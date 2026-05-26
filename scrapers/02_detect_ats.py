"""
02_detect_ats.py
For each employer in Supabase, guess ATS slugs and verify which resolves.
Writes confirmed ATS mappings to employer_ats table.
Run once after 01_process_lca.py, then re-run periodically to catch new companies.

Disambiguation strategy (handles same name / different slug cases like Block, SoFi):
  1. Name verification  — after a slug resolves, fetch the company name the ATS
                          returns and fuzzy-match it against the LCA employer name.
                          Score < 0.65 → saved but flagged needs_review=True.
  2. FEIN deduplication — if another employer row with the same FEIN already has
                          an ATS entry, copy it instead of re-detecting.
  3. Slug overrides      — employer_slug_overrides table holds manually curated
                          (fein, ats_type, slug) rows. Checked before auto-detection.
                          Use 10_add_override.py to add entries.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
import time
import difflib
import subprocess
import requests
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

PULL_EVERY = 5      # pull jobs after every N new ATS finds
QA_EMPLOYERS = 3    # number of random employers to spot-check after each pull
QA_JOBS_EACH = 1    # number of random jobs per employer to check

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 8
NAME_MATCH_THRESHOLD = 0.65  # below this → needs_review = True


def slugify(name: str) -> list[str]:
    """Generate candidate slugs from a company name."""
    base = re.sub(r"[^\w\s-]", "", name.lower())
    base = re.sub(r"[\s_]+", "-", base.strip())
    cleaned = re.sub(r"-(inc|llc|corp|ltd|co|group|technologies|technology|labs|ai)$", "", base)
    candidates = list(dict.fromkeys([base, cleaned]))
    return candidates


def fuzzy_score(a: str, b: str) -> float:
    """Case-insensitive fuzzy match ratio between two strings."""
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


# ── ATS checkers ─────────────────────────────────────────────────────────────
# Each returns (company_name_or_None, matched: bool)

def check_greenhouse(slug: str) -> tuple[str | None, bool]:
    try:
        # Board info endpoint returns company name
        r = requests.get(
            f"https://boards-api.greenhouse.io/v1/boards/{slug}",
            headers=HEADERS, timeout=TIMEOUT,
        )
        if r.status_code != 200:
            return None, False
        data = r.json()
        company_name = data.get("name")
        # Confirm jobs exist
        r2 = requests.get(
            f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
            headers=HEADERS, timeout=TIMEOUT,
        )
        if r2.status_code == 200 and "jobs" in r2.json():
            return company_name, True
        return None, False
    except Exception:
        return None, False


def check_lever(slug: str) -> tuple[str | None, bool]:
    # Lever postings API doesn't expose company name — skip name verification
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return None, r.status_code == 200 and isinstance(r.json(), list)
    except Exception:
        return None, False


def check_ashby(slug: str) -> tuple[str | None, bool]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return None, False
        data = r.json()
        company_name = (data.get("organization") or {}).get("name")
        return company_name, len(data.get("jobs", [])) > 0
    except Exception:
        return None, False


def check_workday(slug: str):
    """Try common Workday instance + jobsite combinations. Returns full slug or None.
    Slug format: {subdomain}.{instance}/{jobsite}  e.g. capitalone.wd12/Capital_One
    """
    jobsites = list(dict.fromkeys([
        slug,
        slug.replace("-", ""),
        slug.replace("-", "_"),
        slug.title().replace("-", ""),
    ]))
    for instance in ["wd1", "wd5", "wd3", "wd12"]:
        for jobsite in jobsites:
            api_url = (
                f"https://{slug}.{instance}.myworkdayjobs.com"
                f"/wday/cxs/{slug}/{jobsite}/jobs"
            )
            try:
                r = requests.post(
                    api_url,
                    json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""},
                    headers={**HEADERS, "Content-Type": "application/json"},
                    timeout=TIMEOUT,
                )
                if r.status_code == 200 and "jobPostings" in r.json():
                    return f"{slug}.{instance}/{jobsite}"
            except Exception:
                pass
            time.sleep(0.2)
    return None


def check_smartrecruiters(slug: str) -> tuple[str | None, bool]:
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return None, r.status_code == 200 and r.json().get("totalFound", 0) > 0
    except Exception:
        return None, False


def check_icims(slug: str) -> tuple[str | None, bool]:
    url = f"https://{slug}.icims.com/jobs/search"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        return None, r.status_code == 200
    except Exception:
        return None, False


def check_bamboohr(slug: str) -> tuple[str | None, bool]:
    url = f"https://{slug}.bamboohr.com/jobs/"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        matched = (
            r.status_code == 200
            and f"{slug}.bamboohr.com" in r.url
            and "expired" not in r.url
        )
        return None, matched
    except Exception:
        return None, False


def check_workable(slug: str) -> tuple[str | None, bool]:
    # ?details=true returns the account's jobs list. Requiring jobs>0 avoids
    # false positives on squatted/placeholder slugs (e.g. "microsoft", "test"
    # return 200 with name populated but jobs:[]).
    url = f"https://www.workable.com/api/accounts/{slug}?details=true"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return None, False
        data = r.json()
        if not data.get("jobs"):
            return None, False
        return data.get("name"), True
    except Exception:
        return None, False


# ATS_CHECKS ordered by approximate prevalence among H-1B sponsors.
ATS_CHECKS = [
    ("greenhouse", check_greenhouse),
    ("lever", check_lever),
    ("icims", check_icims),
    ("smartrecruiters", check_smartrecruiters),
    ("ashby", check_ashby),
    ("bamboohr", check_bamboohr),
    ("workable", check_workable),
    # Workday omitted: jobsite names are non-guessable.
    # Add via detect_workday_urls.py or 10_add_override.py.
]


def detect_ats(employer_id: int, name: str, fein: str | None, overrides: dict, fein_map: dict):
    """
    Returns a dict ready for upsert into employer_ats, or None.

    Priority:
      1. Slug override (manually curated, keyed by FEIN)
      2. FEIN dedup (copy existing entry from sibling employer row)
      3. Auto slug guessing with name verification
    """

    # ── Option 3: check manual override table ────────────────────────────────
    if fein and fein in overrides:
        ov = overrides[fein]
        print(f"    → override: {ov['ats_type']}:{ov['slug']}")
        return {
            "employer_id": employer_id,
            "ats_type": ov["ats_type"],
            "slug": ov["slug"],
            "ats_company_name": None,
            "name_match_score": None,
            "needs_review": False,
        }

    # ── Option 2: FEIN deduplication ─────────────────────────────────────────
    if fein and fein in fein_map:
        existing = fein_map[fein]
        print(f"    → FEIN dedup from employer_id {existing['employer_id']}: "
              f"{existing['ats_type']}:{existing['slug']}")
        return {
            "employer_id": employer_id,
            "ats_type": existing["ats_type"],
            "slug": existing["slug"],
            "ats_company_name": existing.get("ats_company_name"),
            "name_match_score": existing.get("name_match_score"),
            "needs_review": existing.get("needs_review", False),
        }

    # ── Option 1: auto-detect with name verification ──────────────────────────
    for slug in slugify(name):
        for ats_type, checker in ATS_CHECKS:
            ats_company_name, matched = checker(slug)
            if not matched:
                time.sleep(0.3)
                continue

            # Fuzzy-match the name the ATS returned against our LCA name
            score = None
            needs_review = False
            if ats_company_name:
                score = fuzzy_score(name, ats_company_name)
                needs_review = score < NAME_MATCH_THRESHOLD
                flag = "⚠ REVIEW" if needs_review else "✓"
                print(f"    name match: '{ats_company_name}' vs '{name}' → {score:.2f} {flag}")

            return {
                "employer_id": employer_id,
                "ats_type": ats_type,
                "slug": slug,
                "ats_company_name": ats_company_name,
                "name_match_score": score,
                "needs_review": needs_review,
            }

    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None,
                        help="Max employers to scan (highest lca_count first)")
    args = parser.parse_args()

    # Load all employers (with FEIN + lca_count for priority ordering)
    employers = sb.table("employers").select("id,name,fein,lca_count").order("lca_count", desc=True).execute().data

    # Build set of employer_ids already mapped
    existing_rows = sb.table("employer_ats").select("employer_id,ats_type,slug,ats_company_name,name_match_score,needs_review,employers(fein)").execute().data
    existing_ids = {r["employer_id"] for r in existing_rows}

    # Option 2: build FEIN → existing ATS entry map (skip FEINs with no ATS yet)
    fein_map: dict[str, dict] = {}
    for r in existing_rows:
        emp_fein = (r.get("employers") or {}).get("fein")
        if emp_fein and emp_fein not in fein_map:
            fein_map[emp_fein] = r

    # Option 3: load manual overrides keyed by FEIN
    override_rows = sb.table("employer_slug_overrides").select("fein,ats_type,slug").execute().data
    overrides: dict[str, dict] = {r["fein"]: r for r in override_rows}
    if overrides:
        print(f"Loaded {len(overrides)} manual slug override(s)")

    to_check = [e for e in employers if e["id"] not in existing_ids]
    if args.limit:
        to_check = to_check[:args.limit]
    print(f"{len(to_check)} employers to check (skipping {len(existing_ids)} already mapped)")

    def qa_job_links(employer_ids: list[int]):
        """
        Spot-check apply links after a pull.
        Picks QA_EMPLOYERS random employers from the batch, then QA_JOBS_EACH
        random job from each, and verifies the URL returns a non-404 response.
        """
        if not employer_ids:
            return

        # Fetch all active jobs for these employers from DB
        rows = (
            sb.table("jobs")
            .select("id,employer_id,title,url")
            .in_("employer_id", employer_ids)
            .eq("is_active", True)
            .execute()
            .data
        )
        if not rows:
            print("  ── QA: no jobs in DB yet for this batch, skipping ──")
            return

        # Group by employer
        by_employer: dict[int, list[dict]] = {}
        for r in rows:
            by_employer.setdefault(r["employer_id"], []).append(r)

        sample_employers = random.sample(list(by_employer.keys()), min(QA_EMPLOYERS, len(by_employer)))

        print(f"\n  ── QA: checking {QA_JOBS_EACH} job(s) from {len(sample_employers)} random employer(s) ──")
        all_pass = True
        for emp_id in sample_employers:
            jobs = random.sample(by_employer[emp_id], min(QA_JOBS_EACH, len(by_employer[emp_id])))
            for job in jobs:
                url = job.get("url", "")
                title = job.get("title", "")[:50]
                if not url:
                    print(f"    ⚠  employer_id={emp_id} | {title} — no URL")
                    all_pass = False
                    continue
                try:
                    resp = requests.get(url, headers={"User-Agent": "getdatjob-bot/1.0"},
                                        timeout=10, allow_redirects=True)
                    ok = resp.status_code < 400
                    icon = "✓" if ok else "✗"
                    print(f"    {icon}  [{resp.status_code}] employer_id={emp_id} | {title}")
                    if not ok:
                        print(f"         URL: {url}")
                        all_pass = False
                except Exception as e:
                    print(f"    ✗  employer_id={emp_id} | {title} — {e}")
                    all_pass = False
                time.sleep(0.5)

        if all_pass:
            print("  ── QA passed ✓ ──\n")
        else:
            print("  ── QA FAILED — check URLs above ✗ ──\n")

    def flush_pull(employer_ids: list[int]):
        """Pull jobs for a batch of newly found employer IDs, then QA apply links."""
        if not employer_ids:
            return
        print(f"\n  ── pulling jobs for {len(employer_ids)} new employer(s): {employer_ids} ──")
        subprocess.run(
            [sys.executable, "-u", "scrapers/03_pull_jobs.py",
             "--employer-ids"] + [str(eid) for eid in employer_ids],
            check=False,
        )
        print(f"  ── pull done ──")
        qa_job_links(employer_ids)

    found = 0
    pending_pull: list[int] = []

    for i, emp in enumerate(to_check):
        print(f"  [{i+1}/{len(to_check)}] {emp['name']}")
        result = detect_ats(emp["id"], emp["name"], emp.get("fein"), overrides, fein_map)
        if result:
            sb.table("employer_ats").upsert(result, on_conflict="employer_id,ats_type").execute()
            flag = " ⚠ needs_review" if result.get("needs_review") else ""
            print(f"    ✓ {result['ats_type']}:{result['slug']}{flag}")
            # Update fein_map so subsequent employers with the same FEIN get deduped
            fein = emp.get("fein")
            if fein and fein not in fein_map:
                fein_map[fein] = result
            found += 1
            # Queue for job pull (skip manual_review — no fetcher for it)
            if result["ats_type"] != "manual_review":
                pending_pull.append(emp["id"])
                if len(pending_pull) >= PULL_EVERY:
                    flush_pull(pending_pull)
                    pending_pull = []
        else:
            print(f"    — no ATS found")
        time.sleep(0.5)

    # Flush any remaining employers that didn't fill the last batch
    flush_pull(pending_pull)

    print(f"\nDone. {found}/{len(to_check)} employers matched to an ATS.")
