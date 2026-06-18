#!/usr/bin/env python3
"""tier4_backfill_20260618.py — apply the title-discipline-primary model to the corpus.

After the Tier 4 classify.py changes (strong title phrases, data-engineer→Engineering) and
the new jobs.title_dept_strong column, this one-off:
  1. deletes junk dept_mapping rows (company/product names, req codes — _is_junk_source),
  2. recomputes each active job's department with the full precedence
       strong_title(title) -> dept_mapping[source] (non-junk) -> classify_department(title, source),
     and sets title_dept_strong = strong_title(title),
  3. writes only the rows that change (grouped by target so it's a few hundred updates).

Dry-run by default (prints a from→to summary + the 10 QA regression jobs); --apply writes.
Durable half ships in the PR (pull writers + restamp COALESCE); this fixes existing rows now.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict

sys.path.insert(0, ".")
import classify
import map_source_dept as msd
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

PAGE = 1000
CHUNK = 200
REGRESSION = {6638454: "Data", 6623742: "Data", 6594636: "Engineering", 5284218: "Sales",
              6620285: "Engineering", 6564935: "Engineering", 6591737: "Operations",
              6623740: "Platform / DevOps", 6637561: "Sales", 6617039: "Engineering"}


def resolve(title, source_dept, mapping):
    """Full Tier 4 precedence → (department, title_dept_strong)."""
    strong = classify.strong_title_department(title)
    if strong:
        return strong, strong
    if source_dept and not msd._is_junk_source(source_dept):
        n = msd.norm(source_dept)
        if n and n in mapping:
            return mapping[n], None
    return classify.classify_department(title, source_dept), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # 1. junk dept_mapping rows
    dm = []
    start = 0
    while True:
        rows = (sb.table("dept_mapping").select("source_norm,sample_raw,unified_department,mapped_by")
                .range(start, start + PAGE - 1).execute().data) or []
        dm.extend(rows)
        if len(rows) < PAGE:
            break
        start += PAGE
    junk_rows = [r for r in dm if msd._is_junk_source(r.get("sample_raw") or r["source_norm"])]
    print(f"junk dept_mapping rows: {len(junk_rows)} -> {[r['source_norm'] for r in junk_rows][:20]}")
    mapping = {r["source_norm"]: r["unified_department"]
               for r in dm if r not in junk_rows and r["unified_department"]}
    if args.apply:
        for r in junk_rows:
            sb.table("dept_mapping").delete().eq("source_norm", r["source_norm"]).execute()

    # 2. recompute over active jobs
    changes = defaultdict(list)          # (new_dept, new_strong) -> [ids]
    dept_moves = Counter()               # (old_dept, new_dept) -> n
    seen = reg_hits = 0
    reg_report = {}
    start = 0
    while True:
        rows = (sb.table("jobs").select("id,title,department,source_department,title_dept_strong")
                .eq("is_active", True).order("id").range(start, start + PAGE - 1).execute().data) or []
        for j in rows:
            seen += 1
            new_dept, new_strong = resolve(j["title"], j.get("source_department"), mapping)
            if j["id"] in REGRESSION:
                reg_report[j["id"]] = (j["title"][:50], j["department"], new_dept, REGRESSION[j["id"]])
            if new_dept != j["department"] or new_strong != j.get("title_dept_strong"):
                changes[(new_dept, new_strong)].append(j["id"])
                if new_dept != j["department"]:
                    dept_moves[(j["department"], new_dept)] += 1
        if len(rows) < PAGE:
            break
        start += PAGE

    n_changed = sum(len(v) for v in changes.values())
    print(f"\nactive jobs scanned: {seen}; rows needing update: {n_changed}; dept changes: {sum(dept_moves.values())}")
    print("\ntop department moves (old -> new : count):")
    for (o, nw), c in dept_moves.most_common(25):
        print(f"  {str(o):<18} -> {str(nw):<18} : {c}")
    print("\n10 QA regression jobs (id | title | old -> new | want):")
    for jid, want in REGRESSION.items():
        if jid in reg_report:
            t, old, new, w = reg_report[jid]
            print(f"  {'OK ' if new == w else 'XX '}{jid} | {t:<50} | {old} -> {new} | want {w}")
            reg_hits += (new == w)
        else:
            print(f"  -- {jid} not active/found")
    print(f"regression OK: {reg_hits}/{len(REGRESSION)}")

    if not args.apply:
        print("\ndry-run — re-run with --apply to write")
        return
    for (new_dept, new_strong), ids in changes.items():
        payload = {"department": new_dept, "title_dept_strong": new_strong}
        for i in range(0, len(ids), CHUNK):
            sb.table("jobs").update(payload).in_("id", ids[i:i + CHUNK]).execute()
    print(f"\napplied: updated {n_changed} rows; deleted {len(junk_rows)} junk mappings")


if __name__ == "__main__":
    main()
