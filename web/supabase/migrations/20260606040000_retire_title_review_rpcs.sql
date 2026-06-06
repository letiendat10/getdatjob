-- Retire the old per-title HITL. /admin/review (which timed out — a Vercel request running a
-- live 136K-row aggregation) is deleted and superseded by /admin/departments (department) and
-- /admin/soc (occupation / verified tag). Drop the RPCs it used. The title_reviews table (a
-- handful of rows) is left intact and harmless.
do $$
declare r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where proname in ('next_review_batch', 'apply_title_review')
      and pronamespace = 'public'::regnamespace
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;
