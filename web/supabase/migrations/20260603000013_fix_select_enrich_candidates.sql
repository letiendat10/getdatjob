-- The OR condition in select_enrich_candidates defeats the partial index and causes
-- statement timeouts. Fix: add a partial index for the Workday/posted_at branch,
-- rewrite with UNION ALL so each branch can use its own index independently.

CREATE INDEX IF NOT EXISTS idx_jobs_enrich_workday_posted_at
  ON public.jobs (enrich_attempted_at NULLS FIRST)
  WHERE is_active AND ats_source = 'workday' AND posted_at IS NULL
    AND description_text IS NOT NULL AND description_text != '';

CREATE OR REPLACE FUNCTION public.select_enrich_candidates(
  p_ats text[], p_limit int DEFAULT 5000
)
RETURNS TABLE (id bigint, ats_source text, ats_job_id text, url text, employer_id bigint)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  -- Branch 1: jobs with no description yet (all ATS sources)
  (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id
   FROM jobs j
   WHERE j.is_active
     AND j.ats_source = ANY(p_ats)
     AND (j.description_text IS NULL OR j.description_text = '')
     AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
   ORDER BY j.enrich_attempted_at ASC NULLS FIRST, j.id
   LIMIT p_limit)
  UNION ALL
  -- Branch 2: Workday jobs with description but missing posted_at
  (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id
   FROM jobs j
   WHERE j.is_active
     AND j.ats_source = 'workday'
     AND j.posted_at IS NULL
     AND j.description_text IS NOT NULL AND j.description_text != ''
     AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
   ORDER BY j.enrich_attempted_at ASC NULLS FIRST, j.id
   LIMIT p_limit)
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.select_enrich_candidates(text[], int) SET statement_timeout = '20s';
