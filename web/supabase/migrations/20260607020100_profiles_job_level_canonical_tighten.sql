-- Step 2 of 2: run AFTER the canonical-writing web build is live in production.
--
-- Converges every stored enriched.profiles.job_level to the canonical jobs.job_level
-- vocabulary, then narrows the constraint to canonical-only so the preference column and the
-- jobs column share ONE vocabulary. The legacy "People Manager" / "Manager/Lead" collapse into
-- "Lead/Manager" (lossy by design — the preference editor no longer distinguishes them).

update enriched.profiles
set job_level = case job_level
  when 'Junior'         then 'Entry/Junior'
  when 'Lead'           then 'Lead/Manager'
  when 'Manager/Lead'   then 'Lead/Manager'
  when 'People Manager' then 'Lead/Manager'
  when 'Principal/Staff' then 'Principal / Staff'
  when 'Principal'      then 'Principal / Staff'
  when 'Staff'          then 'Principal / Staff'
  when 'Senior IC'      then 'Senior'
  else job_level
end
where job_level is not null
  and job_level not in ('Entry/Junior', 'Senior', 'Principal / Staff', 'Lead/Manager', 'Director', 'VP');

alter table enriched.profiles drop constraint if exists profiles_job_level_check;

alter table enriched.profiles add constraint profiles_job_level_check
  check (
    job_level is null
    or job_level = any (array[
      'Entry/Junior', 'Senior', 'Principal / Staff', 'Lead/Manager', 'Director', 'VP'
    ]::text[])
  );
