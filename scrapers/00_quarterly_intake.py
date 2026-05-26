#!/usr/bin/env python3
"""
00_quarterly_intake.py
Quarterly LCA data intake agent.

Usage:
    python scrapers/00_quarterly_intake.py data/raw/LCA_Dislclosure_Data_FY2026_Q2.xlsx

What it does:
  1. Validates the xlsx file (correct DOL columns, date range)
  2. Upserts employers (lca_count, lca_by_quarter, POC info) + replaces this quarter's lca_filings
  3. Detects ATS for net-new employers (Greenhouse, Lever, Ashby, SmartRecruiters)
  4. Pulls jobs for newly-detected employers
  5. Prints a report + saves it to data/intake_reports/

employer_ats, jobs, and job_signals are never deleted — only appended for new employers.
Prior quarters' lca_filings are preserved; only the new quarter's date range is replaced.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import date, datetime, timezone, timedelta

import anthropic
import pandas as pd
import requests
from supabase import create_client

sys.path.insert(0, os.path.dirname(__file__))

# Load ANTHROPIC_API_KEY from web/.env.local if not already in environment
if not os.environ.get("ANTHROPIC_API_KEY"):
    _env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", ".env.local")
    if os.path.exists(_env_path):
        with open(_env_path) as _f:
            for _line in _f:
                _line = _line.strip()
                if _line.startswith("ANTHROPIC_API_KEY=") and not _line.startswith("#"):
                    os.environ["ANTHROPIC_API_KEY"] = _line.split("=", 1)[1]
                    break

from config import SUPABASE_URL, SUPABASE_KEY, DATA_DIR, TOP_N_EMPLOYERS
from title_utils import clean_title

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
client = anthropic.Anthropic()

HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 8

REQUIRED_COLS = [
    "EMPLOYER_NAME", "EMPLOYER_FEIN", "JOB_TITLE", "SOC_CODE",
    "WAGE_RATE_OF_PAY_FROM", "PW_WAGE_LEVEL", "WORKSITE_CITY", "WORKSITE_STATE",
    "BEGIN_DATE", "VISA_CLASS", "CASE_STATUS",
    "EMPLOYER_POC_FIRST_NAME", "EMPLOYER_POC_LAST_NAME", "EMPLOYER_POC_EMAIL",
]

COLS = {
    "EMPLOYER_NAME": "employer_name",
    "EMPLOYER_FEIN": "fein",
    "JOB_TITLE": "job_title",
    "SOC_CODE": "soc_code",
    "WAGE_RATE_OF_PAY_FROM": "wage_offered",
    "PW_WAGE_LEVEL": "wage_level",
    "WORKSITE_CITY": "city",
    "WORKSITE_STATE": "state",
    "BEGIN_DATE": "filing_date",
    "VISA_CLASS": "visa_class",
    "CASE_STATUS": "case_status",
    "EMPLOYER_POC_FIRST_NAME": "poc_first_name",
    "EMPLOYER_POC_LAST_NAME": "poc_last_name",
    "EMPLOYER_POC_EMAIL": "poc_email",
}

SYSTEM_PROMPT = """\
You are the getdatjob quarterly LCA intake agent.

Goal: enrich the employer database with new quarter LCA data, then map as many employers as
possible to their ATS and get their jobs live — prioritizing the highest LCA-count employers first.

Step-by-step:
1. validate_xlsx_file — confirm file is valid
2. run_lca_enrichment — load filings, upsert employers
3. process_unmapped_bucket(offset=0) — process the first bucket of 5 unmapped employers
4. If has_more is true, call process_unmapped_bucket(offset=next_offset) — keep going
   until has_more is false OR you've processed enough (use judgment: stop if lca_count of
   remaining employers drops below ~20, or after 40 buckets / 200 employers)
5. Write the final intake report with cumulative stats across all buckets, the
   not_mapped list (top 20 by lca_count) for manual Workday/iCIMS follow-up,
   any QA failures (slug found but 0 jobs), and a NEXT STEPS checklist.

