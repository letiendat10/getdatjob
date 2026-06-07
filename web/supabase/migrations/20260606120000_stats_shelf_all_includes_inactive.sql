-- Landing-page hero "total jobs" comes from stats_shelf('all').job_count via getStats().
-- Make it count ALL jobs (active AND inactive) so it matches the /jobs "total jobs" number
-- (job_stats.total_count, which the daily puller now writes as active + inactive).
--
-- Only the 'all' bucket changes. The per-visa buckets (h1b / e3 / tn / opt) stay active-only —
-- they represent currently-open roles in that category. 'total_sponsors' is unchanged.
--
-- NOTE: this function had stopped refreshing in prod (stats_shelf was 7 days stale) because the
-- Vercel cron /api/cron/refresh-stats is the 5th cron entry and Vercel Hobby honors only 2.
-- The daily GitHub scraper (03_pull_jobs_enriched_0606.py) now calls refresh_stats_shelf() at
-- the end of every run, so freshness no longer depends on the capped Vercel cron.

CREATE OR REPLACE FUNCTION public.refresh_stats_shelf()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_h1b_jobs      bigint;
  v_h1b_employers bigint;
  v_e3_jobs       bigint;
  v_e3_employers  bigint;
  v_tn_jobs       bigint;
  v_tn_employers  bigint;
  v_opt_jobs      bigint;
  v_opt_employers bigint;
  v_all_jobs      bigint;
  v_all_employers bigint;
  v_total_sponsors bigint;
BEGIN
  SELECT
    COUNT(*)              FILTER (WHERE j.is_active AND e.visa_types @> ARRAY['H-1B']),
    COUNT(DISTINCT j.employer_id) FILTER (WHERE j.is_active AND e.visa_types @> ARRAY['H-1B'])
  INTO v_h1b_jobs, v_h1b_employers
  FROM jobs j JOIN employers e ON e.id = j.employer_id;

  SELECT
    COUNT(*)              FILTER (WHERE j.is_active AND e.e3_lca_count > 0),
    COUNT(DISTINCT j.employer_id) FILTER (WHERE j.is_active AND e.e3_lca_count > 0)
  INTO v_e3_jobs, v_e3_employers
  FROM jobs j JOIN employers e ON e.id = j.employer_id;

  SELECT
    COUNT(*)              FILTER (WHERE j.is_active AND j.tn_eligible),
    COUNT(DISTINCT j.employer_id) FILTER (WHERE j.is_active AND j.tn_eligible)
  INTO v_tn_jobs, v_tn_employers
  FROM jobs j JOIN employers e ON e.id = j.employer_id;

  SELECT
    COUNT(*) FILTER (WHERE j.is_active),
    COUNT(DISTINCT j.employer_id) FILTER (WHERE j.is_active)
  INTO v_opt_jobs, v_opt_employers
  FROM jobs j;

  -- 'all' = active + inactive (matches /jobs total_count). No is_active filter.
  SELECT
    COUNT(*),
    COUNT(DISTINCT j.employer_id)
  INTO v_all_jobs, v_all_employers
  FROM jobs j;

  -- Total USCIS-verified sponsors in our DB (regardless of active jobs)
  SELECT COUNT(*) INTO v_total_sponsors FROM employers;

  INSERT INTO stats_shelf (visa_type, job_count, employer_count, updated_at) VALUES
    ('h1b',            v_h1b_jobs,      v_h1b_employers,  now()),
    ('e3',             v_e3_jobs,       v_e3_employers,   now()),
    ('tn',             v_tn_jobs,       v_tn_employers,   now()),
    ('opt',            v_opt_jobs,      v_opt_employers,  now()),
    ('all',            v_all_jobs,      v_all_employers,  now()),
    ('total_sponsors', 0,               v_total_sponsors, now())
  ON CONFLICT (visa_type) DO UPDATE SET
    job_count      = EXCLUDED.job_count,
    employer_count = EXCLUDED.employer_count,
    updated_at     = EXCLUDED.updated_at;
END;
$function$;
