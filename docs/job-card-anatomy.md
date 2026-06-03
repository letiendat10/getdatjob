# Job Card Anatomy

The canonical reference for every element of a getdatjob job card: where its data
comes from, how the pieces connect, what values it can take, and how fresh/complete
it is in production. Numbers are from a live audit of the production DB on
**2026-06-03** (123,368 active jobs); treat them as a baseline, not a constant — the
routine QA snapshot (see [QA](#routine-qa) ) tracks them over time.

> One component renders every chip on every surface:
> [`web/src/app/components/JobChips.tsx`](../web/src/app/components/JobChips.tsx).
> `/jobs`, `/kai`, and `/me` all feed it. Change a chip there and it changes everywhere.

---

## 1. Header

| Element | Source | How it's derived | Notes |
|---|---|---|---|
| **Company logo** | `employers.company_domain_url` | Logo.dev lookup by domain; initials fallback | Domain is backfilled from the LCA POC email domain (generic + law-firm domains filtered). 99.8% of active jobs have a domain. |
| **Job title** | `jobs.title` | Raw from the ATS, unmodified | Always the ATS title. (Not `title_clean` — that's internal; see §3.) |
| **Company · Location** | `employers.name`, `jobs.location` | Normalized **client-side** (`normalizeCompanyName`, `normalizeLocation` in `jobs-client.tsx`) into ~20 metro buckets | Normalization is display-only; the raw values stay in the DB. |
| **Posted "Nd ago"** | `effective_posted_at = COALESCE(posted_at, scraped_at)` | Computed in `jobs_kai_view` | **Only ~17.5% of active jobs have a real `posted_at`.** The rest fall back to `scraped_at` (first-seen). See §5. |

## 2. Chips — the visa promise

All rendered by `JobChips.tsx`. Field names differ by surface and are accepted as
aliases: `/kai` passes `visa_tier` + `lca_last_filed`; `/jobs` and `/me` pass
`confidence_tier` + `last_filing_date`.

| Chip | Source field | Derivation | Live coverage |
|---|---|---|---|
| **Salary** | `jobs.salary_range` (display); `salary_min_num`/`salary_max_num`/`salary_period` (filter) | `parse_salary()` over the description / ATS pay range. **The card shows only the real parsed range — never `salary_estimate`** (the LCA wage average in the view). | 10.0% |
| **Verified LCA…** (rainbow) | `job_signals.confidence_tier = 'verified'` | `title_clean` matches one of the employer's **certified LCA filing titles** in the last 36 months. Rare *by design* (near-exact title match). | 6.2% |
| **H-1B Friendly** (green) | `confidence_tier = 'friendly'` | Employer has LCA history, no anti-sponsor language in the description, but the title didn't match a filing. **This is the correct majority signal — not a defect** (see §6). | 92.8% |
| **E-3 Friendly** (amber) | `employers.e3_lca_count > 0` | Employer has filed ≥1 **E-3 Australian** LCA. | 25.5% |
| **TN Friendly** (blue) | chip: `getTnCategory(title)`; filter: `jobs.tn_eligible` | **Title** matches a USMCA profession ([`web/src/lib/tn-eligible.ts`](../web/src/lib/tn-eligible.ts)). **TN files no LCA**, so this is title-only by necessity — structurally a weaker claim than H-1B/E-3, which are filing-backed. | 21.2% |
| **Last LCA filed** | `employers.last_filing_date` | Max `received_date` across the employer's filings. | — |
| **N LCA filings 2025** | `employers.lca_count_2025` | Per-employer 2025 count. | — |
| **PoC** | `employers.poc_first_name`, `poc_last_name`, `poc_email` | Contact from the employer's most-recent certified LCA. Often HR/immigration, not the hiring manager. | 100% present |
| **Viewed** | `localStorage` (`gdj_viewed`) | Client-only; not in the DB. | — |
| **Level / Dept** (detail view only) | `inferLevel`/`inferDepartment(title)` today | Client-side regex — **being replaced** by the stored `job_level`/`department` columns (taxonomy unification). | — |

## 3. `title_clean` — internal only, never displayed

`job_signals.title_clean` is the normalized form of the raw title (`clean_title()`),
used **solely to match against the cleaned titles in `lca_filings`** to compute the
verified visa signal. It is never shown on a card — the card always displays the raw
`jobs.title`. Keeping `title_clean` accurate is how the **H-1B verified** tag stays
honest (a wrong clean form produces a false verified match), which is why it is a
reviewable field in the human-in-the-loop tool even though users never see it.

## 4. Possible-values catalog (ground-truthed)

- **`confidence_tier`**: `verified` | `friendly` | `excluded` | `null`
- **Visa universe** (real LCAs): `H-1B` (~97%), `E-3 Australian`, `H-1B1 Chile`, `H-1B1 Singapore`. **No `TN`** (TN files no LCA). H-1B1 Chile/Singapore exist in the data but are **not surfaced** on the card.
- **`job_level`** (stored, `classify.py`): `Entry/Junior` · `Senior` · `Lead/Manager` · `Director` · `VP` · `null`. ~56% null (untagged mid-level ICs).
- **`department`** (stored): currently `Product · Engineering · Data · Design · Sales · Marketing · Finance · Security` · `null` (~67% null). *Target: the full 15-department set matching the `/jobs` UI (taxonomy unification).*
- **`salary_period`**: `annual` · `hourly` · `null` (~90% null)
- **`is_remote`**: `true` (~2.3% — under-detected) | `false`
- **`is_us`**: `true` | `false` (766 active `false` — a leak that should be excluded)
- **`tn_eligible`**: `true` (~21%) | `false`
- **`ats_source`**: `workday` · `amazon` · `greenhouse` · `smartrecruiters` · `ashby` · `lever` · `icims` · `workable`
- **`lca_filings.wage_level`**: `I` | `II` | `III` | `IV` | `null` — **`case_status`**: `Certified` only (loader filters)

## 5. Data lineage

```
01_process_lca.py   DOL LCA disclosure → employers (visa_types, lca counts, PoC,
                    company_domain_url), lca_filings
        │
03_pull_jobs.py     per-ATS fetch → jobs (title/location/url/posted_at, salary,
                    department, job_level, is_remote)  +  score_job → job_signals
                    (confidence_tier, no_sponsor_flag, title_clean)
        │
04_enrich_descriptions.py   list-only ATSes (Workday/SmartRecruiters/iCIMS):
                    detail fetch → description_text, salary, exact posted_at
        │
jobs_kai_view / jobs_with_details   effective_posted_at = COALESCE(posted_at,
                    scraped_at); salary_estimate (LCA avg); joins employer + signals
        │
search_jobs_kai RPC (/kai)   +   query-jobs.ts (/jobs)
        │
JobChips.tsx  →  the card
```

Per-field origin in one line each:
- **verified/friendly/excluded** ← `score_job` in `03_pull_jobs.py` (title vs. employer's 36-month LCA titles; anti-sponsor text → excluded).
- **E-3 / H-1B counts, PoC, domain, last filing** ← `01_process_lca.py` from DOL data.
- **TN** ← title heuristic (`tn-eligible.ts`); no filing backing exists.
- **department / job_level / is_remote** ← `classify.py` from the title at scrape time.
- **salary** ← `parse_salary()` from the description / ATS pay range.
- **posted_at** ← ATS field, or exact Workday `startDate` from the enrichment detail fetch.

## 6. Known data-quality state (2026-06-03 baseline)

- **Enrichment was down at the CI level, not the code.** Both `daily_scraper.yml` and `enrich.yml` were crashing in ~1s because the `SUPABASE_KEY` GitHub secret was empty and `config.py` returned that empty string instead of falling back. Fixed: `config.py` now requires the key from the environment and fails with a clear message. **Action required:** rotate the (formerly committed) service-role key, set the `SUPABASE_KEY` secret, and run. Until enrichment runs, Workday (82% of inventory) shows ~0% descriptions / salary / real posted dates.
- **"H-1B Friendly" on 93% of cards is honest, not noise.** `verified` requires a near-exact title match to a prior certified filing, so it is necessarily rare (6%); `friendly` is the correct broader "this employer sponsors" signal. Both chips stay; the distinction is documented, not re-tiered.
- **Four divergent dept/level taxonomies** (stored columns vs. `/jobs` title-ILIKE vs. detail-badge inference vs. profile enrichment) are being unified onto the stored columns as the single source of truth.
- **No DB guardrails:** no CHECK constraints on `jobs`/`job_signals` (a typo'd `job_level` writes silently); `job_signals.visa_class` is 100% null (dead); 766 active rows are `is_us=false`; `is_remote` is under-detected at 2.3%.

## 7. Routine QA

Card health is snapshotted daily over the **last-7-day window** (the jobs users
actually browse) into `card_health_snapshot`, with an alert script
(`scrapers/10_qa_card_health.py`) that flags coverage regressions and integrity
breaches (rogue enum values, non-US leaks, salary-shown-without-number, etc.). A
human-in-the-loop queue (`/admin/review`) surfaces ~10 verified, freshly-posted,
highest-LCA cards per day for one-per-title approval/correction that propagates across
the corpus. See the project plan for the full QA + HITL design.
