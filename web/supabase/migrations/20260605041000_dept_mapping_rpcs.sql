-- RPCs for the raw->unified department mapping batch (scrapers/map_source_dept.py).
-- PostgREST can't express DISTINCT / UPDATE..FROM, so the batch drives these.

-- Distinct normalized source departments on active jobs that aren't mapped yet, with a
-- sample raw value and a job count, busiest first — the batch's work queue.
create or replace function public.unmapped_source_depts(p_limit int default 5000)
returns table(source_norm text, sample_raw text, n_jobs bigint)
language sql
stable
as $$
  select public.dept_norm(j.source_department) as source_norm,
         min(j.source_department)               as sample_raw,
         count(*)                               as n_jobs
  from public.jobs j
  where j.source_department is not null
    and public.dept_norm(j.source_department) is not null
    and not exists (
      select 1 from public.dept_mapping m
      where m.source_norm = public.dept_norm(j.source_department)
    )
  group by public.dept_norm(j.source_department)
  order by count(*) desc
  limit p_limit
$$;

-- Re-stamp jobs.department from dept_mapping in bounded batches (avoids the 57014 that
-- bit the last HITL). Returns rows changed; the caller loops until it returns 0.
create or replace function public.restamp_department(p_batch int default 5000)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with cte as (
    select j.id, m.unified_department
    from public.jobs j
    join public.dept_mapping m
      on m.source_norm = public.dept_norm(j.source_department)
    where j.source_department is not null
      and j.is_active
      and j.department is distinct from m.unified_department
    order by j.id
    limit p_batch
  )
  update public.jobs j
  set department = cte.unified_department
  from cte
  where j.id = cte.id;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Refresh the precomputed n_jobs on dept_mapping (keeps /admin fast — no live jobs aggregate).
create or replace function public.refresh_dept_mapping_counts()
returns void
language sql
as $$
  update public.dept_mapping m
  set n_jobs = coalesce(c.cnt, 0), updated_at = now()
  from (
    select public.dept_norm(source_department) as sn, count(*)::int as cnt
    from public.jobs
    where source_department is not null and is_active
    group by public.dept_norm(source_department)
  ) c
  where c.sn = m.source_norm
$$;

-- Internal (scraper/admin via service role) — keep off the public PostgREST surface.
revoke execute on function public.unmapped_source_depts(int)    from anon, authenticated;
revoke execute on function public.restamp_department(int)       from anon, authenticated;
revoke execute on function public.refresh_dept_mapping_counts() from anon, authenticated;
