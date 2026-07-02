"""
03_pull_jobs_enriched_0606.py — best-of-both pull.

Fuses the two existing pullers WITHOUT touching either:
  * from 03_pull_jobs.py   — broad coverage, resilience, source_department capture (incl. the
                             Workday job-family sweep), and the daily dept/SOC mapping chain;
  * from 03_pull_jobs_0605 — gate-BEFORE-store + enrich-BEFORE-write, batched writes, and the
                             Workday early-stop list scan.

Per employer (highest 2025-LCA first, Amazon strictly last), each job runs one funnel:

  GATE — list-time (cheap, before any detail fetch)
    non-US location            -> drop
    non-sponsorable occupation -> drop   (keyword blocklist)
    not full-time (title)      -> drop   (part-time / seasonal / per-diem / temp / on-call)
    posted > 14d ago           -> drop   (only where the LIST payload exposes a date)
  ENRICH — in memory, before the row is ever written
    fetch detail -> description / salary / TRUE posted_at
  GATE — content (after enrichment, on the real description)
    not full-time (description) -> drop
    description not in English  -> drop   (langdetect)
    posted > 14d ago (true date)-> drop
  then: score confidence tier -> stage in a basket -> batched upsert (~200 rows / round trip;
  job_signals ride the ids the jobs upsert returns — no read-back SELECT).

Every row that reaches the database is already enriched, fresh, full-time, English, and US —
so a card is accurate and filterable the moment it appears, and stale/junk is never stored.

Scope        : EVERY mapped employer with employers.lca_count_2025 > --min-lca (default 50).
Window       : 14 days.
Workday       : early-stop list scan that parses `postedOn` — stale jobs are dropped BEFORE the
               per-job detail fetch. The job-family sweep is NOT run: it pages the whole board
               per family (~20-40 min on a mega-board like Cognizant) and blocked the pull, so
               Workday source_department is left blank and dept is classified from the title.
source_dept  : captured for every ATS from the list payload (blank for Workday → title-classified).

It REUSES the proven fetchers + helpers from 03_pull_jobs.py and the DETAIL fetchers from
04_enrich_descriptions.py (loaded via importlib — their filenames start with a digit), plus
the oracle_hcm fetcher. CI: .github/workflows/daily_scraper_enriched.yml runs this 4x/day,
then map_source_dept.py and map_title_soc.py (same post-pull chain as the production daily).

Usage:
  python3 scrapers/03_pull_jobs_enriched_0606.py [--min-lca 50] [--ats workday ...]
        [--employer-ids 116 ...] [--dry-run]
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import re
import signal
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

# ── load the sibling numbered modules (digit-leading filenames can't be imported) ──
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _load(mod_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(mod_name, f"{_HERE}/{filename}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


pj = _load("pull_jobs", "03_pull_jobs.py")
enr = _load("enrich_descriptions", "04_enrich_descriptions.py")
import oracle_hcm  # noqa: E402  (shared host resolver + list/detail fetchers)

sb = pj.sb

# Reused single-source-of-truth helpers (the production puller).
is_non_us_location = pj.is_non_us_location
parse_salary = pj.parse_salary
score_job = pj.score_job
build_lca_index = pj.build_lca_index
classify_department = pj.classify_department
classify_level = pj.classify_level
strong_title_department = pj.strong_title_department
detect_remote = pj.detect_remote
parse_workday_posted_on = pj.parse_workday_posted_on
strip_html = pj.strip_html

# oracle_hcm rides the same enrich machinery (04's DETAIL/ENRICHABLE already include it).
ENRICHABLE = set(enr.ENRICHABLE) | {"oracle_hcm"}
DETAIL = {**enr.DETAIL, "oracle_hcm": oracle_hcm.fetch_detail}
FETCHERS = {**pj.FETCHERS, "oracle_hcm": oracle_hcm.fetch_list}

WINDOW_DAYS = int(os.environ.get("WINDOW_DAYS", "14"))
# Inline-enrich concurrency. macOS exhausts sockets (EAGAIN) at high parallelism, so this is
# tunable via env for a clean local run; CI/Linux is happy at 8.
ENRICH_WORKERS = int(os.environ.get("ENRICH_WORKERS", "8"))
# Rows per Supabase write. Jobs are enriched IN MEMORY first, staged in a basket, and written
# in batches of this size — one round trip per ~200 rows instead of one per row.
WRITE_BATCH = int(os.environ.get("WRITE_BATCH", "200"))
# Workday focused-fetch page cap (×20 jobs/page) — bounds boards that expose no postedOn.
WD_MAX_PAGES = int(os.environ.get("WD_MAX_PAGES", "60"))

# ── Per-employer wall-clock cap + global run deadline ──────────────────────────────────
# One stuck employer (a DNS hang in an enrich worker, a slow-loris read that keeps resetting the
# 10s socket timeout, a pathological board) must never freeze the whole run the way it did
# 2026-06-07 (frozen 4h on an enrich pool, 0 writes, killed by GitHub's 300-min timeout). SIGALRM
# gives each network-heavy phase (list fetch, inline enrich) a hard ceiling; on expiry we abandon
# that phase, keep whatever already landed, and move to the next employer. EMPLOYER_BUDGET_S is a
# CEILING, not a reservation — an employer that finishes in 4s moves on at 4s; the budget only
# bites the slow/stuck ones, turning an *infinite* hang into a bounded skip. 180s clears real
# giants (Target 442 jobs, AbbVie 389) that enrich a detail page per job, with headroom.
EMPLOYER_BUDGET_S = int(os.environ.get("EMPLOYER_BUDGET_S", "180"))
# Stop STARTING new employers past this wall-clock so the run always finishes its meta refresh and
# the workflow's downstream map steps inside GitHub's 300-min job timeout (a hard kill = skipped
# bookkeeping + stale counts). Default 240 min leaves ~60 min for map_source_dept + map_title_soc.
RUN_DEADLINE_S = int(os.environ.get("RUN_DEADLINE_S", str(240 * 60)))


class EmployerTimeout(BaseException):
    """Raised by the SIGALRM handler when an employer blows EMPLOYER_BUDGET_S. Derives from
    BaseException (like KeyboardInterrupt) so the per-employer body's `except Exception` handlers
    can't swallow it — it propagates only to the dedicated `except EmployerTimeout` guards."""


