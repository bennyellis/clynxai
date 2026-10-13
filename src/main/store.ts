import { DatabaseSync } from "node:sqlite";
import { colorsConflict, colorsIn, isColorWord, sameColors } from "./colors.js";
import { compMatchesSpecs, hasSingleModelLetter, modelLettersConflict } from "./compFilter.js";
import type { ProductSignals } from "./dealSummary.js";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { timedSync, recordEvent } from "./metrics.js";
import type { BlacklistedImage, BlacklistTerm, FeedbackExample, FeedbackVerdict, FlawFeedbackExample, GateFactsSnapshot, GateReasonRecord, ListingRecord, MyStoreReference, PhotoFlaw, ProductImage, ProductProfile, ScoredListing, SellerRiskResult, Watch, WatchMatch, WatchPlatform, WatchSearchLink, WatchTerm } from "./types.js";
import { brokenVariantName, isBrokenVariantName } from "./brokenVariant.js";
import { assessListingAge } from "./listingAge.js";
import { codesMissingFrom } from "./identity/codes.js";
import { assessCodes, CodeIndex, NO_CODES, type CodeAssessment, type EvidenceDoc } from "./identity/credibility.js";
import { IdentityFoundation } from "./identity/foundationStore.js";

// What a product is worth on eBay, as the total the BUYER pays (the sold item price plus the shipping they paid): the estimate when
// there is one, else the sold average with its average shipping. The user keeps ~84% of that total (eBay's cut is on all of it).
const EBAY_VALUE_SQL = "COALESCE(ebay_est_value_usd, ebay_avg_sold_price_usd + COALESCE(ebay_avg_shipping_usd, 0))";

// Batch 2 Fix D — what Store.upsertWatchFromCloud actually accepts: a Watch
// minus the 8 desktop-local-only operational/scheduler fields the cloud no
// longer carries (see that method's own doc comment, and cloudClient.ts's
// CloudWatch). watchSync.ts's cloudWatchToLocal is the one producer of this
// shape. platform/minSellerRatingPercent are optional because a cloud server
// that predates the Watch-platform feature doesn't carry them: absent means
// "leave the local value alone" on an existing row and "facebook / no rating
// requirement" on a brand-new one.
export type CloudSyncedWatch = Omit<
  Watch,
  | "listingsSeenCount"
  | "matchCount"
  | "lastCheckedAt"
  | "lastActiveCheckAt"
  | "nextCheckAt"
  | "resolvedLocationUrl"
  | "resolvedLocationLabel"
  | "resolvedLocationCheckedAt"
  | "resolvedLocationUrls"
  | "ntfyTopic"
  | "terms"
  | "checkIntervalMinutes"
  | "accountIds"
  | "searchLinks"
  | "platform"
  | "minSellerRatingPercent"
> & { platform?: WatchPlatform; minSellerRatingPercent?: number | null };

export class Store {
  private db: DatabaseSync;
  // The Database identity foundation (identity/foundationStore.ts): extra tables of candidate relations and evidence, created only when switched on in the
  // config. Null when off: no table exists and nothing reads or writes any.
  identity: IdentityFoundation | null = null;
  // Per explicit instruction — an in-memory accelerator in front of the
  // hasSeen() SQLite lookup below, benchmarked (not assumed) against the
  // plain DB-only path via metrics.ts's db_dedup_lookup/dedup_cache_check
  // stages. Deliberately POSITIVE-ONLY: an id is added here only once the
  // DB has confirmed it's genuinely already seen, and it's never removed or
  // treated as authoritative for a "not seen" answer. That asymmetry is
  // what keeps this safe to add without touching correctness — a stale
  // cache could only ever cause an unnecessary extra DB check (a false
  // miss), never a wrong "already seen" (there's no way for a real id to be
  // wrongly present), which matters here because MULTIPLE accounts share
  // this one Store and rely on the DB's hasSeen() as the actual source of
  // truth for "which account found this first" (see index.ts's
  // setListingFoundBy) — a cache that could go stale in the other direction
  // would risk two accounts both thinking they found the same listing
  // first.
  private seenCache = new Set<string>();
  private static readonly SEEN_CACHE_MAX = 20_000;

