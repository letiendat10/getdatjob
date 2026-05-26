"""
Enrich greenhouse_companies.csv with a domain column, then upsert matches
into employer_ats (ats_type=greenhouse).

Domain source: Greenhouse jobs API absolute_url (works when company uses a
custom careers page, e.g. stripe.com/jobs/...). Falls back to empty string.

Employer matching: name-based ilike on employers.name_clean since employer
domains are mostly unpopulated. Once employer.domain is filled in, the CSV
domain column can be used for a clean join.
"""

import csv
import re
import time
import urllib.parse
from pathlib import Path
from typing import Optional

import requests
from supabase import create_client

import sys
sys.path.insert(0, str(Path(__file__).parent))
from config import SUPABASE_URL, SUPABASE_KEY, DATA_DIR

CSV_PATH = Path(DATA_DIR) / "greenhouse_companies.csv"
GH_JOBS  = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false"
GH_HOSTS = {"boards.greenhouse.io", "job-boards.greenhouse.io"}

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "getdatjob-research/1.0"
sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def domain_from_slug(slug: str) -> str:
    """Extract company domain from a job's absolute_url. Returns '' if not found."""
    try:
        r = SESSION.get(GH_JOBS.format(slug=slug), timeout=10)
        if not r.ok:
            return ""
        for job in r.json().get("jobs", [])[:5]:
            host = urllib.parse.urlparse(job.get("absolute_url", "")).netloc.lower()
            host = host.lstrip("www.")
            if host and host not in GH_HOSTS:
                return host
    except Exception:
        pass
    return ""


def clean_name(name: str) -> str:
    name = name.lower()
    name = re.sub(r"\b(inc|llc|ltd|corp|co|group|holdings|services|solutions|technologies|technology|global|usa|us)\b\.?", "", name)
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def find_employer(company_name: str, domain: str) -> Optional[dict]:
    """Try domain match first (when available), then name match."""
    if domain:
        res = sb.table("employers").select("id,name").ilike("domain", f"%{domain}%").limit(1).execute()
        if res.data:
            return res.data[0]

    cn = clean_name(company_name)
    if not cn:
        return None
    res = sb.table("employers").select("id,name,name_clean").ilike("name_clean", f"%{cn}%").limit(3).execute()
    rows = res.data or []
    for row in rows:
        if clean_name(row.get("name_clean", "")) == cn:
            return row
    if len(rows) == 1:
        return rows[0]
    return None


def load_csv() -> list[dict]:
    with open(CSV_PATH) as f:
        return list(csv.DictReader(f))


def save_csv(rows: list[dict]):
    fieldnames = ["slug", "company_name", "job_count", "verified", "domain"]
    with open(CSV_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def main():
    rows = load_csv()
    verified = [r for r in rows if r.get("verified") == "True"]
    needs_domain = [r for r in verified if not r.get("domain")]
    print(f"Loaded {len(verified)} verified companies, {len(needs_domain)} need domain lookup\n")

    # ── Phase 1: add domain column via absolute_url ───────────────────────────
    print("Phase 1: extracting domains from Greenhouse absolute_url…")
    found = 0
    for i, row in enumerate(needs_domain, 1):
        domain = domain_from_slug(row["slug"])
        row["domain"] = domain
        if domain:
            found += 1
        if i % 5 == 0 or domain:
            print(f"  [{i}/{len(needs_domain)}] {row['slug']:40s} {domain or '—'}")
        if i % 15 == 0:
            time.sleep(0.5)

    # Ensure all rows have the domain key
    for row in rows:
        if "domain" not in row:
            row["domain"] = ""

    save_csv(rows)
    print(f"\nPhase 1 done — {found}/{len(needs_domain)} domains found. CSV saved.\n")

    # ── Phase 2: upsert employer_ats via name match ───────────────────────────
    print("Phase 2: matching against employer table and upserting employer_ats…")
    inserted, already, unmatched = 0, 0, 0

    for row in verified:
        emp = find_employer(row["company_name"], row.get("domain", ""))
        if not emp:
            unmatched += 1
            continue

        try:
            sb.table("employer_ats").upsert(
                {"employer_id": emp["id"], "ats_type": "greenhouse", "slug": row["slug"]},
                on_conflict="employer_id,ats_type"
            ).execute()
            print(f"  ✓ {emp['name']:50s} slug={row['slug']}")
            inserted += 1
        except Exception as e:
            print(f"  ERR {row['slug']}: {e}")

    print(f"\nDone. {inserted} upserted into employer_ats, {unmatched} unmatched (not in employer table)")


if __name__ == "__main__":
    main()