def _employer_alarm(signum, frame):
    raise EmployerTimeout()


# SIGALRM is Unix-only. The handler MUST be installed before any signal.alarm() call — the default
# SIGALRM action terminates the process, so an un-handled alarm would kill the run outright.
_ALARM_ENABLED = hasattr(signal, "SIGALRM")
if _ALARM_ENABLED:
    signal.signal(signal.SIGALRM, _employer_alarm)


def _alarm(seconds: int) -> None:
    """Arm (seconds>0) or clear (0) the per-employer alarm; no-op where SIGALRM is unavailable."""
    if _ALARM_ENABLED:
        signal.alarm(seconds)


# ── Gate: language (description must be English) ───────────────────────────────────
# langdetect is added to scrapers/requirements.txt. Import is guarded so a missing wheel (e.g.
# a one-off local run) degrades to "keep everything" rather than crashing the pull. The gate is
# precision-biased: it only fires on a confident non-English read of a long-enough description,
# so it never drops a genuine English posting that happens to be short or code-heavy.
try:
    from langdetect import DetectorFactory, detect
    DetectorFactory.seed = 0  # deterministic across runs/threads
    _LANGDETECT_OK = True
except Exception as _ld_err:  # pragma: no cover
    print(f"WARN: langdetect unavailable ({_ld_err}) — language gate disabled", flush=True)
    _LANGDETECT_OK = False


def is_non_english(text: str) -> bool:
    """True only on a confident non-English read of a description with enough signal."""
    if not _LANGDETECT_OK or not text:
        return False
    t = text.strip()
    if len(t) < 200:          # too short to judge reliably -> keep
        return False
    try:
        return detect(t[:2000]) != "en"
    except Exception:
        return False          # undetectable -> keep


# ── Gate: not full-time ─────────────────────────────────────────────────────────────
# Title gate is broad (a job titled "Part-Time …" / "Seasonal …" is unambiguous). Description
# gate is narrow — it requires an explicit "part-time position/role/…" phrasing so a full-time
# role merely mentioning part-time benefits isn't dropped. Internships and contract roles are
# intentionally KEPT (per the chosen scope). Much of the hourly-retail/warehouse volume is
# already removed by the non-sponsorable-occupation gate; this catches the full-time-status case.
_NOT_FULLTIME_TITLE_RE = re.compile(
    r"\b(part[\s-]?time|seasonal|per[\s-]?diem|on[\s-]?call|prn|temp(?:orary)?|relief)\b",
    re.IGNORECASE,
)
_NOT_FULLTIME_DESC_RE = re.compile(
    r"\bthis is a part[\s-]?time\b"
    r"|\b(part[\s-]?time|seasonal|per[\s-]?diem)\s+"
    r"(position|role|opportunity|employment|status|schedule|job)\b",
    re.IGNORECASE,
)


def is_not_fulltime_title(title: str) -> bool:
    return bool(_NOT_FULLTIME_TITLE_RE.search(title or ""))