  constructor(dbPath: string, options: { identityFoundation?: boolean } = {}) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.initialize();
      if (options.identityFoundation === true) {
        this.identity = new IdentityFoundation(this.db);
        this.identity.init();
      }
    } catch (err) {
      // A database the app cannot set up must not stay open: on Windows an open file cannot be moved aside, and recovering from a
      // damaged database (dbIntegrity.ts) needs to move it.
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      throw err;
    }
  }

  // Creates the tables and runs the migrations (split out of the constructor so a failure can close the database, see above).
  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        price INTEGER,
        url TEXT NOT NULL,
        thumbnail_url TEXT,
        image_urls TEXT,
        matched_item TEXT,
        reference_price_usd INTEGER,
        discount_percent REAL,
        condition_impact TEXT,
        confidence TEXT,
        reasoning TEXT,
        extracted_attributes TEXT,
        shipping_mentioned INTEGER NOT NULL DEFAULT 0,
        is_deal INTEGER NOT NULL DEFAULT 0,
        deal_tier TEXT,
        estimated_value_range TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        seller_joined_year INTEGER,
        seller_rating REAL,
        seller_rating_count INTEGER,
        seller_has_profile_photo INTEGER,
        seller_risk_passed INTEGER NOT NULL DEFAULT 1,
        seller_risk_reasons TEXT,
        photo_analysis TEXT,
        photo_analysis_checked_at INTEGER,
        location_text TEXT,
        listing_age TEXT,
        seller_name TEXT,
        description TEXT
      );
      CREATE TABLE IF NOT EXISTS feedback (
        listing_id TEXT PRIMARY KEY REFERENCES listings(id),
        verdict TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );
      -- Condition-awareness — one confirm/deny per flagged photo, own id
      -- (not listing_id) as the PK since a single listing can have multiple
      -- flagged photos, unlike feedback above (one verdict per listing).
      -- listing_title is denormalized on purpose so
      -- getFlawFeedbackExamples never needs a join against listings.
      CREATE TABLE IF NOT EXISTS flaw_feedback (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL REFERENCES listings(id),
        photo_number INTEGER NOT NULL,
        description TEXT NOT NULL,
        confidence TEXT NOT NULL,
        confirmed INTEGER NOT NULL,
        listing_title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- Clynx Cloud Phase 5 — updated_at is added via the ALTER TABLE
      -- migration block below (existing installs already have this table
      -- without the column); a fresh CREATE TABLE here still only needs
      -- created_at, since the migration block runs unconditionally right
      -- after and backfills it for both cases identically.
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ai_summary TEXT,
        ai_summary_generated_at INTEGER,
        image_url TEXT,
        category TEXT NOT NULL DEFAULT 'Other',
        family TEXT,
        family_logo_url TEXT,
        loading INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        observed_notes TEXT,
        resale_price_usd REAL,
        resale_time_to_sell TEXT,
        lookout_notes TEXT,
        keep_thumbnail INTEGER NOT NULL DEFAULT 0,
        desired_price_usd REAL,
        hard_cap_at_desired_price INTEGER NOT NULL DEFAULT 0,
        prioritized INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS category_dismissals (
        category TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_dismissed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS product_images (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        image_data TEXT NOT NULL,
        source_title TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blacklist_terms (
        term TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blacklisted_images (
        id TEXT PRIMARY KEY,
        image_data TEXT NOT NULL,
        source_title TEXT,
        category TEXT,
        reason TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_thumbnails (
        path_key TEXT PRIMARY KEY,
        image_data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        search_phrase TEXT NOT NULL,
        match_keywords TEXT NOT NULL,
        linked_product_id TEXT REFERENCES products(id),
        min_price_usd INTEGER,
        max_price_usd INTEGER,
        min_profit_usd INTEGER,
        min_discount_percent REAL,
        max_listing_age_minutes INTEGER,
        location_mode TEXT NOT NULL DEFAULT 'city',
        selected_state TEXT,
        selected_city_or_zip TEXT,
        search_radius_miles INTEGER,
        resolved_location_url TEXT,
        resolved_location_label TEXT,
        resolved_location_checked_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        listings_seen_count INTEGER NOT NULL DEFAULT 0,
        match_count INTEGER NOT NULL DEFAULT 0,
        last_checked_at INTEGER,
        last_active_check_at INTEGER,
        next_check_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watch_matches (
        id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL REFERENCES watches(id),
        listing_id TEXT NOT NULL REFERENCES listings(id),
        matched_at INTEGER NOT NULL,
        found_by_account_id TEXT,
        found_by_account_label TEXT,
        discovery_mode TEXT NOT NULL,
        price_at_match INTEGER,
        discount_percent_at_match REAL,
        profit_usd_at_match INTEGER,
        notified INTEGER NOT NULL DEFAULT 0,
        notified_at INTEGER,
        UNIQUE(watch_id, listing_id)
      );
      CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(next_check_at);
      CREATE INDEX IF NOT EXISTS idx_watch_matches_watch ON watch_matches(watch_id);
      CREATE INDEX IF NOT EXISTS idx_watch_matches_listing ON watch_matches(listing_id);
      -- Batch 2 Fix B — a local record of a delete that happened here but
      -- hasn't been confirmed propagated to the cloud mirror yet. Without
      -- this, a delete was purely local: the next pull would simply see the
      -- cloud's still-there row and resurrect it locally. watchSync.ts/
      -- feedbackSync.ts/productSync.ts each drain their own resource_type's
      -- rows every tick (see their pushPendingDeletes) and also skip
      -- re-applying a pulled remote row whose id is still pending here, so a
      -- delete that hasn't flushed yet doesn't get resurrected by the very
      -- same tick's pull. See deleteWatch/clearFeedback/deleteProduct below
      -- for where rows get added; see Store.addPendingCloudDelete's own
      -- comment for the one remaining residual race this doesn't close.
      CREATE TABLE IF NOT EXISTS pending_cloud_deletes (
        resource_type TEXT NOT NULL,
        local_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (resource_type, local_id)
      );
    `);
    // Older DBs created before seller-risk columns existed.
    const cols = (this.db.prepare("PRAGMA table_info(listings)").all() as any[]).map((c) => c.name);
    const migrations: Array<[string, string]> = [
      ["seller_joined_year", "INTEGER"],
      ["seller_rating", "REAL"],
      ["seller_rating_count", "INTEGER"],
      ["ebay_seller_feedback_percent", "REAL"],
      ["ebay_shipping_usd", "REAL"],
      ["seller_has_profile_photo", "INTEGER"],
      ["seller_risk_passed", "INTEGER NOT NULL DEFAULT 1"],
      ["seller_risk_reasons", "TEXT"],
      ["deal_tier", "TEXT"],
      ["estimated_value_range", "TEXT"],
      ["thumbnail_url", "TEXT"],
      ["image_urls", "TEXT"],
      ["photo_analysis", "TEXT"],
      ["photo_analysis_checked_at", "INTEGER"],
      ["location_text", "TEXT"],
      ["listing_age", "TEXT"],
      // The Deal Quality Gate's persisted verdict (see types.ts DealStatus) and the parsed listing age.
      ["deal_status", "TEXT"],
      ["gate_confidence", "TEXT"],
      ["gate_stars", "REAL"],
      ["gate_headline", "TEXT"],
      ["gate_reasons", "TEXT"],
      ["required_discount_percent", "REAL"],
      ["target_price_usd", "REAL"],
      ["gate_facts", "TEXT"],
      ["listing_age_hours", "REAL"],
      ["seller_name", "TEXT"],
      ["description", "TEXT"],
      // Per explicit instruction — multi-account scanning: which account's
      // browser session found this listing (see types.ts's ListingRecord).
      ["found_by_account_id", "TEXT"],
      ["found_by_account_label", "TEXT"],
      // Per explicit instruction — "avg. Facebook Marketplace price...
      // only available after the ai has come across the same product
      // multiple times." Resolved and stamped in saveScored below
      // (fuzzy-matched from extraction.matchedItem, same findMatchingProduct
      // lookup used everywhere else in this app) so this column stays
      // correct across every re-save of a listing as its own evaluation
      // gets refined, with no extra plumbing needed at any of saveScored's
      // several call sites. Null whenever a listing was never confidently
      // identified as a specific tracked product. See getFacebookPriceStats
      // below for what actually reads this.
      ["product_id", "TEXT"],
      // Clynx Cloud Phase 3 — high-water mark for listingIngestSync.ts's
      // downstream mirror push (see cloudClient.ts's ingestListings). Null
      // means "never pushed yet." Set to the sync tick's own Date.now() the
      // moment a listing is successfully included in a push — not the
      // cloud's own response timestamp — so a listing that fails to push
      // (network hiccup, cloud down) simply stays null and gets retried on
      // the next tick, same retry posture as watchSync.ts's push().
      ["cloud_synced_at", "INTEGER"],
      // Batch 2 Fix E — counts consecutive cloud-rejected (validation
      // failure, not network error) ingest attempts for this listing, so a
      // permanently-malformed row doesn't retry forever every tick — see
      // recordListingCloudSyncFailures below and listingIngestSync.ts's own
      // use of it. 0 means "never rejected" (including "never attempted").
      ["cloud_sync_attempts", "INTEGER DEFAULT 0"],
      // eBay Browse API integration — which marketplace this listing came
      // from. SQLite backfills the DEFAULT onto every existing row the
      // moment this column is added, so every pre-existing row is correctly
      // 'facebook' with no explicit backfill query needed. See
      // getFacebookPriceStats below, the one place this is actually read.
      ["source", "TEXT NOT NULL DEFAULT 'facebook'"],
      // Condition-awareness — vision.ts's structured PhotoFlaw[] for this
      // listing, JSON-encoded (same convention as image_urls/
      // extracted_attributes above). Always '[]'-equivalent (NULL, read
      // back as []) unless Config.researchCondition was on when this
      // listing was last analyzed.
      ["photo_flaws", "TEXT"],
      // Facebook's "Just listed" badge on the search-results card.
      ["just_listed", "INTEGER"],
    ];
    for (const [name, ddl] of migrations) {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${ddl}`);
    }

    // Watch platform choice (Facebook or eBay). Every Watch that existed
    // before this column was a Facebook Marketplace Watch, so the DEFAULT
    // backfills them correctly with no explicit UPDATE needed.
    // min_seller_rating_percent only means anything on an eBay Watch; NULL
    // (no requirement) everywhere else.
    const watchCols = (this.db.prepare("PRAGMA table_info(watches)").all() as any[]).map((c) => c.name);
    if (!watchCols.includes("platform")) this.db.exec("ALTER TABLE watches ADD COLUMN platform TEXT NOT NULL DEFAULT 'facebook'");
    if (!watchCols.includes("min_seller_rating_percent")) this.db.exec("ALTER TABLE watches ADD COLUMN min_seller_rating_percent REAL");
    if (!watchCols.includes("ntfy_topic")) this.db.exec("ALTER TABLE watches ADD COLUMN ntfy_topic TEXT");
    // Facebook Watches search for several things at once ("terms", JSON), on a
    // chosen interval, with a chosen set of accounts (JSON list of account ids;
    // empty = any). A row without terms_json is a pre-existing single-phrase Watch.
    if (!watchCols.includes("terms_json")) this.db.exec("ALTER TABLE watches ADD COLUMN terms_json TEXT");
    if (!watchCols.includes("check_interval_minutes")) this.db.exec("ALTER TABLE watches ADD COLUMN check_interval_minutes INTEGER NOT NULL DEFAULT 15");
    if (!watchCols.includes("account_ids")) this.db.exec("ALTER TABLE watches ADD COLUMN account_ids TEXT");
    this.db.exec(`
      -- Every listing a Watch has already come across, so it is never looked at twice.
      CREATE TABLE IF NOT EXISTS watch_seen_listings (
        watch_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (watch_id, listing_id)
      );
      -- The exact Facebook search each Watch ran for each term at each place.
      CREATE TABLE IF NOT EXISTS watch_searches (
        watch_id TEXT NOT NULL,
        term TEXT NOT NULL,
        place_key TEXT NOT NULL,
        place_label TEXT NOT NULL,
        url TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (watch_id, term, place_key)
      );
      -- Where a place name or ZIP is (for the radius check). found = 0 means
      -- "looked it up and there was no such place", remembered so it isn't asked again.
      CREATE TABLE IF NOT EXISTS geocode_cache (
        query TEXT PRIMARY KEY,
        lat REAL,
        lon REAL,
        label TEXT,
        found INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
    // A state / whole-country Watch searches several places, so it caches a list
    // of Marketplace URLs (JSON array) rather than the single resolved_location_url.
    if (!watchCols.includes("resolved_location_urls")) this.db.exec("ALTER TABLE watches ADD COLUMN resolved_location_urls TEXT");

    // Clynx Cloud Phase 5 — feedbackSync.ts needs an updated_at to compare
    // for last-write-wins, same as watches.updated_at already does. Existing
    // installs only have created_at (set-once, since setFeedback's own
    // UPSERT never bumped it on an edit) — backfilled from created_at so an
    // existing feedback row still gets a sane, monotonic starting point
    // rather than 0/null forcing every remote pull to always "win" on first
    // sync.
    const feedbackCols = (this.db.prepare("PRAGMA table_info(feedback)").all() as any[]).map((c) => c.name);
    if (!feedbackCols.includes("updated_at")) {
      this.db.exec("ALTER TABLE feedback ADD COLUMN updated_at INTEGER");
      this.db.exec("UPDATE feedback SET updated_at = created_at WHERE updated_at IS NULL");
    }

    // Condition-awareness — distinguishes a normal clean reference photo
    // from a deliberately poor-condition/damaged one (see
    // webResearch.ts's findPoorConditionProductImage). Every existing row
    // backfills to 'normal' via the DEFAULT the moment this column exists.
    const productImageCols = (this.db.prepare("PRAGMA table_info(product_images)").all() as any[]).map((c) => c.name);
    if (!productImageCols.includes("kind")) {
      this.db.exec("ALTER TABLE product_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
    }

    // Counting a product's reference photos has to read its `kind` column, which sits behind each ~114 KB photo, so the plain grouped count
    // scanned every photo (about 350 ms for a library of ~4,000 photos). These two small columns together in an index answer it without
    // touching the photos.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_product_images_kind ON product_images(product_id, kind)");
    const productCols = (this.db.prepare("PRAGMA table_info(products)").all() as any[]).map((c) => c.name);
    if (!productCols.includes("observed_notes")) {
      this.db.exec("ALTER TABLE products ADD COLUMN observed_notes TEXT");
    }
    if (!productCols.includes("image_url")) {
      this.db.exec("ALTER TABLE products ADD COLUMN image_url TEXT");
    }
    if (!productCols.includes("category")) {
      this.db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'");
    }
    if (!productCols.includes("resale_price_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN resale_price_usd REAL");
    }
    if (!productCols.includes("resale_time_to_sell")) {
      this.db.exec("ALTER TABLE products ADD COLUMN resale_time_to_sell TEXT");
    }
    if (!productCols.includes("lookout_notes")) {
      this.db.exec("ALTER TABLE products ADD COLUMN lookout_notes TEXT");
    }
    if (!productCols.includes("keep_thumbnail")) {
      this.db.exec("ALTER TABLE products ADD COLUMN keep_thumbnail INTEGER NOT NULL DEFAULT 0");
    }
    if (!productCols.includes("family")) {
      this.db.exec("ALTER TABLE products ADD COLUMN family TEXT");
    }
    if (!productCols.includes("family_logo_url")) {
      this.db.exec("ALTER TABLE products ADD COLUMN family_logo_url TEXT");
    }
    if (!productCols.includes("desired_price_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN desired_price_usd REAL");
    }
    if (!productCols.includes("hard_cap_at_desired_price")) {
      this.db.exec("ALTER TABLE products ADD COLUMN hard_cap_at_desired_price INTEGER NOT NULL DEFAULT 0");
    }
    if (!productCols.includes("prioritized")) {
      this.db.exec("ALTER TABLE products ADD COLUMN prioritized INTEGER NOT NULL DEFAULT 0");
    }
    if (!productCols.includes("ebay_avg_sold_price_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_avg_sold_price_usd REAL");
    }
    if (!productCols.includes("ebay_avg_run_time_days")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_avg_run_time_days REAL");
    }
    if (!productCols.includes("ebay_comps_sample_size")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_comps_sample_size INTEGER");
    }
    if (!productCols.includes("ebay_comps_checked_at")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_comps_checked_at INTEGER");
    }
    if (!productCols.includes("ebay_avg_shipping_usd")) {
      this.db.exec("ALTER TABLE products ADD COLUMN ebay_avg_shipping_usd REAL");
    }
    for (const [column, type] of [
      ["ebay_active_median_usd", "REAL"],
      ["ebay_active_sample_size", "INTEGER"],
      ["ebay_est_value_usd", "REAL"],
      ["ebay_est_basis", "TEXT"],
      ["ebay_comps_identity", "TEXT"],
      ["parent_product_id", "TEXT"],
      ["my_store_ref", "TEXT"],
    ]) {
      if (!productCols.includes(column)) this.db.exec(`ALTER TABLE products ADD COLUMN ${column} ${type}`);
    }
    // A covering index for name lookups. A product row carries its photo (~90 KB of text) in the middle of the row, and SQLite has
    // to read past that photo to reach any column stored after it (created_at, family, the eBay prices), so even a query for just
    // names sorted by date read every photo. These columns, all together in a small index, are answered without touching the rows
    // (see listProductIndex and enrichManyWithMatchedProductPricing).
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(created_at DESC, name, id, family, ebay_est_value_usd, ebay_avg_sold_price_usd, ebay_avg_shipping_usd, ebay_avg_run_time_days)"
    );
    // One-time: eBay prices researched before "Series S" and "Series X" could be told apart for the products whose names have such
    // a letter (an Xbox Series S entry was averaging Series X sales, ~$500 instead of ~$280) are cleared, to be researched again
    // (the Database page offers "Research now").
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_flags (name TEXT PRIMARY KEY)");
    const lettersFlag = "comps-model-letters-2026-10-06";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(lettersFlag)) {
      const checked = this.db.prepare("SELECT id, name FROM products WHERE ebay_comps_checked_at IS NOT NULL").all() as Array<{ id: string; name: string }>;
      for (const r of checked) {
        if (!hasSingleModelLetter(r.name)) continue;
        this.db
          .prepare(
            `UPDATE products SET ebay_avg_sold_price_usd = NULL, ebay_avg_run_time_days = NULL, ebay_avg_shipping_usd = NULL, ebay_comps_sample_size = NULL,
               ebay_comps_checked_at = NULL, ebay_active_median_usd = NULL, ebay_active_sample_size = NULL, ebay_est_value_usd = NULL, ebay_est_basis = NULL WHERE id = ?`
          )
          .run(r.id);
      }
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(lettersFlag);
    }
    // One-time: eBay values that can't be right are cleared (to be researched again, which is now smarter: console products count
    // only listings filed under a console category). Two kinds: (1) sold prices and asking prices that disagree wildly (a "Ps5" entry
    // blended one $385 sale with 27 asking prices of games and accessories into $128); with a couple of sales the sold figure
    // is kept instead; (2) a console priced under 40% of its brand's other consoles ("xbox", worth $20, sat next to Series S at $300).
    const conflictFlag = "comps-conflict-2026-10-07";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(conflictFlag)) {
      const clearComps = (id: string) =>
        this.db
          .prepare(
            `UPDATE products SET ebay_avg_sold_price_usd = NULL, ebay_avg_run_time_days = NULL, ebay_avg_shipping_usd = NULL, ebay_comps_sample_size = NULL,
               ebay_comps_checked_at = NULL, ebay_active_median_usd = NULL, ebay_active_sample_size = NULL, ebay_est_value_usd = NULL, ebay_est_basis = NULL WHERE id = ?`
          )
          .run(id);
      const researched = this.db
        .prepare(
          "SELECT id, ebay_avg_sold_price_usd AS sold, ebay_comps_sample_size AS sn, ebay_active_median_usd AS act, ebay_active_sample_size AS an FROM products WHERE ebay_comps_checked_at IS NOT NULL"
        )
        .all() as Array<{ id: string; sold: number | null; sn: number | null; act: number | null; an: number | null }>;
      for (const r of researched) {
        if (!(r.sold && r.sold > 0) || !(r.act && r.act > 0) || (r.an ?? 0) < 3) continue;
        const ratio = (r.act * 0.92) / r.sold;
        if (ratio >= 0.6 && ratio <= 1.6) continue;
        if ((r.sn ?? 0) >= 2) this.db.prepare("UPDATE products SET ebay_est_value_usd = ?, ebay_est_basis = 'sold' WHERE id = ?").run(r.sold, r.id);
        else clearComps(r.id);
      }
      const consoles = this.db
        .prepare(`SELECT id, name, family, ${EBAY_VALUE_SQL} AS v FROM products WHERE ebay_comps_checked_at IS NOT NULL AND family IS NOT NULL`)
        .all() as Array<{ id: string; name: string; family: string; v: number | null }>;
      const byBrand = new Map<string, Array<{ id: string; v: number; generic: boolean }>>();
      for (const c of consoles) {
        if (!/>\s*consoles?\s*$/i.test(c.family) || !(c.v && c.v > 0)) continue;
        const brand = c.family.split(">")[0].trim().toLowerCase();
        // Only generic one- or two-word names ("xbox", "Ps5") can be this kind of junk: an older console like "Xbox 360 S" is
        // legitimately cheap.
        byBrand.set(brand, [...(byBrand.get(brand) ?? []), { id: c.id, v: c.v, generic: c.name.trim().split(/\s+/).length <= 2 }]);
      }
      for (const group of byBrand.values()) {
        if (group.length < 3) continue;
        const sorted = group.map((g) => g.v).sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length / 2)];
        for (const g of group) if (g.generic && g.v < middle * 0.4) clearComps(g.id);
      }
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(conflictFlag);
    }
    // One-time: values used to be the sold ITEM price only; they are now what the buyer pays in total (item + shipping), since eBay's cut
    // and the user's take-home percentage apply to all of it. Existing estimates get their average shipping added once.
    const shippingFlag = "comps-shipping-2026-10-07";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(shippingFlag)) {
      this.db.exec(
        "UPDATE products SET ebay_est_value_usd = ebay_est_value_usd + ebay_avg_shipping_usd WHERE ebay_est_value_usd IS NOT NULL AND ebay_avg_shipping_usd > 0 AND ebay_comps_checked_at IS NOT NULL"
      );
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(shippingFlag);
    }
    // One-time: a state Watch looks in the state's 10 biggest cities (stateCities.ts). Ones that already resolved their places got
    // whatever cities the AI had named, so those are cleared and resolved again at their next check.
    const stateCitiesFlag = "state-top-cities-2026-10-07";
    if (!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = ?").get(stateCitiesFlag)) {
      this.db.exec("UPDATE watches SET resolved_location_urls = NULL, resolved_location_checked_at = NULL WHERE location_mode = 'state'");
      this.db.prepare("INSERT INTO schema_flags (name) VALUES (?)").run(stateCitiesFlag);
    }
    // Clynx Cloud Phase 6 — productSync.ts needs an updated_at to compare
    // for last-write-wins, same as watches.updated_at already does. Existing
    // installs only have created_at (set-once — none of the mutating product
    // methods below bumped a separate timestamp before this), backfilled
    // from created_at so an existing product row still gets a sane,
    // monotonic starting point rather than 0/null forcing every remote pull
    // to always "win" on first sync, same reasoning as feedback.updated_at's
    // own backfill above.
    if (!productCols.includes("updated_at")) {
      this.db.exec("ALTER TABLE products ADD COLUMN updated_at INTEGER");
      this.db.exec("UPDATE products SET updated_at = created_at WHERE updated_at IS NULL");
    }

    // Per explicit instruction — "when the AI blacklists listings, make
    // sure it blacklists both the title and the image(s), report both in
    // Blacklist": a proper column linking an image row back to the
    // BlacklistTerm it was added alongside, so the Database Blacklist
    // section can show them together instead of relying on parsing the
    // free-text reason field.
    const blacklistedImageCols = (this.db.prepare("PRAGMA table_info(blacklisted_images)").all() as any[]).map((c) => c.name);
    if (!blacklistedImageCols.includes("linked_term")) {
      this.db.exec("ALTER TABLE blacklisted_images ADD COLUMN linked_term TEXT");
      // Backfill existing rows added the old way (a term inferred only from
      // the reason text) so images blacklisted before this column existed
      // still show up linked, not just new ones going forward. Extracts
      // whatever sits between the first and last double-quote rather than a
      // hardcoded offset, so it doesn't depend on the exact prefix wording
      // staying byte-for-byte identical.
      this.db.exec(`
        UPDATE blacklisted_images
        SET linked_term = SUBSTR(reason, INSTR(reason, '"') + 1, LENGTH(reason) - INSTR(reason, '"') - 1)
        WHERE linked_term IS NULL AND reason LIKE 'Blacklisted alongside the term "%"'
      `);
    }
  }

  hasSeen(id: string): boolean {
    return timedSync("db_dedup_lookup", () => {
      const row = this.db.prepare("SELECT 1 FROM listings WHERE id = ?").get(id);
      return row !== undefined;
    });
  }

  // Per explicit instruction — the in-memory-cache-first version of
  // hasSeen(), for scrapeEngine.ts's per-listing dedup check specifically
  // (the hot path this cache is meant to speed up). See seenCache's own doc
  // comment above for why this only ever caches a CONFIRMED-seen id, never
  // a "not seen" result.
  hasSeenCached(id: string): boolean {
    // Timed on its own — this is the number to compare directly against
    // db_dedup_lookup's stats to see whether the cache is actually worth
    // having, per explicit instruction ("benchmark the DB-backed
    // deduplication versus the memory cache so we know whether it actually
    // matters"). A miss still falls through to the real (separately timed)
    // DB check below, so this stage's own duration only ever reflects the
    // Set.has() call itself, not however long a fallback DB query took.
    const hit = timedSync("dedup_cache_check", () => this.seenCache.has(id));
    if (hit) {
      recordEvent("dedup_cache_hit");
      return true;
    }
    recordEvent("dedup_cache_miss");
    const seen = this.hasSeen(id);
    if (seen) this.rememberSeen(id);
    return seen;
  }

  private rememberSeen(id: string): void {
    if (this.seenCache.size >= Store.SEEN_CACHE_MAX) {
      // Not a real LRU — this is a cheap best-effort accelerator, not a
      // correctness-critical structure, so evicting an arbitrary entry
      // (Set iteration order = insertion order, so this is actually the
      // OLDEST entry) once every 20,000 ids is a fine tradeoff against the
      // bookkeeping cost of a proper LRU for something this low-stakes.
      const oldest = this.seenCache.values().next().value;
      if (oldest !== undefined) this.seenCache.delete(oldest);
    }
    this.seenCache.add(id);
  }

  saveScored(scored: ScoredListing, sellerRisk?: SellerRiskResult): void {
    const { listing, extraction, referencePriceUsd, discountPercent, isDeal } = scored;
    const risk = sellerRisk ?? { passed: true, reasons: [] };
    // Per explicit instruction — "avg. Facebook Marketplace price... only
    // available after the ai has come across the same product multiple
    // times": fuzzy-resolved fresh on every save (not threaded in from the
    // caller) so it stays correct across every re-save of a listing as its
    // own evaluation gets refined elsewhere in evaluateListing (photo
    // analysis clearing/confirming a match, etc.) with no extra plumbing
    // needed at any of saveScored's several call sites. Same
    // findMatchingProduct fuzzy-name lookup used everywhere else in this
    // app to connect a plain matched-item name to a real Database entry.
    const productId = extraction.matchedItem ? (this.findMatchingProduct(extraction.matchedItem)?.id ?? null) : null;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO listings
          (id, title, price, url, thumbnail_url, image_urls, matched_item, reference_price_usd, discount_percent,
           condition_impact, confidence, reasoning, extracted_attributes, shipping_mentioned,
           is_deal, deal_tier, estimated_value_range, notified, first_seen_at,
           seller_joined_year, seller_rating, seller_rating_count, seller_has_profile_photo,
           seller_risk_passed, seller_risk_reasons, location_text, listing_age, seller_name, description, product_id, source, just_listed,
           ebay_seller_feedback_percent, ebay_shipping_usd,
           deal_status, gate_confidence, gate_stars, gate_headline, gate_reasons, required_discount_percent, target_price_usd, listing_age_hours, gate_facts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT notified FROM listings WHERE id = ?), 0),
           COALESCE((SELECT first_seen_at FROM listings WHERE id = ?), ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        listing.id,
        listing.title,
        listing.price,
        listing.url,
        listing.thumbnailUrl,
        JSON.stringify(listing.imageUrls ?? []),
        extraction.matchedItem,
        referencePriceUsd,
        discountPercent,
        extraction.conditionImpact,
        extraction.confidence,
        extraction.reasoning,
        extraction.extractedAttributes,
        listing.shippingMentioned ? 1 : 0,
        isDeal ? 1 : 0,
        scored.dealTier,
        scored.estimatedValueRange,
        listing.id,
        listing.id,
        Date.now(),
        listing.seller?.joinedFacebookYear ?? null,
        listing.seller?.rating ?? null,
        listing.seller?.ratingCount ?? null,
        listing.seller?.hasProfilePhoto === null || listing.seller?.hasProfilePhoto === undefined
          ? null
          : listing.seller.hasProfilePhoto
            ? 1
            : 0,
        risk.passed ? 1 : 0,
        risk.reasons.length ? JSON.stringify(risk.reasons) : null,
        listing.locationText ?? null,
        listing.listingAge ?? null,
        listing.seller?.name ?? null,
        listing.description ?? null,
        productId,
        listing.source ?? "facebook",
        listing.justListed ? 1 : 0,
        listing.seller?.ebayFeedbackPercentage ?? null,
        listing.ebayShippingUsd ?? null,
        scored.gate?.status ?? null,
        scored.gate?.confidence ?? null,
        scored.gate?.stars ?? null,
        scored.gate?.headline ?? null,
        scored.gate ? JSON.stringify(scored.gate.reasons) : null,
        scored.gate?.requiredDiscountPercent ?? null,
        scored.gate?.targetPriceUsd ?? null,
        assessListingAge(listing.listingAge, null).hours,
        scored.gate?.facts ? JSON.stringify(scored.gate.facts) : null
      );
    // Every saveScored call means this id is now definitively in the
    // listings table — remember it so a LATER hasSeenCached() check for the
    // same id (a duplicate found by this or another account) never needs
    // the DB round-trip at all, not just the first time it's checked.
    this.rememberSeen(listing.id);
    this.lastSavedId = listing.id;
  }

  // Per explicit instruction — "avg. Facebook Marketplace price... this
  // will only be available after the ai has come across the same product
  // multiple times on facebook marketplace... place this right above eBay
  // sold comps." Deliberately a LIVE aggregation over the listings table
  // (via product_id, stamped in saveScored above) rather than a cached
  // field on the product row the way eBay comps are — this should just
  // organically appear/grow as more real listings get recognized as this
  // product, with no separate "Research now" trigger needed the way eBay's
  // comps do. MIN_SAMPLES gates it off until there's genuinely more than
  // one or two data points — "multiple times," not "the one listing that
  // happened to create this product in the first place."
  // Per explicit instruction, live: "it's saying it has an average fbm
  // sales price of $200 — which is insane. it shouldn't be factoring in
  // all the scammy $65 xbox series x consoles, it should only be taking
  // the more legit looking ones seriously." Two filters, both against
  // signals the pipeline already computes for every listing (not a new
  // classifier): seller_risk_passed (this app's own existing legitimacy
  // check — account age/rating/profile photo) and condition_impact != a
  // major/broken flag (a "for parts"/"doesn't turn on" listing's low price
  // reflects being broken, not the market rate for a working one). A
  // seller-risk-failed listing already gets product_id left null in
  // saveScored above (its own matchedItem is cleared), so this is mostly
  // belt-and-suspenders there — condition is the one that actually needed
  // adding. Even with both, a real scam/bait listing can still slip
  // through with a clean-looking seller and no condition red flags in the
  // text — so ALSO drops anything priced under half the median of what's
  // left, a "less than half of everyone else's asking price" listing being
  // far more likely bait than a genuine steal worth averaging in.
  getFacebookPriceStats(productId: string): { avgPriceUsd: number; sampleSize: number } | null {
    const MIN_SAMPLES = 3;
    const rows = this.db
      .prepare(
        `SELECT price FROM listings
         WHERE product_id = ? AND price IS NOT NULL AND price > 0
           AND seller_risk_passed = 1
           AND (condition_impact IS NULL OR condition_impact != 'major')
           AND source = 'facebook'`
      )
      .all(productId) as Array<{ price: number }>;
    if (rows.length < MIN_SAMPLES) return null;

    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
    const legitPrices = prices.filter((p) => p >= median * 0.5);
    if (legitPrices.length < MIN_SAMPLES) return null;

    const avgPriceUsd = legitPrices.reduce((sum, p) => sum + p, 0) / legitPrices.length;
    return { avgPriceUsd, sampleSize: legitPrices.length };
  }

  markNotified(id: string): void {
    this.db.prepare("UPDATE listings SET notified = 1 WHERE id = ?").run(id);
  }

  // Whether a push has already gone out for this listing (a deal alert or a Watch match): the other kind must not repeat it.
  isListingNotified(id: string): boolean {
    const row = this.db.prepare("SELECT notified FROM listings WHERE id = ?").get(id) as { notified?: number } | undefined;
    return !!row?.notified;
  }

  // Per explicit instruction — multi-account scanning: which account's
  // browser session found this listing, so the user knows which login to
  // act from. A separate call rather than a saveScored() parameter,
  // deliberately: saveScored is called from many places inside
  // scrapeEngine.ts (every skip reason, every re-save on enrichment), and
  // hasSeen() already guarantees only the FIRST account to encounter a
  // given listing id ever reaches any of those call sites at all — every
  // later account re-scanning the same real listing bails out on hasSeen
  // before saveScored ever runs. So index.ts's onListing callback (which
  // fires once per save, already knows which account's engine it's
  // wired to) is the natural, ENGINE-code-untouched place to attach this,
  // rather than threading an account identity through scrapeEngine.ts's
  // save call sites.
  setListingFoundBy(id: string, accountId: string, accountLabel: string): void {
    this.db.prepare("UPDATE listings SET found_by_account_id = ?, found_by_account_label = ? WHERE id = ?").run(accountId, accountLabel, id);
  }

  deleteListing(id: string): void {
    this.db.prepare("DELETE FROM feedback WHERE listing_id = ?").run(id);
    this.db.prepare("DELETE FROM listings WHERE id = ?").run(id);
  }

  clearAllListings(): void {
    this.db.exec("DELETE FROM feedback; DELETE FROM listings;");
  }

  updatePhotoAnalysis(id: string, summary: string | null, flaws: PhotoFlaw[] = []): void {
    this.db
      .prepare("UPDATE listings SET photo_analysis = ?, photo_analysis_checked_at = ?, photo_flaws = ? WHERE id = ?")
      .run(summary, Date.now(), JSON.stringify(flaws), id);
  }

  getById(id: string): ListingRecord | null {
    const row = this.db
      .prepare(
        `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note,
           (SELECT group_concat(w.name, char(31)) FROM watch_matches wm2 JOIN watches w ON w.id = wm2.watch_id WHERE wm2.listing_id = l.id) as watch_names
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id WHERE l.id = ?`
      )
      .get(id) as any;
    return row ? this.enrichWithMatchedProductPricing(rowToRecord(row)) : null;
  }

  // Per explicit instruction — Feed's "est. value" should only ever reflect
  // real data (a matched product's own average watchcount/eBay sold price),
  // never the general pathway's own unverified guess. Looked up fresh here
  // (not stored on the listing row itself) via the SAME fuzzy
  // findMatchingProduct every other feature in this app uses to connect a
  // listing to its Database entry, so this stays correct even as products
  // get renamed/merged/re-researched after a listing was first saved.
  private enrichWithMatchedProductPricing(record: ListingRecord): ListingRecord {
    return this.enrichManyWithMatchedProductPricing([record])[0];
  }

  // The same lookup for a whole page of listings at once. Feed's list used to run
  // findMatchingProduct once PER LISTING, and a fuzzy miss loads every product row
  // (each with its photo as a data: URI) — hundreds of those per refresh, ~600ms of
  // blocked main thread for 266 listings. Here each distinct matched name is looked
  // up once, and only the few columns needed (name + the two prices) are read, in
  // the same order and with the same exact-then-fuzzy rule as findMatchingProduct.
  private enrichManyWithMatchedProductPricing(records: ListingRecord[]): ListingRecord[] {
    const byName = new Map<string, { sold: number | null; run: number | null } | null>();
    let candidates: Array<{ name: string; sold: number | null; run: number | null }> | null = null;
    // The estimate (sold comps, nudged by asking prices when sold data is thin) when there is one, else the plain sold average.
    const columns = `name, ${EBAY_VALUE_SQL} AS sold, ebay_avg_run_time_days AS run`;
    const lookup = (name: string) => {
      if (byName.has(name)) return byName.get(name)!;
      let found: { sold: number | null; run: number | null } | null = null;
      const exact = this.db.prepare(`SELECT ${columns} FROM products WHERE LOWER(name) = LOWER(?)`).get(name) as any;
      if (exact) found = { sold: exact.sold ?? null, run: exact.run ?? null };
      else {
        candidates ??= this.db.prepare(`SELECT ${columns} FROM products ORDER BY created_at DESC`).all() as any[];
        const similar = candidates.find((p) => isSimilarProductName(name, p.name));
        if (similar) found = { sold: similar.sold ?? null, run: similar.run ?? null };
      }
      byName.set(name, found);
      return found;
    };
    return records.map((record) => {
      if (!record.matchedItem) return record;
      // A listing titled "Xbox Series S" that was matched to the "Xbox Series X" entry must not show the Series X's price.
      if (modelLettersConflict(record.matchedItem, record.title)) return { ...record, matchedProductAvgSoldPriceUsd: null, matchedProductAvgRunTimeDays: null };
      const product = lookup(record.matchedItem);
      return { ...record, matchedProductAvgSoldPriceUsd: product?.sold ?? null, matchedProductAvgRunTimeDays: product?.run ?? null };
    });
  }

  // What eBay says a product is worth (the estimate, else the sold average), looked up by a product's name for the
  // deal scoring that runs on every listing. Same exact-then-fuzzy rule as findMatchingProduct, but over just a name
  // and a number (not whole product rows with their photos), kept for a few seconds between lookups.
  private ebayValueCache: { at: number; rows: Array<{ name: string; value: number | null }> } | null = null;
  getEbayValueForProductName(name: string, title?: string): number | null {
    const now = Date.now();
    if (!this.ebayValueCache || now - this.ebayValueCache.at > 10_000) {
      const rows = this.db
        .prepare(`SELECT name, ${EBAY_VALUE_SQL} AS value FROM products`)
        .all() as Array<{ name: string; value: number | null }>;
      this.ebayValueCache = { at: now, rows };
    }
    const rows = this.ebayValueCache.rows;
    const lower = name.toLowerCase();
    const found = rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => isSimilarProductName(name, r.name));
    // The listing's own title can name a more specific product than the tracked name ("xbox" tracked, "Xbox Series S" listed):
    // that product's value is the right one, even when it has none yet (better no price than the generic entry's).
    if (title && found) {
      const specific = this.moreSpecificProductForTitle(rows, found.name, title);
      if (specific) return specific.value !== null && specific.value > 0 ? specific.value : null;
    }
    return found && found.value !== null && found.value > 0 ? found.value : null;
  }

  // The Database product (value or not) whose whole name appears in the title and that has more words than `genericName`
  // (the most words wins), or null.
  private moreSpecificProductForTitle<T extends { name: string }>(rows: T[], genericName: string, title: string): T | null {
    const wordsOf = (n: string) =>
      n.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    const genericCount = wordsOf(genericName).length;
    let best: { row: T; words: number } | null = null;
    for (const r of rows) {
      const words = wordsOf(r.name);
      if (words.length < 2 || words.length <= genericCount || !words.every((w) => haystack.includes(w)) || !compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { row: r, words: words.length };
    }
    return best ? best.row : null;
  }

  // What the Database knows about the product a listing is (by its tracked/matched name, else by its title): its name, what
  // it sells for on eBay, how fast, and from how many sales. Feeds the star rating in ntfy alerts (dealSummary.ts).
  // Evidence for deciding whether a code in a listing title is a real model / version marker (identity/credibility.ts): entry names, other
  // sellers' listing titles and reference-photo titles. Built the first time a listing states a code its entry lacks (most never do), kept for ten
  // minutes, and rebuilt when the number of entries changes.
  private codeIndexCache: { at: number; products: number; index: CodeIndex } | null = null;
  private codeIndex(): CodeIndex {
    const now = Date.now();
    const products = (this.db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
    if (this.codeIndexCache && now - this.codeIndexCache.at < 600_000 && this.codeIndexCache.products === products) return this.codeIndexCache.index;
    const docs: EvidenceDoc[] = [];
    for (const p of this.db.prepare("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>) docs.push({ text: p.name, origin: `product:${p.id}`, kind: "product" });
    for (const l of this.db.prepare("SELECT title, seller_name FROM listings").all() as Array<{ title: string; seller_name: string | null }>) {
      docs.push({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" });
    }
    for (const i of this.db.prepare("SELECT source_title FROM product_images WHERE source_title IS NOT NULL").all() as Array<{ source_title: string }>) {
      docs.push({ text: i.source_title, origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" });
    }
    const index = new CodeIndex(docs);
    this.codeIndexCache = { at: now, products, index };
    return index;
  }

  /** Which codes a listing title states beyond the entry's name are backed by evidence (credible), which are not (unverified), and which are just a short form of the name. */
  assessListingCodes(entryId: string | null, entryName: string, title: string, independentTexts?: string[], seller?: string | null): CodeAssessment {
    if (codesMissingFrom(entryName, title).length === 0) return NO_CODES;
    return assessCodes({ entryId, entryName, title, index: this.codeIndex(), independentTexts, seller });
  }

  /** The credible extra codes only (what the identity second look and the market check need). */
  credibleCodes(entryId: string, entryName: string, title: string): string[] {
    return this.assessListingCodes(entryId, entryName, title).credible.map((c) => c.code);
  }

  getProductSignals(matchedItem: string | null, title: string, independentTexts?: string[]): ProductSignals | null {
    const rows = this.db
      .prepare(`SELECT id, name, ${EBAY_VALUE_SQL} AS value, ebay_avg_run_time_days AS run, ebay_comps_sample_size AS n, ebay_comps_checked_at AS at, my_store_ref AS store, ebay_est_basis AS basis, ebay_comps_identity AS ident FROM products`)
      .all() as Array<{ id: string; name: string; value: number | null; run: number | null; n: number | null; at: number | null; store: string | null; basis: string | null; ident: string | null }>;
    const toSignals = (r: (typeof rows)[number]): ProductSignals => {
      const assessment = this.assessListingCodes(r.id, r.name, title, independentTexts);
      return {
      id: r.id,
      name: r.name,
      valueUsd: r.value !== null && r.value > 0 ? r.value : null,
      runTimeDays: r.run ?? null,
      compSample: r.n ?? null,
      checkedAt: r.at ?? null,
      storeValueUsd: parseMyStore(r.store)?.medianUsd ?? null,
      basis: r.basis === "sold" || r.basis === "blend" || r.basis === "active" ? r.basis : null,
      identity: r.ident === "exact" || r.ident === "approximate" || r.ident === "unresolved" ? r.ident : null,
      // Codes the listing states that this product's name does not, split by evidence (see identity/credibility.ts): the credible ones mean
      // the listing may be a more specific product than the entry it matched, so the entry's value is not known to apply to it.
      unconfirmedCodes: assessment.credible.map((c) => c.code),
      unverifiedCodes: assessment.unverified.map((u) => u.code),
      codeAssessment: assessment,
      };
    };
    if (matchedItem) {
      const lower = matchedItem.toLowerCase();
      const hit = rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => isSimilarProductName(matchedItem, r.name));
      if (hit) return toSignals(this.moreSpecificProductForTitle(rows, hit.name, title) ?? hit);
    }
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let best: { row: (typeof rows)[number]; words: number } | null = null;
    for (const r of rows) {
      const words = r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
      if (words.length < 2 || !words.every((w) => haystack.includes(w)) || !compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { row: r, words: words.length };
    }
    return best ? toSignals(best.row) : null;
  }

  // A Database product the TITLE of a listing names (all of the product's words appear in it; the longest name wins) and
  // what eBay says it is worth: lets the deal check use real numbers with no AI call. Null when nothing matches or
  // the product has no eBay value yet. Hard facts and colors must agree, so a "White" listing isn't priced as the Black one.
  getEbayValueForTitle(title: string): { name: string; value: number } | null {
    this.getEbayValueForProductName(""); // makes sure the shared name/value list is loaded
    const rows = this.ebayValueCache?.rows ?? [];
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let best: { name: string; value: number; words: number } | null = null;
    for (const r of rows) {
      if (r.value === null || r.value <= 0) continue;
      const words = r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
      if (words.length < 2 || !words.every((w) => haystack.includes(w))) continue;
      if (!compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { name: r.name, value: r.value, words: words.length };
    }
    return best ? { name: best.name, value: best.value } : null;
  }

  // What BROKEN / for-parts copies of a product sell for: the value of its "(For Parts / Broken)" variant in the Database (see
  // brokenVariant.ts), found by the product's name. Null when there is no such variant yet or it has no eBay value.
  getBrokenVariantValue(itemName: string): { name: string; value: number } | null {
    this.getEbayValueForProductName(""); // makes sure the shared name/value list is loaded
    const rows = this.ebayValueCache?.rows ?? [];
    const lower = itemName.toLowerCase();
    const parent = rows.find((r) => r.name.toLowerCase() === lower) ?? rows.find((r) => !isBrokenVariantName(r.name) && isSimilarProductName(itemName, r.name));
    const wanted = brokenVariantName(parent?.name ?? itemName).toLowerCase();
    const variant = rows.find((r) => r.name.toLowerCase() === wanted);
    return variant && variant.value !== null && variant.value > 0 ? { name: variant.name, value: variant.value } : null;
  }

  // The listing most recently written by saveScored. The engines announce a change to the
  // Feed right after saving, and used to send "the newest listing by first-seen time",
  // which is a different listing whenever another account saved one in between or an older
  // listing was re-saved (so its card never updated until a full refetch).
  private lastSavedId: string | null = null;
  /**
   * Listings whose stored photo list is heavy (a whole-size photo kept as a data: URI),
   * a few at a time, for the one-off shrinking pass (see index.ts's shrinkStoredListingPhotos).
   */
  listHeavyListingPhotos(limit: number): Array<{ id: string; imageUrls: string[] }> {
    const rows = this.db
      .prepare("SELECT id, image_urls FROM listings WHERE length(image_urls) > 60000 AND image_urls LIKE '%data:image%' LIMIT ?")
      .all(limit) as any[];
    return rows.map((r) => ({ id: r.id, imageUrls: JSON.parse(r.image_urls) as string[] }));
  }

  setListingImageUrls(id: string, imageUrls: string[]): void {
    this.db.prepare("UPDATE listings SET image_urls = ? WHERE id = ?").run(JSON.stringify(imageUrls), id);
  }

  getLastSavedListing(): ListingRecord | null {
    return this.lastSavedId ? this.getById(this.lastSavedId) : null;
  }

  // --- Product database (Config-adjacent knowledge profiles) ------------

  // Two entries are the same product when their names reduce to the same words (case, punctuation and filler words
  // like "new"/"edition" aside). Colors count as words, so the black and the white one stay apart.
  private productDuplicateKey(name: string): string {
    // Deliberately stricter than fuzzy matching's word list: "new" and "edition" can be part of a model's name
    // ("New Nintendo 3DS XL" is a different console from "Nintendo 3DS XL"), so only grammar words are ignored.
    const words = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w && !["the", "a", "an", "and", "or", "with", "for", "of"].includes(w));
    return [...new Set(words)].sort().join(" ");
  }

  // Creates the entry, unless the Database already has one for this product: then nothing is inserted and the
  // EXISTING entry's id is returned, so callers carry on with that one. (Two scans, accounts or lookups finding the same
  // new product at nearly the same moment used to each make their own: two "Xbox Series X" entries.) The check and
  // the insert are one synchronous step, so they can't interleave.
  addProductStub(id: string, name: string): string {
    const key = this.productDuplicateKey(name);
    if (key) {
      const rows = this.db.prepare("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>;
      const existing = rows.find((r) => this.productDuplicateKey(r.name) === key);
      if (existing) return existing.id;
    }
    const now = Date.now();
    this.db
      .prepare("INSERT INTO products (id, name, loading, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .run(id, name, now, now);
    return id;
  }

  // Folds together entries that are already duplicates of each other (made before the check above existed, or
  // arrived from another device through cloud sync): the fullest entry is kept, and everything that pointed at the
  // others (reference photos, listings, Watches, specific models) is repointed to it. Returns removedId -> keptId
  // so callers can repoint anything stored outside the database (the Search For list in config). Cheap when there
  // are no duplicates: one query over names.
  mergeDuplicateProducts(): Map<string, string> {
    const merged = new Map<string, string>();
    const names = this.db.prepare("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>;
    const groups = new Map<string, string[]>();
    for (const row of names) {
      const key = this.productDuplicateKey(row.name);
      if (!key) continue;
      const list = groups.get(key);
      if (list) list.push(row.id);
      else groups.set(key, [row.id]);
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const rows = ids.map((id) => this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as any);
      const imageCounts = this.countNormalImagesByProduct();
      const score = (r: any) =>
        (r.ebay_comps_checked_at ? 4 : 0) + (r.ebay_est_value_usd != null || r.ebay_avg_sold_price_usd != null ? 4 : 0) + (r.ai_summary ? 2 : 0) + (r.image_url ? 1 : 0) + Math.min(imageCounts.get(r.id) ?? 0, 10) * 0.2;
      rows.sort((a, b) => score(b) - score(a) || a.created_at - b.created_at);
      const winner = rows[0];
      for (const loser of rows.slice(1)) {
        // Fill what the kept entry lacks from the one being folded in.
        const fill: Array<[string, boolean]> = [
          ["ai_summary", !winner.ai_summary],
          ["ai_summary_generated_at", winner.ai_summary_generated_at == null],
          ["image_url", !winner.image_url],
          ["family", !winner.family],
          ["resale_price_usd", winner.resale_price_usd == null],
          ["resale_time_to_sell", winner.resale_time_to_sell == null],
          ["desired_price_usd", winner.desired_price_usd == null],
          ["ebay_avg_sold_price_usd", winner.ebay_avg_sold_price_usd == null],
          ["ebay_avg_run_time_days", winner.ebay_avg_run_time_days == null],
          ["ebay_avg_shipping_usd", winner.ebay_avg_shipping_usd == null],
          ["ebay_comps_sample_size", winner.ebay_comps_sample_size == null],
          ["ebay_comps_checked_at", winner.ebay_comps_checked_at == null],
          ["ebay_active_median_usd", winner.ebay_active_median_usd == null],
          ["ebay_active_sample_size", winner.ebay_active_sample_size == null],
          ["ebay_est_value_usd", winner.ebay_est_value_usd == null],
          ["ebay_est_basis", winner.ebay_est_basis == null],
        ];
        for (const [column, empty] of fill) {
          if (empty && loser[column] != null && loser[column] !== "") {
            this.db.prepare(`UPDATE products SET ${column} = ? WHERE id = ?`).run(loser[column], winner.id);
            winner[column] = loser[column];
          }
        }
        if ((!winner.category || winner.category === "Other") && loser.category && loser.category !== "Other") {
          this.db.prepare("UPDATE products SET category = ? WHERE id = ?").run(loser.category, winner.id);
        }
        if (loser.prioritized && !winner.prioritized) this.db.prepare("UPDATE products SET prioritized = 1 WHERE id = ?").run(winner.id);
        const notes = [...(winner.observed_notes ? String(winner.observed_notes).split("\n---\n") : []), ...(loser.observed_notes ? String(loser.observed_notes).split("\n---\n") : [])];
        if (notes.length) {
          winner.observed_notes = notes.slice(-15).join("\n---\n");
          this.db.prepare("UPDATE products SET observed_notes = ? WHERE id = ?").run(winner.observed_notes, winner.id);
        }
        // Watch notes use the same "\n---\n" entry separator as observed notes; identical entries are kept once.
        const lookouts = [...new Set([...String(winner.lookout_notes ?? "").split("\n---\n"), ...String(loser.lookout_notes ?? "").split("\n---\n")].map((l) => l.trim()).filter(Boolean))];
        if (lookouts.length) {
          winner.lookout_notes = lookouts.slice(-15).join("\n---\n");
          this.db.prepare("UPDATE products SET lookout_notes = ? WHERE id = ?").run(winner.lookout_notes, winner.id);
        }

        this.db.prepare("UPDATE product_images SET product_id = ? WHERE product_id = ?").run(winner.id, loser.id);
        this.db.prepare("UPDATE listings SET product_id = ? WHERE product_id = ?").run(winner.id, loser.id);
        this.db.prepare("UPDATE products SET parent_product_id = ? WHERE parent_product_id = ?").run(winner.id, loser.id);
        this.db.prepare("UPDATE watches SET linked_product_id = ? WHERE linked_product_id = ?").run(winner.id, loser.id);
        // A Watch's search terms carry their own linked product ids inside a JSON column.
        const watchRows = this.db.prepare("SELECT id, terms_json FROM watches WHERE terms_json LIKE ?").all(`%${loser.id}%`) as Array<{ id: string; terms_json: string }>;
        for (const w of watchRows) this.db.prepare("UPDATE watches SET terms_json = ? WHERE id = ?").run(w.terms_json.split(loser.id).join(winner.id), w.id);

        this.deleteProduct(loser.id);
        merged.set(loser.id, winner.id);
      }
      this.touchProduct(winner.id);
    }
    if (merged.size) this.ebayValueCache = null;
    return merged;
  }

  // Per explicit instruction — the Library's own "+" button, for a product
  // the user already has their own photo/info for and doesn't want/need AI
  // research run on. Inserted already "finished" (loading = 0) rather than
  // going through addProductStub's loading=1 + a later updateProductProfile
  // call, since there's no research pass coming to ever clear it.
  createManualProduct(id: string, name: string, category: string, imageUrl: string | null): void {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO products (id, name, category, image_url, keep_thumbnail, loading, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run(id, name, category, imageUrl, imageUrl ? 1 : 0, now, now);
  }

  updateProductProfile(
    id: string,
    data: { aiSummary: string; category: string; family: string | null; familyLogoUrl?: string | null; imageUrl: string | null }
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE products SET ai_summary = ?, ai_summary_generated_at = ?, category = ?, family = ?, family_logo_url = ?, image_url = ?, loading = 0, updated_at = ? WHERE id = ?"
      )
      .run(data.aiSummary, now, data.category, this.resolveFamilyName(data.family), data.familyLogoUrl ?? null, data.imageUrl, now, id);
  }

  // Per explicit instruction — separate from updateProductProfile above
  // (which always overwrites the AI-summary/category/family/image fields
  // as a full set) since eBay comps research runs as its OWN follow-up
  // step in index.ts's runProductLookup, on its own success/failure path —
  // a comps lookup failing shouldn't touch (or blank out) the summary/
  // image fields that already succeeded moments earlier, and vice versa.
  updateProductEbayComps(
    id: string,
    data: {
      avgSoldPriceUsd: number | null;
      avgRunTimeDays: number | null;
      avgShippingUsd: number | null;
      sampleSize: number;
      activeMedianUsd?: number | null;
      activeSampleSize?: number | null;
      estimatedValueUsd?: number | null;
      estimateBasis?: "sold" | "blend" | "active" | null;
      identity?: "exact" | "approximate" | "unresolved" | null;
    }
  ): void {
    const now = Date.now();
    this.ebayValueCache = null;
    this.db
      .prepare(
        `UPDATE products SET ebay_avg_sold_price_usd = ?, ebay_avg_run_time_days = ?, ebay_avg_shipping_usd = ?, ebay_comps_sample_size = ?, ebay_comps_checked_at = ?,
           ebay_active_median_usd = ?, ebay_active_sample_size = ?, ebay_est_value_usd = ?, ebay_est_basis = ?, ebay_comps_identity = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        data.avgSoldPriceUsd,
        data.avgRunTimeDays,
        data.avgShippingUsd,
        data.sampleSize,
        now,
        data.activeMedianUsd ?? null,
        data.activeSampleSize ?? null,
        data.estimatedValueUsd ?? null,
        data.estimateBasis ?? null,
        data.identity ?? null,
        now,
        id
      );
  }

  // The user's own store's price for a product (see myStore.ts); null clears it.
  setProductMyStore(id: string, ref: MyStoreReference | null): void {
    this.db.prepare("UPDATE products SET my_store_ref = ? WHERE id = ?").run(ref ? JSON.stringify(ref) : null, id);
  }

  clearAllMyStoreRefs(): void {
    this.db.exec("UPDATE products SET my_store_ref = NULL WHERE my_store_ref IS NOT NULL");
  }

  // --- Specific models filed under a more generic product -----------------
  // Products that are the same thing as `name` apart from color: the black and the white Xbox Series S. Used to find
  // the entry a differently-colored listing or photo belongs to.
  listProductsSharingBase(name: string, excludeId?: string): ProductProfile[] {
    const base = colorlessProductTokens(name);
    if (!base.size) return [];
    return this.listProductIndex()
      .filter((p) => {
        if (p.id === excludeId) return false;
        const other = colorlessProductTokens(p.name);
        return other.size === base.size && [...base].every((t) => other.has(t));
      })
      .map((p) => this.getProductById(p.id))
      .filter((p): p is ProductProfile => p !== null);
  }

  // The entry that is exactly this product in exactly this color, if there is one.
  findColorVariant(name: string): ProductProfile | null {
    const wanted = colorsIn(name);
    return this.listProductsSharingBase(name).find((p) => sameColors(colorsIn(p.name), wanted)) ?? null;
  }

  // A "child" product is a more specific model of a generic entry (an EVGA XC card under the plain
  // "RTX 3060 Ti" entry). Local-only: it isn't part of the cloud product sync, which leaves the column alone.
  setProductParent(id: string, parentId: string | null): void {
    this.db.prepare("UPDATE products SET parent_product_id = ?, updated_at = ? WHERE id = ?").run(parentId, Date.now(), id);
  }

  listProductChildren(parentId: string): ProductProfile[] {
    const rows = this.db.prepare("SELECT * FROM products WHERE parent_product_id = ? ORDER BY name").all(parentId) as any[];
    return rows.map(rowToProduct);
  }

  // Just the listing titles that photos in a product's gallery came from (no image data), newest first. Tells the
  // identity check what kinds of listing have already been filed under a product.
  listProductPhotoTitles(productId: string, limit: number): string[] {
    const rows = this.db
      .prepare("SELECT source_title FROM product_images WHERE product_id = ? AND source_title IS NOT NULL ORDER BY created_at DESC LIMIT ?")
      .all(productId, limit * 3) as Array<{ source_title: string }>;
    return [...new Set(rows.map((r) => r.source_title))].slice(0, limit);
  }

  // Per explicit instruction — lets a SECOND product landing in the same
  // top-level brand family (e.g. the next Xbox product researched after
  // the first) reuse whatever logo image the first one already found,
  // instead of running its own "<brand> logo" web image search from
  // scratch (see index.ts's runProductLookup, which calls this BEFORE
  // deciding whether to search). Matched against the family column's own
  // top-level segment (everything before the first " > ", or the whole
  // string for a single-level family) so a search under "Xbox > Games >
  // Xbox 360" still finds the logo already stored against plain "Xbox".
  // Gives every product in a top-level family (and its sub-families) that has no logo yet this one.
  setFamilyLogo(topLevelFamily: string, logo: string): void {
    this.db
      .prepare(
        `UPDATE products SET family_logo_url = ?, updated_at = ?
         WHERE (family_logo_url IS NULL OR family_logo_url = '') AND (LOWER(family) = LOWER(?) OR LOWER(family) LIKE LOWER(?) || ' >%')`
      )
      .run(logo, Date.now(), topLevelFamily, topLevelFamily);
  }

  getFamilyLogoUrl(topLevelFamily: string): string | null {
    const row = this.db
      .prepare(
        `SELECT family_logo_url FROM products
         WHERE family_logo_url IS NOT NULL AND family_logo_url != ''
           AND (LOWER(family) = LOWER(?) OR LOWER(family) LIKE LOWER(?) || ' >%')
         LIMIT 1`
      )
      .get(topLevelFamily, topLevelFamily) as { family_logo_url: string } | undefined;
    return row?.family_logo_url ?? null;
  }

  // Per explicit instruction — a FOLDER-level thumbnail for a sub-grouping
  // within a family (e.g. "Xbox > Games" or "Xbox > Accessories") that
  // represents the BUCKET itself, not any one member product — see
  // index.ts's runProductLookup (which fetches and caches this once per
  // path, the same "fetch once, reuse forever" shape as familyLogoUrl
  // above) and Database.tsx's FamilyTile (which prefers this over an
  // arbitrary member's own photo for a non-top-level folder tile). Keyed
  // by the full path (lowercased for a case-insensitive match, same
  // normalization the family column itself gets via resolveFamilyName) —
  // "Xbox > Games" and "Xbox > Accessories" are cached separately, unlike
  // the brand logo which is shared by the whole top-level family.
  getGroupThumbnail(path: string): string | null {
    const row = this.db.prepare("SELECT image_data FROM group_thumbnails WHERE path_key = LOWER(?)").get(path) as
      | { image_data: string }
      | undefined;
    return row?.image_data ?? null;
  }

  setGroupThumbnail(path: string, imageData: string): void {
    this.db
      .prepare("INSERT INTO group_thumbnails (path_key, image_data, created_at) VALUES (LOWER(?), ?, ?) ON CONFLICT(path_key) DO UPDATE SET image_data = excluded.image_data")
      .run(path, imageData, Date.now());
  }

  // The whole map at once (path -> image), for Database.tsx to prime its
  // client-side cache in one round trip rather than one IPC call per
  // folder tile — this dataset stays small (one row per distinct
  // sub-grouping actually seen, not per product), so there's no pagination
  // concern here the way there would be for, say, listings.
  listGroupThumbnails(): Record<string, string> {
    const rows = this.db.prepare("SELECT path_key, image_data FROM group_thumbnails").all() as Array<{ path_key: string; image_data: string }>;
    const map: Record<string, string> = {};
    for (const row of rows) map[row.path_key] = row.image_data;
    return map;
  }

  // Per explicit instruction — normalizes a freshly-AI-generated family
  // name (e.g. "Xbox", or a multi-level path like "Xbox > Games > Xbox
  // 360" — see types.ts's ProductProfile.family) against whatever family
  // paths are ALREADY in use in the Database before storing it, the same
  // drift problem category's fixed enum exists to avoid but without a
  // bounded list to pick from: left unchecked, "Xbox Series X Controller"
  // researched today and "Xbox Series X" researched next week could easily
  // end up filed under "Xbox" and "Microsoft Xbox" respectively, defeating
  // the whole point of grouping them together.
  //
  // Normalizes PATH SEGMENT BY SEGMENT rather than the whole string at
  // once, and only against siblings that share the same already-resolved
  // ancestor chain — so a "Games" level under "Xbox" is compared against
  // other "Xbox > Games > ..." entries, never against an unrelated "Games"
  // level that happens to sit under "PlayStation". Exact case-insensitive
  // match wins first per segment; a fuzzy one-contains-the-other fallback
  // (same idea as isSimilarProductName, just simpler since these are short
  // brand/line names, not full product titles) catches near-misses like
  // "Xbox" vs "XBox". A segment with nothing close becomes a new node at
  // that point in the tree (and everything below it also has to be new,
  // there being nothing established yet to match against). null stays null.
  // Public (not just an updateProductProfile implementation detail) so
  // index.ts's runProductLookup can resolve the CANONICAL path before
  // deciding whether a brand-logo search is even needed (see
  // getFamilyLogoUrl above) — calling it again inside updateProductProfile
  // on an already-resolved string is harmless, it just matches itself.
  resolveFamilyName(candidate: string | null): string | null {
    const trimmed = candidate?.trim();
    if (!trimmed) return null;
    const segments = trimmed
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!segments.length) return null;

    const existingPaths = (
      this.db.prepare("SELECT DISTINCT family FROM products WHERE family IS NOT NULL AND family != ''").all() as Array<{ family: string }>
    ).map((row) => row.family.split(">").map((s) => s.trim()).filter(Boolean));

    const resolved: string[] = [];
    for (let depth = 0; depth < segments.length; depth++) {
      const candidateSegment = segments[depth];
      const candidateLower = candidateSegment.toLowerCase();
      const siblings = existingPaths
        .filter((path) => path.length > depth && resolved.every((seg, i) => path[i].toLowerCase() === seg.toLowerCase()))
        .map((path) => path[depth]);
      const match = siblings.find((sib) => {
        const sibLower = sib.toLowerCase();
        return sibLower === candidateLower || sibLower.includes(candidateLower) || candidateLower.includes(sibLower);
      });
      resolved.push(match ?? candidateSegment);
    }
    return resolved.join(" > ");
  }

  setProductLoading(id: string, loading: boolean): void {
    this.db.prepare("UPDATE products SET loading = ?, updated_at = ? WHERE id = ?").run(loading ? 1 : 0, Date.now(), id);
  }

  // Manual correction/input from the Database screen. Title and the
  // research writeup are hand-corrections for when either gets something
  // wrong or goes stale; resalePriceUsd/resaleTimeToSell are the user's own
  // real sales history (what THEY actually sold this for, and how long it
  // took) — never touched by research or scanning, only ever set here.
  // imageUrl/keepThumbnail are the manual-thumbnail feature (see
  // products:pickThumbnail in index.ts) — imageUrl here is always a
  // data: URI already downloaded by the caller, never a bare remote URL.
  // Category stays AI-only (a controlled list, no reason to hand-correct).
  editProductProfile(
    id: string,
    patch: Partial<{
      name: string;
      aiSummary: string;
      resalePriceUsd: number | null;
      resaleTimeToSell: string | null;
      imageUrl: string | null;
      keepThumbnail: boolean;
      desiredPriceUsd: number | null;
      hardCapAtDesiredPrice: boolean;
      prioritized: boolean;
    }>
  ): void {
    // Clynx Cloud Phase 6 — every branch below also bumps updated_at (one
    // shared timestamp for the whole patch call), so productSync.ts's
    // last-write-wins push picks up any edit made through this method,
    // same posture as Watch's updateWatch.
    const now = Date.now();
    if (patch.name !== undefined && patch.name.trim()) {
      this.db.prepare("UPDATE products SET name = ?, updated_at = ? WHERE id = ?").run(patch.name.trim(), now, id);
    }
    if (patch.aiSummary !== undefined) {
      this.db.prepare("UPDATE products SET ai_summary = ?, updated_at = ? WHERE id = ?").run(patch.aiSummary, now, id);
    }
    if (patch.imageUrl !== undefined) {
      this.db.prepare("UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?").run(patch.imageUrl, now, id);
    }
    if (patch.keepThumbnail !== undefined) {
      this.db.prepare("UPDATE products SET keep_thumbnail = ?, updated_at = ? WHERE id = ?").run(patch.keepThumbnail ? 1 : 0, now, id);
    }
    if (patch.resalePriceUsd !== undefined) {
      this.db.prepare("UPDATE products SET resale_price_usd = ?, updated_at = ? WHERE id = ?").run(patch.resalePriceUsd, now, id);
    }
    if (patch.resaleTimeToSell !== undefined) {
      const trimmed = patch.resaleTimeToSell?.trim() || null;
      this.db.prepare("UPDATE products SET resale_time_to_sell = ?, updated_at = ? WHERE id = ?").run(trimmed, now, id);
    }
    if (patch.desiredPriceUsd !== undefined) {
      this.db.prepare("UPDATE products SET desired_price_usd = ?, updated_at = ? WHERE id = ?").run(patch.desiredPriceUsd, now, id);
    }
    if (patch.hardCapAtDesiredPrice !== undefined) {
      this.db.prepare("UPDATE products SET hard_cap_at_desired_price = ?, updated_at = ? WHERE id = ?").run(patch.hardCapAtDesiredPrice ? 1 : 0, now, id);
    }
    if (patch.prioritized !== undefined) {
      this.db.prepare("UPDATE products SET prioritized = ?, updated_at = ? WHERE id = ?").run(patch.prioritized ? 1 : 0, now, id);
    }
  }

  // User-authored, from that product's own Database chat (see chat.ts's
  // add_product_watch_note) — practical things to check for in real
  // listings (bundled extras, condition red flags). Append-only, capped to
  // the most recent entries, same pattern as recordProductObservation.
  // Returns the updated product so the caller can push a live UI update.
  appendProductWatchNote(id: string, note: string): ProductProfile | null {
    const trimmed = note.trim();
    if (!trimmed) return null;
    const product = this.getProductById(id);
    if (!product) return null;
    const prior = product.lookoutNotes ? product.lookoutNotes.split("\n---\n") : [];
    const next = [...prior, trimmed].slice(-15).join("\n---\n");
    this.db.prepare("UPDATE products SET lookout_notes = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), id);
    return this.getProductById(id);
  }

  listProducts(): ProductProfile[] {
    const rows = this.db.prepare("SELECT * FROM products ORDER BY created_at DESC").all() as any[];
    return rows.map(rowToProduct);
  }

  // A light view of the Database for lookups that only need to know which products exist: id, name and family, newest first. It
  // never reads a product's photo (a row's thumbnail is ~90 KB of text, so listProducts() on a library of hundreds is tens of
  // megabytes), and it is read fresh each time, so a product added a moment ago is always seen. Use this, not listProducts(),
  // for name matching and name lists; load the one row you need afterwards with getProductById.
  // The entries with no thumbnail yet (id and name only, never the photos of the others): what the background "research blank entries" sweep needs.
  listBlankProductIndex(): Array<{ id: string; name: string }> {
    return this.db.prepare("SELECT id, name FROM products WHERE image_url IS NULL OR image_url = '' ORDER BY created_at DESC").all() as Array<{ id: string; name: string }>;
  }

  listProductIndex(): Array<{ id: string; name: string; family: string | null }> {
    return this.db.prepare("SELECT id, name, family FROM products ORDER BY created_at DESC").all() as Array<{ id: string; name: string; family: string | null }>;
  }

  getProductById(id: string): ProductProfile | null {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as any;
    return row ? rowToProduct(row) : null;
  }

  // Case-insensitive exact-ish match used to link a Search For item's name
  // to a product profile for extra scoring context.
  getProductByName(name: string): ProductProfile | null {
    const row = this.db.prepare("SELECT * FROM products WHERE LOWER(name) = LOWER(?)").get(name) as any;
    return row ? rowToProduct(row) : null;
  }

  // Exact match first, then a fuzzy fallback (see isSimilarProductName) —
  // this is what lets a differently-phrased listing of a product already in
  // the Database strengthen that existing entry instead of spawning a
  // near-duplicate one under its own slightly different name.
  findMatchingProduct(name: string): ProductProfile | null {
    const exact = this.getProductByName(name);
    if (exact) return exact;
    // Fuzzy: compare against names only, then load just the one product that matched.
    const similar = this.listProductIndex().find((p) => isSimilarProductName(name, p.name));
    return similar ? this.getProductById(similar.id) : null;
  }

  // Clynx Cloud Phase 6 — productSync.ts's own applier, mirroring
  // Store.upsertWatchFromCloud exactly: applies a remote product profile
  // (already decided by the caller to be newer, via its own updated_at
  // comparison — this method does no conflict logic of its own) into local
  // SQLite, keyed by the SAME id the remote row carries as its localId.
  // Inserts a brand-new row when this id doesn't exist locally yet (a
  // product added on another device), or overwrites the synced fields on an
  // existing row otherwise. Deliberately leaves image_url/family_logo_url/
  // loading untouched either way — those are either local-only binary data
  // (data: URIs, out of Phase 6's sync scope — see 006_products.sql) or, for
  // loading, a purely local in-flight-research flag that a remote write
  // should never toggle. Never called from chat.ts, index.ts's
  // runProductLookup, or any other product-mutation call site — those
  // remain untouched and keep going through addProductStub/
  // updateProductProfile/editProductProfile etc. above.
  upsertProductFromCloud(product: ProductProfile): ProductProfile {
    const existing = this.getProductById(product.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE products SET
            name = ?, ai_summary = ?, ai_summary_generated_at = ?, observed_notes = ?, category = ?, family = ?,
            resale_price_usd = ?, resale_time_to_sell = ?, lookout_notes = ?, keep_thumbnail = ?,
            desired_price_usd = ?, hard_cap_at_desired_price = ?, prioritized = ?,
            ebay_avg_sold_price_usd = ?, ebay_avg_run_time_days = ?, ebay_avg_shipping_usd = ?,
            ebay_comps_sample_size = ?, ebay_comps_checked_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          product.name,
          product.aiSummary,
          product.aiSummaryGeneratedAt,
          product.observedNotes,
          product.category,
          this.resolveFamilyName(product.family),
          product.resalePriceUsd,
          product.resaleTimeToSell,
          product.lookoutNotes,
          product.keepThumbnail ? 1 : 0,
          product.desiredPriceUsd,
          product.hardCapAtDesiredPrice ? 1 : 0,
          product.prioritized ? 1 : 0,
          product.ebayAvgSoldPriceUsd,
          product.ebayAvgRunTimeDays,
          product.ebayAvgShippingUsd,
          product.ebayCompsSampleSize,
          product.ebayCompsCheckedAt,
          product.updatedAt,
          product.id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO products (
            id, name, ai_summary, ai_summary_generated_at, observed_notes, category, family,
            resale_price_usd, resale_time_to_sell, lookout_notes, keep_thumbnail,
            desired_price_usd, hard_cap_at_desired_price, prioritized,
            ebay_avg_sold_price_usd, ebay_avg_run_time_days, ebay_avg_shipping_usd,
            ebay_comps_sample_size, ebay_comps_checked_at, loading, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          product.id,
          product.name,
          product.aiSummary,
          product.aiSummaryGeneratedAt,
          product.observedNotes,
          product.category,
          this.resolveFamilyName(product.family),
          product.resalePriceUsd,
          product.resaleTimeToSell,
          product.lookoutNotes,
          product.keepThumbnail ? 1 : 0,
          product.desiredPriceUsd,
          product.hardCapAtDesiredPrice ? 1 : 0,
          product.prioritized ? 1 : 0,
          product.ebayAvgSoldPriceUsd,
          product.ebayAvgRunTimeDays,
          product.ebayAvgShippingUsd,
          product.ebayCompsSampleSize,
          product.ebayCompsCheckedAt,
          product.createdAt,
          product.updatedAt
        );
    }
    return this.getProductById(product.id)!;
  }

  deleteProduct(id: string): void {
    this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM product_images WHERE product_id = ?").run(id);
    this.identity?.forgetProduct(id);
    // Batch 2 Fix B — see deleteWatch's own comment above; same reasoning,
    // productSync.ts's own pushPendingDeletes drains this resource type.
    this.addPendingCloudDelete("product", id);
  }

  // Per explicit instruction — the Database's own "Clear all" button,
  // same shape as Feed's clearAllListings. Only the products themselves
  // and their reference-photo galleries; the Blacklist and Blacklisted
  // Images sections are separate data and untouched by this, same as
  // Feed's clear-all never touches the Blacklist either.
  clearAllProducts(): void {
    this.db.exec("DELETE FROM product_images; DELETE FROM products;");
    this.identity?.forgetAllProducts();
  }

  // --- Product reference-photo library ------------------------------------
  // See types.ts's ProductImage: a growing library of confirmed-genuine
  // photos per product, auto-populated whenever the scanner confirms a real
  // deal for it (see scrapeEngine.ts's evaluateListing), plus whatever the
  // user adds/removes by hand from the product's own page.

  private static readonly MAX_IMAGES_PER_PRODUCT = 20;

  listProductImages(productId: string): ProductImage[] {
    const rows = this.db
      .prepare("SELECT * FROM product_images WHERE product_id = ? ORDER BY created_at DESC")
      .all(productId) as any[];
    return rows.map(rowToProductImage);
  }

  // Auto-called on a confirmed deal, or the user manually adding one from
  // the product's page — same storage either way. Prunes the oldest once
  // over the cap so a long-running scan session can't grow this
  // unboundedly; a manually-added photo is just as prunable as an
  // auto-added one; the cap protects DB size, not curation intent.
  addProductImage(productId: string, imageData: string, sourceTitle: string | null, kind: "normal" | "poor_condition" = "normal"): ProductImage {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, productId, imageData, sourceTitle, Date.now(), kind);
    const excess = this.db
      .prepare("SELECT id FROM product_images WHERE product_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(productId, Store.MAX_IMAGES_PER_PRODUCT) as Array<{ id: string }>;
    for (const row of excess) {
      this.db.prepare("DELETE FROM product_images WHERE id = ?").run(row.id);
    }
    return { id, productId, imageData, sourceTitle, createdAt: Date.now(), kind };
  }

  // How many ordinary (non-poor-condition) reference photos each product
  // has — one grouped query instead of loading every photo's bytes just to
  // count them. Products with none are simply absent from the map.
  countNormalImagesByProduct(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT product_id, COUNT(*) as n FROM product_images WHERE kind = 'normal' GROUP BY product_id")
      .all() as Array<{ product_id: string; n: number }>;
    return new Map(rows.map((r) => [r.product_id, r.n]));
  }

  // Bumps updated_at without changing anything else — for writes that only
  // touch product_images (which has no timestamp of its own on the product
  // row), so cloud sync and any UI keyed off updatedAt still notice them.
  touchProduct(id: string): void {
    this.db.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteProductImage(id: string): void {
    this.db.prepare("DELETE FROM product_images WHERE id = ?").run(id);
  }

  // Used by the general-tier vision check (see scrapeEngine.ts) to pick a
  // small, bounded set of known products to compare an unmatched listing's
  // photos against — capped there, not here, since the caller decides how
  // many reference images it can afford to attach to one vision call.
  // Ordered by most-recently-added image first, as a simple proxy for
  // "products the user has actively been finding/curating lately."
  listProductsWithImages(limit: number): Array<{ product: ProductProfile; images: ProductImage[] }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT product_id, MAX(created_at) as latest FROM product_images GROUP BY product_id ORDER BY latest DESC LIMIT ?`
      )
      .all(limit) as Array<{ product_id: string }>;
    const result: Array<{ product: ProductProfile; images: ProductImage[] }> = [];
    for (const row of rows) {
      const product = this.getProductById(row.product_id);
      if (!product) continue;
      // Condition-awareness — a poor-condition/damaged reference photo
      // isn't reliable "what does this normally look like" ground truth
      // for vision's own ground-truth comparison use of this list.
      result.push({ product, images: this.listProductImages(row.product_id).filter((img) => img.kind === "normal") });
    }
    return result;
  }

  // Per explicit instruction — the Prioritize star's actual mechanical
  // effect: every product marked prioritized gets included in the vision
  // "does this listing show a product I already know" reference set (see
  // scrapeEngine.ts's runPhotoAnalysis), regardless of how recently it was
  // last touched — listProductsWithImages above only ever returns the 3
  // MOST RECENT, which would routinely leave out a prioritized product
  // that hasn't come up in a while, exactly when the user wants the
  // opposite (found as often as possible). Only returns ones that actually
  // have at least one reference photo to compare against — a prioritized
  // product with none yet has nothing to visually match on regardless of
  // how much it's prioritized.
  listPrioritizedProductsWithImages(): Array<{ product: ProductProfile; images: ProductImage[] }> {
    const rows = this.db.prepare("SELECT id FROM products WHERE prioritized = 1").all() as Array<{ id: string }>;
    const result: Array<{ product: ProductProfile; images: ProductImage[] }> = [];
    for (const row of rows) {
      const product = this.getProductById(row.id);
      if (!product) continue;
      // Condition-awareness — same reasoning as listProductsWithImages above.
      const images = this.listProductImages(row.id).filter((img) => img.kind === "normal");
      if (images.length) result.push({ product, images });
    }
    return result;
  }

  // Reinforcement, not discovery: called while the scanner evaluates a
  // listing that resolves to a recognizable product name (a Search For
  // match, or the AI's own general-deal category guess) — whether or not
  // that particular listing turned out to be a deal. Builds a running log of
  // real observed details (condition notes, bundle contents, anything the AI
  // noticed) so a product the user already asked about keeps getting
  // smarter as more listings for it turn up.
  //
  // Deliberately append-only — this never creates a new product record. Per
  // explicit instruction, the Database should only ever contain products
  // the user actually asked about (via chat's research_product, or the
  // Feed's Research button — see index.ts), never every product the scanner
  // happens to pass over; that's what "keeping tabs" without "cluttering
  // the Database" means in practice. So if `name` doesn't match anything
  // already in the Database — exactly or similarly, see findMatchingProduct
  // — there's nothing to reinforce and this is a silent no-op, not a
  // fallback creation. Capped to the most recent entries so this can't grow
  // unbounded over a long-running scan session. Returns the updated product
  // (or null if there was nothing to reinforce) so callers can push a live
  // Database update.
  recordProductObservation(name: string, note: string): ProductProfile | null {
    const trimmedName = name.trim();
    const trimmedNote = note.trim();
    if (!trimmedName || !trimmedNote) return null;

    const match = this.findMatchingProduct(trimmedName);
    if (!match) return null;
    return this.appendProductObservation(match, trimmedName, trimmedNote);
  }

  // The same note, written to a product the caller already resolved (the identity check may have picked a more
  // specific model than the one the name alone would fuzzy-match).
  appendProductObservation(match: ProductProfile, trimmedName: string, trimmedNote: string): ProductProfile | null {
    const sameName = match.name.toLowerCase() === trimmedName.toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    const entry = sameName ? `[${date}] ${trimmedNote}` : `[${date}] (also seen listed as "${trimmedName}") ${trimmedNote}`;
    const prior = match.observedNotes ? match.observedNotes.split("\n---\n") : [];
    const next = [...prior, entry].slice(-15).join("\n---\n");
    this.db.prepare("UPDATE products SET observed_notes = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), match.id);
    return this.getProductById(match.id);
  }

  // --- Category dismissals ("not interested" learning) -------------------
  // General-tier (unverified) deals carry a coarse AI-guessed category
  // (e.g. "cordless power tool") — this is deliberately scoped to that
  // pathway only, never to Search For items, since something you
  // explicitly added to Search For is by definition something you're
  // interested in; there's nothing to learn to skip there.

  // "category" is matched case-insensitively via COLLATE NOCASE at the
  // column level below, so this can just upsert on the raw string.
  recordCategoryDismissal(category: string): void {
    const trimmed = category.trim();
    if (!trimmed) return;
    this.db
      .prepare(
        `INSERT INTO category_dismissals (category, count, last_dismissed_at) VALUES (?, 1, ?)
         ON CONFLICT(category) DO UPDATE SET count = count + 1, last_dismissed_at = excluded.last_dismissed_at`
      )
      .run(trimmed, Date.now());
  }

  // Categories dismissed `minCount` times or more — used as a cheap
  // substring-match pre-filter (see scorer.ts) to skip the general-deal AI
  // call entirely for listings matching a category the user has
  // consistently shown no interest in, rather than re-flagging the same
  // kind of thing forever.
  getDismissedCategories(minCount = 3): string[] {
    const rows = this.db.prepare("SELECT category FROM category_dismissals WHERE count >= ?").all(minCount) as Array<{ category: string }>;
    return rows.map((r) => r.category);
  }

  // --- Blacklist -----------------------------------------------------------
  // See types.ts's BlacklistTerm — a growing list of terms/phrases that
  // instantly skip a listing (see isBlacklisted below) before it's ever
  // opened, for things categorically unrelated to a mail-order resale
  // business, distinct from category_dismissals above (which is about
  // resalable-but-uninteresting items, learned from repeated "Not
  // interested" clicks, not a hard skip).

  listBlacklistTerms(): BlacklistTerm[] {
    const rows = this.db.prepare("SELECT * FROM blacklist_terms ORDER BY created_at DESC").all() as any[];
    return rows.map((r) => ({ term: r.term, source: r.source, createdAt: r.created_at }));
  }

  // Normalized (trimmed + lowercased) so "Apartment" and "apartment" are
  // the same entry — the primary key is the normalized form itself rather
  // than a separate id, which makes de-duping a plain INSERT OR IGNORE
  // instead of a separate existence check.
  // Per explicit instruction — "any time the AI blacklists something, make
  // sure it blacklists both the title and the image if possible": image is
  // genuinely optional (a chat-triggered "blacklist X" has no listing/photo
  // behind it at all) — only ever added when a caller actually has one in
  // hand for the SAME listing/product the term came from. Reuses
  // addBlacklistedImage below rather than a separate table, so it shows up
  // in the exact same Blacklisted Images gallery future thumbnail checks
  // already compare against.
  addBlacklistTerm(
    term: string,
    source: "user" | "ai",
    image?: { imageData: string; sourceTitle: string | null } | null
  ): BlacklistTerm | null {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return null;
    const createdAt = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO blacklist_terms (term, source, created_at) VALUES (?, ?, ?)").run(normalized, source, createdAt);
    const row = this.db.prepare("SELECT * FROM blacklist_terms WHERE term = ?").get(normalized) as any;
    if (!row) return null;
    if (image?.imageData) {
      this.addBlacklistedImage(image.imageData, image.sourceTitle, null, `Blacklisted alongside the term "${normalized}"`, normalized);
    }
    return { term: row.term, source: row.source, createdAt: row.created_at };
  }

  removeBlacklistTerm(term: string): void {
    this.db.prepare("DELETE FROM blacklist_terms WHERE term = ?").run(term.trim().toLowerCase());
  }

  // --- Blacklisted images ----------------------------------------------
  // See types.ts's BlacklistedImage — the photo counterpart to the term
  // blacklist above, for a listing recognized as ineligible from its
  // THUMBNAIL alone (see vision.ts's classifyThumbnailImage and
  // scrapeEngine.ts's evaluateListing), independent of what its title says.
  private static readonly MAX_BLACKLISTED_IMAGES = 40;

  // Confirmed-first, newest-first within each group — a user-reviewed
  // example is worth more than an unreviewed AI guess both for the Database
  // gallery (so genuinely-checked examples surface first) and as the
  // reference set future thumbnail checks are compared against.
  listBlacklistedImages(): BlacklistedImage[] {
    const rows = this.db.prepare("SELECT * FROM blacklisted_images ORDER BY confirmed DESC, created_at DESC").all() as any[];
    return rows.map((r) => ({
      id: r.id,
      imageData: r.image_data,
      sourceTitle: r.source_title,
      category: r.category,
      reason: r.reason,
      confirmed: !!r.confirmed,
      createdAt: r.created_at,
      linkedTerm: r.linked_term,
    }));
  }

  addBlacklistedImage(
    imageData: string,
    sourceTitle: string | null,
    category: string | null,
    reason: string | null,
    linkedTerm: string | null = null
  ): BlacklistedImage {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO blacklisted_images (id, image_data, source_title, category, reason, confirmed, created_at, linked_term) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
      )
      .run(id, imageData, sourceTitle, category, reason, createdAt, linkedTerm);
    // Prune the oldest UNCONFIRMED entries first once over the cap — a
    // user-confirmed example is curated ground truth and shouldn't get
    // silently evicted just because a long scan session kept adding fresh
    // (never-reviewed) AI guesses on top of it. Newest-first + OFFSET(keep)
    // is the same "keep the N most recent, prune the rest" pattern used by
    // addProductImage above — ASC order here would prune backwards (keeping
    // the oldest instead of the newest).
    const keepUnconfirmed = Math.max(0, Store.MAX_BLACKLISTED_IMAGES - this.countConfirmedBlacklistedImages());
    const excessUnconfirmed = this.db
      .prepare("SELECT id FROM blacklisted_images WHERE confirmed = 0 ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(keepUnconfirmed) as Array<{ id: string }>;
    for (const row of excessUnconfirmed) {
      this.db.prepare("DELETE FROM blacklisted_images WHERE id = ?").run(row.id);
    }
    return { id, imageData, sourceTitle, category, reason, confirmed: false, createdAt, linkedTerm };
  }

  private countConfirmedBlacklistedImages(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM blacklisted_images WHERE confirmed = 1").get() as { n: number };
    return row.n;
  }

  // The user reviewing the Database gallery and agreeing the AI got this
  // one right — see BlacklistedImage.confirmed.
  confirmBlacklistedImage(id: string): void {
    this.db.prepare("UPDATE blacklisted_images SET confirmed = 1 WHERE id = ?").run(id);
  }

  // The user reviewing the gallery and deciding the AI got this one WRONG —
  // per explicit instruction, removes it outright rather than leaving a
  // known-bad example sitting around (it would otherwise keep getting sent
  // as a reference example to future vision checks).
  removeBlacklistedImage(id: string): void {
    this.db.prepare("DELETE FROM blacklisted_images WHERE id = ?").run(id);
  }

  // Deterministic, no AI call — checked before a listing is ever opened
  // (see scrapeEngine.ts), same "skip before spending anything on it"
  // posture as isSuspiciousPrice/isLikelyUnshippable. Whole-word/phrase
  // matched (not a raw substring) so a short term like "art" doesn't match
  // "cart" or "smart" — the same reasoning as scorer.ts's
  // titleContainsAllWords, just for one phrase rather than requiring every
  // word of it to appear (a blacklist phrase like "for rent" should match
  // as that exact phrase, not just "for" and "rent" appearing anywhere).
  isBlacklisted(title: string): string | null {
    const lower = title.toLowerCase();
    for (const { term } of this.listBlacklistTerms()) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(lower)) return term;
    }
    return null;
  }

  setFeedback(listingId: string, verdict: FeedbackVerdict, note: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO feedback (listing_id, verdict, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`
      )
      .run(listingId, verdict, note, now, now);
  }

  clearFeedback(listingId: string): void {
    this.db.prepare("DELETE FROM feedback WHERE listing_id = ?").run(listingId);
    // Batch 2 Fix B — see deleteWatch's own comment above; same reasoning,
    // feedbackSync.ts's own pushPendingDeletes drains this resource type.
    this.addPendingCloudDelete("feedback", listingId);
  }

  // --- Clynx Cloud Phase 5 — Feed feedback sync ---------------------------
  // feedbackSync.ts's only caller into this table. Mirrors the
  // Watch/watchSync.ts push/pull shape: an in-memory sync cursor on the
  // service side compares against updated_at here, exactly like watches.

  // All feedback rows, for feedbackSync.ts's push — filtered by the
  // service's own in-memory cursor, same pattern as Store.listWatches()
  // feeding WatchSyncService.push().
  listFeedbackRaw(): Array<{ listingId: string; verdict: FeedbackVerdict; note: string | null; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare("SELECT listing_id, verdict, note, created_at, updated_at FROM feedback").all() as any[];
    return rows.map((r) => ({
      listingId: r.listing_id as string,
      verdict: r.verdict as FeedbackVerdict,
      note: r.note as string | null,
      createdAt: r.created_at as number,
      updatedAt: (r.updated_at as number) ?? (r.created_at as number),
    }));
  }

  // Single row lookup, for feedbackSync.ts's pull-side last-write-wins
  // comparison (mirrors Store.getWatchById's role in WatchSyncService.pull).
  getFeedbackRaw(listingId: string): { verdict: FeedbackVerdict; note: string | null; updatedAt: number } | null {
    const row = this.db.prepare("SELECT verdict, note, updated_at, created_at FROM feedback WHERE listing_id = ?").get(listingId) as any;
    if (!row) return null;
    return { verdict: row.verdict, note: row.note, updatedAt: row.updated_at ?? row.created_at };
  }

  // Applies a remote feedback row pulled from cloud. Only ever called after
  // feedbackSync.ts has already confirmed the remote row is strictly newer
  // (or there's no local row yet) — mirrors Store.upsertWatchFromCloud.
  // Only touches a listing that actually exists locally (feedback's FK to
  // listings) — a remote row for a listing this device has never seen is
  // silently skipped, same as it would be for any other cross-device
  // feedback reference.
  upsertFeedbackFromCloud(listingId: string, verdict: FeedbackVerdict, note: string | null, updatedAt: number): void {
    const listingExists = this.db.prepare("SELECT 1 FROM listings WHERE id = ?").get(listingId);
    if (!listingExists) return;
    this.db
      .prepare(
        `INSERT INTO feedback (listing_id, verdict, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`
      )
      .run(listingId, verdict, note, updatedAt, updatedAt);
  }

  listRecent(limit = 200, offset = 0): ListingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note,
           (SELECT group_concat(w.name, char(31)) FROM watch_matches wm2 JOIN watches w ON w.id = wm2.watch_id WHERE wm2.listing_id = l.id) as watch_names
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id
         ORDER BY l.first_seen_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as any[];
    return this.enrichManyWithMatchedProductPricing(rows.map(rowToRecord));
  }

  // Per explicit instruction — "the Listings Evaluated caps at 500, make it
  // have no cap": Dashboard's own stat used to just read listings.length off
  // the same capped listListings(500, 0) page the Feed uses for display,
  // which is fine for a scrollable feed but silently ceilings the all-time
  // stat once evaluation volume actually passes 500. A real COUNT(*) instead
  // of fetching every row keeps this cheap regardless of how large the table
  // grows.
  countListings(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM listings").get() as { count: number };
    return row.count;
  }

  // Clynx Cloud Phase 3 — listingIngestSync.ts's downstream mirror push.
  // Every scanned listing (not just scored deals — see that file's own
  // comment for why), oldest-unsynced-first so a long backlog after a
  // fresh cloud.enabled flip drains in a stable order rather than always
  // re-picking whatever's newest. cloud_synced_at IS NULL covers both
  // "never pushed" and any row that failed a previous push attempt.
  listUnsyncedListings(limit = 50): ListingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id
         WHERE l.cloud_synced_at IS NULL
         ORDER BY l.first_seen_at ASC LIMIT ?`
      )
      .all(limit) as any[];
    return rows.map((row) => rowToRecord(row));
  }

  markListingsCloudSynced(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare("UPDATE listings SET cloud_synced_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(now, id);
  }

  // Batch 2 Fix E — a listing whose ingest keeps getting rejected as invalid
  // by the cloud (a per-item validation failure reported in the ingest
  // response's own `failures` array — see listingIngestSync.ts — as opposed
  // to a network/request-level failure, which never calls this) would
  // otherwise sit in listUnsyncedListings' backlog and get retried, and
  // fail, every single tick forever. Each rejection bumps this listing's own
  // counter; once it's been rejected more than GIVE_UP_THRESHOLD times, this
  // sets cloud_synced_at to the -1 sentinel — listUnsyncedListings' existing
  // `WHERE cloud_synced_at IS NULL` filter already naturally excludes it
  // from every future tick without that query needing to know anything
  // about sentinels or attempt counts.
  private static readonly LISTING_CLOUD_SYNC_GIVE_UP_THRESHOLD = 5;

  recordListingCloudSyncFailures(ids: string[]): void {
    if (ids.length === 0) return;
    const bump = this.db.prepare("UPDATE listings SET cloud_sync_attempts = cloud_sync_attempts + 1 WHERE id = ?");
    const giveUp = this.db.prepare("UPDATE listings SET cloud_synced_at = -1 WHERE id = ?");
    const readAttempts = this.db.prepare("SELECT cloud_sync_attempts FROM listings WHERE id = ?");
    for (const id of ids) {
      bump.run(id);
      const row = readAttempts.get(id) as { cloud_sync_attempts: number } | undefined;
      if (row && row.cloud_sync_attempts > Store.LISTING_CLOUD_SYNC_GIVE_UP_THRESHOLD) giveUp.run(id);
    }
  }

  // --- Batch 2 Fix B — pending cloud deletes ------------------------------
  // A delete that happened locally (deleteWatch/clearFeedback/deleteProduct
  // below, the only writers) but hasn't been confirmed propagated to the
  // cloud mirror yet. watchSync.ts/feedbackSync.ts/productSync.ts each drain
  // their own resource_type's rows every sync tick.
  //
  // Residual limitation (documented per explicit instruction, not fully
  // closed by this fix): the DELETE and this INSERT are two separate
  // synchronous SQLite statements, not wrapped in one explicit transaction —
  // a crash landing in the narrow window between them could in principle
  // still lose the intent to propagate a delete that already happened
  // locally, letting a later pull resurrect it. Vanishingly unlikely (both
  // statements run back-to-back with no I/O or async work between them) and
  // out of scope for this fix; a real transaction would close it fully.
  addPendingCloudDelete(resourceType: "watch" | "feedback" | "product", localId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO pending_cloud_deletes (resource_type, local_id, created_at) VALUES (?, ?, ?)")
      .run(resourceType, localId, Date.now());
  }

  listPendingCloudDeletes(resourceType: "watch" | "feedback" | "product"): string[] {
    const rows = this.db
      .prepare("SELECT local_id FROM pending_cloud_deletes WHERE resource_type = ?")
      .all(resourceType) as Array<{ local_id: string }>;
    return rows.map((r) => r.local_id);
  }

  removePendingCloudDelete(resourceType: "watch" | "feedback" | "product", localId: string): void {
    this.db.prepare("DELETE FROM pending_cloud_deletes WHERE resource_type = ? AND local_id = ?").run(resourceType, localId);
  }

  // Recent labeled examples, used as few-shot context to steer future AI
  // calls — see scorer.ts's extractGeneralDeal, the first (and, per
  // explicit instruction, intended) consumer of this.
  getFeedbackExamples(limit = 4): FeedbackExample[] {
    const rows = this.db
      .prepare(
        `SELECT l.title, l.reasoning, f.verdict, f.note
         FROM feedback f JOIN listings l ON l.id = f.listing_id
         ORDER BY f.created_at DESC LIMIT ?`
      )
      .all(limit) as any[];
    return rows.map((r) => ({ title: r.title, verdict: r.verdict, note: r.note, reasoning: r.reasoning }));
  }

  // Condition-awareness — ListingCard's "?" badge confirm/deny, captured
  // as-is with no AI call here (the point is recording the user's raw
  // answer; the AI only ever sees it later, batched, via
  // getFlawFeedbackExamples on the NEXT listing's own vision call).
  addFlawFeedback(entry: {
    listingId: string;
    photoNumber: number;
    description: string;
    confidence: string;
    confirmed: boolean;
    listingTitle: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO flaw_feedback (id, listing_id, photo_number, description, confidence, confirmed, listing_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), entry.listingId, entry.photoNumber, entry.description, entry.confidence, entry.confirmed ? 1 : 0, entry.listingTitle, Date.now());
  }

  // Mirrors getFeedbackExamples above exactly — same few-shot-training-
  // example idea, just for flaw flags instead of deal verdicts. See
  // vision.ts's buildFlawFeedbackExamplesBlock, the one consumer of this.
  getFlawFeedbackExamples(limit = 6): FlawFeedbackExample[] {
    const rows = this.db
      .prepare(`SELECT listing_title, description, confidence, confirmed FROM flaw_feedback ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => ({ listingTitle: r.listing_title, description: r.description, confidence: r.confidence, confirmed: !!r.confirmed }));
  }

  // --- Watch (persistent background monitoring) --------------------------
  // Per explicit instruction — unlike searchItems (session-scoped, reset
  // every launch — see config.ts's loadConfig), Watches persist across app/
  // scanner/account restarts by design, which is exactly why they live in
  // SQLite instead of Config. See types.ts's Watch/WatchMatch for the full
  // shape and reasoning.

  // A Watch's own ntfy topic (see Watch.ntfyTopic); null or blank goes back to the topic in Config.
  setWatchNtfyTopic(id: string, topic: string | null): Watch | null {
    const clean = topic?.trim() || null;
    this.db.prepare("UPDATE watches SET ntfy_topic = ?, updated_at = ? WHERE id = ?").run(clean, Date.now(), id);
    return this.getWatchById(id);
  }

  createWatch(data: {
    name: string;
    platform?: WatchPlatform;
    searchPhrase: string;
    matchKeywords: string[];
    linkedProductId: string | null;
    minPriceUsd: number | null;
    maxPriceUsd: number | null;
    minProfitUsd: number | null;
    minDiscountPercent: number | null;
    maxListingAgeMinutes: number | null;
    minSellerRatingPercent?: number | null;
    locationMode: "country" | "state" | "city";
    selectedState: string | null;
    selectedCityOrZip: string | null;
    searchRadiusMiles: number | null;
    // Facebook Watches: everything it looks out for (when given, the first term
    // also becomes searchPhrase/matchKeywords/linkedProductId), how often it
    // checks, and which accounts it may use.
    terms?: WatchTerm[];
    checkIntervalMinutes?: number;
    accountIds?: string[];
  }): Watch {
    const id = randomUUID();
    const now = Date.now();
    const first = data.terms?.[0];
    const searchPhrase = first ? first.phrase : data.searchPhrase;
    const matchKeywords = first ? first.matchKeywords : data.matchKeywords;
    const linkedProductId = first ? first.linkedProductId : data.linkedProductId;
    this.db
      .prepare(
        `INSERT INTO watches (
          id, name, platform, search_phrase, match_keywords, linked_product_id,
          min_price_usd, max_price_usd, min_profit_usd, min_discount_percent, max_listing_age_minutes, min_seller_rating_percent,
          location_mode, selected_state, selected_city_or_zip, search_radius_miles,
          terms_json, check_interval_minutes, account_ids,
          enabled, listings_seen_count, match_count, created_at, updated_at, next_check_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`
      )
      .run(
        id,
        data.name,
        data.platform ?? "facebook",
        searchPhrase,
        JSON.stringify(matchKeywords),
        linkedProductId,
        data.minPriceUsd,
        data.maxPriceUsd,
        data.minProfitUsd,
        data.minDiscountPercent,
        data.maxListingAgeMinutes,
        data.minSellerRatingPercent ?? null,
        data.locationMode,
        data.selectedState,
        data.selectedCityOrZip,
        data.searchRadiusMiles,
        data.terms?.length ? JSON.stringify(data.terms) : null,
        data.checkIntervalMinutes ?? 15,
        data.accountIds?.length ? JSON.stringify(data.accountIds) : null,
        now,
        now,
        // Due immediately — the active scheduler (once it exists) picks up
        // any watch whose next_check_at has already passed on its very
        // first poll tick, rather than waiting a full interval before a
        // brand-new watch gets its first active check.
        now
      );
    return this.getWatchById(id)!;
  }

  updateWatch(
    id: string,
    patch: Partial<{
      name: string;
      searchPhrase: string;
      matchKeywords: string[];
      linkedProductId: string | null;
      minPriceUsd: number | null;
      maxPriceUsd: number | null;
      minProfitUsd: number | null;
      minDiscountPercent: number | null;
      maxListingAgeMinutes: number | null;
      minSellerRatingPercent: number | null;
      locationMode: "country" | "state" | "city";
      selectedState: string | null;
      selectedCityOrZip: string | null;
      searchRadiusMiles: number | null;
      terms: WatchTerm[];
      checkIntervalMinutes: number;
      accountIds: string[];
    }>
  ): Watch | null {
    const existing = this.getWatchById(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    // The first term is also the Watch's plain phrase/keywords/link (see types.ts).
    if (patch.terms?.length) {
      merged.searchPhrase = patch.terms[0].phrase;
      merged.matchKeywords = patch.terms[0].matchKeywords;
      merged.linkedProductId = patch.terms[0].linkedProductId;
    } else {
      // An edit of the plain phrase/keywords/link (the eBay form, an older caller)
      // changes the first term with it, so the two never disagree.
      merged.terms = [
        { phrase: merged.searchPhrase, matchKeywords: merged.matchKeywords, linkedProductId: merged.linkedProductId },
        ...existing.terms.slice(1),
      ];
    }
    // A location edit invalidates any cached resolution — the scheduler
    // (Phase 3) re-resolves on its own next check rather than this method
    // needing to know anything about Playwright/discoverLocation.
    //
    // Bug found live: this used to check `patch.field !== undefined` (was
    // this KEY present in the patch object at all), not whether the VALUE
    // actually changed. WatchFormFlow.tsx's own save() always sends a
    // fully-populated payload (every field, not a true partial patch), so
    // every single edit — even bumping max price by $10 — had all four
    // location keys present and wiped a perfectly good cached resolution
    // every time, forcing an unnecessary re-resolution (a real, slow,
    // Facebook-dialog-driving operation) on the scheduler's very next check.
    // Comparing against what's actually stored is what makes this fire only
    // on a genuine location change.
    const locationChanged =
      merged.locationMode !== existing.locationMode ||
      merged.selectedState !== existing.selectedState ||
      merged.selectedCityOrZip !== existing.selectedCityOrZip ||
      merged.searchRadiusMiles !== existing.searchRadiusMiles;
    this.db
      .prepare(
        `UPDATE watches SET
          name = ?, search_phrase = ?, match_keywords = ?, linked_product_id = ?,
          min_price_usd = ?, max_price_usd = ?, min_profit_usd = ?, min_discount_percent = ?, max_listing_age_minutes = ?, min_seller_rating_percent = ?,
          location_mode = ?, selected_state = ?, selected_city_or_zip = ?, search_radius_miles = ?,
          resolved_location_url = ?, resolved_location_label = ?, resolved_location_checked_at = ?, resolved_location_urls = ?,
          terms_json = ?, check_interval_minutes = ?, account_ids = ?,
          updated_at = ?
         WHERE id = ?`
      )
      .run(
        merged.name,
        merged.searchPhrase,
        JSON.stringify(merged.matchKeywords),
        merged.linkedProductId,
        merged.minPriceUsd,
        merged.maxPriceUsd,
        merged.minProfitUsd,
        merged.minDiscountPercent,
        merged.maxListingAgeMinutes,
        merged.minSellerRatingPercent ?? null,
        merged.locationMode,
        merged.selectedState,
        merged.selectedCityOrZip,
        merged.searchRadiusMiles,
        locationChanged ? null : merged.resolvedLocationUrl,
        locationChanged ? null : merged.resolvedLocationLabel,
        locationChanged ? null : merged.resolvedLocationCheckedAt,
        locationChanged || !merged.resolvedLocationUrls?.length ? null : JSON.stringify(merged.resolvedLocationUrls),
        JSON.stringify(merged.terms),
        merged.checkIntervalMinutes ?? 15,
        merged.accountIds?.length ? JSON.stringify(merged.accountIds) : null,
        Date.now(),
        id
      );
    // What the Watch looks for or where changed, so the searches it remembered no
    // longer apply, and listings it had already passed over deserve a fresh look
    // under the new rules (a wider radius, a higher price ceiling...).
    const termsChanged = JSON.stringify(merged.terms.map((t) => t.phrase)) !== JSON.stringify(existing.terms.map((t) => t.phrase));
    if (locationChanged || termsChanged) this.clearWatchSearchLinks(id);
    if (locationChanged || termsChanged || merged.minPriceUsd !== existing.minPriceUsd || merged.maxPriceUsd !== existing.maxPriceUsd) {
      this.db.prepare("DELETE FROM watch_seen_listings WHERE watch_id = ?").run(id);
    }
    return this.getWatchById(id);
  }

  // Clynx Cloud Phase 2 (watchSync.ts) — applies a remote watch (already
  // decided by the caller to be newer, via its own updated_at comparison —
  // this method does no conflict logic of its own) into local SQLite,
  // keyed by the SAME id the remote row carries as its localId. Inserts a
  // brand-new row when this id doesn't exist locally yet (a watch created
  // on another device), or overwrites the synced fields on an existing row
  // otherwise. Never called from the scan loop, watchScheduler.ts, or
  // watchMatching.ts — those only ever go through createWatch/updateWatch
  // above, which remain untouched.
  //
  // Batch 2 Fix D — the cloud side no longer carries 8 desktop-local-only
  // operational/scheduler fields (nextCheckAt, lastCheckedAt,
  // lastActiveCheckAt, listingsSeenCount, matchCount, resolvedLocationUrl,
  // resolvedLocationLabel, resolvedLocationCheckedAt — see cloudClient.ts's
  // CloudWatch), so `watch` here is deliberately narrower than the full
  // Watch type and this method's own SQL no longer touches those 8 columns
  // at all: an existing local row keeps whatever it already had for them
  // (a remote sync must never clobber this device's own scheduler state),
  // and a brand-new-to-this-device row gets the SAME defaults
  // Store.createWatch gives a freshly-created watch (due for its first
  // active check immediately, zeroed counters, no cached location).
  upsertWatchFromCloud(watch: CloudSyncedWatch): Watch {
    const existing = this.getWatchById(watch.id);
    if (existing) {
      this.db
        .prepare(
          `UPDATE watches SET
            name = ?, search_phrase = ?, match_keywords = ?, linked_product_id = ?,
            min_price_usd = ?, max_price_usd = ?, min_profit_usd = ?, min_discount_percent = ?, max_listing_age_minutes = ?,
            min_seller_rating_percent = ?, platform = ?,
            location_mode = ?, selected_state = ?, selected_city_or_zip = ?, search_radius_miles = ?,
            enabled = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          watch.name,
          watch.searchPhrase,
          JSON.stringify(watch.matchKeywords),
          watch.linkedProductId,
          watch.minPriceUsd,
          watch.maxPriceUsd,
          watch.minProfitUsd,
          watch.minDiscountPercent,
          watch.maxListingAgeMinutes,
          // A cloud row from a server that doesn't know these fields must not
          // wipe the local values (that would turn an eBay Watch back into a
          // Facebook one on the next pull).
          watch.minSellerRatingPercent !== undefined ? watch.minSellerRatingPercent : existing.minSellerRatingPercent,
          watch.platform ?? existing.platform,
          watch.locationMode,
          watch.selectedState,
          watch.selectedCityOrZip,
          watch.searchRadiusMiles,
          watch.enabled ? 1 : 0,
          watch.updatedAt,
          watch.id
        );
    } else {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO watches (
            id, name, search_phrase, match_keywords, linked_product_id,
            min_price_usd, max_price_usd, min_profit_usd, min_discount_percent, max_listing_age_minutes,
            min_seller_rating_percent, platform,
            location_mode, selected_state, selected_city_or_zip, search_radius_miles,
            enabled, listings_seen_count, match_count, next_check_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
        )
        .run(
          watch.id,
          watch.name,
          watch.searchPhrase,
          JSON.stringify(watch.matchKeywords),
          watch.linkedProductId,
          watch.minPriceUsd,
          watch.maxPriceUsd,
          watch.minProfitUsd,
          watch.minDiscountPercent,
          watch.maxListingAgeMinutes,
          watch.minSellerRatingPercent ?? null,
          watch.platform ?? "facebook",
          watch.locationMode,
          watch.selectedState,
          watch.selectedCityOrZip,
          watch.searchRadiusMiles,
          watch.enabled ? 1 : 0,
          // Due immediately — same "picked up on the very first poll tick"
          // reasoning as Store.createWatch's own next_check_at.
          now,
          watch.createdAt,
          watch.updatedAt
        );
    }
    return this.getWatchById(watch.id)!;
  }

  // Called only by the active scheduler (watchScheduler.ts) once a watch's
  // location resolves — a narrow write touching just the 3 cache columns,
  // unlike updateWatch's full-row UPDATE, so a scheduler-driven resolution
  // can never clobber an edit the user is making in WatchFormFlow at the
  // same time (or vice versa).
  setWatchResolvedLocation(id: string, data: { url: string; label: string | null; checkedAt: number }): void {
    this.db
      .prepare("UPDATE watches SET resolved_location_url = ?, resolved_location_label = ?, resolved_location_checked_at = ? WHERE id = ?")
      .run(data.url, data.label, data.checkedAt, id);
  }

  // The state / whole-country counterpart of setWatchResolvedLocation: the
  // list of places that Watch searches (see ScrapeEngine.resolveWatchPlaces).
  setWatchResolvedLocations(id: string, data: { urls: string[]; label: string | null; checkedAt: number }): void {
    this.db
      .prepare("UPDATE watches SET resolved_location_urls = ?, resolved_location_label = ?, resolved_location_checked_at = ? WHERE id = ?")
      .run(JSON.stringify(data.urls), data.label, data.checkedAt, id);
  }

  // Per explicit instruction — a real due/overdue queue, not blind
  // per-watch polling: the active scheduler polls this on its own timer
  // and gets back only the single most-overdue enabled watch (or null when
  // nothing needs checking yet). idx_watches_due (on next_check_at) keeps
  // this cheap regardless of how many watches exist. Does NOT filter on
  // location_mode — a state/country-mode watch (active checking not yet
  // implemented, see watchScheduler.ts) can still come back due; the
  // scheduler itself is what defers those rather than busy-polling them.
  getDueWatch(now: number): Watch | null {
    const row = this.db
      .prepare("SELECT * FROM watches WHERE enabled = 1 AND platform = 'facebook' AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT 1")
      .get(now) as any;
    return row ? rowToWatch(row) : null;
  }

  // Bumps last_active_check_at (an active check just ran, regardless of
  // whether anything matched) and schedules the next one. Deliberately
  // separate from recordWatchCandidateSeen's last_checked_at, which only
  // fires when a listing's TEXT actually candidate-matched (see that
  // method's own doc comment) — this fires every time the scheduler
  // completes a check, even one that found zero candidates, since it
  // reflects "did the scheduler look," not "did it find anything."
  scheduleNextWatchCheck(id: string, nextCheckAt: number): void {
    this.db.prepare("UPDATE watches SET last_active_check_at = ?, next_check_at = ? WHERE id = ?").run(Date.now(), nextCheckAt, id);
  }

  setWatchEnabled(id: string, enabled: boolean): Watch | null {
    this.db.prepare("UPDATE watches SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Date.now(), id);
    return this.getWatchById(id);
  }

  deleteWatch(id: string): void {
    this.db.prepare("DELETE FROM watch_matches WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watch_seen_listings WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watch_searches WHERE watch_id = ?").run(id);
    this.db.prepare("DELETE FROM watches WHERE id = ?").run(id);
    // Batch 2 Fix B — recorded in the SAME method as the delete itself
    // (never left to a caller to remember) so watchSync.ts's next tick
    // propagates this to the cloud mirror instead of a later pull silently
    // resurrecting it.
    this.addPendingCloudDelete("watch", id);
  }

  listWatches(): Watch[] {
    const rows = this.db.prepare("SELECT * FROM watches ORDER BY created_at DESC").all() as any[];
    return rows.map((row) => this.withSearchLinks(rowToWatch(row)));
  }

  private withSearchLinks(watch: Watch): Watch {
    watch.searchLinks = this.listWatchSearchLinks(watch.id);
    return watch;
  }

  // --- Watch: seen listings, search links, geocoding --------------------------

  /** True once this Watch has come across this listing (it is then skipped). */
  hasWatchSeen(watchId: string, listingId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM watch_seen_listings WHERE watch_id = ? AND listing_id = ?").get(watchId, listingId);
  }

  /** Remembers that this Watch has come across this listing. Returns false if it already had. */
  markWatchSeen(watchId: string, listingId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO watch_seen_listings (watch_id, listing_id, seen_at) VALUES (?, ?, ?)")
      .run(watchId, listingId, Date.now());
    return Number(result.changes) > 0;
  }

  /** Takes a listing back off a Watch's seen list (its check couldn't finish, so it should be looked at again). */
  unmarkWatchSeen(watchId: string, listingId: string): void {
    this.db.prepare("DELETE FROM watch_seen_listings WHERE watch_id = ? AND listing_id = ?").run(watchId, listingId);
  }

  /** Remembers the exact Marketplace search a Watch ran for a term at a place (replacing the last one). */
  recordWatchSearchLink(watchId: string, term: string, placeKey: string, placeLabel: string, url: string): void {
    this.db
      .prepare(
        `INSERT INTO watch_searches (watch_id, term, place_key, place_label, url, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(watch_id, term, place_key) DO UPDATE SET place_label = excluded.place_label, url = excluded.url, checked_at = excluded.checked_at`
      )
      .run(watchId, term, placeKey, placeLabel, url, Date.now());
  }

  listWatchSearchLinks(watchId: string): WatchSearchLink[] {
    const rows = this.db.prepare("SELECT term, place_label, url, checked_at FROM watch_searches WHERE watch_id = ? ORDER BY term, place_label").all(watchId) as any[];
    return rows.map((r) => ({ term: r.term, place: r.place_label, url: r.url, checkedAt: r.checked_at }));
  }

  /** Drops a Watch's remembered searches (its terms or place changed, so they no longer apply). */
  clearWatchSearchLinks(watchId: string): void {
    this.db.prepare("DELETE FROM watch_searches WHERE watch_id = ?").run(watchId);
  }

  getGeocode(query: string): { found: boolean; lat: number; lon: number; label: string | null; fetchedAt: number } | null {
    const row = this.db.prepare("SELECT lat, lon, label, found, fetched_at FROM geocode_cache WHERE query = ?").get(query) as any;
    if (!row) return null;
    return { found: !!row.found, lat: row.lat ?? 0, lon: row.lon ?? 0, label: row.label ?? null, fetchedAt: row.fetched_at };
  }

  setGeocode(query: string, result: { found: true; lat: number; lon: number; label: string | null } | { found: false }): void {
    this.db
      .prepare(
        `INSERT INTO geocode_cache (query, lat, lon, label, found, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(query) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, label = excluded.label, found = excluded.found, fetched_at = excluded.fetched_at`
      )
      .run(query, result.found ? result.lat : null, result.found ? result.lon : null, result.found ? result.label : null, result.found ? 1 : 0, Date.now());
  }

  getWatchById(id: string): Watch | null {
    const row = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as any;
    return row ? this.withSearchLinks(rowToWatch(row)) : null;
  }

  // Per explicit instruction — "listings seen" / "last checked" on a
  // Watch card. Bumped whenever a listing's title candidate-matches this
  // watch (scrapeEngine.ts's evaluateListing), regardless of whether the
  // rest of its conditions end up satisfied — a meaningful, frequently-
  // updating signal that Clynx is actually looking, distinct from
  // matchCount (which only counts genuine matches).
  recordWatchCandidateSeen(watchId: string): void {
    this.db.prepare("UPDATE watches SET listings_seen_count = listings_seen_count + 1, last_checked_at = ? WHERE id = ?").run(Date.now(), watchId);
  }

  // Per explicit instruction — "the same Marketplace listing found by
  // multiple Facebook accounts should NOT generate repeated Watch alerts."
  // hasSeenCached at the top of evaluateListing already guarantees a given
  // Facebook listing id only ever reaches scoring/matching once, globally,
  // across every account — but a single evaluation can still legitimately
  // reach this twice for the SAME watch (an immediate post-saveScored
  // check, then a deferred re-check after vision re-prices the listing —
  // see scrapeEngine.ts's runPostScoringPipeline), so the real dedup
  // backstop is UNIQUE(watch_id, listing_id) + INSERT OR IGNORE here.
  // Returns null (not a new WatchMatch) when this exact pair already
  // existed — the caller uses that to know whether to actually fire an
  // alert/increment match_count, rather than doing either on a no-op.
  recordWatchMatch(data: {
    watchId: string;
    listingId: string;
    foundByAccountId: string | null;
    foundByAccountLabel: string | null;
    discoveryMode: "passive" | "active";
    priceAtMatch: number | null;
    discountPercentAtMatch: number | null;
    profitUsdAtMatch: number | null;
  }): WatchMatch | null {
    const id = randomUUID();
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO watch_matches (
          id, watch_id, listing_id, matched_at, found_by_account_id, found_by_account_label,
          discovery_mode, price_at_match, discount_percent_at_match, profit_usd_at_match, notified, notified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`
      )
      .run(
        id,
        data.watchId,
        data.listingId,
        now,
        data.foundByAccountId,
        data.foundByAccountLabel,
        data.discoveryMode,
        data.priceAtMatch,
        data.discountPercentAtMatch,
        data.profitUsdAtMatch
      );
    if (result.changes === 0) return null; // UNIQUE(watch_id, listing_id) already had this pair — not a new match
    this.db.prepare("UPDATE watches SET match_count = match_count + 1 WHERE id = ?").run(data.watchId);
    return {
      id,
      watchId: data.watchId,
      listingId: data.listingId,
      matchedAt: now,
      foundByAccountId: data.foundByAccountId,
      foundByAccountLabel: data.foundByAccountLabel,
      discoveryMode: data.discoveryMode,
      priceAtMatch: data.priceAtMatch,
      discountPercentAtMatch: data.discountPercentAtMatch,
      profitUsdAtMatch: data.profitUsdAtMatch,
      notified: false,
      notifiedAt: null,
    };
  }

  markWatchMatchNotified(matchId: string): void {
    this.db.prepare("UPDATE watch_matches SET notified = 1, notified_at = ? WHERE id = ?").run(Date.now(), matchId);
  }

  // Joined with the canonical listings row (see rowToRecord) rather than
  // returning bare WatchMatch rows — per explicit instruction, "reuse the
  // canonical listing record rather than copying the entire listing into
  // the Watch system," so the renderer can hand each match straight to the
  // existing ListingCard component. A listing_id with no matching row left
  // in `listings` (should not normally happen — listings are never
  // deleted just because Facebook's own listing vanished) is filtered out
  // rather than crashing the join.
  listWatchMatches(watchId: string): Array<{ match: WatchMatch; listing: ListingRecord }> {
    // wm/l alias explicitly rather than `wm.*, l.*` — both tables have an
    // `id`, `notified`, `found_by_account_id`, and `found_by_account_label`
    // column, which node:sqlite would otherwise silently collapse into
    // whichever one was selected last.
    const rows = this.db
      .prepare(
        `SELECT
           wm.id as wm_id, wm.watch_id as wm_watch_id, wm.listing_id as wm_listing_id, wm.matched_at as wm_matched_at,
           wm.found_by_account_id as wm_found_by_account_id, wm.found_by_account_label as wm_found_by_account_label,
           wm.discovery_mode as wm_discovery_mode, wm.price_at_match as wm_price_at_match,
           wm.discount_percent_at_match as wm_discount_percent_at_match, wm.profit_usd_at_match as wm_profit_usd_at_match,
           wm.notified as wm_notified, wm.notified_at as wm_notified_at,
           l.*, f.verdict as feedback_verdict, f.note as feedback_note,
           (SELECT group_concat(w.name, char(31)) FROM watch_matches wm2 JOIN watches w ON w.id = wm2.watch_id WHERE wm2.listing_id = l.id) as watch_names
         FROM watch_matches wm
         JOIN listings l ON l.id = wm.listing_id
         LEFT JOIN feedback f ON f.listing_id = l.id
         WHERE wm.watch_id = ?
         ORDER BY wm.matched_at DESC`
      )
      .all(watchId) as any[];
    return rows.map((row) => ({ match: rowToWatchMatch(row), listing: rowToRecord(row) }));
  }

  // Clynx Cloud Phase 2 (watchSync.ts) — bare match rows, no listings join
  // (the join above is a renderer/ListingCard convenience this sync path
  // doesn't need; matches pushed to cloud only ever carry the snapshotted
  // match fields, never full listing data — see cloudClient.ts's
  // watchMatchToCloud). Read-only, additive; never called from the scan
  // loop or watchScheduler.ts/watchMatching.ts.
  listRawWatchMatches(watchId: string): WatchMatch[] {
    const rows = this.db
      .prepare(
        `SELECT
           id as wm_id, watch_id as wm_watch_id, listing_id as wm_listing_id, matched_at as wm_matched_at,
           found_by_account_id as wm_found_by_account_id, found_by_account_label as wm_found_by_account_label,
           discovery_mode as wm_discovery_mode, price_at_match as wm_price_at_match,
           discount_percent_at_match as wm_discount_percent_at_match, profit_usd_at_match as wm_profit_usd_at_match,
           notified as wm_notified, notified_at as wm_notified_at
         FROM watch_matches
         WHERE watch_id = ?
         ORDER BY matched_at ASC`
      )
      .all(watchId) as any[];
    return rows.map(rowToWatchMatch);
  }

  // Per explicit instruction — drives the Sidebar's unseen-match pulse
  // indicator. Cheap EXISTS query rather than counting/fetching rows — the
  // Sidebar only needs a boolean.
  hasUnseenWatchMatches(sinceTimestamp: number): boolean {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM watch_matches WHERE matched_at > ?) as has_unseen").get(sinceTimestamp) as {
      has_unseen: number;
    };
    return !!row.has_unseen;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: any): ListingRecord {
  return {
    id: row.id,
    justListed: !!row.just_listed,
    watchNames: typeof row.watch_names === "string" && row.watch_names ? row.watch_names.split("\u001f") : [],
    source: row.source === "ebay" ? "ebay" : "facebook",
    title: row.title,
    price: row.price,
    url: row.url,
    thumbnailUrl: row.thumbnail_url ?? null,
    imageUrls: row.image_urls ? JSON.parse(row.image_urls) : [],
    description: row.description ?? "",
    locationText: row.location_text ?? null,
    listingAge: row.listing_age ?? null,
    matchedItem: row.matched_item,
    referencePriceUsd: row.reference_price_usd,
    discountPercent: row.discount_percent,
    conditionImpact: row.condition_impact ?? "unknown",
    confidence: row.confidence ?? "low",
    reasoning: row.reasoning ?? "",
    extractedAttributes: row.extracted_attributes ?? "",
    shippingMentioned: !!row.shipping_mentioned,
    isDeal: !!row.is_deal,
    dealTier: row.deal_tier ?? null,
    estimatedValueRange: row.estimated_value_range ?? null,
    notified: !!row.notified,
    firstSeenAt: row.first_seen_at,
    feedback: row.feedback_verdict ?? null,
    feedbackNote: row.feedback_note ?? null,
    sellerName: row.seller_name ?? null,
    sellerJoinedYear: row.seller_joined_year ?? null,
    sellerRating: row.seller_rating ?? null,
    sellerRatingCount: row.seller_rating_count ?? null,
    sellerFeedbackPercent: row.ebay_seller_feedback_percent ?? null,
    shippingCostUsd: row.ebay_shipping_usd ?? null,
    sellerHasProfilePhoto: row.seller_has_profile_photo === null ? null : !!row.seller_has_profile_photo,
    sellerRiskPassed: row.seller_risk_passed === undefined ? true : !!row.seller_risk_passed,
    sellerRiskReasons: row.seller_risk_reasons ? JSON.parse(row.seller_risk_reasons) : [],
    photoAnalysis: row.photo_analysis ?? null,
    photoAnalysisCheckedAt: row.photo_analysis_checked_at ?? null,
    photoFlaws: row.photo_flaws ? JSON.parse(row.photo_flaws) : [],
    // Filled in by the Store methods below (enrichWithMatchedProductPricing)
    // — rowToRecord itself has no access to the products table.
    matchedProductAvgSoldPriceUsd: null,
    matchedProductAvgRunTimeDays: null,
    foundByAccountId: row.found_by_account_id ?? null,
    foundByAccountLabel: row.found_by_account_label ?? null,
    dealStatus: row.deal_status === "profitable_now" || row.deal_status === "negotiation" || row.deal_status === "worth_a_look" || row.deal_status === "pass" ? row.deal_status : null,
    gateConfidence: row.gate_confidence === "high" || row.gate_confidence === "medium" || row.gate_confidence === "low" ? row.gate_confidence : null,
    gateStars: row.gate_stars ?? null,
    gateHeadline: row.gate_headline ?? null,
    gateReasons: parseGateReasons(row.gate_reasons),
    gateFacts: parseGateFacts(row.gate_facts),
    requiredDiscountPercent: row.required_discount_percent ?? null,
    targetPriceUsd: row.target_price_usd ?? null,
    listingAgeHours: row.listing_age_hours ?? null,
  };
}

function parseGateFacts(raw: unknown): GateFactsSnapshot | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const f = JSON.parse(raw);
    if (!f || typeof f !== "object") return null;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const level = f.evidenceLevel === "strong" || f.evidenceLevel === "moderate" || f.evidenceLevel === "weak" ? f.evidenceLevel : "none";
    const basis = f.basis === "sold" || f.basis === "blend" || f.basis === "active" || f.basis === "user" ? f.basis : null;
    return {
      valueUsd: num(f.valueUsd),
      lotValueUsd: num(f.lotValueUsd),
      netProceedsUsd: num(f.netProceedsUsd),
      netPercent: num(f.netPercent),
      profitAtAskUsd: num(f.profitAtAskUsd),
      marginAtAskPercent: num(f.marginAtAskPercent),
      profitAtTargetUsd: num(f.profitAtTargetUsd),
      extrasCountedUsd: num(f.extrasCountedUsd) ?? 0,
      evidenceLevel: level,
      basis,
      sampleSize: num(f.sampleSize),
    };
  } catch {
    return null;
  }
}

