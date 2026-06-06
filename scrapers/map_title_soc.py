#!/usr/bin/env python3
"""map_title_soc.py — job title -> DOL SOC occupation, for the H-1B verified tag.

A job is "verified" when the occupation (SOC) its title maps to is one its employer has
actually sponsored (lca_filings.soc_code, 3y; see public.employer_soc + public.restamp_soc).
Exact title-string matching only ever verified ~26% of titles; mapping the title to an
occupation and matching on the SOC code lifts the tag toward employer-level truth.

Mirrors scrapers/map_source_dept.py: fold each DISTINCT job title_clean into ONE SOC
(curated rule -> llm -> human; human wins), cached in public.title_soc_map; then re-stamp
job_signals.soc_code and upgrade friendly -> verified in bounded batches (restamp_soc).

Entry points
------------
* resolve_soc(title, mapping) — inline lookup (no LLM): seen-before mapping -> keyword rule.
* run_batch(sb)             — post-pull: map every DISTINCT unmapped title_clean
    (rule -> LLM), upsert title_soc_map, re-stamp + verify, refresh counts.
"""
import os
import re
import json

# Minimal, high-confidence keyword rules (the LLM handles everything else). Keep these
# CONSERVATIVE — a wrong rule overrides silently. Each value is (soc_code, soc_name).
_RULES = [
    (re.compile(r"\b(software\s+(engineer|developer)|software\s+development\s+engineer|swe|"
                r"full[\s-]?stack|back[\s-]?end\s+engineer|front[\s-]?end\s+engineer)\b", re.I),
     ("15-1252.00", "Software Developers")),
    (re.compile(r"\bdata\s+scientist\b", re.I), ("15-2051.00", "Data Scientists")),
]

# O*NET-SOC form, e.g. "15-1252.00" (detail optional). Validates LLM output before we trust it.
_SOC_RE = re.compile(r"^\d{2}-\d{4}(\.\d{2})?$")


def _rule_soc(title):
    """Keyword-classify a title to a (soc_code, soc_name), or None."""
    for rx, soc in _RULES:
        if rx.search(title or ""):
            return soc
    return None


def resolve_soc(title_clean, mapping):
    """Inline resolver (no LLM). Returns soc_code or None.
    Order: seen-before mapping -> keyword rule on the title."""
    if title_clean and title_clean in mapping:
        return mapping[title_clean]
    hit = _rule_soc(title_clean)
    return hit[0] if hit else None


def load_mapping(sb):
    """{title_clean: soc_code} from title_soc_map (paginated past the 1k cap)."""
    out, start, page = {}, 0, 1000
    while True:
        rows = (sb.table("title_soc_map")
                  .select("title_clean,soc_code")
                  .range(start, start + page - 1).execute().data) or []
        for r in rows:
            out[r["title_clean"]] = r["soc_code"]
        if len(rows) < page:
            break
        start += page
    return out


# ── LLM fallback — only for distinct titles the rule pass can't place ──────────────
def _load_anthropic_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return True
    # mirror 00_quarterly_intake.py / map_source_dept.py: pull the key from web/.env.local locally
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


def _llm_classify(titles):
    """titles: list[str] -> {title: (soc_code, soc_name)} using DOL 2018 SOC codes."""
    if not titles or not _load_anthropic_key():
        return {}
    import anthropic
    client = anthropic.Anthropic()
    prompt = (
        "Map each US job title to the single best DOL Standard Occupational Classification "
        "(SOC 2018) code — the occupation a US work-visa filing (H-1B / PERM) would use. "
        "Use the O*NET-SOC form like \"15-1252.00\". Judge by the occupation the title implies, "
        "ignoring seniority. If a title is too generic to place confidently, omit it.\n"
        "Return ONLY a JSON object mapping each exact input string to "
        "{\"soc\": \"<code>\", \"name\": \"<occupation name>\"}.\n\n"
        f"Inputs:\n{json.dumps(titles, ensure_ascii=False)}"
    )
    try:
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=8000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        if text.startswith("```"):  # tolerate ```json fences
            text = text.strip("`")
            text = text[4:].strip() if text.lower().startswith("json") else text
        raw = json.loads(text)
        out = {}
        for k, v in raw.items():
            if isinstance(v, dict) and v.get("soc"):
                out[k] = (str(v["soc"]).strip(), (v.get("name") or "").strip())
        return out
    except Exception as e:
        print(f"  LLM classify failed ({e}) — leaving these unmapped this run", flush=True)
        return {}


