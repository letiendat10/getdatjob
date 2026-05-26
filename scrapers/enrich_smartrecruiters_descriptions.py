"""
enrich_smartrecruiters_descriptions.py
Backfills description_text and correct postingUrl for SmartRecruiters jobs.

The list API (/v1/companies/{slug}/postings) does not include descriptions or
the public-facing postingUrl. This script calls the per-posting detail endpoint
to fetch both and writes them back to the jobs table.

Run modes:
  python enrich_smartrecruiters_descriptions.py              # jobs missing descriptions, 500 max
  python enrich_smartrecruiters_descriptions.py --all        # all SmartRecruiters jobs
  python enrich_smartrecruiters_descriptions.py --limit 200  # custom limit
"""

from __future__ import annotations

import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup
from supabase import create_client

from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 15
WORKERS = 5
DELAY = 0.2


def fetch_posting_detail(job_id: int, ats_job_id: str, slug: str) -> tuple[int, str, str]:
    """Returns (job_id, description_text, posting_url). Empty strings on failure."""
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{ats_job_id}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()

        posting_url = data.get("postingUrl", "") or ""

        sections = (data.get("jobAd") or {}).get("sections", {})
        parts = []
        for key in ("companyDescription", "jobDescription", "qualifications", "additionalInformation"):
            text = (sections.get(key) or {}).get("text", "")
            if text:
                parts.append(BeautifulSoup(text, "html.parser").get_text(" ", strip=True))
        description = "\n\n".join(parts)[:8000]

        return job_id, description, posting_url
    except Exception as e:
        print(f"  WARN job {job_id} ({ats_job_id}): {e}", flush=True)
        return job_id, "", ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Process all SmartRecruiters jobs")
    parser.add_argument("--limit", type=int, default=500, help="Max jobs to process (default 500)")
    args = parser.parse_args()

    # Load slug mapping: employer_id → slug
    ats_rows = (
        sb.table("employer_ats")
        .select("employer_id,slug")
        .eq("ats_type", "smartrecruiters")
        .execute()
        .data
    )
    slug_by_employer = {r["employer_id"]: r["slug"] for r in ats_rows}

    q = (
        sb.table("jobs")
        .select("id,ats_job_id,employer_id,url")
        .eq("ats_source", "smartrecruiters")
        .eq("is_active", True)
        .order("posted_at", desc=True)
        .limit(args.limit)
    )
    if not args.all:
        # Target jobs missing descriptions OR still holding the raw API URL
        q = q.or_("description_text.is.null,description_text.eq.,url.ilike.%api.smartrecruiters.com%")

    rows = q.execute().data
    # Filter to only rows where we have a slug
    rows = [r for r in rows if r["employer_id"] in slug_by_employer]
    print(f"Found {len(rows)} SmartRecruiters jobs to enrich", flush=True)

    if not rows:
        print("Nothing to do.")
        return

    updated = 0
    failed = 0

    def process(r: dict) -> tuple[int, str, str]:
        slug = slug_by_employer[r["employer_id"]]
        return fetch_posting_detail(r["id"], r["ats_job_id"], slug)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process, r): r for r in rows}
        for i, future in enumerate(as_completed(futures), 1):
            job_id, desc, posting_url = future.result()
            updates: dict = {}
            if desc:
                updates["description_text"] = desc
            if posting_url:
                updates["url"] = posting_url
            if updates:
                sb.table("jobs").update(updates).eq("id", job_id).execute()
                updated += 1
            else:
                failed += 1
            if i % 50 == 0:
                print(f"  {i}/{len(rows)} processed ({updated} updated, {failed} failed)", flush=True)
            time.sleep(DELAY)

    print(f"\nDone. {updated} jobs enriched, {failed} failed.", flush=True)


if __name__ == "__main__":
    main()