function parseGateReasons(raw: unknown): GateReasonRecord[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Filler words stripped before comparing product names for similarity —
// generic enough that keeping them would make unrelated products look alike
// just for sharing a word like "bundle" or "with".
const PRODUCT_NAME_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "with", "for", "of", "new", "used", "edition",
  "bundle", "set", "kit", "pack", "brand", "great", "condition", "like", "excellent", "good",
]);

function productNameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w && !PRODUCT_NAME_STOPWORDS.has(w))
  );
}

// Reverses an earlier explicit instruction (see this function's git history
// / the comment this replaced): a shorter base name used to be treated as
// "the same product" as a longer name that just adds a variant word (PS5 ~
// PS5 Pro, Nintendo Switch ~ Nintendo Switch OLED), deliberately folding
// them into ONE shared Database entry rather than separate near-duplicates.
// Per NEW explicit instruction — the Library should show variants/special
// editions as their OWN separately-tracked entries (own price comps, own
// photos), cross-linked from the base product's page (see Database.tsx's
// findVariantSiblings) — that old folding behavior is exactly what this now
// needs to NOT do: a "PS5 Pro" observed on a real listing has to attach to
// (or spawn) its own "PlayStation 5 Pro" entry, not get silently absorbed
// as a note on the base "PlayStation 5" one, which is what was happening
// before this change (verified live — a correction distinguishing "PS5 Pro"
// packaging had nowhere to go but the base entry's own lookout notes).
//
// DATABASE_VARIANT_QUALIFIER_WORDS is its OWN list, deliberately separate
// from scorer.ts's VARIANT_QUALIFIER_WORDS (used for live SEARCH matching,
// not Database organization) — that list excludes "slim" on purpose, per an
// earlier correction that a plain "ps5" search should still catch Slim
// listings (similarly priced, not a different tier). That's a decision
// about what a SEARCH should match; this is a decision about what deserves
// its own tracked Database entry, and the user's own example explicitly
// wants Slim split out here despite staying broadly matched during search —
// two genuinely different questions, so two separate lists.
const DATABASE_VARIANT_QUALIFIER_WORDS = new Set(["pro", "slim", "max", "plus", "mini", "lite", "se", "xl", "oled", "air"]);

