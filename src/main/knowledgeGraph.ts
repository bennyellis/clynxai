// Clynx's product KNOWLEDGE: what exists in the world (makers, product families, models, variants, special editions, and the franchises and characters some editions are
// themed on), with the sources that say so. It is a separate layer from the user's Library: discovering thirty editions of a console creates thirty entries HERE and not one
// product in the Library. Entries carry how sure we are (evidenceKinds.ts), keep conflicting claims instead of choosing silently, and can be re-checked or corrected.
//
//   manufacturer > family > model > variant > edition        (parent_id)
//   edition  --themed_on-->  franchise  --features-->  character        (relations)
//
// The item kind (hardware / game / accessory) is stored on every entry and checked independently of the name: a game that features Pikachu is not the Pikachu console.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { evidenceFromSources, type EvidenceKind, type FactSource, type SourceQuality } from "./evidenceKinds.js";

export type EntityKind = "manufacturer" | "family" | "model" | "variant" | "edition" | "franchise" | "character";
export type ItemKind = "hardware" | "game" | "accessory" | "other";
export type Relation = "themed_on" | "features" | "lookalike_of" | "aftermarket_of" | "successor_of";

export interface Characteristic {
  text: string;
  kind: EvidenceKind;
  sources: FactSource[];
}

export interface KgEntity {
  id: string;
  kind: EntityKind;
  name: string;
  parentId: string | null;
  manufacturer: string | null;
  region: string | null;
  aliases: string[];
  characteristics: Characteristic[];
  /** How well the entry's EXISTENCE is established. */
  status: EvidenceKind;
  disputed: boolean;
  itemKind: ItemKind | null;
  researchedAt: number | null;
}

export interface KgClaim {
  id: string;
  entityId: string;
  topic: string;
  claim: string;
  url: string;
  quality: SourceQuality;
  quote: string | null;
  contradicts: boolean;
  retrievedAt: number;
}

/** A question to ask of the PHOTOS that tells candidates apart, and what each candidate would show. */
export interface Discriminator {
  id: string;
  familyId: string;
  aspect: string;
  question: string;
  options: Array<{ id: string; describe: string }>;
  /** candidate entity id -> the option it would show */
  expected: Record<string, string>;
  kind: EvidenceKind;
  sources: FactSource[];
}

const key = (s: string) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
export const entityKey = key;

export const GRAPH_DDL = `
  CREATE TABLE IF NOT EXISTS kg_entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    parent_id TEXT,
    manufacturer TEXT,
    region TEXT,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    characteristics_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'unknown',
    disputed INTEGER NOT NULL DEFAULT 0,
    item_kind TEXT,
    researched_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entities_key ON kg_entities(kind, name_key, COALESCE(parent_id, ''));
  CREATE TABLE IF NOT EXISTS kg_relations (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    rel TEXT NOT NULL,
    source_url TEXT,
    UNIQUE (from_id, to_id, rel)
  );
  CREATE TABLE IF NOT EXISTS kg_claims (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT 'exists',
    claim TEXT NOT NULL,
    url TEXT NOT NULL,
    quality TEXT NOT NULL,
    quote TEXT,
    contradicts INTEGER NOT NULL DEFAULT 0,
    retrieved_at INTEGER NOT NULL,
    UNIQUE (entity_id, topic, claim, url)
  );
  CREATE INDEX IF NOT EXISTS idx_kg_claims_entity ON kg_claims(entity_id);
  CREATE TABLE IF NOT EXISTS kg_discriminators (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    aspect TEXT NOT NULL,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    kind TEXT NOT NULL,
    sources_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (family_id, aspect)
  );
`;

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

function rowToEntity(r: any): KgEntity {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    parentId: r.parent_id ?? null,
    manufacturer: r.manufacturer ?? null,
    region: r.region ?? null,
    aliases: parse<string[]>(r.aliases_json, []),
    characteristics: parse<Characteristic[]>(r.characteristics_json, []),
    status: r.status,
    disputed: !!r.disputed,
    itemKind: r.item_kind ?? null,
    researchedAt: r.researched_at ?? null,
  };
}

