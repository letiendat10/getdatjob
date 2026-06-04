-- Realtime enrichment: when 03_pull_jobs.py INSERTs a new list-only-ATS job with no
-- description, fire a LISTEN/NOTIFY event so the always-on enrich worker can fetch its
-- description/salary/posted_at within seconds instead of waiting for the hourly sweep.
--
-- AFTER INSERT only: 03 upserts, so re-seen existing jobs take the ON CONFLICT DO UPDATE
-- path (no INSERT trigger) — only genuinely new postings notify. NOTIFY is delivered on
-- COMMIT; with no listener connected it's simply discarded (safe), and the worker's
-- startup + periodic sweeps catch anything that lands while it is between restarts.

CREATE OR REPLACE FUNCTION public.notify_enrich_new() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active
     AND NEW.ats_source IN ('workday', 'smartrecruiters', 'icims')
     AND (NEW.description_text IS NULL OR NEW.description_text = '')
  THEN
    PERFORM pg_notify('enrich_new', json_build_object(
      'id',          NEW.id,
      'ats_source',  NEW.ats_source,
      'ats_job_id',  NEW.ats_job_id,
      'employer_id', NEW.employer_id
    )::text);
  END IF;
  RETURN NULL;  -- AFTER trigger: return value ignored
END $$;

DROP TRIGGER IF EXISTS trg_notify_enrich_new ON public.jobs;
CREATE TRIGGER trg_notify_enrich_new
  AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.notify_enrich_new();
