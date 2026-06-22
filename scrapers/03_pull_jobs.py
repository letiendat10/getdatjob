"""
03_pull_jobs.py
Pulls live job listings from Greenhouse, Lever, Ashby for all mapped employers.
Cross-references each job against LCA filings to assign a confidence tier.
Run daily via GitHub Actions cron.

US location filtering
---------------------
The canonical US location allowlist lives in Google Sheets:
  https://docs.google.com/spreadsheets/d/1Hv7e4e_DcAWmhh0LD366XXaUi6_OTzrNO0sTWb88jec

Columns: type (keyword/state/city) | display_name | match_patterns (pipe-separated,
lowercase) | state_abbrev | notes.

To update allowed locations without a code deploy, edit the sheet and the next
daily run will pick up the changes automatically. Fetch at runtime via the
Sheets API (worksheets[0].get_all_records()) and build the pattern set from the
match_patterns column.
"""

from __future__ import annotations

import importlib.util
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from datetime import datetime, timedelta, timezone
from bs4 import BeautifulSoup
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY
from title_utils import clean_title, build_lca_index
from classify import classify_department, classify_level, detect_remote, strong_title_department

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 10

# ── Non-US location blocklist ─────────────────────────────────────────────────
_NON_US_COUNTRY_RE = re.compile(
    r"\b("
    # Countries (original)
    r"italy|italia|uk|united kingdom|england|france|germany|spain|netherlands|"
    r"australia|canada|india|singapore|japan|brazil|ireland|poland|sweden|denmark|"
    r"norway|finland|switzerland|austria|belgium|portugal|israel|dubai|uae|"
    r"south korea|korea|new zealand|mexico|chile|emea|apac|latam|"
    # Countries (added)
    r"taiwan|china|egypt|philippines|malaysia|indonesia|argentina|romania|hungary|"
    r"czech republic|czechia|hong kong|saudi arabia|colombia|luxembourg|pakistan|"
    r"bulgaria|slovakia|tunisia|morocco|costa rica|greece|turkey|vietnam|"
    r"armenia|malta|"
    # 3-letter ISO country codes appearing in location strings
    # NOTE: "ind" intentionally excluded — it falsely blocks Indiana/IND (Indianapolis airport code)
    # India is already fully covered by the "india" word above + Indian city names below
    r"twn|jpn|kor|chn|isr|can|esp|"
    # 2-letter country codes appearing as standalone tokens (not US state abbrevs)
    r"ie|fr|jp|cn|"
    # Non-US cities — India
    r"bengaluru|bangalore|noida|gurugram|gurgaon|mumbai|kolkata|hyderabad|pune|chennai|"
    # Non-US cities — Philippines
    r"manila|makati|pasig|alabang|taguig|"
    # Non-US cities — Malaysia
    r"kuala lumpur|penang|kulim|"
    # Non-US cities — Taiwan
    r"taipei|taichung|taoyuan|tainan|hsinchu|linkou|miaoli|"
    # Non-US cities — Canada
    r"toronto|vancouver|montreal|calgary|"
    # Non-US cities — UK
    r"london|canary wharf|nottingham|knutsford|glasgow|"
    # Non-US cities — Italy
    r"milan|rome|"
    # Non-US cities — Japan
    r"tokyo|osaka|hiroshima|"
    # Non-US cities — France
    r"paris|neuilly|"
    # Non-US cities — Germany
    r"munich|berlin|frankfurt|wiesbaden|ludwigshafen|hamburg|"
    # Non-US cities — Netherlands
    r"amsterdam|"
    # Non-US cities — Poland
    r"warsaw|warszawa|"
    # Non-US cities — Switzerland
    r"zurich|zürich|"
    # Non-US cities — Belgium
    r"brussels|"
    # Non-US cities — Spain
    r"madrid|barcelona|"
    # Non-US cities — South Korea
    r"seoul|"
    # Non-US cities — Israel
    r"rehovot|tel aviv|"
    # Non-US cities — China
    r"shanghai|beijing|shenzhen|"
    # Non-US cities — Indonesia
    r"jakarta|"
    # Non-US cities — Chile
    r"santiago|valparaiso|concepcion|"
    # Non-US cities — Argentina
    r"buenos aires|"
    # Non-US cities — Brazil
    r"são paulo|sao paulo|rio de janeiro|barueri|belo horizonte|brasilia|curitiba|porto alegre|"
    # Non-US cities — Romania
    r"bucharest|"
    # Non-US cities — Hungary
    r"budapest|"
    # Non-US cities — Czech Republic
    r"prague|"
    # Non-US cities — Thailand
    r"bangkok|"
    # Non-US cities — Colombia
    r"bogota|"
    # Non-US cities — Saudi Arabia
    r"riyadh|king abdullah|"
    # Non-US cities — Egypt
    r"cairo|"
    # Non-US cities — Pakistan
    r"karachi|"
    # Non-US cities — Tunisia
    r"tunis|"
    # Non-US cities — Morocco
    r"casablanca|"
    # Non-US cities — Bulgaria
    r"sofia|"
    # Non-US cities — Slovakia
    r"bratislava|"
    # Non-US cities — Malta
    r"qormi|"
    # Non-US cities — Luxembourg
    r"luxembourg|"
    # Non-US cities — Ireland (Dublin, Athens kept separate for clarity)
    r"dublin|"
    # Non-US cities — Greece
    r"athens"
    r")\b",
    re.IGNORECASE,
)


def is_non_us_location(loc: str) -> bool:
    return bool(_NON_US_COUNTRY_RE.search(loc or ""))


NO_SPONSOR_PATTERNS = [
    r"will not sponsor.{0,60}(employment authorization|work authorization|visa)",
    r"(employment authorization|work authorization|visa).{0,30}will not be sponsored",
    r"not able to (provide|offer).{0,30}(sponsorship|visa support)",
    r"(sponsorship|visa).{0,30}(is not|not) available",
    r"candidates must.{0,40}(authorized|eligible).{0,20}work.{0,20}without.{0,20}sponsor",
    # Citizenship & security clearance — disqualify H-1B holders
    r"u\.?s\.?\s*citizenship\s*(is\s*)?(required|mandatory|needed)",
    r"must\s+be\s+a\s+u\.?s\.?\s*citizen",
    r"requires?\s+u\.?s\.?\s*citizenship",
    r"(access|handle)\s+classified\s+information",
    r"(secret|top\s*secret|ts/sci)\s+(clearance|cleared)",
    r"security\s+clearance\s+(is\s*)?(required|mandatory|needed)",
]

