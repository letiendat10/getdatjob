#!/usr/bin/env python3
"""
00_quarterly_intake.py
Quarterly LCA data intake — loads filings and updates employer records only.
ATS detection and job pulling are handled separately.

Usage:
    python3 scrapers/00_quarterly_intake.py data/raw/LCA_Dislclosure_Data_FY2026_Q1.xlsx

What it does:
  1. Validates the xlsx file (correct DOL columns, date range, already-loaded check)
  2. Upserts employers from the file:
       - New employers (not yet in DB): inserted with all fields
       - Existing employers: POC first/last name, job title, email, and domain are
         updated ONLY if this file's data is more recent than what is already stored
         (prevents an older quarter from overwriting a newer quarter's POC)
  3. Replaces lca_filings for this file's RECEIVED_DATE window — prior quarters untouched
       (safe to re-run: delete-then-insert on the same date range is idempotent)
  4. Calls recompute_lca_counts() in Supabase, which sets lca_fy2026_q1, lca_fy2026_q2,
     lca_fy2025_q1–q4, lca_fy2024_q1–q4, lca_fy2026/2025/2024, lca_count, lca_count_2025
     for every employer using RECEIVED_DATE ranges — never the filename
  5. Prints a summary report and saves it to data/intake_reports/
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timezone

import anthropic
import pandas as pd
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
    "EMPLOYER_NAME", "EMPLOYER_FEIN", "EMPLOYER_CITY", "EMPLOYER_STATE",
    "JOB_TITLE", "SOC_CODE",
    "WAGE_RATE_OF_PAY_FROM", "PW_WAGE_LEVEL", "WORKSITE_CITY", "WORKSITE_STATE",
    "BEGIN_DATE", "RECEIVED_DATE", "VISA_CLASS", "CASE_STATUS",
    "EMPLOYER_POC_FIRST_NAME", "EMPLOYER_POC_LAST_NAME",
    "EMPLOYER_POC_JOB_TITLE", "EMPLOYER_POC_EMAIL",
]

COLS = {
    "EMPLOYER_NAME":           "employer_name",
    "EMPLOYER_FEIN":           "fein",
    "EMPLOYER_CITY":           "employer_city",
    "EMPLOYER_STATE":          "employer_state",
    "JOB_TITLE":               "job_title",
    "SOC_CODE":                "soc_code",
    "WAGE_RATE_OF_PAY_FROM":   "wage_offered",
    "PW_WAGE_LEVEL":           "wage_level",
    "WORKSITE_CITY":           "city",
    "WORKSITE_STATE":          "state",
    "RECEIVED_DATE":           "received_date",
    "VISA_CLASS":              "visa_class",
    "CASE_STATUS":             "case_status",
    "EMPLOYER_POC_FIRST_NAME": "poc_first_name",
    "EMPLOYER_POC_LAST_NAME":  "poc_last_name",
    "EMPLOYER_POC_JOB_TITLE":  "poc_job_title",
    "EMPLOYER_POC_EMAIL":      "poc_email",
}

SYSTEM_PROMPT = """\
You are the getdatjob quarterly LCA intake agent.

Goal: load a DOL LCA xlsx file into the database cleanly and report what changed.

Step-by-step:
1. validate_xlsx_file — confirm the file is valid and check if already loaded
2. run_lca_enrichment — upsert employers and replace this quarter's filings
3. Write a concise summary report: new employers added, existing updated, filings inserted,
   total filings now in DB, and which quarter columns were recomputed.

