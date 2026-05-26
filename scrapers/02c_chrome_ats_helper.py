#!/usr/bin/env python3
"""
02c_chrome_ats_helper.py — Helper for Chrome-driven ATS detection prototype.

This file is INTENTIONALLY separate from 02_detect_ats.py and 02b_detect_ats_via_search.py.
It does not modify any existing data — it's a research helper for the
Chrome-MCP-driven approach where Claude drives Google searches in a real browser
and then matches ATS URL patterns against the SERP / careers page content.

Subcommands:
  list   --limit N         Print top-N unmapped employer names (one per line),
                           ordered by lca_count desc. Read-only Supabase query.
  match                    Read stdin (HTML or plain text), print JSON of detected
                           ATS matches: [{"ats": "...", "slug": "...", "url": "..."}]
  record NAME ATS SLUG URL Append a finding to data/chrome_ats_findings.jsonl
  report                   Pretty-print the findings file so far.

The same ATS_PATTERNS table is shared with 02b — kept in sync intentionally.
"""
from __future__ import annotations

import json
import os
import re
import sys
import argparse
from pathlib import Path

# Optional Supabase import — only needed for `list`
def _sb():
    from supabase import create_client
    from config import SUPABASE_URL, SUPABASE_KEY
    return create_client(SUPABASE_URL, SUPABASE_KEY)


FINDINGS_PATH = Path(__file__).parent.parent / "data" / "chrome_ats_findings.jsonl"


# ATS URL patterns. Order matters: most-specific first.
# Format: (regex, ats_type, slug_group_index_or_0)
ATS_PATTERNS = [
    # Greenhouse
    (r"job-boards\.greenhouse\.io/([a-z0-9_-]+)", "greenhouse", 1),
    (r"boards\.greenhouse\.io/embed/job_board\?for=([a-z0-9_-]+)", "greenhouse", 1),
    (r"boards-api\.greenhouse\.io/v1/boards/([a-z0-9_-]+)", "greenhouse", 1),
    (r"boards\.greenhouse\.io/([a-z0-9_-]+)", "greenhouse", 1),
    # Lever
    (r"jobs\.lever\.co/([a-z0-9_-]+)", "lever", 1),
    (r"api\.lever\.co/v0/postings/([a-z0-9_-]+)", "lever", 1),
    # Workday — tenant subdomain
    (r"([a-z0-9_-]+)\.wd[0-9]+\.myworkdayjobs\.com", "workday", 1),
    (r"([a-z0-9_-]+)\.myworkdayjobs\.com", "workday", 1),
    (r"([a-z0-9_-]+)\.myworkdaysite\.com", "workday", 1),
    # iCIMS
    (r"careers-([a-z0-9_-]+)\.icims\.com", "icims", 1),
    (r"([a-z0-9_-]+)\.icims\.com", "icims", 1),
    # SmartRecruiters
    (r"jobs\.smartrecruiters\.com/([a-z0-9_-]+)", "smartrecruiters", 1),
    (r"careers\.smartrecruiters\.com/([a-z0-9_-]+)", "smartrecruiters", 1),
    (r"api\.smartrecruiters\.com/v1/companies/([a-z0-9_-]+)", "smartrecruiters", 1),
    # Ashby
    (r"jobs\.ashbyhq\.com/([a-z0-9_-]+)", "ashby", 1),
    (r"api\.ashbyhq\.com/posting-api/job-board/([a-z0-9_-]+)", "ashby", 1),
    # BambooHR
    (r"([a-z0-9_-]+)\.bamboohr\.com", "bamboohr", 1),
    # Workable
    (r"apply\.workable\.com/([a-z0-9_-]+)", "workable", 1),
    (r"jobs\.workable\.com/api/v1/accounts/([a-z0-9_-]+)", "workable", 1),
    # === ATSes not currently supported by 02_detect_ats.py ===
    (r"([a-z0-9_-]+)\.taleo\.net", "taleo", 1),
    # Oracle HCM Cloud — capture account from <account>.fa.<region>.oraclecloud.com
    (r"([a-z0-9_-]+)\.fa\.[a-z0-9_-]+\.oraclecloud\.com", "oracle_hcm", 1),
    (r"([a-z0-9_-]+)\.oraclecloud\.com/hcmUI", "oracle_hcm", 1),
    (r"performancemanager\d*\.successfactors\.com", "successfactors", 0),
    (r"career\d*\.successfactors\.com", "successfactors", 0),
    (r"jobs\.jobvite\.com/([a-z0-9_-]+)", "jobvite", 1),
    (r"app\.jobvite\.com/j/?\?cj=", "jobvite", 0),
    (r"([a-z0-9_-]+)\.phenompeople\.com", "phenom", 1),
    (r"([a-z0-9_-]+)\.eightfold\.ai", "eightfold", 1),
    (r"([a-z0-9_-]+)\.avature\.net", "avature", 1),
    (r"([a-z0-9_-]+)\.recruitee\.com", "recruitee", 1),
    (r"([a-z0-9_-]+)\.breezy\.hr", "breezy", 1),
    (r"([a-z0-9_-]+)\.teamtailor\.com", "teamtailor", 1),
    (r"([a-z0-9_-]+)\.pinpointhq\.com", "pinpoint", 1),
    (r"([a-z0-9_-]+)\.applytojob\.com", "jazzhr", 1),
]

