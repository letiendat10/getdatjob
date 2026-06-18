#!/usr/bin/env python3
"""map_source_dept.py — raw ATS department (source_dept) -> unified department.

The ATS's own department string (Greenhouse departments[].name, Lever
categories.department, Workday jobFamilyGroup, Amazon job_category, SmartRecruiters
function.label, ...) is the right signal for "department" (where a role sits in the org).
A job *title* is the occupation axis, not the department — which is why title-only
classification left ~62% of jobs with no department.

Raw values are messy ("Sales & Partnerships", "534 In-Store Sales", "RN Medical Center"),
so we fold each DISTINCT normalized raw value into ONE unified department, cached in
public.dept_mapping (curated rule -> llm -> human; human wins).

Entry points
------------
* resolve_department(source_dept, title, mapping)  — inline at pull (no LLM):
    seen-before mapping -> keyword rule on the ATS department -> keyword rule on the title.
* run_batch(sb)  — post-pull: map every DISTINCT unmapped source_department
    (rule -> LLM), upsert dept_mapping, re-stamp jobs.department, refresh counts.

norm() mirrors SQL public.dept_norm() exactly — keep the two in sync.
"""
import os
import re
import json

from classify import classify_department, DEPARTMENTS

_NUM_PREFIX = re.compile(r"^[0-9]+\s*[-–:]?\s*")
_WS = re.compile(r"\s+")


def norm(s):
    """Mirror of SQL public.dept_norm(): lower, strip a leading numeric code, collapse ws."""
    if not s:
        return None
    s = _NUM_PREFIX.sub("", s.lower())
    s = _WS.sub(" ", s).strip()
    return s or None


_SEG_SPLIT = re.compile(r"[,&/]|\band\b", re.I)

# A raw ATS value that IS a canonical bucket name ("Design", "Engineering", "HR / People")
# maps to itself — keyword heuristics (which dropped bare "design" for title safety) and
# the compound guard must not get a veto. Keyed slash-collapsed to absorb "AI/ML" vs "AI / ML".
_CANON_EXACT = {re.sub(r"\s*/\s*", "/", d.lower()): d for d in DEPARTMENTS}

_CAMEL = re.compile(r"[a-z][A-Z]")        # "tvScientific" — a brand/product, not a department
_NUM_CODE = re.compile(r"^\s*\d+\s+\S")   # "635 DDfB" — an internal req code prefix


def _is_junk_source(raw):
    """True when a source_department is a company/product name or internal req code, not a
    real org unit. We skip mapping these (leave them unmapped → the job falls back to title
    classification) instead of letting the LLM hallucinate a bucket — e.g. 'tvScientific'
    (a Pinterest business unit) was mapped to Marketing, mislabeling every SDET/SRE there.
    A value with ANY real department keyword signal is never junk (so 'iOS Engineering',
    'Stores' survive)."""
    s = (raw or "").strip()
    if not s:
        return True
    if classify_department(s, None):
        return False
    return bool(_CAMEL.search(s) or _NUM_CODE.match(s))


def _rule(text):
    """Keyword-classify a raw string (department or title) to ONE canonical bucket, or None.

    Compound guard: org buckets like "Operations, IT, & Support Engineering" name several
    departments at once — first-keyword-wins picks whichever bucket outranks the rest (that
    once stamped 2k data-center technicians "Customer Success"). When the comma/&/slash/and
    segments classify to DIFFERENT buckets, return None and defer to the LLM/human pass.
    """
    n = norm(text)
    if n and re.sub(r"\s*/\s*", "/", n) in _CANON_EXACT:
        return _CANON_EXACT[re.sub(r"\s*/\s*", "/", n)]
    hit = classify_department(text or "", None)
    if not hit:
        return None
    segs = [s.strip() for s in _SEG_SPLIT.split(text or "") if s.strip()]
    if len(segs) > 1:
        seg_hits = {h for h in (classify_department(s, None) for s in segs) if h}
        if len(seg_hits) > 1:
            return None
    return hit


def resolve_department(source_dept, title, mapping):
    """Inline resolver used at pull time (no LLM). Returns a unified department or None.
    Order: seen-before mapping -> keyword rule on the ATS department -> rule on the title."""
    n = norm(source_dept)
    if n and n in mapping:
        return mapping[n]
    if n:
        hit = _rule(source_dept)
        if hit:
            return hit
    return _rule(title)


def load_mapping(sb):
    """{source_norm: unified_department} from dept_mapping (paginated past the 1k cap)."""
    out, start, page = {}, 0, 1000
    while True:
        rows = (sb.table("dept_mapping")
                  .select("source_norm,unified_department")
                  .range(start, start + page - 1).execute().data) or []
        for r in rows:
            out[r["source_norm"]] = r["unified_department"]
        if len(rows) < page:
            break
        start += page
    return out


