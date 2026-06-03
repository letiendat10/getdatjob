-- Card guardrails: stop bad values from ever reaching a card.
--
-- Pre-verified (2026-06-03) that all existing rows are already canonical, so these
-- CHECK constraints validate cleanly. Vocabularies match scrapers/classify.py
-- (job_level, department) and score_job (confidence_tier).
--
-- DEFERRED: dropping the dead all-null job_signals.visa_class is intentionally NOT done
-- here — it cascades through jobs_kai_view, jobs_with_details AND search_jobs_kai (which
-- references visa_class for p_visa_class filtering), so it needs careful RPC/view surgery
-- + search regression testing. It's a harmless null column; track separately.

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_job_level_chk CHECK (
    job_level IS NULL OR job_level IN
    ('Entry/Junior','Senior','Lead/Manager','Director','VP')),
  ADD CONSTRAINT jobs_department_chk CHECK (
    department IS NULL OR department IN
    ('AI / ML','Data','Security','Design','Product','Finance','Legal','HR / People',
     'Customer Success','Marketing/Growth','Sales','Platform / DevOps','Facilities',
     'Operations','Engineering')),
  ADD CONSTRAINT jobs_salary_period_chk CHECK (
    salary_period IS NULL OR salary_period IN ('annual','hourly'));

ALTER TABLE public.job_signals
  ADD CONSTRAINT job_signals_confidence_tier_chk CHECK (
    confidence_tier IS NULL OR confidence_tier IN ('verified','friendly','excluded'));

-- Non-US leak: the scraper deemed these non-US (is_us=false); they must never reach a
-- card. Deactivate them. (The daily pull's location blocklist should also catch these;
-- the QA snapshot's non_us_leak invariant monitors for regressions.)
UPDATE public.jobs SET is_active = false WHERE is_us IS FALSE AND is_active;