GENERIC_SLUGS = {
    "www", "api", "jobs", "careers", "apply", "boards", "app",
    "static", "assets", "cdn", "help", "support", "login",
    "secure", "host", "id", "embed", "track",
}


def match_ats(text: str) -> list[dict]:
    """Scan text for ATS URL patterns. Returns list of {ats, slug, matched}."""
    # Normalize Google SERP-style breadcrumb separators ( › ) into real slashes
    # so patterns match URLs displayed in the search results page.
    text = re.sub(r"\s*›\s*", "/", text)
    found = []
    seen = set()
    for pattern, ats_type, group_idx in ATS_PATTERNS:
        for m in re.finditer(pattern, text, re.IGNORECASE):
            slug = m.group(group_idx).lower() if group_idx > 0 else ""
            if group_idx > 0 and slug in GENERIC_SLUGS:
                continue
            # Filter out Workday infrastructure subdomains like "wd1", "wd5"
            if re.fullmatch(r"wd\d+", slug):
                continue
            key = (ats_type, slug)
            if key in seen:
                continue
            seen.add(key)
            # Pull surrounding context as "matched" — the URL fragment
            start = max(0, m.start() - 20)
            end = min(len(text), m.end() + 40)
            ctx = text[start:end].strip()
            # Try to isolate just the URL portion
            url_match = re.search(r"https?://[^\s\"'<>)]+", ctx)
            matched_url = url_match.group(0) if url_match else m.group(0)
            found.append({"ats": ats_type, "slug": slug, "matched": matched_url})
    return found


def cmd_list(args):
    sb = _sb()
    mapped_rows = sb.table("employer_ats").select("employer_id").execute().data
    mapped_ids = {r["employer_id"] for r in mapped_rows}
    employers = sb.table("employers").select("id,name,lca_count").order(
        "lca_count", desc=True
    ).execute().data
    out = [(e["name"], e.get("lca_count") or 0) for e in employers if e["id"] not in mapped_ids]
    out = out[: args.limit]
    if args.json:
        print(json.dumps([{"name": n, "lca_count": c} for n, c in out], indent=2))
    else:
        for name, _ in out:
            print(name)


def cmd_match(args):
    text = sys.stdin.read()
    matches = match_ats(text)
    print(json.dumps(matches, indent=2))


def cmd_record(args):
    FINDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "name": args.name,
        "ats": args.ats,
        "slug": args.slug,
        "source": args.source,
    }
    with FINDINGS_PATH.open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"recorded: {row}")


def cmd_report(args):
    if not FINDINGS_PATH.exists():
        print("(no findings yet)")
        return
    with FINDINGS_PATH.open() as f:
        rows = [json.loads(line) for line in f if line.strip()]
    print(f"{len(rows)} findings:")
    for r in rows:
        slug = f":{r['slug']}" if r.get("slug") else ""
        print(f"  {r['name']:<50}  →  {r['ats']}{slug}    [{r.get('source','')}]")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="Print unmapped employer names")
    p_list.add_argument("--limit", type=int, default=20)
    p_list.add_argument("--json", action="store_true")
    p_list.set_defaults(func=cmd_list)

    p_match = sub.add_parser("match", help="Match ATS patterns against stdin text")
    p_match.set_defaults(func=cmd_match)

    p_rec = sub.add_parser("record", help="Append a finding to the findings file")
    p_rec.add_argument("name")
    p_rec.add_argument("ats")
    p_rec.add_argument("slug")
    p_rec.add_argument("source")
    p_rec.set_defaults(func=cmd_record)

    p_rep = sub.add_parser("report", help="Print findings collected so far")
    p_rep.set_defaults(func=cmd_report)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    # Allow running from anywhere
    sys.path.insert(0, str(Path(__file__).parent))
    main()
