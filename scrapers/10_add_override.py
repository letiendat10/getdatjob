"""
10_add_override.py
Manually register a known (FEIN, ATS type, slug) mapping.
Use this for companies where auto-detection fails or finds the wrong slug
(e.g. Block → greenhouse/block, SoFi → greenhouse/sofi-technologies).

Usage:
  python3 10_add_override.py --name "Block, Inc." --ats greenhouse --slug block
  python3 10_add_override.py --name "SoFi" --ats greenhouse --slug sofi-technologies
  python3 10_add_override.py --list

The script looks up the FEIN from the employers table by name, so the
exact company name is not required — it fuzzy-matches and confirms with you.
"""

import argparse
import difflib
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def find_employer(name_query: str) -> dict | None:
    employers = sb.table("employers").select("id,name,fein").execute().data
    matches = difflib.get_close_matches(
        name_query.lower(),
        [e["name"].lower() for e in employers],
        n=5, cutoff=0.4,
    )
    if not matches:
        print(f"No employer found matching '{name_query}'")
        return None

    # Map back to original rows
    match_set = set(matches)
    candidates = [e for e in employers if e["name"].lower() in match_set]

    if len(candidates) == 1:
        return candidates[0]

    print("Multiple matches found:")
    for i, c in enumerate(candidates):
        print(f"  [{i}] {c['name']}  (FEIN: {c['fein']})")
    choice = input("Select number: ").strip()
    try:
        return candidates[int(choice)]
    except (ValueError, IndexError):
        print("Invalid choice.")
        return None


def add_override(employer: dict, ats_type: str, slug: str, notes: str = "") -> None:
    fein = employer.get("fein")
    if not fein:
        print(f"Employer '{employer['name']}' has no FEIN on record — cannot add override.")
        return

    row = {"fein": fein, "ats_type": ats_type, "slug": slug, "notes": notes}
    sb.table("employer_slug_overrides").upsert(row, on_conflict="fein,ats_type").execute()

    # Also upsert into employer_ats immediately
    ats_row = {
        "employer_id": employer["id"],
        "ats_type": ats_type,
        "slug": slug,
        "ats_company_name": None,
        "name_match_score": None,
        "needs_review": False,
    }
    sb.table("employer_ats").upsert(ats_row, on_conflict="employer_id,ats_type").execute()

    print(f"✓ Override saved: {employer['name']} (FEIN {fein}) → {ats_type}:{slug}")
    print(f"  employer_ats also updated for employer_id={employer['id']}")


def list_overrides() -> None:
    rows = (
        sb.table("employer_slug_overrides")
        .select("fein,ats_type,slug,notes,created_at")
        .order("created_at", desc=True)
        .execute()
        .data
    )
    if not rows:
        print("No overrides on record.")
        return
    print(f"{'FEIN':<15} {'ATS':<15} {'Slug':<35} Notes")
    print("-" * 80)
    for r in rows:
        print(f"{r['fein']:<15} {r['ats_type']:<15} {r['slug']:<35} {r['notes'] or ''}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Add or list ATS slug overrides.")
    parser.add_argument("--name", help="Company name (fuzzy-matched against employers table)")
    parser.add_argument("--ats", help="ATS type, e.g. greenhouse, lever, workday")
    parser.add_argument("--slug", help="ATS slug, e.g. block, sofi-technologies")
    parser.add_argument("--notes", default="", help="Optional notes (e.g. 'formerly Square')")
    parser.add_argument("--list", action="store_true", help="List all current overrides")
    args = parser.parse_args()

    if args.list:
        list_overrides()
    elif args.name and args.ats and args.slug:
        employer = find_employer(args.name)
        if employer:
            print(f"Matched: {employer['name']}  (FEIN: {employer['fein']}, id: {employer['id']})")
            confirm = input(f"Add override {args.ats}:{args.slug}? [y/N] ").strip().lower()
            if confirm == "y":
                add_override(employer, args.ats, args.slug, args.notes)
    else:
        parser.print_help()
