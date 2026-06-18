-- card_health integrity lists drifted from the live taxonomy, so the daily QA was
-- permanently red on legitimate values and the alerts stopped meaning anything:
--   * bad_dept counted against the hardcoded canonical 15, flagging every governed
--     LLM/human-coined bucket in dept_mapping (R&D, Product Management, Healthcare, …).
--     bad = a department with NO governance trail: neither canonical nor present in
--     dept_mapping.unified_department.
--   * bad_level was missing 'Principal / Staff' (canonical 6, classify.py/taxonomy.ts),
--     flagging every Principal/Staff job since the level taxonomy shipped.
-- Also backports two prod-only hotfixes the 20260603000004 file never got (so this file
-- IS the deployed body): j.salary_max_num in the w CTE (salary_shown_no_num reads it),
-- and the 60s statement_timeout from 20260603000008 (CREATE OR REPLACE resets proconfig,
-- so it must live in the definition).

CREATE OR REPLACE FUNCTION public.refresh_card_health(p_window_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  m jsonb;
BEGIN
  WITH w AS (
    SELECT j.is_us, j.description_text, j.salary_range, j.salary_min_num, j.salary_max_num,
           j.salary_period, j.posted_at, j.scraped_at, j.department, j.job_level, j.is_remote,
           j.ats_source, js.confidence_tier, e.poc_email, e.company_domain_url
    FROM jobs j
    JOIN employers e ON e.id = j.employer_id
    LEFT JOIN job_signals js ON js.job_id = j.id
    WHERE j.is_active
      AND COALESCE(j.posted_at, j.scraped_at) >= now() - (p_window_days || ' days')::interval
  ),
  agg AS (
    SELECT
      count(*) AS total,
      -- coverage %
      round(100.0*count(*) FILTER (WHERE description_text IS NOT NULL AND description_text <> '')/nullif(count(*),0),1) AS desc_pct,
      round(100.0*count(*) FILTER (WHERE salary_range IS NOT NULL)/nullif(count(*),0),1) AS salary_range_pct,
      round(100.0*count(*) FILTER (WHERE salary_min_num IS NOT NULL)/nullif(count(*),0),1) AS salary_num_pct,
      round(100.0*count(*) FILTER (WHERE posted_at IS NOT NULL)/nullif(count(*),0),1) AS real_posted_pct,
      round(100.0*count(*) FILTER (WHERE department IS NOT NULL)/nullif(count(*),0),1) AS dept_pct,
      round(100.0*count(*) FILTER (WHERE job_level IS NOT NULL)/nullif(count(*),0),1) AS level_pct,
      round(100.0*count(*) FILTER (WHERE is_remote)/nullif(count(*),0),1) AS remote_pct,
      round(100.0*count(*) FILTER (WHERE poc_email IS NOT NULL)/nullif(count(*),0),1) AS poc_pct,
      round(100.0*count(*) FILTER (WHERE company_domain_url IS NOT NULL)/nullif(count(*),0),1) AS logo_pct,
      -- tier mix (tracked, not alarmed — friendly >> verified is expected/honest)
      count(*) FILTER (WHERE confidence_tier='verified') AS tier_verified,
      count(*) FILTER (WHERE confidence_tier='friendly') AS tier_friendly,
      count(*) FILTER (WHERE confidence_tier='excluded') AS tier_excluded,
      count(*) FILTER (WHERE confidence_tier IS NULL)    AS tier_null,
      -- integrity invariants — every one MUST be 0
      count(*) FILTER (WHERE job_level IS NOT NULL AND job_level NOT IN
        ('Entry/Junior','Senior','Principal / Staff','Lead/Manager','Director','VP')) AS bad_level,
      count(*) FILTER (WHERE department IS NOT NULL
        AND department NOT IN
          ('AI / ML','Data','Security','Design','Product','Finance','Legal','HR / People',
           'Customer Success','Marketing/Growth','Sales','Platform / DevOps','Facilities',
           'Operations','Engineering')
        AND department NOT IN
          (SELECT dm.unified_department FROM public.dept_mapping dm
           WHERE dm.unified_department IS NOT NULL)) AS bad_dept,
      count(*) FILTER (WHERE salary_period IS NOT NULL AND salary_period NOT IN ('annual','hourly')) AS bad_salary_period,
      count(*) FILTER (WHERE confidence_tier IS NOT NULL AND confidence_tier NOT IN
        ('verified','friendly','excluded')) AS bad_tier,
      count(*) FILTER (WHERE is_us IS FALSE) AS non_us_leak,
      -- salary shown but no numeric at all (neither bound) → not filterable. "Up to $X"
      -- (max set) and "$X+" (min set) are fine; the min-salary filter keys on salary_max_num.
      count(*) FILTER (WHERE salary_range IS NOT NULL AND salary_min_num IS NULL AND salary_max_num IS NULL) AS salary_shown_no_num,
      -- freshness
      round(100.0*count(*) FILTER (WHERE COALESCE(posted_at,scraped_at) >= now()-interval '7 days')/nullif(count(*),0),1) AS fresh_7d_pct
    FROM w
  ),
  per_ats AS (
    SELECT coalesce(jsonb_object_agg(ats_source, jsonb_build_object(
             'n', n, 'desc_pct', desc_pct, 'posted_pct', posted_pct, 'salary_pct', salary_pct)), '{}'::jsonb) AS by_ats
    FROM (
      SELECT ats_source, count(*) n,
        round(100.0*count(*) FILTER (WHERE description_text IS NOT NULL AND description_text <> '')/count(*),1) desc_pct,
        round(100.0*count(*) FILTER (WHERE posted_at IS NOT NULL)/count(*),1) posted_pct,
        round(100.0*count(*) FILTER (WHERE salary_range IS NOT NULL)/count(*),1) salary_pct
      FROM w GROUP BY ats_source
    ) s
  )
  SELECT to_jsonb(agg) || jsonb_build_object('by_ats', per_ats.by_ats, 'window_days', p_window_days)
  INTO m
  FROM agg CROSS JOIN per_ats;

  INSERT INTO public.card_health_snapshot (captured_on, window_days, metrics)
  VALUES (current_date, p_window_days, m)
  ON CONFLICT (captured_on)
  DO UPDATE SET window_days = excluded.window_days, metrics = excluded.metrics, created_at = now();

  RETURN m;
END;
$$;
