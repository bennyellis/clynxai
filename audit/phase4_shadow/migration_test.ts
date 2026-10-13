// Phase 4 stage 3a - migration test on a COPY of a Clynx database. READ THIS FIRST: it works on a scratch copy of the copy you give it and never modifies the
// file you give it, and it refuses the app's own data folders. Steps: checksum every existing table, apply the foundation (flag on), check nothing existing
// changed, repeat for idempotency, run the backfill to the end, interrupt-and-resume it, roll the whole thing back, and verify the original content again.
//   node audit/phase4_shadow/build.cjs migration_test && node audit/phase4_shadow/migration_test.cjs <copy-of-scout.db> <scratch-folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { IDENTITY_TABLES } from "../../src/main/identity/foundationStore.ts";
import { Store } from "../../src/main/store.ts";

const source = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const scratch = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxMigrationTest");
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(source) || /AppData[\\/]+Roaming[\\/]+(Clynx|marketplace-scout)/i.test(source)) {
  console.error("Refusing to run: this looks like the app's own data folder. Give it a COPY of scout.db in another folder.");
  process.exit(2);
}
if (path.dirname(source) === scratch) {
  console.error("Refusing to run: the scratch folder must differ from the folder of the copy.");
  process.exit(2);
}

const isIdentity = (t: string) => (IDENTITY_TABLES as readonly string[]).includes(t);
const sha256File = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function checksums(file: string): { tables: Record<string, { rows: number; sha256: string }>; relations: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables: Record<string, { rows: number; sha256: string }> = {};
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name).filter((t) => !isIdentity(t));
  for (const t of names) {
    const h = createHash("sha256");
    let last = -1;
    let rows = 0;
    for (;;) {
      const batch = db.prepare(`SELECT rowid AS _r, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT 100`).all(last) as Array<Record<string, unknown>>;
      if (!batch.length) break;
      for (const r of batch) h.update(JSON.stringify(r));
      rows += batch.length;
      last = batch[batch.length - 1]._r as number;
    }
    tables[t] = { rows, sha256: h.digest("hex") };
  }
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const relations = {
    listingsWithoutProduct: n("SELECT COUNT(*) AS n FROM listings WHERE product_id IS NOT NULL AND product_id NOT IN (SELECT id FROM products)"),
    imagesWithoutProduct: n("SELECT COUNT(*) AS n FROM product_images WHERE product_id NOT IN (SELECT id FROM products)"),
    productsWithMissingParent: n("SELECT COUNT(*) AS n FROM products WHERE parent_product_id IS NOT NULL AND parent_product_id NOT IN (SELECT id FROM products)"),
    watchesWithMissingProduct: n("SELECT COUNT(*) AS n FROM watches WHERE linked_product_id IS NOT NULL AND linked_product_id NOT IN (SELECT id FROM products)"),
    listingsWithProduct: n("SELECT COUNT(*) AS n FROM listings WHERE product_id IS NOT NULL"),
    productsWithParent: n("SELECT COUNT(*) AS n FROM products WHERE parent_product_id IS NOT NULL"),
  };
  db.close();
  return { tables, relations };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const tableList = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const t = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  db.close();
  return t;
};
const integrity = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const r = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  const fk = (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
  db.close();
  return { integrity: r, foreignKeyViolations: fk };
};

