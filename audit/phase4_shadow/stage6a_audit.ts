// Phase 4 stage 6a - READ-ONLY contamination audit of a COPY of a database. It applies NOTHING: it works on a scratch copy of the copy, refuses the app's own data folders,
// makes no network or AI calls, and writes (1) a private findings file with names and titles, (2) a counts-only summary and (3) a proposed per-product correction plan whose
// every change carries the before-image needed to undo it (see correction_journal.ts for the mechanism that would apply and undo a plan, tested on scratch copies only).
// The analysis itself is src/main/identity/reviewFindings.ts: the same code the in-app review screen runs.
//   node audit/phase4_shadow/build.cjs stage6a_audit && node audit/phase4_shadow/stage6a_audit.cjs <copy-of-scout.db> <scratch-folder> <output-folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyzeReview, summarizeReview, type ReviewInput } from "../../src/main/identity/reviewFindings.ts";
import { Store } from "../../src/main/store.ts";

const source = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const scratch = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxStage6aScratch");
const outDir = path.resolve(process.argv[4] ?? "C:/Users/biggt/ClynxShadowOutput_stage6a");
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(source) || /AppData[\\/]+Roaming[\\/]+(Clynx|marketplace-scout)/i.test(source)) {
  console.error("Refusing to run: this looks like the app's own data folder. Give it a COPY of scout.db in another folder.");
  process.exit(2);
}
let fetchAttempts = 0;
globalThis.fetch = (() => {
  fetchAttempts++;
  throw new Error("network is blocked in shadow mode");
}) as typeof fetch;
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const hashBefore = sha(source);
  const work = path.join(scratch, "scout.db");
  fs.copyFileSync(source, work);

  // Stage 3a candidate relations and aliases exist only in the scratch copy, built the same way the stage 3b run builds them.
  const store = new Store(work, { identityFoundation: true });
  while (!store.identity!.backfillStep(20).done) {
    /* drain */
  }
  store.close();

  const db = new DatabaseSync(work, { readOnly: true });
  const input: ReviewInput = {
    products: (db.prepare("SELECT id, name, category, ebay_avg_sold_price_usd AS sold, ebay_comps_sample_size AS soldN, ebay_est_value_usd AS est, ebay_est_basis AS basis FROM products").all() as unknown) as ReviewInput["products"],
    listings: (db.prepare("SELECT id, title, product_id AS productId, seller_name AS seller FROM listings").all() as unknown) as ReviewInput["listings"],
    photos: (db.prepare("SELECT id, product_id AS productId, source_title AS sourceTitle FROM product_images").all() as unknown) as ReviewInput["photos"],
    relations: (db.prepare("SELECT from_product_id AS 'from', to_product_id AS 'to', relation, status FROM product_relations").all() as unknown) as ReviewInput["relations"],
    aliases: (db.prepare("SELECT alias_text AS text, product_id AS productId, status FROM product_aliases").all() as unknown) as ReviewInput["aliases"],
  };
  db.close();

  const t0 = performance.now();
  const result = await analyzeReview(input);
  const analysisMs = Math.round(performance.now() - t0);
  const { findings, proposals, stats } = result;
  const jsonl = (f: string, r: unknown[]) => fs.writeFileSync(path.join(outDir, f), r.map((x) => JSON.stringify(x)).join("\n") + "\n");
  jsonl("findings.jsonl", findings);
  fs.writeFileSync(path.join(outDir, "correction_plan.json"), JSON.stringify({ note: "PROPOSED ONLY. Nothing here has been applied. Every item needs a person's decision. 'before' is the exact prior value; restoring it undoes the item.", proposals }, null, 1));
  const summary = {
    database: { source, sha256Before: hashBefore, sha256After: sha(source), unchanged: hashBefore === sha(source) },
    counts: { products: stats.products, listings: input.listings.length, listingsFiled: stats.listingsFiled, photosWithTitle: stats.photosWithTitle, productsWithFiledEvidence: stats.productsWithFiledEvidence },
    filedItems: { supportEntry: stats.docsSupporting, confidentlyElsewhere: stats.docsPointElsewhere, familyOrVariantOnly: stats.docsFamilyOnly, uncertain: stats.docsUncertain, other: stats.docsOther },
    ...summarizeReview(result, stats.products),
    candidatesChecked: { aliases: stats.aliasesChecked, aliasesDisputed: stats.aliasesDisputed, relations: stats.relationsChecked, relationsDisputed: stats.relationsDisputed },
    analysisMs,
    costs: { aiCalls: 0, networkAttempts: fetchAttempts, comparableSaleLookups: 0 },
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
