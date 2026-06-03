-- effective_posted_at = COALESCE(posted_at, scraped_at) is a computed expression in
-- jobs_kai_view / jobs_with_details. The listing query orders by (is_active DESC,
-- effective_posted_at DESC) and filters effective_posted_at >= cutoff, so a composite
-- expression index on exactly that ordering keeps /jobs + /me/job-matches fast
-- (full scan + external sort was ~3.5s; this brings it to ~0.4s).
-- NULLS LAST matches the query's ORDER BY exactly so the planner uses the index for
-- ordering (no external sort) and terminates at LIMIT — ~3.5s full scan → ~15ms.
CREATE INDEX IF NOT EXISTS idx_jobs_active_effective
  ON public.jobs (is_active DESC, (COALESCE(posted_at, scraped_at)) DESC NULLS LAST);
