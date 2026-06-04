#!/usr/bin/env python3
"""Always-on realtime enrichment worker — LISTEN/NOTIFY driven, with a polling net.

A Postgres AFTER INSERT trigger (migration 20260604000003_enrich_notify) pg_notify()s
the channel 'enrich_new' with {id, ats_source, ats_job_id, employer_id} whenever a
list-only-ATS job lands without a description. This worker LISTENs on that channel and
enriches each new posting within seconds, reusing 04_enrich_descriptions.enrich_one()
so there is exactly one copy of the per-job enrichment logic.

It ALSO sweeps select_enrich_candidates() on an interval to (a) drain the existing
backlog newest-/highest-LCA-first and (b) catch any notifications missed while the
worker was restarting — NOTIFY is not durable, so the sweep is the safety net.

Designed for GitHub Actions: it self-limits to --max-runtime (< the 6h job cap); the
workflow's schedule + concurrency guard hand off to the next run with no gap.

Env:
  SUPABASE_KEY     — service key for the PostgREST RPC + writes (config.py hardcodes the
                     project URL). Required.
  SUPABASE_DB_URL  — session-pooler connection string (port 5432, which supports LISTEN).
                     If unset, runs poll-only (still works, at sweep latency not sub-second).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import select
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _load(mod_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(mod_name, f"{_HERE}/{filename}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Reuse the single source of enrichment logic (also pulls in the Supabase client).
_enr = _load("enrich_descriptions", "04_enrich_descriptions.py")
enrich_one = _enr.enrich_one
fetch_candidates = _enr.fetch_candidates
ENRICHABLE = list(_enr.ENRICHABLE)

CHANNEL = "enrich_new"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--concurrency", type=int, default=6, help="parallel detail fetches")
    ap.add_argument("--max-runtime", type=int, default=19800, help="seconds before clean exit (~5.5h)")
    ap.add_argument("--sweep-interval", type=int, default=30, help="seconds between backlog/safety sweeps")
    ap.add_argument("--sweep-limit", type=int, default=300, help="candidates pulled per sweep")
    ap.add_argument("--topup-threshold", type=int, default=50, help="skip sweep while this many are in flight")
    ap.add_argument("--dry-run", action="store_true", help="fetch + parse but never write (for local testing)")
    args = ap.parse_args()

    started = time.monotonic()
    pool = ThreadPoolExecutor(max_workers=args.concurrency)
    in_flight: set[int] = set()
    lock = threading.Lock()

    def submit(job: dict) -> bool:
        jid = job.get("id")
        if jid is None:
            return False
        with lock:
            if jid in in_flight:
                return False
            in_flight.add(jid)

        def run() -> None:
            try:
                res = enrich_one(job, dry_run=args.dry_run)
                status = res.get("status")
                if status not in ("enriched",):
                    print(f"  [{status}] job {jid} {job.get('ats_source')} {res.get('error', '')}".rstrip(), flush=True)
                else:
                    print(f"  [enriched{'+salary' if res.get('with_salary') else ''}] job {jid}", flush=True)
            except Exception as e:  # never let a thread die silently
                print(f"  [crash] job {jid} — {e}", flush=True)
            finally:
                with lock:
                    in_flight.discard(jid)

        pool.submit(run)
        return True

    def sweep() -> int:
        with lock:
            busy = len(in_flight)
        if busy >= args.topup_threshold:
            return 0
        try:
            jobs = fetch_candidates(ENRICHABLE, args.sweep_limit)
        except Exception as e:
            print(f"  sweep error — {e}", flush=True)
            return 0
        return sum(1 for j in jobs if submit(j))

    print(f"startup sweep — queued {sweep()} backlog job(s)", flush=True)

    # ── realtime LISTEN (optional; degrades to poll-only) ─────────────────────
    conn = None
    db_url = os.environ.get("SUPABASE_DB_URL")
    if db_url:
        try:
            import psycopg2
            from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

            conn = psycopg2.connect(db_url)
            conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)  # required to receive NOTIFY
            conn.cursor().execute(f"LISTEN {CHANNEL};")
            print(f"LISTEN {CHANNEL} — realtime enabled", flush=True)
        except Exception as e:
            print(f"⚠ realtime unavailable ({e}) — poll-only mode", flush=True)
            conn = None
    else:
        print("SUPABASE_DB_URL unset — poll-only mode", flush=True)

    # ── main loop ─────────────────────────────────────────────────────────────
    last_sweep = time.monotonic()
    notified = 0
    while time.monotonic() - started < args.max_runtime:
        if conn is not None:
            # Block up to 5s for a notification, then fall through to the sweep tick.
            if select.select([conn], [], [], 5) != ([], [], []):
                conn.poll()
                while conn.notifies:
                    note = conn.notifies.pop(0)
                    try:
                        if submit(json.loads(note.payload)):
                            notified += 1
                    except Exception as e:
                        print(f"  bad notify payload — {e}", flush=True)
        else:
            time.sleep(2)

        if time.monotonic() - last_sweep >= args.sweep_interval:
            sweep()
            last_sweep = time.monotonic()

    print(f"max runtime reached (handled {notified} realtime) — draining …", flush=True)
    pool.shutdown(wait=True)
    if conn is not None:
        conn.close()
    print("worker exit", flush=True)


if __name__ == "__main__":
    main()
