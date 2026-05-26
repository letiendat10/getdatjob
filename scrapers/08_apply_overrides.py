"""
08_apply_overrides.py
Batch-verify and apply all SLUG_OVERRIDES from detect_ats_dryrun.py to the employer_ats table.
Also adds new ATS checkers: SmartRecruiters, Workable, Recruitee.

Run after 02_detect_ats.py to cover companies that need brand-name → slug mapping.
Usage:
    python3 scrapers/08_apply_overrides.py           # write to DB
    python3 scrapers/08_apply_overrides.py --dry-run # print only
    python3 scrapers/08_apply_overrides.py --force   # re-check and overwrite already-mapped entries
"""

import re
import sys
import time
import csv
import requests
from pathlib import Path
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY
from detect_ats_dryrun import SLUG_OVERRIDES

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

DRY_RUN = "--dry-run" in sys.argv
FORCE = "--force" in sys.argv  # re-check and overwrite even if already mapped
HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 8
FAILED_LOG = Path(__file__).parent.parent / "data" / "overrides_failed.csv"


# ── ATS checkers ─────────────────────────────────────────────────────────────

def check_greenhouse(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return r.status_code == 200 and "jobs" in r.json()
    except Exception:
        return False


def check_lever(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://api.lever.co/v0/postings/{slug}?mode=json",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return r.status_code == 200 and isinstance(r.json(), list)
    except Exception:
        return False


def check_ashby(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://jobs.ashby.com/api/posting-api/job-board?organizationHostedJobsPageName={slug}",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return r.status_code == 200 and "jobPostings" in r.json()
    except Exception:
        return False


def check_smartrecruiters(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
            headers=HEADERS, timeout=TIMEOUT,
        )
        # 200 with totalFound=0 means company slug doesn't exist — must be > 0
        return r.status_code == 200 and r.json().get("totalFound", 0) > 0
    except Exception:
        return False


def check_workable(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://www.workable.com/api/accounts/{slug}?details=true",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return r.status_code == 200 and "jobs" in r.json()
    except Exception:
        return False


def check_recruitee(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://{slug}.recruitee.com/api/offers/",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return r.status_code == 200 and isinstance(r.json(), (list, dict))
    except Exception:
        return False


def check_workday(slug: str) -> bool:
    """slug format: {subdomain}.{instance}/{jobsite}"""
    try:
        host, jobsite = slug.split("/", 1)
        tenant = host.split(".")[0]
        r = requests.post(
            f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}/jobs",
            json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""},
            headers={**HEADERS, "Content-Type": "application/json"},
            timeout=TIMEOUT,
        )
        return r.status_code == 200 and "jobPostings" in r.json()
    except Exception:
        return False


def check_icims(slug: str) -> bool:
    try:
        r = requests.get(
            f"https://{slug}.icims.com/jobs/search",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return r.status_code == 200
    except Exception:
        return False


CHECKERS = {
    "greenhouse": check_greenhouse,
    "lever": check_lever,
    "ashby": check_ashby,
    "smartrecruiters": check_smartrecruiters,
    "workable": check_workable,
    "recruitee": check_recruitee,
    "workday": check_workday,
    "icims": check_icims,
}


# ── Main ─────────────────────────────────────────────────────────────────────

def build_name_index(employers):
    """Map name_clean substrings → employer rows for fast lookup."""
    index = {}
    for emp in employers:
        nc = emp.get("name_clean") or emp["name"].lower()
        index[nc] = emp
    return index


def find_employer(override_key: str, name_index: dict, employers: list):
    """Find employer matching the override key by substring."""
    key = override_key.lower().strip()
    # Exact match first
    if key in name_index:
        return name_index[key]
    # Substring match — key is a prefix/substring of name_clean
    matches = [e for nc, e in name_index.items() if key in nc or nc.startswith(key)]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        # Prefer shortest name (most specific match)
        return min(matches, key=lambda e: len(e.get("name_clean") or ""))
    return None


def main():
    employers = sb.table("employers").select("id,name,name_clean").execute().data
    already_mapped = {
        r["employer_id"]
        for r in sb.table("employer_ats").select("employer_id").execute().data
    }
    name_index = build_name_index(employers)

    hits = []
    skipped_none = []
    failed = []

    overrides = {k: v for k, v in SLUG_OVERRIDES.items() if v is not None}
    print(f"Processing {len(overrides)} non-None overrides (DRY_RUN={DRY_RUN})\n")

    for i, (key, (ats_type, slug)) in enumerate(overrides.items()):
        emp = find_employer(key, name_index, employers)
        if not emp:
            failed.append({"key": key, "ats_type": ats_type, "slug": slug, "reason": "employer_not_found"})
            print(f"  [{i+1}] {key[:45]:45} → NOT IN DB")
            continue

        if emp["id"] in already_mapped and not FORCE:
            print(f"  [{i+1}] {emp['name'][:45]:45} → ALREADY MAPPED (skip, use --force to overwrite)")
            continue

        checker = CHECKERS.get(ats_type)
        if not checker:
            failed.append({"key": key, "ats_type": ats_type, "slug": slug, "reason": f"no_checker_for_{ats_type}"})
            continue

        ok = checker(slug)
        time.sleep(0.3)

        if ok:
            hits.append({"employer_id": emp["id"], "ats_type": ats_type, "slug": slug})
            already_mapped.add(emp["id"])
            print(f"  [{i+1}] {emp['name'][:45]:45} → ✓ {ats_type}:{slug}")
            if not DRY_RUN:
                sb.table("employer_ats").upsert(
                    {"employer_id": emp["id"], "ats_type": ats_type, "slug": slug},
                    on_conflict="employer_id,ats_type",
                ).execute()
        else:
            failed.append({"key": key, "ats_type": ats_type, "slug": slug, "reason": "slug_not_live"})
            print(f"  [{i+1}] {emp['name'][:45]:45} → ✗ {ats_type}:{slug} (dead)")

    print(f"\n{'='*60}")
    print(f"Hits: {len(hits)}  |  Failed/dead: {len(failed)}")
    if DRY_RUN:
        print("DRY RUN — nothing written to DB")

    # Write failures log
    if failed:
        FAILED_LOG.parent.mkdir(exist_ok=True)
        with open(FAILED_LOG, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["key", "ats_type", "slug", "reason"])
            w.writeheader()
            w.writerows(failed)
        print(f"Failed entries written to {FAILED_LOG}")


if __name__ == "__main__":
    main()
