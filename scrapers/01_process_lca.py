"""
01_process_lca.py
Reads DOL LCA xlsx → writes top N employers + all their filings to Supabase.
Run once per quarter when DOL publishes new data.
"""

import re
import pandas as pd
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY, LCA_FILE, TOP_N_EMPLOYERS
from title_utils import clean_title

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

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
    "RECEIVED_DATE": "received_date",
    "VISA_CLASS": "visa_class",
    "CASE_STATUS": "case_status",
}

def clean_name(name: str) -> str:
    if not name:
        return ""
    return re.sub(r"\s+", " ", str(name).lower().strip())

def load_lca(path: str) -> pd.DataFrame:
    print(f"Loading {path} …")
    df = pd.read_excel(path, usecols=list(COLS.keys()), dtype=str)
    df.rename(columns=COLS, inplace=True)
    df = df[df["case_status"].str.upper() == "CERTIFIED"]
    df["employer_name"] = df["employer_name"].str.strip()
    df["name_clean"] = df["employer_name"].apply(clean_name)
    df["filing_date"] = pd.to_datetime(df["filing_date"], errors="coerce").dt.date
    df["received_date"] = pd.to_datetime(df["received_date"], errors="coerce").dt.date
    df["wage_offered"] = pd.to_numeric(df["wage_offered"], errors="coerce")
    print(f"  {len(df):,} certified filings loaded")
    return df

def upsert_employers(df: pd.DataFrame) -> dict[str, int]:
    """Insert top N employers, return {name_clean: id}."""
    counts = (
        df.groupby(["employer_name", "name_clean", "fein"])
        .size()
        .reset_index(name="lca_count")
        .sort_values("lca_count", ascending=False)
        .drop_duplicates("name_clean")
        .head(TOP_N_EMPLOYERS)
    )

    # Most common visa class per employer
    top_visa = (
        df.groupby("name_clean")["visa_class"]
        .agg(lambda s: s.value_counts().index[0] if len(s) else None)
        .reset_index()
        .rename(columns={"visa_class": "top_visa_class"})
    )
    last_filing = (
        df.groupby("name_clean")["received_date"]
        .max()
        .reset_index()
        .rename(columns={"received_date": "last_filing_date"})
    )
    df_2025 = df[df["received_date"].apply(lambda d: d.year if pd.notna(d) else 0) == 2025]
    count_2025 = (
        df_2025.groupby("name_clean")
        .size()
        .reset_index(name="lca_count_2025")
    )
    counts = (
        counts
        .merge(top_visa, on="name_clean")
        .merge(last_filing, on="name_clean")
        .merge(count_2025, on="name_clean", how="left")
    )
    counts["lca_count_2025"] = counts["lca_count_2025"].fillna(0).astype(int)

    rows = []
    for _, r in counts.iterrows():
        rows.append({
            "name": r["employer_name"],
            "name_clean": r["name_clean"],
            "fein": r["fein"] if pd.notna(r["fein"]) else None,
            "lca_count": int(r["lca_count"]),
            "lca_count_2025": int(r["lca_count_2025"]),
            "top_visa_class": r["top_visa_class"],
            "last_filing_date": str(r["last_filing_date"]) if pd.notna(r["last_filing_date"]) else None,
        })

    print(f"Inserting {len(rows)} employers (full refresh) …")
    # Full refresh — delete all dependent data first, then employers
    sb.table("job_signals").delete().neq("id", 0).execute()
    sb.table("jobs").delete().neq("id", 0).execute()
    sb.table("lca_filings").delete().neq("id", 0).execute()
    sb.table("employer_ats").delete().neq("id", 0).execute()
    sb.table("employers").delete().neq("id", 0).execute()

    for i in range(0, len(rows), 100):
        sb.table("employers").insert(rows[i:i+100]).execute()

    # Fetch back IDs
    result = sb.table("employers").select("id,name_clean").execute()
    return {r["name_clean"]: r["id"] for r in result.data}

def upsert_filings(df: pd.DataFrame, employer_ids: dict[str, int]):
    top_names = set(employer_ids.keys())
    subset = df[df["name_clean"].isin(top_names)].copy()
    subset["employer_id"] = subset["name_clean"].map(employer_ids)

    rows = []
    for _, r in subset.iterrows():
        rows.append({
            "employer_id": int(r["employer_id"]),
            "job_title": r["job_title"],
            "title_clean": clean_title(r["job_title"]) if pd.notna(r["job_title"]) else None,
            "soc_code": r["soc_code"] if pd.notna(r["soc_code"]) else None,
            "wage_offered": float(r["wage_offered"]) if pd.notna(r["wage_offered"]) else None,
            "wage_level": r["wage_level"] if pd.notna(r["wage_level"]) else None,
            "city": r["city"] if pd.notna(r["city"]) else None,
            "state": r["state"] if pd.notna(r["state"]) else None,
            "filing_date": str(r["filing_date"]) if pd.notna(r["filing_date"]) else None,
            "received_date": str(r["received_date"]) if pd.notna(r["received_date"]) else None,
            "visa_class": r["visa_class"] if pd.notna(r["visa_class"]) else None,
            "case_status": r["case_status"] if pd.notna(r["case_status"]) else None,
        })

    print(f"Inserting {len(rows):,} LCA filings …")
    # Wipe existing and reinsert (full quarterly refresh)
    emp_ids = list(employer_ids.values())
    for i in range(0, len(emp_ids), 50):
        sb.table("lca_filings").delete().in_("employer_id", emp_ids[i:i+50]).execute()

    for i in range(0, len(rows), 500):
        sb.table("lca_filings").insert(rows[i:i+500]).execute()
        print(f"  inserted {min(i+500, len(rows)):,}/{len(rows):,}")

if __name__ == "__main__":
    df = load_lca(LCA_FILE)
    employer_ids = upsert_employers(df)
    upsert_filings(df, employer_ids)
    print("Done.")
