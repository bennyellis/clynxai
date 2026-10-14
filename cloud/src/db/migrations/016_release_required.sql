-- Owner-designated REQUIRED updates. A published release can be marked required with a deadline: desktop apps that are online install it by then (they wait for an idle moment
-- before the deadline and no longer wait after it). Nothing here is ever automatic: only the Owner sets or clears it, and withdrawing a release clears it.
ALTER TABLE releases ADD COLUMN IF NOT EXISTS required_at TIMESTAMPTZ;
ALTER TABLE releases ADD COLUMN IF NOT EXISTS required_deadline TIMESTAMPTZ;
