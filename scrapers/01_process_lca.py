"""
01_process_lca.py
Reads DOL LCA xlsx → writes all employers + all their filings to Supabase.
Run once per quarter when DOL publishes new data.
"""

import re
import pandas as pd
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY, LCA_FILE
from title_utils import clean_title
from domain_resolve import resolve_company_domain

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

COLS = {
    "EMPLOYER_NAME":            "employer_name",
    "EMPLOYER_FEIN":            "fein",
    "EMPLOYER_CITY":            "employer_city",
    "EMPLOYER_STATE":           "employer_state",
    "JOB_TITLE":                "job_title",
    "SOC_CODE":                 "soc_code",
    "WAGE_RATE_OF_PAY_FROM":    "wage_offered",
    "PW_WAGE_LEVEL":            "wage_level",
    "WORKSITE_CITY":            "city",
    "WORKSITE_STATE":           "state",
    "RECEIVED_DATE":            "received_date",
    "VISA_CLASS":               "visa_class",
    "CASE_STATUS":              "case_status",
    "EMPLOYER_POC_FIRST_NAME":  "poc_first_name",
    "EMPLOYER_POC_LAST_NAME":   "poc_last_name",
    "EMPLOYER_POC_JOB_TITLE":   "poc_job_title",
    "EMPLOYER_POC_EMAIL":       "poc_email",
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
    df["received_date"] = pd.to_datetime(df["received_date"], errors="coerce").dt.date
    df["wage_offered"] = pd.to_numeric(df["wage_offered"], errors="coerce")
    print(f"  {len(df):,} certified filings loaded")
    return df

# Brand-domain resolution (law-firm/vendor detection + curated fixes) lives in
# domain_resolve.resolve_company_domain — the single source shared with 00_quarterly_intake.


def upsert_employers(df: pd.DataFrame) -> dict[str, int]:
    """Insert all employers, return {name_clean: id}."""
    counts = (
        df.groupby(["employer_name", "name_clean", "fein"])
        .size()
        .reset_index(name="lca_count")
        .sort_values("lca_count", ascending=False)
        .drop_duplicates("name_clean")
    )

    # All visa types per employer as a list
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
    df_2025 = df[df["received_date"].apply(lambda d: d.year if pd.notna(d) else 0) == 2025]
    count_2025 = (
        df_2025.groupby("name_clean")
        .size()
        .reset_index(name="lca_count_2025")
    )
    e3_counts = (
        df[df["visa_class"].str.upper().str.startswith("E-3", na=False)]
        .groupby("name_clean").size().reset_index(name="e3_lca_count")
    )
    tn_counts = (
        df[df["visa_class"].str.upper().str.startswith("TN", na=False)]
        .groupby("name_clean").size().reset_index(name="tn_lca_count")
    )
    counts = (
        counts
        .merge(top_visa, on="name_clean", how="left")
        .merge(last_filing, on="name_clean")
        .merge(count_2025, on="name_clean", how="left")
        .merge(e3_counts, on="name_clean", how="left")
        .merge(tn_counts, on="name_clean", how="left")
    )
    counts["lca_count_2025"] = counts["lca_count_2025"].fillna(0).astype(int)
    counts["e3_lca_count"] = counts["e3_lca_count"].fillna(0).astype(int)
    counts["tn_lca_count"] = counts["tn_lca_count"].fillna(0).astype(int)

    # POC: for each employer, pick the filing with the latest received_date that has a non-null email.
    # Domain is derived from that email (everything after @).
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
    poc_df = df[df["poc_email"].notna() & (df["poc_email"].str.strip() != "")].copy()
    poc_latest = (
        poc_df
        .sort_values("received_date", ascending=False)
        .drop_duplicates("name_clean")
        [["name_clean", "poc_first_name", "poc_last_name", "poc_job_title", "poc_email"]]
    )
    _resolved = poc_latest.apply(
        lambda r: resolve_company_domain(r["poc_email"], r["name_clean"]), axis=1
    )
    poc_latest["company_domain_url"] = _resolved.map(lambda t: t[0])
    _flagged = poc_latest.loc[_resolved.map(lambda t: t[1]), ["name_clean", "poc_email", "company_domain_url"]]
    if len(_flagged):
        print(f"\n⚠ {len(_flagged)} POC domains look like a law firm / vendor — review company_domain_url (yes/no):")
        for _, _fr in _flagged.iterrows():
            print(f"    {_fr['name_clean']}  poc={_fr['poc_email']}  → proposed {_fr['company_domain_url']}")
    counts = (
        counts
        .merge(employer_city_df, on="name_clean", how="left")
        .merge(employer_state_df, on="name_clean", how="left")
        .merge(poc_latest, on="name_clean", how="left")
    )

    rows = []
    for _, r in counts.iterrows():
        rows.append({
            "name":             r["employer_name"],
            "name_clean":       r["name_clean"],
            "fein":             r["fein"]             if pd.notna(r["fein"])             else None,
            "employer_city":    r["employer_city"]   if pd.notna(r.get("employer_city")) else None,
            "employer_state":   r["employer_state"]  if pd.notna(r.get("employer_state")) else None,
            "lca_count":        int(r["lca_count"]),
            "lca_count_2025":   int(r["lca_count_2025"]),
            "e3_lca_count":     int(r["e3_lca_count"]),
            "tn_lca_count":     int(r["tn_lca_count"]),
            "visa_types":       r["visa_types"] if r.get("visa_types") else None,
            "last_filing_date": str(r["last_filing_date"]) if pd.notna(r["last_filing_date"]) else None,
            "poc_first_name":   r["poc_first_name"]  if pd.notna(r.get("poc_first_name")) else None,
            "poc_last_name":    r["poc_last_name"]   if pd.notna(r.get("poc_last_name"))  else None,
            "poc_job_title":    r["poc_job_title"]   if pd.notna(r.get("poc_job_title"))  else None,
            "poc_email":        r["poc_email"]       if pd.notna(r.get("poc_email"))      else None,
            "company_domain_url": r["company_domain_url"] if pd.notna(r.get("company_domain_url")) else None,
        })

    print(f"Inserting {len(rows)} employers (full refresh) …")
    # Full refresh — truncate all dependent tables in one server-side call (avoids REST timeout)
    sb.rpc("truncate_lca_data", {}).execute()

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
            "job_title_clean": clean_title(r["job_title"]) if pd.notna(r["job_title"]) else None,
            "soc_code": r["soc_code"] if pd.notna(r["soc_code"]) else None,
            "wage_offered": float(r["wage_offered"]) if pd.notna(r["wage_offered"]) else None,
            "wage_level": r["wage_level"] if pd.notna(r["wage_level"]) else None,
            "city": r["city"] if pd.notna(r["city"]) else None,
            "state": r["state"] if pd.notna(r["state"]) else None,
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
