-- SOC occupation matching for the H-1B verified tag (mirrors the department source-of-truth
-- pipeline, 20260605040000–042000). A job is "verified" when the DOL occupation (SOC) its
-- title maps to is one the EMPLOYER has actually sponsored (lca_filings.soc_code, 3y).
--
-- Why: exact title-string matching (03_pull_jobs.score_job: clean_title in employer's LCA
-- titles) only ever verifies ~26% of titles — 91% of active jobs sit at "friendly" despite
-- every one being at a sponsoring employer. Matching on occupation lifts the tag toward
-- employer-level truth without per-title manual review.
--
-- Pattern (same as dept_mapping): a small curated mapping table (rule -> llm -> human, human
-- wins, never overwritten by the batch); bounded re-stamp RPCs (no 57014); precomputed counts
-- so the /admin surface reads a tiny table and can't time out like the old /admin/review.

-- 1) Inferred SOC per job, written by restamp_soc from title_soc_map. Internal scoring column.
alter table public.job_signals add column if not exists soc_code text;

-- Full index on title_clean so the per-distinct-title queue + the re-stamp join are index-backed
-- (the existing covering index is partial on confidence_tier='verified' and on job_id, not this).
create index if not exists idx_job_signals_title_clean on public.job_signals (title_clean);

-- 2) Mapping table — distinct job title_clean -> DOL SOC occupation. One row per distinct
--    title_clean, curated rule -> llm -> human (human wins, never overwritten by the batch).
create table if not exists public.title_soc_map (
  title_clean text primary key,
  soc_code    text not null,                 -- DOL SOC, O*NET form (e.g. 15-1252.00)
  soc_name    text,                          -- human-readable occupation, for /admin review
  mapped_by   text not null default 'rule'   -- 'rule' | 'llm' | 'human' ('human' wins)
              check (mapped_by in ('rule', 'llm', 'human')),
  sample_raw  text,                          -- an example raw job title, for auditing
  n_jobs      integer not null default 0,    -- precomputed count (keeps /admin fast, no live aggregate)
  updated_at  timestamptz not null default now()
);

-- Internal table: scraper writes via the service role (bypasses RLS); admin reads server-side
-- (owner-gated). Enable RLS with no anon policy => denied to the public.
alter table public.title_soc_map enable row level security;

comment on table public.title_soc_map is
  'Distinct job title_clean -> DOL SOC occupation. Curated rule/llm/human; drives job_signals.soc_code and the SOC-occupation verified tag.';

-- 3) employer_soc — the set of SOC occupations each employer has actually sponsored (3y).
--    soc6 = the 6-digit SOC (drops the O*NET ".NN" detail) so "same occupation" matches even
--    when the detail suffix differs. Matview so the re-stamp membership test is index-fast.
create materialized view if not exists public.employer_soc as
  select distinct employer_id, split_part(soc_code, '.', 1) as soc6
  from public.lca_filings
  where soc_code is not null and soc_code <> ''
    and received_date >= (current_date - interval '3 years');

-- Unique index doubles as the key and enables REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index if not exists employer_soc_pk on public.employer_soc (employer_id, soc6);

comment on materialized view public.employer_soc is
  'Per-employer set of sponsored SOC occupations (6-digit, 3y) from lca_filings. Refresh after intake / daily. The verified-tag match set.';

-- 4) RPCs (PostgREST can't express DISTINCT / UPDATE..FROM). Service-role only.

-- Distinct title_clean on active jobs not yet mapped, busiest first — the batch's work queue.
create or replace function public.unmapped_titles(p_limit int default 5000)
returns table(title_clean text, sample_raw text, n_jobs bigint)
language sql
stable
as $$
  select js.title_clean,
         min(j.title) as sample_raw,
         count(*)     as n_jobs
  from public.job_signals js
  join public.jobs j on j.id = js.job_id
  where j.is_active
    and js.title_clean is not null and js.title_clean <> ''
    and not exists (select 1 from public.title_soc_map m where m.title_clean = js.title_clean)
  group by js.title_clean
  order by count(*) desc
  limit p_limit
$$;

-- Re-stamp job_signals.soc_code from title_soc_map and UPGRADE friendly -> verified when the
-- mapped SOC is one the employer has sponsored. UPGRADE-ONLY: verified/excluded are never
-- touched, so existing title-match verifieds can't regress. Bounded batches (avoids the 57014
-- that bit the old HITL); the caller loops until it returns 0.
create or replace function public.restamp_soc(p_batch int default 5000)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with cte as (
    select js.job_id,
           m.soc_code,
           (js.confidence_tier = 'friendly' and exists (
              select 1 from public.employer_soc es
              join public.jobs j on j.id = js.job_id
              where es.employer_id = j.employer_id
                and es.soc6 = split_part(m.soc_code, '.', 1)
           )) as becomes_verified
    from public.job_signals js
    join public.title_soc_map m on m.title_clean = js.title_clean
    where js.soc_code is distinct from m.soc_code
       or (js.confidence_tier = 'friendly' and exists (
              select 1 from public.employer_soc es
              join public.jobs j on j.id = js.job_id
              where es.employer_id = j.employer_id
                and es.soc6 = split_part(m.soc_code, '.', 1)))
    order by js.job_id
    limit p_batch
  )
  update public.job_signals js
  set soc_code = cte.soc_code,
      confidence_tier = case when cte.becomes_verified then 'verified' else js.confidence_tier end
  from cte
  where js.job_id = cte.job_id;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Refresh the precomputed n_jobs on title_soc_map (keeps /admin fast — no live jobs aggregate).
create or replace function public.refresh_soc_map_counts()
returns void
language sql
as $$
  update public.title_soc_map m
  set n_jobs = coalesce(c.cnt, 0), updated_at = now()
  from (
    select js.title_clean as tc, count(*)::int as cnt
    from public.job_signals js
    join public.jobs j on j.id = js.job_id
    where j.is_active and js.title_clean is not null
    group by js.title_clean
  ) c
  where c.tc = m.title_clean
$$;

-- Internal (scraper/admin via service role) — keep off the public PostgREST surface.
revoke execute on function public.unmapped_titles(int)     from anon, authenticated;
revoke execute on function public.restamp_soc(int)         from anon, authenticated;
revoke execute on function public.refresh_soc_map_counts() from anon, authenticated;
