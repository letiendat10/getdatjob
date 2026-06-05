-- Backward-compat: restore a scalar `p_department` alias on search_jobs_kai.
--
-- 20260604000004 renamed p_department -> p_departments (text[]). That changed the function
-- signature, so the PREVIOUSLY DEPLOYED web build (which calls the RPC with p_department +
-- p_location) would fail to resolve the function until the new build ships. To avoid a
-- breakage window on the live site, accept BOTH: p_departments (new, array) and the
-- deprecated p_department (old, scalar). New code passes p_departments; old code passes
-- p_department; either is merged into the effective department list.

DROP FUNCTION IF EXISTS public.search_jobs_kai(
  timestamptz, text, text[], text, text[], text[], text[], text, numeric, int, text[], text, boolean);

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
  p_remote           boolean     DEFAULT NULL,
  p_department       text        DEFAULT NULL   -- deprecated scalar alias (old web builds)
)
RETURNS SETOF jobs_kai_view
LANGUAGE plpgsql
STABLE
AS $func$
DECLARE
  v_depts text[] := COALESCE(p_departments,
                             CASE WHEN p_department IS NOT NULL THEN ARRAY[p_department] END);
BEGIN
  RETURN QUERY EXECUTE $q$
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
        AND COALESCE(j.posted_at, j.scraped_at) >= $1
        AND ($2 IS NULL OR j.location ILIKE '%' || $2 || '%')
        AND ($3 IS NULL OR EXISTS (SELECT 1 FROM unnest($3) AS lt(tok)
                                   WHERE j.location ILIKE '%' || lt.tok || '%'))
        AND ($7 IS NULL OR js.confidence_tier = ANY($7))
        AND ($8 IS NULL OR js.visa_class ILIKE '%' || $8 || '%')
        AND ($9 IS NULL OR j.salary_max_num IS NULL OR j.salary_max_num >= $9)
        AND ($11 IS NULL OR j.department = ANY($11))
        AND ($12 IS NULL OR j.job_level = $12)
        AND ($13 IS NOT TRUE OR j.is_remote)
        AND ($4 IS NULL OR j.title ILIKE '%' || $4 || '%' OR e.name ILIKE '%' || $4 || '%')
        AND ($5 IS NULL OR EXISTS (SELECT 1 FROM unnest($5) AS kw(word)
                                   WHERE j.title ILIKE '%' || kw.word || '%'))
        AND ($6 IS NULL OR EXISTS (SELECT 1 FROM unnest($6) AS kw(word)
                                   WHERE e.name ILIKE '%' || kw.word || '%'))
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
      LIMIT $10
    )
    SELECT
      j.id, j.title, e.name, e.company_domain_url, j.location, j.url, j.posted_at,
      js.confidence_tier, js.visa_class, e.lca_count, j.ats_source, j.ats_job_id,
      j.salary_range, NULL::numeric AS salary_estimate, e.lca_count_2025,
      (SELECT max(lf.received_date) FROM lca_filings lf WHERE lf.employer_id = j.employer_id) AS lca_last_filed,
      e.poc_first_name, e.poc_last_name, e.poc_email,
      COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at,
      j.department, j.job_level, j.salary_min_num, j.salary_max_num, j.salary_period, j.is_remote
    FROM ranked r
    JOIN jobs j        ON j.id = r.id
    JOIN employers e   ON e.id = j.employer_id
    LEFT JOIN job_signals js ON js.job_id = j.id
    ORDER BY
      CASE js.confidence_tier WHEN 'verified' THEN 100 WHEN 'friendly' THEN 50 ELSE 0 END
      + LEAST(COALESCE(e.lca_count_2025, 0), 200)
      + CASE WHEN j.salary_max_num IS NOT NULL AND j.salary_max_num > 0 THEN 75 ELSE 0 END
      + CASE WHEN COALESCE(j.posted_at, j.scraped_at) >= now() - INTERVAL '7 days'  THEN 50
             WHEN COALESCE(j.posted_at, j.scraped_at) >= now() - INTERVAL '14 days' THEN 25
             ELSE 0 END
      + CASE WHEN e.company_domain_url IS NOT NULL THEN 25 ELSE 0 END
      + CASE WHEN (SELECT max(lf.received_date) FROM lca_filings lf WHERE lf.employer_id = j.employer_id)
                  >= (now() - INTERVAL '548 days')::date THEN 25 ELSE 0 END
      DESC
  $q$
  USING p_cutoff, p_location, p_location_tokens, p_query, p_title_keywords,
        p_company_keywords, p_visa_tiers, p_visa_class, p_salary_min, p_result_limit,
        v_depts, p_level, p_remote;
END;
$func$;