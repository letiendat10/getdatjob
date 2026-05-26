"""
04_enrich_domains.py
For the top N employers (by lca_count), look up their real website domain
via Clearbit Autocomplete (free, no auth) and write a verification sheet
to Google Sheets for human review.

Run after 02_detect_ats.py so ATS slugs are already populated.

OUTPUT columns in sheet tab "domain_verification":
  employer_id | company | lca_count | auto_domain | confidence
  | ats_type | slug | careers_url | verified_domain | domain_ok | careers_ok | notes

WORKFLOW:
  1. python scrapers/04_enrich_domains.py        # generates the sheet
  2. Open sheet, review each row, fill domain_ok / careers_ok columns
  3. python scrapers/06_apply_domains.py         # writes verified domains back to DB
"""

import re
import time
import requests
from difflib import SequenceMatcher
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

SHEET_ID = "1mSp6xPlyG-xRnryofRQ6_xZmXRT_FLfMZrUaKSjwBX8"
TAB_NAME = "domain_verification"
TOP_N = 100
HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 8

ATS_CAREERS_URL = {
    "greenhouse": "https://boards.greenhouse.io/{slug}",
    "lever":      "https://jobs.lever.co/{slug}",
    "ashby":      "https://jobs.ashbyhq.com/{slug}",
}


# ── Name cleaning ─────────────────────────────────────────────────────────────

# "d/b/a Fidelity Investments" → keep the trade name, it's more recognisable
_DBA_RE = re.compile(r"\bd/?b/?a\.?\s+(.+)", re.IGNORECASE)

# Legal suffixes to strip
_SUFFIX_RE = re.compile(
    r",?\s+(incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|"
    r"co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc|llp|associates|group|solutions|"
    r"technologies|technology|services|consulting|us\s+llp|u\.s\.\s+llp)\.?\s*$",
    re.IGNORECASE,
)


def clean_name_for_search(raw: str) -> str:
    """Return the most recognisable form of a legal company name."""
    name = raw.strip()

    # Prefer the trade name after "d/b/a"
    m = _DBA_RE.search(name)
    if m:
        name = m.group(1).strip()

    # Strip trailing legal suffixes (loop — some names have two)
    for _ in range(3):
        stripped = _SUFFIX_RE.sub("", name).strip().rstrip(",").strip()
        if stripped == name:
            break
        name = stripped

    # All-caps → title-case (LCA data often shouts)
    letters = re.sub(r"[^a-zA-Z]", "", name)
    if letters and letters == letters.upper():
        name = name.title()

    # Drop "Amazon.com" → "Amazon"
    name = re.sub(r"\.com\b", "", name, flags=re.IGNORECASE).strip()

    return name


# ── Clearbit lookup ───────────────────────────────────────────────────────────