Rules:
- Never delete employer_ats, jobs, or job_signals rows.
- Employers that already have an employer_ats row are automatically skipped by the tool.
- process_unmapped_bucket handles ALL unmapped employers (new and returning), sorted by
  lca_count descending — highest-value companies get processed first.
- Each bucket: detect ATS for each company (all types), QA the slug (must have >0 jobs),
  then pull jobs for all confirmed companies in the bucket before moving on.
"""


# ── Utility ───────────────────────────────────────────────────────────────────

def clean_name(name: str) -> str:
    if not name:
        return ""
    return re.sub(r"\s+", " ", str(name).lower().strip())


def _quarter_key_from_date(d: date) -> str:
    """Convert a date to a fiscal quarter key like 'FY2026_Q2'."""
    q = (d.month - 1) // 3 + 1
    return f"FY{d.year}_Q{q}"


# ── Tool 1: validate_xlsx_file ────────────────────────────────────────────────

def validate_xlsx_file(path: str) -> dict:
    if not os.path.exists(path):
        return {"error": f"File not found: {path}"}
    try:
        print("  Reading column headers …")
        df_head = pd.read_excel(path, nrows=0)
        actual_cols = set(df_head.columns.tolist())
        missing = [c for c in REQUIRED_COLS if c not in actual_cols]

        print("  Counting rows …")
        df_status = pd.read_excel(path, usecols=["CASE_STATUS"], dtype=str)
        row_count = len(df_status)
        certified = int((df_status["CASE_STATUS"].str.upper() == "CERTIFIED").sum())

        print("  Reading date range …")
        df_dates = pd.read_excel(path, usecols=["BEGIN_DATE", "CASE_STATUS"], dtype=str)
        df_dates = df_dates[df_dates["CASE_STATUS"].str.upper() == "CERTIFIED"].copy()
        df_dates["BEGIN_DATE"] = pd.to_datetime(df_dates["BEGIN_DATE"], errors="coerce")
        date_min = df_dates["BEGIN_DATE"].min()
        date_max = df_dates["BEGIN_DATE"].max()
        d_min = str(date_min.date()) if pd.notna(date_min) else None
        d_max = str(date_max.date()) if pd.notna(date_max) else None

        quarter_hint = ""
        m = re.search(r"FY(\d{4})_Q(\d)", os.path.basename(path), re.IGNORECASE)
        if m:
            quarter_hint = f"FY{m.group(1)}_Q{m.group(2)}"
        elif d_min:
            quarter_hint = _quarter_key_from_date(date.fromisoformat(d_min))

        existing_count = 0
        already_loaded = False
        if d_min and d_max:
            res = (
                sb.table("lca_filings")
                .select("id", count="exact")
                .gte("filing_date", d_min)
                .lte("filing_date", d_max)
                .execute()
            )
            existing_count = res.count or 0
            already_loaded = existing_count > 0

        return {
            "path": path,
            "row_count": row_count,
            "certified_count": certified,
            "columns_missing": missing,
            "date_range": {"min": d_min, "max": d_max},
            "quarter_hint": quarter_hint,
            "already_loaded": already_loaded,
            "existing_filing_count": existing_count,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


# ── Tool 2: run_lca_enrichment ────────────────────────────────────────────────

def run_lca_enrichment(xlsx_path: str) -> dict:
    try:
        print("  Loading xlsx …")
        df = pd.read_excel(xlsx_path, usecols=list(COLS.keys()), dtype=str)
        df.rename(columns=COLS, inplace=True)
        df = df[df["case_status"].str.upper() == "CERTIFIED"].copy()
        df["employer_name"] = df["employer_name"].str.strip()
        df["name_clean"] = df["employer_name"].apply(clean_name)
        df["filing_date"] = pd.to_datetime(df["filing_date"], errors="coerce").dt.date
        df["wage_offered"] = pd.to_numeric(df["wage_offered"], errors="coerce")

        date_min = df["filing_date"].min()
        date_max = df["filing_date"].max()
        m = re.search(r"FY(\d{4})_Q(\d)", os.path.basename(xlsx_path), re.IGNORECASE)
        quarter_key = f"FY{m.group(1)}_Q{m.group(2)}" if m else (_quarter_key_from_date(date_min) if date_min else "unknown")

        # Per-employer stats for this quarter
        counts = (
            df.groupby(["employer_name", "name_clean", "fein"])
            .size()
            .reset_index(name="q_count")
            .sort_values("q_count", ascending=False)
            .drop_duplicates("name_clean")
            .head(TOP_N_EMPLOYERS)
        )
        top_visa = (
            df.groupby("name_clean")["visa_class"]
            .agg(lambda s: s.value_counts().index[0] if len(s) else None)
            .reset_index()
            .rename(columns={"visa_class": "top_visa_class"})
        )
        last_filing = (
            df.groupby("name_clean")["filing_date"]
            .max()
            .reset_index()
            .rename(columns={"filing_date": "last_filing_date"})
        )
        # POC from most recent filing per employer
        poc_df = (
            df.sort_values("filing_date", ascending=False)
            .groupby("name_clean")[["poc_first_name", "poc_last_name", "poc_email"]]
            .first()
            .reset_index()
        )
        counts = counts.merge(top_visa, on="name_clean").merge(last_filing, on="name_clean").merge(poc_df, on="name_clean")

        # Fetch existing employers (for cumulative lca_count update)
        existing_result = sb.table("employers").select("id,name_clean,lca_count,lca_by_quarter").execute()
        existing_by_name = {e["name_clean"]: e for e in existing_result.data}

        new_count = 0
        updated_count = 0

        print(f"  Upserting {len(counts)} employers …")
        for _, r in counts.iterrows():
            nc = r["name_clean"]
            q_count = int(r["q_count"])
            poc_fn = r["poc_first_name"] if pd.notna(r.get("poc_first_name")) else None
            poc_ln = r["poc_last_name"] if pd.notna(r.get("poc_last_name")) else None
            poc_em = r["poc_email"] if pd.notna(r.get("poc_email")) else None
            lfd = str(r["last_filing_date"]) if pd.notna(r["last_filing_date"]) else None
            tvc = r["top_visa_class"] if pd.notna(r["top_visa_class"]) else None

            if nc in existing_by_name:
                prior = existing_by_name[nc]
                prior_by_q: dict = prior.get("lca_by_quarter") or {}
                prior_total: int = prior.get("lca_count") or 0
                old_q_count = prior_by_q.get(quarter_key, 0)
                new_by_q = {**prior_by_q, quarter_key: q_count}
                new_total = prior_total - old_q_count + q_count  # replace old Q value, keep others
                sb.table("employers").update({
                    "lca_count": new_total,
                    "lca_by_quarter": new_by_q,
                    "top_visa_class": tvc,
                    "last_filing_date": lfd,
                    "poc_first_name": poc_fn,
                    "poc_last_name": poc_ln,
                    "poc_email": poc_em,
                }).eq("name_clean", nc).execute()
                updated_count += 1
            else:
                sb.table("employers").insert({
                    "name": r["employer_name"],
                    "name_clean": nc,
                    "fein": r["fein"] if pd.notna(r["fein"]) else None,
                    "lca_count": q_count,
                    "lca_by_quarter": {quarter_key: q_count},
                    "top_visa_class": tvc,
                    "last_filing_date": lfd,
                    "poc_first_name": poc_fn,
                    "poc_last_name": poc_ln,
                    "poc_email": poc_em,
                }).execute()
                new_count += 1

        # Fetch employer ID map for filing insert
        id_result = sb.table("employers").select("id,name_clean").execute()
        employer_ids = {r["name_clean"]: r["id"] for r in id_result.data}

        # Replace this quarter's filings only — prior quarters preserved
        print(f"  Replacing lca_filings for {date_min} → {date_max} …")
        sb.table("lca_filings").delete().gte("filing_date", str(date_min)).lte("filing_date", str(date_max)).execute()

        # Build and insert filing rows
        top_names = set(employer_ids.keys())
        subset = df[df["name_clean"].isin(top_names)].copy()
        subset["employer_id"] = subset["name_clean"].map(employer_ids)

        filing_rows = []
        for _, r in subset.iterrows():
            filing_rows.append({
                "employer_id": int(r["employer_id"]),
                "job_title": r["job_title"] if pd.notna(r["job_title"]) else None,
                "title_clean": clean_title(r["job_title"]) if pd.notna(r["job_title"]) else None,
                "soc_code": r["soc_code"] if pd.notna(r["soc_code"]) else None,
                "wage_offered": float(r["wage_offered"]) if pd.notna(r["wage_offered"]) else None,
                "wage_level": r["wage_level"] if pd.notna(r["wage_level"]) else None,
                "city": r["city"] if pd.notna(r["city"]) else None,
                "state": r["state"] if pd.notna(r["state"]) else None,
                "filing_date": str(r["filing_date"]) if pd.notna(r["filing_date"]) else None,
                "visa_class": r["visa_class"] if pd.notna(r["visa_class"]) else None,
                "case_status": r["case_status"] if pd.notna(r["case_status"]) else None,
            })

        print(f"  Inserting {len(filing_rows):,} lca_filings …")
        for i in range(0, len(filing_rows), 500):
            sb.table("lca_filings").insert(filing_rows[i:i + 500]).execute()
            print(f"    {min(i + 500, len(filing_rows)):,}/{len(filing_rows):,}")

        # Total filings in DB (all quarters)
        total_res = sb.table("lca_filings").select("id", count="exact").execute()
        total_in_db = total_res.count or len(filing_rows)

        visa_breakdown = df["visa_class"].value_counts().to_dict()

        return {
            "employers_new": new_count,
            "employers_updated": updated_count,
            "filings_inserted": len(filing_rows),
            "filings_in_db_total": total_in_db,
            "quarter_key": quarter_key,
            "date_range": {"min": str(date_min), "max": str(date_max)},
            "visa_breakdown": {k: int(v) for k, v in visa_breakdown.items()},
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


# ── ATS slug helpers (inline from 02_detect_ats.py) ──────────────────────────

def _slugify(name: str) -> list[str]:
    base = re.sub(r"[^\w\s-]", "", name.lower())
    base = re.sub(r"[\s_]+", "-", base.strip())
    cleaned = re.sub(r"-(inc|llc|corp|ltd|co|group|technologies|technology|labs|ai)$", "", base)
    return list(dict.fromkeys([base, cleaned]))


def _detect_ats_for_company(name: str) -> tuple[str | None, str | None, int]:
    """
    Try all ATS types for one company name.
    Returns (ats_type, slug, job_count) — all None/0 if nothing found.
    QA is built-in: slug must resolve AND have > 0 jobs to be accepted.
    """
    ATS_ORDER = ["greenhouse", "lever", "ashby", "smartrecruiters"]

    def check(ats: str, slug: str) -> int:
        """Returns job count if slug resolves with >0 jobs, else 0."""
        try:
            if ats == "greenhouse":
                r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                                  headers=HEADERS, timeout=TIMEOUT)
                if r.status_code == 200 and "jobs" in r.json():
                    return len(r.json()["jobs"])
            elif ats == "lever":
                r = requests.get(f"https://api.lever.co/v0/postings/{slug}?mode=json",
                                  headers=HEADERS, timeout=TIMEOUT)
                if r.status_code == 200 and isinstance(r.json(), list):
                    return len(r.json())
            elif ats == "ashby":
                r = requests.get(
                    f"https://jobs.ashby.com/api/posting-api/job-board?organizationHostedJobsPageName={slug}",
                    headers=HEADERS, timeout=TIMEOUT,
                )
                if r.status_code == 200 and "jobPostings" in r.json():
                    return len(r.json()["jobPostings"])
            elif ats == "smartrecruiters":
                r = requests.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
                                  headers=HEADERS, timeout=TIMEOUT)
                if r.status_code == 200:
                    return r.json().get("totalFound", 0)
        except Exception:
            pass
        return 0

    for ats in ATS_ORDER:
        for slug in _slugify(name):
            count = check(ats, slug)
            if count > 0:  # QA: must have real jobs, not just an empty board
                return ats, slug, count
            time.sleep(0.3)

    return None, None, 0


# ── Job pulling helper ────────────────────────────────────────────────────────

def _load_pull_jobs_mod():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "pull_jobs",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "03_pull_jobs.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _pull_jobs_for_employer(mod, emp_id: int, emp_name: str, ats_type: str, slug: str) -> int:
    """Pull and upsert jobs + signals for one employer. Returns job count."""
    fetcher = mod.FETCHERS.get(ats_type)
    if not fetcher:
        return 0
    try:
        raw_jobs = fetcher(slug)
    except Exception as e:
        print(f"    ERROR fetching jobs: {e}")
        return 0
    if not raw_jobs:
        return 0

    lca_titles, lca_counts = mod.build_lca_index(sb, emp_id)
    now = datetime.now(timezone.utc).isoformat()

    job_rows = list({j["ats_job_id"]: {
        "employer_id": emp_id,
        "title": j["title"],
        "location": j["location"],
        "url": j["url"],
        "posted_at": j["posted_at"],
        "ats_source": ats_type,
        "ats_job_id": j["ats_job_id"],
        "description_text": j["description_text"],
        "is_active": True,
        "last_seen_at": now,
    } for j in raw_jobs}.values())

    for chunk in range(0, len(job_rows), 500):
        sb.table("jobs").upsert(job_rows[chunk:chunk + 500], on_conflict="ats_source,ats_job_id").execute()

    ids_res = (
        sb.table("jobs").select("id,title,description_text")
        .eq("employer_id", emp_id).eq("ats_source", ats_type).execute()
    )
    signal_rows = []
    for rec in ids_res.data:
        tier, flag, tc, lca_count = mod.score_job(
            rec["title"], rec["description_text"] or "", lca_titles, lca_counts
        )
        signal_rows.append({
            "job_id": rec["id"],
            "confidence_tier": tier,
            "no_sponsor_in_desc_flag": flag,
            "title_clean": tc,
            "title_employer_lca_count": lca_count,
        })
    if signal_rows:
        sb.table("job_signals").upsert(signal_rows, on_conflict="job_id").execute()

    return len(job_rows)


# ── Tool 3: process_unmapped_bucket ──────────────────────────────────────────
# Processes one bucket of unmapped employers (sorted by lca_count DESC):
#   - Skips companies already in employer_ats
#   - Per company: tries all ATS types, QA = must have >0 jobs
#   - After the whole bucket: pulls jobs for confirmed companies
# Claude calls this repeatedly with increasing offset until has_more=false.

def process_unmapped_bucket(offset: int = 0, bucket_size: int = 5) -> dict:
    try:
        mod = _load_pull_jobs_mod()

        # Get total unmapped count and this bucket's employers (JOIN via NOT EXISTS)
        # Supabase doesn't support NOT EXISTS natively, so we fetch mapped IDs and exclude
        all_emps = (
            sb.table("employers")
            .select("id,name,lca_count")
            .order("lca_count", desc=True)
            .execute()
            .data
        )

        # Build set of already-mapped employer IDs
        mapped_ids: set[int] = set()
        all_ids = [e["id"] for e in all_emps]
        for i in range(0, len(all_ids), 100):
            res = sb.table("employer_ats").select("employer_id").in_("employer_id", all_ids[i:i + 100]).execute()
            mapped_ids.update(r["employer_id"] for r in res.data)

        unmapped = [e for e in all_emps if e["id"] not in mapped_ids]
        total_unmapped = len(unmapped)
        bucket = unmapped[offset: offset + bucket_size]

        if not bucket:
            return {
                "offset": offset,
                "bucket_size": 0,
                "total_unmapped": total_unmapped,
                "has_more": False,
                "results": [],
                "jobs_pulled_this_bucket": 0,
                "not_mapped": [],
            }

        print(f"\n── Bucket {offset // bucket_size + 1} "
              f"(employers #{offset + 1}–{offset + len(bucket)} of {total_unmapped} unmapped) ──")

        now_ts = datetime.now(timezone.utc).isoformat()
        results = []
        confirmed_for_pull: list[dict] = []  # employers confirmed this bucket

        for i, emp in enumerate(bucket):
            print(f"  [{i + 1}/{len(bucket)}] {emp['name']} (lca_count={emp['lca_count']}) …")
            ats_type, slug, job_count = _detect_ats_for_company(emp["name"])

            if ats_type and slug and job_count > 0:
                # QA passed — write mapping with verified_at
                sb.table("employer_ats").upsert(
                    {
                        "employer_id": emp["id"],
                        "ats_type": ats_type,
                        "slug": slug,
                        "verified_at": now_ts,
                    },
                    on_conflict="employer_id,ats_type",
                ).execute()
                confirmed_for_pull.append({"id": emp["id"], "name": emp["name"],
                                            "ats_type": ats_type, "slug": slug})
                print(f"    ✓ {ats_type}:{slug}  ({job_count} jobs on board) — confirmed & queued")
                results.append({
                    "employer": emp["name"],
                    "lca_count": emp["lca_count"],
                    "ats_type": ats_type,
                    "slug": slug,
                    "board_job_count": job_count,
                    "status": "confirmed",
                })
            else:
                # Flag for manual review — write sentinel so we don't retry on every run.
                # 03_pull_jobs.py has no fetcher for "manual_review" so it's safely ignored.
                # To action: find their Workday/iCIMS URL, delete this row, insert the real one.
                sb.table("employer_ats").upsert(
                    {"employer_id": emp["id"], "ats_type": "manual_review", "slug": "manual_review"},
                    on_conflict="employer_id,ats_type",
                ).execute()
                print(f"    ✗ no ATS found → flagged as manual_review")
                results.append({
                    "employer": emp["name"],
                    "lca_count": emp["lca_count"],
                    "ats_type": None,
                    "status": "manual_review",
                })
            time.sleep(0.5)

        # Pull jobs for all confirmed employers in this bucket
        total_jobs_pulled = 0
        if confirmed_for_pull:
            print(f"\n  Pulling jobs for {len(confirmed_for_pull)} confirmed employers…")
            for emp_info in confirmed_for_pull:
                n = _pull_jobs_for_employer(
                    mod, emp_info["id"], emp_info["name"],
                    emp_info["ats_type"], emp_info["slug"],
                )
                total_jobs_pulled += n
                print(f"    {emp_info['ats_type']}:{emp_info['slug']} → {n} jobs")
                time.sleep(1)

        next_offset = offset + len(bucket)
        has_more = next_offset < total_unmapped

        not_mapped = [r for r in results if r["status"] == "manual_review"]
        confirmed = [r for r in results if r["status"] == "confirmed"]

        return {
            "offset": offset,
            "next_offset": next_offset,
            "bucket_size": len(bucket),
            "total_unmapped": total_unmapped,
            "has_more": has_more,
            "confirmed": len(confirmed),
            "confirmed_details": confirmed,
            "not_mapped_this_bucket": len(not_mapped),
            "not_mapped": not_mapped,
            "jobs_pulled_this_bucket": total_jobs_pulled,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


# ── Tool dispatch ─────────────────────────────────────────────────────────────

TOOL_HANDLERS = {
    "validate_xlsx_file": lambda **kw: validate_xlsx_file(**kw),
    "run_lca_enrichment": lambda **kw: run_lca_enrichment(**kw),
    "process_unmapped_bucket": lambda **kw: process_unmapped_bucket(**kw),
}

_PHASE_GATE = ["validate_xlsx_file", "run_lca_enrichment"]


def dispatch_tool(name: str, inputs: dict, phases_done: set) -> dict:
    if name not in TOOL_HANDLERS:
        return {"error": f"Unknown tool: {name}"}
    if name == "process_unmapped_bucket":
        missing = set(_PHASE_GATE) - phases_done
        if missing:
            return {"error": f"Phase gate: must complete {sorted(missing)} before process_unmapped_bucket"}
    elif name == "run_lca_enrichment" and "validate_xlsx_file" not in phases_done:
        return {"error": "Phase gate: must call validate_xlsx_file before run_lca_enrichment"}
    result = TOOL_HANDLERS[name](**inputs)
    phases_done.add(name)
    return result


# ── Claude tool definitions ───────────────────────────────────────────────────

TOOLS = [
    {
        "name": "validate_xlsx_file",
        "description": (
            "Validate the DOL LCA xlsx file. Checks required columns exist, counts certified filings, "
            "returns the filing date range, quarter hint, and whether this quarter is already loaded."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute or relative path to the xlsx file"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "run_lca_enrichment",
        "description": (
            "Load the xlsx and enrich the database. Upserts employers (updates lca_count, lca_by_quarter, "
            "last_filing_date, and POC info for existing; inserts new ones). Replaces only this quarter's "
            "lca_filings rows — prior quarters are preserved."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "xlsx_path": {"type": "string", "description": "Path to the validated xlsx file"},
            },
            "required": ["xlsx_path"],
        },
    },
    {
        "name": "process_unmapped_bucket",
        "description": (
            "Process one bucket of unmapped employers (sorted by lca_count DESC, highest priority first). "
            "For each company: tries Greenhouse → Lever → Ashby → SmartRecruiters and QAs the slug "
            "(must have >0 jobs). Writes confirmed mappings to employer_ats with verified_at. "
            "Then immediately pulls jobs for all confirmed companies in the bucket. "
            "Skips any company that already has an employer_ats row. "
            "Call repeatedly with next_offset from each result until has_more=false."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "offset": {
                    "type": "integer",
                    "description": "Start position in the sorted unmapped employer list. First call: 0. Subsequent: use next_offset from prior result.",
                    "default": 0,
                },
                "bucket_size": {
                    "type": "integer",
                    "description": "Number of employers per bucket. Default 5.",
                    "default": 5,
                },
            },
            "required": [],
        },
    },
]


# ── Report saving ─────────────────────────────────────────────────────────────

def save_report(text: str, xlsx_path: str) -> None:
    reports_dir = os.path.join(DATA_DIR, "intake_reports")
    os.makedirs(reports_dir, exist_ok=True)
    basename = os.path.basename(xlsx_path).replace(".xlsx", "")
    today = date.today().isoformat()
    fname = os.path.join(reports_dir, f"intake_{basename}_{today}.txt")
    with open(fname, "w") as f:
        f.write(text)
    print(f"\nReport saved → {fname}")


# ── Agent loop ────────────────────────────────────────────────────────────────

def run_agent(xlsx_path: str) -> None:
    abs_path = os.path.abspath(xlsx_path)
    print(f"Starting quarterly LCA intake for: {abs_path}\n")

    messages: list[dict] = [
        {
            "role": "user",
            "content": (
                f"Run the quarterly LCA intake for this file: {abs_path}\n\n"
                "Execute each tool in order, then write the full intake report."
            ),
        }
    ]
    phases_done: set[str] = set()

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=8096,
            tools=TOOLS,
            messages=messages,
            system=SYSTEM_PROMPT,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            for block in response.content:
                if hasattr(block, "text"):
                    print("\n" + "=" * 60)
                    print(block.text)
                    save_report(block.text, abs_path)
            break

        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                print(f"\n⚙  {block.name}({json.dumps(block.input)[:100]})")
                result = dispatch_tool(block.name, block.input, phases_done)
                if "error" in result:
                    print(f"   ✗ {result['error']}")
                else:
                    summary = {k: v for k, v in result.items() if k != "traceback"}
                    print(f"   ✓ {json.dumps(summary)[:200]}")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result),
                })

        messages.append({"role": "user", "content": tool_results})


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrapers/00_quarterly_intake.py <path_to_lca.xlsx>")
        sys.exit(1)
    run_agent(sys.argv[1])
