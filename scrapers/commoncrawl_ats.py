"""
commoncrawl_ats.py
Enumerate company slugs for SmartRecruiters and Lever via Common Crawl CDX API,
verify each slug, then fuzzy-match against the employers table and upsert into employer_ats.

Usage:
    python3 scrapers/commoncrawl_ats.py                          # all supported ATS
    python3 scrapers/commoncrawl_ats.py --ats smartrecruiters    # one ATS only
    python3 scrapers/commoncrawl_ats.py --ats lever
    python3 scrapers/commoncrawl_ats.py --dry-run                # no DB writes
    python3 scrapers/commoncrawl_ats.py --skip-cdx               # skip CDX, use existing CSV files

Output: data/cdx_{ats_type}.csv  (slug, company_name, job_count, verified)
"""

from __future__ import annotations

import csv
import difflib
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

import requests
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

DRY_RUN = "--dry-run" in sys.argv
SKIP_CDX = "--skip-cdx" in sys.argv

_ats_arg = None
for _idx, _arg in enumerate(sys.argv):
    if _arg == "--ats" and _idx + 1 < len(sys.argv):
        _ats_arg = sys.argv[_idx + 1]

DATA_DIR = Path(__file__).parent.parent / "data"
CDX_INDICES = ["CC-MAIN-2025-05", "CC-MAIN-2024-51", "CC-MAIN-2024-18", "CC-MAIN-2023-50"]

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "getdatjob-research/1.0"

NAME_MATCH_THRESHOLD = 0.55  # lower than 02_detect_ats.py since CDX names are often clean


# ── ATS config ────────────────────────────────────────────────────────────────

ATS_CONFIG = {
    "smartrecruiters": {
        "cdx_url_pattern": "careers.smartrecruiters.com/*",
        "extract_slug": lambda url: urllib.parse.urlparse(url).path.strip("/").split("/")[0],
        "verify": lambda slug: _verify_smartrecruiters(slug),
        "output_csv": "cdx_smartrecruiters.csv",
    },
    "lever": {
        "cdx_url_pattern": "jobs.lever.co/*",
        "extract_slug": lambda url: urllib.parse.urlparse(url).path.strip("/").split("/")[0],
        "verify": lambda slug: _verify_lever(slug),
        "output_csv": "cdx_lever.csv",
    },
}


# ── Verifiers ─────────────────────────────────────────────────────────────────

def _verify_smartrecruiters(slug: str) -> dict | None:
    try:
        r = SESSION.get(
            f"https://api.smartrecruiters.com/v1/companies/{slug}/postings",
            params={"limit": 1},
            timeout=15,
        )
        if r.status_code == 200:
            data = r.json()
            total = data.get("totalFound", 0)
            company_name = data.get("company", {}).get("name", "") if data.get("company") else ""
            if total > 0 or company_name:
                return {"company_name": company_name or slug, "job_count": total}
    except Exception:
        pass
    return None


def _verify_lever(slug: str) -> dict | None:
    try:
        r = SESSION.get(
            f"https://api.lever.co/v0/postings/{slug}?mode=json",
            timeout=15,
        )
        if r.status_code == 200 and isinstance(r.json(), list):
            jobs = r.json()
            # Lever returns company name in the first posting's company field
            company_name = jobs[0].get("company", slug) if jobs else slug
            return {"company_name": company_name, "job_count": len(jobs)}
    except Exception:
        pass
    return None


# ── Phase 1: CDX enumeration ──────────────────────────────────────────────────

def fetch_cdx_slugs(url_pattern: str, extract_slug) -> set[str]:
    slugs = set()
    for idx in CDX_INDICES:
        cdx_url = f"https://index.commoncrawl.org/{idx}-index"
        print(f"  Querying {idx} for {url_pattern}…")
        page = 0
        while True:
            params = {
                "url": url_pattern,
                "output": "json",
                "collapse": "urlkey",
                "page": page,
            }
            try:
                r = SESSION.get(cdx_url, params=params, timeout=60)
                r.raise_for_status()
            except requests.RequestException as e:
                print(f"    failed page {page}: {e}")
                break

            lines = [ln for ln in r.text.strip().splitlines() if ln]
            if not lines:
                break

            for line in lines:
                try:
                    obj = json.loads(line)
                    url = obj.get("url", "")
                    slug = extract_slug(url)
                    if slug and slug not in ("", "jobs", "careers", "embed"):
                        slugs.add(slug.lower())
                except (json.JSONDecodeError, IndexError, Exception):
                    continue

            print(f"    page {page} — {len(slugs):,} unique slugs so far")
            page += 1
            time.sleep(0.3)

    print(f"  CDX done — {len(slugs):,} unique slugs\n")
    return slugs


# ── Phase 2: Verify slugs ─────────────────────────────────────────────────────

