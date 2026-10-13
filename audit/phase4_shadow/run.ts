// Phase 4 stage 0b - shadow-mode run over an isolated COPY of a Clynx database. READ-ONLY and OFFLINE:
//   - refuses to run on the app's own data folder (only a copy somewhere else);
//   - opens the database with SQLite's read-only flag and never reads photo data;
//   - blocks every network call (and counts any attempt), imports no notification, AI, scraper or database-writing code, and calls nothing paid;
//   - hashes the copy before and after to prove it was not changed.
// It compares the existing matcher with the proposed resolver (src/main/identity/) and writes its findings to an output folder.
//   node audit/phase4_shadow/build.cjs && node audit/phase4_shadow/run.cjs <copy-of-scout.db> <output-folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSimilarProductName } from "../../src/main/store.ts";
import { compMatchesSpecs } from "../../src/main/compFilter.ts";
import { codesMissingFrom, specificNameFor } from "../../src/main/identity/codes.ts";
import { learnOptionalWords } from "../../src/main/identity/resolver.ts";
import { assessMixed, comparePairs, genericsWithSpecificSiblings, resolveListings, type ShadowListing, type ShadowProduct } from "../../src/main/identity/shadow.ts";

const dbPath = path.resolve(process.argv[2] ?? "C:/Users/biggt/ClynxDbCopy/scout.db");
const outDir = path.resolve(process.argv[3] ?? "C:/Users/biggt/ClynxShadowOutput");