# ── LLM fallback — only for distinct values the rule pass can't place ──────────────
def _load_anthropic_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return True
    # mirror 00_quarterly_intake.py: pull the key from web/.env.local when running locally
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", ".env.local")
    try:
        with open(p) as f:
            for line in f:
                if line.startswith("ANTHROPIC_API_KEY=") and not line.startswith("#"):
                    os.environ["ANTHROPIC_API_KEY"] = line.split("=", 1)[1].strip()
                    break
    except FileNotFoundError:
        pass
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _llm_classify(samples):
    """samples: list[str] raw department values -> {raw: unified_department}.
    Uses the canonical buckets, or proposes a concise new bucket when none fit."""
    if not samples or not _load_anthropic_key():
        return {}
    import anthropic
    client = anthropic.Anthropic()
    vocab = ", ".join(DEPARTMENTS)
    prompt = (
        "Map each raw company department / job-family string to ONE department bucket.\n"
        f"Prefer these buckets: {vocab}.\n"
        "If none reasonably fit (e.g. healthcare, manufacturing, skilled trades, education), "
        "return a concise Title Case bucket of your own. A department is WHERE a role sits in "
        "the org, not the job title.\n"
        "Return ONLY a JSON object mapping each exact input string to its bucket.\n\n"
        f"Inputs:\n{json.dumps(samples, ensure_ascii=False)}"
    )
    try:
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        if text.startswith("```"):  # tolerate ```json fences
            text = text.strip("`")
            text = text[4:].strip() if text.lower().startswith("json") else text
        return json.loads(text)
    except Exception as e:
        print(f"  LLM classify failed ({e}) — leaving these unmapped this run", flush=True)
        return {}


def run_batch(sb, *, use_llm=True, queue_limit=5000, llm_chunk=60):
    """Map distinct unmapped source departments, upsert dept_mapping, re-stamp jobs.

    Idempotent and resumable: the queue is only the values not already in dept_mapping,
    so human/earlier rows are never touched. Re-stamp runs in bounded batches (no 57014).
    """
    queue = sb.rpc("unmapped_source_depts", {"p_limit": queue_limit}).execute().data or []
    rows, llm_pending, junk = [], [], 0
    for q in queue:
        if _is_junk_source(q["sample_raw"]):
            junk += 1
            continue  # company/product name or req code — leave unmapped, title classifies
        hit = _rule(q["sample_raw"])
        if hit:
            rows.append({"source_norm": q["source_norm"], "unified_department": hit,
                         "mapped_by": "rule", "sample_raw": q["sample_raw"], "n_jobs": q["n_jobs"]})
        else:
            llm_pending.append(q)

    if use_llm and llm_pending:
        for i in range(0, len(llm_pending), llm_chunk):
            chunk = llm_pending[i:i + llm_chunk]
            res = _llm_classify([q["sample_raw"] for q in chunk])
            # The model sometimes normalizes its echo of an input key ("&" -> "and",
            # comma/space tweaks), so exact-key lookups miss and the same values re-queue
            # every night. Match on norm() of the returned keys too, and log what's left.
            res_norm = {norm(k): v for k, v in res.items() if isinstance(k, str) and norm(k)}
            matched = set()
            for q in chunk:
                u = res.get(q["sample_raw"]) or res_norm.get(q["source_norm"])
                unified = u.strip() if isinstance(u, str) else ""
                if unified and len(unified) <= 60:
                    matched.add(q["source_norm"])
                    rows.append({"source_norm": q["source_norm"], "unified_department": unified,
                                 "mapped_by": "llm", "sample_raw": q["sample_raw"], "n_jobs": q["n_jobs"]})
            misses = [q["sample_raw"] for q in chunk if q["source_norm"] not in matched]
            if res and misses:
                print(f"  LLM chunk: {len(misses)} inputs unmatched in the reply: "
                      f"{misses[:5]}{'…' if len(misses) > 5 else ''}", flush=True)

    # Insert new mappings. on_conflict is a no-op safety against in-batch dupes; the queue
    # already excludes mapped source_norms, so existing (incl. human) rows are never altered.
    for i in range(0, len(rows), 500):
        sb.table("dept_mapping").upsert(rows[i:i + 500], on_conflict="source_norm").execute()
    n_rule = sum(1 for r in rows if r["mapped_by"] == "rule")
    print(f"map_source_dept: mapped {len(rows)} new values ({n_rule} rule, {len(rows) - n_rule} llm); "
          f"{len(llm_pending) - (len(rows) - n_rule)} still unmapped; {junk} junk skipped", flush=True)
    # Governance signal: any unified bucket the LLM coined outside the canonical seed is a
    # candidate new department — surface it for owner review in /admin/departments.
    new_buckets = sorted({r["unified_department"] for r in rows} - set(DEPARTMENTS))
    if new_buckets:
        print(f"map_source_dept: NEW buckets proposed (review at /admin/departments): {new_buckets}", flush=True)

    # Re-stamp jobs.department from the mapping, in bounded batches; then refresh counts.
    total = 0
    while True:
        n = sb.rpc("restamp_department", {"p_batch": 5000}).execute().data or 0
        total += n
        if not n:
            break
    sb.rpc("refresh_dept_mapping_counts").execute()
    print(f"map_source_dept: re-stamped {total} jobs", flush=True)
    return {"mapped": len(rows), "restamped": total}


if __name__ == "__main__":
    from supabase import create_client
    from config import SUPABASE_URL, SUPABASE_KEY
    run_batch(create_client(SUPABASE_URL, SUPABASE_KEY))
