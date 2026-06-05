-- Performance rewrite of search_jobs_kai (same signature as 20260604000004).
--
-- Problem: the previous body did `SELECT jkv.* FROM jobs_kai_view jkv WHERE <filters>`,
-- which forced the view's per-row correlated subqueries (salary_estimate = avg over
-- lca_filings, lca_last_filed = max over lca_filings) to evaluate for EVERY filtered row
-- (hundreds–thousands). Through PostgREST's role statement_timeout (~8s) this routinely
-- timed out (57014) and surfaced as a false "nothing matched" in Kai onboarding.
--
-- Fix: do all filtering + dedup + ranking + LIMIT on CHEAP base-table columns only
-- (jobs + employers + job_signals, no lca subqueries), then join jobs_kai_view for just
-- the final <= p_result_limit ids so the expensive subqueries run a handful of times.
-- The pre-LIMIT rank omits the small lca_last_filed bonus (not cheaply available); the
-- final ORDER BY re-applies the full score over the few selected rows.

CREATE OR REPLACE FUNCTION public.search_jobs_kai(
  p_cutoff           timestamptz DEFAULT now() - INTERVAL '7 days',
  p_location         text        DEFAULT NULL,
  p_location_tokens  text[]      DEFAULT NULL,
  p_query            text        DEFAULT NULL,
  p_title_keywords   text[]      DEFAULT NULL,
  p_company_keywords text[]      DEFAULT NULL,
  p_visa_tiers       text[]      DEFAULT NULL,
  p_visa_class       text        DEFAULT NULL,
  p_salary_min       numeric     DEFAULT NULL,
  p_result_limit     int         DEFAULT 10,
  p_departments      text[]      DEFAULT NULL,
  p_level            text        DEFAULT NULL,
  p_remote           boolean     DEFAULT NULL
)
RETURNS SETOF jobs_kai_view
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT j.id,
           e.name               AS company,
           e.company_domain_url AS company_domain,
           j.salary_max_num,
           js.confidence_tier   AS visa_tier,
           e.lca_count_2025,
           COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at
    FROM jobs j
    JOIN employers e   ON e.id = j.employer_id
    LEFT JOIN job_signals js ON js.job_id = j.id
    WHERE j.is_active
      AND COALESCE(j.posted_at, j.scraped_at) >= p_cutoff
      AND (p_location IS NULL OR j.location ILIKE '%' || p_location || '%')
      AND (
        p_location_tokens IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_location_tokens) AS lt(tok)
                   WHERE j.location ILIKE '%' || lt.tok || '%')
      )
      AND (p_visa_tiers IS NULL OR js.confidence_tier = ANY(p_visa_tiers))
      AND (p_visa_class IS NULL OR js.visa_class ILIKE '%' || p_visa_class || '%')
      AND (p_salary_min IS NULL OR j.salary_max_num IS NULL OR j.salary_max_num >= p_salary_min)
      AND (p_departments IS NULL OR j.department = ANY(p_departments))
      AND (p_level      IS NULL OR j.job_level  = p_level)
      AND (p_remote IS NOT TRUE OR j.is_remote)
      AND (
        p_query IS NULL
        OR j.title ILIKE '%' || p_query || '%'
        OR e.name  ILIKE '%' || p_query || '%'
      )
      AND (
        p_title_keywords IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_title_keywords) AS kw(word)
                   WHERE j.title ILIKE '%' || kw.word || '%')
      )
      AND (
        p_company_keywords IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_company_keywords) AS kw(word)
                   WHERE e.name ILIKE '%' || kw.word || '%')
      )
  ),
  deduped AS (
    SELECT DISTINCT ON (company)
           id, salary_max_num, visa_tier, lca_count_2025, company_domain, effective_posted_at
    FROM base
    ORDER BY
      company,
      CASE visa_tier WHEN 'verified' THEN 1 WHEN 'friendly' THEN 2 ELSE 3 END,
      effective_posted_at DESC
  ),
  ranked AS (
    SELECT id
    FROM deduped
    ORDER BY
      CASE visa_tier WHEN 'verified' THEN 100 WHEN 'friendly' THEN 50 ELSE 0 END
      + LEAST(COALESCE(lca_count_2025, 0), 200)
      + CASE WHEN salary_max_num IS NOT NULL AND salary_max_num > 0 THEN 75 ELSE 0 END
      + CASE WHEN effective_posted_at >= now() - INTERVAL '7 days'  THEN 50
             WHEN effective_posted_at >= now() - INTERVAL '14 days' THEN 25
             ELSE 0 END
      + CASE WHEN company_domain IS NOT NULL THEN 25 ELSE 0 END
      DESC
    LIMIT p_result_limit
  )
  SELECT jkv.*
  FROM jobs_kai_view jkv
  JOIN ranked r ON r.id = jkv.id
  ORDER BY
    CASE jkv.visa_tier WHEN 'verified' THEN 100 WHEN 'friendly' THEN 50 ELSE 0 END
    + LEAST(COALESCE(jkv.lca_count_2025, 0), 200)
    + CASE WHEN jkv.salary_max_num IS NOT NULL AND jkv.salary_max_num > 0 THEN 75 ELSE 0 END
    + CASE WHEN jkv.effective_posted_at >= now() - INTERVAL '7 days'  THEN 50
           WHEN jkv.effective_posted_at >= now() - INTERVAL '14 days' THEN 25
           ELSE 0 END
    + CASE WHEN jkv.company_domain IS NOT NULL THEN 25 ELSE 0 END
    + CASE WHEN jkv.lca_last_filed IS NOT NULL
                AND jkv.lca_last_filed >= (now() - INTERVAL '548 days')::date
           THEN 25 ELSE 0 END
    DESC;
$$;