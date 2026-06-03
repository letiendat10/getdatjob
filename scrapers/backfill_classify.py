#!/usr/bin/env python3
"""One-time backfill of jobs.department / jobs.job_level from the job title.

department + job_level are pure functions of the title (see classify.py), so this
needs no scraping — it pages every active job, classifies it, and batch-updates.
is_remote is already seeded by the 20260603 migration (and kept fresh by the daily
scraper), so it is not touched here.

Grouping by the (department, job_level) result keeps writes cheap: one UPDATE per
distinct result bucket, chunked by id.

Usage:
  python3 scrapers/backfill_classify.py            # all active jobs
  python3 scrapers/backfill_classify.py --dry-run  # classify + report, no writes
"""
from __future__ import annotations

import argparse
from collections import defaultdict

from config import SUPABASE_URL, SUPABASE_KEY
from supabase import create_client

from classify import classify_department, classify_level

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

PAGE = 1000      # read page size
ID_CHUNK = 300   # ids per UPDATE (keeps the request URL well under limits)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="classify + report, no writes")
    args = ap.parse_args()

    # bucket: (department|None, job_level|None) -> [job_id, ...]
    buckets: dict[tuple[str | None, str | None], list[int]] = defaultdict(list)
    total = 0
    start = 0
    while True:
        rows = (
            sb.table("jobs")
            .select("id,title")
            .eq("is_active", True)
            .order("id")
            .range(start, start + PAGE - 1)
            .execute()
            .data
        )
        if not rows:
            break
        for r in rows:
            dept = classify_department(r["title"])
            lvl = classify_level(r["title"])
            buckets[(dept, lvl)].append(r["id"])
        total += len(rows)
        print(f"  read {total} jobs…", flush=True)
        if len(rows) < PAGE:
            break
        start += PAGE

    # Report
    print(f"\nClassified {total} active jobs into {len(buckets)} buckets:")
    dept_tot: dict[str | None, int] = defaultdict(int)
    lvl_tot: dict[str | None, int] = defaultdict(int)
    for (dept, lvl), ids in buckets.items():
        dept_tot[dept] += len(ids)
        lvl_tot[lvl] += len(ids)
    print("  by department:", dict(sorted(dept_tot.items(), key=lambda x: -x[1])))
    print("  by level:     ", dict(sorted(lvl_tot.items(), key=lambda x: -x[1])))

    if args.dry_run:
        print("\nDry run — no writes.")
        return

    updated = 0
    for (dept, lvl), ids in buckets.items():
        if dept is None and lvl is None:
            continue  # columns already NULL — nothing to write
        payload = {"department": dept, "job_level": lvl}
        for i in range(0, len(ids), ID_CHUNK):
            chunk = ids[i:i + ID_CHUNK]
            sb.table("jobs").update(payload).in_("id", chunk).execute()
            updated += len(chunk)
        print(f"  updated {updated} rows…", flush=True)

    print(f"\nDone. {updated} rows updated.")


if __name__ == "__main__":
    main()
