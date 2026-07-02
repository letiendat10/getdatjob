#!/usr/bin/env python3
"""Incremental description + salary enrichment for list-only ATS sources.

The daily pull (03_pull_jobs.py) stores only title/location/url for Workday,
SmartRecruiters and iCIMS — their *list* endpoints carry no description, so
description_text is "" and salary_range can never be derived. This pass fetches
each job's *detail* endpoint, fills description_text, and re-derives salary_range.

Design:
  * Capped per run (--limit) so it never runs unbounded — safe to schedule.
  * Resumable: it only selects jobs whose description_text is still empty, so
    repeated runs chew through the backlog (Workday is ~100k jobs) and then keep
    up with the daily delta.
  * Durable: the daily pull omits empty description_text/salary_range from its
    upserts, so values written here survive subsequent daily runs.

Usage:
  python3 scrapers/04_enrich_descriptions.py [--limit 3000] [--ats workday]
                                             [--sleep 0.4] [--dry-run]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

# Reuse helpers + Supabase client from the puller. Its filename starts with a
# digit, so it can't be imported normally — load it by path via importlib. The
# puller only runs its pull under `if __name__ == "__main__"`, so importing it
# is side-effect-free apart from creating the Supabase client. (03_pull_jobs.py
# does `from config import ...`, so its own directory must be on sys.path.)
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location("pull_jobs", f"{_HERE}/03_pull_jobs.py")
pj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pj)

sb = pj.sb
strip_html = pj.strip_html
parse_salary = pj.parse_salary
parse_workday_posted_on = pj.parse_workday_posted_on
# Re-scoring after enrichment reuses the puller's scorer + the LCA title index, so a
# freshly-enriched description can finalize its confidence tier (notably friendly→excluded
# when it carries a no-sponsor clause) — the same logic 05_rescore_job_signals.py runs in
# batch, applied per-job the moment the description lands.
score_job = pj.score_job
from functools import lru_cache
from title_utils import build_lca_index
# Canonical classifiers (classify.py is importable normally — no leading digit). Used to
# re-derive job_level/department/is_remote from the CLEAN iCIMS title (see detail_icims).
from classify import classify_level, classify_department, detect_remote, strong_title_department

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; getdatjob-bot/1.0)"}
TIMEOUT = 20
ENRICHABLE = ("workday", "smartrecruiters", "icims")


# ── per-ATS detail fetchers — return (description_html, posted_at_or_None) ─────

def detail_workday(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    # slug = "{subdomain}.{instance}/{jobsite}" e.g. "cvshealth.wd1/CVS_Health_Careers"
    # ats_job_id = externalPath e.g. "/job/PA---Mount-Carmel/Pharmacy-Technician_R0929734"
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    cxs = f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{jobsite}{ats_job_id}"
    r = requests.get(cxs, headers={**HEADERS, "Accept": "application/json"}, timeout=TIMEOUT)
    r.raise_for_status()
    info = r.json().get("jobPostingInfo", {}) or {}
    html = info.get("jobDescription", "") or ""
    # Exact posting date; fall back to the relative "postedOn" string if absent.
    posted = info.get("startDate") or parse_workday_posted_on(info.get("postedOn"))
    return html, posted


def detail_smartrecruiters(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{ats_job_id}"
    r = requests.get(url, headers={**HEADERS, "Accept": "application/json"}, timeout=TIMEOUT)
    r.raise_for_status()
    sections = (r.json().get("jobAd", {}) or {}).get("sections", {}) or {}
    parts = []
    for key in ("jobDescription", "qualifications", "additionalInformation"):
        sec = sections.get(key) or {}
        if sec.get("text"):
            parts.append(sec["text"])
    return "\n\n".join(parts), None


def _jsonld_jobposting(soup: BeautifulSoup) -> dict | None:
    """First ld+json JobPosting object on a detail page — clean structured data.
    Generic schema.org extraction; shared by the iCIMS and SuccessFactors detail fetchers."""
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.get_text())
        except Exception:
            continue
        for cand in (data if isinstance(data, list) else [data]):
            if isinstance(cand, dict) and cand.get("@type") == "JobPosting":
                return cand
    return None


def _icims_location(jp: dict) -> str:
    """JobPosting.jobLocation → "City, ST" (drops iCIMS "UNAVAILABLE" placeholder fields)."""
    loc = jp.get("jobLocation")
    if isinstance(loc, list):
        loc = loc[0] if loc else None
    addr = (loc or {}).get("address", {}) if isinstance(loc, dict) else {}
    parts = [addr.get("addressLocality"), addr.get("addressRegion")]
    return ", ".join(p for p in parts if p and p != "UNAVAILABLE")


def detail_icims_fields(slug: str, ats_job_id: str) -> dict:
    """iCIMS detail page → clean structured fields from the JSON-LD JobPosting.

    Returns {title, location, posted, description_html}. The public search/LIST page only
    exposes field LABELS ("Title"/"Location") glued onto values, so the list-scraped title and
    location are unreliable ("TitleSenior Software Engineer", "Location"); the JSON-LD is the
    authoritative source. Falls back to the .iCIMS_JobContent node (description HTML only) when
    no JSON-LD is present.
    """
    url = f"https://{slug}.icims.com/jobs/{ats_job_id}/job?in_iframe=1"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    jp = _jsonld_jobposting(soup)
    if jp:
        return {
            "title": (jp.get("title") or "").strip() or None,
            "location": _icims_location(jp) or None,
            "posted": jp.get("datePosted") or None,
            "description_html": jp.get("description") or "",
        }
    node = soup.select_one(
        ".iCIMS_JobContent, .iCIMS_InfoMsg_Job, #jobDescription, [class*='JobDescription']"
    )
    return {"title": None, "location": None, "posted": None,
            "description_html": str(node) if node else ""}


def detail_icims(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    # Clean HTML description + true posted date from the detail-page JSON-LD JobPosting.
    f = detail_icims_fields(slug, ats_job_id)
    return f["description_html"], f["posted"]


# ── Eightfold (PCSX) detail ───────────────────────────────────────────────────
_ef_detail_domain_cache: dict[str, str | None] = {}


def _eightfold_detail_domain(slug: str) -> str | None:
    """Discover Eightfold's required 'domain' param; cached per slug for this process."""
    if slug in _ef_detail_domain_cache:
        return _ef_detail_domain_cache[slug]
    # pj is the 03_pull_jobs module loaded at module scope; reuse its domain cache if available.
    if hasattr(pj, "_get_eightfold_domain") and hasattr(pj, "_eightfold_base"):
        domain = pj._get_eightfold_domain(pj._eightfold_base(slug))
    else:
        base = f"https://{slug}" if "." in slug else f"https://{slug}.eightfold.ai"
        _browser_ua = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}
        try:
            resp = requests.get(f"{base}/careers", headers=_browser_ua, timeout=15,
                                allow_redirects=True)
            m = re.search(r'domain=([a-zA-Z0-9._-]+\.[a-zA-Z]{2,6})', resp.text)
            domain = m.group(1) if m else None
        except Exception:
            domain = None
    _ef_detail_domain_cache[slug] = domain
    return domain


