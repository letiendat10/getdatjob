#!/usr/bin/env python3
"""
02d_detect_ats_chrome.py — PRODUCTION ATS detection helper for Approach B
(Chrome-driven SERP scan, replaces 02_detect_ats.py for new mappings).

ARCHITECTURE
============
This helper is driven INTERACTIVELY by Claude via the Chrome MCP extension.
It is not a standalone autonomous script — the search/navigation step
requires a real browser session. The helper provides composable subcommands
that the driving SKILL.md procedure invokes via Bash.

Subcommands:
  list-targets [--limit N]
      Print top-N unmapped employers WITH a populated domain, as JSON.
      Used by the driving procedure to determine the work queue.

  match
      Read SERP text (URLs, hrefs, cite breadcrumbs) from stdin.
      Print JSON list of detected (ats, slug, matched_url) candidates.
      Same regex table + " › " normalization as the prototype 02c.

  verify <ats> <slug> <employer_name>
      Confirm the (ats, slug) pair via the ATS's own API and fuzzy-match
      the returned company name against the LCA employer name.
      Print JSON: {ok, ats_company_name, name_match_score, needs_review}.

  write <employer_id> <ats> <slug> [--name N] [--score S] [--needs-review]
      Insert into employer_ats. Applies FEIN-dedup + override priority
      (mirrors 02_detect_ats.py logic, but does NOT touch that file).

  report
      Print findings appended to data/chrome_ats_findings.jsonl during
      the current session (also written by `write` for cross-reference).

WHY APPROACH B
==============
Approach A (slug-guess) hit rate: 0-1/50 confident on top-LCA employers.
Approach B (this) hit rate: 11/20 and 15/50 confident in side-by-side tests.
B can detect Workday, Oracle HCM, Taleo, SuccessFactors, Eightfold, Phenom,
Avature, Jobvite, Recruitee, Breezy, etc. — none of which A can reach.

WHY DUPLICATE THE CHECKER FUNCTIONS
====================================
The user wants 02_detect_ats.py untouched (frozen reference). Importing
across files would either require modifying 02 to be a module, or
fragile importlib hacks against a filename starting with a digit. The
check_* functions are stable; duplication is the right tradeoff here.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
from pathlib import Path

import requests
from supabase import create_client

sys.path.insert(0, str(Path(__file__).parent))
from config import SUPABASE_URL, SUPABASE_KEY

HEADERS = {"User-Agent": "getdatjob-bot/1.0"}
TIMEOUT = 8
NAME_MATCH_THRESHOLD = 0.65

FINDINGS_PATH = Path(__file__).parent.parent / "data" / "chrome_ats_findings.jsonl"

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


# ─── ATS URL pattern table (shared with 02c prototype, expanded over time) ───
# Order matters: more-specific patterns first.
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
    # === ATSes Approach A cannot detect ===
    (r"([a-z0-9_-]+)\.fa\.[a-z0-9_-]+\.oraclecloud\.com", "oracle_hcm", 1),
    (r"([a-z0-9_-]+)\.oraclecloud\.com/hcmUI", "oracle_hcm", 1),
    (r"([a-z0-9_-]+)\.taleo\.net", "taleo", 1),
    (r"performancemanager\d*\.successfactors\.com", "successfactors", 0),
    (r"career\d*\.successfactors\.com", "successfactors", 0),
    (r"jobs\.jobvite\.com/([a-z0-9_-]+)", "jobvite", 1),
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


def fuzzy_score(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def match_ats(text: str) -> list[dict]:
    """Scan text for ATS URL patterns. Returns [{ats, slug, matched}] (deduped)."""
    text = re.sub(r"\s*›\s*", "/", text)  # normalize Google SERP breadcrumb
    found, seen = [], set()
    for pattern, ats_type, group_idx in ATS_PATTERNS:
        for m in re.finditer(pattern, text, re.IGNORECASE):
            slug = m.group(group_idx).lower() if group_idx > 0 else ""
            if group_idx > 0 and slug in GENERIC_SLUGS:
                continue
            if re.fullmatch(r"wd\d+", slug):  # Workday infra subdomain
                continue
            key = (ats_type, slug)
            if key in seen:
                continue
            seen.add(key)
            url_match = re.search(r"https?://[^\s\"'<>)]+", text[max(0, m.start()-20):m.end()+40])
            found.append({
                "ats": ats_type,
                "slug": slug,
                "matched": url_match.group(0) if url_match else m.group(0),
            })
    return found


# ─── ATS verifiers ───────────────────────────────────────────────────────────
# Each returns (company_name_or_None, matched: bool).
# These are duplicated from 02_detect_ats.py by design (see file docstring).

def check_greenhouse(slug: str) -> tuple[str | None, bool]:
    try:
        r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}",
                         headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return None, False
        data = r.json()
        r2 = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
                          headers=HEADERS, timeout=TIMEOUT)
        if r2.status_code == 200 and "jobs" in r2.json():
            return data.get("name"), True
        return None, False
    except Exception:
        return None, False


def check_lever(slug: str) -> tuple[str | None, bool]:
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return None, r.status_code == 200 and isinstance(r.json(), list)
    except Exception:
        return None, False


def check_ashby(slug: str) -> tuple[str | None, bool]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return None, False
        data = r.json()
        return None, bool(data.get("jobs"))
    except Exception:
        return None, False


def check_smartrecruiters(slug: str) -> tuple[str | None, bool]:
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        return None, r.status_code == 200 and r.json().get("totalFound", 0) > 0
    except Exception:
        return None, False


def check_icims(slug: str) -> tuple[str | None, bool]:
    url = f"https://{slug}.icims.com/jobs/search"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        return None, r.status_code == 200
    except Exception:
        return None, False


def check_bamboohr(slug: str) -> tuple[str | None, bool]:
    url = f"https://{slug}.bamboohr.com/jobs/"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        matched = (r.status_code == 200 and f"{slug}.bamboohr.com" in r.url
                   and "expired" not in r.url)
        return None, matched
    except Exception:
        return None, False


def check_workable(slug: str) -> tuple[str | None, bool]:
    url = f"https://www.workable.com/api/accounts/{slug}?details=true"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return None, False
        data = r.json()
        if not data.get("jobs"):
            return None, False
        return data.get("name"), True
    except Exception:
        return None, False


def check_url_alive(url: str) -> bool:
    """Soft verification for ATSes without a clean JSON API (Workday, Oracle HCM,
    Taleo, SuccessFactors, etc.). Just confirms the URL the SERP found is alive."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        return r.status_code < 400
    except Exception:
        return False


