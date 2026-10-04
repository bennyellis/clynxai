-- Fix 3 — server-side monotonic sync cursor. `?since=` on the pull routes
-- (GET /watches, GET /feedback, GET /products) used to filter/order by
-- updated_at, a timestamp set by whichever device made the edit. A late or
-- offline push from a different device (with an older client clock, or one
-- that simply pushed after other devices had already pulled) could be
-- silently missed by other devices' pulls forever, since it would sort
-- "before" a cursor another device had already advanced past.
--
-- BIGSERIAL gives each of the three per-user-synced tables a column that
-- only ever increases, assigned by Postgres itself (via a dedicated
-- sequence) independent of any client clock. Existing rows are
-- auto-backfilled with sequential values by ADD COLUMN ... BIGSERIAL.
-- INSERTs get their revision for free from the column default; UPDATEs do
-- NOT auto-bump it (BIGSERIAL is just an integer column with a DEFAULT
-- nextval(...), not a trigger) — every UPDATE in watches/feedback/products
-- routes.ts explicitly sets
-- `revision = nextval(pg_get_serial_sequence('<table>', 'revision'))`
-- in its SET clause; see those files.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS revision BIGSERIAL;
ALTER TABLE listing_feedback ADD COLUMN IF NOT EXISTS revision BIGSERIAL;
ALTER TABLE user_products ADD COLUMN IF NOT EXISTS revision BIGSERIAL;

CREATE INDEX IF NOT EXISTS idx_watches_user_revision ON watches(user_id, revision);
CREATE INDEX IF NOT EXISTS idx_listing_feedback_user_revision ON listing_feedback(user_id, revision);
CREATE INDEX IF NOT EXISTS idx_user_products_user_revision ON user_products(user_id, revision);

-- Fix 4 — the 8 desktop-local-only operational/scheduler fields on watches
-- (next_check_at, last_checked_at, last_active_check_at,
-- listings_seen_count, match_count, resolved_location_url,
-- resolved_location_label, resolved_location_checked_at) stop being
-- treated as synced content as of this migration. Decision: LEAVE the
-- existing columns in place on the `watches` table rather than dropping
-- them — migration 002_watches.sql already created them, dropping columns
-- is a destructive/irreversible schema change, and there is no benefit to
-- forcing that here when the simpler, fully-reversible fix is for the
-- application layer (cloud/src/watches/routes.ts) to simply stop
-- reading them from the request body and stop writing them into the JSON
-- response. The columns become inert/unused going forward; a later
-- cleanup migration can drop them once batch 2 (desktop) has shipped and
-- nothing depends on their historical values anymore.
