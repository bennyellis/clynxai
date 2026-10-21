import { namingFacts, resolveName } from "./namingEngine.js";
import { REQUALIFY_CODES, type SavedListingState } from "./relisting.js";
import { countLifecycle, type LifecycleCounts } from "./listingLifecycle.js";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { colorsConflict, colorsIn, isColorWord, sameColors } from "./colors.js";
import { compMatchesSpecs, hasSingleModelLetter, modelLettersConflict } from "./compFilter.js";
import { extractVariantAttributes } from "./variantIdentity.js";
import { listingContradictsEntry } from "./compIdentity.js";
import type { VariantVerdict } from "./variantEvidence.js";
import type { ProductSignals } from "./dealSummary.js";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { addonKey, type Addon, type AddonRole, type AddonStatus } from "./addons.js";
import { nameKey } from "./modelFacts.js";
import { planCleanup, type CleanupGroup, type CleanupPlan } from "./duplicateCleanup.js";
import { addonEntryKey, candidateKey, type Candidate, type CandidateStatus } from "./variantDiscovery.js";

export interface StoredCandidate {
  parentId: string;
  kind: "variant" | "addon";
  key: string;
  name: string;
  sources: Candidate["sources"];
  evidence: string[];
  support: "confirmed" | "reported" | null;
  status: CandidateStatus;
  note: string | null;
  entryId: string | null;
  attempts: number;
  nextTryAt: number | null;
  firstSeenAt: number;
  lastCheckedAt: number | null;
}
import { timedSync, recordEvent } from "./metrics.js";
import type { BlacklistedImage, BlacklistTerm, FeedbackExample, FeedbackVerdict, FlawFeedbackExample, GateFactsSnapshot, GateReasonRecord, ListingRecord, MyStoreReference, PhotoFlaw, ProductImage, ProductProfile, ScoredListing, SellerRiskResult, Watch, WatchMatch, WatchPlatform, WatchSearchLink, WatchTerm } from "./types.js";
import { REFERENCE_STATUSES } from "./types.js";
import { resolveProduct, type ResolveResult } from "./productResolver.js";
import { judgeCandidateByText, titleFromLabel } from "./photoIdentity.js";
import { brokenVariantName, isBrokenVariantName } from "./brokenVariant.js";
import { assessListingAge } from "./listingAge.js";
import { codesMissingFrom } from "./identity/codes.js";
import { assessCodes, CodeIndex, NO_CODES, type CodeAssessment, type EvidenceDoc } from "./identity/credibility.js";
import { IdentityFoundation } from "./identity/foundationStore.js";
import { IdentitySafeguard, type SafeguardMode } from "./identity/safeguardRuntime.js";
import type { ReviewInput } from "./identity/reviewFindings.js";
import type { ProductKnowledge } from "./knowledgeRegistry.js";
import type { FolderMetaRecord, ThumbSource } from "./folderKeys.js";
import { KnowledgeGraph } from "./knowledgeGraph.js";
import { RESET_KEEPS_TABLES } from "./resetText.js";
import { applyPlan, undoBatch, type Outcome, type PlanItem } from "./identity/correctionJournal.js";

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

// A reference photo's source title as the listing title it came from: photos found on eBay are saved as "eBay listing: <title>"; the label is not part of the title.
export function sourceTitleText(title: string): string {
  return title.replace(/^\s*ebay listing:\s*/i, "").trim();
}