Rules:
- Only call run_lca_enrichment if validate_xlsx_file succeeded (no missing columns, no error).
- If already_loaded is true, still run run_lca_enrichment — it is idempotent.
- Never call any tool not listed here.
"""


# ── Utility ───────────────────────────────────────────────────────────────────

def clean_name(name: str) -> str:
    if not name:
        return ""
    return re.sub(r"\s+", " ", str(name).lower().strip())


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

        print("  Reading received_date range …")
        df_dates = pd.read_excel(path, usecols=["RECEIVED_DATE", "CASE_STATUS"], dtype=str)
        df_dates = df_dates[df_dates["CASE_STATUS"].str.upper() == "CERTIFIED"].copy()
        df_dates["RECEIVED_DATE"] = pd.to_datetime(df_dates["RECEIVED_DATE"], errors="coerce")
        rcvd_min = df_dates["RECEIVED_DATE"].min()
        rcvd_max = df_dates["RECEIVED_DATE"].max()
        d_min = str(rcvd_min.date()) if pd.notna(rcvd_min) else None
        d_max = str(rcvd_max.date()) if pd.notna(rcvd_max) else None

        existing_count = 0
        already_loaded = False
        if d_min and d_max:
            res = (
                sb.table("lca_filings")
                .select("id", count="exact")
                .gte("received_date", d_min)
                .lte("received_date", d_max)
                .execute()
            )
            existing_count = res.count or 0
            already_loaded = existing_count > 0

        return {
            "path": path,
            "row_count": row_count,
            "certified_count": certified,
            "columns_missing": missing,
            "received_date_range": {"min": d_min, "max": d_max},
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
        df["received_date"] = pd.to_datetime(df["received_date"], format="%m/%d/%Y", errors="coerce").dt.date
        df["wage_offered"] = pd.to_numeric(df["wage_offered"], errors="coerce")

        # Use RECEIVED_DATE (not filename) for all quarter attribution
        rcvd_min = df["received_date"].dropna().min()
        rcvd_max = df["received_date"].dropna().max()

        # Per-employer metadata — all employers, no top-N cutoff
        counts = (
            df.groupby(["employer_name", "name_clean", "fein"])
            .size()
            .reset_index(name="q_count")
            .sort_values("q_count", ascending=False)
            .drop_duplicates("name_clean")
        )
        top_visa = (
            df.groupby("name_clean")["visa_class"]
            .agg(lambda s: sorted(s.dropna().unique().tolist()))
            .reset_index()
            .rename(columns={"visa_class": "visa_types"})
        )
        last_filing = (
            df.groupby("name_clean")["received_date"]
            .max()
            .reset_index()
            .rename(columns={"received_date": "last_filing_date"})
        )
        # Employer HQ city/state: most common value across their filings
        def _mode_or_none(s):
            vals = s.dropna()
            return vals.mode().iloc[0] if len(vals) > 0 else None

        employer_city_df = (
            df.groupby("name_clean")["employer_city"]
            .agg(_mode_or_none)
            .reset_index()
        )
        employer_state_df = (
            df.groupby("name_clean")["employer_state"]
            .agg(_mode_or_none)
            .reset_index()
        )
        # POC: latest by received_date, must have email
        poc_df = (
            df[df["poc_email"].notna() & (df["poc_email"].str.strip() != "")]
            .sort_values("received_date", ascending=False)
            .groupby("name_clean")[["poc_first_name", "poc_last_name", "poc_job_title", "poc_email"]]
            .first()
            .reset_index()
        )
        poc_df["company_domain_url"] = (
            poc_df["poc_email"].str.lower().str.strip()
            .apply(lambda e: e.split("@", 1)[1] if "@" in e else None)
        )
        counts = (
            counts
            .merge(top_visa, on="name_clean")
            .merge(last_filing, on="name_clean")
            .merge(employer_city_df, on="name_clean", how="left")
            .merge(employer_state_df, on="name_clean", how="left")
            .merge(poc_df, on="name_clean", how="left")
        )

        # Fetch existing employers (with last_filing_date for recency check)
        existing_result = sb.table("employers").select("id,name_clean,last_filing_date").execute()
        existing_by_name = {e["name_clean"]: e for e in existing_result.data}

        new_count = updated_count = 0
        print(f"  Upserting {len(counts):,} employers …")
        for _, r in counts.iterrows():
            nc = r["name_clean"]
            new_last = str(r["last_filing_date"]) if pd.notna(r["last_filing_date"]) else None
            meta = {
                "visa_types":       r["visa_types"] if r.get("visa_types") else None,
                "last_filing_date": new_last,
                "employer_city":    r["employer_city"]   if pd.notna(r.get("employer_city"))   else None,
                "employer_state":   r["employer_state"]  if pd.notna(r.get("employer_state"))  else None,
                "poc_first_name":   r["poc_first_name"]  if pd.notna(r.get("poc_first_name"))  else None,
                "poc_last_name":    r["poc_last_name"]   if pd.notna(r.get("poc_last_name"))   else None,
                "poc_job_title":    r["poc_job_title"]   if pd.notna(r.get("poc_job_title"))   else None,
                "poc_email":        r["poc_email"]       if pd.notna(r.get("poc_email"))       else None,
                "company_domain_url": r["company_domain_url"] if pd.notna(r.get("company_domain_url")) else None,
            }
            if nc in existing_by_name:
                existing_last = existing_by_name[nc].get("last_filing_date")
                # Only overwrite POC + metadata if this file is the most recent source.
                # Guards against an older quarter (e.g. Q1) clobbering a newer quarter's (Q2) POC.
                if new_last and (not existing_last or new_last >= existing_last):
                    sb.table("employers").update(meta).eq("name_clean", nc).execute()
                updated_count += 1
            else:
                sb.table("employers").insert({
                    "name":       r["employer_name"],
                    "name_clean": nc,
                    "fein":       r["fein"] if pd.notna(r["fein"]) else None,
                    **meta,
                }).execute()
                new_count += 1

        # Fetch full employer ID map
        id_result = sb.table("employers").select("id,name_clean").execute()
        employer_ids = {r["name_clean"]: r["id"] for r in id_result.data}

        # Replace filings for this file's received_date range (idempotent re-run)
        print(f"  Replacing lca_filings for received_date {rcvd_min} → {rcvd_max} …")
        sb.table("lca_filings").delete().gte("received_date", str(rcvd_min)).lte("received_date", str(rcvd_max)).execute()

        # Insert all filings (all employers, no cutoff), including received_date
        subset = df[df["name_clean"].isin(set(employer_ids.keys()))].copy()
        subset["employer_id"] = subset["name_clean"].map(employer_ids)
        filing_rows = [
            {
                "employer_id":    int(r["employer_id"]),
                "job_title":      r["job_title"]    if pd.notna(r["job_title"])    else None,
                "job_title_clean": clean_title(r["job_title"]) if pd.notna(r["job_title"]) else None,
                "soc_code":       r["soc_code"]     if pd.notna(r["soc_code"])     else None,
                "wage_offered":   float(r["wage_offered"]) if pd.notna(r["wage_offered"]) else None,
                "wage_level":     r["wage_level"]   if pd.notna(r["wage_level"])   else None,
                "city":           r["city"]         if pd.notna(r["city"])         else None,
                "state":          r["state"]        if pd.notna(r["state"])        else None,
                "received_date":  str(r["received_date"])  if pd.notna(r["received_date"])  else None,
                "visa_class":     r["visa_class"]   if pd.notna(r["visa_class"])   else None,
                "case_status":    r["case_status"]  if pd.notna(r["case_status"])  else None,
            }
            for _, r in subset.iterrows()
        ]
        print(f"  Inserting {len(filing_rows):,} lca_filings …")
        for i in range(0, len(filing_rows), 500):
            sb.table("lca_filings").insert(filing_rows[i:i + 500]).execute()
            print(f"    {min(i + 500, len(filing_rows)):,}/{len(filing_rows):,}")

        # Recompute all lca_count / lca_fy* columns from lca_filings using RECEIVED_DATE
        # (SQL owns count logic — never computed manually in Python)
        print("  Recomputing lca counts from received_date …")
        sb.rpc("recompute_lca_counts", {}).execute()

        total_res = sb.table("lca_filings").select("id", count="exact").execute()
        total_in_db = total_res.count or len(filing_rows)
        visa_breakdown = df["visa_class"].value_counts().to_dict()

        return {
            "employers_new":       new_count,
            "employers_updated":   updated_count,
            "filings_inserted":    len(filing_rows),
            "filings_in_db_total": total_in_db,
            "received_date_range": {"min": str(rcvd_min), "max": str(rcvd_max)},
            "visa_breakdown":      {k: int(v) for k, v in visa_breakdown.items()},
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


# ── Tool dispatch ─────────────────────────────────────────────────────────────

TOOL_HANDLERS = {
    "validate_xlsx_file": lambda **kw: validate_xlsx_file(**kw),
    "run_lca_enrichment": lambda **kw: run_lca_enrichment(**kw),
}


def dispatch_tool(name: str, inputs: dict, phases_done: set) -> dict:
    if name not in TOOL_HANDLERS:
        return {"error": f"Unknown tool: {name}"}
    if name == "run_lca_enrichment" and "validate_xlsx_file" not in phases_done:
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
            "Load the xlsx and enrich the database. Upserts ALL employers (no top-N cutoff). "
            "For existing employers: updates visa_types, last_filing_date, POC fields, and domain. "
            "For new employers: inserts them. "
            "Replaces lca_filings for this file's RECEIVED_DATE range (prior quarters preserved). "
            "After insert, calls recompute_lca_counts() which uses RECEIVED_DATE to populate "
            "lca_fy2026_q1/q2, lca_fy2025_q1–q4, lca_fy2024_q1–q4, lca_fy2026/2025/2024, "
            "lca_count, and lca_count_2025 — never the filename."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "xlsx_path": {"type": "string", "description": "Path to the validated xlsx file"},
            },
            "required": ["xlsx_path"],
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
