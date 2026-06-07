"""oracle_hcm.py — Oracle Recruiting Cloud (Fusion "Candidate Experience") fetcher.

Shared by the focused pull (03_pull_jobs_0605_inlineenriched.py, which calls
``fetch_list``) and the enrichment pass (04_enrich_descriptions.py, which registers
``fetch_detail`` in its DETAIL map). Kept in its own module so neither of those has to
own Oracle's quirky host/site resolution.

Oracle exposes a public JSON API at
  https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
where {host} is the tenant pod, e.g. `` ehaa.fa.us2.oraclecloud.com``. The *list*
endpoint carries title/location/PostedDate but NOT the full description — that lives on
the *detail* endpoint — so we treat oracle_hcm as a list-only ATS (description filled by
04's enrich pass, exactly like Workday/SmartRecruiters/iCIMS).

Slug shapes seen in employer_ats (the #1 source of breakage — region & site are often
NOT encoded):
  * ``ebwh.fa.us2/CX_1``     → host ebwh.fa.us2.oraclecloud.com, site CX_1   (fully specified)
  * ``fa-evmr-saasfaprod1``  → SaaS pod alias; region + site unknown        (must resolve)
  * ``hdpc``                 → bare pod code; region + site unknown          (must resolve)

For the under-specified forms we probe the known Oracle data-center suffixes and, if the
tenant requires it, discover the site number. Resolutions are cached for the process.

NOTE: validated shape against live tenants; if a specific tenant 4xxs, the per-employer
try/except in the callers degrades it to "skip this employer this run".
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; getdatjob-bot/1.0)", "Accept": "application/json"}
TIMEOUT = 20

# Oracle Fusion data-center suffixes (the ``us2`` in ``pod.fa.us2.oraclecloud.com``).
# Ordered roughly by prevalence so a bare-code probe usually hits on the first few.
_DCS = ["us2", "us6", "us8", "us10", "em2", "em3", "em4", "em5", "ap1", "ap2", "ca2", "ca3"]
# Candidate site numbers to try when a slug doesn't carry one.
_SITES = ["CX_1", "CX_2", "CX_1001", "CX_2001", "CX_3"]

_REQ_PATH = "/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
_DET_PATH = "/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"

# Cache: raw slug → (host, site) once resolved, so we resolve a tenant at most once/run.
_resolved: dict[str, tuple[str | None, str | None]] = {}


def _host_jobsite(slug: str) -> tuple[str | None, str | None]:
    """Parse a slug into (host, site) WITHOUT any network call. host/site may be None."""
    s = (slug or "").strip()
    if not s:
        return None, None
    site = None
    if "/" in s:
        s, site = s.split("/", 1)
        site = site or None
    if s.endswith("oraclecloud.com"):
        return s, site
    if ".fa." in s:  # e.g. "ebwh.fa.us2"
        return f"{s}.oraclecloud.com", site
    return None, site  # bare pod code / SaaS alias — region unknown, must probe


def _req(host: str, site: str | None, limit: int, offset: int) -> requests.Response:
    finder = "findReqs;"
    if site:
        finder += f"siteNumber={site},"
    finder += f"limit={limit},offset={offset}"
    return requests.get(
        f"https://{host}{_REQ_PATH}",
        params={
            "onlyData": "true",
            "expand": "requisitionList.secondaryLocations,requisitionList.requisitionFlexFields",
            "finder": finder,
        },
        headers=HEADERS,
        timeout=TIMEOUT,
    )


def _ok(resp: requests.Response) -> bool:
    if resp.status_code != 200:
        return False
    try:
        return "items" in resp.json()
    except ValueError:
        return False


def _resolve(slug: str) -> tuple[str | None, str | None]:
    """Resolve a slug to a live (host, site), probing DCs / sites as needed. Cached."""
    if slug in _resolved:
        return _resolved[slug]
    host, site = _host_jobsite(slug)
    code = (slug or "").strip().split("/", 1)[0]

    hosts = [host] if host else [f"{code}.fa.{dc}.oraclecloud.com" for dc in _DCS]
    sites = [site] if site else [None] + _SITES  # try "all sites" first, then specific ones

    for h in hosts:
        for st in sites:
            try:
                r = _req(h, st, 1, 0)
            except requests.RequestException:
                break  # host unreachable — move to next host
            if _ok(r):
                _resolved[slug] = (h, st)
                return h, st
            if r.status_code in (401, 403):
                break  # host exists but auth-walled — other sites won't help
    _resolved[slug] = (None, None)
    return None, None


def _iso(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except Exception:
        return s if re.match(r"\d{4}-\d{2}-\d{2}", str(s)) else None


def fetch_list(slug: str) -> list[dict]:
    """List requisitions for a tenant. Returns rows in the standard fetcher shape with
    description_text="" (filled later by fetch_detail via 04's enrich pass). Does NOT filter
    non-US here — the caller's gate centralizes that. Raises on an unresolvable tenant so the
    caller's per-employer try/except can degrade it to a skip."""
    host, site = _resolve(slug)
    if not host:
        raise RuntimeError(f"oracle_hcm: could not resolve a live host for slug {slug!r}")

    jobs: list[dict] = []
    offset, limit = 0, 200
    while True:
        r = _req(host, site, limit, offset)
        r.raise_for_status()
        items = r.json().get("items") or []
        block = items[0] if items else {}
        reqs = block.get("requisitionList") or []
        if not reqs:
            break
        for j in reqs:
            rid = str(j.get("Id") or j.get("Number") or "")
            if not rid:
                continue
            loc = j.get("PrimaryLocation") or j.get("PrimaryLocationCountry") or ""
            jobs.append({
                "ats_job_id": rid,
                "title": j.get("Title", "") or "",
                "location": loc,
                "url": f"https://{host}/hcmUI/CandidateExperience/en/sites/{site or 'CX_1'}/job/{rid}",
                "posted_at": _iso(j.get("PostedDate") or j.get("ExternalPostedStartDate")),
                "source_dept": j.get("JobFamily") or j.get("Organization") or "",
                "description_text": "",  # list endpoint has none; detail fills it
                "salary_range": None,
            })
        total = block.get("TotalJobsCount")
        offset += limit
        if (total is not None and offset >= total) or len(reqs) < limit:
            break
        time.sleep(0.3)
    return jobs


def fetch_detail(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    """(description_html, posted_at_iso_or_None) for one requisition — matches 04's DETAIL
    contract. Best-effort: returns ("", None) on a miss so the enricher cools the job down."""
    host, site = _resolve(slug)
    if not host:
        return "", None
    finder = f"ById;Id={ats_job_id}"
    if site:
        finder += f",siteNumber={site}"
    try:
        r = requests.get(
            f"https://{host}{_DET_PATH}",
            params={"onlyData": "true", "expand": "all", "finder": finder},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        items = r.json().get("items") or []
    except Exception:
        return "", None
    if not items:
        return "", None
    d = items[0]
    parts = [
        d.get(k) for k in (
            "ExternalDescriptionStr", "ExternalResponsibilitiesStr",
            "ExternalQualificationsStr", "CorporateDescriptionStr",
        ) if d.get(k)
    ]
    html = "\n\n".join(parts)
    posted = _iso(d.get("PostedDate") or d.get("ExternalPostedStartDate"))
    return html, posted
