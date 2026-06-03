"""classify.py — derive department, job_level and remote flag from a job title.

Single source of truth for the canonical department + level taxonomies used by the
search filters. Imported by:
  * 03_pull_jobs.py        — classify each job at scrape time
  * backfill_classify.py   — one-time pass over existing rows
  * 07_title_review_sheet.py — pre-fill the human review sheet

Human corrections from the review sheet are stored in
data/classification_overrides.json and win over the keyword heuristics, so a vetted
title always classifies the way the reviewer decided.

Level taxonomy (5 buckets, low → high):
    Entry/Junior → Senior → Lead/Manager → Director → VP
Plain mid-level ICs ("Software Engineer") classify as None == "any level".
"""
from __future__ import annotations

import json
import os
import re

from title_utils import clean_title

# ── Canonical taxonomies ──────────────────────────────────────────────────────
LEVELS = ["Entry/Junior", "Senior", "Lead/Manager", "Director", "VP"]
# 15 canonical departments — matches the /jobs filter UI exactly, so the stored column
# and the filter agree. Priority order (specific → the "engineer" catch-all) lives in
# _DEPT_KEYWORDS below; DEPARTMENTS is the allowed-value set.
DEPARTMENTS = ["AI / ML", "Data", "Security", "Design", "Product", "Finance", "Legal",
               "HR / People", "Customer Success", "Marketing/Growth", "Sales",
               "Platform / DevOps", "Facilities", "Operations", "Engineering"]

# ── Level keyword ladder (highest match wins; checked top-to-bottom) ───────────
_RX_VP = re.compile(
    r"\b(svp|evp|vp|vice\s+president|chief|ceo|cto|cfo|coo|cmo|cpo|cro|cio|cdo)\b", re.I)
_RX_DIRECTOR = re.compile(r"\bdirector\b|\bhead\s+of\b", re.I)
# Manager: explicit manager/supervisor words, or "<role> lead" / leading "lead "
_RX_MANAGER = re.compile(
    r"\b(manager|mgr|supervisor)\b"
    r"|\b(team|tech|technical|engineering|eng|group|squad|project|delivery|program|"
    r"product|design|data|qa|it|dev)\s+lead\b"
    r"|^lead\s+(?!gen)", re.I)  # "Lead Engineer" yes; "Lead Generation Specialist" no
# Senior-most ICs (no dedicated Staff/Principal bucket → fold into Senior)
_RX_SENIOR = re.compile(r"\b(senior|sr\.?|staff|principal|distinguished|fellow)\b", re.I)
_RX_ENTRY = re.compile(
    r"\b(intern|internship|junior|jr\.?|associate|entry[- ]?level|new\s*grad|graduate|"
    r"apprentice|trainee|co[- ]?op|early\s+career)\b", re.I)


def classify_level(title: str | None) -> str | None:
    """Raw title → one of LEVELS, or None for untagged mid-level/IC roles."""
    t = title or ""
    ov = _override(t, "job_level")
    if ov is not None:
        return ov or None
    if _RX_VP.search(t):
        return "VP"
    if _RX_DIRECTOR.search(t):
        return "Director"
    if _RX_MANAGER.search(t):
        return "Lead/Manager"
    if _RX_SENIOR.search(t):
        return "Senior"
    if _RX_ENTRY.search(t):
        return "Entry/Junior"
    return None


# ── Department keywords ───────────────────────────────────────────────────────
# Dict insertion order IS the match priority (specific depts before the "engineer"
# catch-all). Matched as substrings against a space-padded lowercased haystack, so
# boundary tokens (" ai ", " ml ", " hr ", " ops", " pm ", " cx ") are written with
# the spaces they need. Ported from the /jobs DEPT_PATTERNS so column == filter.
_DEPT_KEYWORDS: dict[str, list[str]] = {
    "AI / ML":           ["machine learning", "deep learning", "artificial intelligence",
                          " ai ", "ai/ml", " ml ", "ml engineer", "mlops", "nlp", "llm",
                          "research scientist", "applied scientist"],
    "Data":              ["data engineer", "data scientist", "data analyst", "data science",
                          "data architect", "analytics", "business intelligence", " bi "],
    "Security":          ["security", "infosec", "cybersecurity", "appsec", "devsecops",
                          "soc analyst"],
    "Design":            ["designer", "design", " ux", "ux ", " ui", "ui ",
                          "user experience", "user research"],
    "Product":           ["product manager", "product owner", "product lead",
                          "product management", "head of product", " pm "],
    "Finance":           ["finance", "financial", "accounting", "accountant", "controller",
                          "fp&a", "treasury", "bookkeep"],
    "Legal":             ["legal", "counsel", "attorney", "lawyer", "paralegal", "compliance"],
    "HR / People":       ["recruit", "talent acquisition", "human resources", " hr ",
                          "people ops", "people operations", "people partner", "hrbp"],
    "Customer Success":  ["customer success", "customer support", "customer experience",
                          "account manager", " cx ", "support engineer", "client success"],
    "Marketing/Growth":  ["marketing", "growth", "seo", "brand", "demand generation",
                          "communications", "social media", "content "],
    "Sales":             ["sales", "account executive", "business development", "revenue",
                          " sdr", " bdr"],
    "Platform / DevOps": ["devops", "site reliability", " sre", "platform engineer",
                          "infrastructure", "cloud engineer", "reliability engineer"],
    "Facilities":        ["facilities", "mailroom", "real estate", "workplace", "janitorial",
                          "custodial", "maintenance tech"],
    "Operations":        ["operations", " ops", "logistics", "supply chain", "fulfillment",
                          "warehouse", "procurement"],
    "Engineering":       ["engineer", "developer", "swe", "software", "back end", "backend",
                          "front end", "frontend", "full stack", "fullstack", "programmer",
                          "architect", "sdet", "firmware", "embedded"],
}
_DEPT_PRIORITY = list(_DEPT_KEYWORDS)  # dict preserves insertion (= priority) order


