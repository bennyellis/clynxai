// The sold-comps tables. NEW tables only (sold_comps, sold_comp_matches, sold_comp_lookups); no existing table is read or changed. It takes any node:sqlite database, so the harness and the
// tests use an in-memory one and the real Database can be handed in later without a rewrite.
import type { DatabaseSync } from "node:sqlite";
import type { SoldComp, SoldSource, ProviderOutcome } from "./types.js";

export interface StoredMatch {
  compId: string;
  productId: string;
  identityVerdict: "exact" | "compatible" | "uncertain" | "rejected";
  reason: string;
  photoCheck: string | null;
  accepted: boolean;
  judgedAt: number;
}

export interface LookupRecord {
  queryKey: string;
  day: string;
  provider: SoldSource;
  outcomeKind: ProviderOutcome["kind"];
  detail: string;
  compIds: string[];
  at: number;
}

export const queryKeyOf = (title: string, gtin?: string | null, epid?: string | null) => `${(gtin ?? "").trim()}|${(epid ?? "").trim()}|${title.toLowerCase().replace(/\s+/g, " ").trim()}`;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class SoldCompsStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sold_comps (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_listing_id TEXT, title TEXT NOT NULL, sold_price REAL NOT NULL, currency TEXT NOT NULL,
        sold_at INTEGER, condition TEXT, shipping_cost REAL, quantity_sold INTEGER, buying_option TEXT, gtin TEXT, epid TEXT, category_id TEXT, image_url TEXT,
        seller TEXT, fetched_at INTEGER NOT NULL, expires_at INTEGER, raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sold_comps_source ON sold_comps(source);
      CREATE INDEX IF NOT EXISTS idx_sold_comps_expires ON sold_comps(expires_at);
      CREATE TABLE IF NOT EXISTS sold_comp_matches (
        comp_id TEXT NOT NULL, product_id TEXT NOT NULL, identity_verdict TEXT NOT NULL, reason TEXT NOT NULL, photo_check TEXT, accepted INTEGER NOT NULL, judged_at INTEGER NOT NULL,
        PRIMARY KEY (comp_id, product_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sold_comp_matches_product ON sold_comp_matches(product_id, accepted);
      CREATE TABLE IF NOT EXISTS sold_comp_lookups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, query_key TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, outcome_kind TEXT NOT NULL, detail TEXT NOT NULL, comp_ids TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sold_comp_lookups_key ON sold_comp_lookups(query_key, day, provider);
    `);
  }

  upsertComps(comps: SoldComp[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO sold_comps (id, source, source_listing_id, title, sold_price, currency, sold_at, condition, shipping_cost, quantity_sold, buying_option, gtin, epid, category_id, image_url, seller, fetched_at, expires_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, sold_price = excluded.sold_price, currency = excluded.currency, sold_at = COALESCE(excluded.sold_at, sold_at), condition = excluded.condition,
         shipping_cost = excluded.shipping_cost, quantity_sold = excluded.quantity_sold, buying_option = excluded.buying_option, gtin = COALESCE(excluded.gtin, gtin), epid = COALESCE(excluded.epid, epid),
         category_id = COALESCE(excluded.category_id, category_id), image_url = COALESCE(excluded.image_url, image_url), seller = excluded.seller, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, raw_json = excluded.raw_json`
    );
    this.db.exec("BEGIN");
    try {
      for (const c of comps) {
        stmt.run(c.id, c.source, c.sourceListingId, c.title, c.soldPrice, c.currency, c.soldAt, c.condition, c.shippingCost, c.quantitySold, c.buyingOption, c.gtin, c.epid, c.categoryId, c.imageUrl, c.seller, c.fetchedAt, c.expiresAt, JSON.stringify(c.raw ?? null));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private rowToComp(r: Record<string, unknown>): SoldComp {
    return {
      id: String(r.id),
      source: r.source as SoldSource,
      sourceListingId: (r.source_listing_id as string | null) ?? null,
      title: String(r.title),
      soldPrice: Number(r.sold_price),
      currency: String(r.currency),
      soldAt: r.sold_at == null ? null : Number(r.sold_at),
      condition: (r.condition as string | null) ?? null,
      shippingCost: r.shipping_cost == null ? null : Number(r.shipping_cost),
      quantitySold: r.quantity_sold == null ? null : Number(r.quantity_sold),
      buyingOption: (r.buying_option as string | null) ?? null,
      gtin: (r.gtin as string | null) ?? null,
      epid: (r.epid as string | null) ?? null,
      categoryId: (r.category_id as string | null) ?? null,
      imageUrl: (r.image_url as string | null) ?? null,
      seller: (r.seller as string | null) ?? null,
      fetchedAt: Number(r.fetched_at),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
      raw: r.raw_json ? JSON.parse(String(r.raw_json)) : null,
    };
  }

  listComps(source?: SoldSource): SoldComp[] {
    const rows = (source ? this.db.prepare("SELECT * FROM sold_comps WHERE source = ?").all(source) : this.db.prepare("SELECT * FROM sold_comps").all()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToComp(r));
  }

  getComps(ids: string[]): SoldComp[] {
    if (ids.length === 0) return [];
    const stmt = this.db.prepare("SELECT * FROM sold_comps WHERE id = ?");
    return ids.map((id) => stmt.get(id) as Record<string, unknown> | undefined).filter((r): r is Record<string, unknown> => !!r).map((r) => this.rowToComp(r));
  }

  /** Retention: remove rows past their expiry (and their matches). Returns how many comps went. */
  purgeExpired(now: number): number {
    const ids = (this.db.prepare("SELECT id FROM sold_comps WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare("DELETE FROM sold_comp_matches WHERE comp_id = ?").run(id);
      this.db.prepare("DELETE FROM sold_comps WHERE id = ?").run(id);
    }
    return ids.length;
  }

  saveMatch(m: StoredMatch): void {
    this.db
      .prepare(
        "INSERT INTO sold_comp_matches (comp_id, product_id, identity_verdict, reason, photo_check, accepted, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(comp_id, product_id) DO UPDATE SET identity_verdict = excluded.identity_verdict, reason = excluded.reason, photo_check = excluded.photo_check, accepted = excluded.accepted, judged_at = excluded.judged_at"
      )
      .run(m.compId, m.productId, m.identityVerdict, m.reason, m.photoCheck, m.accepted ? 1 : 0, m.judgedAt);
  }

  matchesFor(productId: string, onlyAccepted = false): StoredMatch[] {
    const rows = this.db.prepare(`SELECT * FROM sold_comp_matches WHERE product_id = ?${onlyAccepted ? " AND accepted = 1" : ""}`).all(productId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      compId: String(r.comp_id),
      productId: String(r.product_id),
      identityVerdict: r.identity_verdict as StoredMatch["identityVerdict"],
      reason: String(r.reason),
      photoCheck: (r.photo_check as string | null) ?? null,
      accepted: Number(r.accepted) === 1,
      judgedAt: Number(r.judged_at),
    }));
  }

  recordLookup(l: LookupRecord): void {
    this.db.prepare("INSERT INTO sold_comp_lookups (query_key, day, provider, outcome_kind, detail, comp_ids, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(l.queryKey, l.day, l.provider, l.outcomeKind, l.detail, JSON.stringify(l.compIds), l.at);
  }

  /** Today's answer for this query from this provider, when it was a real answer (ok or none). A blocked / error / disabled attempt is logged but never cached, so it is tried again. */
  cachedLookup(queryKey: string, day: string, provider: SoldSource): LookupRecord | null {
    const r = this.db
      .prepare("SELECT * FROM sold_comp_lookups WHERE query_key = ? AND day = ? AND provider = ? AND outcome_kind IN ('ok', 'none') ORDER BY id DESC LIMIT 1")
      .get(queryKey, day, provider) as Record<string, unknown> | undefined;
    return r ? { queryKey, day, provider, outcomeKind: r.outcome_kind as ProviderOutcome["kind"], detail: String(r.detail), compIds: JSON.parse(String(r.comp_ids)), at: Number(r.at) } : null;
  }

  lookupsFor(queryKey: string): LookupRecord[] {
    const rows = this.db.prepare("SELECT * FROM sold_comp_lookups WHERE query_key = ? ORDER BY id").all(queryKey) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ queryKey, day: String(r.day), provider: r.provider as SoldSource, outcomeKind: r.outcome_kind as ProviderOutcome["kind"], detail: String(r.detail), compIds: JSON.parse(String(r.comp_ids)), at: Number(r.at) }));
  }
}
