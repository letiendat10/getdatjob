"""
05_verify_slugs.py
Verifies all ATS slugs in employer_ats against live APIs.
Writes a status table to Google Sheets for manual review.

SETUP (one-time):
  1. pip install gspread google-auth-oauthlib
  2. Go to https://console.cloud.google.com → new project → enable Google Sheets API
  3. Credentials → Create Credentials → OAuth 2.0 Client ID → Desktop app
  4. Download JSON → save as scrapers/credentials.json
  5. First run opens a browser for auth; token is cached automatically after that.

OUTPUT columns in sheet:
  company | ats_type | slug | status | job_count | lca_count | notes
"""

import sys
import time
import requests
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 10

SHEET_ID = "1mSp6xPlyG-xRnryofRQ6_xZmXRT_FLfMZrUaKSjwBX8"
TAB_NAME = "slug_verification"


# ── ATS check helpers ─────────────────────────────────────────────────────────

def check_greenhouse(slug: str) -> int:
    """Returns job count or -1 on failure."""
    try:
        r = requests.get(
            f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
            headers=HEADERS, timeout=TIMEOUT,
        )
        if r.status_code == 200:
            return len(r.json().get("jobs", []))
        return -1
    except Exception:
        return -1


def check_lever(slug: str) -> int:
    try:
        r = requests.get(
            f"https://api.lever.co/v0/postings/{slug}?mode=json",
            headers=HEADERS, timeout=TIMEOUT,
        )
        if r.status_code == 200:
            data = r.json()
            return len(data) if isinstance(data, list) else -1
        return -1
    except Exception:
        return -1


def check_ashby(slug: str) -> int:
    try:
        r = requests.get(
            f"https://jobs.ashby.com/api/posting-api/job-board?organizationHostedJobsPageName={slug}",
            headers=HEADERS, timeout=TIMEOUT,
        )
        if r.status_code == 200:
            return len(r.json().get("jobPostings", []))
        return -1
    except Exception:
        return -1


CHECKERS = {
    "greenhouse": check_greenhouse,
    "lever": check_lever,
    "ashby": check_ashby,
}


# ── Main verification ─────────────────────────────────────────────────────────

def verify_all() -> list[dict]:
    rows = (
        sb.table("employer_ats")
        .select("employer_id, ats_type, slug, employers(name, lca_count)")
        .execute()
        .data
    )

    results = []
    for row in rows:
        emp = row.get("employers") or {}
        company = emp.get("name", "unknown")
        lca_count = emp.get("lca_count", 0)
        ats = row["ats_type"]
        slug = row["slug"]

        checker = CHECKERS.get(ats)
        if not checker:
            job_count = -1
        else:
            job_count = checker(slug)

        status = "LIVE" if job_count >= 0 else "DEAD"
        print(f"  {'✓' if status == 'LIVE' else '✗'} {company:35s} {ats:12s} {slug:30s} {job_count:>5} jobs")

        results.append({
            "company": company,
            "ats_type": ats,
            "slug": slug,
            "status": status,
            "job_count": job_count if job_count >= 0 else "",
            "lca_count": lca_count,
            "notes": "",
        })

        time.sleep(0.5)

    return sorted(results, key=lambda r: (-r["lca_count"], r["company"]))


def write_to_sheet(results: list[dict]) -> None:
    try:
        import gspread
    except ImportError:
        print("\ngspread not installed — run: pip install gspread google-auth-oauthlib")
        print("Falling back to CSV output.\n")
        write_csv(results)
        return

    try:
        gc = gspread.oauth(
            credentials_filename="credentials.json",
            authorized_user_filename="token.json",
        )
    except FileNotFoundError:
        print("\ncredentials.json not found in the current directory.")
        print("See setup instructions at the top of this file.")
        print("Falling back to CSV output.\n")
        write_csv(results)
        return

    sh = gc.open_by_key(SHEET_ID)

    try:
        ws = sh.worksheet(TAB_NAME)
        ws.clear()
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=TAB_NAME, rows=100, cols=10)

    header = ["company", "ats_type", "slug", "status", "job_count", "lca_count", "notes"]
    rows = [header] + [[r[c] for c in header] for r in results]
    ws.update(rows, value_input_option="USER_ENTERED")

    # Color LIVE rows green, DEAD rows red
    from gspread.utils import rowcol_to_a1
    for i, r in enumerate(results, start=2):
        color = {"red": 0.85, "green": 0.94, "blue": 0.85} if r["status"] == "LIVE" else {"red": 0.96, "green": 0.85, "blue": 0.85}
        ws.format(f"A{i}:G{i}", {"backgroundColor": color})

    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={ws.id}"
    print(f"\nSheet updated: {url}")


def write_csv(results: list[dict]) -> None:
    import csv, os
    path = os.path.join(os.path.dirname(__file__), "../data/slug_verification.csv")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["company", "ats_type", "slug", "status", "job_count", "lca_count", "notes"])
        w.writeheader()
        w.writerows(results)
    print(f"CSV saved to {path}")


if __name__ == "__main__":
    print("Verifying ATS slugs …\n")
    results = verify_all()

    live = sum(1 for r in results if r["status"] == "LIVE")
    print(f"\n{live}/{len(results)} slugs live\n")

    write_to_sheet(results)