// True if two product names likely refer to the same product FAMILY despite
// different phrasing (e.g. "PS5 Slim" vs "PS5 Slim Console") — deterministic
// word-overlap, not an AI call, since this runs on every listing the
// scanner evaluates and needs to be instant and free, matching the rest of
// the app's non-AI matching (see scrapeEngine's matchSearchItem). A shorter
// name being fully contained in a longer one still generally counts as a
// match (a specific bundle/color/generic descriptor is still the same
// product) — UNLESS the extra word is a real tier/variant qualifier
// (Pro/Slim/OLED/...), which now blocks the merge instead of folding
// through it, so each tier gets its own Database entry. Storage/capacity
// extras (128GB, 1TB, ...) still separately block a merge too, for the same
// "real, trackable difference" reason. Minimum of 2 real (non-variant) base
// words after stripping filler avoids a single shared generic word (e.g.
// "controller") matching too broadly. Known gap: brand+model fusions like
// "PS5" vs "PlayStation 5" tokenize differently and won't match — solving
// that generally would need a per-brand alias table, which isn't worth the
// maintenance burden here.
export function isSimilarProductName(a: string, b: string): boolean {
  // A "(For Parts / Broken)" variant is never the same product as the working one (nor as another product's variant by fuzzy match).
  if (isBrokenVariantName(a) !== isBrokenVariantName(b)) return false;
  const tokensA = productNameTokens(a);
  const tokensB = productNameTokens(b);
  if (!tokensA.size || !tokensB.size) return false;
  // A black one and a white one are different entries (a name that names no color still matches any color).
  if (colorsConflict(a, b)) return false;

  const baseA = new Set([...tokensA].filter((t) => !DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  const baseB = new Set([...tokensB].filter((t) => !DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  const [smaller, larger] = baseA.size <= baseB.size ? [baseA, baseB] : [baseB, baseA];
  if (smaller.size < 2) return false;
  for (const t of smaller) if (!larger.has(t)) return false;

  const variantsA = new Set([...tokensA].filter((t) => DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  const variantsB = new Set([...tokensB].filter((t) => DATABASE_VARIANT_QUALIFIER_WORDS.has(t)));
  if (variantsA.size !== variantsB.size || [...variantsA].some((v) => !variantsB.has(v))) return false;

  const extra = [...larger].filter((t) => !smaller.has(t));
  return !extra.some((t) => /^\d+(gb|tb|mb)$/i.test(t));
}

function colorlessProductTokens(name: string): Set<string> {
  return new Set([...productNameTokens(name)].filter((t) => !isColorWord(t)));
}

function rowToProduct(row: any): ProductProfile {
  return {
    id: row.id,
    name: row.name,
    aiSummary: row.ai_summary ?? "",
    aiSummaryGeneratedAt: row.ai_summary_generated_at ?? null,
    observedNotes: row.observed_notes ?? "",
    category: row.category || "Other",
    family: row.family ?? null,
    familyLogoUrl: row.family_logo_url ?? null,
    imageUrl: row.image_url ?? null,
    resalePriceUsd: row.resale_price_usd ?? null,
    resaleTimeToSell: row.resale_time_to_sell ?? null,
    lookoutNotes: row.lookout_notes ?? "",
    keepThumbnail: !!row.keep_thumbnail,
    desiredPriceUsd: row.desired_price_usd ?? null,
    hardCapAtDesiredPrice: !!row.hard_cap_at_desired_price,
    prioritized: !!row.prioritized,
    ebayAvgSoldPriceUsd: row.ebay_avg_sold_price_usd ?? null,
    ebayAvgRunTimeDays: row.ebay_avg_run_time_days ?? null,
    ebayAvgShippingUsd: row.ebay_avg_shipping_usd ?? null,
    ebayCompsSampleSize: row.ebay_comps_sample_size ?? null,
    ebayCompsCheckedAt: row.ebay_comps_checked_at ?? null,
    ebayActiveMedianUsd: row.ebay_active_median_usd ?? null,
    ebayActiveSampleSize: row.ebay_active_sample_size ?? null,
    ebayEstimatedValueUsd: row.ebay_est_value_usd ?? null,
    ebayEstimateBasis: row.ebay_est_basis ?? null,
    ebayCompsIdentity: row.ebay_comps_identity === "exact" || row.ebay_comps_identity === "approximate" || row.ebay_comps_identity === "unresolved" ? row.ebay_comps_identity : null,
    myStore: parseMyStore(row.my_store_ref),
    parentProductId: row.parent_product_id ?? null,
    loading: !!row.loading,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function parseMyStore(raw: unknown): MyStoreReference | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const ref = JSON.parse(raw) as MyStoreReference;
    return ref && typeof ref.medianUsd === "number" ? ref : null;
  } catch {
    return null;
  }
}

function rowToProductImage(row: any): ProductImage {
  return {
    id: row.id,
    productId: row.product_id,
    imageData: row.image_data,
    sourceTitle: row.source_title ?? null,
    createdAt: row.created_at,
    kind: row.kind === "poor_condition" ? "poor_condition" : "normal",
  };
}

function parseUrlList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

function parseTerms(raw: unknown): WatchTerm[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed.map((t: any) => ({
      phrase: String(t.phrase ?? ""),
      matchKeywords: Array.isArray(t.matchKeywords) ? t.matchKeywords.map(String) : [],
      linkedProductId: t.linkedProductId ?? null,
    }));
  } catch {
    return null;
  }
}

function rowToWatch(row: any): Watch {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform === "ebay" ? "ebay" : "facebook",
    searchPhrase: row.search_phrase,
    matchKeywords: JSON.parse(row.match_keywords || "[]"),
    linkedProductId: row.linked_product_id ?? null,
    minPriceUsd: row.min_price_usd ?? null,
    maxPriceUsd: row.max_price_usd ?? null,
    minProfitUsd: row.min_profit_usd ?? null,
    minDiscountPercent: row.min_discount_percent ?? null,
    maxListingAgeMinutes: row.max_listing_age_minutes ?? null,
    minSellerRatingPercent: row.min_seller_rating_percent ?? null,
    ntfyTopic: row.ntfy_topic ?? null,
    terms: parseTerms(row.terms_json) ?? [
      { phrase: row.search_phrase, matchKeywords: JSON.parse(row.match_keywords || "[]"), linkedProductId: row.linked_product_id ?? null },
    ],
    checkIntervalMinutes: row.check_interval_minutes ?? 15,
    accountIds: parseUrlList(row.account_ids),
    searchLinks: [],
    locationMode: row.location_mode,
    selectedState: row.selected_state ?? null,
    selectedCityOrZip: row.selected_city_or_zip ?? null,
    searchRadiusMiles: row.search_radius_miles ?? null,
    resolvedLocationUrl: row.resolved_location_url ?? null,
    resolvedLocationLabel: row.resolved_location_label ?? null,
    resolvedLocationCheckedAt: row.resolved_location_checked_at ?? null,
    resolvedLocationUrls: parseUrlList(row.resolved_location_urls),
    enabled: !!row.enabled,
    listingsSeenCount: row.listings_seen_count,
    matchCount: row.match_count,
    lastCheckedAt: row.last_checked_at ?? null,
    lastActiveCheckAt: row.last_active_check_at ?? null,
    nextCheckAt: row.next_check_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWatchMatch(row: any): WatchMatch {
  return {
    id: row.wm_id,
    watchId: row.wm_watch_id,
    listingId: row.wm_listing_id,
    matchedAt: row.wm_matched_at,
    foundByAccountId: row.wm_found_by_account_id ?? null,
    foundByAccountLabel: row.wm_found_by_account_label ?? null,
    discoveryMode: row.wm_discovery_mode,
    priceAtMatch: row.wm_price_at_match ?? null,
    discountPercentAtMatch: row.wm_discount_percent_at_match ?? null,
    profitUsdAtMatch: row.wm_profit_usd_at_match ?? null,
    notified: !!row.wm_notified,
    notifiedAt: row.wm_notified_at ?? null,
  };
}