export class Store {
  private db: DatabaseSync;
  // The Database identity foundation (identity/foundationStore.ts): extra tables of candidate relations and evidence, created only when switched on in the
  // config. Null when off: no table exists and nothing reads or writes any.
  identity: IdentityFoundation | null = null;
  // The veto-only identity safeguard (identity/safeguardRuntime.ts): "off" unless config.json says otherwise, and then it only ever REMOVES a match the existing matcher
  // made (nothing is put in its place). Every Store path that turns a matched name into a product for filing or valuation asks it first.
  readonly safeguard: IdentitySafeguard = new IdentitySafeguard({
    entries: () => this.db.prepare("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>,
    evidenceDocs: () => this.extraEvidenceDocs(),
  });
  setIdentitySafeguard(mode: SafeguardMode, log?: ((record: Record<string, unknown>) => void) | null): void {
    this.safeguard.setMode(mode, log);
  }
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

  // Beta 13: additive columns and tables only (nothing is dropped or rewritten here). Older builds ignore them. Every existing photo starts as status 'legacy': still used
  // as a reference, until the one-time suspect pass (markSuspectImages) proves its own title contradicts the entry it is filed under.
  // Add-ons (addons.ts): additive tables only, nothing existing is touched. A base product's add-ons, and which add-ons each scanned listing was seen with.
  private migrateAddons(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_addons (
        id TEXT PRIMARY KEY,
        base_product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        addon_product_id TEXT,
        role TEXT NOT NULL DEFAULT 'bonus',
        status TEXT NOT NULL DEFAULT 'suggested',
        source TEXT NOT NULL DEFAULT 'user_added',
        compatibility TEXT NOT NULL DEFAULT 'unknown',
        enabled INTEGER NOT NULL DEFAULT 0,
        standalone_value_usd REAL,
        times_seen INTEGER NOT NULL DEFAULT 0,
        example_listing_ids TEXT NOT NULL DEFAULT '[]',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE (base_product_id, name_key)
      );
      CREATE INDEX IF NOT EXISTS idx_product_addons_base ON product_addons (base_product_id);
      CREATE TABLE IF NOT EXISTS listing_addons (
        listing_id TEXT NOT NULL,
        base_product_id TEXT NOT NULL,
        addon_id TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT 'title',
        confidence TEXT NOT NULL DEFAULT 'low',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (listing_id, addon_id)
      );
      -- Versions and add-ons found while researching a product, with their status: queued ("found, not yet checked"), added (a Database entry), suggestion (one source only), rejected, skipped.
      CREATE TABLE IF NOT EXISTS variant_candidates (
        parent_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'variant',
        cand_key TEXT NOT NULL,
        name TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '[]',
        support TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        note TEXT,
        entry_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_checked_at INTEGER,
        next_try_at INTEGER,
        PRIMARY KEY (parent_id, kind, cand_key)
      );
      CREATE INDEX IF NOT EXISTS idx_variant_candidates_status ON variant_candidates (status, kind);
      -- Other names for a product (old names, official names, how sellers type it), so a rename or a merge never breaks matching or sync (naming engine, Phase 1).
      CREATE TABLE IF NOT EXISTS product_name_aliases (
        product_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'rename',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (product_id, alias_key)
      );
      CREATE INDEX IF NOT EXISTS idx_product_name_aliases_key ON product_name_aliases (alias_key);
      -- Everything a duplicate clean-up merge moved or removed, so it can be undone exactly (Phase 2.4). One row per entry folded in; a batch is one run.
      CREATE TABLE IF NOT EXISTS merge_undo (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kept_id TEXT NOT NULL,
        folded_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        undone_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_merge_undo_batch ON merge_undo (batch_id);
      -- The owner's edits to the model facts (extra aliases, corrected attributes) on top of the built-in ones.
      CREATE TABLE IF NOT EXISTS model_fact_overrides (
        canonical_key TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        add_aliases TEXT NOT NULL DEFAULT '[]',
        attrs TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
    `);
    // a table made by an earlier development build lacks the back-off column
    const cols = (this.db.prepare("PRAGMA table_info(variant_candidates)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("next_try_at")) this.db.exec("ALTER TABLE variant_candidates ADD COLUMN next_try_at INTEGER");
  }

  private migrateBeta13(): void {
    const imageCols = (this.db.prepare("PRAGMA table_info(product_images)").all() as any[]).map((c) => c.name);
    for (const [column, ddl] of [
      ["status", "TEXT NOT NULL DEFAULT 'legacy'"],
      ["source_kind", "TEXT"],
      ["source_url", "TEXT"],
      ["verdict_json", "TEXT"],
      ["content_hash", "TEXT"],
      ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ["is_primary", "INTEGER NOT NULL DEFAULT 0"],
      ["origin_product_id", "TEXT"],
      ["deleted_at", "INTEGER"],
    ] as const) {
      if (!imageCols.includes(column)) this.db.exec(`ALTER TABLE product_images ADD COLUMN ${column} ${ddl}`);
    }
    const productCols = (this.db.prepare("PRAGMA table_info(products)").all() as any[]).map((c) => c.name);
    for (const [column, ddl] of [
      ["folder_id", "TEXT"],
      ["name_locked", "INTEGER NOT NULL DEFAULT 0"],
      ["deleted_at", "INTEGER"],
      ["identity_json", "TEXT"],
      ["identity_status", "TEXT"],
      ["suggested_family", "TEXT"],
      ["thumbnail_image_id", "TEXT"],
      ["placement_locked", "INTEGER NOT NULL DEFAULT 0"],
      // research that could not run is a state, never description text: failed / unsourced, a plain-words note, how many tries, and when the next one is due
      ["research_state", "TEXT"],
      ["research_note", "TEXT"],
      ["research_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["research_retry_at", "INTEGER"],
    ] as const) {
      if (!productCols.includes(column)) this.db.exec(`ALTER TABLE products ADD COLUMN ${column} ${ddl}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_folders (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES library_folders(id),
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_folders_sibling ON library_folders(COALESCE(parent_id, ''), name_key) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS library_ops (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        args_json TEXT NOT NULL,
        inverse_json TEXT,
        batch_id TEXT,
        undone_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_review_items_state ON review_items(state, kind);
      CREATE TABLE IF NOT EXISTS listing_condition (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        defect_class TEXT NOT NULL,
        area TEXT,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        photo_ref INTEGER,
        quote TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listing_condition_listing ON listing_condition(listing_id);
      CREATE INDEX IF NOT EXISTS idx_product_images_status ON product_images(product_id, status);
      CREATE TABLE IF NOT EXISTS folder_meta (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'auto',
        display_name TEXT,
        thumb_data TEXT,
        thumb_source TEXT,
        thumb_meta TEXT,
        thumb_locked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_counters (
        day TEXT NOT NULL,
        key TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, key)
      );
      CREATE TABLE IF NOT EXISTS product_knowledge (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        researched_at INTEGER NOT NULL
      );
    `);
  }

  /** Clynx's product knowledge (what exists in the world, with sources). Separate from the Library: nothing researched here becomes a product. */
  private kg: KnowledgeGraph | null = null;
  knowledgeGraph(): KnowledgeGraph {
    this.kg ??= new KnowledgeGraph(this.db);
    return this.kg;
  }

  // --- Settings of the AUTOMATIC folders (rename, thumbnail with provenance) and a small ledger of what research and generation cost.
  getFolderMeta(id: string): FolderMetaRecord | null {
    const r = this.db.prepare("SELECT * FROM folder_meta WHERE id = ?").get(id) as any;
    return r ? rowToFolderMeta(r) : null;
  }
  listFolderMeta(): FolderMetaRecord[] {
    return (this.db.prepare("SELECT * FROM folder_meta").all() as any[]).map(rowToFolderMeta);
  }
  /** Sets the given fields of a folder's settings (creating the row on first use). A field left out is kept; null clears it. */
  setFolderMeta(id: string, patch: { displayName?: string | null; thumbData?: string | null; thumbSource?: ThumbSource | null; thumbMeta?: Record<string, unknown> | null; thumbLocked?: boolean }): void {
    const now = Date.now();
    const cur = this.getFolderMeta(id);
    const next = {
      displayName: patch.displayName !== undefined ? patch.displayName : cur?.displayName ?? null,
      thumbData: patch.thumbData !== undefined ? patch.thumbData : cur?.thumbData ?? null,
      thumbSource: patch.thumbSource !== undefined ? patch.thumbSource : cur?.thumbSource ?? null,
      thumbMeta: patch.thumbMeta !== undefined ? patch.thumbMeta : cur?.thumbMeta ?? null,
      thumbLocked: patch.thumbLocked !== undefined ? patch.thumbLocked : cur?.thumbLocked ?? false,
    };
    this.db
      .prepare(
        "INSERT INTO folder_meta (id, kind, display_name, thumb_data, thumb_source, thumb_meta, thumb_locked, updated_at) VALUES (?, 'auto', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, thumb_data = excluded.thumb_data, thumb_source = excluded.thumb_source, thumb_meta = excluded.thumb_meta, thumb_locked = excluded.thumb_locked, updated_at = excluded.updated_at"
      )
      .run(id, next.displayName, next.thumbData, next.thumbSource, next.thumbMeta ? JSON.stringify(next.thumbMeta) : null, next.thumbLocked ? 1 : 0, now);
  }
  /** The automatic folders that exist right now: every (category, family path) with live, unplaced products, and how many products sit directly on it. */
  listAutoFolderPlacements(): Array<{ category: string; family: string | null; count: number }> {
    return (this.db.prepare("SELECT category, family, COUNT(*) AS n FROM products WHERE deleted_at IS NULL AND folder_id IS NULL GROUP BY category, family").all() as any[]).map((r) => ({ category: r.category || "Other", family: r.family ?? null, count: Number(r.n) }));
  }
  addUsage(key: string, count = 1, usd = 0): void {
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare("INSERT INTO usage_counters (day, key, count, usd) VALUES (?, ?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET count = count + excluded.count, usd = usd + excluded.usd").run(day, key, count, usd);
  }
  usageToday(key: string): { count: number; usd: number } {
    const r = this.db.prepare("SELECT count, usd FROM usage_counters WHERE day = ? AND key = ?").get(new Date().toISOString().slice(0, 10), key) as { count: number; usd: number } | undefined;
    return { count: Number(r?.count ?? 0), usd: Number(r?.usd ?? 0) };
  }
  usageTotal(key: string): { count: number; usd: number } {
    const r = this.db.prepare("SELECT COALESCE(SUM(count),0) AS count, COALESCE(SUM(usd),0) AS usd FROM usage_counters WHERE key = ?").get(key) as { count: number; usd: number };
    return { count: Number(r.count), usd: Number(r.usd) };
  }

  /** Every id the cloud sync knows about, so a reset can tell Clynx Cloud to forget them too (otherwise the next sync would bring them straight back). */
  listIdsForCloudReset(): { products: string[]; watches: string[]; feedback: string[] } {
    const ids = (sql: string) => (this.db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
    return { products: ids("SELECT id FROM products"), watches: ids("SELECT id FROM watches"), feedback: ids("SELECT listing_id AS id FROM feedback") };
  }

  /**
   * Empties every table of the user's data (Library, knowledge, listings, corrections, watches, caches) in one transaction and leaves the structure. Only the record of deletes still to
   * be sent to Clynx Cloud and the schema markers are kept. The caller makes a backup first and restarts the app afterwards.
   */
  resetAllData(): { tables: number } {
    const keep = new Set<string>(RESET_KEEPS_TABLES);
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name).filter((n) => !keep.has(n));
    // children go before parents otherwise; with foreign keys off the order does not matter, and they are switched back on whatever happens
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.transaction(() => {
        for (const t of tables) this.db.exec(`DELETE FROM "${t.replace(/"/g, '""')}"`);
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    this.safeguard.invalidate();
    this.invalidateFolders();
    this.ebayValueCache = null;
    this.identity?.forgetAllProducts();
    try {
      this.db.exec("VACUUM");
    } catch {
      /* the space is reclaimed later */
    }
    return { tables: tables.length };
  }

  /** What Clynx learned from the web about a product line (storage options, look-alike models). Additive; see productKnowledge.ts. */
  getKnowledge(key: string): ProductKnowledge | null {
    const row = this.db.prepare("SELECT json FROM product_knowledge WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? ((safeJson(row.json) as ProductKnowledge | null) ?? null) : null;
  }
  saveKnowledge(k: ProductKnowledge): void {
    this.db.prepare("INSERT INTO product_knowledge (key, json, researched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, researched_at = excluded.researched_at").run(k.key, JSON.stringify(k), k.researchedAt);
  }
  listKnowledge(): ProductKnowledge[] {
    return (this.db.prepare("SELECT json FROM product_knowledge ORDER BY researched_at DESC").all() as Array<{ json: string }>).map((r) => safeJson(r.json) as ProductKnowledge | null).filter((k): k is ProductKnowledge => !!k);
  }

  // --- "My folders": the person's own tree (library_folders). A product with a folder_id is shown there instead of in its auto-organized place.
  private folderCache: Map<string, { name: string; parentId: string | null }> | null = null;
  invalidateFolders(): void {
    this.folderCache = null;
  }
  listFolders(): Array<{ id: string; parentId: string | null; name: string; position: number; kind: string }> {
    return (this.db.prepare("SELECT id, parent_id, name, position, kind FROM library_folders WHERE deleted_at IS NULL ORDER BY position, name_key").all() as any[]).map((r) => ({ id: r.id, parentId: r.parent_id ?? null, name: r.name, position: r.position, kind: r.kind }));
  }
  /** "Parent > Child" for a live folder, or null when it does not exist (deleted) - the product then falls back to its auto-organized place. */
  folderPath(id: string): string | null {
    if (!this.folderCache) {
      this.folderCache = new Map(this.listFolders().map((f) => [f.id, { name: f.name, parentId: f.parentId }]));
    }
    const parts: string[] = [];
    let cur: string | null = id;
    for (let depth = 0; cur && depth < 12; depth++) {
      const f = this.folderCache.get(cur);
      if (!f) return null;
      parts.unshift(f.name);
      cur = f.parentId;
    }
    return parts.length ? parts.join(" > ") : null;
  }
  private withFolder(p: ProductProfile): ProductProfile {
    if (p.folderId) p.folderPath = this.folderPath(p.folderId);
    return p;
  }

  /** Keeps the structured condition assessment with the listing (what was found, from where, what it would change). */
  saveConditionAssessment(listingId: string, assessment: unknown): void {
    this.db.prepare("UPDATE listings SET condition_json = ? WHERE id = ?").run(JSON.stringify(assessment), listingId);
  }

  /** The open database, for libraryOps.ts (its operations are SQL over several tables inside one transaction). Nothing else should use it. */
  get database(): DatabaseSync {
    return this.db;
  }

  /** Runs `fn` as one write transaction (BEGIN IMMEDIATE ... COMMIT; ROLLBACK when it throws). Not re-entrant: callers inside a transaction call the plain methods. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
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
      -- Beta 12: how often a seen listing has been looked at again (bounded re-evaluation, see relisting.ts). A side table so saveScored's INSERT OR REPLACE never resets it.
      CREATE TABLE IF NOT EXISTS listing_reeval (
        listing_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER
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
      // Beta 13: the structured condition assessment (conditionEvidence / conditionAdjust) as JSON; null for listings assessed before it existed.
      ["condition_json", "TEXT"],
      // Database discovery: where this listing stands (not researched / not enough evidence / rejected / confirmed unprofitable /
      // researched), a short code for why, and the reason in words. See research.ts.
      ["research_status", "TEXT"],
      ["research_code", "TEXT"],
      ["research_reason", "TEXT"],
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
      // What the evidence check concluded about this product being a real variant (see variantEvidence.ts), and the variant claims checked
      // against it that were NOT recorded as products. Local-only, like the columns above.
      ["variant_status", "TEXT"],
      ["variant_evidence", "TEXT"],
      ["variant_claims", "TEXT"],
      // How the last eBay / WatchCount results were judged against the product's identity (compIdentity.ts): counts and reasons. Local-only.
      ["comps_validation", "TEXT"],
    ]) {
      if (!productCols.includes(column)) this.db.exec(`ALTER TABLE products ADD COLUMN ${column} ${type}`);
    }
    this.migrateBeta13();
    this.migrateAddons();
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
    // Database discovery: a listing saved as "waiting for a look at its photos" belongs to a research job that died with the app (the queue
    // lives in memory). Say so on the next start instead of leaving it waiting for ever. Only that one code is touched, nothing else.
    this.db.exec(
      `UPDATE listings SET research_status = 'insufficient_evidence', research_code = 'INTERRUPTED',
         research_reason = 'Clynx was closed before it got to look at this listing''s photos. This is missing evidence, not a verdict on the listing.'
       WHERE research_code = 'PHOTOS_QUEUED'`
    );
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
    let matchedProduct = extraction.matchedItem ? this.findMatchingProduct(extraction.matchedItem) : null;
    // Veto-only identity safeguard: a match the evidence says is a materially different product is not filed (the listing is still saved and shown).
    if (matchedProduct && this.safeguard.vetoes({ title: listing.title, matchedName: extraction.matchedItem, entry: matchedProduct, seller: listing.seller?.name ?? null, site: "filing" })) matchedProduct = null;
    const productId = matchedProduct?.id ?? null;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO listings
          (id, title, price, url, thumbnail_url, image_urls, matched_item, reference_price_usd, discount_percent,
           condition_impact, confidence, reasoning, extracted_attributes, shipping_mentioned,
           is_deal, deal_tier, estimated_value_range, notified, first_seen_at,
           seller_joined_year, seller_rating, seller_rating_count, seller_has_profile_photo,
           seller_risk_passed, seller_risk_reasons, location_text, listing_age, seller_name, description, product_id, source, just_listed,
           ebay_seller_feedback_percent, ebay_shipping_usd,
           deal_status, gate_confidence, gate_stars, gate_headline, gate_reasons, required_discount_percent, target_price_usd, listing_age_hours, gate_facts,
           photo_analysis, photo_analysis_checked_at, photo_flaws, research_status, research_code, research_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT notified FROM listings WHERE id = ?), 0),
           COALESCE((SELECT first_seen_at FROM listings WHERE id = ?), ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT photo_analysis FROM listings WHERE id = ?),
           (SELECT photo_analysis_checked_at FROM listings WHERE id = ?),
           (SELECT photo_flaws FROM listings WHERE id = ?),
           COALESCE(?, (SELECT research_status FROM listings WHERE id = ?)),
           COALESCE(?, (SELECT research_code FROM listings WHERE id = ?)),
           COALESCE(?, (SELECT research_reason FROM listings WHERE id = ?)))`
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
        scored.gate?.facts ? JSON.stringify(scored.gate.facts) : null,
        // What the photos already told us survives the later re-saves of the same listing (green flag, mismatch, final verdict).
        listing.id,
        listing.id,
        listing.id,
        // Why the listing was or was not looked into any further (research.ts): a re-save that does not say keeps the last word.
        scored.research?.status ?? null,
        listing.id,
        scored.research?.code ?? null,
        listing.id,
        scored.research?.reason ?? null,
        listing.id
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

  // Database discovery: where a listing stands and why (see ResearchStatus). Touches nothing else about the listing.
  setResearch(id: string, d: { status: string; code: string; reason: string }): void {
    this.db.prepare("UPDATE listings SET research_status = ?, research_code = ?, research_reason = ? WHERE id = ?").run(d.status, d.code, d.reason, id);
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
    type Found = { id: string; name: string; sold: number | null; run: number | null };
    const byName = new Map<string, Found | null>();
    let candidates: Found[] | null = null;
    // The estimate (sold comps, nudged by asking prices when sold data is thin) when there is one, else the plain sold average.
    const columns = `id, name, ${EBAY_VALUE_SQL} AS sold, ebay_avg_run_time_days AS run`;
    const lookup = (name: string): Found | null => {
      if (byName.has(name)) return byName.get(name)!;
      let found: Found | null = null;
      const exact = this.db.prepare(`SELECT ${columns} FROM products WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL`).get(name) as any;
      if (exact) found = { id: exact.id, name: exact.name, sold: exact.sold ?? null, run: exact.run ?? null };
      else {
        candidates ??= this.db.prepare(`SELECT ${columns} FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC`).all() as any[];
        const similar = candidates.find((p) => isSimilarProductName(name, p.name));
        if (similar) found = { id: similar.id, name: similar.name, sold: similar.sold ?? null, run: similar.run ?? null };
      }
      byName.set(name, found);
      return found;
    };
    return records.map((record) => {
      if (!record.matchedItem) return record;
      // A listing titled "Xbox Series S" that was matched to the "Xbox Series X" entry must not show the Series X's price.
      if (modelLettersConflict(record.matchedItem, record.title)) return { ...record, matchedProductAvgSoldPriceUsd: null, matchedProductAvgRunTimeDays: null };
      // ...and no other contradiction of the matched entry's identity (iPhone 14 listed under an iPhone 16 entry) shows that entry's price either.
      if (listingContradictsEntry(record.matchedItem, record.title)) return { ...record, matchedProductAvgSoldPriceUsd: null, matchedProductAvgRunTimeDays: null };
      const product = lookup(record.matchedItem);
      // Veto-only identity safeguard: a vetoed match's price is not shown as this listing's market value.
      if (product && this.safeguard.vetoes({ title: record.title, matchedName: record.matchedItem, entry: { id: product.id, name: product.name }, seller: record.sellerName, site: "display" })) return { ...record, matchedProductAvgSoldPriceUsd: null, matchedProductAvgRunTimeDays: null };
      return { ...record, matchedProductAvgSoldPriceUsd: product?.sold ?? null, matchedProductAvgRunTimeDays: product?.run ?? null };
    });
  }

  // What eBay says a product is worth (the estimate, else the sold average), looked up by a product's name for the
  // deal scoring that runs on every listing. Same exact-then-fuzzy rule as findMatchingProduct, but over just a name
  // and a number (not whole product rows with their photos), kept for a few seconds between lookups.
  private ebayValueCache: { at: number; rows: Array<{ id: string; name: string; value: number | null }> } | null = null;
  getEbayValueForProductName(name: string, title?: string): number | null {
    const now = Date.now();
    if (!this.ebayValueCache || now - this.ebayValueCache.at > 10_000) {
      const rows = this.db
        .prepare(`SELECT id, name, ${EBAY_VALUE_SQL} AS value FROM products WHERE deleted_at IS NULL`)
        .all() as Array<{ id: string; name: string; value: number | null }>;
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
    // A listing whose title CONTRADICTS the entry's identity (another model number, tier, capacity, edition) is never valued from that entry: no value
    // is better than another model's value. (Missing information is not a contradiction.)
    if (title && found && listingContradictsEntry(found.name, title)) return null;
    // Veto-only identity safeguard: a value taken from an entry the evidence says is a different product is not used (no value is better than a wrong one).
    if (title && found && this.safeguard.vetoes({ title, matchedName: name, entry: { id: found.id, name: found.name }, site: "valuation" })) return null;
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
  /** What the Database review reads: names, filing, stored values, titles, and the candidate aliases and relations when the identity foundation is on. Reads only; no photo bytes. */
  readReviewInput(): ReviewInput {
    const products = this.db
      .prepare("SELECT id, name, category, ebay_avg_sold_price_usd AS sold, ebay_comps_sample_size AS soldN, ebay_est_value_usd AS est, ebay_est_basis AS basis FROM products")
      .all() as unknown as ReviewInput["products"];
    const listings = this.db.prepare("SELECT id, title, product_id AS productId, seller_name AS seller FROM listings").all() as unknown as ReviewInput["listings"];
    const photos = (this.db.prepare("SELECT id, product_id AS productId, source_title AS sourceTitle FROM product_images").all() as unknown as ReviewInput["photos"]).map((p) => ({ ...p, sourceTitle: p.sourceTitle ? sourceTitleText(p.sourceTitle) : p.sourceTitle }));
    let relations: ReviewInput["relations"] = [];
    let aliases: ReviewInput["aliases"] = [];
    if (this.identity) {
      try {
        relations = this.db.prepare("SELECT from_product_id AS 'from', to_product_id AS 'to', relation, status FROM product_relations").all() as unknown as ReviewInput["relations"];
        aliases = this.db.prepare("SELECT alias_text AS text, product_id AS productId, status FROM product_aliases").all() as unknown as ReviewInput["aliases"];
      } catch {
        /* the identity tables are not there yet */
      }
    }
    return { products, listings, photos, relations, aliases };
  }

  // --- Database review corrections (identityReview.ts). One approved suggestion at a time; the journal records the exact before-values so it can be undone.
  applyCorrection(batchId: string, item: PlanItem): Outcome {
    try {
      return applyPlan(this.db, batchId, [item], new Set([item.id]))[0] ?? { id: item.id, status: "skipped-no-change" };
    } finally {
      this.afterCorrection();
    }
  }
  undoCorrection(batchId: string, proposalId: string): Outcome[] {
    try {
      return undoBatch(this.db, batchId, new Set([proposalId]));
    } finally {
      this.afterCorrection();
    }
  }
  /** A consistent copy of the whole Database in one file (SQLite VACUUM INTO). Refuses to overwrite an existing file. */
  backupDatabase(file: string): void {
    if (existsSync(file)) throw new Error("backup file already exists");
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }
  /** Same as backupDatabase, but with SQLite's online-backup API: copied in small steps, yielding to the app between them, so a big Database never freezes the window. */
  async backupDatabaseAsync(file: string): Promise<void> {
    if (existsSync(file)) throw new Error("backup file already exists");
    await sqliteBackup(this.db, file, { rate: 200 });
  }
  // A correction can change which entry a listing is filed under and what a value is: forget everything derived from the old state.
  private afterCorrection(): void {
    this.safeguard.invalidate();
    this.ebayValueCache = null;
    this.codeIndexCache = null;
  }

  // Listing titles and reference-photo titles as evidence documents (shared by the code index and the identity safeguard).
  private extraEvidenceDocs(): EvidenceDoc[] {
    const docs: EvidenceDoc[] = [];
    for (const l of this.db.prepare("SELECT title, seller_name FROM listings").all() as Array<{ title: string; seller_name: string | null }>) {
      docs.push({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" });
    }
    for (const i of this.db.prepare("SELECT source_title FROM product_images WHERE source_title IS NOT NULL").all() as Array<{ source_title: string }>) {
      docs.push({ text: sourceTitleText(i.source_title), origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" });
    }
    return docs;
  }
  private codeIndexCache: { at: number; products: number; index: CodeIndex } | null = null;
  private codeIndex(): CodeIndex {
    const now = Date.now();
    const products = (this.db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n;
    if (this.codeIndexCache && now - this.codeIndexCache.at < 600_000 && this.codeIndexCache.products === products) return this.codeIndexCache.index;
    const docs: EvidenceDoc[] = [];
    for (const p of this.db.prepare("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>) docs.push({ text: p.name, origin: `product:${p.id}`, kind: "product" });
    docs.push(...this.extraEvidenceDocs());
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
      if (hit) {
        const chosen = this.moreSpecificProductForTitle(rows, hit.name, title) ?? hit;
        // The title contradicts the chosen entry's identity (see compIdentity.ts): its value, sample and codes are not offered for this listing.
        if (listingContradictsEntry(chosen.name, title)) return null;
        // Veto-only identity safeguard: signals (value, sample, codes) from an entry that is a different product are not offered; the caller sees "no matched product".
        if (this.safeguard.vetoes({ title, matchedName: matchedItem, entry: { id: chosen.id, name: chosen.name }, site: "signals" })) return null;
        return toSignals(chosen);
      }
    }
    const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    let best: { row: (typeof rows)[number]; words: number } | null = null;
    for (const r of rows) {
      const words = r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
      if (words.length < 2 || !words.every((w) => haystack.includes(w)) || !compMatchesSpecs(r.name, title)) continue;
      if (!best || words.length > best.words) best = { row: r, words: words.length };
    }
    if (best && listingContradictsEntry(best.row.name, title)) return null;
    if (best && this.safeguard.vetoes({ title, matchedName: null, entry: { id: best.row.id, name: best.row.name }, site: "signals-by-title" })) return null;
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
    if (best && listingContradictsEntry(best.name, title)) return null;
    if (best && this.safeguard.vetoes({ title, matchedName: null, entry: rows.find((r) => r.name === best!.name) ?? null, site: "valuation-by-title" })) return null;
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
    const named = this.nameForInsert(name);
    if (named.existingId) return named.existingId;
    const now = Date.now();
    this.db
      .prepare("INSERT INTO products (id, name, loading, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .run(id, named.name, now, now);
    if (named.alias) this.addProductAlias(id, named.alias, "typed", now);
    this.safeguard.invalidate();
    return id;
  }

  /**
   * Phase 2.1: the naming rules and the alias lookup on a creation path. Returns the entry this name already belongs to (by its old duplicate key, the canonical name, a kept alias, or because an
   * existing entry's name resolves to the same canonical model), else the one simple name the new entry should get, plus the typed name to keep as its alias. When an existing entry is found the
   * typed name is kept as that entry's alias, so the next lookup by it is exact.
   */
  private nameForInsert(typed: string): { name: string; alias: string | null; existingId: string | null } {
    const trimmed = typed.replace(/\s+/g, " ").trim();
    const facts = namingFacts(this.listModelFactOverrides());
    const r = resolveName(trimmed, facts);
    const canonical = r.canonical || trimmed;
    const rows = this.db.prepare("SELECT id, name FROM products WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string }>;
    const keys = [...new Set([this.productDuplicateKey(trimmed), this.productDuplicateKey(canonical)].filter(Boolean))];
    let existing = rows.find((row) => keys.includes(this.productDuplicateKey(row.name)));
    existing ??= rows.find((row) => nameKey(row.name) === nameKey(canonical));
    if (!existing) {
      const viaAlias = this.findProductIdByAlias(trimmed) ?? this.findProductIdByAlias(canonical);
      if (viaAlias) existing = rows.find((row) => row.id === viaAlias);
    }
    // an older entry that goes by another name for the same known model ("Xbox Series X (1TB)" vs "Xbox Series X"); a name nothing is known about never matches this way
    if (!existing && r.how !== "unchanged") {
      existing = rows.find((row) => {
        const o = resolveName(row.name, facts);
        return o.how !== "unchanged" && nameKey(o.canonical) === nameKey(canonical);
      });
    }
    if (existing) {
      if (nameKey(trimmed) !== nameKey(existing.name)) this.addProductAlias(existing.id, trimmed, "typed");
      return { name: existing.name, alias: null, existingId: existing.id };
    }
    // A name that only says the LINE ("Xbox Series X") does not say which model it is: guessing the default model's colour into the name could be wrong, so the entry keeps the line's own name
    // (a later step asks which model). Matching above still sees it as the default model's name, so a later "Xbox Series X (Black)" finds this entry instead of making another.
    const name = r.generic && r.line ? r.line : canonical;
    return { name, alias: nameKey(name) === nameKey(trimmed) ? null : trimmed, existingId: null };
  }

  // Folds together entries that are already duplicates of each other (made before the check above existed, or
  // arrived from another device through cloud sync): the fullest entry is kept, and everything that pointed at the
  // others (reference photos, listings, Watches, specific models) is repointed to it. Returns removedId -> keptId
  // so callers can repoint anything stored outside the database (the Search For list in config). Cheap when there
  // are no duplicates: one query over names.
  /** Entries that reduce to the same words (nothing is changed): the groups mergeDuplicateProducts WOULD fold together. */
  findDuplicateGroups(): Array<{ key: string; ids: string[]; names: string[] }> {
    const names = this.db.prepare("SELECT id, name FROM products WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string }>;
    const groups = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of names) {
      const key = this.productDuplicateKey(row.name);
      if (!key) continue;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    return [...groups].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ key, ids: rows.map((r) => r.id), names: rows.map((r) => r.name) }));
  }

  /** Folds what a loser entry holds into the kept one (fills what the kept entry lacks, joins the notes, repoints photos, listings, children and Watches); the caller deletes the loser afterwards. */
  private foldProductInto(winner: any, loser: any): void {
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

  }

  // ---- Phase 2.2 / 2.4: clean-up of existing duplicates, with an exact undo.

  /** Read-only: which entries the naming rules say are the same product ("N entries become M"). Changes nothing. */
  planDuplicateCleanup(): CleanupPlan {
    const rows = this.db.prepare("SELECT id, name, category, created_at, parent_product_id FROM products WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string; category: string | null; created_at: number; parent_product_id: string | null }>;
    return planCleanup(rows.map((r) => ({ id: r.id, name: r.name, category: r.category, createdAt: r.created_at, parentProductId: r.parent_product_id })), namingFacts(this.listModelFactOverrides()));
  }

  private static readonly MERGE_LINK_TABLES: Array<{ table: string; col: string; pk: string[] }> = [
    { table: "product_addons", col: "base_product_id", pk: ["id"] },
    { table: "listing_addons", col: "base_product_id", pk: ["listing_id", "addon_id"] },
    { table: "variant_candidates", col: "parent_id", pk: ["parent_id", "kind", "cand_key"] },
  ];

  /**
   * Folds the entries in `group.fold` into `group.keep`, as ONE transaction, recording everything needed to undo it: the folded entries' rows, the kept entry's columns that changed, the ids of
   * the photos / listings / children / Watches that moved (and each Watch's search terms as they were), the add-on and version rows, and the aliases. The folded names become aliases of the kept
   * entry. Returns the folded id -> kept id map. Nothing is sent to the cloud here beyond the usual queued delete, which a successful local merge has already earned.
   */
  mergeEntriesWithUndo(group: Pick<CleanupGroup, "keep" | "fold">, batchId: string, now: number = Date.now()): Map<string, string> {
    const merged = new Map<string, string>();
    this.transaction(() => {
      const winner = this.db.prepare("SELECT * FROM products WHERE id = ? AND deleted_at IS NULL").get(group.keep.id) as any;
      if (!winner) throw new Error("the entry to keep is gone");
      for (const f of group.fold) {
        const loser = this.db.prepare("SELECT * FROM products WHERE id = ? AND deleted_at IS NULL").get(f.id) as any;
        if (!loser || loser.id === winner.id) continue;
        const ids = (sql: string, ...args: string[]) => (this.db.prepare(sql).all(...args) as Array<{ id: string }>).map((r) => r.id);
        const winnerBefore = { ...winner };
        const snap: any = {
          loser: { ...loser },
          images: ids("SELECT id FROM product_images WHERE product_id = ?", loser.id),
          listings: ids("SELECT id FROM listings WHERE product_id = ?", loser.id),
          children: ids("SELECT id FROM products WHERE parent_product_id = ?", loser.id),
          watches: ids("SELECT id FROM watches WHERE linked_product_id = ?", loser.id),
          watchTerms: (this.db.prepare("SELECT id, terms_json FROM watches WHERE terms_json LIKE ?").all(`%${loser.id}%`) as Array<{ id: string; terms_json: string }>),
          links: Store.MERGE_LINK_TABLES.map((t) => ({ ...t, rows: this.db.prepare(`SELECT * FROM ${t.table} WHERE ${t.col} = ?`).all(loser.id) as any[] })),
          aliases: this.db.prepare("SELECT * FROM product_name_aliases WHERE product_id = ?").all(loser.id) as any[],
          aliasesAdded: [] as string[],
        };
        // links first (a row the kept entry already has stays where it is and is dropped with the folded entry)
        for (const t of Store.MERGE_LINK_TABLES) this.db.prepare(`UPDATE OR IGNORE ${t.table} SET ${t.col} = ? WHERE ${t.col} = ?`).run(winner.id, loser.id);
        // aliases: the folded entry's own name and its aliases now belong to the kept entry
        for (const name of [loser.name, ...snap.aliases.map((a: any) => a.alias as string)]) {
          const key = nameKey(name);
          if (key && this.addProductAlias(winner.id, name, "merge", now)) snap.aliasesAdded.push(key);
        }
        this.foldProductInto(winner, loser);
        this.deleteProductRows(loser.id);
        const winnerAfter = this.db.prepare("SELECT * FROM products WHERE id = ?").get(winner.id) as any;
        snap.winnerChanged = Object.fromEntries(Object.keys(winnerBefore).filter((c) => (winnerAfter?.[c] ?? null) !== (winnerBefore[c] ?? null)).map((c) => [c, winnerBefore[c] ?? null]));
        this.db.prepare("INSERT INTO merge_undo (id, batch_id, at, kept_id, folded_id, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), batchId, now, winner.id, loser.id, JSON.stringify(snap));
        Object.assign(winner, winnerAfter);
        merged.set(loser.id, winner.id);
      }
      this.touchProduct(winner.id);
    });
    // the local merge committed: only now does the folded entry's delete go out to the cloud
    for (const id of merged.keys()) this.afterProductDeleted(id);
    if (merged.size) this.ebayValueCache = null;
    return merged;
  }

  /** The runs of the clean-up that can still be undone (30 days), newest first. */
  listMergeBatches(now: number = Date.now()): Array<{ batchId: string; at: number; folded: number; keptNames: string[]; undone: boolean }> {
    const rows = this.db.prepare("SELECT batch_id, MIN(at) at, COUNT(*) n, MAX(undone_at) undone, GROUP_CONCAT(kept_id) kept FROM merge_undo WHERE at >= ? GROUP BY batch_id ORDER BY at DESC").all(now - 30 * 86_400_000) as Array<{ batch_id: string; at: number; n: number; undone: number | null; kept: string }>;
    return rows.map((r) => ({
      batchId: r.batch_id,
      at: r.at,
      folded: Number(r.n),
      keptNames: [...new Set(r.kept.split(","))].map((id) => (this.db.prepare("SELECT name FROM products WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "(removed)"),
      undone: !!r.undone,
    }));
  }

  /** Puts every entry of a clean-up run back exactly as it was (photos, listings, Watches, children, add-ons, notes and names). Returns how many entries came back. */
  undoMergeBatch(batchId: string, now: number = Date.now()): number {
    const rows = this.db.prepare("SELECT id, kept_id, folded_id, snapshot_json FROM merge_undo WHERE batch_id = ? AND undone_at IS NULL AND at >= ? ORDER BY rowid DESC").all(batchId, now - 30 * 86_400_000) as Array<{ id: string; kept_id: string; folded_id: string; snapshot_json: string }>;
    let restored = 0;
    this.transaction(() => {
      for (const r of rows) {
        const snap = JSON.parse(r.snapshot_json);
        if (!this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(r.kept_id)) continue; // the kept entry was deleted since: nothing to give back to
        if (this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(r.folded_id)) continue;
        const cols = Object.keys(snap.loser);
        this.db.prepare(`INSERT INTO products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => snap.loser[c]));
        for (const [c, v] of Object.entries(snap.winnerChanged as Record<string, unknown>)) this.db.prepare(`UPDATE products SET ${c} = ? WHERE id = ?`).run(v as never, r.kept_id);
        const mark = (table: string, col: string, idsList: string[]) => { for (const id of idsList) this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(r.folded_id, id); };
        mark("product_images", "product_id", snap.images);
        mark("listings", "product_id", snap.listings);
        mark("products", "parent_product_id", snap.children);
        mark("watches", "linked_product_id", snap.watches);
        for (const w of snap.watchTerms as Array<{ id: string; terms_json: string }>) this.db.prepare("UPDATE watches SET terms_json = ? WHERE id = ?").run(w.terms_json, w.id);
        for (const t of snap.links as Array<{ table: string; col: string; pk: string[]; rows: any[] }>) {
          for (const row of t.rows) {
            const where = t.pk.map((k) => `${k} = ?`).join(" AND ");
            const args = t.pk.map((k) => row[k]);
            const there = this.db.prepare(`SELECT 1 FROM ${t.table} WHERE ${where}`).get(...args);
            if (there) this.db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${where}`).run(r.folded_id, ...args);
            else {
              const c = Object.keys(row);
              this.db.prepare(`INSERT INTO ${t.table} (${c.join(", ")}) VALUES (${c.map(() => "?").join(", ")})`).run(...c.map((k) => row[k]));
            }
          }
        }
        for (const key of snap.aliasesAdded as string[]) this.db.prepare("DELETE FROM product_name_aliases WHERE product_id = ? AND alias_key = ?").run(r.kept_id, key);
        for (const a of snap.aliases as any[]) this.db.prepare("INSERT OR IGNORE INTO product_name_aliases (product_id, alias, alias_key, source, created_at) VALUES (?, ?, ?, ?, ?)").run(a.product_id, a.alias, a.alias_key, a.source, a.created_at);
        this.db.prepare("DELETE FROM pending_cloud_deletes WHERE resource_type = 'product' AND local_id = ?").run(r.folded_id);
        this.db.prepare("UPDATE merge_undo SET undone_at = ? WHERE id = ?").run(now, r.id);
        restored++;
      }
    });
    if (restored) {
      this.safeguard.invalidate();
      this.ebayValueCache = null;
    }
    return restored;
  }

  // Beta 13: this is no longer called on its own (the Library only PROPOSES merges, see findDuplicateGroups); it runs for the groups a person approved: pass their ids.
  mergeDuplicateProducts(onlyIds?: string[]): Map<string, string> {
    const merged = new Map<string, string>();
    const groups = new Map<string, string[]>();
    for (const g of this.findDuplicateGroups()) {
      if (onlyIds && !g.ids.some((id) => onlyIds.includes(id))) continue;
      groups.set(g.key, g.ids);
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
        this.foldProductInto(winner, loser);
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
  createManualProduct(id: string, name: string, category: string, imageUrl: string | null): string {
    const named = this.nameForInsert(name);
    if (named.existingId) return named.existingId;
    const now = Date.now();
    this.db
      .prepare("INSERT INTO products (id, name, category, image_url, keep_thumbnail, loading, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run(id, named.name, category, imageUrl, imageUrl ? 1 : 0, now, now);
    if (named.alias) this.addProductAlias(id, named.alias, "typed", now);
    this.safeguard.invalidate();
    return id;
  }

  updateProductProfile(
    id: string,
    data: { aiSummary: string; category: string; family: string | null; familyLogoUrl?: string | null; imageUrl: string | null }
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        // A product whose place the person chose (placement_locked) keeps its category and family: research refreshes the rest.
        "UPDATE products SET ai_summary = ?, ai_summary_generated_at = ?, category = CASE WHEN placement_locked = 1 THEN category ELSE ? END, family = CASE WHEN placement_locked = 1 THEN family ELSE ? END, family_logo_url = ?, image_url = ?, loading = 0, updated_at = ? WHERE id = ?"
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

  /**
   * Keeps the evidence verdict on a product (what the evidence check found about this being a real variant). Never overwrites a stronger earlier
   * verdict with a weaker one without the caller reconciling them first (see variantEvidence.ts's reconcileVerdict). Returns whether it was written.
   */
  /** Waits before the next try after the nth failed research: 10 minutes, 30 minutes, 2 hours, 6 hours; then Clynx stops retrying on its own (the person can press Research again). */
  static readonly RESEARCH_RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

  /** The research could not run: remember that (and when to try again) WITHOUT touching the description, category or place the product already has. */
  markResearchFailed(id: string, note: string, now: number = Date.now()): void {
    const row = this.db.prepare("SELECT research_attempts n FROM products WHERE id = ?").get(id) as { n: number } | undefined;
    if (!row) return;
    const attempts = (row.n ?? 0) + 1;
    const delay = Store.RESEARCH_RETRY_DELAYS_MS[attempts - 1];
    // out of automatic tries: do not promise one
    const shown = delay === undefined ? note.replace(/\s*I'll try this one again[^.]*\./i, "").trim() + " I've stopped retrying on my own; press Research to try again." : note;
    this.db
      .prepare("UPDATE products SET research_state = 'failed', research_note = ?, research_attempts = ?, research_retry_at = ?, loading = 0, updated_at = ? WHERE id = ?")
      .run(shown.slice(0, 300), attempts, delay === undefined ? null : now + delay, now, id);
  }

  /** Every live product with its parent and the status of its evidence, for linking confirmed editions under their base (variantLinking.planParentLinks). */
  listVariantLinkRows(): Array<{ id: string; name: string; parentId: string | null; evidenceStatus: string | null }> {
    return (this.db.prepare("SELECT id, name, parent_product_id p, variant_status s FROM products WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string; p: string | null; s: string | null }>).map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.p ?? null,
      evidenceStatus: r.s ?? null,
    }));
  }

  /** A research finished: clear a failure, or mark that the write-up had no pages behind it. */
  setResearchState(id: string, state: "unsourced" | null, note: string | null = null): void {
    this.db.prepare("UPDATE products SET research_state = ?, research_note = ?, research_attempts = 0, research_retry_at = NULL WHERE id = ?").run(state, note, id);
  }

  /** Products whose research failed and whose next try is due. */
  listResearchRetriesDue(now: number = Date.now(), limit = 3): Array<{ id: string; name: string }> {
    return this.db
      .prepare("SELECT id, name FROM products WHERE research_state = 'failed' AND deleted_at IS NULL AND research_retry_at IS NOT NULL AND research_retry_at <= ? ORDER BY research_retry_at LIMIT ?")
      .all(now, limit) as Array<{ id: string; name: string }>;
  }

  setProductVariantEvidence(id: string, verdict: VariantVerdict | null): boolean {
    const res = this.db
      .prepare("UPDATE products SET variant_status = ?, variant_evidence = ?, updated_at = ? WHERE id = ?")
      .run(verdict ? verdict.status : null, verdict ? JSON.stringify(compactVerdict(verdict)) : null, Date.now(), id);
    return Number(res.changes) > 0;
  }

  /** Keeps how the latest comparables were judged (counts and reasons only, no listing text beyond a few short examples). */
  setProductCompsValidation(id: string, validation: ProductProfile["compsValidation"]): void {
    this.db.prepare("UPDATE products SET comps_validation = ? WHERE id = ?").run(validation ? JSON.stringify(validation) : null, id);
  }

  /** A variant claim checked against this product that was not confirmed enough to become an entry: kept (newest first, 10 at most) so the next question starts from it. */
  recordVariantClaim(parentId: string, verdict: VariantVerdict): boolean {
    const row = this.db.prepare("SELECT variant_claims FROM products WHERE id = ?").get(parentId) as { variant_claims?: string | null } | undefined;
    if (!row) return false;
    const kept = parseVerdictList(row.variant_claims).filter((v) => v.claim.toLowerCase() !== verdict.claim.toLowerCase());
    const next = [compactVerdict(verdict), ...kept].slice(0, 10);
    this.db.prepare("UPDATE products SET variant_claims = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), Date.now(), parentId);
    return true;
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
      this.db.prepare("SELECT DISTINCT family FROM products WHERE family IS NOT NULL AND family != '' AND deleted_at IS NULL").all() as Array<{ family: string }>
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
      this.safeguard.invalidate();
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
    const rows = this.db.prepare("SELECT * FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as any[];
    return rows.map((r) => this.withFolder(rowToProduct(r)));
  }

  // A light view of the Database for lookups that only need to know which products exist: id, name and family, newest first. It
  // never reads a product's photo (a row's thumbnail is ~90 KB of text, so listProducts() on a library of hundreds is tens of
  // megabytes), and it is read fresh each time, so a product added a moment ago is always seen. Use this, not listProducts(),
  // for name matching and name lists; load the one row you need afterwards with getProductById.
  // The entries with no thumbnail yet (id and name only, never the photos of the others): what the background "research blank entries" sweep needs.
  listBlankProductIndex(): Array<{ id: string; name: string }> {
    return this.db.prepare("SELECT id, name FROM products WHERE deleted_at IS NULL AND (image_url IS NULL OR image_url = '') ORDER BY created_at DESC").all() as Array<{ id: string; name: string }>;
  }

  listProductIndex(): Array<{ id: string; name: string; family: string | null }> {
    return this.db.prepare("SELECT id, name, family FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC").all() as Array<{ id: string; name: string; family: string | null }>;
  }

  getProductById(id: string): ProductProfile | null {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as any;
    return row ? this.withFolder(rowToProduct(row)) : null;
  }

  // Case-insensitive exact-ish match used to link a Search For item's name
  // to a product profile for extra scoring context.
  getProductByName(name: string): ProductProfile | null {
    const row = this.db.prepare("SELECT * FROM products WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL").get(name) as any;
    return row ? this.withFolder(rowToProduct(row)) : null;
  }

  // Exact match first, then a fuzzy fallback (see isSimilarProductName) —
  // this is what lets a differently-phrased listing of a product already in
  // the Database strengthen that existing entry instead of spawning a
  // near-duplicate one under its own slightly different name.
  findMatchingProduct(name: string): ProductProfile | null {
    const exact = this.getProductByName(name);
    if (exact) return exact;
    // a name the entry keeps as an alias, or the canonical name the naming rules give it, is an exact hit too
    const aliasId = this.findProductIdByAlias(name);
    const byAlias = aliasId ? this.getProductById(aliasId) : null;
    if (byAlias) return byAlias;
    const named = resolveName(name, namingFacts(this.listModelFactOverrides()));
    if (named.how === "model" && named.canonical) {
      const byCanonical = this.getProductByName(named.canonical);
      if (byCanonical) return byCanonical;
    }
    // Fuzzy: compare against names only, then load just the one product that matched.
    const legacy = (() => {
      const similar = this.listProductIndex().find((p) => isSimilarProductName(name, p.name));
      if (similar) return this.getProductById(similar.id);
      // a known model whose family entry exists under another name ("xbox series x galaxy" -> the "Xbox Series X" family, kept as "Xbox Series X (Black)"): the family entry is the match
      if (named.how === "model" && named.parent) {
        const familyId = this.findProductIdByAlias(named.parent);
        return (familyId ? this.getProductById(familyId) : null) ?? this.getProductByName(named.parent);
      }
      return null;
    })();
    if (this.resolverMode === "off") return legacy;
    const best = this.resolveTarget(name);
    const resolved = best.status === "resolved" && best.best ? this.getProductById(best.best.id) : null;
    if ((resolved?.id ?? null) !== (legacy?.id ?? null)) this.resolverLog?.({ subject: name, legacy: legacy?.name ?? null, resolved: resolved?.name ?? null, status: best.status, why: best.why, mode: this.resolverMode });
    // "shadow" computes and records the disagreement but keeps today's answer; "enforce" uses the best match (a tie or only-a-parent is null: nothing is attached on a guess).
    return this.resolverMode === "enforce" ? resolved : legacy;
  }

  private resolverMode: "off" | "shadow" | "enforce" = "off";
  private resolverLog: ((m: { subject: string; legacy: string | null; resolved: string | null; status: string; why: string; mode: string }) => void) | null = null;
  setResolverMode(mode: "off" | "shadow" | "enforce", log?: Store["resolverLog"]): void {
    this.resolverMode = mode;
    this.resolverLog = log ?? null;
  }

  /** Best-match resolution (productResolver.ts) of a name against every live entry: unique best or "unresolved" - never a first-come fuzzy hit. Always available, whatever the mode. */
  resolveTarget(name: string): ResolveResult & { product: ProductProfile | null } {
    const r = resolveProduct(name, this.listProductIndex());
    return { ...r, product: r.status === "resolved" && r.best ? this.getProductById(r.best.id) : null };
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
            name = ?, ai_summary = ?, ai_summary_generated_at = ?, observed_notes = ?, category = CASE WHEN placement_locked = 1 THEN category ELSE ? END, family = CASE WHEN placement_locked = 1 THEN family ELSE ? END,
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

  // Hard delete (internal: merges, tests, "Clear all"). The photos go FIRST: product_images.product_id references products(id) and the database enforces it, so deleting the
  // product row while it still had photos failed with "FOREIGN KEY constraint failed" (Beta 13 audit LB-02). Children and links are released in the same transaction.
  deleteProduct(id: string): void {
    this.transaction(() => this.deleteProductRows(id));
    this.afterProductDeleted(id);
  }

  /** The rows of a hard delete, for callers that are already inside a transaction (transaction() is not re-entrant); they call afterProductDeleted once it commits. */
  private deleteProductRows(id: string): void {
    this.db.prepare("DELETE FROM product_images WHERE product_id = ?").run(id);
    this.db.prepare("DELETE FROM listing_addons WHERE base_product_id = ?").run(id);
    this.db.prepare("DELETE FROM product_addons WHERE base_product_id = ?").run(id);
    this.db.prepare("DELETE FROM variant_candidates WHERE parent_id = ?").run(id);
    this.db.prepare("DELETE FROM product_name_aliases WHERE product_id = ?").run(id);
    this.db.prepare("UPDATE products SET parent_product_id = NULL WHERE parent_product_id = ?").run(id);
    this.db.prepare("UPDATE listings SET product_id = NULL WHERE product_id = ?").run(id);
    this.db.prepare("UPDATE watches SET linked_product_id = NULL WHERE linked_product_id = ?").run(id);
    this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
  }

  private afterProductDeleted(id: string): void {
    this.safeguard.invalidate();
    this.identity?.forgetProduct(id);
    // Batch 2 Fix B — see deleteWatch's own comment above; same reasoning,
    // productSync.ts's own pushPendingDeletes drains this resource type.
    this.addPendingCloudDelete("product", id);
  }

  /** The Library's delete: the product goes to the Trash (restorable for 30 days) and disappears from every list. Its photos stay with it. */
  softDeleteProduct(id: string): boolean {
    const res = this.db.prepare("UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), Date.now(), id);
    if (Number(res.changes) > 0) this.safeguard.invalidate();
    this.ebayValueCache = null;
    return Number(res.changes) > 0;
  }

  restoreProduct(id: string): boolean {
    const res = this.db.prepare("UPDATE products SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL").run(Date.now(), id);
    if (Number(res.changes) > 0) this.safeguard.invalidate();
    this.ebayValueCache = null;
    return Number(res.changes) > 0;
  }

  listTrashedProducts(): ProductProfile[] {
    return (this.db.prepare("SELECT * FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as any[]).map(rowToProduct);
  }

  /** Permanently removes what has been in the Trash longer than `olderThanMs` (products, their photos, loose photos, folders). Only the Library calls this; nothing else purges. */
  purgeTrash(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const ids = (this.db.prepare("SELECT id FROM products WHERE deleted_at IS NOT NULL AND deleted_at < ?").all(cutoff) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) this.deleteProduct(id);
    this.db.prepare("DELETE FROM product_images WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
    this.db.prepare("UPDATE products SET folder_id = NULL WHERE folder_id IN (SELECT id FROM library_folders WHERE deleted_at IS NOT NULL AND deleted_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM library_folders WHERE deleted_at IS NOT NULL AND deleted_at < ? AND id NOT IN (SELECT parent_id FROM library_folders WHERE parent_id IS NOT NULL AND (deleted_at IS NULL OR deleted_at >= ?))").run(cutoff, cutoff);
    this.invalidateFolders();
    return ids.length;
  }

  /** What is in the Trash: products, loose photos and folders, newest first. */
  listTrash(): { products: Array<{ id: string; name: string; deletedAt: number }>; images: Array<{ id: string; productId: string; productName: string; sourceTitle: string | null; deletedAt: number }>; folders: Array<{ id: string; name: string; deletedAt: number }> } {
    return {
      products: (this.db.prepare("SELECT id, name, deleted_at FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as any[]).map((r) => ({ id: r.id, name: r.name, deletedAt: r.deleted_at })),
      images: (this.db.prepare("SELECT i.id, i.product_id, p.name, i.source_title, i.deleted_at FROM product_images i JOIN products p ON p.id = i.product_id WHERE i.deleted_at IS NOT NULL AND p.deleted_at IS NULL ORDER BY i.deleted_at DESC LIMIT 200").all() as any[]).map((r) => ({ id: r.id, productId: r.product_id, productName: r.name, sourceTitle: r.source_title ?? null, deletedAt: r.deleted_at })),
      folders: (this.db.prepare("SELECT id, name, deleted_at FROM library_folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as any[]).map((r) => ({ id: r.id, name: r.name, deletedAt: r.deleted_at })),
    };
  }

  // Per explicit instruction — the Database's own "Clear all" button,
  // same shape as Feed's clearAllListings. Only the products themselves
  // and their reference-photo galleries; the Blacklist and Blacklisted
  // Images sections are separate data and untouched by this, same as
  // Feed's clear-all never touches the Blacklist either.
  clearAllProducts(): void {
    // the server keeps a copy of every synced product: queue a cloud delete for each (productSync sends them), or the next pull brings every one of them back
    for (const r of this.db.prepare("SELECT id FROM products").all() as Array<{ id: string }>) this.addPendingCloudDelete("product", r.id);
    this.db.exec("DELETE FROM product_images; DELETE FROM listing_addons; DELETE FROM product_addons; DELETE FROM variant_candidates; DELETE FROM product_name_aliases; DELETE FROM products;");
    this.safeguard.invalidate();
    this.identity?.forgetAllProducts();
  }

  // --- Product reference-photo library ------------------------------------
  // See types.ts's ProductImage: a growing library of confirmed-genuine
  // photos per product, auto-populated whenever the scanner confirms a real
  // deal for it (see scrapeEngine.ts's evaluateListing), plus whatever the
  // user adds/removes by hand from the product's own page.

  static readonly MAX_IMAGES_PER_PRODUCT = 20;

  listProductImages(productId: string): ProductImage[] {
    const rows = this.db
      .prepare("SELECT * FROM product_images WHERE product_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, sort_order ASC, created_at DESC")
      .all(productId) as any[];
    return rows.map(rowToProductImage);
  }

  /** The same list without the picture bytes (a gallery with 20 photos is several MB): ids, titles, status, order. For lists, selection and counts. */
  listProductImageMeta(productId: string): Array<Omit<ProductImage, "imageData">> {
    const rows = this.db
      .prepare(
        "SELECT id, product_id, source_title, created_at, kind, status, source_kind, source_url, is_primary, sort_order, content_hash FROM product_images WHERE product_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, sort_order ASC, created_at DESC"
      )
      .all(productId) as any[];
    return rows.map((r) => {
      const { imageData: _unused, ...meta } = rowToProductImage({ ...r, image_data: "" });
      return meta;
    });
  }

  // Auto-called on a confirmed deal, or the user manually adding one from the product's page — same storage either way. Prunes once over the cap, but never a
  // picture the user added, a primary picture or one that is the product's thumbnail source; the lowest-value picture goes first (unverified, then oldest).
  addProductImage(
    productId: string,
    imageData: string,
    sourceTitle: string | null,
    kind: "normal" | "poor_condition" = "normal",
    extra: { status?: ProductImage["status"]; sourceKind?: string | null; sourceUrl?: string | null; contentHash?: string | null; verdictJson?: string | null; originProductId?: string | null; isPrimary?: boolean } = {}
  ): ProductImage {
    const id = randomUUID();
    const status = extra.status ?? "legacy";
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO product_images (id, product_id, image_data, source_title, created_at, kind, status, source_kind, source_url, verdict_json, content_hash, origin_product_id, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, productId, imageData, sourceTitle, createdAt, kind, status, extra.sourceKind ?? null, extra.sourceUrl ?? null, extra.verdictJson ?? null, extra.contentHash ?? null, extra.originProductId ?? null, extra.isPrimary ? 1 : 0);
    this.pruneProductImages(productId);
    return { id, productId, imageData, sourceTitle, createdAt, kind, status, sourceKind: extra.sourceKind ?? null, sourceUrl: extra.sourceUrl ?? null, isPrimary: !!extra.isPrimary, sortOrder: 0, contentHash: extra.contentHash ?? null };
  }

  /** An existing live photo of this product with the same content hash (exact duplicate), or null. */
  findImageByHash(productId: string, hash: string): ProductImage | null {
    const row = this.db.prepare("SELECT * FROM product_images WHERE product_id = ? AND content_hash = ? AND deleted_at IS NULL LIMIT 1").get(productId, hash) as any;
    return row ? rowToProductImage(row) : null;
  }

  getProductImage(id: string): ProductImage | null {
    const row = this.db.prepare("SELECT * FROM product_images WHERE id = ?").get(id) as any;
    return row ? rowToProductImage(row) : null;
  }

  /** Changes how far a picture is trusted (and records why). Never deletes it. */
  setImageStatus(imageId: string, status: ProductImage["status"], verdictJson?: string | null): boolean {
    const res = verdictJson === undefined
      ? this.db.prepare("UPDATE product_images SET status = ? WHERE id = ?").run(status, imageId)
      : this.db.prepare("UPDATE product_images SET status = ?, verdict_json = ? WHERE id = ?").run(status, verdictJson, imageId);
    return Number(res.changes) > 0;
  }

  /** The source titles of the photos in a product that may serve as references (trusted, user, legacy): what a new photo must stay consistent with. */
  listReferenceTitles(productId: string): string[] {
    const rows = this.db
      .prepare("SELECT source_title, status FROM product_images WHERE product_id = ? AND deleted_at IS NULL AND kind = 'normal' AND source_title IS NOT NULL AND status IN ('trusted','user','legacy')")
      .all(productId) as Array<{ source_title: string }>;
    return rows.map((r) => r.source_title);
  }

  /**
   * The one-time suspect pass (and the re-check after a merge): a photo filed before Beta 13 whose OWN source title contradicts the entry it is in is set aside (status
   * needs_review: not used as a reference, still visible, nothing deleted) with a review item. `all` also re-judges photos that already have a verdict (after a merge).
   * Processes at most `limit` photos per call; returns how many it looked at (0 = nothing left).
   */
  markSuspectImages(opts: { limit?: number; productId?: string; all?: boolean } = {}): { looked: number; flagged: number } {
    const limit = opts.limit ?? 200;
    const where = opts.all ? "status IN ('legacy','trusted','unverified')" : "status = 'legacy' AND verdict_json IS NULL";
    const rows = this.db
      .prepare(`SELECT i.id, i.product_id, i.source_title, p.name FROM product_images i JOIN products p ON p.id = i.product_id WHERE ${where} AND i.kind = 'normal' AND i.source_title IS NOT NULL AND i.deleted_at IS NULL${opts.productId ? " AND i.product_id = ?" : ""} LIMIT ?`.replace(/\bstatus\b/g, "i.status").replace(/verdict_json/g, "i.verdict_json"))
      .all(...(opts.productId ? [opts.productId, limit] : [limit])) as Array<{ id: string; product_id: string; source_title: string; name: string }>;
    let flagged = 0;
    for (const r of rows) {
      const title = titleFromLabel(r.source_title) ?? r.source_title;
      const v = judgeCandidateByText(r.name, title);
      if (v.status === "mismatch") {
        this.db.prepare("UPDATE product_images SET status = 'needs_review', verdict_json = ? WHERE id = ?").run(JSON.stringify({ outcome: "quarantined", reasons: v.reasons, proposer: "suspect-pass" }), r.id);
        this.addReviewItem({ kind: "image", subjectId: r.id, reasons: v.reasons, evidence: { productId: r.product_id, productName: r.name, sourceTitle: r.source_title, proposer: "suspect-pass" } });
        flagged++;
      } else if (!opts.all) {
        this.db.prepare("UPDATE product_images SET verdict_json = ? WHERE id = ?").run(JSON.stringify({ outcome: "legacy-checked", status: v.status }), r.id);
      }
    }
    return { looked: rows.length, flagged };
  }

  /** Has the one-time suspect pass finished (schema flag b13-suspect-pass)? */
  suspectPassDone(): boolean {
    return !!this.db.prepare("SELECT 1 FROM schema_flags WHERE name = 'b13-suspect-pass'").get();
  }
  finishSuspectPass(): void {
    this.db.prepare("INSERT OR IGNORE INTO schema_flags (name) VALUES ('b13-suspect-pass')").run();
  }

  // --- Review queue: things a person should look at (a picture whose evidence disagrees, a name made from a picture alone). Suggestions only; nothing here changes the Library.
  addReviewItem(item: { kind: "image" | "product" | "merge"; subjectId: string; reasons: string[]; evidence: Record<string, unknown> }): string {
    // one open item per (kind, subject): re-detecting the same problem updates it instead of piling up
    const open = this.db.prepare("SELECT id FROM review_items WHERE kind = ? AND subject_id = ? AND state = 'open'").get(item.kind, item.subjectId) as { id: string } | undefined;
    if (open) {
      this.db.prepare("UPDATE review_items SET reasons_json = ?, evidence_json = ? WHERE id = ?").run(JSON.stringify(item.reasons), JSON.stringify(item.evidence), open.id);
      return open.id;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO review_items (id, kind, subject_id, reasons_json, evidence_json, state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)").run(id, item.kind, item.subjectId, JSON.stringify(item.reasons), JSON.stringify(item.evidence), Date.now());
    return id;
  }

  listReviewItems(state: "open" | "all" = "open"): Array<{ id: string; kind: string; subjectId: string; reasons: string[]; evidence: Record<string, unknown>; state: string; createdAt: number }> {
    const rows = (state === "open" ? this.db.prepare("SELECT * FROM review_items WHERE state = 'open' ORDER BY created_at DESC") : this.db.prepare("SELECT * FROM review_items ORDER BY created_at DESC")).all() as any[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, subjectId: r.subject_id, reasons: JSON.parse(r.reasons_json), evidence: JSON.parse(r.evidence_json), state: r.state, createdAt: r.created_at }));
  }

  resolveReviewItem(id: string, state: "accepted" | "rejected" | "snoozed", by: string): boolean {
    return Number(this.db.prepare("UPDATE review_items SET state = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND state = 'open'").run(state, Date.now(), by, id).changes) > 0;
  }

  private pruneProductImages(productId: string): void {
    const rows = this.db
      .prepare("SELECT id, status, is_primary, created_at FROM product_images WHERE product_id = ? AND deleted_at IS NULL")
      .all(productId) as Array<{ id: string; status: string; is_primary: number; created_at: number }>;
    let excess = rows.length - Store.MAX_IMAGES_PER_PRODUCT;
    if (excess <= 0) return;
    const thumb = (this.db.prepare("SELECT thumbnail_image_id FROM products WHERE id = ?").get(productId) as { thumbnail_image_id?: string | null } | undefined)?.thumbnail_image_id ?? null;
    const protectedRow = (r: { id: string; status: string; is_primary: number }) => r.status === "user" || !!r.is_primary || r.id === thumb;
    // lowest value first: not-used-as-reference statuses, then legacy/trusted by age
    const value = (r: { status: string }) => (r.status === "quarantined" || r.status === "needs_review" ? 0 : r.status === "unverified" ? 1 : 2);
    const candidates = rows.filter((r) => !protectedRow(r)).sort((a, b) => value(a) - value(b) || a.created_at - b.created_at);
    for (const row of candidates) {
      if (excess <= 0) break;
      this.db.prepare("DELETE FROM product_images WHERE id = ?").run(row.id);
      excess--;
    }
  }

  // How many ordinary (non-poor-condition) reference photos each product
  // has — one grouped query instead of loading every photo's bytes just to
  // count them. Products with none are simply absent from the map.
  countNormalImagesByProduct(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT product_id, COUNT(*) as n FROM product_images WHERE kind = 'normal' AND deleted_at IS NULL GROUP BY product_id")
      .all() as Array<{ product_id: string; n: number }>;
    return new Map(rows.map((r) => [r.product_id, r.n]));
  }

  // Bumps updated_at without changing anything else — for writes that only
  // touch product_images (which has no timestamp of its own on the product
  // row), so cloud sync and any UI keyed off updatedAt still notice them.
  touchProduct(id: string): void {
    this.db.prepare("UPDATE products SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ---- Add-ons (addons.ts). Suggested ones start OFF; a dismissed one never comes back; nothing here touches the base product's own value.
  private addonFromRow(r: any): Addon {
    let examples: string[] = [];
    try {
      const parsed = JSON.parse(r.example_listing_ids ?? "[]");
      if (Array.isArray(parsed)) examples = parsed.filter((x) => typeof x === "string");
    } catch {
      /* keep empty */
    }
    return {
      id: r.id,
      baseProductId: r.base_product_id,
      name: r.name,
      addonProductId: r.addon_product_id ?? null,
      role: r.role === "expected" ? "expected" : "bonus",
      status: r.status === "confirmed" || r.status === "dismissed" ? r.status : "suggested",
      source: r.source === "seen_in_listing" || r.source === "researched_related" ? r.source : "user_added",
      compatibility: r.compatibility === "verified" || r.compatibility === "plausible" ? r.compatibility : "unknown",
      enabled: !!r.enabled,
      standaloneValueUsd: typeof r.standalone_value_usd === "number" ? r.standalone_value_usd : null,
      timesSeen: r.times_seen ?? 0,
      exampleListingIds: examples,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    };
  }

  listAddons(baseProductId: string): Addon[] {
    return (this.db.prepare("SELECT * FROM product_addons WHERE base_product_id = ? ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, first_seen_at").all(baseProductId) as any[]).map((r) => this.addonFromRow(r));
  }

  /** The person adds one by hand: confirmed straight away, and switched on only if they say so. A name they dismissed earlier is revived (they asked for it again). */
  addAddon(baseProductId: string, input: { name: string; role?: AddonRole; standaloneValueUsd?: number | null; addonProductId?: string | null; enabled?: boolean }, now: number = Date.now()): Addon | null {
    const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = addonKey(name);
    if (!name || !key || !this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(baseProductId)) return null;
    const existing = this.db.prepare("SELECT id FROM product_addons WHERE base_product_id = ? AND name_key = ?").get(baseProductId, key) as { id: string } | undefined;
    const value = typeof input.standaloneValueUsd === "number" && Number.isFinite(input.standaloneValueUsd) && input.standaloneValueUsd >= 0 ? input.standaloneValueUsd : null;
    if (existing) {
      this.db
        .prepare("UPDATE product_addons SET status = 'confirmed', role = ?, standalone_value_usd = COALESCE(?, standalone_value_usd), addon_product_id = COALESCE(?, addon_product_id), enabled = ?, last_seen_at = ? WHERE id = ?")
        .run(input.role ?? "bonus", value, input.addonProductId ?? null, input.enabled ? 1 : 0, now, existing.id);
      return this.getAddon(existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO product_addons (id, base_product_id, name, name_key, addon_product_id, role, status, source, enabled, standalone_value_usd, times_seen, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'user_added', ?, ?, 0, ?, ?)")
      .run(id, baseProductId, name, key, input.addonProductId ?? null, input.role ?? "bonus", input.enabled ? 1 : 0, value, now, now);
    return this.getAddon(id);
  }

  getAddon(id: string): Addon | null {
    const r = this.db.prepare("SELECT * FROM product_addons WHERE id = ?").get(id);
    return r ? this.addonFromRow(r) : null;
  }

  /**
   * Clynx saw this add-on in a listing of the base product: counted, and created as a SUGGESTION (switched off) the first time. Never revives a dismissed one, never switches anything on,
   * never creates a second row for the same name.
   */
  noteAddonSeen(baseProductId: string, name: string, listingId: string | null, now: number = Date.now()): Addon | null {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = addonKey(clean);
    if (!clean || !key || !this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(baseProductId)) return null;
    const existing = this.db.prepare("SELECT * FROM product_addons WHERE base_product_id = ? AND name_key = ?").get(baseProductId, key) as any | undefined;
    if (existing) {
      if (existing.status === "dismissed") return this.addonFromRow(existing);
      const examples: string[] = this.addonFromRow(existing).exampleListingIds;
      if (listingId && !examples.includes(listingId)) examples.push(listingId);
      this.db.prepare("UPDATE product_addons SET times_seen = times_seen + 1, example_listing_ids = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(examples.slice(-5)), now, existing.id);
      return this.getAddon(existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO product_addons (id, base_product_id, name, name_key, role, status, source, enabled, times_seen, example_listing_ids, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'bonus', 'suggested', 'seen_in_listing', 0, 1, ?, ?, ?)")
      .run(id, baseProductId, clean, key, JSON.stringify(listingId ? [listingId] : []), now, now);
    if (listingId) this.db.prepare("INSERT OR IGNORE INTO listing_addons (listing_id, base_product_id, addon_id, evidence, confidence, created_at) VALUES (?, ?, ?, 'title', 'low', ?)").run(listingId, baseProductId, id, now);
    return this.getAddon(id);
  }

  /**
   * An add-on found by research (or seen in a listing) that now has its OWN Database entry: the row on the base product's page is created if missing (suggested, switched OFF, no price) and
   * linked to the entry. An add-on the person dismissed is left alone and null is returned (the caller must not create an entry for it). The base product's value is never touched.
   */
  linkResearchedAddon(baseProductId: string, name: string, entryId: string | null, now: number = Date.now()): Addon | null {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = addonKey(clean);
    if (!clean || !key || !this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(baseProductId)) return null;
    const existing = this.db.prepare("SELECT * FROM product_addons WHERE base_product_id = ? AND name_key = ?").get(baseProductId, key) as any | undefined;
    if (existing) {
      if (existing.status === "dismissed") return null;
      if (entryId) this.db.prepare("UPDATE product_addons SET addon_product_id = ?, last_seen_at = ? WHERE id = ?").run(entryId, now, existing.id);
      return this.getAddon(existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO product_addons (id, base_product_id, name, name_key, addon_product_id, role, status, source, enabled, times_seen, example_listing_ids, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'bonus', 'suggested', 'researched_related', 0, 0, '[]', ?, ?)")
      .run(id, baseProductId, clean, key, entryId, now, now);
    return this.getAddon(id);
  }

  /** The toggle. Only changes whether the add-on counts on the page: the base product's stored value is never touched. */
  setAddonEnabled(id: string, enabled: boolean): boolean {
    const row = this.getAddon(id);
    if (!row || row.status === "dismissed") return false;
    // switching one on is the person confirming it
    this.db.prepare("UPDATE product_addons SET enabled = ?, status = CASE WHEN ? = 1 THEN 'confirmed' ELSE status END WHERE id = ?").run(enabled ? 1 : 0, enabled ? 1 : 0, id);
    return true;
  }

  setAddonStatus(id: string, status: AddonStatus): boolean {
    if (!this.getAddon(id)) return false;
    // dismissed = never counts and never comes back (noteAddonSeen leaves it alone)
    this.db.prepare("UPDATE product_addons SET status = ?, enabled = CASE WHEN ? = 'dismissed' THEN 0 ELSE enabled END WHERE id = ?").run(status, status, id);
    return true;
  }

  setAddonDetails(id: string, patch: { name?: string; role?: AddonRole; standaloneValueUsd?: number | null }): boolean {
    const row = this.getAddon(id);
    if (!row) return false;
    const name = patch.name !== undefined ? patch.name.replace(/\s+/g, " ").trim().slice(0, 120) : row.name;
    if (!name) return false;
    const value = patch.standaloneValueUsd === undefined ? row.standaloneValueUsd : patch.standaloneValueUsd === null ? null : Number.isFinite(patch.standaloneValueUsd) && patch.standaloneValueUsd >= 0 ? patch.standaloneValueUsd : row.standaloneValueUsd;
    this.db.prepare("UPDATE product_addons SET name = ?, name_key = ?, role = ?, standalone_value_usd = ? WHERE id = ?").run(name, addonKey(name), patch.role ?? row.role, value, id);
    return true;
  }

  // ---- versions and add-ons found by research (variantDiscovery.ts): a persistent queue with a status per name, so nothing is silently dropped.

  /** Adds newly found names as "queued"; a name already known keeps its status and gains any new sources / evidence. A name the person dismissed or that was rejected is not re-queued. */
  upsertCandidates(parentId: string, candidates: Candidate[], now: number = Date.now()): number {
    let added = 0;
    for (const c of candidates) {
      // an add-on's key ignores filler (brand, "wireless", "gaming", "storage", plurals): the three spellings of one Seagate card or one standard controller are ONE queued name
      const key = c.kind === "addon" ? addonEntryKey(c.name) : candidateKey(c.name);
      if (!key) continue;
      const row = this.db.prepare("SELECT sources, evidence, support, status FROM variant_candidates WHERE parent_id = ? AND kind = ? AND cand_key = ?").get(parentId, c.kind, key) as { sources: string; evidence: string; support: string | null; status: string } | undefined;
      if (!row) {
        this.db
          .prepare("INSERT INTO variant_candidates (parent_id, kind, cand_key, name, sources, evidence, support, status, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)")
          .run(parentId, c.kind, key, c.name, JSON.stringify(c.sources), JSON.stringify(c.evidence), c.support ?? null, now);
        added++;
        continue;
      }
      const sources = [...new Set([...(JSON.parse(row.sources) as string[]), ...c.sources])];
      const evidence = [...new Set([...(JSON.parse(row.evidence) as string[]), ...c.evidence])];
      const support = c.support === "confirmed" || row.support === "confirmed" ? "confirmed" : (row.support ?? c.support ?? null);
      // a suggestion that just gained a SECOND kind of source is worth checking again
      const regained = row.status === "suggestion" && sources.filter((s) => s !== "memory").length > (JSON.parse(row.sources) as string[]).filter((s) => s !== "memory").length;
      this.db
        .prepare("UPDATE variant_candidates SET sources = ?, evidence = ?, support = ?, status = ? WHERE parent_id = ? AND kind = ? AND cand_key = ?")
        .run(JSON.stringify(sources), JSON.stringify(evidence), support, regained ? "queued" : row.status, parentId, c.kind, key);
    }
    return added;
  }

  listCandidates(parentId: string, kind?: "variant" | "addon"): StoredCandidate[] {
    const rows = (kind
      ? this.db.prepare("SELECT * FROM variant_candidates WHERE parent_id = ? AND kind = ? ORDER BY first_seen_at, name").all(parentId, kind)
      : this.db.prepare("SELECT * FROM variant_candidates WHERE parent_id = ? ORDER BY kind, first_seen_at, name").all(parentId)) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToCandidate(r));
  }

  /** The next queued names across every product, for the background worker: names never tried come first, then the ones that failed least; a name waiting out a back-off is not offered yet. */
  nextQueuedCandidates(kind: "variant" | "addon", limit: number, now: number = Date.now()): StoredCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM variant_candidates WHERE status = 'queued' AND kind = ? AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY attempts, first_seen_at, name LIMIT ?")
      .all(kind, now, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToCandidate(r));
  }

  /** How many names were checked (any outcome) since this moment: the count against the daily ceiling. */
  countCandidateChecksSince(since: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM variant_candidates WHERE last_checked_at IS NOT NULL AND last_checked_at >= ?").get(since) as { n: number }).n);
  }

  // ---- aliases and the owner's model-fact edits (namingEngine.ts / modelFacts.ts). Used on the creation paths (addProductStub, createManualProduct) and by findMatchingProduct.

  /** Keeps another name for a product. A name that is the product's own name, or one it already has, is not added twice. Returns true when it was added. */
  addProductAlias(productId: string, alias: string, source: string = "rename", now: number = Date.now()): boolean {
    const clean = alias.replace(/\s+/g, " ").trim().slice(0, 160);
    const key = nameKey(clean);
    const row = this.db.prepare("SELECT name FROM products WHERE id = ?").get(productId) as { name: string } | undefined;
    if (!clean || !key || !row || nameKey(row.name) === key) return false;
    const res = this.db.prepare("INSERT OR IGNORE INTO product_name_aliases (product_id, alias, alias_key, source, created_at) VALUES (?, ?, ?, ?, ?)").run(productId, clean, key, source, now);
    return Number(res.changes) > 0;
  }

  listProductAliases(productId: string): Array<{ alias: string; source: string; createdAt: number }> {
    return (this.db.prepare("SELECT alias, source, created_at FROM product_name_aliases WHERE product_id = ? ORDER BY created_at, alias").all(productId) as Array<{ alias: string; source: string; created_at: number }>).map((r) => ({ alias: r.alias, source: r.source, createdAt: r.created_at }));
  }

  /** The product that keeps this name as an alias (null when none, or when two products claim it: an ambiguous alias decides nothing). */
  /** Every kept alias, by product id (one query), for searches that should find an entry by any of its names. */
  aliasesByProduct(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT product_id, alias FROM product_name_aliases ORDER BY created_at").all() as Array<{ product_id: string; alias: string }>) map.set(r.product_id, [...(map.get(r.product_id) ?? []), r.alias]);
    return map;
  }

  findProductIdByAlias(alias: string): string | null {
    const rows = this.db.prepare("SELECT DISTINCT a.product_id id FROM product_name_aliases a JOIN products p ON p.id = a.product_id WHERE a.alias_key = ?").all(nameKey(alias)) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0].id : null;
  }

  setModelFactOverride(canonical: string, patch: { addAliases?: string[]; attrs?: Record<string, string> }, now: number = Date.now()): void {
    const key = nameKey(canonical);
    if (!key) return;
    const row = this.db.prepare("SELECT add_aliases, attrs FROM model_fact_overrides WHERE canonical_key = ?").get(key) as { add_aliases: string; attrs: string } | undefined;
    const aliases = [...new Set([...(row ? (JSON.parse(row.add_aliases) as string[]) : []), ...(patch.addAliases ?? [])])];
    const attrs = { ...(row ? (JSON.parse(row.attrs) as Record<string, string>) : {}), ...(patch.attrs ?? {}) };
    this.db
      .prepare("INSERT INTO model_fact_overrides (canonical_key, canonical, add_aliases, attrs, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(canonical_key) DO UPDATE SET add_aliases = excluded.add_aliases, attrs = excluded.attrs, updated_at = excluded.updated_at")
      .run(key, canonical, JSON.stringify(aliases), JSON.stringify(attrs), now);
  }

  listModelFactOverrides(): Array<{ canonical: string; addAliases: string[]; attrs: Record<string, string> }> {
    return (this.db.prepare("SELECT canonical, add_aliases, attrs FROM model_fact_overrides ORDER BY canonical").all() as Array<{ canonical: string; add_aliases: string; attrs: string }>).map((r) => ({ canonical: r.canonical, addAliases: JSON.parse(r.add_aliases) as string[], attrs: JSON.parse(r.attrs) as Record<string, string> }));
  }

  /** How many names are still waiting (including those in a back-off), for "N waiting to be checked". */
  countQueuedCandidates(): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM variant_candidates WHERE status = 'queued'").get() as { n: number }).n);
  }

  static readonly CANDIDATE_RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

  /**
   * A check of this name FAILED (a blocked search, an unreadable page): it goes to the back of the line with a growing wait, so a name that always fails can never hold up the good ones
   * behind it, and after four failures it is set aside with a visible note instead of being retried forever.
   */
  deferCandidate(parentId: string, kind: "variant" | "addon", key: string, note: string, now: number = Date.now()): "waiting" | "gave_up" {
    const row = this.db.prepare("SELECT attempts FROM variant_candidates WHERE parent_id = ? AND kind = ? AND cand_key = ?").get(parentId, kind, key) as { attempts: number } | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const delay = Store.CANDIDATE_RETRY_DELAYS_MS[attempts - 1];
    // the fourth failed check is the last: three waits, then it is set aside
    if (delay === undefined || attempts >= Store.CANDIDATE_RETRY_DELAYS_MS.length) {
      this.db.prepare("UPDATE variant_candidates SET status = 'skipped', note = ?, attempts = ?, last_checked_at = ?, next_try_at = NULL WHERE parent_id = ? AND kind = ? AND cand_key = ?").run(`could not be checked after ${attempts} tries (${note}); set aside`, attempts, now, parentId, kind, key);
      return "gave_up";
    }
    this.db.prepare("UPDATE variant_candidates SET note = ?, attempts = ?, last_checked_at = ?, next_try_at = ? WHERE parent_id = ? AND kind = ? AND cand_key = ?").run(`could not be checked just now (${note}); will try again`, attempts, now, now + delay, parentId, kind, key);
    return "waiting";
  }

  setCandidateStatus(parentId: string, kind: "variant" | "addon", key: string, status: CandidateStatus, note: string | null, entryId: string | null = null, now: number = Date.now()): void {
    this.db
      .prepare("UPDATE variant_candidates SET status = ?, note = ?, entry_id = COALESCE(?, entry_id), attempts = attempts + 1, last_checked_at = ?, next_try_at = NULL WHERE parent_id = ? AND kind = ? AND cand_key = ?")
      .run(status, note, entryId, now, parentId, kind, key);
  }

  private rowToCandidate(r: Record<string, unknown>): StoredCandidate {
    return {
      parentId: String(r.parent_id),
      kind: r.kind as "variant" | "addon",
      key: String(r.cand_key),
      name: String(r.name),
      sources: JSON.parse(String(r.sources)) as Candidate["sources"],
      evidence: JSON.parse(String(r.evidence)) as string[],
      support: (r.support as "confirmed" | "reported" | null) ?? null,
      status: r.status as CandidateStatus,
      note: (r.note as string | null) ?? null,
      entryId: (r.entry_id as string | null) ?? null,
      attempts: Number(r.attempts),
      nextTryAt: r.next_try_at == null ? null : Number(r.next_try_at),
      firstSeenAt: Number(r.first_seen_at),
      lastCheckedAt: r.last_checked_at == null ? null : Number(r.last_checked_at),
    };
  }

  /** Links an add-on (a row of product_addons) to its own Database entry. */
  setAddonProductId(addonId: string, productId: string | null): boolean {
    return Number(this.db.prepare("UPDATE product_addons SET addon_product_id = ? WHERE id = ?").run(productId, addonId).changes) > 0;
  }

  removeAddon(id: string): boolean {
    const res = this.db.prepare("DELETE FROM product_addons WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM listing_addons WHERE addon_id = ?").run(id);
    return Number(res.changes) > 0;
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
        `SELECT i.product_id, MAX(i.created_at) as latest FROM product_images i JOIN products p ON p.id = i.product_id WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL GROUP BY i.product_id ORDER BY latest DESC LIMIT ?`
      )
      .all(limit) as Array<{ product_id: string }>;
    const result: Array<{ product: ProductProfile; images: ProductImage[] }> = [];
    for (const row of rows) {
      const product = this.getProductById(row.product_id);
      if (!product) continue;
      // Condition-awareness — a poor-condition/damaged reference photo
      // isn't reliable "what does this normally look like" ground truth
      // for vision's own ground-truth comparison use of this list.
      result.push({ product, images: this.listProductImages(row.product_id).filter((img) => img.kind === "normal" && REFERENCE_STATUSES.has(img.status)) });
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
    const rows = this.db.prepare("SELECT id FROM products WHERE prioritized = 1 AND deleted_at IS NULL").all() as Array<{ id: string }>;
    const result: Array<{ product: ProductProfile; images: ProductImage[] }> = [];
    for (const row of rows) {
      const product = this.getProductById(row.id);
      if (!product) continue;
      // Condition-awareness — same reasoning as listProductsWithImages above.
      const images = this.listProductImages(row.id).filter((img) => img.kind === "normal" && REFERENCE_STATUSES.has(img.status));
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
  /** What is saved about an already-seen listing, for deciding whether it deserves another look (relisting.reevaluationReason). null when it is not saved. */
  getListingState(id: string): SavedListingState | null {
    const row = this.db
      .prepare(
        `SELECT l.price, l.research_status, l.research_code, l.is_deal, l.notified, l.first_seen_at, r.count AS reeval_count, r.last_at AS reeval_at
         FROM listings l LEFT JOIN listing_reeval r ON r.listing_id = l.id WHERE l.id = ?`
      )
      .get(id) as any;
    if (!row) return null;
    return {
      price: row.price ?? null,
      researchStatus: row.research_status ?? null,
      researchCode: row.research_code ?? null,
      isDeal: !!row.is_deal,
      notified: !!row.notified,
      firstSeenAt: row.first_seen_at,
      reevalCount: row.reeval_count ?? 0,
      lastReevalAt: row.reeval_at ?? null,
    };
  }

  noteReevaluation(id: string): void {
    this.db.prepare("INSERT INTO listing_reeval (listing_id, count, last_at) VALUES (?, 1, ?) ON CONFLICT(listing_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at").run(id, Date.now());
  }

  /** Listings kept as "worth a look" for want of evidence that the saved record could now settle (no page visit needed), newest first. */
  listRequalifyCandidates(sinceMs: number, limit: number): string[] {
    const codes = REQUALIFY_CODES.map((c) => `'${c}'`).join(",");
    const rows = this.db
      .prepare(
        `SELECT id FROM listings WHERE is_deal = 0 AND notified = 0 AND matched_item IS NOT NULL AND price IS NOT NULL AND first_seen_at >= ?
           AND research_status = 'insufficient_evidence' AND research_code IN (${codes}) ORDER BY first_seen_at DESC LIMIT ?`
      )
      .all(sinceMs, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** How many saved listings are in each stage of their life (listingLifecycle.ts): the Dashboard's honest "evaluated" numbers. */
  lifecycleCounts(): LifecycleCounts {
    const rows = this.db
      .prepare(
        `SELECT research_status AS status, research_code AS code, is_deal AS deal, (CASE WHEN description IS NOT NULL AND length(description) > 0 THEN 1 ELSE 0 END) AS opened, COUNT(*) AS n
         FROM listings GROUP BY research_status, research_code, is_deal, opened`
      )
      .all() as Array<{ status: string | null; code: string | null; deal: number; opened: number; n: number }>;
    return countLifecycle(rows.map((r) => ({ status: r.status, code: r.code, isDeal: !!r.deal, opened: !!r.opened, n: r.n })));
  }

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
    conditionAssessment: row.condition_json ? (safeJson(row.condition_json) as ListingRecord["conditionAssessment"]) : null,
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
    researchStatus:
      row.research_status === "unresearched" || row.research_status === "insufficient_evidence" || row.research_status === "rejected" || row.research_status === "confirmed_unprofitable" || row.research_status === "researched"
        ? row.research_status
        : null,
    researchCode: row.research_code ?? null,
    researchReason: row.research_reason ?? null,
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
  if (extra.some((t) => /^\d+(gb|tb|mb)$/i.test(t))) return false;
  // A special/limited/themed edition is a product of its own (own sales, own price), not the standard entry with a few more words in the
  // title: "Xbox Series X Special Edition" and "Xbox Series X" do not share an entry or a value. Both names must say the same edition words.
  const editionA = extractVariantAttributes(a).editionTerms;
  const editionB = extractVariantAttributes(b).editionTerms;
  if (editionA.length !== editionB.length || editionA.some((t) => !editionB.includes(t))) return false;
  return true;
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
    folderId: row.folder_id ?? null,
    nameLocked: !!row.name_locked,
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
    variantEvidence: parseVerdict(row.variant_evidence),
    variantClaims: parseVerdictList(row.variant_claims),
    researchState: row.research_state === "failed" || row.research_state === "unsourced" ? row.research_state : null,
    researchNote: row.research_note ?? null,
    compsValidation: parseCompsValidation(row.comps_validation),
    loading: !!row.loading,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

const VERDICT_STATUSES = new Set(["verified", "supported", "unverified", "disproven"]);

function parseVerdict(raw: unknown): VariantVerdict | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as VariantVerdict;
    return v && typeof v.claim === "string" && VERDICT_STATUSES.has(v.status) ? v : null;
  } catch {
    return null;
  }
}

function parseVerdictList(raw: unknown): VariantVerdict[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((v): v is VariantVerdict => !!v && typeof v.claim === "string" && VERDICT_STATUSES.has(v.status)) : [];
  } catch {
    return [];
  }
}

function parseCompsValidation(raw: unknown): ProductProfile["compsValidation"] {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Small enough to keep with a product: no page text, a handful of sources. */
export function compactVerdict(v: VariantVerdict): VariantVerdict {
  return { ...v, sources: v.sources.filter((s) => s.fullMatch || s.matched.length > 0).slice(0, 6).map((s) => ({ ...s, excerpt: undefined })) };
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
    status: ["trusted", "user", "legacy", "unverified", "needs_review", "quarantined"].includes(row.status) ? row.status : "legacy",
    sourceKind: row.source_kind ?? null,
    sourceUrl: row.source_url ?? null,
    isPrimary: !!row.is_primary,
    sortOrder: Number(row.sort_order ?? 0),
    contentHash: row.content_hash ?? null,
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

function rowToFolderMeta(r: any): FolderMetaRecord {
  return { id: r.id, displayName: r.display_name ?? null, thumbData: r.thumb_data ?? null, thumbSource: (r.thumb_source ?? null) as ThumbSource | null, thumbLocked: !!r.thumb_locked, thumbMeta: r.thumb_meta ? (safeJson(r.thumb_meta) as Record<string, unknown> | null) : null, updatedAt: Number(r.updated_at) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
