-- refresh_card_health scans the 7-day window with wide description_text reads and can
-- exceed the ~8s PostgREST role statement_timeout (it only completed via direct admin
-- connections). Give the function its own 60s budget so BOTH callers through PostgREST
-- succeed: the daily refresh-stats cron (anon client) and scrapers/10_qa_card_health.py
-- (service key, GitHub Action).
ALTER FUNCTION public.refresh_card_health(int) SET statement_timeout = '60s';
