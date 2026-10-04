-- Clynx Cloud Phase 2 — Watch cloud persistence/synchronization.
-- Mirrors the local SQLite `watches`/`watch_matches` schema (src/main/store.ts)
-- field-for-field. Local SQLite remains the sole source of truth for the
-- live scan loop; this is a background-synced mirror only.

CREATE TABLE IF NOT EXISTS watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The client's own local watch id (src/main/types.ts Watch.id, a
  -- randomUUID() string from store.ts's createWatch) — an external
  -- reference used for last-write-wins upserts, kept distinct from this
  -- row's own server-generated primary key. Unique per user (two different
  -- users could, in principle, coincidentally generate the same local id,
  -- though astronomically unlikely with UUIDs — scope the uniqueness to be
  -- safe).
  local_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,

  name TEXT NOT NULL,
  search_phrase TEXT NOT NULL,
  match_keywords JSONB NOT NULL DEFAULT '[]',
  linked_product_id TEXT,
  min_price_usd DOUBLE PRECISION,
  max_price_usd DOUBLE PRECISION,
  min_profit_usd DOUBLE PRECISION,
  min_discount_percent DOUBLE PRECISION,
  max_listing_age_minutes DOUBLE PRECISION,
  location_mode TEXT NOT NULL DEFAULT 'city',
  selected_state TEXT,
  selected_city_or_zip TEXT,
  search_radius_miles DOUBLE PRECISION,
  resolved_location_url TEXT,
  resolved_location_label TEXT,
  resolved_location_checked_at BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  listings_seen_count INTEGER NOT NULL DEFAULT 0,
  match_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at BIGINT,
  last_active_check_at BIGINT,
  next_check_at BIGINT,

  -- Epoch-millisecond timestamps, matching the local SQLite side (which
  -- stores Date.now() integers) rather than TIMESTAMPTZ, so last-write-wins
  -- comparisons never need a unit conversion between client and server.
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,

  UNIQUE(user_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_watches_user_id ON watches(user_id);
CREATE INDEX IF NOT EXISTS idx_watches_local_id ON watches(local_id);

CREATE TABLE IF NOT EXISTS watch_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The client's own local match id (WatchMatch.id) — append-only, so
  -- unlike watches this only needs dedup, not a full upsert path.
  local_id TEXT NOT NULL,
  watch_id UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  listing_id TEXT NOT NULL,
  matched_at BIGINT NOT NULL,
  found_by_account_id TEXT,
  found_by_account_label TEXT,
  discovery_mode TEXT NOT NULL,
  price_at_match DOUBLE PRECISION,
  discount_percent_at_match DOUBLE PRECISION,
  profit_usd_at_match DOUBLE PRECISION,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  notified_at BIGINT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(watch_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_matches_watch_id ON watch_matches(watch_id);
CREATE INDEX IF NOT EXISTS idx_watch_matches_user_id ON watch_matches(user_id);