YES_SPONSOR_PATTERNS = [
    r"(will|can|do).{0,20}sponsor.{0,40}(visa|work authorization|h.?1.?b)",
    r"visa sponsorship (is |)available",
    r"(h.?1.?b|e.?3|tn visa).{0,30}sponsor",
    r"open to.{0,20}(visa|sponsorship)",
]


def strip_html(html: str) -> str:
    if not html:
        return ""
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


# ── Salary parsing ────────────────────────────────────────────────────────────
# A dollar amount, optionally K-suffixed: "$95K", "$120,000", "$58.50".
_AMT = r'\$\s*\d[\d,]*(?:\.\d+)?\s*[kK]?'
# Optional unit that can sit between an amount and the dash: "$120,000/year - $200,000".
_UNIT = r'(?:\s*(?:/\s*(?:yr|year|hr|hour)|per\s+(?:year|hour|annum)|a\s+year|annually))?'
_RANGE = re.compile(rf'({_AMT}){_UNIT}\s*(?:[-–—]+|to)\s*({_AMT})', re.I)
# Amazon-style "142,800.00 – 193,200.00 USD" (no $ prefix, USD trails the range).
_USD_RANGE = re.compile(r'(\d[\d,]{4,}(?:\.\d+)?)\s*(?:[-–—]+|to)\s*(\d[\d,]{4,}(?:\.\d+)?)\s*USD', re.I)
# NYC Pay-Transparency phrasing: "USD $100,000.00 to USD $120,000.00" — a currency word LEADS
# each $bound, so _RANGE (which needs $ right after the separator) misses it. Require the
# leading currency word so this only fires on the case _RANGE can't handle (plain "$X to $Y"
# is already matched by _RANGE first), never double-matching.
_USD_PREFIX_RANGE = re.compile(
    rf'(?:USD|US\$|US\s*Dollars?)\s*({_AMT})\s*(?:[-–—]+|to)\s*'
    rf'(?:USD|US\$|US\s*Dollars?)?\s*({_AMT})',
    re.I,
)
_UPTO = re.compile(rf'up\s+to\s+({_AMT})', re.I)
_PLUS = re.compile(rf'({_AMT})\s*\+', re.I)
# "$187,741.00-270,500.00 per annum" — dollar sign only on first number (PayPal / some Workday)
_DOLLAR_SHARED = re.compile(
    r'\$\s*(\d[\d,]*(?:\.\d+)?)\s*[-–—]\s*(\d[\d,]*(?:\.\d+)?)'
    r'(?=\s*(?:per annum|annually|/yr|/year|a year|\s*$))',
    re.I,
)
# Two separately-labelled bounds: "Minimum Salary: $X  Maximum Salary: $Y" / "Minimum Pay: …"
# (common on Workday). No dash between the numbers, so every range pattern above misses it.
_MIN_MAX = re.compile(
    r'min(?:imum)?\s+(?:salary|pay)\s*:?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\b'
    r'.{0,40}?max(?:imum)?\s+(?:salary|pay)\s*:?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)',
    re.I | re.S,
)
_HOURLY_HINT = re.compile(r'(/\s*(?:hr|hour)|per\s+hour|hourly|an\s+hour)', re.I)


def _sal_num(tok: str) -> int | None:
    tok = tok.replace("$", "").replace(",", "").strip().lower()
    k = tok.endswith("k")
    if k:
        tok = tok[:-1].strip()
    try:
        return round(float(tok) * (1000 if k else 1))
    except ValueError:
        return None


def _fmt(lo: int | None, hi: int | None, period: str) -> str | None:
    suffix = " /hr" if period == "hourly" else ""
    if lo is not None and hi is not None:
        return f"${lo:,} – ${hi:,}{suffix}"
    if hi is not None:
        return f"Up to ${hi:,}{suffix}"
    if lo is not None:
        return f"${lo:,}+{suffix}"
    return None


def parse_salary(html: str) -> dict | None:
    """Extract a salary range from a description (HTML or text).

    Returns {display, min_num, max_num, period} or None. `display` is what the card
    shows; min_num/max_num are integers for filtering; period is 'annual' | 'hourly'.
    Handles $-ranges (K-suffixed, with /year or /hr units between the bounds),
    "X to Y", trailing-USD ranges, and single "up to $X" / "$X+" bounds.
    """
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    # Greenhouse content-pay-transparency block first, then the whole description.
    pay_div = soup.find("div", class_="pay-range")
    candidates = ([pay_div.get_text(" ", strip=True)] if pay_div else []) + [soup.get_text(" ", strip=True)]

    for ctx in candidates:
        m = _RANGE.search(ctx)
        if m:
            lo, hi = _sal_num(m.group(1)), _sal_num(m.group(2))
            if lo is not None and hi is not None:
                span = ctx[max(0, m.start() - 15):m.end() + 15]
                period = "hourly" if (_HOURLY_HINT.search(span) or max(lo, hi) < 1000) else "annual"
                return {"display": _fmt(lo, hi, period), "min_num": lo, "max_num": hi, "period": period}
        m = _USD_PREFIX_RANGE.search(ctx)
        if m:
            lo, hi = _sal_num(m.group(1)), _sal_num(m.group(2))
            if lo and hi and lo > 1000:  # "USD $100,000 to USD $120,000" — annual pay-transparency
                return {"display": _fmt(lo, hi, "annual"), "min_num": lo, "max_num": hi, "period": "annual"}
        m = _USD_RANGE.search(ctx)
        if m:
            lo, hi = _sal_num(m.group(1)), _sal_num(m.group(2))
            if lo and hi and lo > 1000:  # guard against "1 – 2 USD" noise
                return {"display": _fmt(lo, hi, "annual"), "min_num": lo, "max_num": hi, "period": "annual"}
        m = _DOLLAR_SHARED.search(ctx)
        if m:
            lo, hi = _sal_num(m.group(1)), _sal_num(m.group(2))
            if lo and hi and lo > 1000:
                return {"display": _fmt(lo, hi, "annual"), "min_num": lo, "max_num": hi, "period": "annual"}
        m = _MIN_MAX.search(ctx)
        if m:
            lo, hi = _sal_num(m.group(1)), _sal_num(m.group(2))
            if lo and hi and lo > 1000:
                return {"display": _fmt(lo, hi, "annual"), "min_num": lo, "max_num": hi, "period": "annual"}
        m = _UPTO.search(ctx)
        if m:
            hi = _sal_num(m.group(1))
            if hi and hi > 1000:
                return {"display": _fmt(None, hi, "annual"), "min_num": None, "max_num": hi, "period": "annual"}
        m = _PLUS.search(ctx)
        if m:
            lo = _sal_num(m.group(1))
            if lo and lo > 1000:
                return {"display": _fmt(lo, None, "annual"), "min_num": lo, "max_num": None, "period": "annual"}
    return None


