-- Give server-side (service_role) requests headroom so a COLD search_jobs_kai call can't
-- get killed mid-flight and surface as a false "nothing matched" in Kai onboarding.
--
-- service_role had no statement_timeout of its own, so it inherited authenticator's 8s.
-- The Kai onboarding RPC is ~1-3s warm but can take 10-20s on a cold cache (first access
-- to a given department/metro). 20s is a safety ceiling, not the expected latency; under
-- real traffic the working set stays warm. (The route also falls back to a broader window
-- if a stage is empty, so a rare very-cold broad query still returns results.)
ALTER ROLE service_role SET statement_timeout = '20s';