def _upsert_rows(sb, rows):
    """Upsert mapping rows in chunks of 500 (on_conflict no-op vs in-batch dupes)."""
    for i in range(0, len(rows), 500):
        sb.table("title_soc_map").upsert(rows[i:i + 500], on_conflict="title_clean").execute()


def run_batch(sb, *, use_llm=True, queue_limit=5000, llm_chunk=50, restamp=True):
    """Map distinct unmapped title_clean -> SOC, upsert title_soc_map, re-stamp + verify.

    Idempotent and resumable: the queue is only titles not already in title_soc_map, so
    human/earlier rows are never touched. Re-stamp runs in bounded batches (no 57014).

    restamp=False populates title_soc_map only (no tier changes) — use it to stage the
    mapping for the /admin/soc precision audit before flipping anything in production.
    """
    queue = sb.rpc("unmapped_titles", {"p_limit": queue_limit}).execute().data or []
    print(f"map_title_soc: {len(queue)} unmapped titles queued", flush=True)

    # Rule pass first — cheap, deterministic — and SAVE it immediately. Every upsert is
    # crash-safe: the queue excludes already-mapped titles, so an interrupted run loses no
    # progress and simply re-running resumes where it left off.
    rule_rows, llm_pending = [], []
    for q in queue:
        hit = _rule_soc(q["title_clean"])
        if hit:
            rule_rows.append({"title_clean": q["title_clean"], "soc_code": hit[0], "soc_name": hit[1],
                              "mapped_by": "rule", "sample_raw": q["sample_raw"], "n_jobs": q["n_jobs"]})
        else:
            llm_pending.append(q)
    _upsert_rows(sb, rule_rows)
    print(f"map_title_soc: {len(rule_rows)} rule rows saved; {len(llm_pending)} to LLM", flush=True)

    # LLM pass — classify AND upsert per chunk, so an interruption never throws away work.
    llm_total = 0
    if use_llm and llm_pending:
        for i in range(0, len(llm_pending), llm_chunk):
            chunk = llm_pending[i:i + llm_chunk]
            res = _llm_classify([q["title_clean"] for q in chunk])
            chunk_rows = []
            for q in chunk:
                got = res.get(q["title_clean"])
                if got and _SOC_RE.match(got[0]):
                    chunk_rows.append({"title_clean": q["title_clean"], "soc_code": got[0],
                                       "soc_name": got[1] or None, "mapped_by": "llm",
                                       "sample_raw": q["sample_raw"], "n_jobs": q["n_jobs"]})
            _upsert_rows(sb, chunk_rows)
            llm_total += len(chunk_rows)
            print(f"  llm {min(i + llm_chunk, len(llm_pending))}/{len(llm_pending)} titles "
                  f"(+{len(chunk_rows)} this chunk, {llm_total} total)", flush=True)

    print(f"map_title_soc: mapped {len(rule_rows) + llm_total} new titles "
          f"({len(rule_rows)} rule, {llm_total} llm)", flush=True)

    sb.rpc("refresh_soc_map_counts").execute()
    if not restamp:
        print("map_title_soc: restamp skipped (populate-only) — audit /admin/soc, then re-run with restamp", flush=True)
        return {"mapped": len(rule_rows) + llm_total, "restamped": 0}

    # Re-stamp job_signals.soc_code + upgrade friendly->verified, in bounded batches.
    total = 0
    while True:
        n = sb.rpc("restamp_soc", {"p_batch": 5000}).execute().data or 0
        total += n
        if not n:
            break
    print(f"map_title_soc: re-stamped/verified {total} job_signals", flush=True)
    return {"mapped": len(rule_rows) + llm_total, "restamped": total}


if __name__ == "__main__":
    from supabase import create_client
    from config import SUPABASE_URL, SUPABASE_KEY
    run_batch(create_client(SUPABASE_URL, SUPABASE_KEY))
