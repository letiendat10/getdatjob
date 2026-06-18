#!/usr/bin/env python3
"""workday_family_sweep.py — weekly jobs.source_department backfill for Workday tenants.

Workday's CXS list API returns no job family on postings and the detail API carries none
either — the ONLY source is the list FACETS (jobFamilyGroup, fallback jobFamily), which
cost one extra paginated sweep per facet value (~a second full pull per tenant). That's
why the 4x/day puller (03_pull_jobs_enriched_0606) skips the sweep. This job runs WEEKLY
instead (.github/workflows/weekly_workday_family.yml), decoupled from the pull deadline:

  * tenants are ranked by how many ACTIVE jobs lack source_department (most first); a
    tenant that's fully covered is skipped, so reruns resume naturally and the steady
    state is cheap (families are stable — weekly refresh is plenty).
  * writes ONLY jobs.source_department, and only where it is NULL — never department.
    map_source_dept.py (the next workflow step) folds new raw values into dept_mapping
    and restamps jobs.department through the normal governed rule -> LLM -> human path.
  * budgeted like the daily pull (see bug_pull_enrich_pool_hang): SIGALRM caps each
    employer, a global deadline caps the run, and per-employer flushes mean nothing is
    lost if either trips.

Env knobs: EMPLOYER_BUDGET_S (default 420), RUN_DEADLINE_MIN (default 150),
MAX_EMPLOYERS (default 0 = no cap; handy for local validation).
"""
from __future__ import annotations

import importlib.util
import os
import signal
import sys
import time

import requests
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name: str, fname: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# Shared fetcher library (digit-prefixed filename → importlib): HEADERS + TIMEOUT. The
# facet-sweep logic is reimplemented here rather than reusing _workday_family_map because
# the sweep needs different write semantics: per-facet flushes (a budget interrupt keeps
# every completed job family) and an early exit once all missing paths are matched.
pull = _load("pull_jobs_lib", "03_pull_jobs.py")

EMPLOYER_BUDGET_S = int(os.environ.get("EMPLOYER_BUDGET_S", "420"))
RUN_DEADLINE_MIN = int(os.environ.get("RUN_DEADLINE_MIN", "150"))
MAX_EMPLOYERS = int(os.environ.get("MAX_EMPLOYERS", "0"))
UPDATE_CHUNK = 50  # externalPaths are long; keep PostgREST in_() URLs comfortably short
PAGE = 1000


class _EmployerTimeout(BaseException):
    # BaseException, NOT Exception: the SIGALRM must punch through the broad
    # `except Exception` guards inside the per-page fetch loops.
    pass


def _alarm(_sig, _frm):
    raise _EmployerTimeout()


def fetch_all(query_fn):
    out, start = [], 0
    while True:
        rows = query_fn(start, start + PAGE - 1).execute().data or []
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        start += PAGE


def load_queue(sb):
    """[(employer_id, slug, [missing externalPaths])] ranked by missing count desc."""
    missing = fetch_all(lambda s, e: sb.table("jobs")
                        .select("employer_id,ats_job_id")
                        .eq("ats_source", "workday").eq("is_active", True)
                        .is_("source_department", "null")
                        .order("id").range(s, e))
    by_emp: dict[int, list[str]] = {}
    for r in missing:
        by_emp.setdefault(r["employer_id"], []).append(r["ats_job_id"])

    ats = fetch_all(lambda s, e: sb.table("employer_ats")
                    .select("employer_id,slug")
                    .eq("ats_type", "workday").range(s, e))
    slug_by_emp = {r["employer_id"]: r["slug"] for r in ats if r.get("slug")}

    queue = [(eid, slug_by_emp[eid], paths) for eid, paths in by_emp.items()
             if eid in slug_by_emp]
    queue.sort(key=lambda t: -len(t[2]))
    return queue


