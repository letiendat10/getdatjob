#!/usr/bin/env python3
"""Incremental description + salary enrichment for list-only ATS sources.

The daily pull (03_pull_jobs.py) stores only title/location/url for Workday,
SmartRecruiters and iCIMS — their *list* endpoints carry no description, so
description_text is "" and salary_range can never be derived. This pass fetches
each job's *detail* endpoint, fills description_text, and re-derives salary_range.

Design:
  * Capped per run (--limit) so it never runs unbounded — safe to schedule.
  * Resumable: it only selects jobs whose description_text is still empty, so
    repeated runs chew through the backlog (Workday is ~100k jobs) and then keep
    up with the daily delta.
  * Durable: the daily pull omits empty description_text/salary_range from its
    upserts, so values written here survive subsequent daily runs.

Usage:
  python3 scrapers/04_enrich_descriptions.py [--limit 3000] [--ats workday]
                                             [--sleep 0.4] [--dry-run]
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

# Reuse helpers + Supabase client from the puller. Its filename starts with a
# digit, so it can't be imported normally — load it by path via importlib. The
# puller only runs its pull under `if __name__ == "__main__"`, so importing it
# is side-effect-free apart from creating the Supabase client. (03_pull_jobs.py
# does `from config import ...`, so its own directory must be on sys.path.)
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location("pull_jobs", f"{_HERE}/03_pull_jobs.py")
pj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pj)

sb = pj.sb
strip_html = pj.strip_html
parse_salary = pj.parse_salary
parse_workday_posted_on = pj.parse_workday_posted_on
# Re-scoring after enrichment reuses the puller's scorer + the LCA title index, so a
# freshly-enriched description can finalize its confidence tier (notably friendly→excluded
# when it carries a no-sponsor clause) — the same logic 05_rescore_job_signals.py runs in
# batch, applied per-job the moment the description lands.
score_job = pj.score_job
from functools import lru_cache
from title_utils import build_lca_index

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; getdatjob-bot/1.0)"}
TIMEOUT = 20
ENRICHABLE = ("workday", "smartrecruiters", "icims")


# ── per-ATS detail fetchers — return (description_html, posted_at_or_None) ─────

def detail_workday(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    # slug = "{subdomain}.{instance}/{jobsite}" e.g. "cvshealth.wd1/CVS_Health_Careers"
    # ats_job_id = externalPath e.g. "/job/PA---Mount-Carmel/Pharmacy-Technician_R0929734"
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    cxs = f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}{ats_job_id}"
    r = requests.get(cxs, headers={**HEADERS, "Accept": "application/json"}, timeout=TIMEOUT)
    r.raise_for_status()
    info = r.json().get("jobPostingInfo", {}) or {}
    html = info.get("jobDescription", "") or ""
    # Exact posting date; fall back to the relative "postedOn" string if absent.
    posted = info.get("startDate") or parse_workday_posted_on(info.get("postedOn"))
    return html, posted


def detail_smartrecruiters(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{ats_job_id}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"}, timeout=TIMEOUT)
    r.raise_for_status()
    sections = (r.json().get("jobAd", {}) or {}).get("sections", {}) or {}
    parts = []
    for key in ("jobDescription", "qualifications", "additionalInformation"):
        sec = sections.get(key) or {}
        if sec.get("text"):
            parts.append(sec["text"])
    return "\n\n".join(parts), None


def detail_icims(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    # Best-effort: the public job page (in_iframe=1) carries the description body.
    url = f"https://{slug}.icims.com/jobs/{ats_job_id}/job?in_iframe=1"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    node = soup.select_one(
        ".iCIMS_JobContent, .iCIMS_InfoMsg_Job, #jobDescription, [class*='JobDescription']"
    )
    return (str(node) if node else ""), None


DETAIL = {
    "workday": detail_workday,
    "smartrecruiters": detail_smartrecruiters,
    "icims": detail_icims,
}

# oracle_hcm rides the same enrich path; its list + detail fetchers live in oracle_hcm.py
# (shared with 03_pull_jobs_0605_inlineenriched.py). Additive + inert for the PRODUCTION pull,
# which has no oracle_hcm LIST fetcher and so never stores an oracle_hcm job to enrich. Guarded
# so an oracle import hiccup can never break the production enrich path.
try:
    from oracle_hcm import fetch_detail as detail_oracle_hcm
    DETAIL["oracle_hcm"] = detail_oracle_hcm
    if "oracle_hcm" not in ENRICHABLE:
        ENRICHABLE = ENRICHABLE + ("oracle_hcm",)
except Exception as _oracle_import_err:  # pragma: no cover
    print(f"[04] oracle_hcm detail fetcher unavailable: {_oracle_import_err}", flush=True)


# ── slug cache (employer_id, ats) → slug ──────────────────────────────────────
_slug_cache: dict[tuple, str | None] = {}


def get_slug(employer_id: int, ats: str) -> str | None:
    key = (employer_id, ats)
    if key not in _slug_cache:
        r = (
            sb.table("employer_ats")
            .select("slug")
            .eq("employer_id", employer_id)
            .eq("ats_type", ats)
            .limit(1)
            .execute()
        )
        _slug_cache[key] = r.data[0]["slug"] if r.data else None
    return _slug_cache[key]


def fetch_candidates(ats_list: list[str], limit: int) -> list[dict]:
    # Prioritise the jobs that most improve a visa-seeker's search: jobs inside the Kai
    # cascade window first, then biggest-LCA sponsors, newest first; failures cool down
    # (7d) instead of head-of-line blocking the queue. Ordering lives in
    # select_enrich_candidates(); see migration 20260604000002_enrich_sponsor_priority.
    return sb.rpc(
        "select_enrich_candidates", {"p_ats": ats_list, "p_limit": limit}
    ).execute().data


def stamp_attempt(job_id: int, extra: dict | None = None) -> None:
    """Mark a job attempted now (optionally with enrichment fields) so a failure cools
    down for 7 days instead of being re-selected every run and blocking the budget."""
    payload = {"enrich_attempted_at": datetime.now(timezone.utc).isoformat()}
    if extra:
        payload.update(extra)
    sb.table("jobs").update(payload).eq("id", job_id).execute()


@lru_cache(maxsize=4096)
def _lca_index(employer_id: int):
    """Per-employer LCA title index, cached for the process lifetime. LCA data only changes
    on a quarterly bulk load, so caching across a worker's ~5.5h run is safe and avoids a DB
    round-trip per enriched job."""
    return build_lca_index(sb, employer_id)


def rescore_after_enrich(job_id: int, employer_id: int | None, desc_text: str) -> str | None:
    """Finalize a job's confidence tier once its description lands — the per-job equivalent
    of 05_rescore_job_signals.rescore_employer(). Re-runs score_job against the now-present
    description; the only enrichment-driven change is friendly→excluded when a no-sponsor
    clause appears (title-derived verified/excluded are terminal, matching 05's skip rule).
    Returns the new tier when it changed, else None. Callers wrap this so a rescore hiccup
    never fails a successful enrichment."""
    if not employer_id:
        return None
    sig = (
        sb.table("job_signals")
        .select("confidence_tier,no_sponsor_in_desc_flag")
        .eq("job_id", job_id)
        .limit(1)
        .execute()
        .data
    )
    cur_tier = sig[0]["confidence_tier"] if sig else None
    cur_flag = sig[0]["no_sponsor_in_desc_flag"] if sig else None
    if cur_tier in ("verified", "excluded"):
        return None  # terminal — see 05_rescore_job_signals.rescore_employer
    jr = sb.table("jobs").select("title").eq("id", job_id).limit(1).execute().data
    if not jr:
        return None
    titles, counts = _lca_index(employer_id)
    tier, flag, tc, lca_count = score_job(jr[0]["title"], desc_text or "", titles, counts)
    if tier == cur_tier and flag == cur_flag:
        return None  # unchanged — skip the write (and the enrich_priority trigger churn)
    sb.table("job_signals").upsert(
        {
            "job_id": job_id,
            "confidence_tier": tier,
            "no_sponsor_in_desc_flag": flag,
            "title_clean": tc,
            "title_employer_lca_count": lca_count,
        },
        on_conflict="job_id",
    ).execute()
    return tier


def enrich_one(job: dict, *, dry_run: bool = False) -> dict:
    """Fetch + parse + persist enrichment for a single job — the single source of
    per-job enrichment logic, shared by main()'s batch loop and enrich_worker.py.

    `job` needs id, ats_source, ats_job_id, employer_id. Returns a status dict
    {"status": "no_slug"|"error"|"no_desc"|"enriched", ...}. Stamps enrich_attempted_at
    on every outcome (unless dry_run) so failures cool down instead of blocking the queue.
    """
    ats = job["ats_source"]
    slug = get_slug(job["employer_id"], ats)
    if not slug:
        if not dry_run:
            stamp_attempt(job["id"])  # cool down so it doesn't block the queue
        return {"status": "no_slug"}
    try:
        html, posted = DETAIL[ats](slug, job["ats_job_id"])
    except Exception as e:
        if not dry_run:
            stamp_attempt(job["id"])
        return {"status": "error", "error": str(e)}

    desc_text = strip_html(html)[:8000]
    if not desc_text:
        if not dry_run:
            stamp_attempt(job["id"])
        return {"status": "no_desc"}

    # parse_salary derives display + numeric bounds + annual/hourly period.
    sal = parse_salary(html) or parse_salary(desc_text)
    update = {"description_text": desc_text}
    if posted:  # exact Workday startDate — the daily pull leaves posted_at NULL for it
        update["posted_at"] = posted
    if sal:
        update["salary_range"] = sal["display"]
        update["salary_min_num"] = sal["min_num"]
        update["salary_max_num"] = sal["max_num"]
        update["salary_period"] = sal["period"]

    if not dry_run:
        try:
            stamp_attempt(job["id"], update)  # enrichment fields + attempt time in one write
        except Exception as e:
            return {"status": "error", "error": f"update: {e}"}

    # Finalize the confidence tier now that the description exists (per-job 05). Best-effort:
    # a rescore hiccup must never turn a successful enrichment into a failure.
    rescored = None
    if not dry_run:
        try:
            rescored = rescore_after_enrich(job["id"], job.get("employer_id"), desc_text)
        except Exception as e:
            print(f"  [rescore-skip] job {job['id']} — {e}", flush=True)
    # posted_at is surfaced so the focused pull can deactivate a list-only job whose true
    # (just-fetched) date proves older than its freshness window. Additive — the production
    # caller ignores the extra key.
    return {"status": "enriched", "with_salary": bool(sal), "rescored": rescored, "posted_at": posted}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=3000, help="max jobs to enrich this run")
    ap.add_argument("--ats", choices=ENRICHABLE, help="restrict to one ATS (default: all)")
    ap.add_argument("--sleep", type=float, default=0.4, help="delay between detail fetches")
    ap.add_argument("--dry-run", action="store_true", help="fetch + parse but don't write")
    args = ap.parse_args()

    ats_list = [args.ats] if args.ats else list(ENRICHABLE)
    jobs = fetch_candidates(ats_list, args.limit)
    print(f"Enriching {len(jobs)} jobs (ats={ats_list}, dry_run={args.dry_run}) …", flush=True)

    stats = {"enriched": 0, "with_salary": 0, "no_desc": 0, "errors": 0}
    for n, j in enumerate(jobs, 1):
        res = enrich_one(j, dry_run=args.dry_run)
        st = res["status"]
        if st == "enriched":
            stats["enriched"] += 1
            if res.get("with_salary"):
                stats["with_salary"] += 1
        elif st == "no_desc":
            stats["no_desc"] += 1
        else:  # no_slug | error
            stats["errors"] += 1
            if st == "error" and stats["errors"] <= 20:
                print(f"  ERROR {j['ats_source']} id={j['id']} — {res.get('error')}", flush=True)
        if n % 250 == 0:
            print(
                f"  {n}/{len(jobs)} — enriched {stats['enriched']}, "
                f"with salary {stats['with_salary']}, no-desc {stats['no_desc']}, "
                f"errors {stats['errors']}",
                flush=True,
            )
        time.sleep(args.sleep)

    print(
        f"Done. enriched {stats['enriched']} / {len(jobs)} "
        f"({stats['with_salary']} with salary, {stats['no_desc']} no-desc, "
        f"{stats['errors']} errors).",
        flush=True,
    )


if __name__ == "__main__":
    main()
