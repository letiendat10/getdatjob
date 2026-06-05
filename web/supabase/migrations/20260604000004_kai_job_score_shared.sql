-- Single source of truth for the Kai relevance score, so jobs.enrich_priority can never
-- drift from how search_jobs_kai ranks jobs for users. The inline scoreJob expression is
-- extracted into kai_job_score(); search_jobs_kai's ORDER BYs call it (verified
-- byte-identical: 0 mismatches over jobs_kai_view), and enrich_priority is recomputed from
-- the SAME function with the enrichment/time terms nulled -> the sponsor-stable floor
-- (verified +100 > friendly +50 > rest, plus LCA up to +200). Change a weight once and both
-- the search ranking and the enrichment queue follow.
--
-- NOTE: the LIVE search_jobs_kai is the 13-arg overload (p_location_tokens + p_departments[],
-- plpgsql/dynamic-SQL) that the app calls. An older 12-arg overload (p_department singular)
-- was stale and unused — this migration drops it to remove call ambiguity.
--
-- enrich_priority upkeep moves from the jobs BEFORE INSERT trigger to a job_signals
-- statement trigger, because visa_tier = job_signals.confidence_tier (per-job, written by
-- 03 on pull and rewritten daily by 05_rescore) -> it refreshes exactly when its inputs
-- change, never on a separate schedule.

-- 1. The shared score (exact copy of the prior inline ORDER BY expression).
CREATE OR REPLACE FUNCTION public.kai_job_score(
  p_visa_tier text, p_lca_count_2025 int, p_salary_max_num numeric,
  p_effective_posted_at timestamptz, p_company_domain text, p_lca_last_filed date
) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT (
    CASE p_visa_tier WHEN 'verified' THEN 100 WHEN 'friendly' THEN 50 ELSE 0 END
    + LEAST(COALESCE(p_lca_count_2025, 0), 200)
    + CASE WHEN p_salary_max_num IS NOT NULL AND p_salary_max_num > 0 THEN 75 ELSE 0 END
    + CASE WHEN p_effective_posted_at >= now() - INTERVAL '7 days'  THEN 50
           WHEN p_effective_posted_at >= now() - INTERVAL '14 days' THEN 25 ELSE 0 END
    + CASE WHEN p_company_domain IS NOT NULL THEN 25 ELSE 0 END
    + CASE WHEN p_lca_last_filed IS NOT NULL
                AND p_lca_last_filed >= (now() - INTERVAL '548 days')::date THEN 25 ELSE 0 END
  )::int
$$;
GRANT EXECUTE ON FUNCTION public.kai_job_score(text,int,numeric,timestamptz,text,date)
  TO anon, authenticated, service_role;

-- 2. search_jobs_kai (live 13-arg overload): both ORDER BYs now call kai_job_score. The
--    ranked CTE preserves its prior behaviour (it omitted the last-filed term) by passing
--    NULL for p_lca_last_filed; the final sort passes the real value.
CREATE OR REPLACE FUNCTION public.search_jobs_kai(
  p_cutoff timestamp with time zone DEFAULT (now() - '7 days'::interval),
  p_location text DEFAULT NULL::text, p_location_tokens text[] DEFAULT NULL::text[],
  p_query text DEFAULT NULL::text, p_title_keywords text[] DEFAULT NULL::text[],
  p_company_keywords text[] DEFAULT NULL::text[], p_visa_tiers text[] DEFAULT NULL::text[],
  p_visa_class text DEFAULT NULL::text, p_salary_min numeric DEFAULT NULL::numeric,
  p_result_limit integer DEFAULT 10, p_departments text[] DEFAULT NULL::text[],
  p_level text DEFAULT NULL::text, p_remote boolean DEFAULT NULL::boolean
) RETURNS SETOF jobs_kai_view LANGUAGE plpgsql STABLE AS $function$
BEGIN
  RETURN QUERY EXECUTE $q$
    WITH base AS (
      SELECT j.id, e.name AS company, e.company_domain_url AS company_domain, j.salary_max_num,
             js.confidence_tier AS visa_tier, e.lca_count_2025,
             COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at
      FROM jobs j
      JOIN employers e ON e.id = j.employer_id
      LEFT JOIN job_signals js ON js.job_id = j.id
      WHERE j.is_active
        AND COALESCE(j.posted_at, j.scraped_at) >= $1
        AND ($2 IS NULL OR j.location ILIKE '%' || $2 || '%')
        AND ($3 IS NULL OR EXISTS (SELECT 1 FROM unnest($3) AS lt(tok) WHERE j.location ILIKE '%' || lt.tok || '%'))
        AND ($7 IS NULL OR js.confidence_tier = ANY($7))
        AND ($8 IS NULL OR js.visa_class ILIKE '%' || $8 || '%')
        AND ($9 IS NULL OR j.salary_max_num IS NULL OR j.salary_max_num >= $9)
        AND ($11 IS NULL OR j.department = ANY($11))
        AND ($12 IS NULL OR j.job_level = $12)
        AND ($13 IS NOT TRUE OR j.is_remote)
        AND ($4 IS NULL OR j.title ILIKE '%' || $4 || '%' OR e.name ILIKE '%' || $4 || '%')
        AND ($5 IS NULL OR EXISTS (SELECT 1 FROM unnest($5) AS kw(word) WHERE j.title ILIKE '%' || kw.word || '%'))
        AND ($6 IS NULL OR EXISTS (SELECT 1 FROM unnest($6) AS kw(word) WHERE e.name ILIKE '%' || kw.word || '%'))
    ),
    deduped AS (
      SELECT DISTINCT ON (company) id, salary_max_num, visa_tier, lca_count_2025, company_domain, effective_posted_at
      FROM base
      ORDER BY company, CASE visa_tier WHEN 'verified' THEN 1 WHEN 'friendly' THEN 2 ELSE 3 END, effective_posted_at DESC
    ),
    ranked AS (
      SELECT id FROM deduped
      ORDER BY public.kai_job_score(visa_tier, lca_count_2025, salary_max_num, effective_posted_at, company_domain, NULL::date) DESC
      LIMIT $10
    )
    SELECT j.id, j.title, e.name, e.company_domain_url, j.location, j.url, j.posted_at,
      js.confidence_tier, js.visa_class, e.lca_count, j.ats_source, j.ats_job_id,
      j.salary_range, NULL::numeric AS salary_estimate, e.lca_count_2025,
      (SELECT max(lf.received_date) FROM lca_filings lf WHERE lf.employer_id = j.employer_id) AS lca_last_filed,
      e.poc_first_name, e.poc_last_name, e.poc_email,
      COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at,
      j.department, j.job_level, j.salary_min_num, j.salary_max_num, j.salary_period, j.is_remote
    FROM ranked r
    JOIN jobs j ON j.id = r.id
    JOIN employers e ON e.id = j.employer_id
    LEFT JOIN job_signals js ON js.job_id = j.id
    ORDER BY public.kai_job_score(
               js.confidence_tier, e.lca_count_2025, j.salary_max_num,
               COALESCE(j.posted_at, j.scraped_at), e.company_domain_url,
               (SELECT max(lf.received_date) FROM lca_filings lf WHERE lf.employer_id = j.employer_id)
             ) DESC
  $q$
  USING p_cutoff, p_location, p_location_tokens, p_query, p_title_keywords, p_company_keywords,
        p_visa_tiers, p_visa_class, p_salary_min, p_result_limit, p_departments, p_level, p_remote;
