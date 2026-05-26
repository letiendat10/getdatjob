-- Auth + Onboarding schema
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run
--
-- After running, expose both schemas in Supabase Dashboard:
--   Settings → API → Extra Search Path → add: linkedin, enriched

create schema if not exists linkedin;
create schema if not exists enriched;

-- ─── linkedin.profiles ───────────────────────────────────────────────────────
-- Raw LinkedIn identity data. One row per auth user. Upserted on every login.

create table if not exists linkedin.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  first_name  text,
  email       text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

alter table linkedin.profiles enable row level security;

create policy "Users can read own linkedin profile"
  on linkedin.profiles for select
  using (auth.uid() = id);

create policy "Users can insert own linkedin profile"
  on linkedin.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update own linkedin profile"
  on linkedin.profiles for update
  using (auth.uid() = id);

-- ─── enriched.profiles ───────────────────────────────────────────────────────
-- Onboarding answers and app preferences. One row per user.

create table if not exists enriched.profiles (
  user_id                 uuid primary key references linkedin.profiles(id) on delete cascade,
  visa_type               text check (visa_type in ('H-1B', 'OPT', 'E-3/TN', 'Other')),
  salary_floor            int,                     -- null = no floor; in dollars e.g. 100000
  job_level               text check (job_level in ('Senior IC', 'Manager/Lead', 'Either')),
  job_function            text,
  location                text,
  onboarding_complete     boolean not null default false,
  jobs_viewed_today       int     not null default 0,
  jobs_viewed_date        date    not null default current_date,
  is_supporter            boolean not null default false,
  email_alerts            boolean not null default false,
  email_alerts_frequency  int     not null default 24  -- hours between alerts: 4 | 24 | 48
    check (email_alerts_frequency in (4, 24, 48)),
  updated_at              timestamptz not null default now()
);

alter table enriched.profiles enable row level security;

create policy "Users can read own enriched profile"
  on enriched.profiles for select
  using (auth.uid() = user_id);

create policy "Users can insert own enriched profile"
  on enriched.profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update own enriched profile"
  on enriched.profiles for update
  using (auth.uid() = user_id);

-- ─── public.user_work_history ─────────────────────────────────────────────────
-- LinkedIn enrichment: past and current roles. Multiple rows per user.

create table if not exists public.user_work_history (
  id          bigint primary key generated always as identity,
  user_id     uuid not null references linkedin.profiles(id) on delete cascade,
  company     text not null,
  title       text not null,
  location    text,
  start_date  date,
  end_date    date,                                -- null = current role
  is_current  boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.user_work_history enable row level security;

create policy "Users can read own work history"
  on public.user_work_history for select
  using (auth.uid() = user_id);

create policy "Users can insert own work history"
  on public.user_work_history for insert
  with check (auth.uid() = user_id);

create policy "Users can update own work history"
  on public.user_work_history for update
  using (auth.uid() = user_id);

create policy "Users can delete own work history"
  on public.user_work_history for delete
  using (auth.uid() = user_id);

create index if not exists idx_work_history_user on public.user_work_history(user_id);
create index if not exists idx_work_history_current on public.user_work_history(user_id, is_current) where is_current = true;

-- ─── public.saved_jobs ────────────────────────────────────────────────────────
-- Jobs saved by users. Available to free + supporter tiers.

create table if not exists public.saved_jobs (
  id        bigint primary key generated always as identity,
  user_id   uuid not null references linkedin.profiles(id) on delete cascade,
  job_id    bigint not null references public.jobs(id) on delete cascade,
  saved_at  timestamptz not null default now(),
  unique (user_id, job_id)
);

alter table public.saved_jobs enable row level security;

create policy "Users can read own saved jobs"
  on public.saved_jobs for select
  using (auth.uid() = user_id);

create policy "Users can save jobs"
  on public.saved_jobs for insert
  with check (auth.uid() = user_id);

create policy "Users can unsave jobs"
  on public.saved_jobs for delete
  using (auth.uid() = user_id);

create index if not exists idx_saved_jobs_user on public.saved_jobs(user_id, saved_at desc);
