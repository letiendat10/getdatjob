"""
09_qa_ats.py
QA check for all employer_ats entries.

Checks:
1. Slug liveness — API endpoint returns HTTP 200 + non-empty jobs
2. Zero-jobs flag — live but 0 jobs → status EMPTY
3. LCA cross-check — lca_count >= 5 and not LIVE → HIGH_PRIORITY
4. Malformed slug — workday type without .wd → BAD_SLUG

Output:
- stdout summary
- data/qa_ats_{date}.csv
- Google Sheet tab 'ats_qa' (auto-upload, non-blocking)

Usage:
    python3 scrapers/09_qa_ats.py
    python3 scrapers/09_qa_ats.py --dry-run   (no sheet upload)
"""

import csv
import re
import sys
import time
import requests
from datetime import date
from pathlib import Path
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

DRY_RUN = "--dry-run" in sys.argv
HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 10
DATA_DIR = Path(__file__).parent.parent / "data"


# ── ATS job count checkers ────────────────────────────────────────────────────

def count_greenhouse(slug: str):
    r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 200:
        return len(r.json().get("jobs", []))
    return None


def count_lever(slug: str):
    r = requests.get(f"https://api.lever.co/v0/postings/{slug}?mode=json", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 200 and isinstance(r.json(), list):
        return len(r.json())
    return None


def count_ashby(slug: str):
    r = requests.get(
        f"https://api.ashbyhq.com/posting-api/job-board/{slug}",
        headers=HEADERS, timeout=TIMEOUT,
    )
    if r.status_code == 200:
        return len(r.json().get("jobs", []))
    return None


def count_workday(slug: str):
    if "/" not in slug:
        return None
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    r = requests.post(
        f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}/jobs",
        json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""},
        headers={**HEADERS, "Content-Type": "application/json"},
        timeout=TIMEOUT,
    )
    if r.status_code == 200:
        return r.json().get("total", 0)
    return None


