-- next_review_batch was timing out. Root causes:
--
-- 1. LANGUAGE sql STABLE → function is inlined by planner → ALTER FUNCTION SET
--    statement_timeout has NO effect on inlined functions. PostgREST's role-level
--    timeout (~8s) applies instead.
--
-- 2. Planner drove the join from job_signals (9,888 verified rows, ~1s scan) instead
--    of the much smaller recent-jobs set (~3,689 rows in 24h). The hash join was
--    ~1.9s warm-cache, potentially 8s+ cold.
--
-- Fix:
-- • Covering partial index (INCLUDE title_clean) so LATERAL lookups are index-only.
-- • Rewrite to LANGUAGE plpgsql — blocks inlining, so statement_timeout GUC applies.
-- • JOIN LATERAL forces nested-loop from recent jobs (3,689) → job_signals, using
--   the covering index. Each lookup takes ~0.006ms; total job_signals cost ~22ms
--   vs 1,076ms previously. Result: 764ms total vs 1,900ms.
-- • NOT EXISTS instead of NOT IN (avoids anti-join degrade as title_reviews grows).

CREATE INDEX IF NOT EXISTS idx_job_signals_verified_job
  ON public.job_signals (job_id)
  WHERE confidence_tier = 'verified';

CREATE INDEX IF NOT EXISTS idx_job_signals_job_id
  ON public.job_signals (job_id);

CREATE INDEX IF NOT EXISTS idx_job_signals_verified_covering
  ON public.job_signals (job_id)
  INCLUDE (title_clean)
  WHERE confidence_tier = 'verified';

CREATE OR REPLACE FUNCTION public.next_review_batch(p_limit int DEFAULT 10, p_hours int DEFAULT 24)
RETURNS TABLE (
  id bigint, title text, company text, location text, url text,
  posted_at timestamptz, effective_posted_at timestamptz,
  department text, job_level text, title_clean text,
  salary_range text, company_domain text,
  e3_lca_count int, lca_count int, lca_count_2025 int, confidence_tier text
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH recent AS MATERIALIZED (
    SELECT j.id, j.title, j.location, j.url, j.posted_at, j.scraped_at,
           j.department, j.job_level, j.salary_range, j.employer_id
    FROM jobs j
    WHERE j.is_active
      AND COALESCE(j.posted_at, j.scraped_at) >= now() - make_interval(hours => p_hours)
      AND NOT EXISTS (
        SELECT 1 FROM title_reviews WHERE title_norm = lower(j.title)
      )
  )
  SELECT d.id, d.title, d.company, d.location, d.url, d.posted_at, d.effective_posted_at,
         d.department, d.job_level, d.title_clean, d.salary_range, d.company_domain,
         d.e3_lca_count, d.lca_count, d.lca_count_2025, d.confidence_tier
  FROM (
    SELECT DISTINCT ON (lower(r.title))
      r.id, r.title, e.name AS company, r.location, r.url,
      r.posted_at, COALESCE(r.posted_at, r.scraped_at) AS effective_posted_at,
      r.department, r.job_level, js.title_clean,
      r.salary_range, e.company_domain_url AS company_domain,
      e.e3_lca_count, e.lca_count, e.lca_count_2025, 'verified'::text AS confidence_tier
    FROM recent r
    JOIN LATERAL (
      SELECT js.title_clean
      FROM job_signals js
      WHERE js.job_id = r.id AND js.confidence_tier = 'verified'
      LIMIT 1
    ) js ON TRUE
    JOIN employers e ON e.id = r.employer_id
    ORDER BY lower(r.title), e.lca_count DESC NULLS LAST,
             COALESCE(r.posted_at, r.scraped_at) DESC
  ) d
  ORDER BY d.lca_count DESC NULLS LAST, d.effective_posted_at DESC
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.next_review_batch(int, int) SET statement_timeout = '15s';