def detail_eightfold(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    """Eightfold position detail — returns (jobDescription HTML, posted_at ISO date)."""
    domain = _eightfold_detail_domain(slug)
    if not domain:
        return "", None
    base = f"https://{slug}" if "." in slug else f"https://{slug}.eightfold.ai"
    r = requests.get(
        f"{base}/api/pcsx/position_details",
        params={"position_id": ats_job_id, "domain": domain, "hl": "en"},
        headers=HEADERS, timeout=20,
    )
    r.raise_for_status()
    data = r.json().get("data") or {}
    html = data.get("jobDescription") or ""
    posted_ts = data.get("postedTs")
    posted = (
        datetime.fromtimestamp(posted_ts, tz=timezone.utc).strftime("%Y-%m-%d")
        if posted_ts else None
    )
    return html, posted


# ── SuccessFactors (RMK) detail ───────────────────────────────────────────────
_SF_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}


def _sf_microdata_posted(soup: BeautifulSoup) -> str | None:
    """RMK detail pages embed schema.org MICRODATA (not JSON-LD):
    <meta itemprop="datePosted" content="Wed Jul 01 07:00:00 UTC 2026">."""
    tag = soup.select_one("meta[itemprop='datePosted']")
    raw = (tag.get("content") or "").strip() if tag else ""
    if not raw:
        return None
    for fmt in ("%a %b %d %H:%M:%S UTC %Y", "%Y-%m-%d", "%b %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw[:10] if re.match(r"\d{4}-\d{2}-\d{2}", raw) else None


def detail_successfactors(slug: str, ats_job_id: str) -> tuple[str, str | None]:
    """RMK detail page → (description HTML, posted ISO date).

    Description comes from the itemprop='description' microdata node (RMK's standard;
    JSON-LD tried first for tenants that add it); posted from the datePosted microdata.
    slug = the employer's public careers host, optionally with a base path
    (e.g. "careers.cintas.com", "careers.knorr-bremse.com/Bendix"); ats_job_id = the
    root-absolute detail path stored by 03.fetch_successfactors (so the URL is just
    host + path — the base path only matters for the /search/ list surface)."""
    host = (slug or "").strip("/").split("/")[0]
    r = requests.get(f"https://{host}{ats_job_id}", headers=_SF_UA, timeout=TIMEOUT)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    posted = _sf_microdata_posted(soup)
    jp = _jsonld_jobposting(soup)
    if jp and jp.get("description"):
        return jp["description"], (jp.get("datePosted") or "")[:10] or posted
    node = soup.select_one("span[itemprop='description'], .jobdescription, .jobDisplay, .job")
    return (str(node) if node else ""), posted


DETAIL = {
    "workday": detail_workday,
    "smartrecruiters": detail_smartrecruiters,
    "icims": detail_icims,
    "eightfold": detail_eightfold,
    "successfactors": detail_successfactors,
}
ENRICHABLE = ENRICHABLE + ("eightfold", "successfactors")


# ── slug cache (employer_id, ats) → slug ──────────────────────────────────────
_slug_cache: dict[tuple, str | None] = {}


def get_slug(employer_id: int, ats: str) -> str | None:
    key = (employer_id, ats)
    if key not in _slug_cache:
        r = (
            sb.table("employer_ats")
            .select("slug")
            .eq("employer_id", employer_id)
            .eq("ats_type", ats)
            .limit(1)
            .execute()
        )
        _slug_cache[key] = r.data[0]["slug"] if r.data else None
    return _slug_cache[key]


def fetch_candidates(ats_list: list[str], limit: int) -> list[dict]:
    # Prioritise the jobs that most improve a visa-seeker's search: jobs inside the Kai
    # cascade window first, then biggest-LCA sponsors, newest first; failures cool down
    # (7d) instead of head-of-line blocking the queue. Ordering lives in
    # select_enrich_candidates(); see migration 20260604000002_enrich_sponsor_priority.
    return sb.rpc(
        "select_enrich_candidates", {"p_ats": ats_list, "p_limit": limit}
    ).execute().data


def stamp_attempt(job_id: int, extra: dict | None = None) -> None:
    """Mark a job attempted now (optionally with enrichment fields) so a failure cools
    down for 7 days instead of being re-selected every run and blocking the budget."""
    payload = {"enrich_attempted_at": datetime.now(timezone.utc).isoformat()}
    if extra:
        payload.update(extra)
    sb.table("jobs").update(payload).eq("id", job_id).execute()


@lru_cache(maxsize=4096)
def _lca_index(employer_id: int):
    """Per-employer LCA title index, cached for the process lifetime. LCA data only changes
    on a quarterly bulk load, so caching across a worker's ~5.5h run is safe and avoids a DB
    round-trip per enriched job."""
    return build_lca_index(sb, employer_id)


def rescore_after_enrich(job_id: int, employer_id: int | None, desc_text: str) -> str | None:
    """Finalize a job's confidence tier once its description lands — the per-job equivalent
    of 05_rescore_job_signals.rescore_employer(). Re-runs score_job against the now-present
    description; the only enrichment-driven change is friendly→excluded when a no-sponsor
    clause appears (title-derived verified/excluded are terminal, matching 05's skip rule).
    Returns the new tier when it changed, else None. Callers wrap this so a rescore hiccup
    never fails a successful enrichment."""
    if not employer_id:
        return None
    sig = (
        sb.table("job_signals")
        .select("confidence_tier,no_sponsor_in_desc_flag")
        .eq("job_id", job_id)
        .limit(1)
        .execute()
        .data
    )
    cur_tier = sig[0]["confidence_tier"] if sig else None
    cur_flag = sig[0]["no_sponsor_in_desc_flag"] if sig else None
    if cur_tier in ("verified", "excluded"):
        return None  # terminal — see 05_rescore_job_signals.rescore_employer
    jr = sb.table("jobs").select("title").eq("id", job_id).limit(1).execute().data
    if not jr:
        return None
    titles, counts = _lca_index(employer_id)
    tier, flag, tc, lca_count = score_job(jr[0]["title"], desc_text or "", titles, counts)
    if tier == cur_tier and flag == cur_flag:
        return None  # unchanged — skip the write (and the enrich_priority trigger churn)
    sb.table("job_signals").upsert(
        {
            "job_id": job_id,
            "confidence_tier": tier,
            "no_sponsor_in_desc_flag": flag,
            "title_clean": tc,
            "title_employer_lca_count": lca_count,
        },
        on_conflict="job_id",
    ).execute()
    return tier


def enrich_one(job: dict, *, dry_run: bool = False) -> dict:
    """Fetch + parse + persist enrichment for a single job — the single source of
    per-job enrichment logic, shared by main()'s batch loop and enrich_worker.py.

    `job` needs id, ats_source, ats_job_id, employer_id. Returns a status dict
    {"status": "no_slug"|"error"|"no_desc"|"enriched", ...}. Stamps enrich_attempted_at
    on every outcome (unless dry_run) so failures cool down instead of blocking the queue.
    """
    ats = job["ats_source"]
    slug = get_slug(job["employer_id"], ats)
    if not slug:
        if not dry_run:
            stamp_attempt(job["id"])  # cool down so it doesn't block the queue
        return {"status": "no_slug"}
    icims = ats == "icims"
    icims_fields: dict | None = None
    detail_src_dept: str | None = None
    try:
        if icims:
            # iCIMS: pull clean title/location/posted/description from the JSON-LD JobPosting.
            icims_fields = detail_icims_fields(slug, job["ats_job_id"])
            html, posted = icims_fields["description_html"], icims_fields["posted"]
        else:
            det = DETAIL[ats](slug, job["ats_job_id"])
            # Length-tolerant unpack: a detail fetcher MAY return a third element with the
            # ATS's department descriptor (oracle_hcm Category — its list API returns the
            # names as null). It lands in source_department below and flows into
            # jobs.department via map_source_dept's governed restamp.
            html, posted = det[0], det[1]
            detail_src_dept = det[2] if len(det) > 2 else None
    except Exception as e:
        if not dry_run:
            stamp_attempt(job["id"])
        return {"status": "error", "error": str(e)}

    # Plain text drives gating, salary parsing and scoring; it is NOT what we store for iCIMS.
    desc_text = strip_html(html)[:8000]
    if not desc_text:
        if not dry_run:
            stamp_attempt(job["id"])
        return {"status": "no_desc"}

    # parse_salary derives display + numeric bounds + annual/hourly period.
    sal = parse_salary(html) or parse_salary(desc_text)
    # iCIMS stores the clean JSON-LD HTML so every UI surface renders it formatted (each
    # already renders description_text as HTML when it carries tags); other ATSes stay plain.
    update = {"description_text": (html[:24000] if icims and html else desc_text)}
    if posted:  # exact Workday startDate — the daily pull leaves posted_at NULL for it
        update["posted_at"] = posted
    if detail_src_dept and not job.get("source_department"):
        # Detail-only department descriptor (oracle_hcm): store the raw value; the post-pull
        # map step folds it into dept_mapping and restamps jobs.department.
        update["source_department"] = detail_src_dept
    if sal:
        update["salary_range"] = sal["display"]
        update["salary_min_num"] = sal["min_num"]
        update["salary_max_num"] = sal["max_num"]
        update["salary_period"] = sal["period"]
    if icims and icims_fields:
        # The list scrape captured iCIMS field LABELS ("Title…"/"Location"). Overwrite with the
        # authoritative JSON-LD title/location and re-derive level/department/remote from them.
        title = icims_fields.get("title")
        if title:
            update["title"] = title
            update["job_level"] = classify_level(title)
            update["title_dept_strong"] = strong_title_department(title)
            dept = classify_department(title, job.get("source_department"))
            if dept:
                update["department"] = dept
        if icims_fields.get("location"):
            update["location"] = icims_fields["location"]
        update["is_remote"] = detect_remote(title or "", icims_fields.get("location") or "")

    if not dry_run:
        try:
            stamp_attempt(job["id"], update)  # enrichment fields + attempt time in one write
        except Exception as e:
            return {"status": "error", "error": f"update: {e}"}

    # Finalize the confidence tier now that the description exists (per-job 05). Best-effort:
    # a rescore hiccup must never turn a successful enrichment into a failure.
    rescored = None
    if not dry_run:
        try:
            rescored = rescore_after_enrich(job["id"], job.get("employer_id"), desc_text)
        except Exception as e:
            print(f"  [rescore-skip] job {job['id']} — {e}", flush=True)
    return {"status": "enriched", "with_salary": bool(sal), "rescored": rescored}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=3000, help="max jobs to enrich this run")
    ap.add_argument("--ats", choices=ENRICHABLE, help="restrict to one ATS (default: all)")
    ap.add_argument("--sleep", type=float, default=0.4, help="delay between detail fetches")
    ap.add_argument("--dry-run", action="store_true", help="fetch + parse but don't write")
    args = ap.parse_args()

    ats_list = [args.ats] if args.ats else list(ENRICHABLE)
    jobs = fetch_candidates(ats_list, args.limit)
    print(f"Enriching {len(jobs)} jobs (ats={ats_list}, dry_run={args.dry_run}) …", flush=True)

    stats = {"enriched": 0, "with_salary": 0, "no_desc": 0, "errors": 0}
    for n, j in enumerate(jobs, 1):
        res = enrich_one(j, dry_run=args.dry_run)
        st = res["status"]
        if st == "enriched":
            stats["enriched"] += 1
            if res.get("with_salary"):
                stats["with_salary"] += 1
        elif st == "no_desc":
            stats["no_desc"] += 1
        else:  # no_slug | error
            stats["errors"] += 1
            if st == "error" and stats["errors"] <= 20:
                print(f"  ERROR {j['ats_source']} id={j['id']} — {res.get('error')}", flush=True)
        if n % 250 == 0:
            print(
                f"  {n}/{len(jobs)} — enriched {stats['enriched']}, "
                f"with salary {stats['with_salary']}, no-desc {stats['no_desc']}, "
                f"errors {stats['errors']}",
                flush=True,
            )
        time.sleep(args.sleep)

    print(
        f"Done. enriched {stats['enriched']} / {len(jobs)} "
        f"({stats['with_salary']} with salary, {stats['no_desc']} no-desc, "
        f"{stats['errors']} errors).",
        flush=True,
    )


if __name__ == "__main__":
    main()
