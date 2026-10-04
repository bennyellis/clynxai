-- Clynx Cloud Phase 6 — personal Database/Library (ProductProfile) cloud
-- persistence/synchronization. Mirrors watches (002_watches.sql)'s
-- per-user-owned, local_id-keyed, last-write-wins shape exactly — a
-- product profile is PERSONAL state (each user's own Database/Library),
-- unlike Phase 3's shared `listings` cache.
--
-- Named `user_products` (not `products`) to keep this unambiguous from any
-- future separate "global product intelligence cache" concept, which is an
-- explicitly different, not-yet-built table — this is only ever a per-user
-- mirror of the local SQLite `products` table (src/main/store.ts).
--
-- Deliberately excludes image binary/local-file fields per Phase 6 scope:
-- image_url and family_logo_url are always locally-downloaded `data:` URIs
-- (see src/main/store.ts's own comments on ProductProfile.imageUrl/
-- familyLogoUrl), not plain remote URLs, so syncing them needs S3-compatible
-- object storage that isn't set up yet. product_images/group_thumbnails
-- (separate local tables) aren't mirrored here at all, for the same reason.

CREATE TABLE IF NOT EXISTS user_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The client's own local product id (src/main/types.ts ProductProfile.id,
  -- a randomUUID() string from store.ts's addProductStub/createManualProduct)
  -- — mirrors watches.local_id exactly, including the per-user uniqueness
  -- scoping reasoning in that migration's own comment.
  local_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  ai_summary TEXT,
  ai_summary_generated_at BIGINT,
  observed_notes TEXT,
  category TEXT NOT NULL DEFAULT 'Other',
  family TEXT,
  resale_price_usd DOUBLE PRECISION,
  resale_time_to_sell TEXT,
  lookout_notes TEXT,
  keep_thumbnail BOOLEAN NOT NULL DEFAULT FALSE,
  desired_price_usd DOUBLE PRECISION,
  hard_cap_at_desired_price BOOLEAN NOT NULL DEFAULT FALSE,
  prioritized BOOLEAN NOT NULL DEFAULT FALSE,
  ebay_avg_sold_price_usd DOUBLE PRECISION,
  ebay_avg_run_time_days DOUBLE PRECISION,
  ebay_avg_shipping_usd DOUBLE PRECISION,
  ebay_comps_sample_size INTEGER,
  ebay_comps_checked_at BIGINT,
  loading BOOLEAN NOT NULL DEFAULT FALSE,

  -- Epoch-millisecond timestamps, matching watches.created_at/updated_at —
  -- same reasoning: no unit conversion between the client's Date.now() and
  -- the last-write-wins comparison here.
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,

  UNIQUE(user_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_user_products_user_id ON user_products(user_id);
CREATE INDEX IF NOT EXISTS idx_user_products_local_id ON user_products(local_id);
