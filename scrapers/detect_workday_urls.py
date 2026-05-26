"""
detect_workday_urls.py
For each unmapped employer, search DuckDuckGo for the company name scoped to
known ATS domains. First result that matches gives us the exact ATS URL.

Run: python3 scrapers/detect_workday_urls.py
     python3 scrapers/detect_workday_urls.py --dry-run          # print only, no DB writes
     python3 scrapers/detect_workday_urls.py --limit 50         # only top 50 unmapped employers
     python3 scrapers/detect_workday_urls.py --from-failures    # target companies in data/overrides_failed.csv
"""

from __future__ import annotations

import csv
import re
import sys
import time
import requests
from pathlib import Path
from bs4 import BeautifulSoup
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

DRY_RUN = "--dry-run" in sys.argv
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 10

# ATS URL patterns — order matters (most specific first)
ATS_PATTERNS = [
    # Workday: subdomain.wdN.myworkdayjobs.com/jobsite
    (
        "workday",
        re.compile(r"https?://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/([^/?#\s\"\'<>]+)", re.I),
        lambda m: f"{m.group(1)}.{m.group(2)}/{m.group(3)}",
    ),
    # iCIMS: tenant.icims.com
    (
        "icims",
        re.compile(r"https?://([a-z0-9-]+)\.icims\.com", re.I),
        lambda m: m.group(1),
    ),
    # Greenhouse
    (
        "greenhouse",
        re.compile(r"https?://(?:boards\.greenhouse\.io|([a-z0-9-]+)\.greenhouse\.io)/([a-z0-9_-]+)", re.I),
        lambda m: m.group(2) or m.group(1),
    ),
    # Lever
    (
        "lever",
        re.compile(r"https?://jobs\.lever\.co/([a-z0-9_-]+)", re.I),
        lambda m: m.group(1),
    ),
    # Ashby
    (
        "ashby",
        re.compile(r"https?://jobs\.ashby\.(?:com|hq)/([a-z0-9_-]+)", re.I),
        lambda m: m.group(1),
    ),
    # SmartRecruiters: careers.smartrecruiters.com/slug
    (
        "smartrecruiters",
        re.compile(r"https?://careers\.smartrecruiters\.com/([a-zA-Z0-9_-]+)", re.I),
        lambda m: m.group(1),
    ),
    # Taleo: company.taleo.net
    (
        "taleo",
        re.compile(r"https?://([a-z0-9-]+)\.taleo\.net", re.I),
        lambda m: m.group(1),
    ),
    # BambooHR: company.bamboohr.com/jobs
    (
        "bamboohr",
        re.compile(r"https?://([a-z0-9-]+)\.bamboohr\.com/(?:jobs|careers)", re.I),
        lambda m: m.group(1),
    ),
    # Jobvite: jobs.jobvite.com/company/
    (
        "jobvite",
        re.compile(r"https?://jobs\.jobvite\.com/([a-z0-9_-]+)/", re.I),
        lambda m: m.group(1),
    ),
    # Workable: apply.workable.com/slug
    (
        "workable",
        re.compile(r"https?://apply\.workable\.com/([a-z0-9_-]+)", re.I),
        lambda m: m.group(1),
    ),
]

DDG_URL = "https://html.duckduckgo.com/html/"
ATS_SITE_QUERY = (
    "site:myworkdayjobs.com OR site:icims.com OR "
    "site:greenhouse.io OR site:jobs.lever.co OR site:jobs.ashby.com OR "
    "site:careers.smartrecruiters.com OR site:apply.workable.com OR "
    "site:taleo.net OR site:bamboohr.com OR site:jobs.jobvite.com"
)


def search_ats(company_name: str):
    """Search DuckDuckGo for company + ATS sites. Returns (ats_type, slug) or None."""
    query = f'"{company_name}" ({ATS_SITE_QUERY})'
    try:
        r = requests.post(
            DDG_URL,
            data={"q": query, "kl": "us-en"},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        soup = BeautifulSoup(r.text, "html.parser")
        links = [
            a["href"]
            for a in soup.select("a.result__url, a.result__a")
            if a.get("href")
        ]
        for link in links:
            for ats_type, pattern, extract in ATS_PATTERNS:
                m = pattern.search(link)
                if m:
                    return ats_type, extract(m)
    except Exception:
        pass
    return None


def verify_slug(ats_type: str, slug: str) -> bool:
    """Quick sanity check that the slug returns real jobs."""
    try:
        if ats_type == "workday":
            host, jobsite = slug.split("/", 1)
            tenant = host.split(".")[0]
            api_url = f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}/jobs"
            r = requests.post(
                api_url,
                json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""},
                headers={**HEADERS, "Content-Type": "application/json"},
                timeout=TIMEOUT,
            )
            return r.status_code == 200 and "jobPostings" in r.json()
        if ats_type == "greenhouse":
            r = requests.get(
                f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                headers=HEADERS, timeout=TIMEOUT,
            )
            return r.status_code == 200 and "jobs" in r.json()
        if ats_type == "lever":
            r = requests.get(
                f"https://api.lever.co/v0/postings/{slug}?mode=json",
                headers=HEADERS, timeout=TIMEOUT,
            )
            return r.status_code == 200
        if ats_type == "icims":
            r = requests.get(
                f"https://{slug}.icims.com/jobs/search",
                headers=HEADERS, timeout=TIMEOUT,
            )
            return r.status_code == 200
        if ats_type == "ashby":
            r = requests.get(
                f"https://jobs.ashby.com/api/posting-api/job-board?organizationHostedJobsPageName={slug}",
                headers=HEADERS, timeout=TIMEOUT,
            )
            return r.status_code == 200
        if ats_type == "smartrecruiters":
            r = requests.get(
                f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
                headers=HEADERS, timeout=TIMEOUT,
            )
            return r.status_code == 200 and r.json().get("totalFound", 0) > 0
        if ats_type in ("taleo", "bamboohr", "jobvite", "workable"):
            # For URL-detected ATS types, trust the URL pattern match
            return True
    except Exception:
        pass
    return False


