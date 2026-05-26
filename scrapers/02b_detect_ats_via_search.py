#!/usr/bin/env python3
"""
02b_detect_ats_via_search.py — ALTERNATIVE ATS detection prototype.

Approach (different from 02_detect_ats.py):
  1. For each unmapped employer, search DuckDuckGo for "<company name> careers"
  2. Visit the top few result URLs (skipping LinkedIn/Indeed/Glassdoor noise)
  3. Regex-scan each page's HTML for known ATS URL patterns
       — apply buttons, embedded iframes, script srcs, anchor hrefs
  4. Report: company → discovered ATS type + slug + source URL (or no match)

Differences from the existing detector:
  - Discovers ATSes we don't currently probe (Workday, Oracle HCM, SAP SuccessFactors,
    Taleo, Phenom, Eightfold, Jobvite, Avature, Recruitee, Breezy, JazzHR, etc.)
  - Doesn't depend on the company name matching the ATS slug — works for any naming
  - Slower per employer (search + page fetch + scan) but higher recall on enterprise ATSes

READ-ONLY: does not write to Supabase. Just prints findings.

Usage:
  python3 scrapers/02b_detect_ats_via_search.py --limit 20
  python3 scrapers/02b_detect_ats_via_search.py --names "AppLovin Corporation, Archer Aviation Inc."
"""
from __future__ import annotations

import re
import time
import argparse
from urllib.parse import urlparse, quote_plus, unquote, parse_qs

import requests
from bs4 import BeautifulSoup
from supabase import create_client

from config import SUPABASE_URL, SUPABASE_KEY

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 12
POLITE_SLEEP = 1.0

# Sites that show up in "<company> careers" searches but never reveal the ATS
SEARCH_NOISE_HOSTS = {
    "linkedin.com", "www.linkedin.com",
    "indeed.com", "www.indeed.com",
    "glassdoor.com", "www.glassdoor.com",
    "ziprecruiter.com", "www.ziprecruiter.com",
    "monster.com", "www.monster.com",
    "facebook.com", "www.facebook.com", "twitter.com", "x.com",
    "youtube.com", "www.youtube.com",
    "wikipedia.org", "en.wikipedia.org",
}

# ATS URL patterns. Order matters: more-specific patterns first.
# Format: (regex, ats_type, slug_group_index_or_0)
ATS_PATTERNS = [
    # Greenhouse
    (r"boards\.greenhouse\.io/embed/job_board\?for=([a-z0-9_-]+)", "greenhouse", 1),
    (r"boards-api\.greenhouse\.io/v1/boards/([a-z0-9_-]+)", "greenhouse", 1),
    (r"job-boards\.greenhouse\.io/([a-z0-9_-]+)", "greenhouse", 1),
    (r"boards\.greenhouse\.io/([a-z0-9_-]+)", "greenhouse", 1),
    # Lever
    (r"jobs\.lever\.co/([a-z0-9_-]+)", "lever", 1),
    (r"api\.lever\.co/v0/postings/([a-z0-9_-]+)", "lever", 1),
    # Workday — capture tenant subdomain
    (r"([a-z0-9_-]+)\.wd[0-9]+\.myworkdayjobs\.com", "workday", 1),
    (r"([a-z0-9_-]+)\.myworkdayjobs\.com", "workday", 1),
    # iCIMS
    (r"careers-([a-z0-9_-]+)\.icims\.com", "icims", 1),
    (r"([a-z0-9_-]+)\.icims\.com", "icims", 1),
    # SmartRecruiters
    (r"jobs\.smartrecruiters\.com/([a-z0-9_-]+)", "smartrecruiters", 1),
    (r"careers\.smartrecruiters\.com/([a-z0-9_-]+)", "smartrecruiters", 1),
    (r"api\.smartrecruiters\.com/v1/companies/([a-z0-9_-]+)", "smartrecruiters", 1),
    # Ashby
    (r"jobs\.ashbyhq\.com/([a-z0-9_-]+)", "ashby", 1),
    (r"api\.ashbyhq\.com/posting-api/job-board/([a-z0-9_-]+)", "ashby", 1),
    # BambooHR
    (r"([a-z0-9_-]+)\.bamboohr\.com", "bamboohr", 1),
    # Workable
    (r"apply\.workable\.com/([a-z0-9_-]+)", "workable", 1),
    (r"jobs\.workable\.com/api/v1/accounts/([a-z0-9_-]+)", "workable", 1),
    # === Below: ATSes the existing detector does NOT support ===
    # Oracle Taleo
    (r"([a-z0-9_-]+)\.taleo\.net", "taleo", 1),
    # Oracle HCM Cloud
    (r"([a-z0-9_-]+)\.oraclecloud\.com/hcmUI", "oracle_hcm", 1),
    (r"ecsn\.oraclecloud\.com", "oracle_hcm", 0),
    # SAP SuccessFactors
    (r"performancemanager\d*\.successfactors\.com", "successfactors", 0),
    (r"jobs\.sap\.com", "successfactors", 0),
    # Jobvite
    (r"jobs\.jobvite\.com/([a-z0-9_-]+)", "jobvite", 1),
    (r"app\.jobvite\.com/j/?\?cj=", "jobvite", 0),
    # Phenom
    (r"([a-z0-9_-]+)\.phenompeople\.com", "phenom", 1),
    # Eightfold
    (r"([a-z0-9_-]+)\.eightfold\.ai", "eightfold", 1),
    # Avature
    (r"([a-z0-9_-]+)\.avature\.net", "avature", 1),
    # Recruitee
    (r"([a-z0-9_-]+)\.recruitee\.com", "recruitee", 1),
    # Breezy
    (r"([a-z0-9_-]+)\.breezy\.hr", "breezy", 1),
    # Teamtailor
    (r"([a-z0-9_-]+)\.teamtailor\.com", "teamtailor", 1),
    # Pinpoint
    (r"([a-z0-9_-]+)\.pinpointhq\.com", "pinpoint", 1),
    # JazzHR
    (r"([a-z0-9_-]+)\.applytojob\.com", "jazzhr", 1),
    # Workday-via-myworkdaysite (newer variant)
    (r"([a-z0-9_-]+)\.myworkdaysite\.com", "workday", 1),
]