def is_not_fulltime_desc(desc: str) -> bool:
    return bool(desc and _NOT_FULLTIME_DESC_RE.search(desc))


# ── Gate: non-sponsorable occupation (interim keyword blocklist, from 0605) ──────────
# Cheap first cut — drop obviously non-sponsorable roles (warehouse/retail/food/etc.) at list
# time, BEFORE the per-job detail fetch they would otherwise trigger. Precision-biased: only
# unambiguous non-specialty terms, multi-word where a bare token would be risky. Unknown title
# -> KEEP. The full title_soc_map-driven gate replaces this in the SOC follow-on.
_NON_SPONSORABLE_RE = re.compile(
    r"\b("
    r"warehouse|fulfillment|fulfilment|sortation|stower|stocker|"
    r"material handler|delivery driver|truck driver|cdl|courier|"
    r"cashier|barista|line cook|dishwasher|busser|"
    r"janitor|custodian|housekeep(?:er|ing)|"
    r"security guard|valet|groundskeeper|landscaper|forklift|"
    r"order picker|warehouse associate|store associate|sales floor|"
    r"delivery station|delivery associate"
    r")\b",
    re.IGNORECASE,
)


def is_non_sponsorable_title(title: str) -> bool:
    return bool(_NON_SPONSORABLE_RE.search(title or ""))


def _parse_dt(iso: str | None):
    """Parse an ISO date to a TZ-AWARE datetime (UTC). Some ATS detail fetchers return a
    timezone-naive ISO string (no Z/offset); left naive, comparing it against the UTC-aware
    `cutoff` raised 'can't compare offset-naive and offset-aware datetimes'. Coerce naive → UTC
    so every gate/freshness comparison (list_gate, fetch_workday_recent, enrich_row_inplace) is
    safe."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def list_gate(j: dict, cutoff: datetime) -> str:
    """Cheap pre-enrich gate. Returns 'keep' or a drop reason. Runs cheapest/most-available
    first. Freshness only fires when the LIST payload already carries a date; list-only-no-date
    ATSes arrive with posted_at=None and are deferred to the content gate after enrichment."""
    loc = j.get("location") or ""
    title = j.get("title") or ""
    if is_non_us_location(loc) or (
        re.match(r"^\d+ [Ll]ocation", loc) and is_non_us_location(title)
    ):
        return "non_us"
    if is_non_sponsorable_title(j.get("title") or ""):
        return "occupation"
    if is_not_fulltime_title(j.get("title") or ""):
        return "part_time"
    dt = _parse_dt(j.get("posted_at"))
    if dt is not None and dt < cutoff:
        return "stale"
    return "keep"


def content_gate(desc: str | None) -> str | None:
    """Post-enrich gate on the real description. Returns a drop reason or None. Also run at list
    time for ATSes whose list payload already carries the description (Greenhouse/Lever/etc.)."""
    if not desc:
        return None
    if is_not_fulltime_desc(desc):
        return "part_time"
    if is_non_english(desc):
        return "non_english"
    return None


# ── Workday: early-stop list scan (0605); dept from title, family sweep dropped ──────

def fetch_workday_recent(slug: str) -> list[dict]:
    """Workday list fetch tuned for the focused pull: EARLY-STOP scan parsing `postedOn` into
    posted_at, so stale Workday jobs are dropped by the freshness gate BEFORE the per-job detail
    fetch, and the board shows a date immediately.

    source_department is left BLANK. Workday exposes job family only via a per-family facet sweep
    over the WHOLE board (the list/detail payloads carry none); on a mega-board like Cognizant
    (~10k+ postings) that sweep takes 20-40 min AND runs before any write, which stalled the pull.
    Department is instead classified from the title (classify_department) and folded into the
    unified taxonomy by map_source_dept post-pull. Tenants exposing no postedOn can't be
    date-gated here, so a page cap bounds them and their jobs defer to the content gate at enrich
    time. Same row shape as pj.fetch_workday."""
    host, jobsite = slug.split("/", 1)
    tenant = host.split(".")[0]
    base_url = f"https://{host}.myworkdayjobs.com"
    api_url = f"{base_url}/wday/cxs/{tenant}/{jobsite}/jobs"
    headers = {**pj.HEADERS, "Content-Type": "application/json"}
    cutoff = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)

    jobs, offset, limit, total = [], 0, 20, None
    seen_fresh, stale_streak = False, 0
    for _ in range(WD_MAX_PAGES):
        r = requests.post(
            api_url,
            json={"appliedFacets": {}, "limit": limit, "offset": offset, "searchText": ""},
            headers=headers, timeout=pj.TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        if total is None:
            total = data.get("total", 0)
        postings = data.get("jobPostings", [])
        if not postings:
            break
        page_fresh = False
        for j in postings:
            loc = j.get("locationsText", "")
            title = j.get("title", "")
            if is_non_us_location(loc) or (
                re.match(r"^\d+ [Ll]ocation", loc) and is_non_us_location(title)
            ):
                continue
            posted = parse_workday_posted_on(j.get("postedOn"))   # coarse list date or None
            if posted is None and j.get("postedOn"):              # ISO-date fallback ("2026-04-22")
                try:
                    _d = datetime.fromisoformat(j["postedOn"])
                    if _d.tzinfo is None:
                        _d = _d.replace(tzinfo=timezone.utc)
                    posted = _d.isoformat()
                except (ValueError, AttributeError):
                    pass
            pdt = _parse_dt(posted)
            if pdt is None or pdt >= cutoff:   # fresh OR unknown-date → keep scanning
                page_fresh = True
            path = j.get("externalPath", "")
            jobs.append({
                "ats_job_id": path,
                "title": title,
                "location": loc,
                "url": f"{base_url}/{jobsite}{path}",
                "posted_at": posted,
                "source_dept": "",         # Workday dept omitted (sweep too slow) → title-classified
                "description_text": "",
            })
        if page_fresh:
            seen_fresh, stale_streak = True, 0
        else:
            stale_streak += 1
        if seen_fresh and stale_streak >= 2:   # past the newest-first fresh head → done
            break
        offset += limit
        if offset >= (total or 0) or len(postings) < limit:
            break
        time.sleep(0.3)
    else:
        if offset < (total or 0):
            print(f"  [wd-cap] {slug}: stopped at {WD_MAX_PAGES}-page cap, {offset}/{total} scanned",
                  flush=True)
    return jobs


# Override the Workday fetcher with the focused early-stop one (this script only — pj untouched).
FETCHERS["workday"] = fetch_workday_recent


# ── Phase 1: focus-set driver ──────────────────────────────────────────────────────

def _fetch_all_employers(min_lca: int) -> list[dict]:
    """All employers with lca_count_2025 > min_lca, highest first. Range-paginates past
    PostgREST's 1000-row cap (the > 50 set is bigger than one page)."""
    rows, page, PAGE = [], 0, 1000
    while True:
        chunk = (sb.table("employers").select("id,name,lca_count_2025")
                 .gt("lca_count_2025", min_lca)
                 .order("lca_count_2025", desc=True)
                 .range(page * PAGE, page * PAGE + PAGE - 1).execute().data)
        rows += chunk
        if len(chunk) < PAGE:
            break
        page += 1
    return rows


