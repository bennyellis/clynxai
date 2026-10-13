-- Phase 10: the permanent Owner role. Separate from "admin": an admin runs the website and has NO free plan; the Owner has every feature without a subscription.
--
-- Defence in depth, because this role must never be obtainable by accident or by a bug:
--   1. a CHECK constraint lists the only valid roles,
--   2. a unique index allows AT MOST ONE owner row,
--   3. a trigger refuses ANY change that creates, removes or deletes an owner unless the statement runs inside the server-side setup tool, which sets a transaction-local
--      switch (clynx.owner_change = 'on'). Nothing the web API does can set that switch, so even a bug that built a "role = owner" UPDATE would be refused by the database.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'owner'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users ((role)) WHERE role = 'owner';

CREATE OR REPLACE FUNCTION guard_owner_role() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' AND coalesce(current_setting('clynx.owner_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'the owner role can only be granted by the server-side setup tool';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.role IS DISTINCT FROM OLD.role AND (NEW.role = 'owner' OR OLD.role = 'owner') AND coalesce(current_setting('clynx.owner_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'the owner role can only be changed by the server-side setup tool';
    END IF;
    RETURN NEW;
  ELSE
    IF OLD.role = 'owner' AND coalesce(current_setting('clynx.owner_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'the owner account cannot be deleted from the website or the API';
    END IF;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_owner_role ON users;
CREATE TRIGGER trg_guard_owner_role BEFORE INSERT OR UPDATE OF role OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION guard_owner_role();

-- One-time setup codes. Only a hash is stored; a code works once, for one address, for a short time.
CREATE TABLE IF NOT EXISTS owner_setup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
