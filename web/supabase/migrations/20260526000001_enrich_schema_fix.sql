-- Enrichment schema fix
-- Adds missing columns + RPC functions that the enrichment pipeline requires.
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- Then: Settings → API → Extra Search Path → confirm "enriched" is listed

-- ─── linkedin.profiles: add linkedin_url + headline ──────────────────────────
alter table linkedin.profiles
  add column if not exists linkedin_url text,
  add column if not exists headline     text;

-- ─── enriched.profiles: add enrich_status + current_title ────────────────────
alter table enriched.profiles
  add column if not exists enrich_status text not null default 'pending'
    check (enrich_status in ('pending', 'done', 'failed')),
  add column if not exists current_title text;

-- ─── RPC: write enrichment result ────────────────────────────────────────────
create or replace function enrich_set_result(
  p_user_id       uuid,
  p_location      text,
  p_current_title text,
  p_job_function  text,
  p_job_level     text
) returns void language sql security definer as $$
  insert into enriched.profiles
    (user_id, location, current_title, job_function, job_level, enrich_status, updated_at)
  values
    (p_user_id, p_location, p_current_title, p_job_function, p_job_level, 'done', now())
  on conflict (user_id) do update set
    location       = excluded.location,
    current_title  = excluded.current_title,
    job_function   = excluded.job_function,
    job_level      = excluded.job_level,
    enrich_status  = 'done',
    updated_at     = now();
$$;

-- ─── RPC: mark enrichment failed ─────────────────────────────────────────────
create or replace function enrich_set_failed(
  p_user_id uuid
) returns void language sql security definer as $$
  update enriched.profiles
  set enrich_status = 'failed', updated_at = now()
  where user_id = p_user_id and enrich_status = 'pending';
$$;
