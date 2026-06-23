-- location_facets(): returns raw (location, is_remote, job_count) groups for
-- active jobs, sorted by count desc. The /api/location-facets route applies
-- normalizeCityState() in TypeScript to collapse format variants and groups
-- by normalized value to produce the location filter dropdown.
CREATE OR REPLACE FUNCTION location_facets(p_limit int DEFAULT 1000)
RETURNS TABLE(location text, is_remote boolean, job_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    location,
    COALESCE(is_remote, false)::boolean,
    COUNT(*)::bigint
  FROM jobs
  WHERE is_active = true
  GROUP BY location, COALESCE(is_remote, false)
  ORDER BY COUNT(*) DESC
  LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION location_facets(int) TO anon;
