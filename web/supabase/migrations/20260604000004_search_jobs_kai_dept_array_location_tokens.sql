-- search_jobs_kai: support multi-department and multi-token (metro) location filters.
--
-- Why: the Kai onboarding/chat search wrongly returned zero results because the single
-- `p_department text` was compared with `=` against the stored 15-value taxonomy. A UX
-- bucket can map to more than one canonical department (e.g. "Data / AI" → Data + AI/ML),
-- and a city selection ("San Francisco Bay Area") must match many messy free-text city
-- strings. We switch department to `text[]` (= ANY) and add `p_location_tokens text[]`
-- (OR of ILIKE fragments). Everything else — the CTE, dedup, and ranking — is unchanged
-- from 20260603000001_jobs_filters_freshness_salary_logo.sql.
--
-- Changing a parameter's name/type changes the function signature, so we DROP the old
-- 12-arg version first (CREATE OR REPLACE can't rename a parameter in place).

DROP FUNCTION IF EXISTS public.search_jobs_kai(
  timestamptz, text, text, text[], text[], text[], text, numeric, int, text, text, boolean);

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
  WITH filtered AS (
    SELECT jkv.*
    FROM jobs_kai_view jkv
    WHERE jkv.effective_posted_at >= p_cutoff
      -- Location: single token (back-compat) AND/OR a list of metro/city fragments.
      AND (p_location IS NULL OR jkv.location ILIKE '%' || p_location || '%')
      AND (
        p_location_tokens IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_location_tokens) AS lt(tok)
                   WHERE jkv.location ILIKE '%' || lt.tok || '%')
      )
      AND (p_visa_tiers IS NULL OR jkv.visa_tier = ANY(p_visa_tiers))
      AND (p_visa_class IS NULL OR jkv.visa_class ILIKE '%' || p_visa_class || '%')
      -- Min-salary: real parsed salary only, KEEP unknowns visible (never LCA).
      AND (p_salary_min IS NULL OR jkv.salary_max_num IS NULL OR jkv.salary_max_num >= p_salary_min)
      AND (p_departments IS NULL OR jkv.department = ANY(p_departments))
      AND (p_level      IS NULL OR jkv.job_level  = p_level)
      AND (p_remote IS NOT TRUE OR jkv.is_remote)
      AND (
        p_query IS NULL
        OR jkv.title   ILIKE '%' || p_query || '%'
        OR jkv.company ILIKE '%' || p_query || '%'
      )
      AND (
        p_title_keywords IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_title_keywords) AS kw(word)
                   WHERE jkv.title ILIKE '%' || kw.word || '%')
      )
      AND (
        p_company_keywords IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_company_keywords) AS kw(word)
                   WHERE jkv.company ILIKE '%' || kw.word || '%')
      )
  ),
  deduped AS (
    SELECT DISTINCT ON (company) *
    FROM filtered
    ORDER BY
      company,
      CASE visa_tier WHEN 'verified' THEN 1 WHEN 'friendly' THEN 2 ELSE 3 END,
      effective_posted_at DESC
  )
  SELECT * FROM deduped
  ORDER BY
    CASE visa_tier WHEN 'verified' THEN 100 WHEN 'friendly' THEN 50 ELSE 0 END
    + LEAST(COALESCE(lca_count_2025, 0), 200)
    + CASE WHEN salary_max_num IS NOT NULL AND salary_max_num > 0 THEN 75 ELSE 0 END
    + CASE WHEN effective_posted_at >= now() - INTERVAL '7 days'  THEN 50
           WHEN effective_posted_at >= now() - INTERVAL '14 days' THEN 25
           ELSE 0 END
    + CASE WHEN company_domain IS NOT NULL THEN 25 ELSE 0 END
    + CASE WHEN lca_last_filed IS NOT NULL
                AND lca_last_filed >= (now() - INTERVAL '548 days')::date
           THEN 25 ELSE 0 END
    DESC
  LIMIT p_result_limit;
$$;