def detect_from_domain(domain: str) -> tuple:
    """Check /careers and /jobs redirect chain for ATS URLs. Returns (ats_type, slug) or (None, None)."""
    for path in ["/careers", "/jobs", "/en/careers", "/company/careers"]:
        try:
            r = requests.get(
                f"https://{domain}{path}",
                headers=HEADERS,
                timeout=TIMEOUT,
                allow_redirects=True,
            )
            # Check all URLs in redirect chain + page content
            all_urls = [resp.url for resp in r.history] + [r.url]
            page_content = r.text
            for source in all_urls + [page_content]:
                for ats_type, pattern, extract in ATS_PATTERNS:
                    m = pattern.search(source)
                    if m:
                        slug = extract(m)
                        # Filter out obvious false positives (login, en-US paths)
                        if slug and not any(x in slug.lower() for x in ["login", "en-us", "sign-in"]):
                            return ats_type, slug
        except Exception:
            pass
    return None, None


FAILURES_CSV = Path(__file__).parent.parent / "data" / "overrides_failed.csv"

# Parse --limit N from CLI args
_limit_val = None
for _idx, _arg in enumerate(sys.argv):
    if _arg == "--limit" and _idx + 1 < len(sys.argv):
        try:
            _limit_val = int(sys.argv[_idx + 1])
        except ValueError:
            pass

FROM_FAILURES = "--from-failures" in sys.argv


def load_failure_names() -> set[str]:
    """Load employer names from the overrides_failed.csv (slug_not_live entries only)."""
    if not FAILURES_CSV.exists():
        return set()
    names = set()
    with open(FAILURES_CSV) as f:
        for row in csv.DictReader(f):
            if row.get("reason") == "slug_not_live":
                names.add(row["key"].lower().strip())
    return names


if __name__ == "__main__":
    all_employers = (
        sb.table("employers")
        .select("id,name,domain,lca_count,name_clean")
        .order("lca_count", desc=True)
        .execute()
        .data
    )
    mapped_ids = {
        r["employer_id"]
        for r in sb.table("employer_ats").select("employer_id").execute().data
    }

    if FROM_FAILURES:
        failure_names = load_failure_names()
        # Include unmapped employers AND already-mapped ones whose name matches a failure
        # (they may have a wrong/stale ATS entry from a previous run)
        to_check = [
            e for e in all_employers
            if (e.get("name_clean") or e["name"].lower()) in failure_names
            or any(fn in (e.get("name_clean") or e["name"].lower()) for fn in failure_names)
        ]
        # For --from-failures, also process mapped employers (they may have wrong slugs)
        print(f"--from-failures mode: {len(to_check)} employers matched from failures log\n")
    else:
        to_check = [e for e in all_employers if e["id"] not in mapped_ids]
        if _limit_val:
            to_check = to_check[:_limit_val]
            print(f"--limit {_limit_val}: checking top {len(to_check)} unmapped employers (DRY_RUN={DRY_RUN})\n")
        else:
            print(f"{len(to_check)} employers to probe (DRY_RUN={DRY_RUN})\n")

    found = 0
    for i, emp in enumerate(to_check):
        name = emp["name"]
        domain = emp.get("domain")
        print(f"[{i+1}/{len(to_check)}] {name[:50]}", end=" ... ", flush=True)

        # Try domain-based redirect detection first (faster, more accurate)
        ats_type, slug = None, None
        if domain:
            ats_type, slug = detect_from_domain(domain)
            if ats_type:
                print(f"domain→{ats_type}:{slug}", end=" ", flush=True)

        # Fall back to DuckDuckGo search
        if not ats_type:
            result = search_ats(name)
            if result:
                ats_type, slug = result

        if not ats_type:
            print("not found")
            time.sleep(1)
            continue

        ok = verify_slug(ats_type, slug)
        status = "✓" if ok else "unverified"
        print(f"FOUND {status} → {ats_type}:{slug}")
        found += 1

        if not DRY_RUN and ok:
            sb.table("employer_ats").upsert(
                {"employer_id": emp["id"], "ats_type": ats_type, "slug": slug},
                on_conflict="employer_id,ats_type",
            ).execute()

        time.sleep(1.5)  # be polite to DDG

    print(f"\nDone. {found}/{len(to_check)} employers matched.")
    if DRY_RUN:
        print("DRY RUN — nothing written to DB.")