def extract_salary(html: str) -> str | None:
    """Back-compat wrapper — returns just the display string."""
    s = parse_salary(html)
    return s["display"] if s else None


def _struct_salary(min_val, max_val, *, hourly: bool = False, currency: str | None = "USD") -> str | None:
    """Display string from an ATS's STRUCTURED pay fields — Lever `salaryRange`, Ashby
    `compensation.summaryComponents`, SmartRecruiters `Salary Min/Max` custom fields. Most
    employers put the number here, not in the description prose, so text-scraping alone missed
    them (SmartRecruiters/Lever/Ashby were at 5%/0.5%/19% salary coverage vs Greenhouse 75%).

    Returns "$X – $Y" (annual) or "… /hr" (hourly), or None. Non-USD is dropped — a "$" prefix
    on a EUR/GBP figure would mislead. The format matches parse_salary()'s grammar on purpose:
    the central upsert reparses this string to derive salary_min_num/max_num/period."""
    if currency and str(currency).upper() not in ("USD", ""):
        return None

    def _to_int(v):
        try:
            n = int(float(str(v).replace(",", "").replace("$", "").strip()))
            return n if n > 0 else None
        except (TypeError, ValueError):
            return None

    lo, hi = _to_int(min_val), _to_int(max_val)
    if lo is None and hi is None:
        return None
    return _fmt(lo, hi, "hourly" if hourly else "annual")


def check_sponsorship(text: str) -> str | None:
    """Returns 'no_sponsor', 'sponsors', or None."""
    lower = text.lower()
    for pat in NO_SPONSOR_PATTERNS:
        if re.search(pat, lower):
            return "no_sponsor"
    for pat in YES_SPONSOR_PATTERNS:
        if re.search(pat, lower):
            return "sponsors"
    return None


def parse_iso(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat()
    except Exception:
        return None


def parse_date_loose(s: str | None) -> str | None:
    """ISO first, then US long dates ("June  9, 2026" — Amazon pads single-digit days
    with a double space). Relative strings ("38 minutes", "about 2 hours") → None,
    never a fake date."""
    if not s:
        return None
    iso = parse_iso(s)
    if iso:
        return iso
    try:
        clean = re.sub(r"\s+", " ", s.strip())
        return datetime.strptime(clean, "%B %d, %Y").replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


_WD_DAYS = re.compile(r"posted\s+(\d+)\+?\s+days?\s+ago", re.I)


def parse_workday_posted_on(s: str | None) -> str | None:
    """Coarse posted_at from Workday's list 'postedOn' relative string.

    "Posted Today" → now, "Posted Yesterday" → -1d, "Posted 5 Days Ago" → -5d,
    "Posted 30+ Days Ago" → -31d. Unrecognized strings → None (never now()), so an
    unknown format leaves the date blank rather than faking freshness; the exact
    startDate is filled later by 04_enrich_descriptions.py.
    """
    if not s:
        return None
    low = s.lower()
    now = datetime.now(timezone.utc)
    if "today" in low:
        return now.isoformat()
    if "yesterday" in low:
        return (now - timedelta(days=1)).isoformat()
    m = _WD_DAYS.search(low)
    if m:
        days = int(m.group(1)) + (1 if "+" in low else 0)
        return (now - timedelta(days=days)).isoformat()
    return None


# ── ATS fetchers ─────────────────────────────────────────────────────────────

# ── Custom-site salary augmentation ───────────────────────────────────────────
# A few Greenhouse employers render pay ONLY on their own careers page and omit it from the
# Greenhouse feed (verified: Stripe — 224 LCAs/2025, was 7% covered). For those, fetch the
# rendered page and scrape the range. Gated to a verified host allow-list so it never touches
# the generic Greenhouse path. See memory bug_ats_structured_salary_fields.
_BROWSER_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
_STRIPE_PAY_RE = re.compile(
    r'base salary range[^$]{0,40}\$\s*([\d,]+)\s*(?:[-–—]|to)\s*\$\s*([\d,]+)', re.I)


def _stripe_page_salary(url: str) -> str | None:
    try:
        r = requests.get(url, headers=_BROWSER_UA, timeout=20)  # large SSR page; generous timeout
        m = _STRIPE_PAY_RE.search(r.text)
        if m:
            return _struct_salary(m.group(1), m.group(2))
    except Exception:
        pass
    return None


# host substring -> page-salary extractor. Add a host ONLY after verifying it exposes pay.
_CUSTOM_SALARY_HOSTS = {"stripe.com": _stripe_page_salary}


def _augment_custom_salary(jobs: list[dict]) -> None:
    """Fill salary_range for jobs whose employer renders pay only on a custom careers page.
    Mutates `jobs` in place; concurrent + best-effort (a page failure never blocks the pull).
    No-op (returns immediately) for employers not on the host allow-list."""
    targets = [j for j in jobs if not j.get("salary_range")
               and any(h in (j.get("url") or "") for h in _CUSTOM_SALARY_HOSTS)]
    if not targets:
        return

    def _fill(j: dict) -> None:
        for host, fn in _CUSTOM_SALARY_HOSTS.items():
            if host in j.get("url", ""):
                s = fn(j["url"])
                if s:
                    j["salary_range"] = s
                return

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(_fill, targets))