// ---- safety: a copy only, offline
if (/fb-marketplace-scout[\\/]+data[\\/]/i.test(dbPath) || /AppData[\\/]+Roaming[\\/]+(Clynx|marketplace-scout)/i.test(dbPath)) {
  console.error("Refusing to run: this looks like the app's own data folder. Give it a COPY of scout.db in another folder.");
  process.exit(2);
}
let fetchAttempts = 0;
globalThis.fetch = (() => {
  fetchAttempts++;
  throw new Error("network is blocked in shadow mode");
}) as typeof fetch;

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const hashBefore = await sha256(dbPath);
  const statBefore = fs.statSync(dbPath);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

  // names, categories and values only: no photo data is ever selected
  const prodRows = all<{ id: string; name: string; category: string | null; parent_product_id: string | null; val: number | null; ident: string | null }>(
    "SELECT id, name, category, parent_product_id, COALESCE(ebay_est_value_usd, ebay_avg_sold_price_usd) AS val, ebay_comps_identity AS ident FROM products"
  );
  const titlesBy = new Map<string, string[]>();
  for (const r of all<{ product_id: string; source_title: string | null }>("SELECT product_id, source_title FROM product_images WHERE source_title IS NOT NULL")) {
    (titlesBy.get(r.product_id) ?? titlesBy.set(r.product_id, []).get(r.product_id)!).push(r.source_title as string);
  }
  const listingRows = all<{ id: string; title: string; price: number | null; product_id: string | null }>("SELECT id, title, price, product_id FROM listings");
  for (const l of listingRows) if (l.product_id) (titlesBy.get(l.product_id) ?? titlesBy.set(l.product_id, []).get(l.product_id)!).push(l.title);
  db.close();

  const products: ShadowProduct[] = prodRows.map((p) => ({ id: p.id, name: p.name, category: p.category || "Other", parentId: p.parent_product_id, valueUsd: p.val, titles: titlesBy.get(p.id) ?? [], compsIdentity: p.ident }));
  const listings: ShadowListing[] = listingRows.map((l) => ({ id: l.id, title: l.title, price: l.price, productId: l.product_id }));
  const memLoaded = process.memoryUsage();

  // ---- A. product names against each other, old vs proposed (strict, then with data-learned optional words)
  const optional = learnOptionalWords(products.map((p) => p.name));
  const tA = process.hrtime.bigint();
  const pairsStrict = comparePairs(products, isSimilarProductName);
  const msStrict = Number(process.hrtime.bigint() - tA) / 1e6;
  const tB = process.hrtime.bigint();
  const pairsLearned = comparePairs(products, isSimilarProductName, optional);
  const msLearned = Number(process.hrtime.bigint() - tB) / 1e6;

  // ---- B. generic entries with more specific siblings, and what was filed under them
  const generics = genericsWithSpecificSiblings(products);

  // ---- C. possibly mixed entries
  const mixed = products.map(assessMixed);

  // ---- D. listings resolved to entries: stored link vs old title rule vs proposed rule
  const tC = process.hrtime.bigint();
  const resolutions = resolveListings(listings, products, compMatchesSpecs);
  const msResolve = Number(process.hrtime.bigint() - tC) / 1e6;

  // ---- E. what the slice-1 doubt rule would trigger in live use: distinct specific entries (= WatchCount lookups) it would ask for
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const implied = new Map<string, string>();
  for (const r of resolutions) {
    const target = r.storedProductId ?? r.oldPick;
    const name = target ? nameById.get(target) : undefined;
    if (!name) continue;
    if (codesMissingFrom(name, r.title).length > 0) implied.set(specificNameFor(name, r.title).toLowerCase(), r.title);
  }

  const memPeak = process.memoryUsage();
  const hashAfter = await sha256(dbPath);
  const statAfter = fs.statSync(dbPath);

  // ---- outputs
  const jsonl = (file: string, rows: unknown[]) => fs.writeFileSync(path.join(outDir, file), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  jsonl("disagreements_pairs.jsonl", pairsLearned.disagreements);
  jsonl("disagreements_pairs_strict.jsonl", pairsStrict.disagreements);
  jsonl("generics_with_specific.jsonl", generics);
  jsonl("mixed_assessments.jsonl", mixed.filter((m) => m.mixed));
  jsonl("listing_resolutions.jsonl", resolutions);

  const rnd = mulberry32(20261012);
  const pick = <T>(rows: T[], n: number) => [...rows].sort(() => rnd() - 0.5).slice(0, n);
  const sample = [
    ...pick(pairsLearned.disagreements.filter((d) => d.kind === "old-same/new-line"), 30).map((d) => ({ type: d.kind, a: d.a, b: d.b, cat: d.categoryA, why: d.evidence.reasons.join("; ") })),
    ...pick(pairsLearned.disagreements.filter((d) => d.kind === "old-same/new-different"), 30).map((d) => ({ type: d.kind, a: d.a, b: d.b, cat: d.categoryA, why: d.evidence.reasons.join("; ") })),
    ...pick(pairsLearned.disagreements.filter((d) => d.kind === "old-different/new-exact"), 30).map((d) => ({ type: d.kind, a: d.a, b: d.b, cat: d.categoryA, why: d.evidence.reasons.join("; ") })),
  ];
  jsonl("manual_review_sample.jsonl", sample);

  const countBy = <T>(rows: T[], key: (r: T) => string) => rows.reduce<Record<string, number>>((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {});
  const summary = {
    database: { path: dbPath, bytes: statBefore.size, sha256Before: hashBefore, sha256After: hashAfter, unchanged: hashBefore === hashAfter && statBefore.size === statAfter.size && statBefore.mtimeMs === statAfter.mtimeMs },
    counts: { products: products.length, listings: listings.length, listingsWithProduct: listings.filter((l) => l.productId).length, filedTitles: products.reduce((n, p) => n + p.titles.length, 0), productsWithTitles: products.filter((p) => p.titles.length > 0).length, categories: countBy(products, (p) => p.category) },
    optionalWordsLearned: [...optional],
    pairs: {
      total: pairsStrict.pairs,
      strict: { matrix: pairsStrict.matrix, disagreements: pairsStrict.disagreements.length, byKind: countBy(pairsStrict.disagreements, (d) => d.kind) },
      learned: { matrix: pairsLearned.matrix, disagreements: pairsLearned.disagreements.length, byKind: countBy(pairsLearned.disagreements, (d) => d.kind) },
      byCategoryLearned: pairsLearned.byCategory,
    },
    collisions: {
      productsWithOldCollision: pairsLearned.collisions.filter((c) => c.old > 0).length,
      productsWithNewExactTwin: pairsLearned.collisions.filter((c) => c.newExact > 0).length,
      worstOld: [...pairsLearned.collisions].sort((a, b) => b.old - a.old).slice(0, 12),
    },
    generics: {
      genericEntriesWithSpecificSibling: new Set(generics.map((g) => g.generic.id)).size,
      pairs: generics.length,
      withFiledTitles: generics.filter((g) => g.generic.filedTitles > 0).length,
      withLikelyMisfiled: generics.filter((g) => g.likelyMisfiled.length > 0).length,
      examples: generics.filter((g) => g.likelyMisfiled.length > 0).slice(0, 15).map((g) => ({ generic: g.generic.name, specific: g.specific.name, distinguishing: g.distinguishing, misfiled: g.likelyMisfiled.slice(0, 3), category: g.generic.category })),
    },
    mixed: {
      assessable: mixed.filter((m) => m.assessable).length,
      mixed: mixed.filter((m) => m.mixed).length,
      byKind: countBy(mixed.filter((m) => m.mixed), (m) => m.kind ?? "?"),
      byCategory: countBy(mixed.filter((m) => m.mixed), (m) => m.category),
      examples: mixed.filter((m) => m.mixed).slice(0, 15),
      compsFlaggedApproximateOrUnresolved: products.filter((p) => p.compsIdentity === "approximate" || p.compsIdentity === "unresolved").length,
    },
    listings: {
      total: resolutions.length,
      withStoredLink: resolutions.filter((r) => r.storedProductId).length,
      oldPickedAny: resolutions.filter((r) => r.oldPick).length,
      newPickedAny: resolutions.filter((r) => r.newPick).length,
      bothPicked: resolutions.filter((r) => r.oldPick && r.newPick).length,
      bothPickedSame: resolutions.filter((r) => r.oldPick && r.newPick && r.oldPick === r.newPick).length,
      bothPickedDifferent: resolutions.filter((r) => r.oldPick && r.newPick && r.oldPick !== r.newPick).length,
      onlyOld: resolutions.filter((r) => r.oldPick && !r.newPick).length,
      onlyNew: resolutions.filter((r) => !r.oldPick && r.newPick).length,
      newLine: resolutions.filter((r) => r.newLevel === "line").length,
      newAmbiguous: resolutions.filter((r) => r.ambiguous).length,
      storedVsOldDifferent: resolutions.filter((r) => r.storedProductId && r.oldPick && r.storedProductId !== r.oldPick).length,
      storedVsNewDifferent: resolutions.filter((r) => r.storedProductId && r.newPick && r.storedProductId !== r.newPick).length,
      byCategoryOfStored: countBy(resolutions.filter((r) => r.storedProductId), (r) => products.find((p) => p.id === r.storedProductId)?.category ?? "?"),
    },
    costs: {
      aiCalls: 0,
      paidApiCalls: 0,
      networkAttempts: fetchAttempts,
      comparableSaleLookups: 0,
      impliedSpecificEntriesFromDoubtRule: implied.size,
      impliedExamples: [...implied].slice(0, 10),
    },
    performance: {
      msAllProductPairsStrict: Math.round(msStrict),
      msAllProductPairsLearned: Math.round(msLearned),
      microsecondsPerPair: Number(((msStrict * 1000) / pairsStrict.pairs).toFixed(2)),
      msResolveListings: Math.round(msResolve),
      microsecondsPerListing: Number(((msResolve * 1000) / Math.max(1, listings.length)).toFixed(1)),
      wallSecondsTotal: Number(((Date.now() - t0) / 1000).toFixed(1)),
      memoryMB: { rssAfterLoad: Math.round(memLoaded.rss / 1048576), rssPeak: Math.round(memPeak.rss / 1048576), heapAfterLoad: Math.round(memLoaded.heapUsed / 1048576), heapPeak: Math.round(memPeak.heapUsed / 1048576) },
    },
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
