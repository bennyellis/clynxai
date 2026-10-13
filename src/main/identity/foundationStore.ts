// Stage 3a persistence: the tables of the Database identity foundation and the background backfill that fills them. This is the ONLY code that writes
// to them, and it writes to nothing else: every INSERT / UPDATE / DELETE / DROP below names one of the identity tables. The pre-existing tables
// (products, listings, product_images, watches ...) are only ever read. The whole thing exists only when the foundation is switched on in the config;
// off, no table is created and no code here runs.
//
// What is stored is evidence and candidates, never decisions: no product is merged, split, renamed, deleted or re-pointed, and no relation or alias is
// confirmed except by an explicit call that records who decided and why (and can be reverted from the audit log).
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { aliasCovered, codesMissingFrom, definingCodes } from "./codes.js";
import { assessCodes, CodeIndex, type EvidenceDoc } from "./credibility.js";
import { aliasCandidatesFor, buildProductIdentity, classifyRelation, hashInputs, identityTermsOf, IDENTITY_VERSION, type RelationCandidate, type RelationKind, type RelationStatus } from "./foundation.js";
import { identityTokens } from "./resolver.js";
import { NOISE_WORDS } from "./words.js";

export const IDENTITY_TABLES = ["identity_meta", "product_identity", "identity_terms", "product_relations", "product_aliases", "listing_identity", "identity_audit"] as const;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS identity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS product_identity (
    product_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    level TEXT NOT NULL,
    identity_key TEXT,
    confidence REAL NOT NULL,
    attributes_json TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_product_identity_key ON product_identity(identity_key);
  CREATE TABLE IF NOT EXISTS identity_terms (
    product_id TEXT NOT NULL,
    term TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (product_id, term, kind)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_identity_terms_term ON identity_terms(term, kind);
  CREATE TABLE IF NOT EXISTS product_relations (
    id TEXT PRIMARY KEY,
    from_product_id TEXT NOT NULL,
    to_product_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    ambiguity_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    decision_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_product_relations ON product_relations(from_product_id, to_product_id, relation);
  CREATE INDEX IF NOT EXISTS idx_product_relations_to ON product_relations(to_product_id);
  CREATE INDEX IF NOT EXISTS idx_product_relations_status ON product_relations(status);
  CREATE TABLE IF NOT EXISTS product_aliases (
    id TEXT PRIMARY KEY,
    alias_norm TEXT NOT NULL,
    alias_text TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    source TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    decision_note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_product_aliases ON product_aliases(alias_norm, product_id);
  CREATE INDEX IF NOT EXISTS idx_product_aliases_norm ON product_aliases(alias_norm);
  CREATE TABLE IF NOT EXISTS listing_identity (
    listing_id TEXT PRIMARY KEY,
    best_product_id TEXT,
    stored_product_id TEXT,
    level TEXT NOT NULL,
    confidence REAL NOT NULL,
    extras_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identity_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_identity_audit_entity ON identity_audit(entity, entity_id);
`;

type Row = Record<string, unknown>;
const now = () => Date.now();
const normAlias = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface BackfillStatus {
  phase: "products" | "relations" | "aliases" | "listings" | "done";
  cursor: string;
  startedAt: number | null;
  completedAt: number | null;
}

export interface Candidate {
  productId: string;
  name: string;
  score: number;
  sharedTerms: string[];
}

export class IdentityFoundation {
  private index: CodeIndex | null = null;
  private names = new Map<string, string>();

  // Prepared statements are kept and reused (preparing the same SQL thousands of times during a backfill churns native memory).
  private statements = new Map<string, StatementSync>();
  private p(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

  constructor(private db: DatabaseSync) {}

  // ---------- schema

  /** Creates the tables (idempotent). Touches no existing table. */
  init(): void {
    this.db.exec(SCHEMA);
    this.p("INSERT OR IGNORE INTO identity_meta (key, value) VALUES ('schema_version', ?)").run(String(IDENTITY_VERSION));
  }

  /** Removes every identity table. Nothing else is touched; the decisions can be exported first (exportDecisions). */
  drop(): void {
    this.statements.clear();
    this.db.exec("BEGIN");
    try {
      for (const t of IDENTITY_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- audit

  private audit(actor: string, action: string, entity: string, entityId: string, before: unknown, after: unknown, note?: string): number {
    const r = this.db
      .prepare("INSERT INTO identity_audit (at, actor, action, entity, entity_id, before_json, after_json, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(now(), actor, action, entity, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), note ?? null);
    return Number(r.lastInsertRowid);
  }

  // ---------- backfill (resumable, idempotent, time-boxed)

  private meta(key: string): string | null {
    return ((this.p("SELECT value FROM identity_meta WHERE key = ?").get(key) as Row | undefined)?.value as string | undefined) ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.p("INSERT INTO identity_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  backfillStatus(): BackfillStatus {
    const phase = (this.meta("backfill_phase") ?? "products") as BackfillStatus["phase"];
    return { phase, cursor: this.meta("backfill_cursor") ?? "", startedAt: Number(this.meta("backfill_started_at")) || null, completedAt: Number(this.meta("backfill_completed_at")) || null };
  }

  /** Starts the backfill over (derived data is rebuilt; decisions already recorded are kept). */
  resetBackfill(): void {
    for (const k of ["backfill_phase", "backfill_cursor", "backfill_started_at", "backfill_completed_at"]) this.p("DELETE FROM identity_meta WHERE key = ?").run(k);
    this.index = null;
  }

  private loadNames(): void {
    if (this.names.size > 0) return;
    for (const p of this.p("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>) this.names.set(p.id, p.name);
  }

  // Evidence for the backfill's corroboration checks: entry names and listing titles. Reference-photo titles are deliberately NOT read here: they sit in
  // rows that also hold the photos, so reading all of them is a long synchronous read on a big library (each product's own photo titles are read one product
  // at a time in filedTitles instead).
  private buildIndex(): CodeIndex {
    if (this.index) return this.index;
    const docs: EvidenceDoc[] = [];
    for (const p of this.p("SELECT id, name FROM products").all() as Array<{ id: string; name: string }>) docs.push({ text: p.name, origin: `product:${p.id}`, kind: "product" });
    for (const l of this.p("SELECT title, seller_name FROM listings").all() as Array<{ title: string; seller_name: string | null }>) {
      docs.push({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" });
    }
    this.index = new CodeIndex(docs);
    return this.index;
  }

  private filedTitles(productId: string): string[] {
    const photos = (this.p("SELECT source_title FROM product_images WHERE product_id = ? AND source_title IS NOT NULL").all(productId) as Array<{ source_title: string }>).map((r) => r.source_title);
    const listings = (this.p("SELECT title FROM listings WHERE product_id = ?").all(productId) as Array<{ title: string }>).map((r) => r.title);
    return [...photos, ...listings];
  }

  /**
   * Does a bounded amount of work (about `budgetMs`) and returns. Call it again later until `done`. Safe to stop at any point (a crash included): the
   * cursor is saved with each batch and every write is an upsert, so resuming repeats nothing harmful.
   */
  backfillStep(budgetMs = 10): { done: boolean; phase: BackfillStatus["phase"]; processed: number } {
    const status = this.backfillStatus();
    if (status.phase === "done") return { done: true, phase: "done", processed: 0 };
    if (!status.startedAt) this.setMeta("backfill_started_at", String(now()));
    const t0 = performance.now();
    let processed = 0;
    let phase: BackfillStatus["phase"] = status.phase;
    let cursor = status.cursor;
    this.db.exec("BEGIN");
    try {
      // at least one batch per call, so a tiny budget still makes progress
      let first = true;
      while ((first || performance.now() - t0 < budgetMs) && phase !== "done") {
        first = false;
        const r = this.stepPhase(phase, cursor, t0 + budgetMs);
        processed += r.processed;
        if (r.finished) {
          phase = ({ products: "relations", relations: "aliases", aliases: "listings", listings: "done" } as const)[phase as "products" | "relations" | "aliases" | "listings"];
          cursor = "";
        } else cursor = r.cursor;
      }
      this.setMeta("backfill_phase", phase);
      this.setMeta("backfill_cursor", cursor);
      if (phase === "done") this.setMeta("backfill_completed_at", String(now()));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (phase === "done") {
      this.index = null;
      this.names.clear();
    }
    return { done: phase === "done", phase, processed };
  }

  // Processes the rows of one phase one at a time until the deadline (always at least one) and reports where it got to. A phase is finished when a
  // batch comes back short; running out of time mid-batch just means the next call resumes after the last row done.
  private stepPhase(phase: string, cursor: string, deadline: number): { finished: boolean; cursor: string; processed: number } {
    const BATCH = 10;
    let processed = 0;
    let last = cursor;
    const run = <T extends { id: string }>(rows: T[], work: (r: T) => void): boolean => {
      for (const r of rows) {
        if (processed > 0 && performance.now() > deadline) return false;
        work(r);
        processed++;
        last = r.id;
      }
      return rows.length < BATCH;
    };
    const products = () => this.p("SELECT id, name FROM products WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BATCH) as Array<{ id: string; name: string }>;
    let finished: boolean;
    if (phase === "products") {
      finished = run(products(), (p) => this.computeProduct(p.id, p.name));
    } else if (phase === "relations") {
      this.loadNames();
      finished = run(products(), (p) => {
        for (const q of this.candidates(p.name, 40, p.id)) this.proposeRelation({ id: p.id, name: p.name }, { id: q.productId, name: q.name });
      });
    } else if (phase === "aliases") {
      finished = run(products(), (p) => this.proposeAliases(p.id, p.name));
    } else {
      this.loadNames();
      const rows = this.p("SELECT id, title, product_id, seller_name FROM listings WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BATCH) as Array<{ id: string; title: string; product_id: string | null; seller_name: string | null }>;
      finished = run(rows, (l) => this.computeListing(l));
    }
    return { finished, cursor: last, processed };
  }

  private computeProduct(id: string, name: string): void {
    const titles = this.filedTitles(id);
    const hash = hashInputs(name, titles);
    const existing = this.p("SELECT source_hash, version FROM product_identity WHERE product_id = ?").get(id) as Row | undefined;
    if (existing && existing.source_hash === hash && existing.version === IDENTITY_VERSION) return;
    const index = this.buildIndex();
    const corroborated: Array<{ code: string; reason: string }> = [];
    for (const code of definingCodes(name)) {
      const origins = new Set(index.docsWith(code).filter((d) => d.origin !== `product:${id}`).map((d) => d.origin));
      if (origins.size >= 2) corroborated.push({ code, reason: "seen-in-multiple-sources" });
    }
    const row = buildProductIdentity({ productId: id, name, filedTitles: titles, corroborated });
    this.db
      .prepare(
        `INSERT INTO product_identity (product_id, version, level, identity_key, confidence, attributes_json, unresolved_json, evidence_json, source_hash, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET version = excluded.version, level = excluded.level, identity_key = excluded.identity_key, confidence = excluded.confidence,
           attributes_json = excluded.attributes_json, unresolved_json = excluded.unresolved_json, evidence_json = excluded.evidence_json, source_hash = excluded.source_hash, computed_at = excluded.computed_at`
      )
      .run(id, row.version, row.level, row.identityKey, row.confidence, JSON.stringify(row.attributes), JSON.stringify(row.unresolved), JSON.stringify(row.evidence), row.sourceHash, now());
    this.p("DELETE FROM identity_terms WHERE product_id = ?").run(id);
    const ins = this.p("INSERT OR IGNORE INTO identity_terms (product_id, term, kind) VALUES (?, ?, ?)");
    for (const t of identityTermsOf(name)) ins.run(id, t.term, t.kind);
  }

  private proposeRelation(a: { id: string; name: string }, b: { id: string; name: string }): void {
    const rel = classifyRelation(a, b);
    if (!rel) return;
    this.upsertRelation(rel);
  }

  private upsertRelation(rel: RelationCandidate): void {
    const existing = this.p("SELECT id, status FROM product_relations WHERE from_product_id = ? AND to_product_id = ? AND relation = ?").get(rel.fromProductId, rel.toProductId, rel.relation) as Row | undefined;
    if (existing) {
      // A decided relation (confirmed / rejected) is never touched by the backfill.
      if (existing.status === "candidate") {
        this.p("UPDATE product_relations SET confidence = ?, evidence_json = ?, ambiguity_json = ?, updated_at = ? WHERE id = ?").run(rel.confidence, JSON.stringify(rel.evidence), JSON.stringify(rel.ambiguity), now(), existing.id as string);
      }
      return;
    }
    const id = randomUUID();
    const t = now();
    this.db
      .prepare("INSERT INTO product_relations (id, from_product_id, to_product_id, relation, role, status, confidence, evidence_json, ambiguity_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)")
      .run(id, rel.fromProductId, rel.toProductId, rel.relation, rel.role, rel.confidence, JSON.stringify(rel.evidence), JSON.stringify(rel.ambiguity), t, t);
    this.audit("backfill", "propose", "relation", id, null, { ...rel, status: "candidate" });
  }

  private proposeAliases(productId: string, name: string): void {
    const titles = this.filedTitles(productId);
    for (const c of aliasCandidatesFor({ name, titles, isCovered: aliasCovered })) {
      const norm = normAlias(c.alias);
      const existing = this.p("SELECT id, status FROM product_aliases WHERE alias_norm = ? AND product_id = ?").get(norm, productId) as Row | undefined;
      const confidence = Math.min(0.7, 0.3 + 0.1 * c.support);
      const evidence = JSON.stringify({ method: "short-form-in-filed-titles/v1", support: c.support, examples: c.examples, name });
      if (existing) {
        if (existing.status === "candidate") this.p("UPDATE product_aliases SET confidence = ?, evidence_json = ?, updated_at = ? WHERE id = ?").run(confidence, evidence, now(), existing.id as string);
        continue;
      }
      const id = randomUUID();
      const t = now();
      this.db
        .prepare("INSERT INTO product_aliases (id, alias_norm, alias_text, product_id, status, source, confidence, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'candidate', 'short-form', ?, ?, ?, ?)")
        .run(id, norm, c.alias, productId, confidence, evidence, t, t);
      this.audit("backfill", "propose", "alias", id, null, { alias: c.alias, productId, status: "candidate", confidence });
    }
  }

  private computeListing(l: { id: string; title: string; product_id: string | null; seller_name: string | null }): void {
    const tokens = identityTokens(l.title);
    const cands = this.candidates(l.title, 25);
    const fits = cands
      .map((c) => ({ c, n: identityTokens(c.name) }))
      .filter(({ n }) => n.words.size >= 2 && [...n.words].every((w) => tokens.words.has(w)) && (n.capacities.size === 0 || [...n.capacities].some((x) => tokens.capacities.has(x))))
      .map(({ c, n }) => ({ id: c.productId, name: c.name, covered: n.words.size + n.capacities.size, extra: codesMissingFrom(c.name, l.title) }));
    fits.sort((x, y) => x.extra.length - y.extra.length || y.covered - x.covered);
    const best = fits[0] ?? null;
    const tie = best ? fits.filter((f) => f.extra.length === best.extra.length && f.covered === best.covered).length > 1 : false;
    let extras: Row = { credible: [], unverified: [], dismissed: [] };
    if (best && best.extra.length > 0) {
      const a = assessCodes({ entryId: best.id, entryName: best.name, title: l.title, index: this.buildIndex(), seller: l.seller_name });
      extras = { credible: a.credible, unverified: a.unverified, dismissed: a.dismissed };
    }
    const unresolved: string[] = [];
    if (!best) unresolved.push("no Database product's stated words are all in the title");
    if (tie) unresolved.push("more than one product fits equally well");
    if (best && (extras.credible as unknown[]).length > 0) unresolved.push("the title states a model or version marker the product's name lacks");
    const level = !best ? "unknown" : (extras.credible as unknown[]).length > 0 ? "line" : tie ? "line" : "exact";
    const confidence = !best ? 0.1 : Math.max(0.2, (level === "exact" ? 0.7 : 0.45) - (tie ? 0.15 : 0));
    this.db
      .prepare(
        `INSERT INTO listing_identity (listing_id, best_product_id, stored_product_id, level, confidence, extras_json, evidence_json, unresolved_json, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET best_product_id = excluded.best_product_id, stored_product_id = excluded.stored_product_id, level = excluded.level, confidence = excluded.confidence,
           extras_json = excluded.extras_json, evidence_json = excluded.evidence_json, unresolved_json = excluded.unresolved_json, computed_at = excluded.computed_at`
      )
      .run(l.id, best?.id ?? null, l.product_id, level, Number(confidence.toFixed(2)), JSON.stringify(extras), JSON.stringify({ method: "title-fit/v1", considered: fits.slice(0, 3).map((f) => ({ productId: f.id, name: f.name, extraCodes: f.extra })) }), JSON.stringify(unresolved), now());
  }

  // ---------- candidate retrieval (indexed)

  /**
   * The products that share the most distinctive terms with `text`, found through the term index (never a scan of the products). A term that
   * almost every product has says little and is skipped unless it is all there is.
   */
  candidates(text: string, limit = 20, excludeProductId?: string): Candidate[] {
    this.loadNames();
    const t = identityTokens(text);
    const terms = [...new Set([...t.words, ...t.capacities, ...definingCodes(text)])].filter((w) => !NOISE_WORDS.has(w));
    if (terms.length === 0) return [];
    const POSTING_CAP = 400;
    const postings: Array<{ term: string; ids: string[] }> = [];
    const select = this.p("SELECT product_id FROM identity_terms WHERE term = ? LIMIT ?");
    for (const term of terms) {
      const ids = (select.all(term, POSTING_CAP + 1) as Array<{ product_id: string }>).map((r) => r.product_id);
      if (ids.length > 0) postings.push({ term, ids });
    }
    const usable = postings.filter((p) => p.ids.length <= POSTING_CAP);
    const lists = usable.length > 0 ? usable : postings;
    const score = new Map<string, { s: number; terms: string[] }>();
    for (const p of lists) {
      const weight = 1 / Math.log2(2 + p.ids.length);
      for (const id of p.ids) {
        if (id === excludeProductId) continue;
        const row = score.get(id) ?? { s: 0, terms: [] };
        row.s += weight;
        row.terms.push(p.term);
        score.set(id, row);
      }
    }
    return [...score]
      .sort((a, b) => b[1].s - a[1].s)
      .slice(0, limit)
      .map(([id, v]) => ({ productId: id, name: this.names.get(id) ?? (this.p("SELECT name FROM products WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "", score: Number(v.s.toFixed(3)), sharedTerms: v.terms }))
      .filter((c) => c.name !== "");
  }

  // ---------- reading

  getProductIdentity(productId: string): Row | null {
    return (this.p("SELECT * FROM product_identity WHERE product_id = ?").get(productId) as Row | undefined) ?? null;
  }

  listRelations(filter: { status?: RelationStatus; relation?: RelationKind; productId?: string } = {}): Row[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    if (filter.relation) (where.push("relation = ?"), args.push(filter.relation));
    if (filter.productId) (where.push("(from_product_id = ? OR to_product_id = ?)"), args.push(filter.productId, filter.productId));
    return this.p(`SELECT * FROM product_relations ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`).all(...args) as Row[];
  }

  listAliases(filter: { status?: RelationStatus; productId?: string } = {}): Row[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    if (filter.productId) (where.push("product_id = ?"), args.push(filter.productId));
    return this.p(`SELECT * FROM product_aliases ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`).all(...args) as Row[];
  }

  stats(): Record<string, number> {
    const n = (sql: string) => Number((this.p(sql).get() as { n: number }).n);
    return {
      identities: n("SELECT COUNT(*) AS n FROM product_identity"),
      terms: n("SELECT COUNT(*) AS n FROM identity_terms"),
      relations: n("SELECT COUNT(*) AS n FROM product_relations"),
      relationsCandidate: n("SELECT COUNT(*) AS n FROM product_relations WHERE status = 'candidate'"),
      aliases: n("SELECT COUNT(*) AS n FROM product_aliases"),
      aliasesCandidate: n("SELECT COUNT(*) AS n FROM product_aliases WHERE status = 'candidate'"),
      listings: n("SELECT COUNT(*) AS n FROM listing_identity"),
      audit: n("SELECT COUNT(*) AS n FROM identity_audit"),
    };
  }

  // ---------- decisions (explicit, recorded, reversible)

  decideRelation(id: string, status: RelationStatus, by: string, note?: string): void {
    const before = this.p("SELECT * FROM product_relations WHERE id = ?").get(id) as Row | undefined;
    if (!before) throw new Error("no such relation");
    const t = now();
    this.p("UPDATE product_relations SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(status, status === "candidate" ? null : t, status === "candidate" ? null : by, note ?? null, t, id);
    const after = this.p("SELECT * FROM product_relations WHERE id = ?").get(id);
    this.audit(by, `decide:${status}`, "relation", id, before, after, note);
  }

  decideAlias(id: string, status: RelationStatus, by: string, note?: string): void {
    const before = this.p("SELECT * FROM product_aliases WHERE id = ?").get(id) as Row | undefined;
    if (!before) throw new Error("no such alias");
    const t = now();
    this.p("UPDATE product_aliases SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(status, status === "candidate" ? null : t, status === "candidate" ? null : by, note ?? null, t, id);
    const after = this.p("SELECT * FROM product_aliases WHERE id = ?").get(id);
    this.audit(by, `decide:${status}`, "alias", id, before, after, note);
  }

  /** Undoes one audited change (a proposal or a decision) if it is the most recent change to that entity. */
  revertAudit(auditId: number): void {
    const a = this.p("SELECT * FROM identity_audit WHERE id = ?").get(auditId) as Row | undefined;
    if (!a) throw new Error("no such audit entry");
    const latest = this.p("SELECT MAX(id) AS m FROM identity_audit WHERE entity = ? AND entity_id = ?").get(a.entity as string, a.entity_id as string) as { m: number };
    if (latest.m !== auditId) throw new Error("a newer change exists for this item: revert that one first");
    const table = a.entity === "relation" ? "product_relations" : a.entity === "alias" ? "product_aliases" : null;
    if (!table) throw new Error("this kind of entry cannot be reverted");
    const before = a.before_json ? (JSON.parse(a.before_json as string) as Row) : null;
    this.db.exec("BEGIN");
    try {
      if (before === null) this.p(`DELETE FROM ${table} WHERE id = ?`).run(a.entity_id as string);
      else {
        const cols = Object.keys(before).filter((k) => k !== "id");
        this.p(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...(cols.map((c) => before[c] ?? null) as never[]), a.entity_id as string);
      }
      this.audit("system", `revert:${a.action}`, a.entity as string, a.entity_id as string, a.after_json ? JSON.parse(a.after_json as string) : null, before, `reverts audit ${auditId}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------- maintenance

  /** Called when a product is deleted by the app: its identity rows go with it (the audit log keeps what they were). */
  forgetProduct(productId: string): void {
    const rels = this.p("SELECT * FROM product_relations WHERE from_product_id = ? OR to_product_id = ?").all(productId, productId) as Row[];
    for (const r of rels) this.audit("system", "forget", "relation", r.id as string, r, null, `product ${productId} deleted`);
    this.p("DELETE FROM product_relations WHERE from_product_id = ? OR to_product_id = ?").run(productId, productId);
    this.p("DELETE FROM product_aliases WHERE product_id = ?").run(productId);
    this.p("DELETE FROM identity_terms WHERE product_id = ?").run(productId);
    this.p("DELETE FROM product_identity WHERE product_id = ?").run(productId);
    this.p("DELETE FROM listing_identity WHERE best_product_id = ? OR stored_product_id = ?").run(productId, productId);
    this.names.delete(productId);
  }

  forgetAllProducts(): void {
    for (const t of ["product_relations", "product_aliases", "identity_terms", "product_identity", "listing_identity"]) this.db.exec(`DELETE FROM ${t}`);
    this.names.clear();
  }

  /** Every relation and alias a person decided on, as plain data (keep this before dropping the tables). */
  exportDecisions(): { relations: Row[]; aliases: Row[] } {
    return {
      relations: this.p("SELECT * FROM product_relations WHERE status != 'candidate'").all() as Row[],
      aliases: this.p("SELECT * FROM product_aliases WHERE status != 'candidate'").all() as Row[],
    };
  }
}
