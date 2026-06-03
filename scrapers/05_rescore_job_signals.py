#!/usr/bin/env python3
"""
05_rescore_job_signals.py
Re-scores all existing job_signals using the current 36-month LCA title index.

Run this after loading additional historical LCA quarters so jobs that previously
sat at 'friendly' can flip to 'verified' when older title filings now match.

Usage:
    python3 scrapers/05_rescore_job_signals.py
    python3 scrapers/05_rescore_job_signals.py --employer-ids 101 202 303
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

import importlib.util

sys.path.insert(0, os.path.dirname(__file__))

from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY
from title_utils import build_lca_index

# 03_pull_jobs.py starts with a digit so we use importlib
def _load_pull_jobs():
    spec = importlib.util.spec_from_file_location(
        "pull_jobs",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "03_pull_jobs.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

_pj = _load_pull_jobs()
score_job = _pj.score_job

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def rescore_employer(emp_id: int) -> dict:
    """Re-score all jobs for one employer. Returns per-tier counts (before & after)."""
    lca_titles, lca_counts = build_lca_index(sb, emp_id)

    jobs_res = (
        sb.table("jobs")
        .select("id,title,description_text")
        .eq("employer_id", emp_id)
        .execute()
    )
    if not jobs_res.data:
        return {"jobs": 0}

    before: Counter = Counter()
    after: Counter = Counter()
    signal_rows = []

    # Fetch current tiers for before/after comparison
    job_ids = [r["id"] for r in jobs_res.data]
    existing_signals: dict[int, str] = {}
    for i in range(0, len(job_ids), 1000):
        chunk = job_ids[i:i + 1000]
        sig_res = (
            sb.table("job_signals")
            .select("job_id,confidence_tier")
            .in_("job_id", chunk)
            .execute()
        )
        for s in sig_res.data:
            existing_signals[s["job_id"]] = s["confidence_tier"]

    for rec in jobs_res.data:
        current_tier = existing_signals.get(rec["id"], "no_signal")
        before[current_tier] += 1
        # verified/excluded can't improve further — skip
        if current_tier in ("verified", "excluded"):
            after[current_tier] += 1
            continue
        tier, flag, tc, lca_count = score_job(
            rec["title"], rec["description_text"] or "", lca_titles, lca_counts
        )
        after[tier] += 1
        signal_rows.append({
            "job_id": rec["id"],
            "confidence_tier": tier,
            "no_sponsor_in_desc_flag": flag,
            "title_clean": tc,
            "title_employer_lca_count": lca_count,
        })

    for i in range(0, len(signal_rows), 500):
        sb.table("job_signals").upsert(signal_rows[i:i + 500], on_conflict="job_id").execute()

    return {"jobs": len(signal_rows), "before": dict(before), "after": dict(after)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--employer-ids", nargs="+", type=int,
        help="Only rescore these employer IDs (default: all employers with jobs)",
    )
    args = parser.parse_args()

    if args.employer_ids:
        emp_ids = args.employer_ids
        print(f"Rescoring {len(emp_ids)} specified employer(s) …")
    else:
        # Distinct employer_ids via DB; keyset pagination to avoid PostgREST's 1000-row cap.
        emp_ids_set: set[int] = set()
        last_id = 0
        while True:
            batch = (
                sb.table("jobs")
                .select("employer_id")
                .gt("employer_id", last_id)
                .order("employer_id")
                .limit(1000)
                .execute()
            )
            if not batch.data:
                break
            for r in batch.data:
                if r["employer_id"]:
                    emp_ids_set.add(r["employer_id"])
            if len(batch.data) < 1000:
                break
            last_id = batch.data[-1]["employer_id"]
        emp_ids = sorted(emp_ids_set)
        print(f"Rescoring {len(emp_ids)} employer(s) with jobs …")

    totals_before: Counter = Counter()
    totals_after: Counter = Counter()
    total_jobs = 0

    for i, emp_id in enumerate(emp_ids, 1):
        result = rescore_employer(emp_id)
        if result["jobs"] == 0:
            continue
        total_jobs += result["jobs"]
        for tier, n in result.get("before", {}).items():
            totals_before[tier] += n
        for tier, n in result.get("after", {}).items():
            totals_after[tier] += n
        if i % 50 == 0 or i == len(emp_ids):
            print(f"  {i}/{len(emp_ids)} employers processed ({total_jobs} jobs so far) …", flush=True)

    print(f"\n{'='*50}")
    print(f"Rescore complete — {total_jobs} jobs across {len(emp_ids)} employers")
    print(f"\n{'Tier':<12} {'Before':>8} {'After':>8} {'Delta':>8}")
    print("-" * 42)
    all_tiers = sorted(set(totals_before) | set(totals_after))
    for tier in all_tiers:
        b = totals_before.get(tier, 0)
        a = totals_after.get(tier, 0)
        delta = a - b
        sign = "+" if delta > 0 else ""
        print(f"{tier:<12} {b:>8,} {a:>8,} {sign}{delta:>7,}")
    print(f"\nVerified jobs: {totals_before.get('verified', 0):,} → {totals_after.get('verified', 0):,}")


if __name__ == "__main__":
    main()
