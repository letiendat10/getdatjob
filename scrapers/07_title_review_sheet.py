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
from classify import classify_department, classify_level

# data/classification_overrides.json — consumed by classify.py (dept/level overrides).
_OVERRIDES_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data", "classification_overrides.json")

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

    def row(title: str, count: int, section: str) -> dict:
        return {
            "original_title": title,
            "auto_clean": clean_map.get(title, clean_title(title)),
            "auto_department": classify_department(title) or "",
            "auto_level": classify_level(title) or "",
            "filing_count": count,
            "section": section,
        }

    result = [row(t, c, "top500") for t, c in top500]
    result += [row(t, c, "random50") for t, c in random_50]
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

    # One review pass covers title-cleaning AND department/level classification.
    # Leave any override_* cell blank to accept the auto_* value; fill it to correct.
    header = ["original_title", "auto_clean", "override_clean",
              "auto_department", "override_department",
              "auto_level", "override_level",
              "filing_count", "_section"]
    ws.update("A1", [header])
    rows_out = [
        [d["original_title"], d["auto_clean"], "",
         d["auto_department"], "",
         d["auto_level"], "",
         d["filing_count"], d["section"]]
        for d in data
    ]
    ws.update("A2", rows_out)

    # Freeze header, highlight override column
    ws.freeze(rows=1)
    print(f"Sheet written: {len(rows_out)} rows")
    print(f"URL: {sh.url}")


# ── Apply ─────────────────────────────────────────────────────────────────────

def apply_classification_overrides(records: list[dict]) -> None:
    """Persist override_department / override_level into data/classification_overrides.json
    (keyed by lowercased title, the same key classify.py looks up) and re-apply to jobs.

    A non-empty override cell sets the value; the literal "none" clears it to NULL.
    """
    try:
        with open(_OVERRIDES_PATH, encoding="utf-8") as f:
            store: dict[str, dict[str, str]] = json.load(f)
    except (FileNotFoundError, ValueError):
        store = {}

    def norm(v: str) -> str | None:
        v = (v or "").strip()
        if not v:
            return None            # blank cell → no override for this field
        return "" if v.lower() == "none" else v   # "none" → explicit clear

    changed = 0
    for r in records:
        title = (r.get("original_title") or "").strip()
        if not title:
            continue
        dept = norm(r.get("override_department", ""))
        lvl = norm(r.get("override_level", ""))
        if dept is None and lvl is None:
            continue
        key = title.lower()
        row = store.get(key, {})
        if dept is not None:
            row["department"] = dept
        if lvl is not None:
            row["job_level"] = lvl
        store[key] = row
        # Re-apply to existing jobs with this exact title.
        patch = {}
        if dept is not None:
            patch["department"] = dept or None
        if lvl is not None:
            patch["job_level"] = lvl or None
        sb.table("jobs").update(patch).ilike("title", title).execute()
        changed += 1

    if changed:
        os.makedirs(os.path.dirname(_OVERRIDES_PATH), exist_ok=True)
        with open(_OVERRIDES_PATH, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=2, ensure_ascii=False, sort_keys=True)
        print(f"{changed} department/level overrides written to {_OVERRIDES_PATH}")
    else:
        print("No department/level overrides found in sheet.")


def apply_overrides():
    if not SHEET_ID:
        raise RuntimeError("TITLE_REVIEW_SHEET_ID not set — run --generate first")
    gc = get_gc()
    sh = gc.open_by_key(SHEET_ID)
    ws = sh.sheet1
    records = ws.get_all_records()

    # Classification (department/level) overrides — written for classify.py to consume.
    apply_classification_overrides(records)

    overrides = {
        r["original_title"]: r["override_clean"].strip()
        for r in records
        if r.get("override_clean", "").strip()
    }
    if not overrides:
        print("No title_clean overrides found in sheet.")
        return

    print(f"{len(overrides)} title_clean overrides to apply …")
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
