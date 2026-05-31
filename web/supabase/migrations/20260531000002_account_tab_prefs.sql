-- Add posted_within_days user preference column
ALTER TABLE enriched.profiles
  ADD COLUMN IF NOT EXISTS posted_within_days int;

-- Clear old job_level values that won't satisfy the new constraint
UPDATE enriched.profiles
  SET job_level = NULL
  WHERE job_level NOT IN ('Junior', 'Lead', 'Senior', 'Principal/Staff', 'People Manager');

-- Update job_level check constraint to new 5-level options
ALTER TABLE enriched.profiles
  DROP CONSTRAINT IF EXISTS profiles_job_level_check;

ALTER TABLE enriched.profiles
  ADD CONSTRAINT profiles_job_level_check
    CHECK (job_level IN ('Junior', 'Lead', 'Senior', 'Principal/Staff', 'People Manager'));