def fetch_greenhouse(slug: str) -> list[dict]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        loc = (j.get("location") or {}).get("name", "")
        if is_non_us_location(loc):
            continue
        content_html = j.get("content", "")
        # Structured pay_input_ranges takes priority; fall back to HTML extraction
        salary = None
        for pr in j.get("pay_input_ranges", []):
            min_c, max_c = pr.get("min_cents"), pr.get("max_cents")
            if min_c and max_c:
                salary = f"${round(min_c / 100):,} – ${round(max_c / 100):,}"
                break
        if not salary:
            salary = extract_salary(content_html)
        jobs.append({
            "ats_job_id": str(j["id"]),
            "title": j.get("title", ""),
            "location": loc,
            "url": j.get("absolute_url", ""),
            "posted_at": parse_iso(j.get("first_published")) or parse_iso(j.get("updated_at")),
            "source_dept": (j.get("departments") or [{}])[0].get("name", ""),
            "description_text": strip_html(content_html),
            "salary_range": salary,
        })
    _augment_custom_salary(jobs)  # backfill salary from custom careers pages (e.g. Stripe)
    return jobs


def fetch_lever(slug: str) -> list[dict]:
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json():
        loc = (j.get("categories") or {}).get("location", "")
        if is_non_us_location(loc):
            continue
        created_ms = j.get("createdAt", 0)
        posted_at = datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc).isoformat() if created_ms else None
        desc_html = j.get("descriptionBody", "")
        # Lever exposes a structured salaryRange ({min,max,currency,interval}); prefer it,
        # then fall back to text-scraping the salaryDescription / body.
        sr = j.get("salaryRange") or {}
        salary = _struct_salary(
            sr.get("min"), sr.get("max"),
            hourly="hour" in (sr.get("interval") or "").lower(),
            currency=sr.get("currency"),
        ) or extract_salary(j.get("salaryDescription") or desc_html)
        jobs.append({
            "ats_job_id": j.get("id", ""),
            "title": j.get("text", ""),
            "location": loc,
            "url": j.get("hostedUrl", ""),
            "posted_at": posted_at,
            # ATS-native department (org structure) — the right signal for dept search.
            "source_dept": (j.get("categories") or {}).get("department") or (j.get("categories") or {}).get("team", ""),
            "description_text": strip_html(desc_html),
            "salary_range": salary,
        })
    return jobs


def fetch_ashby(slug: str) -> list[dict]:
    # includeCompensation=true surfaces the structured compensation block (salary range).
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        loc = j.get("location") or ""
        if is_non_us_location(loc):
            continue
        desc_html = j.get("descriptionHtml", "")
        # compensation.summaryComponents lists pay parts; use the Salary one (skip
        # EquityCashValue, whose values are null). Fall back to text-scraping the description.
        salary = None
        for c in ((j.get("compensation") or {}).get("summaryComponents") or []):
            if c.get("compensationType") == "Salary" and (c.get("minValue") or c.get("maxValue")):
                salary = _struct_salary(
                    c.get("minValue"), c.get("maxValue"),
                    hourly="hour" in (c.get("interval") or "").lower(),
                    currency=c.get("currencyCode"),
                )
                break
        jobs.append({
            "ats_job_id": j.get("id", ""),
            "title": j.get("title", ""),
            "location": loc,
            "url": j.get("jobUrl", ""),
            "posted_at": parse_iso(j.get("publishedAt")) or parse_iso(j.get("updatedAt")),
            "source_dept": j.get("department") or j.get("team", ""),
            "description_text": strip_html(desc_html),
            "salary_range": salary or extract_salary(desc_html),
        })
    return jobs


