-- Fresh / filterable / salaried jobs — schema + search overhaul.
--
-- Fixes (see plan):
--   1. Rename jobs.created_at -> scraped_at (it's first-seen, not "created").
--   2. Add real columns: department, job_level, salary_min_num/max_num/period, is_remote.
--   3. jobs_kai_view exposes effective_posted_at = COALESCE(posted_at, scraped_at) so the
--      101k Workday + 259 iCIMS rows with NULL posted_at stop being invisible to search.
--   4. search_jobs_kai gates/ranks on effective_posted_at, filters real department/job_level/
--      is_remote, and filters salary on the REAL parsed salary_max_num (keep-unknowns), never LCA.
--   5. Backfill employers.company_domain_url from the LCA POC email domain (authoritative) so
--      company logos resolve consistently across every surface.

-- ── 1. Column rename + new columns ───────────────────────────────────────────
ALTER TABLE public.jobs RENAME COLUMN created_at TO scraped_at;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS department     text,
  ADD COLUMN IF NOT EXISTS job_level      text,
  ADD COLUMN IF NOT EXISTS salary_min_num integer,
  ADD COLUMN IF NOT EXISTS salary_max_num integer,
  ADD COLUMN IF NOT EXISTS salary_period  text,     -- 'annual' | 'hourly'
  ADD COLUMN IF NOT EXISTS is_remote      boolean;

CREATE INDEX IF NOT EXISTS idx_jobs_department     ON public.jobs (department)     WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_jobs_job_level      ON public.jobs (job_level)      WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_jobs_salary_max_num ON public.jobs (salary_max_num) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_jobs_is_remote      ON public.jobs (is_remote)      WHERE is_active;

-- ── 2. Recreate the search view (drop dependent function first) ───────────────
DROP FUNCTION IF EXISTS public.search_jobs_kai(
  timestamptz, text, text, text[], text[], text[], text, numeric, int);

CREATE OR REPLACE VIEW public.jobs_kai_view AS
  SELECT j.id,
         j.title,
         e.name              AS company,
         e.company_domain_url AS company_domain,
         j.location,
         j.url,
         j.posted_at,
         js.confidence_tier  AS visa_tier,
         js.visa_class,
         e.lca_count,
         j.ats_source,
         j.ats_job_id,
         j.salary_range,
         ( SELECT round(avg(lf.wage_offered))
             FROM lca_filings lf
            WHERE lf.employer_id = j.employer_id
              AND lf.received_date > (now() - '2 years'::interval) ) AS salary_estimate,
         e.lca_count_2025,
         ( SELECT max(lf.received_date)
             FROM lca_filings lf
            WHERE lf.employer_id = j.employer_id ) AS lca_last_filed,
         e.poc_first_name,
         e.poc_last_name,
         e.poc_email,
         -- new fields appended after existing columns
         COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at,
         j.department,
         j.job_level,
         j.salary_min_num,
         j.salary_max_num,
         j.salary_period,
         j.is_remote
    FROM jobs j
    JOIN employers e   ON e.id = j.employer_id
    LEFT JOIN job_signals js ON js.job_id = j.id
   WHERE j.is_active = true;

-- ── 3. Rebuild search_jobs_kai on effective_posted_at + real filter columns ───
CREATE OR REPLACE FUNCTION public.search_jobs_kai(
  p_cutoff           timestamptz DEFAULT now() - INTERVAL '7 days',
  p_location         text        DEFAULT NULL,
  p_query            text        DEFAULT NULL,
  p_title_keywords   text[]      DEFAULT NULL,
  p_company_keywords text[]      DEFAULT NULL,
  p_visa_tiers       text[]      DEFAULT NULL,
  p_visa_class       text        DEFAULT NULL,
  p_salary_min       numeric     DEFAULT NULL,
  p_result_limit     int         DEFAULT 10,
  p_department       text        DEFAULT NULL,
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
      AND (p_location   IS NULL OR jkv.location  ILIKE '%' || p_location  || '%')
      AND (p_visa_tiers IS NULL OR jkv.visa_tier = ANY(p_visa_tiers))
      AND (p_visa_class IS NULL OR jkv.visa_class ILIKE '%' || p_visa_class || '%')
      -- Min-salary: real parsed salary only, KEEP unknowns visible (never LCA).
      AND (p_salary_min IS NULL OR jkv.salary_max_num IS NULL OR jkv.salary_max_num >= p_salary_min)
      AND (p_department IS NULL OR jkv.department = p_department)
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

-- ── 4. Seed is_remote for existing rows (scraper keeps it fresh going forward) ─
UPDATE public.jobs
SET is_remote = (
      location ILIKE '%remote%'
   OR location ILIKE '%work from home%'
   OR location ILIKE '%anywhere%'
   OR title    ILIKE '%remote%'
)
WHERE is_remote IS NULL;

-- ── 5. Backfill employer domains from the LCA POC email (authoritative) ───────
-- Skip generic providers and known immigration-law-firm domains so a law-firm POC
-- never becomes the company domain; those rare cases fall back to the domain pipeline.
UPDATE public.employers
SET company_domain_url = lower(split_part(poc_email, '@', 2))
WHERE company_domain_url IS NULL
  AND poc_email ~ '^[^@]+@[^@]+\.[^@]+$'
  AND lower(split_part(poc_email, '@', 2)) NOT IN (
    'gmail.com','outlook.com','yahoo.com','hotmail.com','icloud.com','aol.com','protonmail.com',
    'me.com','live.com','msn.com',
    'fragomen.com','bal.com','ogletree.com','seyfarth.com','jacksonlewis.com','foley.com',
    'flwlaw.com','immigrationlaw.com','klaskolaw.com','maggio-kattar.com'
  );

-- Brand-correction: companies that file from an email domain different from their web/brand
-- domain (logo.dev + LOGO_OVERRIDES key on the brand domain).
UPDATE public.employers SET company_domain_url = 'sofi.com'
WHERE lower(company_domain_url) = 'sofi.org';
