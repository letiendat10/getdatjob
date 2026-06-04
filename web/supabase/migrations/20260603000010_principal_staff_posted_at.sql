-- Bug fixes (2026-06-03):
--
-- 1. posted_at backfill for Workday jobs:
--    select_enrich_candidates only selected jobs with empty description_text, so
--    Workday jobs enriched before today's PR (which added posted_at enrichment) kept
--    posted_at = NULL forever. Fix: expand the candidate query to also pick up Workday
--    jobs with posted_at IS NULL, and reset enrich_attempted_at so they're eligible
--    immediately rather than waiting 7 days.
--
-- 2. Principal / Staff level bucket:
--    classify.py folded principal/staff/distinguished/fellow titles into "Senior".
--    They now get their own bucket. Backfill existing jobs in the DB.

-- ── 1a. Update select_enrich_candidates to include Workday posted_at backfill ──

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
    AND (
      (j.description_text IS NULL OR j.description_text = '')
      OR (j.ats_source = 'workday' AND j.posted_at IS NULL)
    )
    AND (j.enrich_attempted_at IS NULL OR j.enrich_attempted_at < now() - INTERVAL '7 days')
  ORDER BY j.enrich_attempted_at ASC NULLS FIRST, e.lca_count DESC NULLS LAST, j.id
  LIMIT p_limit;
$$;

-- ── 1b. Reset cooldown for Workday jobs that have description but no posted_at ──
-- They'll be re-fetched on the next 04_enrich_descriptions.py run and will get
-- posted_at set from Workday's startDate / postedOn fields.

UPDATE public.jobs
SET enrich_attempted_at = NULL
WHERE ats_source = 'workday'
  AND posted_at IS NULL
  AND is_active = true
  AND description_text IS NOT NULL
  AND description_text != '';

-- ── 2. Backfill Principal / Staff level ──────────────────────────────────────
-- Jobs previously classified as "Senior" where the title signals principal-track IC.
-- Lead/Manager regex (checked first in classify_level) ensures titles like
-- "Principal Manager" stay as Lead/Manager; we only touch what landed in Senior.

UPDATE public.jobs
SET job_level = 'Principal / Staff'
WHERE job_level = 'Senior'
  AND is_active = true
  AND (
    title ~* '\bprincipal\b'
    OR title ~* '\bstaff\b'
    OR title ~* '\bdistinguished\b'
    OR title ~* '\bfellow\b'
  )
  AND NOT title ~* '\b(manager|mgr|supervisor|director|head\s+of)\b'
  AND NOT title ~* '\b(team|tech|technical|engineering|eng|group|squad|project|delivery|program|product|design|data|qa|it|dev)\s+lead\b';
