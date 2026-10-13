-- Phase 10: website and customer platform. Everything here is ADDITIVE (new columns have defaults, new tables); the desktop app's endpoints and data are untouched.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_beta_tester BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which price (and so which billing interval) a subscription is on, written by the webhook handler from the provider's subscription object.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_interval TEXT;

-- Browser sessions for the website. Only a hash of the session secret is stored; the CSRF token belongs to the session.
CREATE TABLE IF NOT EXISTS web_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);

-- One-time tokens sent by email (verify the address, reset the password, confirm a new address). Only the hash is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,            -- verify_email | reset_password | change_email
  token_hash TEXT NOT NULL UNIQUE,
  payload TEXT,                     -- change_email: the new address
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);

-- Every email the system wants to send. Delivery (if SMTP is configured) updates the row; without SMTP the row is the record ("captured").
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGSERIAL PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | sent | failed | captured
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, created_at);

-- Application releases. A release is a draft, then approved by an administrator, then published; only published releases are visible or downloadable by the public.
CREATE TABLE IF NOT EXISTS releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('beta', 'stable')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'withdrawn')),
  platform TEXT NOT NULL DEFAULT 'win32-x64',
  notes TEXT NOT NULL DEFAULT '',
  known_issues TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  storage_key TEXT,
  sha256 TEXT,                         -- the hash of the stored file, computed by the server when the file was uploaded
  size_bytes BIGINT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  UNIQUE (version, channel, platform)
);

-- Privacy-conscious download analytics: one counter per release per day. No IP address, no user agent, no account.
CREATE TABLE IF NOT EXISTS download_counts (
  release_id UUID NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (release_id, day)
);

CREATE TABLE IF NOT EXISTS support_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  category TEXT NOT NULL,              -- install | scanner | billing | account | bug | other
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  diagnostics TEXT,                    -- an optional pasted support report (size-limited, scrubbed of secrets on the way in)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_requests(status, created_at);

-- What administrators did (who, what, to what). Append-only.
CREATE TABLE IF NOT EXISTS admin_audit (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at);
