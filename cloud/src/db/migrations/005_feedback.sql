-- Clynx Cloud Phase 5 — Feed feedback cloud persistence/synchronization.
--
-- Unlike watches/devices (per-user owned by their own local_id) or listings
-- (a shared canonical cache), a user's good/bad verdict + note on a listing
-- is PERSONAL state, similar in spirit to Watches — but there is no local
-- feedback "id" to key an upsert on the way watches.local_id does; the
-- local SQLite `feedback` table (src/main/store.ts) is already keyed by
-- listing_id alone (PRIMARY KEY, one row per listing). This mirrors that
-- shape exactly: one feedback row per (user, listing), upserted by that
-- pair, last-write-wins by updated_at — see cloud/src/feedback/routes.ts.
--
-- listing_id here is the CLOUD canonical listings.id (uuid, migration
-- 003_listings.sql), not the local Facebook item id — the sync layer
-- (src/main/feedbackSync.ts) resolves local id -> cloud id via
-- GET /listings/lookup before ever calling PUT /feedback/:listingId.

CREATE TABLE IF NOT EXISTS listing_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,

  verdict TEXT NOT NULL,
  note TEXT,

  -- Epoch-millisecond timestamps, matching watches.created_at/updated_at —
  -- same reasoning: no unit conversion between the client's Date.now() and
  -- the last-write-wins comparison here.
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,

  UNIQUE(user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_feedback_user_id ON listing_feedback(user_id);
