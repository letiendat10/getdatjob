"""
12_resolve_sf_domains.py — one-time SuccessFactors slug → public-domain resolution.

Problem: employer_ats.slug for ats_type='successfactors' was stored as whatever
detection saw — SF company codes ("dukeuniverP1", "NYPAPROD"), apply-backend hosts
("career4.successfactors.com/<CODE>", "api012.successfactors.eu"), or junk-suffixed
domains ("careers.nrgenergy.com (SuccessFactors)"). The company-code/apply surfaces
are client-rendered JS shells and NOT scrapeable; the fetchable surface is the
employer's PUBLIC careers domain serving the server-rendered RMK /search/ page
(careers.cintas.com, jobs.sap.com, careers.nypa.gov, ...).

This script probes candidates for every successfactors employer and classifies:
  variant_a   — RMK /search/ responds with the "Results X – Y of N" marker
                → the fetchable slug; written back with --apply
  unresolved  — no candidate responded (CSB/client-rendered tenants, mis-tagged
                employers like Moody's=Radancy, or domains we couldn't guess)
                → left untouched; listed for manual follow-up / --set overrides

Usage:
  python3 scrapers/12_resolve_sf_domains.py             # dry-run, prints table
  python3 scrapers/12_resolve_sf_domains.py --apply     # write resolved slugs
  python3 scrapers/12_resolve_sf_domains.py --apply --set 123=careers.foo.com
                                                        # manual override for employer 123

Precedent: fix data, not code (the Workday underscore-host workaround) — the slug
column holds the fetchable identity so 03.fetch_successfactors stays dumb.
"""

from __future__ import annotations

import argparse
import re
import time

import requests
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_KEY

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}
# Tenant-skinned phrasings (keep in sync with 03_pull_jobs._SF_RESULTS_RE):
# "Results 1 – 25 of N" | "Showing 1 to 25 of N Jobs" | "1 to 10 of N results"
RESULTS_RE = re.compile(
    r"(?:Results\s+[\d,]+\s*[–—-]\s*[\d,]+\s+of\s+(?P<t1>[\d,]+)"
    r"|Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+(?P<t2>[\d,]+)\s+Jobs"
    r"|[\d,]+\s+to\s+[\d,]+\s+of\s+(?P<t3>[\d,]+)\s+results)",
    re.I,
)

_probe_cache: dict[str, int | None] = {}


def probe(candidate: str) -> int | None:
    """GET https://{candidate}/search/ and return the tenant's total job count if the
    RMK results marker is present, else None. Cached — employers share domains."""
    candidate = candidate.strip("/")
    if candidate in _probe_cache:
        return _probe_cache[candidate]
    total: int | None = None
    try:
        r = requests.get(f"https://{candidate}/search/",
                         params={"q": "", "startrow": 0},
                         headers=UA, timeout=15, allow_redirects=True)
        if r.status_code == 200:
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ",
                                              r.text.replace("&nbsp;", " ")))
            m = RESULTS_RE.search(text)
            if m:
                total = int(next(g for g in m.groups() if g).replace(",", ""))
    except Exception:
        total = None
    _probe_cache[candidate] = total
    return total


def clean_slug(slug: str) -> str:
    """Strip junk from a stored slug: parenthetical notes, protocol, whitespace."""
    s = re.sub(r"\s*\(.*?\)\s*", "", slug or "").strip()
    s = re.sub(r"^https?://", "", s).strip().strip("/")
    return s


def is_domainish(s: str) -> bool:
    host = s.split("/")[0]
    return ("." in host
            and not host.endswith("successfactors.com")
            and not host.endswith("successfactors.eu")
            and re.fullmatch(r"[a-z0-9.-]+(/[A-Za-z0-9_/-]+)?", s, re.I) is not None)


def candidates_for(slug: str, company_domain: str) -> list[str]:
    """Ordered candidate list: cleaned stored slug first (if domain-shaped, with and
    without its path), then careers./jobs. guesses off the employer's website domain."""
    cands: list[str] = []
    s = clean_slug(slug)
    if s and is_domainish(s):
        cands.append(s)
        if "/" in s:  # multi-brand path slug — also try the bare host
            cands.append(s.split("/")[0])
    dom = re.sub(r"^https?://|^www\.", "", (company_domain or "").strip().strip("/"))
    if dom and "." in dom:
        root = ".".join(dom.split(".")[-2:])  # sa.ucsb.edu -> ucsb.edu
        for d in dict.fromkeys([dom, root]):
            cands += [f"careers.{d}", f"jobs.{d}", f"career.{d}", f"jobsearch.{d}"]
    return list(dict.fromkeys(cands))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write resolved slugs to employer_ats")
    ap.add_argument("--set", action="append", default=[], metavar="EMPLOYER_ID=SLUG",
                    help="manual override (repeatable); probed before writing")
    args = ap.parse_args()

    overrides: dict[int, str] = {}
    for kv in args.set:
        emp_id, _, slug = kv.partition("=")
        overrides[int(emp_id)] = slug.strip().strip("/")

    rows = (sb.table("employer_ats")
            .select("id,employer_id,ats_type,slug,needs_review")
            .eq("ats_type", "successfactors").execute().data)
    emp_ids = [r["employer_id"] for r in rows]
    emps: dict[int, dict] = {}
    for i in range(0, len(emp_ids), 200):
        for e in (sb.table("employers")
                  .select("id,name,company_domain_url,lca_count_2025")
                  .in_("id", emp_ids[i:i + 200]).execute().data):
            emps[e["id"]] = e

    resolved, unresolved = [], []
    for r in sorted(rows, key=lambda r: -(emps.get(r["employer_id"], {}).get("lca_count_2025") or 0)):
        emp = emps.get(r["employer_id"], {})
        name = (emp.get("name") or "")[:44]
        lca = emp.get("lca_count_2025") or 0
        cands = (
            [overrides[r["employer_id"]]] if r["employer_id"] in overrides
            else candidates_for(r["slug"] or "", emp.get("company_domain_url") or "")
        )
        hit, total = None, None
        for cand in cands:
            total = probe(cand)
            if total is not None:
                hit = cand
                break
            time.sleep(0.3)
        if hit:
            changed = hit != (r["slug"] or "")
            resolved.append((r, name, lca, hit, total, changed))
            print(f"  OK   {name:<44} lca={lca:<5} {r['slug'] or '∅':<45} -> {hit}  ({total} jobs)"
                  + ("" if changed else "  [unchanged]"), flush=True)
        else:
            unresolved.append((r, name, lca, cands))
            print(f"  MISS {name:<44} lca={lca:<5} {r['slug'] or '∅':<45} tried={len(cands)}", flush=True)

    print(f"\n=== {len(resolved)} resolved (variant_a), {len(unresolved)} unresolved ===")
    if unresolved:
        print("\nUnresolved (CSB/mis-tag/needs manual --set):")
        for r, name, lca, cands in unresolved:
            print(f"  emp={r['employer_id']:<7} lca={lca:<5} {name:<44} slug={r['slug'] or '∅'}"
                  f"  candidates_tried={cands}")

    if args.apply:
        wrote = 0
        for r, name, lca, hit, total, changed in resolved:
            if not changed:
                continue
            sb.table("employer_ats").update({"slug": hit}).eq("id", r["id"]).execute()
            wrote += 1
        print(f"\nAPPLIED: {wrote} slugs updated on employer_ats")
    else:
        print("\nDRY-RUN: no writes. Re-run with --apply to persist resolved slugs.")


if __name__ == "__main__":
    main()
