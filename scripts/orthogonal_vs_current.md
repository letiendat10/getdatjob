# Orthogonal vs current enrichment — spike results

**Date:** 2026-06-03 · **Cohort:** n=5 personal-Gmail addresses · **Plan:** `/Users/dat/.claude/plans/you-are-the-principal-snoopy-treasure.md`

## TL;DR

**Ship Strategy D: SerpAPI → ContactOut `/v1/linkedin/enrich`** (2¢/sign-up, ~4–6s, 5/5/5 perfect match). It replaces the entire 16–25s Chrome-extension scrape with one server-side HTTP chain that has zero user-install dependency. Keep the extension as Tier-2 fallback.

## Results

Four strategies, each tested on the same 5 personal-Gmail cohort (Alanna, Bruno, Patrick, Sigal, Joshua). Grades = (URL slug match / title keyword match / location city match).

| Strategy | URL | Title | Loc | p50 | p95 | Cost/5 | Per call |
|---|---|---|---|---|---|---|---|
| **A** ContactOut `/v1/people/enrich` (name+email) | 0–5/5 ⚠️ | unstable | unstable | 531ms | 5.4s | $2.75 | $0.55 |
| **B** Tomba `/v1/enrich` → ContactOut `/v1/linkedin/enrich` | 3/5 | 3/5 | 3/5 | 6.7s | 7.6s | $0.08 | $0.02 |
| **C** SerpAPI (today's pipeline, URL only) | 5/5 | 0/5 | 0/5 | 65ms | 104ms | $0.03 | $0.005 |
| **D** SerpAPI → ContactOut `/v1/linkedin/enrich` | **5/5** | **5/5** | **5/5** | **4.2s** | **4.9s** | **$0.07** | **$0.014** |

(p50/p95 over 5 calls each; SerpAPI's <100ms reflects cache hits across runs.)

### Strategy A is unreliable

ContactOut's `/v1/people/enrich` (the single-call email+name endpoint the original research recommended) **dropped from 5/5 → 2/5 → 0/5 across three consecutive runs** while still charging 55¢ per call. Failing calls return in <700ms with empty profiles. Likely cause: rate-limit / concurrency-sensitive. Even if it were stable, $0.55/sign-up is 27× more expensive than Strategy D for the same data. **Reject.**

### Strategy B falls short on coverage

Tomba's `/v1/enrich` essentially packages a Google SERP scrape (we can see its `sources` field literally contains `google.com/search?q=site:linkedin.com ...`). It misses 2/5 — Bruno's `id.linkedin.com` Indonesia subdomain and Sigal's profile aren't in Tomba's index. SerpAPI's scoring algorithm catches both. **Reject for URL discovery.**

### Strategy C is what we have today, just without the extension

SerpAPI alone gets the URL right 5/5 — confirming the current callback's `trySerpAPI()` does its job. But the URL is *all* it gives us; today we need the 16-second extension scrape to extract title/location. That's the pain point.

### Strategy D combines the strengths

SerpAPI gets the URL in <500ms with proven 5/5 reliability. ContactOut's `/v1/linkedin/enrich` (with `profile_only=true`) takes that URL and returns headline + location + company for **1¢ in ~3–4s**. The 2-step chain is **5/5 on URL, title, and location across both test runs**.

Patrick's `ch.linkedin.com` and Bruno's `id.linkedin.com` country subdomains: ContactOut handled both correctly.

## Comparison vs today's pipeline

| | Current (SerpAPI + extension) | Proposed (Strategy D) |
|---|---|---|
| Time to `enriched.profiles.enrich_status='done'` | ~16–25s | **~4–6s** |
| User dependency | Chrome + extension install + Realtime + LinkedIn not rate-limiting | None |
| URL match rate | 5/5 (SerpAPI step) | 5/5 |
| Title accuracy | depends on DOM scrape success | 5/5 (direct from ContactOut) |
| Location accuracy | depends on DOM scrape success | 5/5 (direct from ContactOut) |
| Cost per sign-up | ~$0.005 SerpAPI + extension infra | **~$0.014** |
| Failure modes | extension not installed; LinkedIn HTML changes; tab open lag | Orthogonal/ContactOut outage |

**Cost at scale:** at 1,000 sign-ups/day, Strategy D costs ~$14/day. The current pipeline is ~$5 in SerpAPI but takes 16+ seconds and silently fails for any user without the extension.

## Recommendation

1. **Ship Strategy D.** Replace `trySerpAPI()` → `linkedin_import_queue` insert in `web/src/app/auth/linkedin/callback/route.ts` with: `trySerpAPI()` → `enrichByLinkedInUrl()` (new wrapper around ContactOut). On a `enrich_status='done'` write, skip the queue insert.
2. **Keep the extension as Tier-2.** On ContactOut miss/error/timeout (>6s), insert to `linkedin_import_queue` exactly as today. Extension wakes up via Realtime and scrapes. Zero ongoing cost when idle.
3. **Add `enrich_source` column** to `enriched.profiles` ("orthogonal" | "extension" | "serpapi-only") so we can monitor the fallback rate in prod.
4. **Do NOT use ContactOut `/v1/people/enrich`.** Unreliable AND expensive. Always go SerpAPI → linkedin/enrich.

## Files

- Spike script: `scripts/spike_orthogonal.mjs`
- Raw results: `scripts/spike_orthogonal_results.csv`
- This report: `scripts/orthogonal_vs_current.md`
