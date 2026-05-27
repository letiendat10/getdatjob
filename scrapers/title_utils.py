"""
Shared job title normalization.
clean_title("Senior Software Engineer - Firmware") → "Software Engineer"
clean_title("Manager JC50 - Computer Systems Engineers/Architects") → "Computer Systems Engineers"
clean_title("Vice President, Lead Software Engineer") → "Software Engineer"
"""

from __future__ import annotations
import re

# Words that indicate the token is a seniority/level modifier, not the role
_LEVEL_WORDS = frozenset({
    "principal", "associate", "senior", "sr", "junior", "jr",
    "lead", "staff", "vp", "manager", "specialist", "president",
    "analyst", "consultant", "director",
})

# VP-style bank titles: "Vice President, <real title>"
_VP_PREFIX = re.compile(
    r"^(vice\s+president|senior\s+vice\s+president|assistant\s+vice\s+president|svp|avp|vp)[,;]\s*",
    re.I,
)

# "MTS 1, Software Engineer" → "Software Engineer"
_MTS_PREFIX = re.compile(r"^mts\s+\d+[,\s]+", re.I)

# Internal level codes embedded in title (Deloitte, Accenture)
_INTERNAL_CODE = re.compile(r"\s*(JC\d+|SMTS|LMTS|PMTS|MTS\b)\s*", re.I)

# Seniority prefixes — only at the START of the string
_SENIORITY_PREFIX = re.compile(
    r"^(senior|sr\.?\s+|junior|jr\.?\s+|lead\s+|staff\s+|principal\s+|"
    r"associate\s+|mid[- ]?level\s+|entry[- ]?level\s+|advanced\s+|"
    r"distinguished\s+|founding\s+|head\s+of\s+)",
    re.I,
)

# Level suffix: roman numerals or digits at the end
_LEVEL_SUFFIX = re.compile(r"\s+(i{1,4}|iv|vi{0,3}|[1-9])$", re.I)

_SLASH = re.compile(r"\s*/\s*.+$")
_PARENS = re.compile(r"\s*\([^)]*\)")
_WHITESPACE = re.compile(r"\s+")


def _choose_dash_side(title: str) -> str:
    """
    For 'X - Y' (spaces required around dash), return left unless left contains
    an internal level code (Deloitte-style 'Manager JC50 - Computer Systems Engineers'),
    in which case return right (the actual SOC job description).
    Compound words like 'Post-Doctoral' or 'Front-End' are intentionally left alone
    because they have no spaces around the hyphen.
    """
    m = re.match(r"^(.+?)\s+[-–]\s+(.+)$", title)
    if not m:
        return title
    left, right = m.group(1).strip(), m.group(2).strip()
    if re.search(r"\b(JC\d+|SMTS|LMTS|PMTS|SA\b|AD\b|MTS\b)\b", left, re.I):
        return right
    return left


def _handle_comma(title: str) -> str:
    """
    'Associate, Software Engineer III' → 'Software Engineer III'  (level word before comma)
    'Software Engineer, Machine Learning' → 'Software Engineer'   (real title before comma)
    Only flips when the part before the comma is ≤2 words AND the last word is a level word.
    """
    if "," not in title:
        return title
    before, _, after = title.partition(",")
    before, after = before.strip(), after.strip()
    if not after:
        return before
    words_before = before.split()
    if not words_before:   # title starts with a comma — take the part after it
        return after
    last_word = words_before[-1].lower().rstrip(".")
    if len(words_before) <= 2 and last_word in _LEVEL_WORDS:
        return after
    return before


def clean_title(title: str) -> str:
    if not title:
        return ""
    t = title.strip()

    # 1. VP / bank-title prefix
    t = _VP_PREFIX.sub("", t)
    # 2. MTS level prefix
    t = _MTS_PREFIX.sub("", t)
    # 3. Decide which side of dash to keep (check codes BEFORE stripping them)
    t = _choose_dash_side(t)
    # 4. Strip internal level codes from within the chosen side
    t = _INTERNAL_CODE.sub(" ", t)
    # 5. Strip slash qualifiers ("Engineer/Developer" → "Engineer")
    t = _SLASH.sub("", t)
    # 6. Handle comma (flip or strip qualifier)
    t = _handle_comma(t)
    # 7. Strip parentheticals
    t = _PARENS.sub("", t)
    # 8. Strip seniority prefix (up to 2 passes for "Senior Principal X")
    for _ in range(2):
        stripped = _SENIORITY_PREFIX.sub("", t.strip())
        if stripped == t.strip():
            break
        t = stripped
    # 9. Strip level suffix
    t = _LEVEL_SUFFIX.sub("", t.strip())
    # 10. Normalize whitespace, title-case
    t = _WHITESPACE.sub(" ", t).strip().title()
    return t or title.strip().title()


# ---------------------------------------------------------------------------
# Auto-verification helper used by 07_title_review_sheet.py
# ---------------------------------------------------------------------------

def auto_verified_reason(original: str, clean: str) -> str:
    """
    Returns a short reason string if the transformation from `original` to
    `clean` can be explained solely by seniority-prefix stripping, level-suffix
    stripping, and/or case normalisation.

    Returns '' if any other rule fired (separator, comma-flip, VP prefix, etc.)
    — those rows need manual review on the sheet.

    Values: 'case only' | 'seniority' | 'level' | 'seniority + level' | ''
    """
    t = original.strip()
    parts = []

    # seniority prefix (up to 2 passes)
    for _ in range(2):
        stripped = _SENIORITY_PREFIX.sub("", t.strip())
        if stripped != t.strip():
            if "seniority" not in parts:
                parts.append("seniority")
        t = stripped.strip()

    # level suffix
    stripped = _LEVEL_SUFFIX.sub("", t)
    if stripped != t:
        parts.append("level")
    t = stripped

    # case + whitespace normalisation only
    t_final = _WHITESPACE.sub(" ", t).strip().title()
    if t_final == clean:
        return " + ".join(parts) if parts else "case only"
    return ""


# ---------------------------------------------------------------------------
# LCA index helpers used by 03_pull_jobs.py
# ---------------------------------------------------------------------------

def build_lca_index(sb, employer_id: int) -> tuple[set[str], dict[str, int]]:
    """
    Returns:
        titles   – set of clean titles filed by this employer in last 12 months
        counts   – {clean_title: filing_count}
    """
    from datetime import date, timedelta
    cutoff = (date.today() - timedelta(days=365 * 3)).isoformat()
    rows = (
        sb.table("lca_filings")
        .select("job_title_clean")
        .eq("employer_id", employer_id)
        .gte("received_date", cutoff)
        .not_.is_("job_title_clean", "null")
        .execute()
        .data
    )
    counts: dict[str, int] = {}
    for r in rows:
        tc = r["job_title_clean"]
        if tc:
            counts[tc] = counts.get(tc, 0) + 1
    return set(counts.keys()), counts
