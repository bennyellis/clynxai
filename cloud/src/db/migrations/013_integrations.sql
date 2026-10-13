-- Phase 10: company-managed API integrations (OpenAI, eBay) and the cost controls around them.

-- The stored credentials. Only ENCRYPTED text is kept (AES-256-GCM, key from the server's environment); the masked identifier is the only part ever shown.
CREATE TABLE IF NOT EXISTS integration_credentials (
  provider TEXT PRIMARY KEY CHECK (provider IN ('openai', 'ebay')),
  ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  masked JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  last_verified_at TIMESTAMPTZ,
  last_verify_ok BOOLEAN,
  last_verify_error TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What was done to the credentials (never the credentials themselves).
CREATE TABLE IF NOT EXISTS integration_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,            -- set | rotate | revoke | verify
  by_user UUID REFERENCES users(id) ON DELETE SET NULL,
  ok BOOLEAN NOT NULL DEFAULT true,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The single row of spending and safety controls. id is fixed at 1.
CREATE TABLE IF NOT EXISTS api_controls (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paid_api_enabled BOOLEAN NOT NULL DEFAULT true,       -- the emergency switch: false stops every paid operation at once
  disabled_reason TEXT,
  disabled_at TIMESTAMPTZ,
  disabled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  global_daily_usd NUMERIC(10,2) NOT NULL DEFAULT 20,
  global_monthly_usd NUMERIC(10,2) NOT NULL DEFAULT 200,
  user_daily_usd_free NUMERIC(10,4) NOT NULL DEFAULT 0.25,
  user_daily_usd_pro NUMERIC(10,4) NOT NULL DEFAULT 3,
  owner_daily_usd NUMERIC(10,4) NOT NULL DEFAULT 25,    -- the Owner has no plan limits, but not unlimited spending either
  max_concurrent_user INTEGER NOT NULL DEFAULT 3,
  max_concurrent_global INTEGER NOT NULL DEFAULT 20,
  ebay_daily_calls_global INTEGER NOT NULL DEFAULT 4000,
  ebay_daily_calls_free INTEGER NOT NULL DEFAULT 100,
  ebay_daily_calls_pro INTEGER NOT NULL DEFAULT 1500,
  ebay_daily_calls_owner INTEGER NOT NULL DEFAULT 3000,
  abuse_requests_per_10min INTEGER NOT NULL DEFAULT 300,
  abuse_refusals_per_10min INTEGER NOT NULL DEFAULT 40,
  abuse_block_minutes INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO api_controls (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Cost attribution: every AI request records the customer and an ESTIMATED cost (from token counts and a price table; an estimate, not an invoice).
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cost_usd_est NUMERIC(12,6) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

CREATE TABLE IF NOT EXISTS ebay_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,         -- search | item | user_call | token
  status INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ebay_usage_day ON ebay_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_ebay_usage_user_day ON ebay_usage(user_id, created_at);

-- Abuse handling: a flag says why, a block says until when a customer's paid operations are refused.
CREATE TABLE IF NOT EXISTS api_abuse_flags (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at TIMESTAMPTZ,
  cleared_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_abuse_flags_open ON api_abuse_flags(created_at) WHERE cleared_at IS NULL;
CREATE TABLE IF NOT EXISTS api_user_blocks (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blocked_until TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual customers' eBay authorisation (the "authorization code" flow). Tokens are stored ENCRYPTED; the application credentials alone grant no access to anyone's eBay account.
CREATE TABLE IF NOT EXISTS ebay_user_tokens (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ebay_oauth_states (
  nonce TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