def clearbit_lookup(raw_name: str) -> tuple[str, float]:
    """
    Returns (domain, confidence_0_to_1).
    confidence is based on name similarity between the top result and our query.
    Returns ("", 0.0) when nothing found.
    """
    query = clean_name_for_search(raw_name)
    try:
        r = requests.get(
            "https://autocomplete.clearbit.com/v1/companies/suggest",
            params={"query": query},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if r.status_code != 200:
            return "", 0.0
        results = r.json()
        if not results:
            return "", 0.0

        best = results[0]
        domain = best.get("domain", "")
        cb_name = best.get("name", "")
        confidence = SequenceMatcher(None, query.lower(), cb_name.lower()).ratio()
        return domain, round(confidence, 2)
    except Exception:
        return "", 0.0


# ── Main ──────────────────────────────────────────────────────────────────────

def build_rows() -> list[dict]:
    # Top N employers
    employers = (
        sb.table("employers")
        .select("id,name,lca_count,domain")
        .order("lca_count", desc=True)
        .limit(TOP_N)
        .execute()
        .data
    )

    # ATS mappings keyed by employer_id
    ats_rows = sb.table("employer_ats").select("employer_id,ats_type,slug").execute().data
    ats_map = {r["employer_id"]: r for r in ats_rows}

    rows = []
    for i, emp in enumerate(employers):
        eid   = emp["id"]
        name  = emp["name"]
        lca   = emp.get("lca_count", 0)
        existing_domain = emp.get("domain") or ""

        ats   = ats_map.get(eid, {})
        ats_type = ats.get("ats_type", "")
        slug     = ats.get("slug", "")
        careers_url = ATS_CAREERS_URL.get(ats_type, "").format(slug=slug) if slug else ""

        # Use existing domain if already set, otherwise call Clearbit
        if existing_domain:
            auto_domain = existing_domain
            confidence  = 1.0
        else:
            auto_domain, confidence = clearbit_lookup(name)
            time.sleep(0.3)   # be polite to Clearbit

        conf_pct = f"{int(confidence * 100)}%"

        print(f"  [{i+1:>3}/{TOP_N}] {name[:45]:<45} → {auto_domain or '(none)':30s}  {conf_pct}")

        rows.append({
            "employer_id":     eid,
            "company":         name,
            "lca_count":       lca,
            "auto_domain":     auto_domain,
            "confidence":      conf_pct,
            "ats_type":        ats_type,
            "slug":            slug,
            "careers_url":     careers_url,
            # Pre-fill verified_domain with auto_domain — reviewer only edits wrong ones
            "verified_domain": auto_domain,
            "domain_ok":       "",
            "careers_ok":      "",
            "notes":           "",
        })

    return rows


COLUMNS = [
    "employer_id", "company", "lca_count", "auto_domain", "confidence",
    "ats_type", "slug", "careers_url", "verified_domain", "domain_ok",
    "careers_ok", "notes",
]


def write_to_sheet(rows: list[dict]) -> None:
    try:
        import gspread
    except ImportError:
        print("\ngspread not installed — run: pip install gspread google-auth-oauthlib")
        print("Falling back to CSV.\n")
        write_csv(rows)
        return

    try:
        gc = gspread.oauth(
            credentials_filename="credentials.json",
            authorized_user_filename="token.json",
        )
    except FileNotFoundError:
        print("\ncredentials.json not found. See 05_verify_slugs.py setup instructions.")
        print("Falling back to CSV.\n")
        write_csv(rows)
        return

    sh = gc.open_by_key(SHEET_ID)

    try:
        ws = sh.worksheet(TAB_NAME)
        ws.clear()
    except gspread.exceptions.WorksheetNotFound:
        ws = sh.add_worksheet(title=TAB_NAME, rows=TOP_N + 10, cols=len(COLUMNS))

    data = [COLUMNS] + [[r[c] for c in COLUMNS] for r in rows]
    ws.update(data, value_input_option="USER_ENTERED")

    # Freeze header + employer_id/company columns
    ws.freeze(rows=1, cols=2)

    # Color header row
    ws.format("A1:L1", {
        "backgroundColor": {"red": 0.27, "green": 0.51, "blue": 0.71},
        "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
    })

    # Highlight rows where confidence < 70% (need extra attention)
    for i, row in enumerate(rows, start=2):
        pct = int(row["confidence"].rstrip("%") or 0)
        if pct < 70:
            ws.format(f"A{i}:L{i}", {
                "backgroundColor": {"red": 1.0, "green": 0.95, "blue": 0.8},
            })

    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={ws.id}"
    print(f"\nSheet written ({len(rows)} rows): {url}")
    print("\nNext steps:")
    print("  1. Open the sheet above")
    print("  2. For each row: verify 'verified_domain', mark domain_ok=TRUE, careers_ok=TRUE")
    print("  3. Rows highlighted yellow = low-confidence match, check carefully")
    print("  4. Run: python scrapers/06_apply_domains.py")


def write_csv(rows: list[dict]) -> None:
    import csv, os
    path = os.path.join(os.path.dirname(__file__), "../data/domain_verification.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"CSV saved to {path}")
    print("Fill in 'verified_domain', set domain_ok=TRUE / careers_ok=TRUE, then run 06_apply_domains.py")


if __name__ == "__main__":
    print(f"Looking up domains for top {TOP_N} employers …\n")
    rows = build_rows()
    write_to_sheet(rows)
