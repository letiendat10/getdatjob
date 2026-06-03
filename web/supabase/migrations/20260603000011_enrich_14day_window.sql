-- Narrow the enrichment queue to jobs scraped within the last 14 days.
-- Rationale: enriching old Workday/iCIMS/SmartRecruiters jobs burns the
-- per-run budget on listings that are likely to expire soon anyway.
-- Focusing on recently-scraped jobs keeps descriptions current and fast.
--
-- scraped_at is the right anchor (not effective_posted_at) because posted_at
-- is NULL for list-only ATSes until this enrichment pass fills it in.

CREATE OR REPLACE FUNCTION public.select_enrich_candidates(p_ats text[], p_limit int DEFAULT 5000)
RETURNS TABLE (id bigint, ats_source text, ats_job_id text, url text, employer_id bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id
  FROM jobs j
  JOIN employers e ON e.id = j.employer_id
  WHERE j.is_active
    AND j.ats_source = ANY(p_ats)
    AND (j.description_text IS NULL OR j.description_text = '')
    AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
    AND j.scraped_at >= now() - INTERVAL '14 days'
  ORDER BY j.enrich_attempted_at ASC NULLS FIRST, e.lca_count DESC NULLS LAST, j.id
  LIMIT p_limit;
$$;