def count_icims(slug: str):
    r = requests.get(f"https://{slug}.icims.com/jobs/search", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 200:
        return 1  # iCIMS doesn't return a clean count easily; treat 200 as live
    return None


def count_smartrecruiters(slug: str):
    r = requests.get(
        f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
        headers=HEADERS, timeout=TIMEOUT,
    )
    if r.status_code == 200:
        return r.json().get("totalFound", 0)
    return None


def count_workable(slug: str):
    r = requests.get(f"https://www.workable.com/api/accounts/{slug}?details=true", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 200:
        return len(r.json().get("jobs", []))
    return None


def count_bamboohr(slug: str):
    r = requests.get(f"https://{slug}.bamboohr.com/jobs/embed2.php?version=1", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 200:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(r.text, "html.parser")
        job_ids = {m.group(1) for a in soup.select("a[href*='/jobs/']")
                   for m in [re.search(r"/jobs/(\d+)/", a.get("href", ""))] if m}
        return len(job_ids)
    return None


def count_recruitee(slug: str):
    r = requests.get(f"https://{slug}.recruitee.com/api/offers/", headers=HEADERS, timeout=TIMEOUT)
    if r.status_code == 200:
        data = r.json()
        if isinstance(data, list):
            return len(data)
        return len(data.get("offers", []))
    return None


# Custom scrapers — just check liveness (non-zero response)
def count_custom(slug: str, ats_type: str):
    if ats_type == "amazon":
        r = requests.get(
            "https://www.amazon.jobs/en/search.json?result_limit=1&normalized_country_code[]=USA",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return 1 if r.status_code == 200 else None
    if ats_type == "microsoft":
        r = requests.get(
            "https://gcsservices.careers.microsoft.com/search/api/v1/search?lc=en_us&pg=1&pgSz=1&country=United%20States",
            headers=HEADERS, timeout=TIMEOUT,
        )
        return 1 if r.status_code == 200 else None
    if ats_type == "apple":
        r = requests.post(
            "https://jobs.apple.com/api/role/search",
            json={"filters": {"locations": {"USA": 1}}, "page": 1, "locale": "en-us"},
            headers={**HEADERS, "Content-Type": "application/json"},
            timeout=TIMEOUT,
        )
        return 1 if r.status_code == 200 else None
    return None


COUNTERS = {
    "greenhouse": count_greenhouse,
    "lever": count_lever,
    "ashby": count_ashby,
    "workday": count_workday,
    "icims": count_icims,
    "smartrecruiters": count_smartrecruiters,
    "workable": count_workable,
    "bamboohr": count_bamboohr,
    "recruitee": count_recruitee,
}


def get_job_count(ats_type: str, slug: str):
    if ats_type in ("amazon", "microsoft", "apple"):
        return count_custom(slug, ats_type)
    counter = COUNTERS.get(ats_type)
    if counter:
        try:
            return counter(slug)
        except Exception:
            return None
    return None


# ── QA logic ─────────────────────────────────────────────────────────────────

def determine_status_flags(ats_type: str, slug: str, job_count, lca_count: int):
    flags = []
    if job_count is None:
        status = "DEAD"
        if lca_count >= 5:
            flags.append("HIGH_PRIORITY")
    elif job_count == 0:
        status = "EMPTY"
        flags.append("ZERO_JOBS")
    else:
        status = "LIVE"

    # Malformed slug check
    if ats_type == "workday" and ".wd" not in slug:
        flags.append("BAD_SLUG")

    # Custom ATS down check
    if ats_type in ("amazon", "microsoft", "apple") and job_count is None:
        flags.append("CUSTOM_DOWN")

    return status, "|".join(flags) if flags else ""


def main():
    # Load all employer_ats rows with employer metadata
    ats_rows = sb.table("employer_ats").select("employer_id,ats_type,slug,verified_at").execute().data
    employers = {
        e["id"]: e
        for e in sb.table("employers").select("id,name,lca_count").execute().data
    }

    results = []
    live = dead = empty = 0

    print(f"Checking {len(ats_rows)} ATS entries...\n")

    for row in ats_rows:
        emp = employers.get(row["employer_id"], {})
        name = emp.get("name", f"id={row['employer_id']}")
        lca_count = emp.get("lca_count", 0) or 0
        ats_type = row["ats_type"]
        slug = row["slug"] or ""

        # Skip manual_review — no API to check, would pollute DEAD count
        if ats_type == "manual_review":
            continue

        print(f"  {name[:45]:45} {ats_type:15} {slug[:35]:35}", end=" ... ", flush=True)

        job_count = get_job_count(ats_type, slug)
        status, flags = determine_status_flags(ats_type, slug, job_count, lca_count)

        if status == "LIVE":
            live += 1
        elif status == "DEAD":
            dead += 1
        else:
            empty += 1

        print(f"{status} ({job_count} jobs) {flags}")

        results.append({
            "company": name,
            "ats_type": ats_type,
            "slug": slug,
            "status": status,
            "job_count": job_count if job_count is not None else "",
            "lca_count": lca_count,
            "flag": flags,
            "notes": "",
        })

        time.sleep(0.4)

    # Summary
    print(f"\n{'='*60}")
    print(f"LIVE: {live} | EMPTY: {empty} | DEAD: {dead}")
    high_priority = [r for r in results if "HIGH_PRIORITY" in r.get("flag", "")]
    bad_slugs = [r for r in results if "BAD_SLUG" in r.get("flag", "")]
    print(f"HIGH_PRIORITY: {len(high_priority)} | BAD_SLUG: {len(bad_slugs)}")

    # Export CSV
    today = date.today().isoformat()
    csv_path = DATA_DIR / f"qa_ats_{today}.csv"
    DATA_DIR.mkdir(exist_ok=True)
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["company", "ats_type", "slug", "status", "job_count", "lca_count", "flag", "notes"])
        writer.writeheader()
        writer.writerows(results)
    print(f"\nExported to {csv_path}")

    if high_priority:
        print("\nHIGH PRIORITY companies (lca_count >= 5, ATS not live):")
        for r in high_priority:
            print(f"  {r['company'][:50]:50} lca={r['lca_count']} flag={r['flag']}")

    # Upload to Google Sheet (non-blocking — skip if import fails)
    if not DRY_RUN:
        try:
            upload_to_sheet(results, today)
        except Exception as e:
            print(f"\nSheet upload failed (non-blocking): {e}")


def upload_to_sheet(results, today):
    """Upload QA results to Google Sheet tab 'ats_qa'. Non-blocking."""
    import gspread
    from google.oauth2.service_account import Credentials
    from config import GOOGLE_SA_KEY_FILE, GOOGLE_SHEET_ID

    creds = Credentials.from_service_account_file(
        GOOGLE_SA_KEY_FILE,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(GOOGLE_SHEET_ID)

    try:
        ws = sh.worksheet("ats_qa")
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title="ats_qa", rows=1000, cols=10)

    # Clear and rewrite
    ws.clear()
    header = ["Company", "ATS Type", "Slug", "Status", "Job Count", "LCA Count", "Flag", "Notes", "Updated"]
    rows = [header]
    for r in results:
        rows.append([
            r["company"], r["ats_type"], r["slug"], r["status"],
            r["job_count"], r["lca_count"], r["flag"], r["notes"], today,
        ])
    ws.update(rows)

    # Highlight HIGH_PRIORITY rows in red
    high_rows = [i + 2 for i, r in enumerate(results) if "HIGH_PRIORITY" in r.get("flag", "")]
    if high_rows:
        fmt = {"backgroundColor": {"red": 1, "green": 0.8, "blue": 0.8}}
        for row_num in high_rows:
            ws.format(f"A{row_num}:I{row_num}", fmt)

    print(f"Uploaded {len(results)} rows to Google Sheet tab 'ats_qa'")


if __name__ == "__main__":
    main()
