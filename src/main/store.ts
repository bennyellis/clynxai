import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BlacklistedImage, BlacklistTerm, FeedbackExample, FeedbackVerdict, ListingRecord, ProductImage, ProductProfile, ScoredListing, SellerRiskResult } from "./types.js";

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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
    `);
    // Older DBs created before seller-risk columns existed.
    const cols = (this.db.prepare("PRAGMA table_info(listings)").all() as any[]).map((c) => c.name);
    const migrations: Array<[string, string]> = [
      ["seller_joined_year", "INTEGER"],
      ["seller_rating", "REAL"],
      ["seller_rating_count", "INTEGER"],
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
      ["seller_name", "TEXT"],
      ["description", "TEXT"],
    ];
    for (const [name, ddl] of migrations) {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${ddl}`);
    }

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
  }

  hasSeen(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM listings WHERE id = ?").get(id);
    return row !== undefined;
  }

  saveScored(scored: ScoredListing, sellerRisk?: SellerRiskResult): void {
    const { listing, extraction, referencePriceUsd, discountPercent, isDeal } = scored;
    const risk = sellerRisk ?? { passed: true, reasons: [] };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO listings
          (id, title, price, url, thumbnail_url, image_urls, matched_item, reference_price_usd, discount_percent,
           condition_impact, confidence, reasoning, extracted_attributes, shipping_mentioned,
           is_deal, deal_tier, estimated_value_range, notified, first_seen_at,
           seller_joined_year, seller_rating, seller_rating_count, seller_has_profile_photo,
           seller_risk_passed, seller_risk_reasons, location_text, listing_age, seller_name, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT notified FROM listings WHERE id = ?), 0),
           COALESCE((SELECT first_seen_at FROM listings WHERE id = ?), ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        listing.description ?? null
      );
  }

  markNotified(id: string): void {
    this.db.prepare("UPDATE listings SET notified = 1 WHERE id = ?").run(id);
  }

  deleteListing(id: string): void {
    this.db.prepare("DELETE FROM feedback WHERE listing_id = ?").run(id);
    this.db.prepare("DELETE FROM listings WHERE id = ?").run(id);
  }

  clearAllListings(): void {
    this.db.exec("DELETE FROM feedback; DELETE FROM listings;");
  }

  updatePhotoAnalysis(id: string, summary: string | null): void {
    this.db
      .prepare("UPDATE listings SET photo_analysis = ?, photo_analysis_checked_at = ? WHERE id = ?")
      .run(summary, Date.now(), id);
  }

  getById(id: string): ListingRecord | null {
    const row = this.db
      .prepare(
        `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note
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
    if (!record.matchedItem) return record;
    const product = this.findMatchingProduct(record.matchedItem);
    return {
      ...record,
      matchedProductAvgSoldPriceUsd: product?.ebayAvgSoldPriceUsd ?? null,
      matchedProductAvgRunTimeDays: product?.ebayAvgRunTimeDays ?? null,
    };
  }

  // --- Product database (Config-adjacent knowledge profiles) ------------

  addProductStub(id: string, name: string): void {
    this.db
      .prepare("INSERT INTO products (id, name, loading, created_at) VALUES (?, ?, 1, ?)")
      .run(id, name, Date.now());
  }

  // Per explicit instruction — the Library's own "+" button, for a product
  // the user already has their own photo/info for and doesn't want/need AI
  // research run on. Inserted already "finished" (loading = 0) rather than
  // going through addProductStub's loading=1 + a later updateProductProfile
  // call, since there's no research pass coming to ever clear it.
  createManualProduct(id: string, name: string, category: string, imageUrl: string | null): void {
    this.db
      .prepare("INSERT INTO products (id, name, category, image_url, keep_thumbnail, loading, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(id, name, category, imageUrl, imageUrl ? 1 : 0, Date.now());
  }

  updateProductProfile(
    id: string,
    data: { aiSummary: string; category: string; family: string | null; familyLogoUrl?: string | null; imageUrl: string | null }
  ): void {
    this.db
      .prepare(
        "UPDATE products SET ai_summary = ?, ai_summary_generated_at = ?, category = ?, family = ?, family_logo_url = ?, image_url = ?, loading = 0 WHERE id = ?"
      )
      .run(data.aiSummary, Date.now(), data.category, this.resolveFamilyName(data.family), data.familyLogoUrl ?? null, data.imageUrl, id);
  }

  // Per explicit instruction — separate from updateProductProfile above
  // (which always overwrites the AI-summary/category/family/image fields
  // as a full set) since eBay comps research runs as its OWN follow-up
  // step in index.ts's runProductLookup, on its own success/failure path —
  // a comps lookup failing shouldn't touch (or blank out) the summary/
  // image fields that already succeeded moments earlier, and vice versa.
  updateProductEbayComps(
    id: string,
    data: { avgSoldPriceUsd: number | null; avgRunTimeDays: number | null; avgShippingUsd: number | null; sampleSize: number }
  ): void {
    this.db
      .prepare(
        "UPDATE products SET ebay_avg_sold_price_usd = ?, ebay_avg_run_time_days = ?, ebay_avg_shipping_usd = ?, ebay_comps_sample_size = ?, ebay_comps_checked_at = ? WHERE id = ?"
      )
      .run(data.avgSoldPriceUsd, data.avgRunTimeDays, data.avgShippingUsd, data.sampleSize, Date.now(), id);
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
    this.db.prepare("UPDATE products SET loading = ? WHERE id = ?").run(loading ? 1 : 0, id);
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
    if (patch.name !== undefined && patch.name.trim()) {
      this.db.prepare("UPDATE products SET name = ? WHERE id = ?").run(patch.name.trim(), id);
    }
    if (patch.aiSummary !== undefined) {
      this.db.prepare("UPDATE products SET ai_summary = ? WHERE id = ?").run(patch.aiSummary, id);
    }
    if (patch.imageUrl !== undefined) {
      this.db.prepare("UPDATE products SET image_url = ? WHERE id = ?").run(patch.imageUrl, id);
    }
    if (patch.keepThumbnail !== undefined) {
      this.db.prepare("UPDATE products SET keep_thumbnail = ? WHERE id = ?").run(patch.keepThumbnail ? 1 : 0, id);
    }
    if (patch.resalePriceUsd !== undefined) {
      this.db.prepare("UPDATE products SET resale_price_usd = ? WHERE id = ?").run(patch.resalePriceUsd, id);
    }
    if (patch.resaleTimeToSell !== undefined) {
      const trimmed = patch.resaleTimeToSell?.trim() || null;
      this.db.prepare("UPDATE products SET resale_time_to_sell = ? WHERE id = ?").run(trimmed, id);
    }
    if (patch.desiredPriceUsd !== undefined) {
      this.db.prepare("UPDATE products SET desired_price_usd = ? WHERE id = ?").run(patch.desiredPriceUsd, id);
    }
    if (patch.hardCapAtDesiredPrice !== undefined) {
      this.db.prepare("UPDATE products SET hard_cap_at_desired_price = ? WHERE id = ?").run(patch.hardCapAtDesiredPrice ? 1 : 0, id);
    }
    if (patch.prioritized !== undefined) {
      this.db.prepare("UPDATE products SET prioritized = ? WHERE id = ?").run(patch.prioritized ? 1 : 0, id);
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
    this.db.prepare("UPDATE products SET lookout_notes = ? WHERE id = ?").run(next, id);
    return this.getProductById(id);
  }

  listProducts(): ProductProfile[] {
    const rows = this.db.prepare("SELECT * FROM products ORDER BY created_at DESC").all() as any[];
    return rows.map(rowToProduct);
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
    return this.listProducts().find((p) => isSimilarProductName(name, p.name)) ?? null;
  }

  deleteProduct(id: string): void {
    this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM product_images WHERE product_id = ?").run(id);
  }

  // Per explicit instruction — the Database's own "Clear all" button,
  // same shape as Feed's clearAllListings. Only the products themselves
  // and their reference-photo galleries; the Blacklist and Blacklisted
  // Images sections are separate data and untouched by this, same as
  // Feed's clear-all never touches the Blacklist either.
  clearAllProducts(): void {
    this.db.exec("DELETE FROM product_images; DELETE FROM products;");
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
  addProductImage(productId: string, imageData: string, sourceTitle: string | null): ProductImage {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, productId, imageData, sourceTitle, Date.now());
    const excess = this.db
      .prepare("SELECT id FROM product_images WHERE product_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(productId, Store.MAX_IMAGES_PER_PRODUCT) as Array<{ id: string }>;
    for (const row of excess) {
      this.db.prepare("DELETE FROM product_images WHERE id = ?").run(row.id);
    }
    return { id, productId, imageData, sourceTitle, createdAt: Date.now() };
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
      result.push({ product, images: this.listProductImages(row.product_id) });
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
      const images = this.listProductImages(row.id);
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

    const sameName = match.name.toLowerCase() === trimmedName.toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    const entry = sameName ? `[${date}] ${trimmedNote}` : `[${date}] (also seen listed as "${trimmedName}") ${trimmedNote}`;
    const prior = match.observedNotes ? match.observedNotes.split("\n---\n") : [];
    const next = [...prior, entry].slice(-15).join("\n---\n");
    this.db.prepare("UPDATE products SET observed_notes = ? WHERE id = ?").run(next, match.id);
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
      this.addBlacklistedImage(image.imageData, image.sourceTitle, null, `Blacklisted alongside the term "${normalized}"`);
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
    }));
  }

  addBlacklistedImage(imageData: string, sourceTitle: string | null, category: string | null, reason: string | null): BlacklistedImage {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO blacklisted_images (id, image_data, source_title, category, reason, confirmed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(id, imageData, sourceTitle, category, reason, createdAt);
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
    return { id, imageData, sourceTitle, category, reason, confirmed: false, createdAt };
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
    this.db
      .prepare(
        `INSERT INTO feedback (listing_id, verdict, note, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, created_at = excluded.created_at`
      )
      .run(listingId, verdict, note, Date.now());
  }

  clearFeedback(listingId: string): void {
    this.db.prepare("DELETE FROM feedback WHERE listing_id = ?").run(listingId);
  }

  listRecent(limit = 200, offset = 0): ListingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, f.verdict as feedback_verdict, f.note as feedback_note
         FROM listings l LEFT JOIN feedback f ON f.listing_id = l.id
         ORDER BY l.first_seen_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as any[];
    return rows.map((row) => this.enrichWithMatchedProductPricing(rowToRecord(row)));
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

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: any): ListingRecord {
  return {
    id: row.id,
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
    sellerHasProfilePhoto: row.seller_has_profile_photo === null ? null : !!row.seller_has_profile_photo,
    sellerRiskPassed: row.seller_risk_passed === undefined ? true : !!row.seller_risk_passed,
    sellerRiskReasons: row.seller_risk_reasons ? JSON.parse(row.seller_risk_reasons) : [],
    photoAnalysis: row.photo_analysis ?? null,
    photoAnalysisCheckedAt: row.photo_analysis_checked_at ?? null,
    // Filled in by the Store methods below (enrichWithMatchedProductPricing)
    // — rowToRecord itself has no access to the products table.
    matchedProductAvgSoldPriceUsd: null,
    matchedProductAvgRunTimeDays: null,
  };
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

// True if two product names likely refer to the same product FAMILY despite
// different phrasing or variant wording (e.g. "PS5 Slim" vs "PS5 Slim
// Console", or "Nintendo Switch" vs "Nintendo Switch OLED") — deterministic
// word-overlap, not an AI call, since this runs on every listing the
// scanner evaluates and needs to be instant and free, matching the rest of
// the app's non-AI matching (see scrapeEngine's matchSearchItem).
//
// Per explicit instruction, a shorter name being fully contained in a
// longer one (a "base" name vs that same line's specific variant) counts as
// a match even when the extra word names a real variant — Nintendo Switch
// OLED is a variant of Nintendo Switch, iPhone 13 Pro a variant of iPhone
// 13, and the goal is ONE Database entry per product family with variant
// detail living inside its writeup, not a separate near-duplicate entry
// per variant. This used to hard-block merges like that via a fixed list
// of "distinguishing" words (oled/pro/max/slim/...), which was overcorrecting
// for genuinely different sibling products (Xbox Series X vs Series S,
// Steam Deck OLED vs LCD) — but those are still correctly kept apart below,
// since neither name's tokens are a subset of the other's (each adds its
// OWN distinct word), which was never about the blocked-word list to begin
// with. Storage/capacity extras (128GB, 1TB, ...) still block a merge,
// since those track real, consistent resale-value differences within a
// family, not just a variant name. Minimum of 2 real words after stripping
// filler avoids a single shared generic word (e.g. "controller") matching
// too broadly. Known gap: brand+model fusions like "PS5" vs "PlayStation 5"
// tokenize differently and won't match — solving that generally would need
// a per-brand alias table, which isn't worth the maintenance burden here.
function isSimilarProductName(a: string, b: string): boolean {
  const tokensA = productNameTokens(a);
  const tokensB = productNameTokens(b);
  if (!tokensA.size || !tokensB.size) return false;

  const [smaller, larger] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  if (smaller.size < 2) return false;
  for (const t of smaller) if (!larger.has(t)) return false;

  const extra = [...larger].filter((t) => !smaller.has(t));
  return !extra.some((t) => /^\d+(gb|tb|mb)$/i.test(t));
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
    loading: !!row.loading,
    createdAt: row.created_at,
  };
}

function rowToProductImage(row: any): ProductImage {
  return {
    id: row.id,
    productId: row.product_id,
    imageData: row.image_data,
    sourceTitle: row.source_title ?? null,
    createdAt: row.created_at,
  };
}
