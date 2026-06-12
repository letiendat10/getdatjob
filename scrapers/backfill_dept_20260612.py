#!/usr/bin/env python3
"""backfill_dept_20260612.py — one-off cleanup after the department keyword/guard fix.

The 2026-06-12 fix changed the classification rules (boundary-safe "llm", no bare
"design", compound-bucket guard in map_source_dept._rule). Three populations were
built with the OLD rules and won't self-heal:

  A. dept_mapping rows with mapped_by='rule' — frozen at creation; run_batch only maps
     NEW values. Re-evaluate each under the fixed _rule:
       * new bucket  -> upsert (stays mapped_by='rule')
       * now None    -> delete the row + NULL the active jobs it stamped, so the value
                        re-queues for the LLM/human pass (run map_source_dept after).
  B. title-only jobs stamped "AI / ML" via "fulfi-llm-ent" (restamp can't reach rows
     with no source_department).
  C. title-only jobs stamped "Design" via the bare "design" keyword (chip/civil eng).

Dry-run by default; pass --apply to write. Finishes with the restamp loop + count
refresh so mapping changes land on jobs immediately.
"""
from __future__ import annotations

import argparse
import sys

import classify
import map_source_dept as msd
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

PAGE = 1000
UPDATE_CHUNK = 200


def fetch_all(query_fn):
    """Page past the 1k PostgREST cap. query_fn(start, end) -> request builder."""
    out, start = [], 0
    while True:
        rows = query_fn(start, start + PAGE - 1).execute().data or []
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        start += PAGE


def part_a_rule_rows(sb, apply: bool):
    rows = fetch_all(lambda s, e: sb.table("dept_mapping").select("*")
                     .eq("mapped_by", "rule").order("source_norm").range(s, e))
    changes, drops = [], []
    for r in rows:
        new = msd._rule(r["sample_raw"])
        if new == r["unified_department"]:
            continue
        (drops if new is None else changes).append((r, new))

    print(f"A. rule rows: {len(rows)} total, {len(changes)} re-bucketed, {len(drops)} now ambiguous (drop->LLM)")
    for r, new in changes:
        print(f"   CHANGE {r['source_norm']!r}: {r['unified_department']} -> {new}  (n_jobs={r['n_jobs']})")
    for r, _ in drops:
        print(f"   DROP   {r['source_norm']!r}: was {r['unified_department']}  (n_jobs={r['n_jobs']})")
    if not apply:
        return

    for r, new in changes:
        sb.table("dept_mapping").update({"unified_department": new}).eq("source_norm", r["source_norm"]).execute()

    if drops:
        # The mapping stamped these jobs with a bucket the fixed rule no longer stands
        # behind. NULL the active ones (honest "unknown" until the LLM pass re-maps) and
        # delete the row so unmapped_source_depts() re-queues the value.
        variants = fetch_all(lambda s, e: sb.table("jobs").select("source_department")
                             .eq("is_active", True).not_.is_("source_department", "null")
                             .range(s, e))
        by_norm: dict[str, set] = {}
        for v in variants:
            n = msd.norm(v["source_department"])
            if n:
                by_norm.setdefault(n, set()).add(v["source_department"])
        for r, _ in drops:
            for raw in sorted(by_norm.get(r["source_norm"], ())):
                sb.table("jobs").update({"department": None}) \
                  .eq("is_active", True).eq("source_department", raw).execute()
            sb.table("dept_mapping").delete().eq("source_norm", r["source_norm"]).execute()


def re_classify_slice(sb, label: str, dept: str, title_ilike: str | None, apply: bool):
    """Re-run the FIXED classifier over title-only rows currently stamped `dept`."""
    def q(s, e):
        b = (sb.table("jobs").select("id,title")
             .eq("is_active", True).eq("department", dept).is_("source_department", "null"))
        if title_ilike:
            b = b.ilike("title", title_ilike)
        return b.order("id").range(s, e)

    rows = fetch_all(q)
    moves: dict[str | None, list] = {}
    for r in rows:
        new = classify.classify_department(r["title"], None)
        if new != dept:
            moves.setdefault(new, []).append(r)

    print(f"{label}: {len(rows)} rows in slice, {sum(len(v) for v in moves.values())} re-bucketed")
    for new, rs in sorted(moves.items(), key=lambda kv: -len(kv[1])):
        sample = ", ".join(sorted({x["title"].strip() for x in rs})[:4])
        print(f"   -> {new}: {len(rs)}  (e.g. {sample})")
    if not apply:
        return

    for new, rs in moves.items():
        ids = [x["id"] for x in rs]
        for i in range(0, len(ids), UPDATE_CHUNK):
            sb.table("jobs").update({"department": new}).in_("id", ids[i:i + UPDATE_CHUNK]).execute()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    args = ap.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    part_a_rule_rows(sb, args.apply)
    re_classify_slice(sb, "B. AI/ML fulfillment (title-only)", "AI / ML", "%fulfillment%", args.apply)
    re_classify_slice(sb, "C. Design (title-only)", "Design", None, args.apply)

    if not args.apply:
        print("dry-run only — re-run with --apply to write")
        return
    total = 0
    while True:
        n = sb.rpc("restamp_department", {"p_batch": 5000}).execute().data or 0
        total += n
        if not n:
            break
    sb.rpc("refresh_dept_mapping_counts").execute()
    print(f"re-stamped {total} jobs from the updated mapping", flush=True)


if __name__ == "__main__":
    main()
