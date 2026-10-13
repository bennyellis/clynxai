// The apply / undo mechanism for a reviewed correction (Phase 4). The app uses it ONLY for a suggestion a person has approved on the Database > Review screen, one suggestion
// at a time, and only when config.databaseReview.apply is on (off by default; see identityReview.ts). The audit tools test it on throwaway copies (stage6a_roundtrip.ts).
// Design:
//  * Only one-row UPDATEs of named columns are supported (move a listing or photo, clear a valuation, reject a candidate alias or relation). It never inserts into data
//    tables, merges or deletes, so nothing is lost and there is nothing to "recreate" on undo.
//  * Every applied change is written to correction_journal in the SAME database and the SAME transaction as the change itself: either both exist or neither does.
//  * Apply refuses an item whose row no longer holds the values the plan was written against (it changed since): no stale plan is applied.
//  * Undo restores the exact before-values, newest first, and refuses an item whose row was changed again since (so a later edit by a person is never overwritten).
import { DatabaseSync } from "node:sqlite";

export interface PlanChange {
  table: string;
  key: Record<string, string>;
  set: Record<string, unknown>;
}
export interface PlanItem {
  id: string;
  change: PlanChange | null;
  before: Record<string, unknown> | null;
}
export interface Outcome {
  id: string;
  status: "applied" | "skipped-changed-since" | "skipped-missing" | "skipped-no-change" | "undone" | "undo-refused-changed-since";
}

const ALLOWED: Record<string, { key: string[]; columns: string[] }> = {
  listings: { key: ["id"], columns: ["product_id"] },
  product_images: { key: ["id"], columns: ["product_id"] },
  products: { key: ["id"], columns: ["ebay_avg_sold_price_usd", "ebay_comps_sample_size", "ebay_est_value_usd", "ebay_est_basis"] },
  product_aliases: { key: ["alias_text", "product_id"], columns: ["status"] },
  product_relations: { key: ["from_product_id", "to_product_id", "relation"], columns: ["status"] },
};

const quote = (n: string) => `"${n.replace(/"/g, "")}"`;
function check(c: PlanChange) {
  const spec = ALLOWED[c.table];
  if (!spec) throw new Error(`table not allowed: ${c.table}`);
  if (Object.keys(c.key).sort().join() !== [...spec.key].sort().join()) throw new Error(`bad key for ${c.table}`);
  for (const col of Object.keys(c.set)) if (!spec.columns.includes(col)) throw new Error(`column not allowed: ${c.table}.${col}`);
}
const where = (key: Record<string, string>) => Object.keys(key).map((k) => `${quote(k)} = ?`).join(" AND ");

export function ensureJournal(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS correction_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, proposal_id TEXT NOT NULL, table_name TEXT NOT NULL, key_json TEXT NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL, applied_at INTEGER NOT NULL, undone_at INTEGER)`);
}

export function applyPlan(db: DatabaseSync, batchId: string, items: PlanItem[], approvedIds: Set<string>): Outcome[] {
  ensureJournal(db);
  const out: Outcome[] = [];
  for (const it of items) {
    if (!approvedIds.has(it.id)) continue;
    if (!it.change) {
      out.push({ id: it.id, status: "skipped-no-change" });
      continue;
    }
    check(it.change);
    const cols = Object.keys(it.change.set);
    const keyVals = Object.values(it.change.key);
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT ${cols.map(quote).join(", ")} FROM ${quote(it.change.table)} WHERE ${where(it.change.key)}`).get(...keyVals) as Record<string, unknown> | undefined;
      if (!row) {
        db.exec("ROLLBACK");
        out.push({ id: it.id, status: "skipped-missing" });
        continue;
      }
      // the plan was written against the 'before' values; if the row moved on, the plan is stale for this item
      const expected = it.before ?? {};
      const stale = Object.keys(expected).some((c) => (row[c] ?? null) !== (expected[c] ?? null) && cols.includes(c));
      if (stale) {
        db.exec("ROLLBACK");
        out.push({ id: it.id, status: "skipped-changed-since" });
        continue;
      }
      db.prepare(`UPDATE ${quote(it.change.table)} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${where(it.change.key)}`).run(...cols.map((c) => (it.change!.set[c] ?? null) as never), ...keyVals);
      db.prepare("INSERT INTO correction_journal (batch_id, proposal_id, table_name, key_json, before_json, after_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        batchId, it.id, it.change.table, JSON.stringify(it.change.key), JSON.stringify(row), JSON.stringify(Object.fromEntries(cols.map((c) => [c, it.change!.set[c] ?? null]))), Date.now(),
      );
      db.exec("COMMIT");
      out.push({ id: it.id, status: "applied" });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return out;
}

/** Undoes a batch (or only the listed proposal ids), newest first. */
export function undoBatch(db: DatabaseSync, batchId: string, onlyIds?: Set<string>): Outcome[] {
  ensureJournal(db);
  const rows = db.prepare("SELECT * FROM correction_journal WHERE batch_id = ? AND undone_at IS NULL ORDER BY seq DESC").all(batchId) as Array<Record<string, string | number>>;
  const out: Outcome[] = [];
  for (const j of rows) {
    if (onlyIds && !onlyIds.has(String(j.proposal_id))) continue;
    const key = JSON.parse(String(j.key_json)) as Record<string, string>;
    const before = JSON.parse(String(j.before_json)) as Record<string, unknown>;
    const after = JSON.parse(String(j.after_json)) as Record<string, unknown>;
    const cols = Object.keys(before);
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT ${cols.map(quote).join(", ")} FROM ${quote(String(j.table_name))} WHERE ${where(key)}`).get(...Object.values(key)) as Record<string, unknown> | undefined;
      if (!row || Object.keys(after).some((c) => (row[c] ?? null) !== (after[c] ?? null))) {
        db.exec("ROLLBACK");
        out.push({ id: String(j.proposal_id), status: "undo-refused-changed-since" });
        continue;
      }
      db.prepare(`UPDATE ${quote(String(j.table_name))} SET ${cols.map((c) => `${quote(c)} = ?`).join(", ")} WHERE ${where(key)}`).run(...cols.map((c) => (before[c] ?? null) as never), ...Object.values(key));
      db.prepare("UPDATE correction_journal SET undone_at = ? WHERE seq = ?").run(Date.now(), j.seq as number);
      db.exec("COMMIT");
      out.push({ id: String(j.proposal_id), status: "undone" });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return out;
}

export interface JournalEntry {
  seq: number;
  batchId: string;
  proposalId: string;
  table: string;
  appliedAt: number;
  undoneAt: number | null;
}

/** The journal's entries for a batch (or all), newest first. Empty when the journal does not exist yet. */
export function listJournal(db: DatabaseSync, batchId?: string): JournalEntry[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'correction_journal'").get();
  if (!exists) return [];
  const rows = (batchId ? db.prepare("SELECT * FROM correction_journal WHERE batch_id = ? ORDER BY seq DESC").all(batchId) : db.prepare("SELECT * FROM correction_journal ORDER BY seq DESC").all()) as Array<Record<string, string | number | null>>;
  return rows.map((r) => ({ seq: r.seq as number, batchId: String(r.batch_id), proposalId: String(r.proposal_id), table: String(r.table_name), appliedAt: r.applied_at as number, undoneAt: (r.undone_at as number | null) ?? null }));
}
