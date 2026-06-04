-- Tier 2 enrichment prioritisation: spend the (scarce) enrichment budget on the jobs
-- most likely to make a visa-seeker's search better. Two levers, mirroring how
-- search_jobs_kai already ranks results for users (its scoreJob expression):
--   1. Sponsor strength    — biggest LCA filers first (the dominant +LEAST(lca_count_2025,200) term).
--   2. User-visible window  — jobs inside the Kai cascade window (<= p_window_days by
--                             effective_posted_at) before the older backlog.
-- Recency (effective_posted_at DESC) is the tiebreak within each.
--
-- Prior behaviour ordered purely by scraped_at DESC (20260604000001): newest-pulled first,
-- sponsor strength ignored. Before that the LCA tiebreak was dropped in 20260603000013 when
-- the employers JOIN was removed to beat a statement timeout. We get LCA priority back here
-- WITHOUT reintroducing that JOIN by denormalising lca_count_2025 onto jobs.enrich_priority,
-- so the whole selection stays single-table and index-ordered.

-- 1. Priority column = capped LCA count (mirrors LEAST(lca_count_2025, 200) in scoreJob).
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS enrich_priority smallint;

-- NOTE: on an already-populated jobs table this one-shot backfill rewrites every row and
-- will hit the statement timeout. On the live DB it was run in 8 modulo batches
-- (WHERE j.id % 8 = k). The IS DISTINCT FROM guard makes it a cheap no-op on re-run.
UPDATE public.jobs j
SET enrich_priority = LEAST(COALESCE(e.lca_count_2025, 0), 200)
FROM public.employers e
WHERE e.id = j.employer_id
  AND j.enrich_priority IS DISTINCT FROM LEAST(COALESCE(e.lca_count_2025, 0), 200);

-- 2. Keep it correct for newly-pulled jobs without a refresh job. (Employer LCA counts
--    change only at quarterly intake; re-run the UPDATE above after 00_quarterly_intake +
--    05_rescore touch employers.lca_count_2025 so existing rows pick up new counts.)
CREATE OR REPLACE FUNCTION public.set_job_enrich_priority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT LEAST(COALESCE(e.lca_count_2025, 0), 200)
    INTO NEW.enrich_priority
  FROM public.employers e
  WHERE e.id = NEW.employer_id;
  NEW.enrich_priority := COALESCE(NEW.enrich_priority, 0);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_set_job_enrich_priority ON public.jobs;
CREATE TRIGGER trg_set_job_enrich_priority
  BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_job_enrich_priority();

-- 3. Priority-ordered partial indexes (replace the scraped_at-only enrich indexes so each
--    branch's ORDER BY enrich_priority DESC, <recency> DESC is a plain index scan, no sort).
DROP INDEX IF EXISTS idx_jobs_enrich_queue;
DROP INDEX IF EXISTS idx_jobs_enrich_workday_posted_at;

CREATE INDEX idx_jobs_enrich_queue
  ON public.jobs (enrich_priority DESC NULLS LAST, COALESCE(posted_at, scraped_at) DESC NULLS LAST)
  WHERE is_active AND (description_text IS NULL OR description_text = '');

CREATE INDEX idx_jobs_enrich_workday_posted_at
  ON public.jobs (enrich_priority DESC NULLS LAST, scraped_at DESC NULLS LAST)
  WHERE is_active AND ats_source = 'workday'
    AND posted_at IS NULL
    AND description_text IS NOT NULL AND description_text <> '';

-- 4. Rewrite selection: window-first, sponsor-weighted, recency tiebreak. Per-branch LIMIT
--    keeps each subquery index-bounded; the outer sort runs over at most 3*p_limit rows.
DROP FUNCTION IF EXISTS public.select_enrich_candidates(text[], int);
DROP FUNCTION IF EXISTS public.select_enrich_candidates(text[], int, int);

CREATE FUNCTION public.select_enrich_candidates(
  p_ats text[], p_limit int DEFAULT 5000, p_window_days int DEFAULT 7
)
RETURNS TABLE (id bigint, ats_source text, ats_job_id text, url text, employer_id bigint)
LANGUAGE sql STABLE
AS $$
  WITH cand AS (
    -- Lane 0: missing description, inside the user-visible cascade window
    (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id,
            0 AS lane, COALESCE(j.enrich_priority, 0) AS prio,
            COALESCE(j.posted_at, j.scraped_at) AS eff
     FROM public.jobs j
     WHERE j.is_active
       AND j.ats_source = ANY(p_ats)
       AND (j.description_text IS NULL OR j.description_text = '')
       AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
       AND COALESCE(j.posted_at, j.scraped_at) >= now() - make_interval(days => p_window_days)
     ORDER BY j.enrich_priority DESC NULLS LAST, COALESCE(j.posted_at, j.scraped_at) DESC NULLS LAST
     LIMIT p_limit)
    UNION ALL
    -- Lane 1: missing description, older backlog
    (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id,
            1 AS lane, COALESCE(j.enrich_priority, 0) AS prio,
            COALESCE(j.posted_at, j.scraped_at) AS eff
     FROM public.jobs j
     WHERE j.is_active
       AND j.ats_source = ANY(p_ats)
       AND (j.description_text IS NULL OR j.description_text = '')
       AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
       AND COALESCE(j.posted_at, j.scraped_at) < now() - make_interval(days => p_window_days)
     ORDER BY j.enrich_priority DESC NULLS LAST, COALESCE(j.posted_at, j.scraped_at) DESC NULLS LAST
     LIMIT p_limit)
    UNION ALL
    -- Lane 0 (urgent, tiny set): Workday with description but no posted_at. Fixes the wrong
    -- "posted" date + lost freshness rank on otherwise-complete cards.
    (SELECT j.id, j.ats_source, j.ats_job_id, j.url, j.employer_id,
            0 AS lane, COALESCE(j.enrich_priority, 0) AS prio,
            j.scraped_at AS eff
     FROM public.jobs j
     WHERE j.is_active
       AND j.ats_source = 'workday'
       AND j.posted_at IS NULL
       AND j.description_text IS NOT NULL AND j.description_text <> ''
       AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
     ORDER BY j.enrich_priority DESC NULLS LAST, j.scraped_at DESC NULLS LAST
     LIMIT p_limit)
  )
  SELECT id, ats_source, ats_job_id, url, employer_id
  FROM cand
  ORDER BY lane, prio DESC, eff DESC
  LIMIT p_limit;
$$;

ALTER FUNCTION public.select_enrich_candidates(text[], int, int) SET statement_timeout = '20s';
