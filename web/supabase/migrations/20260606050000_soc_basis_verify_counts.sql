-- Make SOC verification correctable + add a per-title verify count for the /admin/soc sort.
--
-- 1) verified_basis tracks WHY a job is verified: 'soc' (this pipeline) vs NULL (legacy
--    title-string match). This lets restamp_soc DOWNGRADE a soc-verified job when a human
--    corrects its title→SOC mapping, WITHOUT ever touching a legacy title-match verified.
-- 2) restamp_soc v2: full recompute for jobs whose title is mapped — upgrade friendly→verified
--    when the SOC matches the employer's sponsored occupations, and downgrade verified(soc)→
--    friendly when it no longer does. Excluded (no-sponsor) is left alone; legacy verifieds kept.
-- 3) n_verify on title_soc_map = how many active jobs this title actually verifies (employer
--    sponsored that SOC) — the impact metric to sort the admin by.

alter table public.job_signals  add column if not exists verified_basis text;   -- 'soc' | NULL(legacy/title)
alter table public.title_soc_map add column if not exists n_verify integer not null default 0;

create or replace function public.restamp_soc(p_batch int default 5000)
returns integer
language plpgsql
set statement_timeout to '180s'
as $$
declare n integer;
begin
  with cand as (
    select js.job_id, js.confidence_tier as cur_tier, js.verified_basis as cur_basis,
           js.no_sponsor_in_desc_flag as nsf, js.soc_code as cur_soc, m.soc_code as new_soc,
           exists (
             select 1 from public.employer_soc es
             join public.jobs j on j.id = js.job_id
             where es.employer_id = j.employer_id
               and es.soc6 = split_part(m.soc_code, '.', 1)
           ) as matches
    from public.job_signals js
    join public.title_soc_map m on m.title_clean = js.title_clean
  ),
  calc as (
    select job_id, new_soc, cur_tier, cur_basis, cur_soc,
      case
        when nsf = 'no_sponsor' then 'excluded'
        when matches then 'verified'
        when cur_tier = 'verified' and cur_basis = 'soc' then 'friendly'   -- soc match no longer holds
        else cur_tier
      end as new_tier,
      case
        when nsf = 'no_sponsor' then cur_basis
        when matches then (case when cur_tier = 'verified' then cur_basis else 'soc' end)
        when cur_tier = 'verified' and cur_basis = 'soc' then null
        else cur_basis
      end as new_basis
    from cand
  ),
  chg as (
    select * from calc
    where cur_soc  is distinct from new_soc
       or cur_tier is distinct from new_tier
       or cur_basis is distinct from new_basis
    order by job_id
    limit p_batch
  )
  update public.job_signals js
  set soc_code = chg.new_soc,
      confidence_tier = chg.new_tier,
      verified_basis = chg.new_basis
  from chg
  where js.job_id = chg.job_id;
  get diagnostics n = row_count;
  return n;
end
$$;

create or replace function public.refresh_soc_map_counts()
returns void
language plpgsql
set statement_timeout to '180s'
as $$
begin
  update public.title_soc_map m
  set n_jobs = coalesce(sub.cnt, 0),
      n_verify = coalesce(sub.vcnt, 0),
      updated_at = now()
  from (
    select js.title_clean as tc,
           count(*) as cnt,
           count(*) filter (where es.employer_id is not null) as vcnt
    from public.job_signals js
    join public.jobs j on j.id = js.job_id and j.is_active
    join public.title_soc_map tm on tm.title_clean = js.title_clean
    left join public.employer_soc es
      on es.employer_id = j.employer_id and es.soc6 = split_part(tm.soc_code, '.', 1)
    where js.title_clean is not null
    group by js.title_clean
  ) sub
  where sub.tc = m.title_clean;
end
$$;

revoke execute on function public.restamp_soc(int)         from anon, authenticated;
revoke execute on function public.refresh_soc_map_counts() from anon, authenticated;
