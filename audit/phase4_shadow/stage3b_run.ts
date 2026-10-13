// Phase 4 stage 3b - SHADOW comparison of three matchers on a COPY of a database: the existing matcher, the earlier shadow resolver, and the foundation-based resolver
// (which reads candidates through the Stage 3a identity index). READ-ONLY with respect to the copy given: it works on a scratch copy of it, refuses the app's own data
// folders, makes no network or AI calls, and removes the scratch copy at the end.
//   node audit/phase4_shadow/build.cjs stage3b_run && node audit/phase4_shadow/stage3b_run.cjs <copy-of-scout.db> <scratch-folder> <output-folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compMatchesSpecs } from "../../src/main/compFilter.ts";
import { buildContext, compareProducts, resolveListing } from "../../src/main/identity/foundationResolver.ts";
import { compareIdentity } from "../../src/main/identity/resolver.ts";
import { newTitlePick, oldTitlePick, type ShadowProduct } from "../../src/main/identity/shadow.ts";
import type { EvidenceDoc } from "../../src/main/identity/credibility.ts";
import { isSimilarProductName, Store } from "../../src/main/store.ts";

const source = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const scratch = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxStage3bScratch");
const outDir = path.resolve(process.argv[4] ?? "C:/Users/biggt/ClynxShadowOutput_stage3b");
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
const ms = (t: number) => Number((performance.now() - t).toFixed(1));

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const hashBefore = sha(source);
  const work = path.join(scratch, "scout.db");
  fs.copyFileSync(source, work);

  // --- Stage 3a foundation on the scratch copy
  const tBackfill = performance.now();
  const store = new Store(work, { identityFoundation: true });
  let steps = 0;
  while (!store.identity!.backfillStep(20).done) steps++;
  const backfillMs = ms(tBackfill);

  const db = new DatabaseSync(work, { readOnly: true });
  const prods = db.prepare("SELECT id, name, category FROM products").all() as Array<{ id: string; name: string; category: string | null }>;
  const listings = db.prepare("SELECT id, title, seller_name, product_id FROM listings").all() as Array<{ id: string; title: string; seller_name: string | null; product_id: string | null }>;
  const photos = db.prepare("SELECT product_id, source_title FROM product_images WHERE source_title IS NOT NULL").all() as Array<{ product_id: string; source_title: string }>;
  db.close();
  const cat = new Map(prods.map((p) => [p.id, p.category || "Other"]));
  const nameOf = new Map(prods.map((p) => [p.id, p.name]));
  const docs: EvidenceDoc[] = [
    ...listings.map((l) => ({ text: l.title, origin: l.seller_name ? `seller:${l.seller_name.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" as const })),
    ...photos.map((i) => ({ text: i.source_title, origin: `title:${i.source_title.toLowerCase()}`, kind: "photo" as const })),
  ];
  const tCtx = performance.now();
  const ctx = buildContext(prods.map((p) => ({ id: p.id, name: p.name })), docs);
  const ctxMs = ms(tCtx);
  const shadowProds: ShadowProduct[] = prods.map((p) => ({ id: p.id, name: p.name, category: p.category || "Other", parentId: null, valueUsd: null, titles: [], compsIdentity: null }));

  // --- A. product vs product, exhaustive
  const tPairs = performance.now();
  const rows: Array<Record<string, unknown>> = [];
  const matrix: Record<string, number> = {};
  const infos = ctx.infos();
  const sameShadow = (l: string) => l === "exact" || l === "possible-alias";
  for (let i = 0; i < prods.length; i++) {
    for (let j = i + 1; j < prods.length; j++) {
      const a = prods[i];
      const b = prods[j];
      const old = isSimilarProductName(a.name, b.name);
      const sh = compareIdentity(a.name, b.name);
      const fo = compareProducts(ctx.info(a.id)!, ctx.info(b.id)!, ctx);
      const key = `old:${old ? "same" : "no"}|shadow:${sameShadow(sh.level) ? sh.level : sh.level}|foundation:${fo.verdict}${fo.lean ? "/" + fo.lean : ""}`;
      matrix[key] = (matrix[key] ?? 0) + 1;
      if (old || sameShadow(sh.level) || fo.verdict === "confirmed" || fo.verdict === "uncertain" || fo.verdict === "related") {
        rows.push({ a: a.id, b: b.id, nameA: a.name, nameB: b.name, category: cat.get(a.id) === cat.get(b.id) ? cat.get(a.id) : "(mixed)", old, shadow: sh.level, shadowWhy: sh.reasons.join("; "), foundation: fo.verdict, relation: fo.relation, lean: fo.lean, sureness: fo.sureness, why: fo.reasons.join("; "), unresolved: fo.unresolved.join("; ") });
      }
    }
  }
  const pairsMs = ms(tPairs);

  // --- B. indexed candidate lookup (how much of the exhaustive "same-like" set does the index find?)
  const tIdx = performance.now();
  const interesting = new Set(rows.filter((r) => r.old || sameShadow(String(r.shadow)) || r.foundation === "confirmed" || r.foundation === "uncertain").map((r) => `${r.a}|${r.b}`));
  const interestingAll = new Set(rows.map((r) => `${r.a}|${r.b}`));
  const idxAll = new Set<string>();
  let found = 0;
  const lookupMs: number[] = [];
  const idxFound = new Set<string>();
  for (const p of prods) {
    const s = performance.now();
    const cands = store.identity!.candidates(p.name, 40, p.id);
    lookupMs.push(performance.now() - s);
    for (const c of cands) {
      const k1 = `${p.id}|${c.productId}`;
      const k2 = `${c.productId}|${p.id}`;
      if (interesting.has(k1)) idxFound.add(k1);
      else if (interesting.has(k2)) idxFound.add(k2);
      if (interestingAll.has(k1) || interestingAll.has(k2)) idxAll.add(interestingAll.has(k1) ? k1 : k2);
    }
  }
  found = idxFound.size;
  lookupMs.sort((a, b) => a - b);
  const idxMs = ms(tIdx);

  // --- C. listings against entries
  const tList = performance.now();
  const lrows: Array<Record<string, unknown>> = [];
  const lookupL: number[] = [];
  for (const l of listings) {
    const oldPick = oldTitlePick(l.title, shadowProds, compMatchesSpecs);
    const shPick = newTitlePick(l.title, shadowProds);
    const s = performance.now();
    const cands = store.identity!.candidates(l.title, 30);
    const fo = resolveListing(l.title, cands.map((c) => ({ id: c.productId, name: c.name })), ctx, { seller: l.seller_name });
    lookupL.push(performance.now() - s);
    const brute = resolveListing(l.title, prods.map((p) => ({ id: p.id, name: p.name })), ctx, { seller: l.seller_name });
    lrows.push({
      id: l.id, title: l.title, stored: l.product_id ? nameOf.get(l.product_id) : null, storedId: l.product_id, old: oldPick ? nameOf.get(oldPick) : null, oldId: oldPick,
      shadow: shPick.id ? nameOf.get(shPick.id) : null, shadowId: shPick.id, shadowLevel: shPick.level,
      foundation: fo.verdict, relation: fo.relation, product: fo.product?.name ?? null, productId: fo.product?.id ?? null, sureness: fo.sureness, why: fo.reasons.join("; "), unresolved: fo.unresolved.join("; "),
      newModel: fo.newModel ? `${fo.newModel.family ?? "-"} [${fo.newModel.codes.join(",")}] ${fo.newModel.note}` : null,
      mentions: fo.alsoMentions.map((m) => `${m.as}:${m.name}`).join("; "), alternatives: fo.alternatives.map((a) => a.name).join("; "),
      bruteProduct: brute.product?.name ?? null, bruteVerdict: brute.verdict, indexAgrees: (brute.product?.id ?? null) === (fo.product?.id ?? null) && brute.verdict === fo.verdict,
    });
  }
  const listMs = ms(tList);
  lookupL.sort((a, b) => a - b);

  // --- outputs
  const jsonl = (f: string, r: unknown[]) => fs.writeFileSync(path.join(outDir, f), r.map((x) => JSON.stringify(x)).join("\n") + "\n");
  jsonl("pairs_review.jsonl", rows);
  jsonl("listings.jsonl", lrows);
  const count = <T,>(arr: T[], k: (x: T) => string) => arr.reduce<Record<string, number>>((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
  const allVerdicts = count(rows, (r) => String(r.foundation));
  const summary = {
    database: { source, sha256Before: hashBefore, sha256After: sha(source), unchanged: hashBefore === sha(source) },
    counts: { products: prods.length, listings: listings.length, pairs: (prods.length * (prods.length - 1)) / 2, pairsInReviewSet: rows.length, generic: infos.filter((i) => i.generic).length, withHost: infos.filter((i) => i.host).length, bracketKinds: count(infos.filter((i) => i.bracket), (i) => String(i.bracket)) },
    pairMatrix: Object.fromEntries(Object.entries(matrix).sort((a, b) => b[1] - a[1])),
    foundationVerdictsInReviewSet: allVerdicts,
    indexRecall: { sameLikeOrUncertainPairs: interesting.size, foundByIndexedLookup: found, allReviewedPairs: interestingAll.size, allFoundByIndexedLookup: idxAll.size },
    listings: {
      foundation: count(lrows, (r) => String(r.foundation)), relation: count(lrows.filter((r) => r.relation), (r) => String(r.relation)),
      newModels: lrows.filter((r) => r.newModel).length, indexMatchesBruteForce: lrows.filter((r) => r.indexAgrees).length,
      oldVsFoundationDifferentProduct: lrows.filter((r) => r.oldId && r.productId && r.oldId !== r.productId).length,
    },
    performance: {
      backfillMs, backfillSteps: steps, contextBuildMs: ctxMs, allPairsMs: pairsMs, microsecondsPerPair: Number(((pairsMs * 1000) / ((prods.length * (prods.length - 1)) / 2)).toFixed(2)),
      indexedProductLookups: { n: lookupMs.length, p50Ms: Number(lookupMs[Math.floor(lookupMs.length / 2)].toFixed(2)), p95Ms: Number(lookupMs[Math.floor(lookupMs.length * 0.95)].toFixed(2)), maxMs: Number(lookupMs[lookupMs.length - 1].toFixed(2)), totalMs: idxMs },
      listingResolution: { n: lookupL.length, p50Ms: Number(lookupL[Math.floor(lookupL.length / 2)].toFixed(2)), p95Ms: Number(lookupL[Math.floor(lookupL.length * 0.95)].toFixed(2)), maxMs: Number(lookupL[lookupL.length - 1].toFixed(2)), totalMs: listMs },
      memoryMB: { rss: Math.round(process.memoryUsage().rss / 1048576), heapUsed: Math.round(process.memoryUsage().heapUsed / 1048576) },
    },
    costs: { aiCalls: 0, networkAttempts: fetchAttempts, comparableSaleLookups: 0 },
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  store.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