END;
$function$;

-- Drop the stale 12-arg overload (p_department singular) — unused, removes call ambiguity.
DROP FUNCTION IF EXISTS public.search_jobs_kai(
  timestamp with time zone, text, text, text[], text[], text[], text, numeric, integer, text, text, boolean);

-- 3. enrich_priority = the sponsor-stable part of the same score (salary/freshness/domain/
--    last-filed nulled), kept in sync by a set-based statement trigger on job_signals.
CREATE OR REPLACE FUNCTION public.sync_enrich_priority_from_signals() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.jobs j
  SET enrich_priority = public.kai_job_score(ns.confidence_tier, e.lca_count_2025, NULL, NULL, NULL, NULL)
  FROM changed ns
  JOIN public.jobs src ON src.id = ns.job_id
  JOIN public.employers e ON e.id = src.employer_id
  WHERE j.id = ns.job_id
    AND j.enrich_priority IS DISTINCT FROM
        public.kai_job_score(ns.confidence_tier, e.lca_count_2025, NULL, NULL, NULL, NULL);
  RETURN NULL;
END $$;

-- Two triggers: Postgres disallows transition tables on a single multi-event trigger.
DROP TRIGGER IF EXISTS trg_sync_enrich_priority_ins ON public.job_signals;
DROP TRIGGER IF EXISTS trg_sync_enrich_priority_upd ON public.job_signals;
CREATE TRIGGER trg_sync_enrich_priority_ins
  AFTER INSERT ON public.job_signals
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION public.sync_enrich_priority_from_signals();
CREATE TRIGGER trg_sync_enrich_priority_upd
  AFTER UPDATE ON public.job_signals
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION public.sync_enrich_priority_from_signals();

-- 4. Retire the LCA-only jobs trigger — job_signals is now the single owner of enrich_priority.
DROP TRIGGER IF EXISTS trg_set_job_enrich_priority ON public.jobs;
DROP FUNCTION IF EXISTS public.set_job_enrich_priority();

-- 5. Backfill existing rows. RUN IN BATCHES on the live table (WHERE id % 16 = k, and on a
--    busy DB scope to is_active + empty description — the queue-relevant rows) to stay under
--    the statement timeout; the rest are corrected by the trigger on the next 05_rescore.
UPDATE public.jobs j
SET enrich_priority = public.kai_job_score(js.confidence_tier, e.lca_count_2025, NULL, NULL, NULL, NULL)
FROM public.employers e, public.job_signals js
WHERE e.id = j.employer_id AND js.job_id = j.id
  AND j.enrich_priority IS DISTINCT FROM
      public.kai_job_score(js.confidence_tier, e.lca_count_2025, NULL, NULL, NULL, NULL);