def _write_family(sb, eid: int, desc: str, eps: list[str]) -> int:
    n = 0
    for i in range(0, len(eps), UPDATE_CHUNK):
        chunk = eps[i:i + UPDATE_CHUNK]
        # NULL-guarded: never churn a value some other path already filled.
        sb.table("jobs").update({"source_department": desc}) \
          .eq("employer_id", eid).eq("ats_source", "workday") \
          .in_("ats_job_id", chunk).is_("source_department", "null").execute()
        n += len(chunk)
    return n


def sweep_employer(sb, eid: int, slug: str, missing_paths: list[str]) -> int:
    """Enumerate the tenant's jobFamilyGroup facet (fallback jobFamily) and fill
    source_department for the missing externalPaths. Flushes PER FACET VALUE, so a
    budget interrupt keeps every completed family; exits early once all missing paths
    are matched."""
    missing = set(missing_paths)
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    api = f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}/jobs"
    headers = {**pull.HEADERS, "Content-Type": "application/json"}

    r = requests.post(api, json={"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": ""},
                      headers=headers, timeout=pull.TIMEOUT)
    r.raise_for_status()
    facets = (r.json() or {}).get("facets", []) or []
    fam = (next((f for f in facets if f.get("facetParameter") == "jobFamilyGroup"), None)
           or next((f for f in facets if f.get("facetParameter") == "jobFamily"), None))
    if not fam:
        return 0
    param = fam.get("facetParameter")

    n = 0
    for v in (fam.get("values") or []):
        fid, desc = v.get("id"), v.get("descriptor")
        if not fid or not desc:
            continue
        cnt = v.get("count") or 0
        hits: list[str] = []
        offset, limit = 0, 20
        while True:
            try:
                rr = requests.post(
                    api,
                    json={"appliedFacets": {param: [fid]}, "limit": limit, "offset": offset, "searchText": ""},
                    headers=headers, timeout=pull.TIMEOUT,
                )
                rr.raise_for_status()
                posts = rr.json().get("jobPostings", [])
            except Exception:
                break  # this facet is best-effort; _EmployerTimeout (BaseException) still escapes
            if not posts:
                break
            hits.extend(p.get("externalPath") for p in posts if p.get("externalPath") in missing)
            offset += limit
            if (cnt and offset >= cnt) or len(posts) < limit:
                break
            time.sleep(0.3)
        if hits:
            n += _write_family(sb, eid, desc, hits)
            missing.difference_update(hits)
        if not missing:
            break  # every missing path is matched — skip the remaining facet values
    return n


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    queue = load_queue(sb)
    if MAX_EMPLOYERS:
        queue = queue[:MAX_EMPLOYERS]
    total_missing = sum(len(p) for _, _, p in queue)
    print(f"workday_family_sweep: {len(queue)} tenants, {total_missing} active jobs missing "
          f"source_department", flush=True)

    deadline = time.monotonic() + RUN_DEADLINE_MIN * 60
    signal.signal(signal.SIGALRM, _alarm)
    done = updated = 0
    for eid, slug, paths in queue:
        if time.monotonic() > deadline:
            print(f"workday_family_sweep: deadline ({RUN_DEADLINE_MIN}m) reached after "
                  f"{done}/{len(queue)} tenants — the next weekly run resumes here", flush=True)
            break
        signal.alarm(EMPLOYER_BUDGET_S)
        try:
            n = sweep_employer(sb, eid, slug, paths)
            updated += n
            print(f"  {slug}: +{n}/{len(paths)}", flush=True)
        except _EmployerTimeout:
            print(f"  {slug}: employer budget ({EMPLOYER_BUDGET_S}s) hit — completed families "
                  f"kept, rest next run", flush=True)
        except Exception as e:
            print(f"  {slug}: skipped ({type(e).__name__}: {e})", flush=True)
        finally:
            signal.alarm(0)
        done += 1

    print(f"workday_family_sweep: done — {updated} jobs gained source_department "
          f"across {done} tenants", flush=True)


if __name__ == "__main__":
    main()