def fetch_workday(slug: str) -> list[dict]:
    # slug format: {subdomain}.{instance}/{jobsite}
    # e.g., "capitalone.wd12/Capital_One" or "expedia.wd108/search"
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    base_url = f"https://{host}.myworkdayjobs.com"
    api_url = f"{base_url}/wday/cxs/{tenant}/{jobsite}/jobs"

    jobs = []
    offset = 0
    limit = 20
    # Workday only returns `total` reliably on the first page; capture it once
    # and use it to bound pagination (subsequent pages often return total=0).
    total = None

    first_data = None
    while True:
        r = requests.post(
            api_url,
            json={"appliedFacets": {}, "limit": limit, "offset": offset, "searchText": ""},
            headers={**HEADERS, "Content-Type": "application/json"},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if first_data is None:
            first_data = data  # holds the facet list (only the first page carries it)
        if total is None:
            total = data.get("total", 0)
        postings = data.get("jobPostings", [])
        if not postings:
            break

        for j in postings:
            loc = j.get("locationsText", "")
            if is_non_us_location(loc):
                continue
            path = j.get("externalPath", "")
            jobs.append({
                "ats_job_id": path,  # externalPath is unique per company
                "title": j.get("title", ""),
                "location": loc,
                "url": f"{base_url}/{jobsite}{path}",
                # The list API has no posting date. Left NULL here and filled with the
                # exact jobPostingInfo.startDate by 04_enrich_descriptions.py. The upsert
                # protects posted_at (drops NULLs) so this daily pull never clobbers the
                # enriched date; meanwhile effective_posted_at falls back to scraped_at.
                "posted_at": None,
                "description_text": "",
            })

        offset += limit
        if offset >= total or len(postings) < limit:
            break
        time.sleep(0.5)

    # Department signal: Workday's detail API exposes NO job family, but the list FACETS do.
    # Enumerate the jobFamilyGroup (fallback jobFamily) facet and re-query per value to tag
    # each externalPath with its family descriptor — that's source_dept for Workday.
    fam_by_path = _workday_family_map(api_url, {**HEADERS, "Content-Type": "application/json"}, first_data)
    for jb in jobs:
        jb["source_dept"] = fam_by_path.get(jb["ats_job_id"], "")

    return jobs


def _workday_family_map(api_url: str, headers: dict, first_data: dict | None) -> dict:
    """Map Workday externalPath -> job-family descriptor using the list facets (the detail
    API carries none). Prefers the coarser jobFamilyGroup, falls back to jobFamily. Bounded
    to one paginated sweep per facet value (~one extra full pull's worth of requests).
    Best-effort: any facet failure is swallowed so it never blocks the daily pull."""
    facets = (first_data or {}).get("facets", []) or []
    fam = (next((f for f in facets if f.get("facetParameter") == "jobFamilyGroup"), None)
           or next((f for f in facets if f.get("facetParameter") == "jobFamily"), None))
    if not fam:
        return {}
    param = fam.get("facetParameter")
    out: dict = {}
    for v in (fam.get("values") or []):
        fid, desc = v.get("id"), v.get("descriptor")
        if not fid or not desc:
            continue
        cnt = v.get("count") or 0
        offset, limit = 0, 20
        while True:
            try:
                r = requests.post(
                    api_url,
                    json={"appliedFacets": {param: [fid]}, "limit": limit, "offset": offset, "searchText": ""},
                    headers=headers, timeout=TIMEOUT,
                )
                r.raise_for_status()
                posts = r.json().get("jobPostings", [])
            except Exception:
                break
            if not posts:
                break
            for p in posts:
                ep = p.get("externalPath")
                if ep:
                    out.setdefault(ep, desc)
            offset += limit
            if (cnt and offset >= cnt) or len(posts) < limit:
                break
            time.sleep(0.3)
    return out


def fetch_workable(slug: str) -> list[dict]:
    url = f"https://www.workable.com/api/accounts/{slug}?details=true"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        loc = (j.get("location") or {}).get("location_str", "")
        if is_non_us_location(loc):
            continue
        desc_html = j.get("description", "") + j.get("requirements", "")
        desc = strip_html(desc_html)
        jobs.append({
            "ats_job_id": j.get("shortcode", ""),
            "title": j.get("title", ""),
            "location": loc,
            "url": j.get("url", ""),
            "posted_at": parse_iso(j.get("created_at")),
            "source_dept": j.get("department") or j.get("function", ""),
            "description_text": desc,
            "salary_range": extract_salary(desc_html),
        })
    return jobs


def fetch_icims(slug: str) -> list[dict]:
    # slug = iCIMS subdomain, e.g., "us-careers-rivian"
    base_url = f"https://{slug}.icims.com"
    search_url = f"{base_url}/jobs/search?ss=1&searchLocation=&searchCategory=&in_iframe=1"
    r = requests.get(search_url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    jobs = []
    seen = set()
    for a in soup.select("a[href*='/jobs/']"):
        href = a.get("href", "")
        m = re.search(r"/jobs/(\d+)/", href)
        if not m:
            continue
        job_id = m.group(1)
        if job_id in seen:
            continue
        seen.add(job_id)

        title = a.get_text(strip=True)
        container = a.find_parent(class_=re.compile(r"iCIMS_Job", re.I))
        loc = ""
        if container:
            loc_el = container.select_one(".iCIMS_JobHeaderField, .location, [class*='location']")
            if loc_el:
                loc = loc_el.get_text(strip=True)

        if is_non_us_location(loc):
            continue
        job_url = href if href.startswith("http") else f"{base_url}{href}"
        jobs.append({
            "ats_job_id": job_id,
            "title": title,
            "location": loc,
            "url": job_url,
            "posted_at": None,
            "description_text": "",
        })
    return jobs


def fetch_amazon(_slug: str) -> list[dict]:
    """Amazon custom scraper. slug is ignored — one board covers all Amazon entities."""
    base = "https://www.amazon.jobs"
    jobs = []
    offset = 0
    limit = 100
    while True:
        r = requests.get(
            f"{base}/en/search.json",
            params={"result_limit": limit, "offset": offset, "normalized_country_code[]": "USA"},
            headers=HEADERS, timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        batch = data.get("jobs", [])
        if not batch:
            break
        for j in batch:
            path = j.get("job_path", "")
            desc_parts = [j.get("description", "")]
            basic = strip_html(j.get("basic_qualifications", ""))
            preferred = strip_html(j.get("preferred_qualifications", ""))
            if basic:
                desc_parts.append(f"Basic Qualifications\n{basic}")
            if preferred:
                desc_parts.append(f"Preferred Qualifications\n{preferred}")
            desc_text = "\n\n".join(p for p in desc_parts if p)[:8000]
            jobs.append({
                "ats_job_id": str(j.get("id_icims", j.get("id", ""))),
                "title": j.get("title", ""),
                "location": j.get("location", ""),
                "url": f"{base}{path}" if path else "",
                # posted_date is "June 9, 2026"-style; updated_time is relative ("38 minutes",
                # "3 days") and means last-touched, not posted — never use it as a date.
                "posted_at": parse_date_loose(j.get("posted_date")),
                "source_dept": j.get("job_category") or j.get("business_category", ""),
                "description_text": desc_text,
                "salary_range": extract_salary(desc_text),
            })
        if len(batch) < limit:
            break
        offset += limit
        time.sleep(0.5)
    return jobs


def fetch_smartrecruiters(slug: str) -> list[dict]:
    """SmartRecruiters fetcher — paginates through all postings."""
    jobs = []
    offset = 0
    limit = 100
    while True:
        r = requests.get(
            f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
            params={"limit": limit, "offset": offset},
            headers=HEADERS, timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        batch = data.get("content", [])
        if not batch:
            break
        for j in batch:
            loc_parts = j.get("location", {})
            loc = ", ".join(filter(None, [
                loc_parts.get("city"), loc_parts.get("region"), loc_parts.get("country")
            ]))
            if is_non_us_location(loc):
                continue
            company_id = (j.get("company") or {}).get("identifier", slug)
            job_id = j.get("id", "")
            # Salary lives in the posting's customFields ('Salary Min'/'Salary Max'), not the
            # description (which this list endpoint omits anyway). Capture it here at pull time.
            cf = {c.get("fieldLabel"): c.get("valueLabel") for c in (j.get("customField") or [])}
            salary = _struct_salary(
                cf.get("Salary Min"), cf.get("Salary Max"),
                hourly="hour" in (cf.get("Salary/Hourly Pay Indicator") or "").lower(),
            )
            jobs.append({
                "ats_job_id": job_id,
                "title": j.get("name", ""),
                "location": loc,
                "url": f"https://jobs.smartrecruiters.com/{company_id}/{job_id}",
                "posted_at": parse_iso(j.get("releasedDate")) or parse_iso(j.get("createdOn")),
                # function.label is the populated field; department.label is usually empty.
                "source_dept": (j.get("function") or {}).get("label") or (j.get("department") or {}).get("label", ""),
                "description_text": "",
                "salary_range": salary,
            })
        if len(batch) < limit:
            break
        offset += limit
        time.sleep(0.3)
    return jobs


def fetch_bamboohr(slug: str) -> list[dict]:
    """BambooHR fetcher — parses the public embed2 job board HTML."""
    url = f"https://{slug}.bamboohr.com/jobs/embed2.php?version=1"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    jobs = []
    seen = set()
    base = f"https://{slug}.bamboohr.com"
    for a in soup.select("a[href*='/jobs/']"):
        href = a.get("href", "")
        m = re.search(r"/jobs/(\d+)/", href)
        if not m:
            continue
        job_id = m.group(1)
        if job_id in seen:
            continue
        seen.add(job_id)
        title = a.get_text(strip=True)
        if not title:
            continue
        # Location is in the adjacent <li> sibling text (varies by theme)
        loc = ""
        li = a.find_parent("li")
        if li:
            loc_el = li.select_one(".location, [class*='location']")
            if loc_el:
                loc = loc_el.get_text(strip=True)
        if is_non_us_location(loc):
            continue
        job_url = href if href.startswith("http") else f"{base}{href}"
        jobs.append({
            "ats_job_id": job_id,
            "title": title,
            "location": loc,
            "url": job_url,
            "posted_at": None,
            "description_text": "",
        })
    return jobs


def fetch_jibe(slug: str) -> list[dict]:
    """Jibe-powered careers sites. slug = base URL, e.g. https://careers.amd.com"""
    base_url = slug.rstrip("/")
    jobs = []
    limit = 100
    offset = 0
    while True:
        r = requests.get(
            f"{base_url}/api/jobs",
            params={"limit": limit, "offset": offset},
            headers=HEADERS, timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        batch = data.get("jobs", [])
        if not batch:
            break
        for j in batch:
            d = j.get("data", {})
            if d.get("country_code") != "US":
                continue
            req_id = d.get("req_id") or d.get("slug", "")
            title = d.get("title", "")
            location = d.get("full_location") or d.get("location_name", "")
            desc_html = d.get("description", "")
            desc = strip_html(desc_html)
            posted = d.get("posted_date")
            job_url = f"{base_url}/careers-home/jobs/{req_id}"
            jobs.append({
                "ats_job_id": str(req_id),
                "title": title,
                "location": location,
                "url": job_url,
                "posted_at": parse_date_loose(posted),
                "description_text": desc[:8000],
                "salary_range": extract_salary(desc_html),
            })
        if len(batch) < limit:
            break
        offset += limit
        time.sleep(0.3)
    return jobs


# ── Eightfold (PCSX) ─────────────────────────────────────────────────────────
# Hardcoded slug→domain map so we never need to hit the career page just to find the domain.
# Eightfold's CDN rate-limits rapid sequential career-page hits. Extend this map when adding
# new Eightfold employers rather than relying on the discovery fallback during a pull run.
_EF_SLUG_DOMAIN: dict[str, str] = {
    "citi": "citi.com",
    "nttdata": "nttdata.com",
    "eaton": "eaton.com",
    "arcadis": "arcadis.com",
    "ericsson": "ericsson.com",
    "bayer": "bayer.com",
    "netapp": "netapp.com",
    "hsbc": "hsbc.com",
    "gotinder": "gotinder.com",
    "fluor": "fluor.com",
    "mlp": "mlp.com",
    "juniper": "juniper.net",
    # Custom-domain slugs: slug already IS the base domain
    "jobs.whirlpool.com": "whirlpool.com",
}

_ef_domain_cache: dict[str, str | None] = {}
_BROWSER_UA_EF = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}


def _eightfold_base(slug: str) -> str:
    return f"https://{slug}" if "." in slug else f"https://{slug}.eightfold.ai"


def _get_eightfold_domain(base_url: str) -> str | None:
    """Return the Eightfold 'domain' query param for a given base URL.
    Checks the hardcoded map first; discovers from the career page as a fallback."""
    if base_url in _ef_domain_cache:
        return _ef_domain_cache[base_url]
    # Derive slug from base_url for map lookup
    slug = base_url.replace("https://", "").replace(".eightfold.ai", "")
    if slug in _EF_SLUG_DOMAIN:
        domain: str | None = _EF_SLUG_DOMAIN[slug]
        _ef_domain_cache[base_url] = domain
        return domain
    # Fallback: scrape the career page (one hit per unknown slug per run)
    try:
        resp = requests.get(f"{base_url}/careers", headers=_BROWSER_UA_EF, timeout=15,
                            allow_redirects=True)
        m = re.search(r'domain=([a-zA-Z0-9._-]+\.[a-zA-Z]{2,6})', resp.text)
        domain = m.group(1) if m else None
    except Exception:
        domain = None
    _ef_domain_cache[base_url] = domain
    return domain


def fetch_eightfold(slug: str) -> list[dict]:
    """Eightfold PCSX career site — paginates /api/pcsx/search filtered to United States."""
    base = _eightfold_base(slug)
    domain = _get_eightfold_domain(base)
    if not domain:
        raise ValueError(f"eightfold domain not in map and not discoverable for slug={slug!r}")
    jobs: list[dict] = []
    start = 0
    total: int | None = None
    while True:
        r = requests.get(
            f"{base}/api/pcsx/search",
            params={"domain": domain, "query": "", "location": "United States", "start": start},
            headers=HEADERS, timeout=20,
        )
        r.raise_for_status()
        data = (r.json().get("data") or {})
        positions = data.get("positions") or []
        if not positions:
            break
        if total is None:
            total = data.get("count", 0)
        for pos in positions:
            job_id = str(pos["id"])
            locs = pos.get("standardizedLocations") or pos.get("locations") or []
            loc = locs[0] if locs else ""
            if is_non_us_location(loc):
                continue
            posted_ts = pos.get("postedTs")
            posted_at = (
                datetime.fromtimestamp(posted_ts, tz=timezone.utc).strftime("%Y-%m-%d")
                if posted_ts else None
            )
            jobs.append({
                "ats_job_id": job_id,
                "title": pos.get("name", ""),
                "location": loc,
                "url": f"{base}/careers/job/{job_id}",
                "posted_at": posted_at,
                "source_dept": pos.get("department") or "",
                "description_text": "",
                "salary_range": None,
            })
        start += len(positions)
        if total is not None and start >= total:
            break
        time.sleep(0.5)
    return jobs


FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "workday": fetch_workday,
    "eightfold": fetch_eightfold,
    "icims": fetch_icims,
    "workable": fetch_workable,
    "bamboohr": fetch_bamboohr,
    "amazon": fetch_amazon,
    "smartrecruiters": fetch_smartrecruiters,
    "jibe": fetch_jibe,
}


# ── LCA title matching ────────────────────────────────────────────────────────

def score_job(
    title: str,
    desc: str,
    lca_titles: set[str],
    lca_counts: dict[str, int],
) -> tuple[str, str | None, str, int]:
    """Return (confidence_tier, no_sponsor_in_desc_flag, title_clean, title_employer_lca_count)."""
    desc_flag = check_sponsorship(desc)
    tc = clean_title(title)
    lca_count = lca_counts.get(tc, 0)
    if desc_flag == "no_sponsor":
        return "excluded", "no_sponsor", tc, lca_count
    if tc in lca_titles:
        return "verified", desc_flag, tc, lca_count
    return "friendly", desc_flag, tc, lca_count


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse, sys
    parser = argparse.ArgumentParser()
    parser.add_argument("--ats", nargs="+", help="Only run for these ATS types (e.g. greenhouse lever)")
    parser.add_argument("--employer-ids", nargs="+", type=int, help="Only pull for these employer IDs")
    args = parser.parse_args()

    # Human title reviews (from /admin/review) win over keyword heuristics for
    # department/job_level on every job pulled. See classify.merge_db_overrides.
    from classify import merge_db_overrides
    merge_db_overrides(
        sb.table("title_reviews").select("title_norm,department,job_level").execute().data
    )

    ats_rows = sb.table("employer_ats").select("employer_id,ats_type,slug").execute().data
    if args.ats:
        ats_rows = [r for r in ats_rows if r["ats_type"] in args.ats]
    if args.employer_ids:
        ats_rows = [r for r in ats_rows if r["employer_id"] in args.employer_ids]
    # Deduplicate by (ats_type, slug) — keep first employer_id only
    seen_slugs: set[tuple] = set()
    unique_rows = []
    for r in ats_rows:
        key = (r["ats_type"], r["slug"])
        if key not in seen_slugs:
            seen_slugs.add(key)
            unique_rows.append(r)
        else:
            print(f"  SKIP duplicate slug {r['ats_type']}:{r['slug']} (employer_id={r['employer_id']})", flush=True)
    ats_rows = unique_rows
    # Pull Amazon last: its job volume is large enough to hit Supabase statement
    # timeouts, so a mid-run crash there must not block every later employer.
    ats_rows.sort(key=lambda r: r["ats_type"] == "amazon")
    print(f"Pulling jobs for {len(ats_rows)} employer-ATS mappings …", flush=True)

    # ── Concurrent enrichment — enrichment rides the pull (Tier 2) ─────────────────
    # New list-only-ATS jobs (Workday/SmartRecruiters/iCIMS) arrive with no description.
    # Rather than depend on a separate always-on worker (whose GitHub hourly cron never
    # reliably fired), we enrich them HERE — concurrently, as each employer is pulled — by
    # reusing enrich_one(). A job's salary/description/posted_at/tier is filled within
    # minutes of being pulled, in this one reliable process. enrich.yml is a daily backstop.
    _enr_spec = importlib.util.spec_from_file_location(
        "enrich_descriptions",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "04_enrich_descriptions.py"),
    )
    _enr = importlib.util.module_from_spec(_enr_spec)
    _enr_spec.loader.exec_module(_enr)
    enrich_one = _enr.enrich_one
    ENRICHABLE = set(_enr.ENRICHABLE)

    _enrich_pool = ThreadPoolExecutor(max_workers=8)
    _in_flight: set[int] = set()
    _enrich_lock = threading.Lock()
    _enrich_stats = {"enriched": 0, "salary": 0, "excluded": 0, "errors": 0}

    def _submit_enrich(job: dict) -> None:
        jid = job.get("id")
        if jid is None:
            return
        with _enrich_lock:
            if jid in _in_flight:
                return
            _in_flight.add(jid)

        def _run() -> None:
            try:
                res = enrich_one(job)  # fetch detail → salary/desc/posted_at → rescore tier
                if res.get("status") == "enriched":
                    with _enrich_lock:
                        _enrich_stats["enriched"] += 1
                        if res.get("with_salary"):
                            _enrich_stats["salary"] += 1
                        if res.get("rescored") == "excluded":
                            _enrich_stats["excluded"] += 1
            except Exception as e:
                with _enrich_lock:
                    _enrich_stats["errors"] += 1
                print(f"  enrich error job {jid} — {e}", flush=True)
            finally:
                with _enrich_lock:
                    _in_flight.discard(jid)

        _enrich_pool.submit(_run)

    total_jobs = 0
    for mapping in ats_rows:
        emp_id = mapping["employer_id"]
        ats = mapping["ats_type"]
        slug = mapping["slug"]
        fetcher = FETCHERS.get(ats)
        if not fetcher:
            continue

        try:
            raw_jobs = fetcher(slug)
        except Exception as e:
            print(f"  ERROR {ats}:{slug} — {e}", flush=True)
            continue

        # A transient PostgREST/httpx timeout on this one lookup must not abort the whole
        # run. It previously did exactly that (run #13): the exception propagated out of the
        # per-employer loop and killed every later employer plus the downstream steps.
        # Degrade to "no LCA-title boost for this employer this run"; the next run re-scores.
        try:
            lca_titles, lca_counts = build_lca_index(sb, emp_id)
        except Exception as e:
            print(f"  ERROR lca_index emp={emp_id} — {e}", flush=True)
            lca_titles, lca_counts = set(), {}

        job_rows = []
        signal_rows = []
        for j in raw_jobs:
            # Salary: prefer a fetcher-provided range (e.g. Greenhouse pay_input_ranges),
            # otherwise parse the description. parse_salary derives both the display
            # string and the numeric bounds used for the keep-unknowns salary filter.
            range_str = j.get("salary_range")
            sal = parse_salary(range_str) if range_str else parse_salary(j.get("description_text") or "")
            job_rows.append({
                "employer_id": emp_id,
                "title": j["title"],
                "location": j["location"],
                "url": j["url"],
                "posted_at": j["posted_at"],
                "ats_source": ats,
                "ats_job_id": j["ats_job_id"],
                "description_text": j["description_text"],
                "salary_range": range_str or (sal["display"] if sal else None),
                "salary_min_num": sal["min_num"] if sal else None,
                "salary_max_num": sal["max_num"] if sal else None,
                "salary_period": sal["period"] if sal else None,
                "department": classify_department(j["title"], j.get("source_dept")),
                # Cached strong-title discipline (restamp COALESCEs it over the source_dept mapping).
                "title_dept_strong": strong_title_department(j["title"]),
                # Raw ATS department (source of truth). map_source_dept.run_batch() folds it
                # into the unified jobs.department post-pull (rule -> LLM) and re-stamps.
                "source_department": (j.get("source_dept") or None),
                "job_level": classify_level(j["title"]),
                "is_remote": detect_remote(j["title"], j["location"]),
                "is_active": True,
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
            })

        if not job_rows:
            continue

        # Dedup within the batch by ats_job_id (e.g. Amazon returns same job across entities)
        job_rows = list({r["ats_job_id"]: r for r in job_rows}.values())

        # Upsert in chunks of 100. Small batches keep each statement under Supabase's
        # statement timeout — 500-row batches of Amazon rows (large description_text +
        # on-conflict index maintenance) were timing out.
        for i in range(0, len(job_rows), 100):
            # Drop empty description_text / null salary_range from the payload so the
            # enrichment pass (04_enrich_descriptions.py) — which backfills these for
            # list-only ATSes like Workday — isn't clobbered on every daily run.
            # Rows in a chunk are homogeneous (one ATS), so PostgREST's column set
            # stays consistent across the batch.
            # Drop empty enrichment fields so the enrichment pass (04_enrich_descriptions.py),
            # which backfills these for list-only ATSes (Workday/SmartRecruiters/iCIMS),
            # isn't clobbered with NULLs on every daily run.
            chunk = [
                {k: v for k, v in r.items()
                 if v or k not in ("description_text", "salary_range",
                                   "salary_min_num", "salary_max_num", "salary_period",
                                   "posted_at", "department", "source_department")}
                for r in job_rows[i:i+100]
            ]
            try:
                sb.table("jobs").upsert(chunk, on_conflict="ats_source,ats_job_id").execute()
            except Exception as e:
                print(f"  ERROR upsert {ats}:{slug} chunk {i//100 + 1} — {e}", flush=True)

        # Mark jobs removed from ATS as inactive
        try:
            fresh_ids = {j["ats_job_id"] for j in raw_jobs}
            active_result = (
                sb.table("jobs")
                .select("id,ats_job_id")
                .eq("employer_id", emp_id)
                .eq("ats_source", ats)
                .eq("is_active", True)
                .execute()
            )
            stale_ids = [
                row["id"] for row in active_result.data
                if row["ats_job_id"] not in fresh_ids
            ]
            if stale_ids:
                sb.table("jobs").update({"is_active": False}).in_("id", stale_ids).execute()
                print(f"  Marked {len(stale_ids)} jobs inactive for {slug} ({ats})", flush=True)
        except Exception as e:
            print(f"  ERROR stale-mark {ats}:{slug} — {e}", flush=True)

        # Fetch IDs back for signal computation. Pull only id+ats_job_id (small);
        # title/description_text are already in job_rows, so join locally instead of
        # re-fetching the heavy description_text column for every job (Amazon's volume
        # made that SELECT exceed Supabase's statement timeout).
        try:
            ids_result = (
                sb.table("jobs")
                .select("id,ats_job_id")
                .eq("employer_id", emp_id)
                .eq("ats_source", ats)
                .execute()
            )
            rows_by_ats_id = {r["ats_job_id"]: r for r in job_rows}
            for rec in ids_result.data:
                row = rows_by_ats_id.get(rec["ats_job_id"])
                if row is None:
                    continue
                tier, flag, tc, lca_count = score_job(
                    row["title"], row["description_text"] or "", lca_titles, lca_counts
                )
                signal_rows.append({
                    "job_id": rec["id"],
                    "confidence_tier": tier,
                    "no_sponsor_in_desc_flag": flag,
                    "title_clean": tc,
                    "title_employer_lca_count": lca_count,
                })
            if signal_rows:
                sb.table("job_signals").upsert(signal_rows, on_conflict="job_id").execute()
        except Exception as e:
            print(f"  ERROR signals {ats}:{slug} — {e}", flush=True)

        # Enrich this employer's new list-only jobs NOW, concurrently — so salary /
        # description / posted_at / tier are filled within minutes, not left for a separate
        # run. Submitted AFTER the per-employer job_signals upsert above, so enrich_one's
        # rescore updates an existing signal (no race with the pull's signal write). The
        # pull thread doesn't wait on these; the pool drains alongside the rest of the pull.
        # Cooldown-aware (skip jobs whose enrich was attempted in the last 7d); PostgREST's
        # 1000-row cap naturally bounds a huge new employer to 1000/run (rest next run).
        if ats in ENRICHABLE:
            try:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
                cands = (
                    sb.table("jobs")
                    .select("id,ats_source,ats_job_id,employer_id")
                    .eq("employer_id", emp_id)
                    .eq("ats_source", ats)
                    .is_("description_text", "null")
                    .or_(f"enrich_attempted_at.is.null,enrich_attempted_at.lt.{cutoff}")
                    .execute()
                    .data
                )
                for cand in cands:
                    _submit_enrich(cand)
            except Exception as e:
                print(f"  ERROR enrich-queue {ats}:{slug} — {e}", flush=True)

        total_jobs += len(job_rows)
        print(f"  {ats}:{slug} → {len(job_rows)} jobs", flush=True)
        time.sleep(1)

    print(f"\nDone. {total_jobs} jobs synced.", flush=True)

    # Join the enrichment tail: the pool has been draining each employer's new jobs
    # throughout the pull; wait for the remainder so they're done before the run ends.
    print(f"Draining enrichment pool ({len(_in_flight)} in flight) …", flush=True)
    _enrich_pool.shutdown(wait=True)
    print(
        f"Enrichment done — {_enrich_stats['enriched']} enriched "
        f"({_enrich_stats['salary']} w/ salary, {_enrich_stats['excluded']} excluded, "
        f"{_enrich_stats['errors']} errors).",
        flush=True,
    )

    # Update pre-aggregated counts so /api/jobs/meta reads instantly
    three_days_ago = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    total_res = sb.table("jobs").select("id", count="exact").eq("is_active", True).execute()
    three_day_res = (
        sb.table("jobs")
        .select("id", count="exact")
        .gte("scraped_at", three_days_ago)
        .execute()
    )
    sb.table("job_stats").upsert({
        "id": 1,
        "total_count": total_res.count or 0,
        "week_count": 0,
        "three_day_count": three_day_res.count or 0,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    print(f"job_stats updated — total: {total_res.count}, 3-day: {three_day_res.count}", flush=True)
