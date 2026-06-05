-- Department source-of-truth pipeline (Part 2 of the department-search fix).
--
-- We capture the ATS's OWN department string (Greenhouse departments[].name, Lever
-- categories.department, Workday jobFamily, Amazon job_category, SmartRecruiters
-- function.label, ...) verbatim in jobs.source_department — that org-structure value is
-- the right signal for "department" (a job title is the *occupation* axis, not the
-- department, which is why the title-only classifier left 62% NULL).
--
-- Raw values are messy ("Sales & Partnerships", "Enterprise Sales", "534 In-Store Sales"),
-- so dept_mapping folds each DISTINCT normalized raw value into ONE unified department
-- (the value stored on jobs.department and shown in the filter). Mapping is curated once
-- per distinct value (rule -> LLM -> human), so the table stays small and reusable.

-- 1) Raw ATS department, captured verbatim. Internal source-of-truth / audit column —
--    NEVER rendered to users (the UI always shows the unified jobs.department).
--    Nullable, no default => metadata-only add, no table rewrite.
alter table public.jobs add column if not exists source_department text;

-- 2) Canonical normalizer: lowercase, strip a leading numeric code ("534 ", "12001 - ",
--    "318 "), collapse whitespace, trim, empty -> NULL. IMMUTABLE so it can back a
--    functional index and stay consistent across the scraper, the re-stamp, and the admin.
--    NOTE: scrapers/map_source_dept.py mirrors this exactly — keep them in sync.
create or replace function public.dept_norm(s text)
returns text
language sql
immutable
as $$
  select nullif(
    btrim(regexp_replace(
      regexp_replace(lower(coalesce(s, '')), '^[0-9]+\s*[-–:]?\s*', ''),
      '\s+', ' ', 'g')),
    '')
$$;

-- Functional, partial index so the re-stamp join (dept_norm(source_department) =
-- dept_mapping.source_norm) is index-backed. Partial keeps it tiny (most rows are NULL
-- until the scraper backfills source_department on re-pull). Index build, not a rewrite.
create index if not exists idx_jobs_source_dept_norm
  on public.jobs (public.dept_norm(source_department))
  where source_department is not null;

-- 3) Mapping table — the source of truth for raw -> unified. One row per DISTINCT
--    normalized raw value.
create table if not exists public.dept_mapping (
  source_norm        text primary key,             -- dept_norm(raw)
  unified_department text not null,                 -- the value stored on jobs + shown in filters
  mapped_by          text not null default 'rule'   -- 'rule' | 'llm' | 'human' ('human' wins)
                     check (mapped_by in ('rule', 'llm', 'human')),
  sample_raw         text,                          -- an example raw value, for auditing
  n_jobs             integer not null default 0,    -- precomputed count (keeps /admin fast, no live jobs aggregate)
  updated_at         timestamptz not null default now()
);

-- Internal table: scraper writes via the service role (bypasses RLS); the admin reads
-- server-side (owner-gated). Enable RLS with no anon policy => denied to the public.
alter table public.dept_mapping enable row level security;

comment on column public.jobs.source_department is
  'Raw ATS-native department/family/category, captured verbatim. Internal SoT; never rendered — UI shows the unified jobs.department mapped via dept_mapping.';
comment on table public.dept_mapping is
  'Distinct normalized raw ATS department (source_norm) -> unified department. Curated rule/llm/human; drives jobs.department and the filter vocabulary.';
