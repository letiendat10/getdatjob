-- Part 3: the filter-options source of truth. The DISTINCT unified department values
-- present on active jobs (busiest first) ARE the dropdown vocabulary on every surface.
-- When dept_mapping changes and jobs.department is re-stamped, this automatically follows.
create or replace function public.department_facets()
returns table(department text, n bigint)
language sql
stable
as $$
  select department, count(*) as n
  from public.jobs
  where is_active and department is not null and department <> ''
  group by department
  order by count(*) desc
$$;

-- Public, read-only filter data (same exposure as get_active_companies, called with the anon key).
grant execute on function public.department_facets() to anon, authenticated;
