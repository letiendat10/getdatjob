-- Add "Principal / Staff" to the job_level check constraint and backfill existing jobs.
-- Previously the constraint only allowed 5 levels; this adds the 6th IC track bucket.

ALTER TABLE public.jobs
  DROP CONSTRAINT jobs_job_level_chk;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_job_level_chk CHECK (
    job_level IS NULL OR job_level = ANY (ARRAY[
      'Entry/Junior', 'Senior', 'Principal / Staff',
      'Lead/Manager', 'Director', 'VP'
    ])
  );

-- Backfill: promote Senior jobs with principal-track title keywords
UPDATE public.jobs
SET job_level = 'Principal / Staff'
WHERE job_level = 'Senior'
  AND is_active = true
  AND (
    lower(title) LIKE '%principal%'
    OR lower(title) LIKE '%staff%'
    OR lower(title) LIKE '%distinguished%'
    OR lower(title) LIKE '%fellow%'
  )
  AND lower(title) NOT LIKE '%manager%'
  AND lower(title) NOT LIKE '%mgr%'
  AND lower(title) NOT LIKE '%supervisor%'
  AND lower(title) NOT LIKE '%director%'
  AND lower(title) NOT LIKE '%head of%'
  AND lower(title) NOT SIMILAR TO '%(team|tech|technical|engineering|eng|group|squad|project|delivery|program|product|design|data|qa|it|dev) lead%';
