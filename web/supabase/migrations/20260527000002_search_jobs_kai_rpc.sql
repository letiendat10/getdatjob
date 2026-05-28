-- Fix: bulk-posting employers (Lowe's: 19K jobs, Amazon: 10K jobs) crowded out
-- all other companies when the JS layer fetched top-1000 by posted_at DESC.
-- This RPC deduplicates by company at the SQL level before returning results.

CREATE OR REPLACE FUNCTION search_jobs_kai(
  p_cutoff          timestamptz DEFAULT now() - INTERVAL '7 days',
  p_location        text        DEFAULT NULL,
  p_query           text        DEFAULT NULL,
  p_title_keywords  text[]      DEFAULT NULL,
  p_company_keywords text[]     DEFAULT NULL,
  p_visa_tiers      text[]      DEFAULT NULL,   -- e.g. ARRAY['verified','friendly'] for H-1B
  p_visa_class      text        DEFAULT NULL,   -- ilike match for E-3 / TN / OPT
  p_salary_min      numeric     DEFAULT NULL,
  p_result_limit    int         DEFAULT 10
)
RETURNS SETOF jobs_kai_view
LANGUAGE sql
STABLE
AS $$
  WITH filtered AS (
    SELECT jkv.*
    FROM jobs_kai_view jkv
    WHERE jkv.posted_at >= p_cutoff
      AND (p_location      IS NULL OR jkv.location  ILIKE '%' || p_location  || '%')
      AND (p_visa_tiers    IS NULL OR jkv.visa_tier = ANY(p_visa_tiers))
      AND (p_visa_class    IS NULL OR jkv.visa_class ILIKE '%' || p_visa_class || '%')
      AND (p_salary_min    IS NULL OR jkv.salary_estimate >= p_salary_min)
      AND (
        p_query IS NULL
        OR jkv.title   ILIKE '%' || p_query || '%'
        OR jkv.company ILIKE '%' || p_query || '%'
      )
      AND (
        p_title_keywords IS NULL
        OR EXISTS (
          SELECT 1 FROM unnest(p_title_keywords) AS kw(word)
          WHERE jkv.title ILIKE '%' || kw.word || '%'
        )
      )
      AND (
        p_company_keywords IS NULL
        OR EXISTS (
          SELECT 1 FROM unnest(p_company_keywords) AS kw(word)
          WHERE jkv.company ILIKE '%' || kw.word || '%'
        )
      )
  ),
  -- One job per company: prefer verified > friendly, then most recently posted.
  deduped AS (
    SELECT DISTINCT ON (company) *
    FROM filtered
    ORDER BY
      company,
      CASE visa_tier WHEN 'verified' THEN 1 WHEN 'friendly' THEN 2 ELSE 3 END,
      posted_at DESC
  )
  -- Final ranking: mirrors the JS scoreJob() function.
  SELECT * FROM deduped
  ORDER BY
    CASE visa_tier WHEN 'verified' THEN 100 WHEN 'friendly' THEN 50 ELSE 0 END
    + LEAST(COALESCE(lca_count_2025, 0), 200)
    + CASE WHEN salary_estimate IS NOT NULL AND salary_estimate > 0 THEN 75 ELSE 0 END
    + CASE WHEN posted_at >= now() - INTERVAL '7 days'  THEN 50
           WHEN posted_at >= now() - INTERVAL '14 days' THEN 25
           ELSE 0 END
    + CASE WHEN company_domain IS NOT NULL THEN 25 ELSE 0 END
    + CASE WHEN lca_last_filed IS NOT NULL
                AND lca_last_filed >= (now() - INTERVAL '548 days')::date
           THEN 25 ELSE 0 END
    DESC
  LIMIT p_result_limit;
$$;
