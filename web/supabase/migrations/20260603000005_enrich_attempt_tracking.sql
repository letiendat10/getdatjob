-- Make list-only enrichment (Workday/SmartRecruiters/iCIMS) prioritize the strongest
-- sponsors and never head-of-line block on failures.
--
-- enrich_attempted_at is stamped on EVERY attempt (success or failure) by
-- 04_enrich_descriptions.py; select_enrich_candidates() orders never-tried jobs at the
-- highest-LCA employers first, and lets a failed job cool down 7 days (rotate to the
-- back) instead of being re-selected forever and burning the per-run budget — the bug
-- that left Workday at 5/101,495 enriched once CI was also fixed.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS enrich_attempted_at timestamptz;

-- Partial index over the live enrichment queue (still-empty descriptions).
CREATE INDEX IF NOT EXISTS idx_jobs_enrich_queue
  ON public.jobs (enrich_attempted_at NULLS FIRST)
  WHERE is_active AND (description_text IS NULL OR description_text = '');

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
  ORDER BY j.enrich_attempted_at ASC NULLS FIRST, e.lca_count DESC NULLS LAST, j.id
  LIMIT p_limit;
$$;