def classify_department(title: str | None, source_dept: str | None = None) -> str | None:
    """Title (+ optional source department hint) → canonical department, or None."""
    t = title or ""
    ov = _override(t, "department")
    if ov is not None:
        return ov or None
    # Strip noisy numeric prefixes from source dept (Greenhouse: "7112 Data Science").
    hint = re.sub(r"^\s*\d+\s+", "", source_dept or "")
    # Pad so boundary keywords (" ai ", " ml ", " hr ", " ops", " pm ") match at the edges.
    hay = f" {t} {hint} ".lower()
    for dept in _DEPT_PRIORITY:
        if any(kw in hay for kw in _DEPT_KEYWORDS[dept]):
            return dept
    return None


# ── Remote detection ──────────────────────────────────────────────────────────
_RX_REMOTE = re.compile(
    r"\b(remote|work\s+from\s+home|wfh|distributed|anywhere|telecommute|virtual)\b", re.I)


def detect_remote(title: str | None, location: str | None) -> bool:
    return bool(_RX_REMOTE.search(f"{location or ''} {title or ''}"))


# ── Human-review overrides ──────────────────────────────────────────────────────
# data/classification_overrides.json: { "<lowercased raw title>": {"department": "...",
#                                       "job_level": "..."} }
_OVERRIDES_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data", "classification_overrides.json")
_overrides: dict[str, dict[str, str]] | None = None


def _load_overrides() -> dict[str, dict[str, str]]:
    global _overrides
    if _overrides is None:
        try:
            with open(_OVERRIDES_PATH, encoding="utf-8") as f:
                _overrides = json.load(f)
        except (FileNotFoundError, ValueError):
            _overrides = {}
    return _overrides


def _override(title: str, field: str) -> str | None:
    """Return the override value for this title+field, or None if none exists.
    An empty string in the map means 'reviewer set it to none' and is returned as ''."""
    row = _load_overrides().get((title or "").strip().lower())
    if row is None:
        return None
    return row.get(field)  # str | None


def merge_db_overrides(rows) -> None:
    """Merge human title reviews (public.title_reviews rows) over the JSON seed so a
    review instantly governs classification across daily pulls + backfills. Call once at
    scraper startup, e.g.::

        merge_db_overrides(sb.table("title_reviews")
                             .select("title_norm,department,job_level").execute().data)

    Only non-null fields override; a review that touched only title_clean leaves the
    keyword heuristic in charge of dept/level."""
    ov = _load_overrides()
    for r in rows or []:
        key = (r.get("title_norm") or "").strip().lower()
        if not key:
            continue
        entry = {k: r[k] for k in ("department", "job_level") if r.get(k) is not None}
        if entry:
            ov[key] = {**ov.get(key, {}), **entry}


if __name__ == "__main__":
    samples = [
        ("Senior Software Engineer", None),
        ("Engineering Manager", None),
        ("Staff Data Scientist", None),
        ("VP of Product", None),
        ("Associate Director, Finance", None),
        ("Junior UX Designer", None),
        ("Software Engineer", None),
        ("Lead Generation Specialist", None),  # must NOT be Lead/Manager
        ("Principal Security Engineer", None),
        ("Sr. Account Executive", None),
        ("Data Engineer", "7112 Data Science"),
        ("Machine Learning Engineer", None),   # AI / ML
        ("Research Scientist", None),          # AI / ML
        ("Site Reliability Engineer", None),   # Platform / DevOps
        ("DevOps Engineer", None),             # Platform / DevOps (not Operations)
        ("Technical Recruiter", None),         # HR / People
        ("Customer Success Manager", None),    # Customer Success (not Sales)
        ("Corporate Counsel", None),           # Legal
        ("Growth Marketing Manager", None),    # Marketing/Growth
        ("Supply Chain Analyst", None),        # Operations
        ("Facilities Coordinator", None),      # Facilities
        ("Account Manager", None),             # Customer Success (not Sales/Finance)
        ("HR Business Partner", None),         # HR / People
    ]
    for title, sd in samples:
        print(f"{title!r:45} level={classify_level(title)!r:16} "
              f"dept={classify_department(title, sd)!r}")
