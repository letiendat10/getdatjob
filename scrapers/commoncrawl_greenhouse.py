"""
Discover all Greenhouse company slugs via Common Crawl CDX API,
then verify each slug against the Greenhouse public job board API.

Output: data/greenhouse_companies.csv
Columns: slug, company_name, job_count, verified
"""

import csv
import json
import time
import urllib.parse
from pathlib import Path
from typing import Optional

import requests

# Query multiple crawl indices for maximum slug coverage
CDX_INDICES = [
    "CC-MAIN-2025-05",
    "CC-MAIN-2024-51",
    "CC-MAIN-2024-18",
    "CC-MAIN-2023-50",
]
GH_API = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false"
OUTPUT = Path(__file__).parent.parent / "data" / "greenhouse_companies.csv"

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "getdatjob-research/1.0"


# ── Phase 1: Common Crawl CDX ─────────────────────────────────────────────────

def fetch_cdx_slugs():
    """Query multiple CDX indices for boards.greenhouse.io/* and extract slugs."""
    slugs = set()

    for idx in CDX_INDICES:
        cdx_url = f"https://index.commoncrawl.org/{idx}-index"
        print(f"Querying {idx}…")
        page = 0
        while True:
            params = {
                "url": "boards.greenhouse.io/*",
                "output": "json",
                "collapse": "urlkey",
                "page": page,
            }
            try:
                r = SESSION.get(cdx_url, params=params, timeout=60)
                r.raise_for_status()
            except requests.RequestException as e:
                print(f"  failed page {page}: {e}")
                break

            lines = [l for l in r.text.strip().splitlines() if l]
            if not lines:
                break

            for line in lines:
                try:
                    obj = json.loads(line)
                    url = obj.get("url", "")
                    parts = urllib.parse.urlparse(url).path.strip("/").split("/")
                    slug = parts[0] if parts else ""
                    if slug and slug not in ("embed", ""):
                        slugs.add(slug.lower())
                except (json.JSONDecodeError, IndexError):
                    continue

            print(f"  page {page} — unique slugs so far: {len(slugs):,}")
            page += 1
            time.sleep(0.3)

    print(f"Phase 1 done — {len(slugs):,} unique slugs found\n")
    return slugs


# ── Phase 2: Verify via Greenhouse API ───────────────────────────────────────

def verify_slug(slug: str) -> Optional[dict]:
    """
    Returns dict with company_name and job_count, or None if slug is invalid.
    Uses the public Greenhouse job board API (no auth required).
    """
    url = GH_API.format(slug=slug)
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        data = r.json()
        jobs = data.get("jobs", [])
        # company name lives on the first job's company field, or we use the slug
        company_name = ""
        if jobs:
            company_name = jobs[0].get("company", {}).get("name", "")
        # fallback: try the metadata endpoint
        if not company_name:
            meta_url = f"https://boards-api.greenhouse.io/v1/boards/{slug}"
            mr = SESSION.get(meta_url, timeout=10)
            if mr.ok:
                company_name = mr.json().get("name", "")
        return {"company_name": company_name or slug, "job_count": len(jobs)}
    except requests.RequestException:
        return None


def verify_all(slugs: set[str]) -> list[dict]:
    results = []
    total = len(slugs)
    for i, slug in enumerate(sorted(slugs), 1):
        row = verify_slug(slug)
        if row:
            results.append({"slug": slug, **row, "verified": True})
            print(f"  [{i}/{total}] ✓ {slug:40s} {row['job_count']:>5} jobs  {row['company_name']}")
        else:
            results.append({"slug": slug, "company_name": "", "job_count": 0, "verified": False})
            print(f"  [{i}/{total}] ✗ {slug}")

        # Greenhouse rate-limits generously but let's be polite
        if i % 10 == 0:
            time.sleep(0.5)

    return results


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Phase 1
    slugs = fetch_cdx_slugs()

    if not slugs:
        print("No slugs found — check CDX index name or network.")
        return

    # Phase 2
    print(f"Phase 2: verifying {len(slugs):,} slugs against Greenhouse API…\n")
    rows = verify_all(slugs)

    # Write output
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["slug", "company_name", "job_count", "verified"]
    with open(OUTPUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: -r["job_count"]))

    verified = [r for r in rows if r["verified"]]
    print(f"\nDone. {len(verified):,} verified companies → {OUTPUT}")


if __name__ == "__main__":
    main()
