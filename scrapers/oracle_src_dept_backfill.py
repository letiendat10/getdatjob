#!/usr/bin/env python3
"""oracle_src_dept_backfill.py — one-off source_department backfill for oracle_hcm jobs.

Oracle's LIST API returns JobFamily/Department/Organization as null (only *Id numerics),
so every oracle job pulled before 2026-06-12 has source_department NULL. The DETAIL API
carries the readable Category/JobFunction; oracle_hcm.fetch_detail now returns it as a
third element and the 0606 inline enrich stores it for NEW jobs — but already-enriched
jobs are never revisited. This walks active oracle jobs missing source_department, calls
fetch_detail once each (~1-2s; _resolve caches the host per slug), and fills the column.
map_source_dept (nightly, or run manually after) folds the values + restamps department.

Resumable by construction (only NULL rows are selected). Env: MAX_JOBS (0 = all),
RUN_DEADLINE_MIN (default 150).
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import oracle_hcm
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

PAGE = 1000
MAX_JOBS = int(os.environ.get("MAX_JOBS", "0"))
RUN_DEADLINE_MIN = int(os.environ.get("RUN_DEADLINE_MIN", "150"))


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    ats = (sb.table("employer_ats").select("employer_id,slug")
           .eq("ats_type", "oracle_hcm").execute().data) or []
    slug_by_emp = {r["employer_id"]: r["slug"] for r in ats if r.get("slug")}

    jobs, start = [], 0
    while True:
        rows = (sb.table("jobs").select("id,employer_id,ats_job_id")
                .eq("ats_source", "oracle_hcm").eq("is_active", True)
                .is_("source_department", "null")
                .order("id").range(start, start + PAGE - 1).execute().data) or []
        jobs.extend(rows)
        if len(rows) < PAGE:
            break
        start += PAGE
    if MAX_JOBS:
        jobs = jobs[:MAX_JOBS]
    print(f"oracle_src_dept_backfill: {len(jobs)} active oracle jobs missing source_department",
          flush=True)

    deadline = time.monotonic() + RUN_DEADLINE_MIN * 60
    filled = misses = 0
    for i, j in enumerate(jobs, 1):
        if time.monotonic() > deadline:
            print(f"deadline reached at {i - 1}/{len(jobs)} — rerun to resume", flush=True)
            break
        slug = slug_by_emp.get(j["employer_id"])
        if not slug:
            continue
        try:
            _, _, src = oracle_hcm.fetch_detail(slug, j["ats_job_id"])
        except Exception:
            src = None
        if src:
            sb.table("jobs").update({"source_department": src}) \
              .eq("id", j["id"]).is_("source_department", "null").execute()
            filled += 1
        else:
            misses += 1
        if i % 200 == 0:
            print(f"  {i}/{len(jobs)} (+{filled} filled, {misses} no-signal)", flush=True)
        time.sleep(0.25)

    print(f"oracle_src_dept_backfill: done — {filled} filled, {misses} without a signal",
          flush=True)


if __name__ == "__main__":
    main()
