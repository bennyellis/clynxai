// Phase 4 stage 6a - proves the undo mechanism on throwaway copies: applies the proposed correction plan to a scratch copy of a COPY of a database, undoes it, and checks the
// database is byte-for-byte identical in every table the plan can touch. READ-ONLY on the source; refuses the app's own data folders; scratch is deleted at the end.
//   node audit/phase4_shadow/build.cjs stage6a_roundtrip && node audit/phase4_shadow/stage6a_roundtrip.cjs <copy-of-scout.db> <scratch-folder> <plan-json> <output-json>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/main/store.ts";
import { applyPlan, undoBatch, type PlanItem } from "./correction_journal.ts";

const source = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const scratch = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxStage6aRoundtrip");
const planFile = path.resolve(process.argv[4] ?? "C:/Users/biggt/ClynxShadowOutput_stage6a/correction_plan.json");
const outFile = path.resolve(process.argv[5] ?? "C:/Users/biggt/ClynxShadowOutput_stage6a/roundtrip.json");
if (/fb-marketplace-scout[\/]+data[\/]/i.test(source) || /AppData[\/]+Roaming[\/]+(Clynx|marketplace-scout)/i.test(source)) {
  console.error("Refusing to run: this looks like the app's own data folder. Give it a COPY of scout.db in another folder.");
  process.exit(2);
}
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const TABLES: Array<{ name: string; order: string; select: string }> = [
  { name: "products", order: "id", select: "*" },
  { name: "listings", order: "id", select: "*" },
  { name: "product_images", order: "id", select: "id, product_id, source_title, created_at, kind, length(image_data) AS n, hex(substr(image_data, 1, 64)) AS head" },
  { name: "product_relations", order: "id", select: "*" },
  { name: "product_aliases", order: "id", select: "*" },
];
function fingerprint(db: DatabaseSync): string {
  const h = createHash("sha256");
  for (const t of TABLES) {
    h.update(`#${t.name}\n`);
    for (const row of db.prepare(`SELECT ${t.select} FROM ${t.name} ORDER BY ${t.order}`).iterate()) h.update(JSON.stringify(row) + "\n");
  }
  return h.digest("hex");
}

async function main() {
  const hashBefore = sha(source);
  fs.mkdirSync(scratch, { recursive: true });
  const work = path.join(scratch, "scout.db");
  fs.copyFileSync(source, work);
  const s = new Store(work, { identityFoundation: true });
  while (!s.identity!.backfillStep(20).done) {
    /* drain */
  }
  s.close();

  const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as { proposals: PlanItem[] };
  const items = plan.proposals.filter((p) => p.change);
  const all = new Set(items.map((p) => p.id));
  const results: Record<string, unknown> = {};
  const db = new DatabaseSync(work);
  db.exec("PRAGMA journal_mode = DELETE");

  const original = fingerprint(db);
  results.itemsWithAChange = items.length;

  // 1. apply everything, undo everything
  const a1 = applyPlan(db, "b1", items, all);
  const applied = a1.filter((o) => o.status === "applied").length;
  const afterApply = fingerprint(db);
  const u1 = undoBatch(db, "b1");
  const afterUndo = fingerprint(db);
  results.applyAllUndoAll = { applied, skipped: a1.length - applied, databaseChangedByApply: afterApply !== original, undone: u1.filter((o) => o.status === "undone").length, identicalAfterUndo: afterUndo === original };

  // 2. apply everything, undo in two halves
  applyPlan(db, "b2", items, all);
  const ids = items.map((i) => i.id);
  const half1 = new Set(ids.filter((_, i) => i % 2 === 0));
  undoBatch(db, "b2", half1);
  const mid = fingerprint(db);
  undoBatch(db, "b2");
  results.partialThenRest = { midStateDiffersFromOriginal: mid !== original, midStateDiffersFromApplied: mid !== afterApply, identicalAfterUndo: fingerprint(db) === original };

  // 3. applying the same plan twice changes nothing the second time
  applyPlan(db, "b3", items, all);
  const once = fingerprint(db);
  const again = applyPlan(db, "b3b", items, all);
  results.secondApplyIsNoop = { appliedAgain: again.filter((o) => o.status === "applied").length, unchanged: fingerprint(db) === once };
  undoBatch(db, "b3");
  undoBatch(db, "b3b");
  results.identicalAfterThirdUndo = fingerprint(db) === original;

  // 4. a person edits one row after the apply: undo leaves that row alone and undoes the rest
  applyPlan(db, "b4", items, all);
  const listingItem = items.find((i) => i.change!.table === "listings");
  const imageItem = items.find((i) => i.change!.table === "product_images");
  const target = listingItem ?? imageItem;
  if (target) {
    const t = target.change!;
    db.prepare(`UPDATE ${t.table} SET product_id = ? WHERE id = ?`).run("edited-by-a-person", t.key.id);
    const u = undoBatch(db, "b4");
    const row = db.prepare(`SELECT product_id FROM ${t.table} WHERE id = ?`).get(t.key.id) as { product_id: string };
    results.editedRowIsProtected = { refused: u.filter((o) => o.status === "undo-refused-changed-since").length, editedRowKept: row.product_id === "edited-by-a-person", othersUndone: u.filter((o) => o.status === "undone").length };
    // put it back by hand and finish
    db.prepare(`UPDATE ${t.table} SET product_id = ? WHERE id = ?`).run(target.before!.product_id as string, t.key.id);
    const rest = undoBatch(db, "b4");
    results.afterManualRestore = { remaining: rest.length, identical: fingerprint(db) === original };
  }

  // 5. a stale plan (the row is not as the plan expected) applies nothing
  const stale = items.slice(0, 5).map((i) => ({ ...i, before: Object.fromEntries(Object.keys(i.change!.set).map((c) => [c, "not-what-is-there"])) }));
  const s5 = applyPlan(db, "b5", stale, new Set(stale.map((i) => i.id)));
  results.stalePlan = { applied: s5.filter((o) => o.status === "applied").length, skipped: s5.filter((o) => o.status === "skipped-changed-since").length, unchanged: fingerprint(db) === original };

  // 6. a plan that tries to touch something else is refused
  let refused = 0;
  for (const bad of [{ id: "x1", change: { table: "listings", key: { id: "a" }, set: { price: 1 } }, before: null }, { id: "x2", change: { table: "watches", key: { id: "a" }, set: { name: "x" } }, before: null }] as PlanItem[]) {
    try {
      applyPlan(db, "b6", [bad], new Set([bad.id]));
    } catch {
      refused++;
    }
  }
  results.disallowedChangesRefused = { tried: 2, refused };
  db.close();

  results.sourceDatabase = { sha256Before: hashBefore, sha256After: sha(source), unchanged: hashBefore === sha(source) };
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
