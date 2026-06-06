-- Up to 2 example active job postings per normalized raw department, for the
-- /admin/departments review UI: many raw ATS department strings are cryptic
-- ("7LQ", "Mfg (JDS)", "6D3"), so linking 2 real postings lets the owner see what
-- the bucket actually contains before deciding the unified mapping.
create or replace function public.dept_mapping_examples()
returns table(source_norm text, examples jsonb)
language sql
stable
as $$
  select s.source_norm,
         jsonb_agg(jsonb_build_object('url', s.url, 'title', s.title) order by s.rn)
  from (
    select public.dept_norm(j.source_department) as source_norm,
           j.url, j.title,
           row_number() over (
             partition by public.dept_norm(j.source_department)
             order by j.id desc
           ) as rn
    from public.jobs j
    where j.source_department is not null
      and j.is_active
      and j.url is not null
  ) s
  where s.rn <= 2
  group by s.source_norm
$$;

-- Internal (admin reads server-side via the service role) — keep off the public surface.
revoke execute on function public.dept_mapping_examples() from anon, authenticated;
