"""
07_title_review_sheet.py

Two modes:

  python 07_title_review_sheet.py --generate
      Populates lca_filings.title_clean with auto-generated clean titles,
      then writes (or refreshes) the review Google Sheet:
        top 500 most-filed job titles  +  50 random titles from the long tail
      Columns: original_title | auto_clean | override_clean | filing_count

  python 07_title_review_sheet.py --apply
      Reads the sheet. Any row where override_clean is non-empty is treated as
      a manual correction: updates lca_filings.title_clean to that value,
      then recomputes job_signals.title_clean / title_employer_lca_count.

Auth: set GOOGLE_SERVICE_ACCOUNT_JSON env var to the path of a service-account
      JSON with Sheets + Drive editor access, OR share the sheet with the
      service account email.
      Set TITLE_REVIEW_SHEET_ID in config.py (or env var) after first --generate.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
from collections import Counter

import gspread
from google.oauth2.service_account import Credentials
from supabase import create_client

from config import SUPABASE_URL, SUPABASE_KEY
from title_utils import clean_title

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
SHEET_TITLE = "getdatjob — Title Clean Review"
# After first run, paste the sheet ID into config.py as TITLE_REVIEW_SHEET_ID
SHEET_ID = os.environ.get("TITLE_REVIEW_SHEET_ID") or getattr(
    __import__("config"), "TITLE_REVIEW_SHEET_ID", None
)


def get_gc() -> gspread.Client:
    sa_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not sa_path:
        raise RuntimeError("Set GOOGLE_SERVICE_ACCOUNT_JSON env var to service-account JSON path")
    creds = Credentials.from_service_account_file(sa_path, scopes=SCOPES)
    return gspread.authorize(creds)


# ── Generate ──────────────────────────────────────────────────────────────────

def populate_lca_title_clean():
    """Backfill job_title_clean on all lca_filings rows that don't have it yet."""
    print("Fetching LCA filings missing job_title_clean …")
    rows = (
        sb.table("lca_filings")
        .select("id,job_title")
        .is_("job_title_clean", "null")
        .execute()
        .data
    )
    print(f"  {len(rows):,} rows to update")
    updates = [{"id": r["id"], "job_title_clean": clean_title(r["job_title"] or "")} for r in rows]
    for i in range(0, len(updates), 500):
        batch = updates[i : i + 500]
        sb.table("lca_filings").upsert(batch).execute()
        print(f"  updated {min(i + 500, len(updates)):,}/{len(updates):,}")


def build_review_data() -> list[dict]:
    """Return top 500 + random 50 titles with their auto_clean and filing_count."""
    print("Querying distinct LCA job titles …")
    rows = (
        sb.table("lca_filings")
        .select("job_title,job_title_clean")
        .execute()
        .data
    )
    counts: Counter = Counter(r["job_title"] for r in rows if r["job_title"])
    clean_map: dict[str, str] = {r["job_title"]: r["job_title_clean"] for r in rows if r["job_title"]}

    ranked = counts.most_common()
    top500 = ranked[:500]
    tail = ranked[500:]
    random_50 = random.sample(tail, min(50, len(tail)))

    result = []
    for title, count in top500:
        result.append({"original_title": title, "auto_clean": clean_map.get(title, clean_title(title)),
                        "filing_count": count, "section": "top500"})
    for title, count in random_50:
        result.append({"original_title": title, "auto_clean": clean_map.get(title, clean_title(title)),
                        "filing_count": count, "section": "random50"})
    return result


def generate():
    populate_lca_title_clean()
    data = build_review_data()

    gc = get_gc()
    if SHEET_ID:
        sh = gc.open_by_key(SHEET_ID)
        ws = sh.sheet1
        ws.clear()
        print(f"Refreshing existing sheet: {sh.url}")
    else:
        sh = gc.create(SHEET_TITLE)
        sh.share("", perm_type="anyone", role="writer")  # make it link-shareable
        ws = sh.sheet1
        print(f"Created sheet: {sh.url}")
        print(f"\n  *** Add this to config.py:  TITLE_REVIEW_SHEET_ID = \"{sh.id}\" ***\n")

    header = ["original_title", "auto_clean", "override_clean", "filing_count", "_section"]
    ws.update("A1", [header])
    rows_out = [
        [d["original_title"], d["auto_clean"], "", d["filing_count"], d["section"]]
        for d in data
    ]
    ws.update("A2", rows_out)

    # Freeze header, highlight override column
    ws.freeze(rows=1)
    print(f"Sheet written: {len(rows_out)} rows")
    print(f"URL: {sh.url}")


# ── Apply ─────────────────────────────────────────────────────────────────────

def apply_overrides():
    if not SHEET_ID:
        raise RuntimeError("TITLE_REVIEW_SHEET_ID not set — run --generate first")
    gc = get_gc()
    sh = gc.open_by_key(SHEET_ID)
    ws = sh.sheet1
    records = ws.get_all_records()

    overrides = {
        r["original_title"]: r["override_clean"].strip()
        for r in records
        if r.get("override_clean", "").strip()
    }
    if not overrides:
        print("No overrides found in sheet.")
        return

    print(f"{len(overrides)} overrides to apply …")
    for original, corrected in overrides.items():
        sb.table("lca_filings").update({"job_title_clean": corrected}).eq("job_title", original).execute()

    # Recompute job_signals for affected jobs
    # (re-run score_job logic inline: update job_title_clean, then recount)
    print("Recomputing job_signals.title_clean for affected jobs …")
    affected_clean_titles = set(overrides.values())

    # Update job_signals where title_clean matches an overridden value
    for tc in affected_clean_titles:
        rows = (
            sb.table("job_signals")
            .select("id,job_id,title_clean")
            .execute()
            .data
        )
        # Recompute title_employer_lca_count for each affected signal
        lca_rows = (
            sb.table("lca_filings")
            .select("employer_id,job_title_clean")
            .eq("job_title_clean", tc)
            .execute()
            .data
        )
        employer_counts: dict[int, int] = Counter(r["employer_id"] for r in lca_rows)

        # Fetch job→employer mapping
        job_ids = [r["job_id"] for r in rows if r["title_clean"] == tc]
        if not job_ids:
            continue
        jobs = (
            sb.table("jobs")
            .select("id,employer_id")
            .in_("id", job_ids)
            .execute()
            .data
        )
        emp_map = {j["id"]: j["employer_id"] for j in jobs}
        updates = [
            {"id": r["id"], "title_employer_lca_count": employer_counts.get(emp_map.get(r["job_id"], 0), 0)}
            for r in rows
            if r["title_clean"] == tc
        ]
        if updates:
            sb.table("job_signals").upsert(updates).execute()

    print("Done.")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if "--apply" in sys.argv:
        apply_overrides()
    elif "--generate" in sys.argv:
        generate()
    else:
        print("Usage: python 07_title_review_sheet.py [--generate | --apply]")
