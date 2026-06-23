#!/usr/bin/env python3
"""
merge_fein_dupes.py — one-time, idempotent/resumable merge of duplicate employer
rows that share a FEIN.

WHY
===
00_quarterly_intake.py upserts employers on_conflict="name_clean", so two spellings
of one company ("Shopify (USA) Inc." vs "Shopify USA Inc.", FEIN 47-1039071) become
two rows. recompute_lca_counts() counts filings per employer_id, so each row only
gets a slice of the company's LCAs — fragmenting lca_count, which the job pipeline
uses to decide who to scan/pull. This script repoints the fragmented rows' children
onto one canonical row per company and deletes the extras, so the next
recompute_lca_counts() makes the counts whole.

SAFETY — FEIN is NOT a clean proxy for "company"
================================================
Many FEINs are shared *umbrella* IDs (every SUNY campus + NY agencies under
14-6013200; CUNY colleges under 13-3893536), and some are placeholders
(12-3456789 = Acme | Amazon | Test). Merging by FEIN alone would fuse distinct
employers. So a group is merged ONLY when:
  - the FEIN is plausibly real (is_mergeable_fein), AND
  - the rows share an identical company_token_key (same significant words) — a
    CONSERVATIVE same-company test that keeps formatting/punctuation/legal-suffix
    variants together but treats a differing token (a campus, a place, a typo) as a
    distinct entity. Within a FEIN, rows are clustered by that key; only clusters of
    >=2 identical-key rows merge. Everything else is written to needs_review_*.csv
    and left untouched.

IDEMPOTENT / RESUMABLE
======================
Buckets are re-derived from live DB state each run; a merged cluster collapses to one
row and is skipped next time. Filing repointing re-queries by dup employer_id, so a
re-run only moves what is left. Deletes happen only after a per-dup child-count==0
assert. Re-running is always safe.

Everything goes through supabase-py (PostgREST) — there is no raw-SQL path. service_role
times out at ~20s/statement, so writes are chunked.

USAGE
=====
  python3 scrapers/merge_fein_dupes.py --dry-run            # preview, writes only snapshots/review CSV
  python3 scrapers/merge_fein_dupes.py --fein 47-1039071 --yes   # Shopify canary
  python3 scrapers/merge_fein_dupes.py --min-lca 30 --yes        # high-value groups first
  python3 scrapers/merge_fein_dupes.py --yes                     # full gated run
  python3 scrapers/merge_fein_dupes.py --verify                  # report buckets, no writes

Requires SUPABASE_KEY in the environment (service-role secret).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))

import httpx
from config import SUPABASE_URL, SUPABASE_KEY, DATA_DIR
from supabase import create_client
from title_utils import company_token_key, is_mergeable_fein, fein_digits

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# supabase-py reuses ONE HTTP/2 connection; the server terminates it after ~10k streams
# (httpx.RemoteProtocolError). Refresh the client periodically and retry a cluster on a
# dropped connection — process_unit is idempotent (re-queries by dup id), so retry is safe.
CLIENT_REFRESH = 120
CONN_ERRORS = (httpx.RemoteProtocolError, httpx.ConnectError, httpx.ReadError,
               httpx.WriteError, httpx.PoolTimeout, httpx.ReadTimeout, httpx.ConnectTimeout)


def reset_client():
    global sb
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# Columns we read for every employer (full enough to snapshot + freshest-merge).
EMP_COLS = ("id,name,fein,name_clean,lca_count,lca_count_2025,last_filing_date,"
            "company_domain_url,poc_first_name,poc_last_name,poc_job_title,poc_email,"
            "visa_types,employer_city,employer_state")
# Fields merged "freshest non-null wins" (visa_types + last_filing_date handled separately).
FRESH_FIELDS = ["company_domain_url", "poc_first_name", "poc_last_name",
                "poc_job_title", "poc_email", "employer_city", "employer_state"]
# Real FK tables whose employer_id must be repointed before a dup row can be deleted.
CHILD_TABLES = ["lca_filings", "jobs", "employer_ats"]

SNAP_DIR = os.path.join(DATA_DIR, "merge_fein_snapshots")


# ── DB helpers ────────────────────────────────────────────────────────────────

def fetch_all_employers(cols: str) -> list[dict]:
    """Every employers row via keyset pagination (past PostgREST's 1000-row cap)."""
    rows, last_id = [], 0
    while True:
        batch = (sb.table("employers").select(cols)
                 .gt("id", last_id).order("id").limit(1000).execute().data)
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        last_id = batch[-1]["id"]
    return rows


def child_count(table: str, employer_id: int) -> int:
    return (sb.table(table).select("employer_id", count="exact")
            .eq("employer_id", employer_id).limit(1).execute().count or 0)


# ── Canonical pick + freshest-field merge ──────────────────────────────────────

def canonical_pick(rows: list[dict]) -> dict:
    """Survivor of a same-company cluster: max lca_count, then newest last_filing_date,
    then lowest id. The id tiebreak makes the choice deterministic across re-runs."""
    ordered = sorted(rows, key=lambda r: r["id"])                                  # id asc
    ordered = sorted(ordered, key=lambda r: (r.get("last_filing_date") or ""),     # date desc
                     reverse=True)
    ordered = sorted(ordered, key=lambda r: (r.get("lca_count") or 0), reverse=True)  # lca desc (stable)
    return ordered[0]


def freshest_patch(canon: dict, rows: list[dict]) -> dict:
    """Patch for the canonical row: each POC/domain field = newest non-null value in the
    cluster; visa_types = union; last_filing_date = group max. Only changed fields."""
    newest_first = sorted(rows, key=lambda r: r["id"])
    newest_first = sorted(newest_first, key=lambda r: (r.get("last_filing_date") or ""),
                          reverse=True)
    patch: dict = {}
    for f in FRESH_FIELDS:
        for r in newest_first:
            v = r.get(f)
            if v not in (None, ""):
                if v != canon.get(f):
                    patch[f] = v
                break
    union = sorted({x for r in rows for x in (r.get("visa_types") or []) if x})
    if union and union != sorted(canon.get("visa_types") or []):
        patch["visa_types"] = union
    max_date = max((r.get("last_filing_date") or "") for r in rows)
    if max_date and max_date != (canon.get("last_filing_date") or ""):
        patch["last_filing_date"] = max_date
    return patch


# ── Bucket construction (the mergeability gate lives here) ──────────────────────

def build_buckets():
    """Return (merge_units, review_rows, stats).

    merge_units: list of dicts {fein, key, rows} — same-company clusters of >=2 rows
                 under a valid FEIN that are safe to auto-merge.
    review_rows: rows (for needs_review CSV) covering every dup-FEIN group that is NOT
                 fully auto-merged (invalid/placeholder FEIN, umbrella/distinct names,
                 typo variants, or partial clusters).
    """
    emps = fetch_all_employers(EMP_COLS)
    by_fein: dict[str, list[dict]] = defaultdict(list)
    for e in emps:
        d = fein_digits(e.get("fein"))
        if d:
            by_fein[d].append(e)

    merge_units, review_rows = [], []
    dup_feins = 0
    for d, rows in by_fein.items():
        if len(rows) < 2:
            continue
        dup_feins += 1
        mergeable_fein = is_mergeable_fein(d)
        clusters: dict[frozenset, list[dict]] = defaultdict(list)
        for r in rows:
            clusters[company_token_key(r.get("name_clean") or r.get("name"))].append(r)

        merged_ids = set()
        if mergeable_fein:
            for key, crows in clusters.items():
                if len(key) > 0 and len(crows) >= 2:
                    merge_units.append({"fein": d, "key": key, "rows": crows})
                    merged_ids.update(r["id"] for r in crows)

        # Anything not auto-merged in this dup FEIN → review (with context).
        if len(merged_ids) < len(rows):
            if not mergeable_fein:
                reason = "invalid_or_placeholder_fein"
            elif len(clusters) > 1:
                reason = "distinct_or_umbrella_names"
            else:
                reason = "single_row_cluster"
            for r in rows:
                review_rows.append({
                    "fein": d,
                    "employer_id": r["id"],
                    "name": r.get("name"),
                    "name_clean": r.get("name_clean"),
                    "lca_count": r.get("lca_count"),
                    "lca_count_2025": r.get("lca_count_2025"),
                    "token_key": " ".join(sorted(company_token_key(r.get("name_clean") or r.get("name")))),
                    "cluster_size": len(clusters[company_token_key(r.get("name_clean") or r.get("name"))]),
                    "will_auto_merge": r["id"] in merged_ids,
                    "reason": reason,
                })

    stats = {
        "employers": len(emps),
        "dup_feins": dup_feins,
        "merge_units": len(merge_units),
        "rows_to_delete": sum(len(u["rows"]) - 1 for u in merge_units),
        "review_feins": len({r["fein"] for r in review_rows}),
        "review_rows": len(review_rows),
    }
    return merge_units, review_rows, stats


# ── Snapshot writers ────────────────────────────────────────────────────────────

def _open_writers(ts: str):
    os.makedirs(SNAP_DIR, exist_ok=True)
    emp_path = os.path.join(SNAP_DIR, f"employers_before_{ts}.csv")
    mov_path = os.path.join(SNAP_DIR, f"filings_moved_{ts}.csv")
    emp_f = open(emp_path, "a", newline="")
    mov_f = open(mov_path, "a", newline="")
    emp_w = csv.writer(emp_f)
    mov_w = csv.writer(mov_f)
    if emp_f.tell() == 0:
        emp_w.writerow(["ts", "fein", "role", "id", "name", "name_clean",
                        "lca_count", "lca_count_2025", "last_filing_date", "row_json"])
    if mov_f.tell() == 0:
        mov_w.writerow(["filing_id", "old_employer_id", "canonical_id"])
    return (emp_f, emp_w, emp_path), (mov_f, mov_w, mov_path)


def write_review_csv(review_rows: list[dict], ts: str) -> str:
    os.makedirs(SNAP_DIR, exist_ok=True)
    path = os.path.join(SNAP_DIR, f"needs_review_{ts}.csv")
    cols = ["fein", "employer_id", "name", "name_clean", "lca_count", "lca_count_2025",
            "token_key", "cluster_size", "will_auto_merge", "reason"]
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in sorted(review_rows, key=lambda x: (x["reason"], x["fein"])):
            w.writerow(r)
    return path


# ── Per-unit execution ──────────────────────────────────────────────────────────

def process_unit(unit: dict, canon: dict, dups: list[dict], args, mov_w) -> dict:
    """Mutate one cluster. Returns counters. Assumes snapshot already written."""
    stat = {"filings": 0, "jobs": 0, "ats": 0, "deleted": 0, "skipped": 0}

    patch = freshest_patch(canon, unit["rows"])
    if patch:
        sb.table("employers").update(patch).eq("id", canon["id"]).execute()

    for d in dups:
        did, cid = d["id"], canon["id"]
        # repoint lca_filings (record moved ids), then jobs — re-query by dup id => resumable
        while True:
            ids = [r["id"] for r in sb.table("lca_filings").select("id")
                   .eq("employer_id", did).order("id").limit(args.chunk).execute().data]
            if not ids:
                break
            sb.table("lca_filings").update({"employer_id": cid}).in_("id", ids).execute()
            for fid in ids:
                mov_w.writerow([fid, did, cid])
            stat["filings"] += len(ids)
        while True:
            ids = [r["id"] for r in sb.table("jobs").select("id")
                   .eq("employer_id", did).order("id").limit(args.chunk).execute().data]
            if not ids:
                break
            sb.table("jobs").update({"employer_id": cid}).in_("id", ids).execute()
            stat["jobs"] += len(ids)
        # migrate employer_ats (dedup on conflict), then drop the dup's rows
        ats = (sb.table("employer_ats")
               .select("ats_type,slug,ats_company_name,name_match_score,needs_review")
               .eq("employer_id", did).execute().data)
        for a in ats:
            sb.table("employer_ats").upsert({"employer_id": cid, **a},
                                            on_conflict="employer_id,ats_type").execute()
        if ats:
            sb.table("employer_ats").delete().eq("employer_id", did).execute()
            stat["ats"] += len(ats)

    # GUARDRAIL: only delete a dup once it has zero children in every real FK table.
    deletable = []
    for d in dups:
        remaining = sum(child_count(t, d["id"]) for t in CHILD_TABLES)
        if remaining == 0:
            deletable.append(d["id"])
        else:
            stat["skipped"] += 1
            print(f"    ! SKIP delete employer {d['id']} ({d.get('name')!r}): "
                  f"{remaining} child rows still attached", flush=True)
    if deletable:
        sb.table("employers").delete().in_("id", deletable).execute()
        stat["deleted"] = len(deletable)
    return stat


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Merge duplicate-FEIN employer rows (same-company only).")
    ap.add_argument("--dry-run", action="store_true", help="preview only; writes snapshot + review CSVs, no DB mutations")
    ap.add_argument("--verify", action="store_true", help="report bucket counts and exit (no writes at all)")
    ap.add_argument("--fein", help="restrict to one FEIN (digits or NN-NNNNNNN)")
    ap.add_argument("--min-lca", type=int, default=0, help="only merge clusters whose summed lca_count >= this")
    ap.add_argument("--limit", type=int, help="process at most N clusters (highest summed lca_count first)")
    ap.add_argument("--chunk", type=int, default=500, help="child-row repoint batch size (lower if 20s timeouts)")
    ap.add_argument("--no-recompute", action="store_true", help="skip the final recompute_lca_counts() RPC")
    ap.add_argument("--yes", action="store_true", help="skip the interactive confirmation")
    args = ap.parse_args()

    print("Building buckets from live employers …", flush=True)
    merge_units, review_rows, stats = build_buckets()
    print(f"  employers={stats['employers']:,}  dup-FEINs={stats['dup_feins']:,}  "
          f"auto-merge clusters={stats['merge_units']:,}  rows→delete={stats['rows_to_delete']:,}  "
          f"review FEINs={stats['review_feins']:,}", flush=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    review_path = write_review_csv(review_rows, ts)
    print(f"  needs_review → {review_path}", flush=True)

    if args.verify:
        return

    # Filter / order the work list.
    if args.fein:
        want = fein_digits(args.fein)
        merge_units = [u for u in merge_units if u["fein"] == want]
    for u in merge_units:
        u["sum_lca"] = sum((r.get("lca_count") or 0) for r in u["rows"])
    merge_units = [u for u in merge_units if u["sum_lca"] >= args.min_lca]
    merge_units.sort(key=lambda u: u["sum_lca"], reverse=True)
    if args.limit:
        merge_units = merge_units[:args.limit]

    if not merge_units:
        print("No clusters match the selection. Nothing to do.")
        return

    n_delete = sum(len(u["rows"]) - 1 for u in merge_units)
    print(f"\nSelected {len(merge_units):,} clusters → will delete {n_delete:,} non-canonical rows.")
    print("Top by summed lca_count:")
    for u in merge_units[:10]:
        canon = canonical_pick(u["rows"])
        names = " | ".join(f"{r['name']}(id={r['id']},lca={r.get('lca_count')})" for r in u["rows"])
        print(f"  fein={u['fein']} sum_lca={u['sum_lca']} canon=id{canon['id']} :: {names}")

    if args.dry_run:
        # still record what WOULD be touched, for audit
        (emp_f, emp_w, emp_path), (mov_f, mov_w, mov_path) = _open_writers(ts)
        for u in merge_units:
            canon = canonical_pick(u["rows"])
            for r in u["rows"]:
                role = "canonical" if r["id"] == canon["id"] else "dup"
                emp_w.writerow([ts, u["fein"], role, r["id"], r.get("name"), r.get("name_clean"),
                                r.get("lca_count"), r.get("lca_count_2025"),
                                r.get("last_filing_date"), json.dumps(r, default=str)])
        emp_f.close(); mov_f.close()
        print(f"\n[DRY RUN] no DB mutations. Snapshot of intended changes → {emp_path}")
        return

    if not args.yes:
        if not sys.stdin.isatty():
            sys.exit("Refusing to mutate without --yes (non-interactive stdin).")
        if input(f"\nProceed to merge {len(merge_units):,} clusters? type 'yes': ").strip().lower() != "yes":
            sys.exit("Aborted.")

    (emp_f, emp_w, emp_path), (mov_f, mov_w, mov_path) = _open_writers(ts)
    totals = {"filings": 0, "jobs": 0, "ats": 0, "deleted": 0, "skipped": 0, "units": 0}
    try:
        for i, u in enumerate(merge_units, 1):
            canon = canonical_pick(u["rows"])
            dups = [r for r in u["rows"] if r["id"] != canon["id"]]
            for r in u["rows"]:                                  # snapshot BEFORE mutating
                role = "canonical" if r["id"] == canon["id"] else "dup"
                emp_w.writerow([ts, u["fein"], role, r["id"], r.get("name"), r.get("name_clean"),
                                r.get("lca_count"), r.get("lca_count_2025"),
                                r.get("last_filing_date"), json.dumps(r, default=str)])
            emp_f.flush()
            if i % CLIENT_REFRESH == 0:
                reset_client()
            for attempt in range(4):
                try:
                    stat = process_unit(u, canon, dups, args, mov_w)
                    break
                except CONN_ERRORS as e:
                    if attempt == 3:
                        raise
                    print(f"    ~ connection dropped ({type(e).__name__}); refreshing client, "
                          f"retrying cluster fein={u['fein']}", flush=True)
                    time.sleep(1.5)
                    reset_client()
            mov_f.flush()
            for k in stat:
                totals[k] += stat[k]
            totals["units"] += 1
            if i % 50 == 0 or i == len(merge_units):
                print(f"  [{i}/{len(merge_units)}] filings={totals['filings']:,} "
                      f"deleted={totals['deleted']:,} skipped={totals['skipped']}", flush=True)
    finally:
        emp_f.close(); mov_f.close()

    print(f"\nMerged {totals['units']:,} clusters: moved {totals['filings']:,} filings, "
          f"{totals['jobs']:,} jobs, {totals['ats']:,} ats; deleted {totals['deleted']:,} rows; "
          f"skipped {totals['skipped']}.")
    print(f"Snapshots: {emp_path} , {mov_path}")

    if not args.no_recompute:
        print("Calling recompute_lca_counts() …", flush=True)
        sb.rpc("recompute_lca_counts", {}).execute()
        print("recompute done.")
    else:
        print("Skipped recompute_lca_counts() (--no-recompute).")


if __name__ == "__main__":
    main()
