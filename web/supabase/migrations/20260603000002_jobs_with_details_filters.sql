-- Expose the new freshness/classification/salary columns on jobs_with_details too,
-- so /jobs and /me/job-matches (which read this view) can show dept/level chips,
-- honest posted dates (effective_posted_at), and filter on real salary bounds.
CREATE OR REPLACE VIEW public.jobs_with_details AS
  SELECT j.id,
    j.title,
    j.location,
    j.url,
    j.posted_at,
    j.ats_source,
    j.ats_job_id,
    ea.slug AS ats_slug,
    e.name AS company,
    e.company_domain_url,
    e.lca_count_2025,
    e.visa_types,
    e.e3_lca_count,
    e.tn_lca_count,
    e.last_filing_date,
    js.confidence_tier,
    j.is_active,
    j.salary_range,
    j.tn_eligible,
    e.poc_first_name,
    e.poc_last_name,
    e.poc_email,
    COALESCE(j.posted_at, j.scraped_at) AS effective_posted_at,
    j.department,
    j.job_level,
    j.salary_min_num,
    j.salary_max_num,
    j.is_remote
   FROM jobs j
     JOIN employers e ON e.id = j.employer_id
     LEFT JOIN employer_ats ea ON ea.employer_id = j.employer_id AND ea.ats_type = j.ats_source
     LEFT JOIN job_signals js ON js.job_id = j.id
  WHERE js.confidence_tier IS NULL OR js.confidence_tier <> 'excluded'::text;