def select_focus_employers(min_lca: int, ats_filter, employer_ids):
    """(rows, lca_by_emp, name_by_emp): employer_ats mappings for the focus set, deduped by
    (ats_type, slug), sorted highest-LCA first with Amazon strictly last."""
    if employer_ids:
        emp_rows = (sb.table("employers").select("id,name,lca_count_2025")
                    .in_("id", employer_ids).execute().data)
    else:
        emp_rows = _fetch_all_employers(min_lca)
    lca_by_emp = {r["id"]: (r["lca_count_2025"] or 0) for r in emp_rows}
    name_by_emp = {r["id"]: r.get("name") or "" for r in emp_rows}
    focus_ids = list(lca_by_emp.keys())

    ats_rows = []
    for i in range(0, len(focus_ids), 200):  # chunk the IN() — focus set can be large
        ats_rows += (sb.table("employer_ats").select("employer_id,ats_type,slug")
                     .in_("employer_id", focus_ids[i:i + 200]).execute().data)
    if ats_filter:
        ats_rows = [r for r in ats_rows if r["ats_type"] in ats_filter]

    seen, unique = set(), []
    for r in ats_rows:
        key = (r["ats_type"], r["slug"])
        if key not in seen:
            seen.add(key)
            unique.append(r)

    # highest-LCA first; Amazon last (its volume is the #1 statement-timeout source).
    unique.sort(key=lambda r: (r["ats_type"] == "amazon", -lca_by_emp.get(r["employer_id"], 0)))
    return unique, lca_by_emp, name_by_emp


