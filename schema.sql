-- getdatjob schema
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run

create table if not exists employers (
  id            bigint primary key generated always as identity,
  name          text not null,
  name_clean    text unique,             -- lowercased, normalized for matching
  fein          text,
  domain        text,                    -- verified website domain (e.g. block.xyz) — populated by 04_enrich_domains.py
  lca_count     int default 0,
  lca_count_2025 int default 0,
  lca_2025_by_quarter jsonb default '{}'::jsonb,
  top_visa_class text,                   -- H-1B | E-3 | TN
  last_filing_date date,
  created_at    timestamptz default now()
);

create table if not exists employer_ats (
  id            bigint primary key generated always as identity,
  employer_id   bigint references employers(id) on delete cascade,
  ats_type      text not null,           -- greenhouse | lever | ashby
  slug          text not null,
  verified_at   timestamptz,            -- null = auto-guessed, not yet confirmed
  created_at    timestamptz default now(),
  unique(employer_id, ats_type)
);

create table if not exists lca_filings (
  id            bigint primary key generated always as identity,
  employer_id   bigint references employers(id) on delete cascade,
  job_title     text,
  soc_code      text,
  wage_offered  numeric,
  wage_level    text,                   -- I | II | III | IV
  city          text,
  state         text,
  filing_date   date,
  received_date date,
  visa_class    text,                   -- H-1B | H-1B1 | E-3 | TN
  case_status   text,                   -- Certified | Withdrawn | Denied
  title_clean   text,
  created_at    timestamptz default now()
);

create table if not exists jobs (
  id            bigint primary key generated always as identity,
  employer_id   bigint references employers(id) on delete cascade,
  title         text,
  location      text,
  url           text,
  posted_at     timestamptz,
  ats_source    text,                   -- greenhouse | lever | ashby
  ats_job_id    text,                   -- original ID from ATS (for dedup)
  description_text text,
  is_active     boolean default true,
  last_seen_at  timestamptz default now(),
  created_at    timestamptz default now(),
  unique(ats_source, ats_job_id)
);

create table if not exists job_signals (
  id                  bigint primary key generated always as identity,
  job_id              bigint references jobs(id) on delete cascade unique,
  confidence_tier          text,         -- verified | friendly | excluded
  no_sponsor_in_desc_flag  text,         -- sponsors | no_sponsor | null
  title_clean              text,
  title_employer_lca_count int,
  visa_class               text,
  computed_at              timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_employers_name_clean on employers(name_clean);
create index if not exists idx_lca_employer_date on lca_filings(employer_id, filing_date desc);
create index if not exists idx_lca_title on lca_filings(job_title);
create index if not exists idx_jobs_employer on jobs(employer_id);
create index if not exists idx_jobs_active on jobs(is_active, posted_at desc);
create index if not exists idx_job_signals_tier on job_signals(confidence_tier);