SUPPORTED_CHECKERS = {
    "greenhouse": check_greenhouse,
    "lever": check_lever,
    "ashby": check_ashby,
    "smartrecruiters": check_smartrecruiters,
    "icims": check_icims,
    "bamboohr": check_bamboohr,
    "workable": check_workable,
}

# ATSes where we soft-verify (URL alive + employer-name in page is too brittle to
# rely on; we trust the SERP URL and let downstream pull/QA catch errors).
SOFT_VERIFY_ATSES = {
    "workday", "oracle_hcm", "taleo", "successfactors", "jobvite",
    "phenom", "eightfold", "avature", "recruitee", "breezy",
    "teamtailor", "pinpoint", "jazzhr",
}


# ─── Subcommands ──────────────────────────────────────────────────────────────

def cmd_list_targets(args):
    """Print top-N unmapped employers WITH a populated domain, as JSON."""
    mapped = {r["employer_id"] for r in
              sb.table("employer_ats").select("employer_id").execute().data}
    emps = (sb.table("employers")
              .select("id,name,fein,company_domain_url,lca_count")
              .order("lca_count", desc=True).execute().data)
    targets = []
    for e in emps:
        if e["id"] in mapped:
            continue
        if not e.get("company_domain_url"):
            continue
        targets.append({
            "id": e["id"],
            "name": e["name"],
            "fein": e.get("fein"),
            "company_domain_url": e["company_domain_url"],
            "lca_count": e.get("lca_count") or 0,
        })
        if len(targets) >= args.limit:
            break
    print(json.dumps(targets, indent=2))


def cmd_match(args):
    text = sys.stdin.read()
    print(json.dumps(match_ats(text), indent=2))


def cmd_verify(args):
    ats, slug, employer_name = args.ats, args.slug, args.employer_name
    ats_company_name = None
    matched = False

    if ats in SUPPORTED_CHECKERS:
        ats_company_name, matched = SUPPORTED_CHECKERS[ats](slug)
    elif ats in SOFT_VERIFY_ATSES:
        # Soft-verify: prefer the actual matched URL from the SERP (knows wdN /
        # Oracle region); fall back to a constructed probe for ATSes with
        # predictable canonical URLs.
        if args.matched_url:
            matched = check_url_alive(args.matched_url)
        else:
            probe_url = {
                "workday": f"https://{slug}.wd1.myworkdayjobs.com",  # best-effort
                "oracle_hcm": f"https://{slug}.fa.us2.oraclecloud.com/hcmUI",
                "taleo": f"https://{slug}.taleo.net",
                "successfactors": f"https://career.successfactors.com",
                "jobvite": f"https://jobs.jobvite.com/{slug}",
                "phenom": f"https://{slug}.phenompeople.com",
                "eightfold": f"https://{slug}.eightfold.ai/careers",
                "avature": f"https://{slug}.avature.net",
                "recruitee": f"https://{slug}.recruitee.com",
                "breezy": f"https://{slug}.breezy.hr",
                "teamtailor": f"https://{slug}.teamtailor.com",
                "pinpoint": f"https://{slug}.pinpointhq.com",
                "jazzhr": f"https://{slug}.applytojob.com",
            }.get(ats)
            matched = bool(probe_url and check_url_alive(probe_url))
    else:
        print(json.dumps({"ok": False, "reason": f"unknown ats: {ats}"}))
        return

    score = None
    needs_review = False
    if ats_company_name:
        score = fuzzy_score(employer_name, ats_company_name)
        needs_review = score < NAME_MATCH_THRESHOLD
    elif ats in SOFT_VERIFY_ATSES:
        # No name to compare — flag as needs_review by default so a human can spot-check
        needs_review = True

    print(json.dumps({
        "ok": matched,
        "ats": ats,
        "slug": slug,
        "ats_company_name": ats_company_name,
        "name_match_score": score,
        "needs_review": needs_review,
    }))