def main():
    ap = argparse.ArgumentParser(description="Best-of-both enriched pull (lca>min, 14d, gated).")
    ap.add_argument("--min-lca", type=int, default=50,
                    help="include employers with lca_count_2025 strictly greater than this")
    ap.add_argument("--ats", nargs="+", help="restrict to these ATS types")
    ap.add_argument("--employer-ids", nargs="+", type=int,
                    help="restrict to these employer ids (overrides --min-lca)")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch + gate + score in memory; write nothing")
    args = ap.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
    rows, lca_by_emp, name_by_emp = select_focus_employers(
        args.min_lca, args.ats, args.employer_ids)
    n_emp = len({r["employer_id"] for r in rows})
    print(f"Focus set: {n_emp} employers, {len(rows)} ATS mappings "
          f"(lca_count_2025 > {args.min_lca}, {WINDOW_DAYS}d window)"
          f"{' [DRY RUN]' if args.dry_run else ''}", flush=True)

    # ── inline enrichment + batched writes ──────────────────────────────────────────
    # Details are fetched in parallel and merged into the rows IN MEMORY; finished rows are
    # staged in a basket and written to Supabase in batches of WRITE_BATCH instead of one trip
    # per job. Rows inside one upsert must share identical keys (PostgREST rejects mixed-key
    # arrays), so the basket is flushed in same-key groups.
    pool = ThreadPoolExecutor(max_workers=ENRICH_WORKERS)
    lock = threading.Lock()
    estats: Counter = Counter()
    basket: list[dict] = []                 # fully-enriched job rows awaiting one batched write
    basket_sigs: dict[tuple, tuple] = {}    # (ats_source, ats_job_id) -> scored signal fields

    _ENRICH_FIELDS = ("description_text", "salary_range", "salary_min_num",
                      "salary_max_num", "salary_period", "posted_at",
                      "department", "source_department")

    def _clean_row(r: dict) -> dict:
        # Drop EMPTY enrichment fields so an upsert never clobbers a previously enriched value
        # with NULL (the production 04 backfill stays safe).
        return {k: v for k, v in r.items() if v or k not in _ENRICH_FIELDS}

    def enrich_row_inplace(row: dict, slug: str) -> bool:
        """Fetch the job's detail page and merge description/salary/true posted_at into the
        in-memory row BEFORE it is ever written. Returns False when the enriched row fails a
        content gate (stale true date | not full-time | non-English) — the caller drops it, so
        nothing unenriched, stale, part-time, or non-English ever lands in the database."""
        row["enrich_attempted_at"] = datetime.now(timezone.utc).isoformat()
        icims = row["ats_source"] == "icims"
        icims_fields = None
        try:
            if icims:
                # iCIMS: the JSON-LD JobPosting is the authoritative source for title/location/
                # posted/description — the LIST page only exposes field LABELS glued to values.
                icims_fields = enr.detail_icims_fields(slug, row["ats_job_id"])
                html, posted = icims_fields["description_html"], icims_fields["posted"]
            else:
                det = DETAIL[row["ats_source"]](slug, row["ats_job_id"])
                # Length-tolerant: a detail fetcher MAY return a third element with the
                # ATS's department descriptor (oracle_hcm Category — its list API returns
                # the names as null). Stored raw; map_source_dept folds + restamps.
                html, posted = det[0], det[1]
                if len(det) > 2 and det[2] and not row.get("source_department"):
                    row["source_department"] = det[2]
                    if not row.get("department"):
                        dept = classify_department(row["title"], det[2])
                        if dept:
                            row["department"] = dept
        except Exception:
            with lock:
                estats["error"] += 1
            return True  # keep the row; enrich_attempted_at cools it down for 04's retry
        if posted:
            row["posted_at"] = posted
            dt = _parse_dt(posted)
            if dt is not None and dt < cutoff:
                with lock:
                    estats["stale_dropped"] += 1
                return False
        # Plain text drives gating/salary/scoring; for iCIMS it is NOT what we store.
        desc_text = strip_html(html)[:8000]
        if not desc_text:
            with lock:
                estats["no_desc"] += 1
            return True
        reason = content_gate(desc_text)
        if reason == "part_time":
            with lock:
                estats["parttime_dropped"] += 1
            return False
        if reason == "non_english":
            with lock:
                estats["lang_dropped"] += 1
            return False
        if icims and icims_fields:
            # Store the clean JSON-LD HTML (every UI surface renders description_text as HTML
            # when it carries tags) and overwrite the list-scraped "Title…"/"Location" junk,
            # re-deriving level/department/remote from the authoritative title.
            row["description_text"] = html[:24000] if html else desc_text
            title = icims_fields.get("title")
            if title:
                row["title"] = title
                row["job_level"] = classify_level(title)
                row["title_dept_strong"] = strong_title_department(title)
                dept = classify_department(title, row.get("source_department"))
                if dept:
                    row["department"] = dept
            if icims_fields.get("location"):
                row["location"] = icims_fields["location"]
            row["is_remote"] = detect_remote(
                title or row["title"], icims_fields.get("location") or row["location"])
        else:
            row["description_text"] = desc_text
        sal = parse_salary(html) or parse_salary(desc_text)
        if sal:
            row["salary_range"] = sal["display"]
            row["salary_min_num"] = sal["min_num"]
            row["salary_max_num"] = sal["max_num"]
            row["salary_period"] = sal["period"]
        with lock:
            estats["enriched"] += 1
            if sal:
                estats["salary"] += 1
        return True

    def flush_basket(force: bool = False):
        """One trip to the post office for ~WRITE_BATCH letters, not one per letter."""
        if not basket or (len(basket) < WRITE_BATCH and not force):
            return
        rows = basket[:]
        basket.clear()
        groups: dict[tuple, list[dict]] = {}
        for r in rows:
            groups.setdefault(tuple(sorted(r)), []).append(r)
        id_by_key: dict[tuple, int] = {}
        for g in groups.values():
            for i in range(0, len(g), WRITE_BATCH):
                chunk = g[i:i + WRITE_BATCH]
                try:
                    res = sb.table("jobs").upsert(
                        chunk, on_conflict="ats_source,ats_job_id").execute()
                    for w in res.data or []:
                        id_by_key[(w["ats_source"], w["ats_job_id"])] = w["id"]
                except Exception as e:
                    print(f"  ERROR jobs flush ({len(chunk)} rows) — {e}", flush=True)
        # Signals ride the ids the upsert just returned — no read-back query needed.
        sig_rows = []
        for key, jid in id_by_key.items():
            s = basket_sigs.pop(key, None)
            if s is not None:
                sig_rows.append({"job_id": jid, "confidence_tier": s[0],
                                 "no_sponsor_in_desc_flag": s[1], "title_clean": s[2],
                                 "title_employer_lca_count": s[3]})
        for i in range(0, len(sig_rows), WRITE_BATCH):
            try:
                sb.table("job_signals").upsert(
                    sig_rows[i:i + WRITE_BATCH], on_conflict="job_id").execute()
            except Exception as e:
                print(f"  ERROR signals flush — {e}", flush=True)
        estats["flushes"] += 1

    gate_stats: Counter = Counter()
    tier_stats: Counter = Counter()
    employers_with_jobs = 0
    total_kept = 0
    no_fetcher = 0

    run_start = time.monotonic()
    for idx, mapping in enumerate(rows):
        if time.monotonic() - run_start > RUN_DEADLINE_S:
            print(f"  RUN DEADLINE {RUN_DEADLINE_S}s reached after {idx}/{len(rows)} employers — "
                  f"stopping pull, proceeding to meta refresh + downstream steps", flush=True)
            break
        emp_id, ats, slug = mapping["employer_id"], mapping["ats_type"], mapping["slug"]
        fetcher = FETCHERS.get(ats)
        if not fetcher:
            no_fetcher += 1
            continue

        _alarm(EMPLOYER_BUDGET_S)
        try:
            raw_jobs = fetcher(slug)
        except EmployerTimeout:
            _alarm(0)
            print(f"  TIMEOUT {ats}:{slug} list-fetch >{EMPLOYER_BUDGET_S}s — skipping employer",
                  flush=True)
            continue
        except Exception as e:
            _alarm(0)
            print(f"  ERROR {ats}:{slug} — {e}", flush=True)
            continue
        _alarm(0)

        try:
            lca_titles, lca_counts = build_lca_index(sb, emp_id)
        except Exception as e:
            print(f"  ERROR lca_index emp={emp_id} — {e}", flush=True)
            lca_titles, lca_counts = set(), {}

        job_rows = []
        for j in raw_jobs:
            decision = list_gate(j, cutoff)
            if decision != "keep":
                gate_stats[decision] += 1
                continue
            # ATSes whose list payload already carries the description (Greenhouse/Lever/Ashby/
            # Workable/Amazon/jibe) can run the content gate now, before building the row.
            desc0 = j.get("description_text")
            if desc0:
                c = content_gate(desc0)
                if c:
                    gate_stats[c] += 1
                    continue
            range_str = j.get("salary_range")
            sal = parse_salary(range_str) if range_str else parse_salary(j.get("description_text") or "")
            job_rows.append({
                "employer_id": emp_id,
                "title": j["title"],
                "location": j["location"],
                "url": j["url"],
                "posted_at": j["posted_at"],
                "ats_source": ats,
                "ats_job_id": j["ats_job_id"],
                "description_text": j["description_text"],
                "salary_range": range_str or (sal["display"] if sal else None),
                "salary_min_num": sal["min_num"] if sal else None,
                "salary_max_num": sal["max_num"] if sal else None,
                "salary_period": sal["period"] if sal else None,
                "department": classify_department(j["title"], j.get("source_dept")),
                # Cached strong-title discipline (restamp COALESCEs it over the source_dept mapping).
                "title_dept_strong": strong_title_department(j["title"]),
                # Raw ATS department (source of truth) — map_source_dept.run_batch() folds it
                # into the unified jobs.department post-pull and re-stamps.
                "source_department": (j.get("source_dept") or None),
                "job_level": classify_level(j["title"]),
                "is_remote": detect_remote(j["title"], j["location"]),
                "is_active": True,
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
            })

        if not job_rows:
            print(f"  {ats}:{slug} → 0 kept "
                  f"({lca_by_emp.get(emp_id, 0)} LCA · {name_by_emp.get(emp_id, '')[:28]})", flush=True)
            continue
        job_rows = list({r["ats_job_id"]: r for r in job_rows}.values())
        employers_with_jobs += 1

        label = f"({lca_by_emp.get(emp_id, 0)} LCA · {name_by_emp.get(emp_id, '')[:28]})"
        if args.dry_run:
            for r in job_rows:
                tier, _flag, _tc, _lca = score_job(
                    r["title"], r.get("description_text") or "", lca_titles, lca_counts)
                tier_stats[tier] += 1
            total_kept += len(job_rows)
            print(f"  [dry] {ats}:{slug} → {len(job_rows)} keep {label}", flush=True)
            continue

        # Inline-enrich BEFORE the write: fetch detail pages in parallel and merge
        # description/salary/true posted_at into the in-memory rows. A job that fails a content
        # gate after enrichment (stale | part-time | non-English) is dropped here and never
        # written, so every row that reaches the database is already enriched and clean.
        dropped_ids: list[str] = []
        if ats in ENRICHABLE:
            need = [r for r in job_rows if not r.get("description_text")]
            if need:
                _alarm(EMPLOYER_BUDGET_S)
                try:
                    keep_flags = list(pool.map(lambda r: enrich_row_inplace(r, slug), need))
                except EmployerTimeout:
                    # Ceiling hit mid-enrich: keep every row (drop nothing), write what we have.
                    # Rows whose detail fetch never finished go in un-enriched; 04's backfill /
                    # the next pull completes them. A stuck pool worker is abandoned (see os._exit
                    # at shutdown — its leaked thread must not block the run from finishing).
                    keep_flags = [True] * len(need)
                    print(f"  TIMEOUT {ats}:{slug} enrich >{EMPLOYER_BUDGET_S}s — writing "
                          f"{len(job_rows)} rows (some un-enriched, 04 finishes them)", flush=True)
                finally:
                    _alarm(0)
                drop = {id(r) for r, ok in zip(need, keep_flags) if not ok}
                if drop:
                    dropped_ids = [r["ats_job_id"] for r in need if id(r) in drop]
                    job_rows = [r for r in job_rows if id(r) not in drop]
        total_kept += len(job_rows)

        # Score tiers against the now-present descriptions, stage rows in the basket, and write.
        for r in job_rows:
            tier, flag, tc, lca_count = score_job(
                r["title"], r.get("description_text") or "", lca_titles, lca_counts)
            tier_stats[tier] += 1
            basket_sigs[(ats, r["ats_job_id"])] = (tier, flag, tc, lca_count)
            basket.append(_clean_row(r))
        # Flush after EVERY employer (force), not only when the basket crosses WRITE_BATCH: jobs
        # land as each employer completes (visible progress) and a mid-run timeout can't lose a
        # large pooled basket. A big employer still chunks into WRITE_BATCH-sized writes inside.
        flush_basket(force=True)

        # Stale-mark: jobs no longer on the ATS → inactive (focus-set only, batched).
        try:
            fresh_ids = {j["ats_job_id"] for j in raw_jobs}
            active = (sb.table("jobs").select("id,ats_job_id")
                      .eq("employer_id", emp_id).eq("ats_source", ats)
                      .eq("is_active", True).execute())
            stale = [row["id"] for row in active.data if row["ats_job_id"] not in fresh_ids]
            if stale:
                sb.table("jobs").update({"is_active": False}).in_("id", stale).execute()
        except Exception as e:
            print(f"  ERROR stale-mark {ats}:{slug} — {e}", flush=True)

        # The enrich step proved these list-visible jobs are stale / part-time / non-English. If
        # a previous run already stored them, deactivate them — one batched call, not one per job.
        if dropped_ids:
            try:
                (sb.table("jobs").update({"is_active": False})
                   .eq("employer_id", emp_id).eq("ats_source", ats)
                   .in_("ats_job_id", dropped_ids).execute())
            except Exception as e:
                print(f"  ERROR drop-deactivate {ats}:{slug} — {e}", flush=True)

        print(f"  {ats}:{slug} → {len(job_rows)} jobs {label}", flush=True)
        time.sleep(0.5)

    # wait=False: a worker abandoned by an enrich timeout may still be stuck in a socket/DNS read.
    # We must NOT block on it here — the run's writes are already committed per-employer. The
    # entrypoint's os._exit(0) tears the process down without joining any leaked thread.
    pool.shutdown(wait=False)
    flush_basket(force=True)  # write whatever is left in the basket
    if not args.dry_run:
        _refresh_job_stats()
    _digest(args, n_emp, total_kept, employers_with_jobs, no_fetcher, gate_stats, tier_stats, estats)


