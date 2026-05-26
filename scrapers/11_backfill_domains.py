"""
11_backfill_domains.py

Backfill employers.domain for ALL employers that have no domain set.

Priority order per employer:
  1. ATS slug  — most reliable; encodes the company's own chosen identifier
     • Workday  : extract subdomain from "sub.wdN/portal" slug → sub.com
     • Greenhouse/Lever/Ashby/SmartRecruiters: use slug directly → slug.com
     • Amazon   : hardcoded to amazon.com / aws.amazon.com
  2. Name guesser — fallback for employers with no ATS entry
     • Strip legal suffixes, normalise, append .com

Manual overrides handle the ~15 cases where the slug doesn't equal the real domain
(e.g. Workday "ghr" → bankofamerica.com, Greenhouse "doordashusa" → doordash.com).

Run:
  cd /Users/dat/getdatjob
  python scrapers/11_backfill_domains.py
"""

import re
import sys
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Overrides ─────────────────────────────────────────────────────────────────

# Workday subdomain → real domain  (cases where sub ≠ brand domain)
WORKDAY_SUB_OVERRIDES: dict[str, str] = {
    "wf":              "wellsfargo.com",
    "ghr":             "bankofamerica.com",
    "ms":              "morganstanley.com",
    "amat":            "appliedmaterials.com",
    "fmr":             "fidelity.com",
    "ffive":           "f5.com",
    "ouryahoo":        "yahoo.com",
    "collaborative":   "cognizant.com",
    "generalmotors":   "gm.com",
}

# Greenhouse / Lever / Ashby / SmartRecruiters slug → real domain
SLUG_OVERRIDES: dict[str, str] = {
    "doordashusa":    "doordash.com",
    "archer56":       "adm.com",           # Archer Daniels Midland
    "pmg":            "kpmg.com",
    "hextechnologies":"hexaware.com",
    "hubspotjobs":    "hubspot.com",
    "block":          "block.xyz",
    "akko":           "akkodis.com",
    "instacart":      "instacart.com",     # legal name is Maplebear Inc.
    "tcs":            "tcs.com",
    "sofi":           "sofi.com",
    "vast":           "vastek.com",
    "sage49":         "sageit.in",
    "atos-syntel":    "syntel.com",
    "geico":          "geico.com",
    "lucidmotors":    "lucidmotors.com",
    "point72":        "point72.com",
    "neweratech":     "neweratech.com",
}

# Employer-id → domain  (last resort for truly weird cases)
EMPLOYER_ID_OVERRIDES: dict[int, str] = {
    2:  "amazon.com",   # Amazon.com Services LLC
    11: "aws.amazon.com",  # Amazon Web Services
}

# ── Name-guesser fallback (mirrors companyDomain() in jobs/page.tsx) ──────────

_DBA_RE = re.compile(r"\bd/?b/?a\.?\s+(.+)", re.IGNORECASE)
_SUFFIX_RE = re.compile(
    r",?\s+(incorporated|inc\.?|l\.?l\.?c\.?|corporation|corp\.?|limited|ltd\.?|"
    r"co\.|l\.p\.?|\blp\b|pbc|p\.c\.|pllc|llp|associates|group|solutions|"
    r"technologies|technology|services|consulting|us\s+llp|u\.s\.\s+llp|"
    r"n\.a\.?|\bna\b|plc|s\.a\.|ag|gmbh|se|b\.v\.|nv|s\.p\.a\.)\.?\s*$",
    re.IGNORECASE,
)
_DOMAIN_OVERRIDES: dict[str, str] = {
    "block":          "block.xyz",
    "ciscosystems":   "cisco.com",
    "citibankna":     "citi.com",
}


def clean_name(raw: str) -> str:
    name = raw.strip()
    m = _DBA_RE.search(name)
    if m:
        name = m.group(1).strip()
    for _ in range(4):
        s = _SUFFIX_RE.sub("", name).strip().rstrip(",").strip()
        if s == name:
            break
        name = s
    letters = re.sub(r"[^a-zA-Z]", "", name)
    if letters and letters == letters.upper():
        name = " ".join(
            w if re.match(r"^[A-Z]{1,4}$", w) else w.capitalize()
            for w in name.split()
        )
    name = re.sub(r"\.com\b", "", name, flags=re.IGNORECASE).strip()
    return name


def name_to_domain(raw: str) -> str:
    stem = clean_name(raw).lower().replace(" ", "").replace("-", "").replace(".", "").replace("&", "and")
    stem = re.sub(r"[^a-z0-9]", "", stem)
    return _DOMAIN_OVERRIDES.get(stem, stem + ".com")


# ── ATS → domain ──────────────────────────────────────────────────────────────

def workday_domain(slug: str) -> str:
    """'cisco.wd5/Cisco_Careers' → 'cisco.com'"""
    sub = slug.split(".wd")[0].lower()
    return WORKDAY_SUB_OVERRIDES.get(sub, sub + ".com")


def slug_domain(slug: str) -> str:
    """'doordashusa' → 'doordash.com'"""
    key = slug.lower()
    if key in SLUG_OVERRIDES:
        return SLUG_OVERRIDES[key]
    return key + ".com"


def domain_for_employer(emp: dict, ats) -> str:
    eid = emp["id"]
    if eid in EMPLOYER_ID_OVERRIDES:
        return EMPLOYER_ID_OVERRIDES[eid]

    if ats:
        t    = ats.get("ats_type", "")
        slug = (ats.get("slug") or "").strip()
        if t == "workday" and slug:
            return workday_domain(slug)
        if t in ("greenhouse", "lever", "ashby", "smartrecruiters", "icims") and slug:
            return slug_domain(slug)

    return name_to_domain(emp["name"])


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Fetching employers with no domain …")
    employers = (
        sb.table("employers")
        .select("id,name")
        .is_("domain", "null")
        .execute()
        .data
    )
    print(f"  {len(employers)} employers\n")

    print("Fetching ATS mappings …")
    ats_rows = sb.table("employer_ats").select("employer_id,ats_type,slug").execute().data
    ats_map: dict[int, dict] = {r["employer_id"]: r for r in ats_rows}

    updates: list[dict] = []
    for emp in employers:
        eid    = emp["id"]
        domain = domain_for_employer(emp, ats_map.get(eid))
        if domain:
            updates.append({"id": eid, "name": emp["name"], "domain": domain})

    # Print preview
    print(f"{'ID':>6}  {'Domain':30s}  Company")
    print("-" * 80)
    for u in updates:
        print(f"  {u['id']:>4}  {u['domain']:30s}  {u['name'][:45]}")

    print(f"\n{len(updates)} rows to update.")
    answer = input("Apply to database? [y/N] ").strip().lower()
    if answer != "y":
        print("Aborted.")
        sys.exit(0)

    print("\nApplying …")
    ok = 0
    for u in updates:
        sb.table("employers").update({"domain": u["domain"]}).eq("id", u["id"]).execute()
        ok += 1
        if ok % 50 == 0:
            print(f"  {ok}/{len(updates)} …")

    print(f"\nDone. {ok} domains written.")


if __name__ == "__main__":
    main()
