"""
06_apply_domains.py
Reads the "domain_verification" tab from Google Sheets (written by 04_enrich_domains.py),
and updates employers.domain in Supabase for every row where domain_ok is truthy.

Run after you've reviewed and marked rows in the sheet.
"""

import sys
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

SHEET_ID = "1mSp6xPlyG-xRnryofRQ6_xZmXRT_FLfMZrUaKSjwBX8"
TAB_NAME = "domain_verification"

CSV_FALLBACK = "data/domain_verification.csv"

TRUTHY = {"true", "yes", "✓", "ok", "1", "x"}


def is_ok(val: str) -> bool:
    return str(val).strip().lower() in TRUTHY


def load_from_sheet() -> list[dict]:
    try:
        import gspread
    except ImportError:
        print("gspread not installed — falling back to CSV.")
        return load_from_csv()

    try:
        gc = gspread.oauth(
            credentials_filename="credentials.json",
            authorized_user_filename="token.json",
        )
    except FileNotFoundError:
        print("credentials.json not found — falling back to CSV.")
        return load_from_csv()

    sh = gc.open_by_key(SHEET_ID)
    ws = sh.worksheet(TAB_NAME)
    records = ws.get_all_records()
    return records


def load_from_csv() -> list[dict]:
    import csv, os
    path = os.path.join(os.path.dirname(__file__), "..", CSV_FALLBACK)
    if not os.path.exists(path):
        print(f"CSV not found at {path}. Run 04_enrich_domains.py first.")
        sys.exit(1)
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def apply(records: list[dict]) -> None:
    approved = [r for r in records if is_ok(r.get("domain_ok", "")) and r.get("verified_domain", "").strip()]

    if not approved:
        print("No rows with domain_ok=TRUE found. Nothing to apply.")
        return

    print(f"Applying {len(approved)} verified domains …\n")
    updated = 0
    skipped = 0

    for r in approved:
        eid    = int(r["employer_id"])
        domain = r["verified_domain"].strip().lower()

        # Sanity check: must look like a domain (contains a dot, no spaces)
        if "." not in domain or " " in domain:
            print(f"  SKIP  id={eid}  bad domain value: '{domain}'")
            skipped += 1
            continue

        sb.table("employers").update({"domain": domain}).eq("id", eid).execute()
        print(f"  ✓  id={eid:>5}  {r['company'][:40]:<40}  →  {domain}")
        updated += 1

    print(f"\nDone. {updated} updated, {skipped} skipped.")

    # Report rows that were NOT approved so reviewer knows what's left
    pending = [r for r in records if not is_ok(r.get("domain_ok", ""))]
    if pending:
        print(f"\n{len(pending)} rows still pending review:")
        for r in pending[:10]:
            print(f"  • {r['company'][:45]}")
        if len(pending) > 10:
            print(f"  … and {len(pending) - 10} more")


if __name__ == "__main__":
    print(f"Loading from sheet '{TAB_NAME}' …\n")
    records = load_from_sheet()
    print(f"  {len(records)} rows loaded\n")
    apply(records)
