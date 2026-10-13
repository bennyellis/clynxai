-- Phase 5/6: subscriptions (written ONLY by the billing webhook handler), idempotent billing-event log, AI usage metering, and case-insensitive unique emails.

-- One subscription row per user. The plan a user actually gets is computed from this row (see src/billing/plan.ts), never stored here, so a lapsed grace period
-- or an expired period needs no background job to take effect.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'pro',
  status TEXT NOT NULL,                       -- trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired | paused
  current_period_end TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  past_due_since TIMESTAMPTZ,
  last_event_created BIGINT NOT NULL DEFAULT 0, -- provider event time (seconds): an older event never overwrites a newer state
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(provider_customer_id) WHERE provider_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_subscription ON subscriptions(provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

-- Every webhook event the provider sends, keyed by the provider's event id: the primary key IS the idempotency guarantee (a redelivery inserts nothing and is not processed twice).
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider_created BIGINT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  outcome TEXT,                                -- applied | ignored-stale | ignored-unknown-user | ignored-type | error
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_events_received ON billing_events(received_at);

-- AI proxy metering: one row per request, for daily quotas, abuse detection and cost reporting. No prompt or response content is stored.
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- chat | image
  model TEXT,
  status INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage(user_id, created_at);

-- Emails are compared case-insensitively. Created only when no two existing accounts collide after lower-casing (a collision needs a person to resolve, not a migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
  END IF;
END $$;