def cmd_write(args):
    """Insert into employer_ats with override + FEIN-dedup priority."""
    employer_id = args.employer_id

    # Look up employer
    rows = sb.table("employers").select("id,name,fein").eq("id", employer_id).execute().data
    if not rows:
        print(json.dumps({"ok": False, "reason": "employer not found"}))
        return
    employer = rows[0]
    fein = employer.get("fein")

    # Priority 1: override
    if fein:
        ov_rows = (sb.table("employer_slug_overrides")
                     .select("ats_type,slug").eq("fein", fein).execute().data)
        if ov_rows:
            ov = ov_rows[0]
            row = {
                "employer_id": employer_id,
                "ats_type": ov["ats_type"],
                "slug": ov["slug"],
                "ats_company_name": None,
                "name_match_score": None,
                "needs_review": False,
            }
            sb.table("employer_ats").upsert(row, on_conflict="employer_id").execute()
            print(json.dumps({"ok": True, "via": "override", "row": row}))
            return

    # Priority 2: FEIN dedup
    if fein:
        sibling_rows = (sb.table("employer_ats")
                          .select("ats_type,slug,ats_company_name,name_match_score,needs_review,"
                                  "employers!inner(fein)")
                          .eq("employers.fein", fein).limit(1).execute().data)
        if sibling_rows:
            s = sibling_rows[0]
            row = {
                "employer_id": employer_id,
                "ats_type": s["ats_type"],
                "slug": s["slug"],
                "ats_company_name": s.get("ats_company_name"),
                "name_match_score": s.get("name_match_score"),
                "needs_review": s.get("needs_review", False),
            }
            sb.table("employer_ats").upsert(row, on_conflict="employer_id").execute()
            print(json.dumps({"ok": True, "via": "fein_dedup", "row": row}))
            return

    # Priority 3: write the verified detection
    row = {
        "employer_id": employer_id,
        "ats_type": args.ats,
        "slug": args.slug,
        "ats_company_name": args.name,
        "name_match_score": args.score,
        "needs_review": bool(args.needs_review),
    }
    sb.table("employer_ats").upsert(row, on_conflict="employer_id").execute()

    # Log to findings file for cross-reference / report
    FINDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with FINDINGS_PATH.open("a") as f:
        f.write(json.dumps({
            "name": employer["name"], "ats": args.ats, "slug": args.slug,
            "score": args.score, "needs_review": bool(args.needs_review),
        }) + "\n")

    print(json.dumps({"ok": True, "via": "verified_detection", "row": row}))


def cmd_report(args):
    if not FINDINGS_PATH.exists():
        print("(no findings yet)")
        return
    with FINDINGS_PATH.open() as f:
        rows = [json.loads(line) for line in f if line.strip()]
    print(f"{len(rows)} findings:")
    for r in rows:
        slug = f":{r['slug']}" if r.get("slug") else ""
        flag = " ⚠ REVIEW" if r.get("needs_review") else ""
        print(f"  {r['name']:<55}  →  {r['ats']}{slug}{flag}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list-targets")
    pl.add_argument("--limit", type=int, default=30)
    pl.set_defaults(func=cmd_list_targets)

    pm = sub.add_parser("match")
    pm.set_defaults(func=cmd_match)

    pv = sub.add_parser("verify")
    pv.add_argument("ats")
    pv.add_argument("slug")
    pv.add_argument("employer_name")
    pv.add_argument("--matched-url", default=None,
                    help="Full URL from SERP match (preferred for workday/oracle_hcm)")
    pv.set_defaults(func=cmd_verify)

    pw = sub.add_parser("write")
    pw.add_argument("employer_id", type=int)
    pw.add_argument("ats")
    pw.add_argument("slug")
    pw.add_argument("--name", default=None)
    pw.add_argument("--score", type=float, default=None)
    pw.add_argument("--needs-review", action="store_true")
    pw.set_defaults(func=cmd_write)

    pr = sub.add_parser("report")
    pr.set_defaults(func=cmd_report)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
