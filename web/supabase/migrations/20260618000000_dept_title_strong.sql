-- Tier 4 (2026-06-18 human QA): a SPECIFIC title discipline must beat a coarse or garbage
-- source_department. E.g. "Data Analyst" in an org named "Engineering" → Data, not Engineering;
-- "Data Scientist, Marketing" → Data, not Marketing. Today restamp_department unconditionally
-- prefers the dept_mapping value for any job with a source_department, overwriting the (correct)
-- title classification.
--
-- jobs.title_dept_strong caches classify.py:strong_title_department(title) — the unambiguous
-- discipline named in the title, or NULL when the title is generic ("Manager", "Associate").
-- restamp now writes COALESCE(title_dept_strong, mapping): a strong title wins; a generic title
-- still defers to the source_department mapping (the case map_source_dept was built for).
-- Populated by the pull writers (03/0606/04) going forward and by a one-off backfill for the
-- existing corpus.

alter table public.jobs add column if not exists title_dept_strong text;

create or replace function public.restamp_department(p_batch int default 5000)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with cte as (
    select j.id, coalesce(j.title_dept_strong, m.unified_department) as dept
    from public.jobs j
    join public.dept_mapping m
      on m.source_norm = public.dept_norm(j.source_department)
    where j.source_department is not null
      and j.is_active
      and j.department is distinct from coalesce(j.title_dept_strong, m.unified_department)
    order by j.id
    limit p_batch
  )
  update public.jobs j
  set department = cte.dept
  from cte
  where j.id = cte.id;
  get diagnostics n = row_count;
  return n;
end
$$;
