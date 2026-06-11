"""
backfill_amazon_posted_at.py — ONE-OFF repair (2026-06-11).

Amazon's search.json sends posted_date as "June 9, 2026", which the ISO-only
parse_iso silently dropped, so every Amazon row was written with posted_at NULL
(displayed as the scrape date) or, worse, a relative `updated_time` stamp from a
legacy run. The pull can't repair rows older than the freshness window — list_gate
drops them before the write — so this script re-fetches the FULL amazon.jobs board
once and stamps the true posted_date on every existing row (active or not) by
ats_job_id. Future pulls stay correct via parse_date_loose in 03_pull_jobs.py.

Run locally (service key):
  export SUPABASE_KEY=...   # from web/.env.local
  python3 scrapers/backfill_amazon_posted_at.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _load(mod_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(mod_name, f"{_HERE}/{filename}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


pj = _load("pull_jobs", "03_pull_jobs.py")
sb = pj.sb

CHUNK = 400  # ids per UPDATE — keyed lookups on the (ats_source, ats_job_id) unique index


def main() -> None:
    print("fetching full amazon.jobs board…", flush=True)
    rows = pj.fetch_amazon("")
    seen: dict[str, str] = {}
    undated = 0
    for r in rows:
        jid, posted = r["ats_job_id"], r["posted_at"]
        if not jid or jid in seen:
            continue
        if posted:
            seen[jid] = posted
        else:
            undated += 1
    by_date: dict[str, list[str]] = defaultdict(list)
    for jid, posted in seen.items():
        by_date[posted].append(jid)
    print(f"{len(rows)} board jobs → {len(seen)} dated across {len(by_date)} distinct dates "
          f"({undated} without posted_date, left untouched)", flush=True)

    stamped = 0
    for i, (posted, ids) in enumerate(sorted(by_date.items()), 1):
        for j in range(0, len(ids), CHUNK):
            chunk = ids[j:j + CHUNK]
            sb.table("jobs").update({"posted_at": posted}) \
              .eq("ats_source", "amazon").in_("ats_job_id", chunk).execute()
            stamped += len(chunk)
        if i % 10 == 0 or i == len(by_date):
            print(f"  {i}/{len(by_date)} dates · {stamped} board ids stamped", flush=True)

    remaining = (sb.table("jobs").select("id", count="exact")
                 .eq("ats_source", "amazon").eq("is_active", True)
                 .is_("posted_at", "null").limit(1).execute())
    print(f"done — {stamped} board ids stamped; active amazon rows still NULL: "
          f"{remaining.count} (delisted from the board or undated there)", flush=True)


if __name__ == "__main__":
    main()
