-- unmapped_titles aggregates job_signals ⋈ jobs (group by title_clean) — ~26s cold, over the
-- service-role 20s cap. It's an OFFLINE batch RPC (map_title_soc), not a user request, so make it
-- plpgsql with its own higher statement_timeout (a language sql function inlines, so a SET on it
-- is ignored — same lesson as next_review_batch). Body refs are table-qualified to avoid clashing
-- with the OUT column names.
create or replace function public.unmapped_titles(p_limit int default 5000)
returns table(title_clean text, sample_raw text, n_jobs bigint)
language plpgsql
stable
set statement_timeout to '180s'
as $$
begin
  return query
    select js.title_clean,
           min(j.title) as sample_raw,
           count(*)     as n_jobs
    from public.job_signals js
    join public.jobs j on j.id = js.job_id
    where j.is_active
      and js.title_clean is not null and js.title_clean <> ''
      and not exists (select 1 from public.title_soc_map m where m.title_clean = js.title_clean)
    group by js.title_clean
    order by count(*) desc
    limit p_limit;
end
$$;

revoke execute on function public.unmapped_titles(int) from anon, authenticated;
