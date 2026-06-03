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
DEPARTMENTS = ["Product", "Engineering", "Data", "Design", "Sales", "Marketing",
               "Finance", "Security"]

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


# ── Department keywords (priority order: specific before the "engineer" catch-all) ─
_DEPT_KEYWORDS: dict[str, list[str]] = {
    "Data":        ["data scientist", "data engineer", "data analyst", "ml engineer",
                    "machine learning", "analytics", "data science", "data architect"],
    "Security":    ["security", "infosec", "cybersecurity", "soc analyst", "appsec"],
    "Design":      ["designer", "ux", "product design", "user experience", "ui/ux", "ux/ui"],
    "Product":     ["product manager", "product owner", "head of product", "product lead"],
    "Finance":     ["finance", "financial", "accounting", "accountant", "controller", "cfo"],
    "Marketing":   ["marketing", "growth", "seo", "content marketing", "brand"],
    "Sales":       ["sales", "account executive", "account manager", "business development",
                    "revenue"],
    "Engineering": ["engineer", "developer", "swe", "software", "backend", "back end",
                    "frontend", "front end", "full stack", "fullstack", "devops", "platform",
                    "infrastructure", "sre", "programmer", "architect"],
}
_DEPT_PRIORITY = ["Data", "Security", "Design", "Product", "Finance", "Marketing", "Sales",
                  "Engineering"]


def classify_department(title: str | None, source_dept: str | None = None) -> str | None:
    """Title (+ optional source department hint) → canonical department, or None."""
    t = title or ""
    ov = _override(t, "department")
    if ov is not None:
        return ov or None
    # Strip noisy numeric prefixes from source dept (Greenhouse: "7112 Data Science").
    hint = re.sub(r"^\s*\d+\s+", "", source_dept or "")
    hay = f"{t} {hint}".lower()
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
    ]
    for title, sd in samples:
        print(f"{title!r:45} level={classify_level(title)!r:16} "
              f"dept={classify_department(title, sd)!r}")
