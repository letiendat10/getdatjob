-- select_enrich_candidates was ordering by id ASC as the tiebreaker for
-- never-attempted jobs, so the newest pulls (highest IDs) sat behind 97k
-- historical rows and waited 5+ hours for their first enrichment.
-- Fix: order by scraped_at DESC so today's jobs surface first.

DROP INDEX IF EXISTS idx_jobs_enrich_queue;
DROP INDEX IF EXISTS idx_jobs_enrich_workday_posted_at;

-- Static predicate only (no now() — not immutable in index)
CREATE INDEX idx_jobs_enrich_queue
  ON public.jobs (scraped_at DESC NULLS LAST)
  WHERE is_active AND (description_text IS NULL OR description_text = '');

CREATE INDEX idx_jobs_enrich_workday_posted_at
  ON public.jobs (scraped_at DESC NULLS LAST)
  WHERE is_active AND ats_source = 'workday'
    AND posted_at IS NULL
    AND description_text IS NOT NULL AND description_text != '';

CREATE OR REPLACE FUNCTION public.select_enrich_candidates(
  p_ats text[], p_limit int DEFAULT 5000
)
RETURNS TABLE (id bigint, ats_source text, ats_job_id text, url text, employer_id bigint)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id
   FROM jobs j
   WHERE j.is_active
     AND j.ats_source = ANY(p_ats)
     AND (j.description_text IS NULL OR j.description_text = '')
     AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
   ORDER BY j.scraped_at DESC NULLS LAST
   LIMIT p_limit)
  UNION ALL
  (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id
   FROM jobs j
   WHERE j.is_active
     AND j.ats_source = 'workday'
     AND j.posted_at IS NULL
     AND j.description_text IS NOT NULL AND j.description_text != ''
     AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
   ORDER BY j.scraped_at DESC NULLS LAST
   LIMIT p_limit)
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.select_enrich_candidates(text[], int) SET statement_timeout = '20s';