# Slug values that indicate a generic / wrong capture (e.g. matching "www.icims.com")
GENERIC_SLUGS = {
    "www", "api", "jobs", "careers", "apply", "boards", "app",
    "static", "assets", "cdn", "help", "support", "login",
    "secure", "host", "id", "embed", "track",
}


def search_duckduckgo(query: str, max_results: int = 5) -> list[str]:
    """Scrape DuckDuckGo HTML results. No API key needed."""
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, "html.parser")
        results = []
        for a in soup.select("a.result__a"):
            href = a.get("href", "")
            # DDG wraps URLs in /l/?uddg=<encoded>
            if href.startswith("//duckduckgo.com/l/?") or href.startswith("/l/?"):
                parsed = urlparse(href if href.startswith("//") else "https:" + href)
                qs = parse_qs(parsed.query)
                if "uddg" in qs:
                    results.append(unquote(qs["uddg"][0]))
            elif href.startswith("http"):
                results.append(href)
            if len(results) >= max_results:
                break
        return results
    except Exception as e:
        print(f"      search error: {e}")
        return []


def is_noise(url: str) -> bool:
    host = urlparse(url).hostname or ""
    host = host.lower()
    return host in SEARCH_NOISE_HOSTS or any(host.endswith("." + n) for n in SEARCH_NOISE_HOSTS)


def fetch_page(url: str) -> str | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        if r.status_code == 200 and r.text:
            # Include the final URL in the scan body (catches redirects to ATS)
            return r.url + "\n" + r.text
    except Exception:
        pass
    return None


def detect_ats_in_html(html: str) -> list[tuple[str, str]]:
    """Scan HTML for ATS URL patterns. Returns list of (ats_type, slug)."""
    found = []
    seen = set()
    for pattern, ats_type, group_idx in ATS_PATTERNS:
        for match in re.finditer(pattern, html, re.IGNORECASE):
            slug = match.group(group_idx).lower() if group_idx > 0 else ""
            if group_idx > 0 and slug in GENERIC_SLUGS:
                continue
            key = (ats_type, slug)
            if key in seen:
                continue
            seen.add(key)
            found.append(key)
    return found


def discover_ats(name: str, verbose: bool = True) -> tuple[str, str, str] | None:
    """Returns (ats_type, slug, source_url) or None."""
    query = f'"{name}" careers apply'
    urls = search_duckduckgo(query, max_results=6)
    urls = [u for u in urls if not is_noise(u)]
    if verbose and not urls:
        print(f"      (no usable search results)")
    for url in urls[:4]:
        if verbose:
            print(f"      → {url}")
        html = fetch_page(url)
        if not html:
            continue
        matches = detect_ats_in_html(html)
        if matches:
            ats_type, slug = matches[0]
            return ats_type, slug, url
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=20,
                        help="Max unmapped employers to check from DB (default 20)")
    parser.add_argument("--names", type=str, default=None,
                        help="Comma-separated company names to test (skips DB lookup)")
    parser.add_argument("--quiet", action="store_true",
                        help="Only print final summary")
    args = parser.parse_args()

    if args.names:
        companies = [n.strip() for n in args.names.split(",") if n.strip()]
        print(f"Testing {len(companies)} explicit name(s)")
    else:
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)
        employers = sb.table("employers").select("id,name,lca_count").order(
            "lca_count", desc=True
        ).execute().data
        mapped_rows = sb.table("employer_ats").select("employer_id").execute().data
        mapped_ids = {r["employer_id"] for r in mapped_rows}
        companies = [e["name"] for e in employers if e["id"] not in mapped_ids][:args.limit]
        print(f"{len(companies)} unmapped employers to check (skipping {len(mapped_ids)} mapped)")

    hits = []
    for i, name in enumerate(companies, 1):
        print(f"  [{i}/{len(companies)}] {name}")
        result = discover_ats(name, verbose=not args.quiet)
        if result:
            ats_type, slug, source = result
            slug_disp = f":{slug}" if slug else ""
            print(f"    ✓ {ats_type}{slug_disp}  (from {source})")
            hits.append((name, ats_type, slug, source))
        else:
            print(f"    — no ATS found")
        time.sleep(POLITE_SLEEP)

    print(f"\nDone. {len(hits)}/{len(companies)} discovered via search.")
    if hits:
        print("\nDiscovered mappings (NOT written to DB):")
        for name, ats_type, slug, source in hits:
            slug_disp = f":{slug}" if slug else ""
            print(f"  {name}  →  {ats_type}{slug_disp}")


if __name__ == "__main__":
    main()