def verify_all(slugs: set[str], verify_fn) -> list[dict]:
    results = []
    total = len(slugs)
    for i, slug in enumerate(sorted(slugs), 1):
        row = verify_fn(slug)
        if row:
            results.append({"slug": slug, **row, "verified": True})
            if i % 50 == 0:
                print(f"  [{i}/{total}] ✓ {slug:40s} {row['job_count']:>5} jobs  {row['company_name']}")
        else:
            results.append({"slug": slug, "company_name": "", "job_count": 0, "verified": False})
        if i % 20 == 0:
            time.sleep(0.5)
    verified_count = sum(1 for r in results if r["verified"])
    print(f"  Verification done — {verified_count:,}/{total:,} verified\n")
    return results


# ── Phase 3: Match against employers table ────────────────────────────────────

def clean_name(name: str) -> str:
    name = name.lower()
    name = re.sub(r"\b(inc|llc|ltd|corp|co|group|holdings|services|solutions|technologies|technology|global|usa|us)\b\.?", "", name)
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def fuzzy_score(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def match_employers(verified_rows: list[dict], employers: list[dict]) -> list[tuple]:
    """Return list of (employer_id, employer_name, slug, score) matches."""
    matches = []
    for row in verified_rows:
        if not row.get("verified") or not row.get("job_count", 0):
            continue
        ats_name = row["company_name"]
        slug = row["slug"]
        cn_ats = clean_name(ats_name)

        best_emp = None
        best_score = 0.0
        for emp in employers:
            cn_emp = emp.get("name_clean") or clean_name(emp["name"])
            score = fuzzy_score(cn_ats, cn_emp)
            if score > best_score:
                best_score = score
                best_emp = emp

        if best_emp and best_score >= NAME_MATCH_THRESHOLD:
            matches.append((best_emp["id"], best_emp["name"], slug, best_score))

    return matches


# ── Main ──────────────────────────────────────────────────────────────────────

def run_ats(ats_type: str, config: dict, employers: list[dict], existing_ids: set[int]):
    csv_path = DATA_DIR / config["output_csv"]

    if SKIP_CDX and csv_path.exists():
        print(f"[{ats_type}] Loading existing {csv_path.name}…")
        with open(csv_path) as f:
            all_rows = list(csv.DictReader(f))
        all_rows = [
            {**r, "verified": r.get("verified") == "True", "job_count": int(r.get("job_count") or 0)}
            for r in all_rows
        ]
    else:
        print(f"[{ats_type}] Phase 1: CDX enumeration…")
        slugs = fetch_cdx_slugs(config["cdx_url_pattern"], config["extract_slug"])

        print(f"[{ats_type}] Phase 2: Verifying {len(slugs):,} slugs…")
        all_rows = verify_all(slugs, config["verify"])

        DATA_DIR.mkdir(exist_ok=True)
        with open(csv_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["slug", "company_name", "job_count", "verified"])
            w.writeheader()
            w.writerows(sorted(all_rows, key=lambda r: -r.get("job_count", 0)))
        print(f"[{ats_type}] Saved {len(all_rows):,} rows to {csv_path.name}\n")

    print(f"[{ats_type}] Phase 3: Matching against {len(employers):,} employers…")
    matches = match_employers(all_rows, employers)
    print(f"[{ats_type}] {len(matches)} matches found (threshold={NAME_MATCH_THRESHOLD})\n")

    new_count = 0
    for emp_id, emp_name, slug, score in sorted(matches, key=lambda x: -x[3]):
        flag = " ⚠ REVIEW" if score < 0.7 else ""
        print(f"  {emp_name[:50]:50s} → {ats_type}:{slug}  score={score:.2f}{flag}")
        if emp_id not in existing_ids:
            new_count += 1
            if not DRY_RUN:
                sb.table("employer_ats").upsert(
                    {"employer_id": emp_id, "ats_type": ats_type, "slug": slug},
                    on_conflict="employer_id,ats_type",
                ).execute()
        else:
            print(f"    (already mapped — skipping)")

    print(f"\n[{ats_type}] Done. {new_count} new employer_ats entries added.")
    if DRY_RUN:
        print("  DRY RUN — nothing written to DB.")
    return new_count


def main():
    employers = sb.table("employers").select("id,name,name_clean,lca_count").execute().data
    existing_ids = {
        r["employer_id"]
        for r in sb.table("employer_ats").select("employer_id").execute().data
    }
    print(f"Loaded {len(employers):,} employers, {len(existing_ids):,} already mapped\n")

    ats_to_run = [_ats_arg] if _ats_arg and _ats_arg in ATS_CONFIG else list(ATS_CONFIG.keys())
    total_new = 0
    for ats_type in ats_to_run:
        total_new += run_ats(ats_type, ATS_CONFIG[ats_type], employers, existing_ids)

    print(f"\nAll done. {total_new} total new employer_ats entries.")


if __name__ == "__main__":
    main()
