-- Human-in-the-loop daily review (title-keyed, propagating).
--
-- One review per raw job title governs every job that shares it. The reviewer eyeballs
-- the public-card fields plus the internal title_clean (the LCA-match key behind the
-- H-1B verified tag — never shown publicly). Decisions are keyed by the lowercased raw
-- title (same key space as classification_overrides.json) and propagate corpus-wide.

CREATE TABLE IF NOT EXISTS public.title_reviews (
  title_norm  text PRIMARY KEY,          -- lowercased raw jobs.title
  decision    text NOT NULL,             -- 'approved' | 'corrected'
  department  text,
  job_level   text,
  title_clean text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewer    text,
  notes       text
);
ALTER TABLE public.title_reviews ENABLE ROW LEVEL SECURITY;  -- service role only

-- ── Daily queue ───────────────────────────────────────────────────────────────
-- Verified + posted in the last p_hours (default 24h), one card per still-unreviewed
-- title, highest-LCA employers first. Fewer than p_limit on a quiet day → return what
-- exists (no window cascade). title_clean is returned for review but never displayed.
CREATE OR REPLACE FUNCTION public.next_review_batch(p_limit int DEFAULT 10, p_hours int DEFAULT 24)
RETURNS TABLE (
  id bigint, title text, company text, location text, url text,
  posted_at timestamptz, effective_posted_at timestamptz,
  department text, job_level text, title_clean text,
  salary_range text, company_domain text,
  e3_lca_count int, lca_count int, lca_count_2025 int, confidence_tier text
)
LANGUAGE sql STABLE
AS $$
  SELECT d.id, d.title, d.company, d.location, d.url, d.posted_at, d.effective_posted_at,
         d.department, d.job_level, d.title_clean, d.salary_range, d.company_domain,
         d.e3_lca_count, d.lca_count, d.lca_count_2025, d.confidence_tier
  FROM (
    SELECT DISTINCT ON (lower(j.title))
      j.id, j.title, e.name AS company, j.location, j.url,
      j.posted_at, COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at,
      j.department, j.job_level, js.title_clean,
      j.salary_range, e.company_domain_url AS company_domain,
      e.e3_lca_count, e.lca_count, e.lca_count_2025, js.confidence_tier
    FROM jobs j
    JOIN employers e ON e.id = j.employer_id
    JOIN job_signals js ON js.job_id = j.id
    WHERE j.is_active
      AND js.confidence_tier = 'verified'
      AND COALESCE(j.posted_at, j.scraped_at) >= now() - make_interval(hours => p_hours)
      AND lower(j.title) NOT IN (SELECT title_norm FROM title_reviews)
    ORDER BY lower(j.title), e.lca_count DESC NULLS LAST, COALESCE(j.posted_at, j.scraped_at) DESC
  ) d
  ORDER BY d.lca_count DESC NULLS LAST, d.effective_posted_at DESC
  LIMIT p_limit;
$$;

-- ── Apply a review ──────────────────────────────────────────────────────────────
-- Upserts the decision, propagates dept/level to every job with this raw title, and —
-- if title_clean was corrected — updates job_signals.title_clean AND re-scores
-- confidence_tier against the employer's certified LCA titles (mirrors score_job).
CREATE OR REPLACE FUNCTION public.apply_title_review(
  p_title_norm text, p_decision text,
  p_department text DEFAULT NULL, p_job_level text DEFAULT NULL,
  p_title_clean text DEFAULT NULL, p_reviewer text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_norm text := lower(p_title_norm);
BEGIN
  INSERT INTO title_reviews (title_norm, decision, department, job_level, title_clean, reviewer, notes, reviewed_at)
  VALUES (v_norm, p_decision, p_department, p_job_level, p_title_clean, p_reviewer, p_notes, now())
  ON CONFLICT (title_norm) DO UPDATE SET
    decision = excluded.decision, department = excluded.department, job_level = excluded.job_level,
    title_clean = excluded.title_clean, reviewer = excluded.reviewer, notes = excluded.notes,
    reviewed_at = now();

  -- Propagate dept/level (title-derived) to every job with this raw title.
  IF p_department IS NOT NULL OR p_job_level IS NOT NULL THEN
    UPDATE jobs SET
      department = COALESCE(p_department, department),
      job_level  = COALESCE(p_job_level, job_level)
    WHERE lower(title) = v_norm AND is_active;
  END IF;

  -- title_clean correction → fix the LCA-match key and re-score the verified signal.
  IF p_title_clean IS NOT NULL THEN
    UPDATE job_signals js SET
      title_clean = p_title_clean,
      confidence_tier = CASE
        WHEN js.no_sponsor_in_desc_flag = 'no_sponsor' THEN 'excluded'
        WHEN EXISTS (
          SELECT 1 FROM lca_filings lf
          WHERE lf.employer_id = j.employer_id
            AND lf.job_title_clean = p_title_clean
            AND lf.received_date >= (now() - interval '3 years')::date
        ) THEN 'verified'
        ELSE 'friendly'
      END
    FROM jobs j
    WHERE js.job_id = j.id AND lower(j.title) = v_norm AND j.is_active;
  END IF;
END;
$$;

-- apply_title_review mutates classifications — restrict to the service role (the
-- /admin/review server action must use the service-role client). next_review_batch is
-- read-only and may stay callable.
REVOKE EXECUTE ON FUNCTION public.apply_title_review(text, text, text, text, text, text, text) FROM public, anon, authenticated;
