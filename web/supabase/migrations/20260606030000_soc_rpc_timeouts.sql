-- refresh_soc_map_counts does the same job_signals ⋈ jobs aggregation as unmapped_titles
-- (~26s), and restamp_soc's per-batch cte joins a (growing) title_soc_map. Both are offline
-- batch RPCs (map_title_soc / the /admin save), so give them their own higher statement_timeout
-- via plpgsql (a language sql function inlines and ignores the SET).

create or replace function public.refresh_soc_map_counts()
returns void
language plpgsql
set statement_timeout to '180s'
as $$
begin
  update public.title_soc_map m
  set n_jobs = coalesce(c.cnt, 0), updated_at = now()
  from (
    select js.title_clean as tc, count(*)::int as cnt
    from public.job_signals js
    join public.jobs j on j.id = js.job_id
    where j.is_active and js.title_clean is not null
    group by js.title_clean
  ) c
  where c.tc = m.title_clean;
end
$$;

create or replace function public.restamp_soc(p_batch int default 5000)
returns integer
language plpgsql
set statement_timeout to '180s'
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

revoke execute on function public.refresh_soc_map_counts() from anon, authenticated;
revoke execute on function public.restamp_soc(int)         from anon, authenticated;
