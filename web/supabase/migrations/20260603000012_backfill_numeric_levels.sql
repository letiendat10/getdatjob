-- Backfill numeric IC levels for existing jobs now that classify.py handles them.
-- Mapping: num 1-3 → Entry/Junior, 4-5 → Senior, 6+ → Principal / Staff

-- Level 1-3 / L1-L3 / E1-E3 → Entry/Junior
UPDATE public.jobs SET job_level = 'Entry/Junior'
WHERE job_level IS NULL AND is_active
  AND (
    lower(title) SIMILAR TO '%\mlevel [123]\M%'
    OR lower(title) SIMILAR TO '%\ml[123]\M%'
    OR lower(title) SIMILAR TO '%\me[123]\M%'
    OR lower(title) SIMILAR TO '%\mic[123]\M%'
  );

-- Level 4-5 / L4-L5 / E4-E5 + trailing digit 4-5 → Senior
UPDATE public.jobs SET job_level = 'Senior'
WHERE job_level IS NULL AND is_active
  AND (
    lower(title) SIMILAR TO '%\mlevel [45]\M%'
    OR lower(title) SIMILAR TO '%\ml[45]\M%'
    OR lower(title) SIMILAR TO '%\me[45]\M%'
    OR lower(title) SIMILAR TO '%\mic[45]\M%'
    OR lower(title) SIMILAR TO '%\mswe[45]\M%'
    OR title ~ '\m[45]\M$'
  );

-- Level 6+ / L6+ / E6+ → Principal / Staff
UPDATE public.jobs SET job_level = 'Principal / Staff'
WHERE job_level IS NULL AND is_active
  AND (
    lower(title) SIMILAR TO '%\mlevel [6-9]\M%'
    OR lower(title) SIMILAR TO '%\ml[6-9]\M%'
    OR lower(title) SIMILAR TO '%\me[6-9]\M%'
    OR lower(title) SIMILAR TO '%\mic[6-9]\M%'
    OR lower(title) SIMILAR TO '%\mswe[6-9]\M%'
    OR title ~ '\m[6-9]\M$'
  )
  AND lower(title) NOT LIKE '%manager%'
  AND lower(title) NOT LIKE '%director%';
