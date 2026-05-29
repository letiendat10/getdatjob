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

import re
import time
import requests
from datetime import datetime, timedelta, timezone
from bs4 import BeautifulSoup
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY
from title_utils import clean_title, build_lca_index

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
    r"south korea|korea|new zealand|mexico|emea|apac|latam|"
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


# ── ATS fetchers ─────────────────────────────────────────────────────────────

def fetch_greenhouse(slug: str) -> list[dict]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        loc = (j.get("location") or {}).get("name", "")
        if is_non_us_location(loc):
            continue
        jobs.append({
            "ats_job_id": str(j["id"]),
            "title": j.get("title", ""),
            "location": loc,
            "url": j.get("absolute_url", ""),
            "posted_at": parse_iso(j.get("updated_at")),
            "description_text": strip_html(j.get("content", "")),
        })
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
        jobs.append({
            "ats_job_id": j.get("id", ""),
            "title": j.get("text", ""),
            "location": loc,
            "url": j.get("hostedUrl", ""),
            "posted_at": posted_at,
            "description_text": strip_html(j.get("descriptionBody", "")),
        })
    return jobs


def fetch_ashby(slug: str) -> list[dict]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        loc = j.get("location") or ""
        if is_non_us_location(loc):
            continue
        jobs.append({
            "ats_job_id": j.get("id", ""),
            "title": j.get("title", ""),
            "location": loc,
            "url": j.get("jobUrl", ""),
            "posted_at": parse_iso(j.get("publishedAt")) or datetime.now(timezone.utc).isoformat(),
            "description_text": strip_html(j.get("descriptionHtml", "")),
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

    while True:
        r = requests.post(
            api_url,
            json={"appliedFacets": {}, "limit": limit, "offset": offset, "searchText": ""},
            headers={**HEADERS, "Content-Type": "application/json"},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
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
                "posted_at": None,
                "description_text": "",
            })

        offset += limit
        if offset >= total or len(postings) < limit:
            break
        time.sleep(0.5)

    return jobs


def fetch_workable(slug: str) -> list[dict]:
    url = f"https://www.workable.com/api/accounts/{slug}?details=true"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        loc = (j.get("location") or {}).get("location_str", "")
        if is_non_us_location(loc):
            continue
        desc = strip_html(j.get("description", "") + j.get("requirements", ""))
        jobs.append({
            "ats_job_id": j.get("shortcode", ""),
            "title": j.get("title", ""),
            "location": loc,
            "url": j.get("url", ""),
            "posted_at": parse_iso(j.get("created_at")),
            "description_text": desc,
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
            jobs.append({
                "ats_job_id": str(j.get("id_icims", j.get("id", ""))),
                "title": j.get("title", ""),
                "location": j.get("location", ""),
                "url": f"{base}{path}" if path else "",
                "posted_at": parse_iso(j.get("posted_date")) or datetime.now(timezone.utc).isoformat(),
                "description_text": "\n\n".join(p for p in desc_parts if p)[:8000],
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
            jobs.append({
                "ats_job_id": job_id,
                "title": j.get("name", ""),
                "location": loc,
                "url": f"https://jobs.smartrecruiters.com/{company_id}/{job_id}",
                "posted_at": parse_iso(j.get("releasedDate")) or datetime.now(timezone.utc).isoformat(),
                "description_text": "",
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
            desc = strip_html(d.get("description", ""))
            posted = d.get("posted_date")
            job_url = f"{base_url}/careers-home/jobs/{req_id}"
            jobs.append({
                "ats_job_id": str(req_id),
                "title": title,
                "location": location,
                "url": job_url,
                "posted_at": parse_iso(posted) if posted else None,
                "description_text": desc[:8000],
            })
        if len(batch) < limit:
            break
        offset += limit
        time.sleep(0.3)
    return jobs


FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "workday": fetch_workday,
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

        lca_titles, lca_counts = build_lca_index(sb, emp_id)

        job_rows = []
        signal_rows = []
        for j in raw_jobs:
            job_rows.append({
                "employer_id": emp_id,
                "title": j["title"],
                "location": j["location"],
                "url": j["url"],
                "posted_at": j["posted_at"],
                "ats_source": ats,
                "ats_job_id": j["ats_job_id"],
                "description_text": j["description_text"],
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
            try:
                sb.table("jobs").upsert(job_rows[i:i+100], on_conflict="ats_source,ats_job_id").execute()
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

        total_jobs += len(job_rows)
        print(f"  {ats}:{slug} → {len(job_rows)} jobs", flush=True)
        time.sleep(1)

    print(f"\nDone. {total_jobs} jobs synced.", flush=True)

    # Update pre-aggregated counts so /api/jobs/meta reads instantly
    three_days_ago = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    total_res = sb.table("jobs").select("id", count="exact").eq("is_active", True).execute()
    three_day_res = (
        sb.table("jobs")
        .select("id", count="exact")
        .gte("created_at", three_days_ago)
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
