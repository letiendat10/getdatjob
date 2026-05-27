-- getdatjob schema
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run

create table if not exists employers (
  id            bigint primary key generated always as identity,
  name          text not null,
  name_clean    text unique,             -- lowercased, normalized for matching
  fein          text,
  employer_city  text,                   -- most common city across filings
  employer_state text,                   -- most common state across filings
  company_domain_url text,               -- company website domain (email-derived or enriched)
  poc_first_name text,
  poc_last_name  text,
  poc_job_title  text,
  poc_email      text,                   -- latest POC email from LCA filing (by received_date)
  lca_count      int default 0,           -- cumulative across all loaded quarters
  lca_fy2026     int default 0,           -- calendar year 2026 total
  lca_fy2026_q1  int default 0,          -- Jan–Mar 2026
  lca_fy2026_q2  int default 0,          -- Apr–Jun 2026
  lca_fy2026_q3  int default 0,          -- Jul–Sep 2026
  lca_fy2026_q4  int default 0,          -- Oct–Dec 2026
  lca_fy2025     int default 0,           -- calendar year 2025 total
  lca_fy2025_q1  int default 0,          -- Jan–Mar 2025
  lca_fy2025_q2  int default 0,          -- Apr–Jun 2025
  lca_fy2025_q3  int default 0,          -- Jul–Sep 2025
  lca_fy2025_q4  int default 0,          -- Oct–Dec 2025
  lca_fy2024     int default 0,           -- calendar year 2024 total
  lca_fy2024_q1  int default 0,          -- Jan–Mar 2024
  lca_fy2024_q2  int default 0,          -- Apr–Jun 2024
  lca_fy2024_q3  int default 0,          -- Jul–Sep 2024
  lca_fy2024_q4  int default 0,          -- Oct–Dec 2024
  lca_count_2025 int default 0,          -- legacy calendar-year 2025 (used by web app)
  visa_types     text[],                 -- all visa types filed, e.g. {H-1B,E-3}
  e3_lca_count   int not null default 0, -- count of E-3 filings (E-3 Australian)
  tn_lca_count   int not null default 0, -- count of TN filings
  last_filing_date date,
  created_at    timestamptz default now()
);

create table if not exists employer_ats (
  id            bigint primary key generated always as identity,
  employer_id   bigint references employers(id),
  ats_type      text not null,           -- greenhouse | lever | ashby
  slug          text not null,
  verified_at   timestamptz,            -- null = auto-guessed, not yet confirmed
  created_at    timestamptz default now(),
  unique(employer_id, ats_type)
);

create table if not exists lca_filings (
  id            bigint primary key generated always as identity,
  employer_id   bigint references employers(id),
  job_title     text,
  soc_code      text,
  wage_offered  numeric,
  wage_level    text,                   -- I | II | III | IV
  city          text,
  state         text,
  received_date date,
  visa_class    text,                   -- H-1B | H-1B1 | E-3 | TN
  case_status     text,                  -- Certified | Withdrawn | Denied
  job_title_clean text,
  created_at    timestamptz default now()
);

create table if not exists jobs (
  id            bigint primary key generated always as identity,
  employer_id   bigint references employers(id),
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
  job_id              bigint references jobs(id) unique,
  confidence_tier          text,         -- verified | friendly | excluded
  no_sponsor_in_desc_flag  text,         -- sponsors | no_sponsor | null
  title_clean              text,
  title_employer_lca_count int,
  visa_class               text,
  computed_at              timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_employers_name_clean on employers(name_clean);
create index if not exists idx_lca_employer_date on lca_filings(employer_id, received_date desc);
create index if not exists idx_lca_title on lca_filings(job_title);
create index if not exists idx_jobs_employer on jobs(employer_id);
create index if not exists idx_jobs_active on jobs(is_active, posted_at desc);
create index if not exists idx_job_signals_tier on job_signals(confidence_tier);