const report: Record<string, unknown> = {};
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : ""}`);
};

function drainStore(file: string, maxMs = 120_000): { steps: number; ms: number; p50StepMs: number; p95StepMs: number; maxStepMs: number; stepsOver50Ms: number } {
  const store = new Store(file, { identityFoundation: true });
  const t0 = Date.now();
  const times: number[] = [];
  while (Date.now() - t0 < maxMs) {
    const s = performance.now();
    const r = store.identity!.backfillStep(20); // the budget the app uses
    times.push(performance.now() - s);
    if (r.done) break;
  }
  store.close();
  const sorted = [...times].sort((a, b) => a - b);
  const q = (f: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))].toFixed(1));
  return { steps: times.length, ms: Date.now() - t0, p50StepMs: q(0.5), p95StepMs: q(0.95), maxStepMs: Number(sorted[sorted.length - 1].toFixed(1)), stepsOver50Ms: times.filter((t) => t > 50).length };
}

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  const sourceHashBefore = sha256File(source);
  const work = path.join(scratch, "scout.db");
  fs.copyFileSync(source, work);
  const pristine = path.join(scratch, "scout.pristine.db");
  fs.copyFileSync(source, pristine);
  check("the scratch copy is byte-identical to the copy given", sha256File(work) === sourceHashBefore);

  // 0. baseline: the pristine content, and what the app's OWN existing migrations do when it opens the file with the foundation off
  const base0 = checksums(work);
  report.baselineRows = Object.fromEntries(Object.entries(base0.tables).map(([k, v]) => [k, v.rows]));
  report.baselineRelations = base0.relations;
  {
    const off = new Store(work);
    off.close();
  }
  const baseOff = checksums(work);
  check("opening with the foundation OFF (today's behaviour) changes no existing table", same(base0.tables, baseOff.tables), Object.keys(base0.tables).filter((t) => base0.tables[t].sha256 !== baseOff.tables[t]?.sha256));
  check("...and creates no identity table", tableList(work).every((t) => !isIdentity(t)));

  // 1. apply the foundation
  const t1 = performance.now();
  {
    const on = new Store(work, { identityFoundation: true });
    on.close();
  }
  report.schemaCreateMs = Math.round(performance.now() - t1);
  const afterSchema = checksums(work);
  check("all identity tables exist after enabling", IDENTITY_TABLES.every((t) => tableList(work).includes(t)));
  check("row counts of every existing table are unchanged", same(Object.fromEntries(Object.entries(baseOff.tables).map(([k, v]) => [k, v.rows])), Object.fromEntries(Object.entries(afterSchema.tables).map(([k, v]) => [k, v.rows]))));
  check("content checksums of every existing table are unchanged", same(baseOff.tables, afterSchema.tables), Object.keys(baseOff.tables).filter((t) => baseOff.tables[t].sha256 !== afterSchema.tables[t]?.sha256));
  check("product / listing / photo / Watch / parent relationships are unchanged", same(baseOff.relations, afterSchema.relations), { before: baseOff.relations, after: afterSchema.relations });

  // 2. idempotent schema
  for (let i = 0; i < 3; i++) new Store(work, { identityFoundation: true }).close();
  check("repeated opens are idempotent (checksums identical)", same(afterSchema.tables, checksums(work).tables));

  // 3. backfill to the end
  const run1 = drainStore(work);
  report.backfillRun1 = run1;
  const afterBackfill = checksums(work);
  check("after the backfill every existing table is still identical", same(baseOff.tables, afterBackfill.tables), Object.keys(baseOff.tables).filter((t) => baseOff.tables[t].sha256 !== afterBackfill.tables[t]?.sha256));
  check("typical backfill steps are short (p95 under 50 ms) and the worst is under 250 ms", run1.p95StepMs < 50 && run1.maxStepMs < 250, run1);
  const db1 = new DatabaseSync(work, { readOnly: true });
  const n = (sql: string) => Number((db1.prepare(sql).get() as { n: number }).n);
  const stats = {
    products: n("SELECT COUNT(*) AS n FROM products"),
    identities: n("SELECT COUNT(*) AS n FROM product_identity"),
    terms: n("SELECT COUNT(*) AS n FROM identity_terms"),
    relations: n("SELECT COUNT(*) AS n FROM product_relations"),
    relationsByKind: Object.fromEntries((db1.prepare("SELECT relation, COUNT(*) AS c FROM product_relations GROUP BY relation").all() as Array<{ relation: string; c: number }>).map((r) => [r.relation, r.c])),
    relationsNotCandidate: n("SELECT COUNT(*) AS n FROM product_relations WHERE status != 'candidate'"),
    aliases: n("SELECT COUNT(*) AS n FROM product_aliases"),
    aliasesNotCandidate: n("SELECT COUNT(*) AS n FROM product_aliases WHERE status != 'candidate'"),
    listings: n("SELECT COUNT(*) AS n FROM listing_identity"),
    audit: n("SELECT COUNT(*) AS n FROM identity_audit"),
    productsByLevel: Object.fromEntries((db1.prepare("SELECT level, COUNT(*) AS c FROM product_identity GROUP BY level").all() as Array<{ level: string; c: number }>).map((r) => [r.level, r.c])),
    listingsByLevel: Object.fromEntries((db1.prepare("SELECT level, COUNT(*) AS c FROM listing_identity GROUP BY level").all() as Array<{ level: string; c: number }>).map((r) => [r.level, r.c])),
    listingsWhereBestDiffersFromStored: n("SELECT COUNT(*) AS n FROM listing_identity WHERE stored_product_id IS NOT NULL AND best_product_id IS NOT NULL AND stored_product_id != best_product_id"),
  };
  report.stats = stats;
  check("every product has an identity row and every listing a listing identity", stats.identities === stats.products && stats.listings === n("SELECT COUNT(*) AS n FROM listings"), stats);
  check("every relation and alias is a candidate (none confirmed or rejected by the backfill)", stats.relationsNotCandidate === 0 && stats.aliasesNotCandidate === 0);
  db1.close();
  const identitySnapshot = (file: string) => {
    const d = new DatabaseSync(file, { readOnly: true });
    const h = createHash("sha256");
    for (const t of ["product_identity", "identity_terms", "product_relations", "product_aliases", "listing_identity"]) {
      const cols = (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name).filter((c) => !["computed_at", "created_at", "updated_at", "id"].includes(c));
      for (const r of d.prepare(`SELECT ${cols.join(", ")} FROM ${t} ORDER BY ${cols[0]}, ${cols[1] ?? cols[0]}${cols[2] ? ", " + cols[2] : ""}`).all()) h.update(JSON.stringify(r));
    }
    d.close();
    return h.digest("hex");
  };
  const snap1 = identitySnapshot(work);

  // 4. idempotent backfill: reset and run again; the derived content is identical
  {
    const s = new Store(work, { identityFoundation: true });
    s.identity!.resetBackfill();
    s.close();
  }
  const run2 = drainStore(work);
  report.backfillRun2 = run2;
  check("the repeat run is just as well behaved", run2.p95StepMs < 50 && run2.maxStepMs < 250, run2);
  check("re-running the whole backfill gives identical identity content (idempotent)", identitySnapshot(work) === snap1);
  check("...and still changes no existing table", same(baseOff.tables, checksums(work).tables));

  // 5. interrupt and resume: a child process runs the backfill and is killed part-way
  const crashed = path.join(scratch, "scout.crash.db");
  fs.copyFileSync(pristine, crashed);
  new Store(crashed, { identityFoundation: true }).close();
  const child = spawnSync(process.execPath, [__filename, "--child-backfill", crashed], { timeout: 4000, encoding: "utf8" });
  const killed = child.signal !== null || child.status !== 0 || child.error !== undefined;
  const mid = new Store(crashed, { identityFoundation: true });
  const midStatus = mid.identity!.backfillStatus();
  mid.close();
  report.interrupted = { killed, phaseAtInterruption: midStatus.phase };
  check("the backfill was interrupted part-way (killed)", killed && midStatus.phase !== "done", midStatus);
  drainStore(crashed);
  check("after the crash a restart resumes and finishes with identical identity content", identitySnapshot(crashed) === snap1);
  check("the crashed copy's existing tables are identical to the pristine ones", same(base0.tables, checksums(crashed).tables));
  check("the crashed copy passes the integrity check", integrity(crashed).integrity === "ok");

  // 6. rollback: export decisions, drop, and verify the original content
  {
    const s = new Store(work, { identityFoundation: true });
    const exported = s.identity!.exportDecisions();
    s.identity!.drop();
    s.close();
    report.exportedDecisions = { relations: exported.relations.length, aliases: exported.aliases.length };
  }
  check("rollback removed every identity table", tableList(work).every((t) => !isIdentity(t)));
  check("rollback left every existing table identical to the original", same(base0.tables, checksums(work).tables));
  const ig = integrity(work);
  check("the database passes SQLite's integrity check and has no foreign-key violations after rollback", ig.integrity === "ok" && ig.foreignKeyViolations === 0, ig);
  new Store(work).close();
  check("the app opens the rolled-back database normally with the foundation off", same(base0.tables, checksums(work).tables));

  // 7. the file you gave me was never touched
  check("the copy you gave was not modified (SHA-256 unchanged)", sha256File(source) === sourceHashBefore);

  report.checks = checks;
  report.sourceSha256 = sourceHashBefore;
  fs.writeFileSync(path.join(scratch, "migration_report.json"), JSON.stringify(report, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  console.log(JSON.stringify({ stats: report.stats, backfillRun1: report.backfillRun1, backfillRun2: report.backfillRun2, schemaCreateMs: report.schemaCreateMs, interrupted: report.interrupted }, null, 1));
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === "--child-backfill") {
  // runs the backfill slowly forever; the parent kills it
  const store = new Store(process.argv[3], { identityFoundation: true });
  const tick = () => {
    store.identity!.backfillStep(2);
    setTimeout(tick, 15);
  };
  tick();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