def _refresh_job_stats():
    """Refresh the /jobs meta counts (job_stats → loadMeta → the "X new jobs last 3 days ·
    Y total jobs" line). The retired 03_pull_jobs.py used to own this; now this puller does.

      total_count     = ALL jobs, active AND inactive (no is_active filter — per product ask)
      three_day_count = jobs scraped in the last 3 days   ("up to date" — active + inactive)
      week_count      = jobs scraped in the last 7 days

    NOTE: the landing page total (stats_shelf, refreshed by the Vercel cron
    /api/cron/refresh-stats) and /me/job-matches (live search RPC) read DIFFERENT sources —
    they are not job_stats and are unaffected here. Wrapped so a COUNT timeout (57014) on the
    full table can never fail the pull."""
    try:
        now = datetime.now(timezone.utc)
        d3 = (now - timedelta(days=3)).isoformat()
        d7 = (now - timedelta(days=7)).isoformat()
        total = sb.table("jobs").select("id", count="exact").limit(1).execute().count or 0
        three = (sb.table("jobs").select("id", count="exact")
                 .gte("scraped_at", d3).limit(1).execute().count or 0)
        week = (sb.table("jobs").select("id", count="exact")
                .gte("scraped_at", d7).limit(1).execute().count or 0)
        sb.table("job_stats").upsert({
            "id": 1,
            "total_count": total,         # active + inactive
            "three_day_count": three,
            "week_count": week,
            "updated_at": now.isoformat(),
        }).execute()
        print(f"job_stats updated — total(all)={total}  3-day={three}  7-day={week}", flush=True)
    except Exception as e:
        print(f"  ERROR job_stats refresh — {e}", flush=True)

    # Landing-page hero stats (stats_shelf) — refresh here too. Its Vercel cron
    # (/api/cron/refresh-stats) is the 5th cron entry and Vercel Hobby honors only 2, so it had
    # gone stale; riding the reliable daily pull keeps it current regardless of the Vercel cap.
    try:
        sb.rpc("refresh_stats_shelf").execute()
        print("stats_shelf refreshed (landing page hero)", flush=True)
    except Exception as e:
        print(f"  ERROR stats_shelf refresh — {e}", flush=True)


