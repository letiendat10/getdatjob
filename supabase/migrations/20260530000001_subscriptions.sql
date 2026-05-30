-- Subscription schema for getdatjob paid tiers
-- Tracks Stripe subscription state separately from enriched.profiles

CREATE SCHEMA IF NOT EXISTS subs;

CREATE TABLE subs.subscriptions (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                   text,
  subscription_tier       text NOT NULL DEFAULT 'free',
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text,
  subscription_status     text,
  first_subscribed_at     timestamptz,
  current_tier_expires_at timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subs.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own subscription"
  ON subs.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can write (used by webhook handler with service key)
CREATE POLICY "Service role can manage subscriptions"
  ON subs.subscriptions FOR ALL
  USING (true)
  WITH CHECK (true);
