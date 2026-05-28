-- LinkedIn profile import columns
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- Adds the columns the LinkedIn import flow writes into linkedin.profiles.
-- Column names are provider-agnostic — the same shape works for Scrapingdog,
-- Apify, RapidAPI listings, etc. Positions still go into
-- public.user_work_history (one row per role).

alter table linkedin.profiles
  add column if not exists summary               text,
  add column if not exists location              text,
  add column if not exists skills                jsonb,
  add column if not exists education             jsonb,
  add column if not exists linkedin_data_raw     jsonb,
  add column if not exists linkedin_data_source  text,            -- 'scrapingdog' | 'proxycurl' | ...
  add column if not exists linkedin_imported_at  timestamptz;

-- Make re-imports cheap: clear a user's work history before re-inserting.
create index if not exists idx_work_history_user_current
  on public.user_work_history(user_id, is_current);
