-- Clynx Cloud Phase 3 — Listing ingestion + global dedup.
--
-- Unlike watches/devices, this table is NOT per-user-owned — it's a shared
-- canonical cache (see the architecture doc's "product intelligence cache
-- is not the same as user's personal Database" distinction). Any
-- authenticated user/device can ingest into it; dedup is keyed purely on
-- (source, source_listing_id), the same stable per-listing identity the
-- desktop scanner already derives (the numeric Facebook item id embedded in
-- a listing's own /marketplace/item/<id>/ URL — see src/main/scraper.ts's
-- readListingAnchors, which is also literally what src/main/store.ts uses
-- as the local `listings.id` primary key).
--
-- Cloud-side processing in this phase is deliberately dumb/fast: validate,
-- normalize identity, dedupe, store. No AI calls, no job queue (that's
-- Phase 4) — see cloud/src/listings/routes.ts.

CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity used for dedup — mirrors src/main/types.ts's ListingRecord
  -- shape: `source` is a fixed string per scraper ("facebook_marketplace"
  -- today; more sources are a future concern), `source_listing_id` is that
  -- source's own stable per-listing id (the local SQLite `listings.id`
  -- value verbatim for Facebook).
  source TEXT NOT NULL,
  source_listing_id TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,
  -- Whole US dollars, matching the local SQLite side's `price INTEGER`
  -- column (src/main/store.ts) — no cents precision exists anywhere
  -- upstream of this, so there's nothing to gain by storing price_cents.
  price DOUBLE PRECISION,
  currency TEXT NOT NULL DEFAULT 'USD',
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  -- Every photo found on the listing page (ListingRecord.imageUrls).
  images JSONB NOT NULL DEFAULT '[]',
  location_text TEXT,
  listing_age TEXT,

  -- Seller signals (ListingRecord's flattened SellerSignals fields) —
  -- best-effort, all nullable exactly like the local shape.
  seller_name TEXT,
  seller_joined_year INTEGER,
  seller_rating DOUBLE PRECISION,
  seller_rating_count INTEGER,
  seller_has_profile_photo BOOLEAN,

  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(source, source_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_source_listing_id ON listings(source_listing_id);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen_at ON listings(last_seen_at);
