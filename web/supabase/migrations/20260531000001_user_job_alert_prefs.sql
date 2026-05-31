-- Unified job alert preferences table.
-- Both paywall mode and venmo mode write here for consistency.
-- Replaces the scattered writes to profiles.email_alerts and enriched.profiles.email_alerts.

CREATE TABLE public.user_job_alert_prefs (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email_alerts boolean DEFAULT false,
  frequency    text CHECK (frequency IN ('daily', 'weekly')) DEFAULT 'daily',
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

ALTER TABLE public.user_job_alert_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own prefs"
  ON public.user_job_alert_prefs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
