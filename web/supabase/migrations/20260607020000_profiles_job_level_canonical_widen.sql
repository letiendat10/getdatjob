-- Step 1 of 2 (deploy-safe): widen enriched.profiles.job_level to ALSO accept the canonical
-- jobs.job_level vocabulary, while still allowing the legacy preference values.
--
-- Why two steps: prod runs the old web build (which writes the legacy vocabulary "Junior" /
-- "Lead" / "People Manager", and whose derivers can emit "Principal" / "Staff" / "Senior IC" /
-- "Manager/Lead") until the canonical-writing build deploys. This constraint is a pure SUPERSET
-- of the old one, so it breaks nothing now and lets the new build write canonical values once
-- live. The companion migration *_canonical_tighten.sql backfills legacy -> canonical and
-- narrows the constraint to canonical-only; run it AFTER the new build is confirmed deployed.
--
-- Reads stay correct throughout: lib/taxonomy.toCanonicalLevel() maps every legacy value to its
-- canonical equivalent.

alter table enriched.profiles drop constraint if exists profiles_job_level_check;

alter table enriched.profiles add constraint profiles_job_level_check
  check (
    job_level is null
    or job_level = any (array[
      -- canonical (matches jobs.job_level / classify.py)
      'Entry/Junior', 'Senior', 'Principal / Staff', 'Lead/Manager', 'Director', 'VP',
      -- legacy preference vocabulary + stray values older derivers emitted
      'Junior', 'Lead', 'Principal/Staff', 'People Manager', 'Senior IC', 'Manager/Lead',
      'Principal', 'Staff'
    ]::text[])
  );
