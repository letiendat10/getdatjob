-- Routine card-health QA: a daily snapshot of the metrics that decide whether the
-- job card is accurate (every chip true) and joyful (rich, fresh, non-misleading).
--
-- Scope = jobs users actually browse: effective_posted_at within the last N days
-- (default 7), NOT the full backlog. Every metric is a single-pass aggregate, so
-- daily full-window coverage is cheap. refresh_card_health() upserts today's row and
-- returns the metrics; scrapers/10_qa_card_health.py reads the history to alert on
-- regressions + integrity breaches.

CREATE TABLE IF NOT EXISTS public.card_health_snapshot (
  captured_on date        PRIMARY KEY DEFAULT current_date,
  window_days int         NOT NULL DEFAULT 7,
  metrics     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Internal/admin table — service role only. RLS on with no policy = no anon/auth
-- access (service_role bypasses RLS), matching how the QA script reads it.
ALTER TABLE public.card_health_snapshot ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER so the cron's anon-keyed client can still write the RLS-locked
-- snapshot table (mirrors refresh_stats_shelf). search_path pinned for safety.
CREATE OR REPLACE FUNCTION public.refresh_card_health(p_window_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m jsonb;
BEGIN
  WITH w AS (
    SELECT j.is_us, j.description_text, j.salary_range, j.salary_min_num, j.salary_period,
           j.posted_at, j.scraped_at, j.department, j.job_level, j.is_remote, j.ats_source,
           js.confidence_tier, e.poc_email, e.company_domain_url
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
        ('Entry/Junior','Senior','Lead/Manager','Director','VP')) AS bad_level,
      count(*) FILTER (WHERE department IS NOT NULL AND department NOT IN
        ('AI / ML','Data','Security','Design','Product','Finance','Legal','HR / People',
         'Customer Success','Marketing/Growth','Sales','Platform / DevOps','Facilities',
         'Operations','Engineering')) AS bad_dept,
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
