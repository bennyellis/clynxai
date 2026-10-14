-- Invitations for a private beta. With REGISTRATION=invite nobody can create an account without a valid, unused, unexpired invitation code. Only a hash of the code is stored (the code
-- is shown once, to the person who creates it). An invitation may be tied to one email address.
CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  email TEXT,                                   -- lower-case; when set, only this address can use the code
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invites_created ON invites(created_at);