def _digest(args, n_emp, total_kept, employers_with_jobs, no_fetcher, gate_stats, tier_stats, estats):
    line = "─" * 64
    print(f"\n{line}\nDIGEST — best-of-both pull (lca>{args.min_lca}, {WINDOW_DAYS}d)"
          f"{'  [DRY RUN]' if args.dry_run else ''}\n{line}", flush=True)
    print(f"  employers in focus set    {n_emp}", flush=True)
    print(f"  with ≥1 job this run      {employers_with_jobs}", flush=True)
    print(f"  skipped (no fetcher)      {no_fetcher}", flush=True)
    print(f"  jobs kept                 {total_kept}", flush=True)
    print(f"  gate drops (list)         non_us={gate_stats['non_us']}  "
          f"occupation={gate_stats['occupation']}  part_time={gate_stats['part_time']}  "
          f"stale={gate_stats['stale']}  non_english={gate_stats['non_english']}", flush=True)
    print(f"  tier split (kept)         verified={tier_stats['verified']}  "
          f"friendly={tier_stats['friendly']}  excluded={tier_stats['excluded']}", flush=True)
    if not args.dry_run:
        print(f"  inline enrich             enriched={estats['enriched']}  salary={estats['salary']}  "
              f"stale_dropped={estats['stale_dropped']}", flush=True)
        print(f"  enrich drops              part_time={estats['parttime_dropped']}  "
              f"non_english={estats['lang_dropped']}  no_desc={estats['no_desc']}  "
              f"errors={estats['error']}  batched writes={estats['flushes']}", flush=True)
    print(line, flush=True)


if __name__ == "__main__":
    main()
    # A worker thread abandoned by an enrich timeout (stuck in a socket/DNS read Python can't
    # kill) would otherwise block ThreadPoolExecutor's atexit join and hang the process forever —
    # exactly the failure this whole change exists to prevent, just relocated to exit. The work is
    # done and committed, so flush stdout and tear the process down hard with a success code.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
