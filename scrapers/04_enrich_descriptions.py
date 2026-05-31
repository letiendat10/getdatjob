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
extract_salary = pj.extract_salary

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; getdatjob-bot/1.0)"}
TIMEOUT = 20
ENRICHABLE = ("workday", "smartrecruiters", "icims")


def label_salary(text: str) -> str | None:
    """extract_salary() plus an hourly/annual label.

    Many Workday roles (retail, healthcare) post hourly pay like "$16.00 - $24.00".
    Shown bare on a card that looks like annual figures, so tag small-magnitude
    ranges with "/hr". K-suffixed ($95K – $130K) and 5-6 digit ranges are annual.
    """
    raw = extract_salary(text)
    if not raw:
        return None
    if re.search(r"\dK\b", raw, re.I):  # "$95K – $130K" → annual
        return raw
    nums = [float(n.replace(",", "")) for n in re.findall(r"([\d,]+(?:\.\d+)?)", raw)]
    hi = max(nums) if nums else 0
    if 0 < hi < 1000:  # small magnitude → hourly
        return f"{raw} /hr"
    return raw


# ── per-ATS detail fetchers — return description HTML (or "") ──────────────────

def detail_workday(slug: str, ats_job_id: str) -> str:
    # slug = "{subdomain}.{instance}/{jobsite}" e.g. "cvshealth.wd1/CVS_Health_Careers"
    # ats_job_id = externalPath e.g. "/job/PA---Mount-Carmel/Pharmacy-Technician_R0929734"
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    cxs = f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}{ats_job_id}"
    r = requests.get(cxs, headers={**HEADERS, "Accept": "application/json"}, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json().get("jobPostingInfo", {}).get("jobDescription", "") or ""


def detail_smartrecruiters(slug: str, ats_job_id: str) -> str:
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{ats_job_id}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"}, timeout=TIMEOUT)
    r.raise_for_status()
    sections = (r.json().get("jobAd", {}) or {}).get("sections", {}) or {}
    parts = []
    for key in ("jobDescription", "qualifications", "additionalInformation"):
        sec = sections.get(key) or {}
        if sec.get("text"):
            parts.append(sec["text"])
    return "\n\n".join(parts)


def detail_icims(slug: str, ats_job_id: str) -> str:
    # Best-effort: the public job page (in_iframe=1) carries the description body.
    url = f"https://{slug}.icims.com/jobs/{ats_job_id}/job?in_iframe=1"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    node = soup.select_one(
        ".iCIMS_JobContent, .iCIMS_InfoMsg_Job, #jobDescription, [class*='JobDescription']"
    )
    return str(node) if node else ""


DETAIL = {
    "workday": detail_workday,
    "smartrecruiters": detail_smartrecruiters,
    "icims": detail_icims,
}


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
    return (
        sb.table("jobs")
        .select("id, ats_source, ats_job_id, url, employer_id")
        .eq("is_active", True)
        .in_("ats_source", ats_list)
        .or_("description_text.is.null,description_text.eq.")
        .order("posted_at", desc=True, nullsfirst=False)
        .limit(limit)
        .execute()
        .data
    )


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
        ats = j["ats_source"]
        slug = get_slug(j["employer_id"], ats)
        if not slug:
            stats["errors"] += 1
            continue
        try:
            html = DETAIL[ats](slug, j["ats_job_id"])
        except Exception as e:
            stats["errors"] += 1
            if stats["errors"] <= 20:
                print(f"  ERROR {ats} id={j['id']} — {e}", flush=True)
            time.sleep(args.sleep)
            continue

        desc_text = strip_html(html)[:8000]
        if not desc_text:
            stats["no_desc"] += 1
            time.sleep(args.sleep)
            continue
        salary = label_salary(desc_text or html)

        if not args.dry_run:
            try:
                sb.table("jobs").update(
                    {"description_text": desc_text, "salary_range": salary}
                ).eq("id", j["id"]).execute()
            except Exception as e:
                stats["errors"] += 1
                print(f"  ERROR update id={j['id']} — {e}", flush=True)
                continue

        stats["enriched"] += 1
        if salary:
            stats["with_salary"] += 1
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
