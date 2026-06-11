#!/usr/bin/env python3
"""Routine card-health QA — alert on coverage regressions + integrity breaches.

Calls refresh_card_health() (snapshots today's metrics over the last-7-day window —
the jobs users actually browse — into card_health_snapshot), then compares against the
trailing history and FAILS (exit 1) on:
  * any integrity invariant > 0 (rogue enum values, non-US leak, salary-without-number)
  * Workday description coverage DROPPING vs the prior snapshot (enrichment regressed)
and WARNS on overall description coverage below a floor.

Writes a CSV to data/ and prints a summary. Safe to schedule daily (mirrors 09_qa_ats.py).

Usage:
  python3 scrapers/10_qa_card_health.py [--window 7] [--floor-desc 12]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date

from config import SUPABASE_URL, SUPABASE_KEY
from supabase import create_client

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Portable output dir (repo_root/data) — works locally AND on the CI runner, unlike
# config.DATA_DIR which is an absolute macOS path that doesn't exist on Linux.
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

# Integrity invariants — any non-zero value is a hard failure (the card is lying).
INVARIANTS = ["bad_level", "bad_dept", "bad_salary_period", "bad_tier",
              "non_us_leak", "salary_shown_no_num"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=7, help="effective_posted_at window (days)")
    ap.add_argument("--floor-desc", type=float, default=12.0, help="min acceptable desc %%")
    ap.add_argument("--floor-posted", type=float, default=90.0,
                    help="min acceptable per-ATS real posted_at %%")
    args = ap.parse_args()

    # Snapshot today (upserts card_health_snapshot) and get the metrics back.
    res = sb.rpc("refresh_card_health", {"p_window_days": args.window}).execute().data
    m = res if isinstance(res, dict) else json.loads(res)

    # Most recent snapshot before today, for regression checks.
    rows = (
        sb.table("card_health_snapshot")
        .select("captured_on,metrics")
        .order("captured_on", desc=True)
        .limit(8)
        .execute()
        .data
    )
    prior = next((r["metrics"] for r in rows
                  if str(r["captured_on"]) != date.today().isoformat()), None)

    failures: list[str] = []
    warnings: list[str] = []

    # 1. Integrity invariants must be 0.
    for k in INVARIANTS:
        v = m.get(k) or 0
        if v:
            failures.append(f"{k} = {v} (must be 0)")

    # 2. Workday description coverage must not regress (enrichment health canary).
    wd_now = (m.get("by_ats", {}).get("workday") or {}).get("desc_pct")
    if prior is not None and wd_now is not None:
        wd_prev = (prior.get("by_ats", {}).get("workday") or {}).get("desc_pct")
        if wd_prev is not None and wd_now + 0.05 < wd_prev:
            failures.append(f"workday desc% regressed: {wd_prev} -> {wd_now}")

    # 3. Overall description coverage floor (warn only — climbs as enrichment runs).
    if (m.get("desc_pct") or 0) < args.floor_desc:
        warnings.append(f"desc% {m.get('desc_pct')} below floor {args.floor_desc}")

    # 4. Per-ATS real posted_at coverage. A silent date-parse regression hides behind the
    # scraped_at display fallback (cards show first-seen and look fine) — amazon ran at 0%
    # for days this way. Gate every ATS with meaningful in-window volume.
    posted_exempt = {"bamboohr"}  # no date field at the source at all
    for ats, s in sorted((m.get("by_ats") or {}).items()):
        n, posted = s.get("n") or 0, s.get("posted_pct")
        if ats in posted_exempt or n < 25 or posted is None:
            continue
        if posted < args.floor_posted:
            failures.append(
                f"{ats} real posted_at coverage {posted}% < {args.floor_posted}% (n={n})")

    # ── summary ──
    print(f"\nCard health — {date.today().isoformat()} "
          f"(window {args.window}d, {m.get('total')} jobs)")
    print(f"  coverage:  desc {m.get('desc_pct')}%  salary {m.get('salary_range_pct')}%  "
          f"posted {m.get('real_posted_pct')}%  dept {m.get('dept_pct')}%  "
          f"level {m.get('level_pct')}%  remote {m.get('remote_pct')}%")
    print(f"  tier:      verified {m.get('tier_verified')}  friendly {m.get('tier_friendly')}  "
          f"excluded {m.get('tier_excluded')}  null {m.get('tier_null')}")
    print("  integrity: " + "  ".join(f"{k}={m.get(k)}" for k in INVARIANTS))
    wd = m.get("by_ats", {}).get("workday") or {}
    print(f"  workday:   n={wd.get('n')}  desc={wd.get('desc_pct')}%  (enrichment canary)")
    posted_line = "  ".join(
        f"{a}={s.get('posted_pct')}%" for a, s in sorted((m.get("by_ats") or {}).items())
        if (s.get("n") or 0) >= 25)
    print(f"  posted by ats: {posted_line}")

    # ── CSV (best-effort; the DB snapshot + exit code are the real outputs) ──
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        csv_path = os.path.join(OUT_DIR, f"card_health_{date.today().isoformat()}.csv")
        flat = {k: v for k, v in m.items() if not isinstance(v, (dict, list))}
        with open(csv_path, "w", newline="") as f:
            wr = csv.writer(f)
            wr.writerow(["metric", "value"])
            for k, v in flat.items():
                wr.writerow([k, v])
        print(f"  csv -> {csv_path}")
    except OSError as e:
        print(f"  (csv write skipped: {e})")

    if warnings:
        print("\nWARN:")
        for x in warnings:
            print(f"  - {x}")
    if failures:
        print("\nFAIL:")
        for x in failures:
            print(f"  - {x}")
        sys.exit(1)
    print("\nOK — no integrity breaches or regressions.")


if __name__ == "__main__":
    main()