export class KnowledgeGraph {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = () => Date.now()) {
    db.exec(GRAPH_DDL);
  }

  /** Creates the entry, or returns the one that already exists with this kind, name and parent. Aliases and the item kind are merged in, never overwritten. */
  upsert(e: { kind: EntityKind; name: string; parentId?: string | null; manufacturer?: string | null; region?: string | null; aliases?: string[]; itemKind?: ItemKind | null }): KgEntity {
    const nameKey = key(e.name);
    if (!nameKey) throw new Error("An entry needs a name.");
    const parentId = e.parentId ?? null;
    const existing = this.db.prepare("SELECT * FROM kg_entities WHERE kind = ? AND name_key = ? AND COALESCE(parent_id, '') = ?").get(e.kind, nameKey, parentId ?? "") as any;
    const t = this.now();
    if (existing) {
      const cur = rowToEntity(existing);
      const aliases = [...new Set([...cur.aliases, ...(e.aliases ?? [])].map((a) => a.trim()).filter((a) => a && key(a) !== nameKey))];
      this.db.prepare("UPDATE kg_entities SET aliases_json = ?, manufacturer = COALESCE(manufacturer, ?), region = COALESCE(region, ?), item_kind = COALESCE(item_kind, ?), updated_at = ? WHERE id = ?").run(JSON.stringify(aliases), e.manufacturer ?? null, e.region ?? null, e.itemKind ?? null, t, cur.id);
      return this.get(cur.id)!;
    }
    const id = randomUUID();
    const aliases = [...new Set((e.aliases ?? []).map((a) => a.trim()).filter((a) => a && key(a) !== nameKey))];
    this.db.prepare("INSERT INTO kg_entities (id, kind, name, name_key, parent_id, manufacturer, region, aliases_json, item_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, e.kind, e.name.trim(), nameKey, parentId, e.manufacturer ?? null, e.region ?? null, JSON.stringify(aliases), e.itemKind ?? null, t, t);
    return this.get(id)!;
  }

  get(id: string): KgEntity | null {
    const r = this.db.prepare("SELECT * FROM kg_entities WHERE id = ?").get(id);
    return r ? rowToEntity(r) : null;
  }

  /** Entries whose name or alias is this (any case, punctuation ignored). */
  find(name: string, kinds?: EntityKind[]): KgEntity[] {
    const k = key(name);
    if (!k) return [];
    const rows = (this.db.prepare("SELECT * FROM kg_entities WHERE name_key = ? OR aliases_json LIKE ?").all(k, `%${name.replace(/[%_]/g, "")}%`) as any[]).map(rowToEntity);
    return rows.filter((e) => (key(e.name) === k || e.aliases.some((a) => key(a) === k)) && (!kinds || kinds.includes(e.kind)));
  }

  children(id: string, kinds?: EntityKind[]): KgEntity[] {
    return (this.db.prepare("SELECT * FROM kg_entities WHERE parent_id = ? ORDER BY name_key").all(id) as any[]).map(rowToEntity).filter((e) => !kinds || kinds.includes(e.kind));
  }

  /** The chain from the maker down to this entry. */
  ancestry(id: string): KgEntity[] {
    const out: KgEntity[] = [];
    let cur = this.get(id);
    for (let i = 0; cur && i < 10; i++) {
      out.unshift(cur);
      cur = cur.parentId ? this.get(cur.parentId) : null;
    }
    return out;
  }

  relate(fromId: string, toId: string, rel: Relation, sourceUrl?: string): void {
    this.db.prepare("INSERT INTO kg_relations (id, from_id, to_id, rel, source_url) VALUES (?, ?, ?, ?, ?) ON CONFLICT(from_id, to_id, rel) DO NOTHING").run(randomUUID(), fromId, toId, rel, sourceUrl ?? null);
  }
  related(fromId: string, rel?: Relation): Array<{ rel: Relation; entity: KgEntity; sourceUrl: string | null }> {
    const rows = this.db.prepare(`SELECT rel, to_id, source_url FROM kg_relations WHERE from_id = ? ${rel ? "AND rel = ?" : ""}`).all(...(rel ? [fromId, rel] : [fromId])) as Array<{ rel: Relation; to_id: string; source_url: string | null }>;
    return rows.map((r) => ({ rel: r.rel, entity: this.get(r.to_id)!, sourceUrl: r.source_url })).filter((r) => !!r.entity);
  }

  /** "Nintendo > New Nintendo 3DS XL > Pikachu Edition > Pokemon > Pikachu": the maker-to-edition chain, then the franchise and character the edition is themed on. */
  describeChain(id: string): string {
    const chain = this.ancestry(id).map((e) => e.name);
    const themed: string[] = [];
    let cur: string[] = [id];
    for (let depth = 0; depth < 3 && cur.length; depth++) {
      const next: string[] = [];
      for (const c of cur) for (const r of [...this.related(c, "themed_on"), ...this.related(c, "features")]) {
        if (!themed.includes(r.entity.name)) themed.push(r.entity.name);
        next.push(r.entity.id);
      }
      cur = next;
    }
    return [...chain, ...themed].join(" > ");
  }

  /** Records what a source says. The entry's `status` and `disputed` are recomputed from every claim about its existence, so a conflict is kept and shown, not decided away. */
  addClaim(entityId: string, c: { topic?: string; claim: string; url: string; quality: SourceQuality; quote?: string; contradicts?: boolean }): void {
    const topic = c.topic ?? "exists";
    this.db.prepare("INSERT INTO kg_claims (id, entity_id, topic, claim, url, quality, quote, contradicts, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entity_id, topic, claim, url) DO UPDATE SET quote = excluded.quote, contradicts = excluded.contradicts, retrieved_at = excluded.retrieved_at").run(randomUUID(), entityId, topic, c.claim.slice(0, 300), c.url, c.quality, c.quote?.slice(0, 300) ?? null, c.contradicts ? 1 : 0, this.now());
    if (topic === "exists") this.recompute(entityId);
  }
  claims(entityId: string, topic?: string): KgClaim[] {
    const rows = this.db.prepare(`SELECT * FROM kg_claims WHERE entity_id = ? ${topic ? "AND topic = ?" : ""} ORDER BY retrieved_at DESC`).all(...(topic ? [entityId, topic] : [entityId])) as any[];
    return rows.map((r) => ({ id: r.id, entityId: r.entity_id, topic: r.topic, claim: r.claim, url: r.url, quality: r.quality, quote: r.quote ?? null, contradicts: !!r.contradicts, retrievedAt: r.retrieved_at }));
  }
  conflicts(entityId: string): KgClaim[] {
    return this.claims(entityId).filter((c) => c.contradicts);
  }
  private recompute(entityId: string): void {
    const sources: FactSource[] = this.claims(entityId, "exists").map((c) => ({ url: c.url, quality: c.quality, quote: c.quote ?? undefined, contradicts: c.contradicts }));
    const ev = evidenceFromSources(sources);
    this.db.prepare("UPDATE kg_entities SET status = ?, disputed = ?, researched_at = ?, updated_at = ? WHERE id = ?").run(ev.kind, ev.disputed ? 1 : 0, this.now(), this.now(), entityId);
  }

  /** Gives an entry a starting status (an owner's seed) only while nothing better is known; research and sources move it from there. */
  setStatusIfUnknown(entityId: string, status: EvidenceKind): void {
    this.db.prepare("UPDATE kg_entities SET status = ?, updated_at = ? WHERE id = ? AND status = 'unknown'").run(status, this.now(), entityId);
  }

  setCharacteristic(entityId: string, ch: Characteristic): void {
    const e = this.get(entityId);
    if (!e) return;
    const rest = e.characteristics.filter((c) => key(c.text) !== key(ch.text));
    this.db.prepare("UPDATE kg_entities SET characteristics_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...rest, ch]), this.now(), entityId);
  }

  setDiscriminator(d: Omit<Discriminator, "id">): void {
    this.db
      .prepare("INSERT INTO kg_discriminators (id, family_id, aspect, question, options_json, expected_json, kind, sources_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(family_id, aspect) DO UPDATE SET question = excluded.question, options_json = excluded.options_json, expected_json = excluded.expected_json, kind = excluded.kind, sources_json = excluded.sources_json")
      .run(randomUUID(), d.familyId, d.aspect, d.question, JSON.stringify(d.options), JSON.stringify(d.expected), d.kind, JSON.stringify(d.sources));
  }
  discriminators(familyId: string): Discriminator[] {
    return (this.db.prepare("SELECT * FROM kg_discriminators WHERE family_id = ?").all(familyId) as any[]).map((r) => ({ id: r.id, familyId: r.family_id, aspect: r.aspect, question: r.question, options: parse(r.options_json, []), expected: parse(r.expected_json, {}), kind: r.kind, sources: parse(r.sources_json, []) }));
  }

  /** The person (or a later check) says an entry is wrong: it goes back to unknown, keeps its history, and is due for another look. */
  retract(entityId: string, reason: string): void {
    this.addClaim(entityId, { topic: "correction", claim: reason, url: "user-correction", quality: "other", contradicts: true });
    this.db.prepare("UPDATE kg_entities SET status = 'unknown', researched_at = NULL, updated_at = ? WHERE id = ?").run(this.now(), entityId);
  }
  /** Whether research on this entry is older than `maxAgeMs` or was never done (or was retracted). */
  stale(entityId: string, maxAgeMs: number): boolean {
    const e = this.get(entityId);
    return !e || e.researchedAt === null || this.now() - e.researchedAt > maxAgeMs;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT kind, COUNT(*) AS n FROM kg_entities GROUP BY kind").all() as Array<{ kind: string; n: number }>) out[r.kind] = Number(r.n);
    return out;
  }
}
