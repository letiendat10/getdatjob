#!/usr/bin/env python3
"""One-time re-parse of salary from descriptions already stored in the DB.

The upgraded parse_salary() (03_pull_jobs.py) recognizes more formats than the
extractor that ran when these rows were first pulled (unit suffixes between the
bounds, "up to $X", "$X+", K-without-$, etc.). This pass re-reads the stored
salary_range / description_text for active jobs that still have no numeric salary,
and fills salary_range + salary_min_num/max_num/period. No scraping.

Genuinely no-salary postings simply stay NULL.

Usage:
  python3 scrapers/backfill_salary.py            # all eligible active jobs
  python3 scrapers/backfill_salary.py --dry-run  # parse + report, no writes
  python3 scrapers/backfill_salary.py --limit 5000
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys

# Load parse_salary + the Supabase client from the puller (digit-prefixed filename).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location("pull_jobs", f"{_HERE}/03_pull_jobs.py")
pj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pj)

sb = pj.sb
parse_salary = pj.parse_salary

PAGE = 1000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="cap rows processed (0 = no cap)")
    args = ap.parse_args()

    stats = {"scanned": 0, "filled": 0}
    last_id = 0
    while True:
        # Keyset pagination by id — OFFSET pagination over a filtered scan times out.
        q = (
            sb.table("jobs")
            .select("id,salary_range,description_text")
            .eq("is_active", True)
            .is_("salary_min_num", "null")
            # Only rows with a description to parse (skips empty-description list-only
            # rows — those get salary at enrichment time). Matches idx_jobs_salary_backfill
            # so the keyset scan stays fast and never times out.
            .not_.is_("description_text", "null")
            .neq("description_text", "")
            .gt("id", last_id)
            .order("id")
            .limit(PAGE)
        )
        rows = q.execute().data
        if not rows:
            break
        last_id = rows[-1]["id"]
        for r in rows:
            stats["scanned"] += 1
            src = r.get("salary_range") or r.get("description_text") or ""
            sal = parse_salary(src)
            if not sal:
                continue
            patch = {
                "salary_min_num": sal["min_num"],
                "salary_max_num": sal["max_num"],
                "salary_period": sal["period"],
            }
            if not r.get("salary_range"):
                patch["salary_range"] = sal["display"]
            stats["filled"] += 1
            if not args.dry_run:
                sb.table("jobs").update(patch).eq("id", r["id"]).execute()
        print(f"  scanned {stats['scanned']}, filled {stats['filled']}…", flush=True)
        if len(rows) < PAGE or (args.limit and stats["scanned"] >= args.limit):
            break

    print(f"\nDone. scanned {stats['scanned']}, salary filled on {stats['filled']} "
          f"(dry_run={args.dry_run}).", flush=True)


if __name__ == "__main__":
    main()
