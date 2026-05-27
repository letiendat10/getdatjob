"""
enrich_workday_descriptions.py
Backfills description_text for Workday jobs that have empty descriptions.

Uses the Workday CXS API (the same endpoint the browser calls) which returns
proper HTML — far better than the JSON-LD plain-text that the old approach used.

CXS URL pattern:
  Job URL:  https://{host}.myworkdayjobs.com/{jobboard}/job/{slug}/{id}
  CXS URL:  https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobboard}/job/{slug}/{id}
  tenant  = first segment of host (e.g. "cisco" from "cisco.wd5.myworkdayjobs.com")
  Returns JSON: data["jobPostingInfo"]["jobDescription"] (HTML string)

Run modes:
  python enrich_workday_descriptions.py              # recent jobs (past 30 days), 500 max
  python enrich_workday_descriptions.py --all        # all jobs with missing descriptions
  python enrich_workday_descriptions.py --limit 200  # custom limit

Add to GitHub Actions cron alongside 03_pull_jobs.py for ongoing enrichment.
"""

from __future__ import annotations

import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from supabase import create_client

from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Content-Type": "application/json",
}
TIMEOUT = 15
WORKERS = 5    # concurrent requests — stay polite to Workday servers
DELAY = 0.2    # seconds between requests per worker


def strip_html(html: str) -> str:
    if not html:
        return ""
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


def fetch_description(job_id: int, url: str) -> tuple[int, str]:
    """Returns (job_id, description_text). Empty string on failure."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        if not hostname.endswith(".myworkdayjobs.com"):
            return job_id, ""
        tenant = hostname.split(".")[0]
        cxs_url = f"https://{hostname}/wday/cxs/{tenant}{parsed.path}"

        r = requests.get(cxs_url, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        html = data.get("jobPostingInfo", {}).get("jobDescription", "")
        if html:
            return job_id, strip_html(html)[:8000]
    except Exception as e:
        print(f"  WARN job {job_id}: {e}", flush=True)
    return job_id, ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="Process all jobs, not just recent")
    parser.add_argument("--limit", type=int, default=500, help="Max jobs to process (default 500)")
    args = parser.parse_args()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

    q = (
        sb.table("jobs")
        .select("id,url")
        .eq("ats_source", "workday")
        .eq("is_active", True)
        .or_("description_text.is.null,description_text.eq.")
        .order("posted_at", desc=True)
        .limit(args.limit)
    )
    if not args.all:
        q = q.gte("posted_at", cutoff)

    rows = q.execute().data
    print(f"Found {len(rows)} Workday jobs needing descriptions", flush=True)

    if not rows:
        print("Nothing to do.")
        return

    updated = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch_description, r["id"], r["url"]): r for r in rows}
        for i, future in enumerate(as_completed(futures), 1):
            job_id, desc = future.result()
            if desc:
                sb.table("jobs").update({"description_text": desc}).eq("id", job_id).execute()
                updated += 1
            else:
                failed += 1
            if i % 50 == 0:
                print(f"  {i}/{len(rows)} processed ({updated} updated, {failed} failed)", flush=True)
            time.sleep(DELAY)

    print(f"\nDone. {updated} descriptions added, {failed} failed.", flush=True)


if __name__ == "__main__":
    main()
