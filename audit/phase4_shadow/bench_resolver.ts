// Scaling benchmark for the foundation RESOLVER on a SYNTHETIC library (made-up names, a temp folder; no real data, no network): context build time and memory,
// pair-comparison throughput, listing resolution through the indexed candidates, and (for contrast) brute force over every entry. At 1,000 and 10,000 products.
//   node audit/phase4_shadow/build.cjs bench_resolver && node --expose-gc audit/phase4_shadow/bench_resolver.cjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildContext, compareProducts, resolveListing } from "../../src/main/identity/foundationResolver.ts";
import { Store } from "../../src/main/store.ts";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(7);
const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
const brands = Array.from({ length: 400 }, (_, i) => `Brand${i.toString(36)}x`);
const nouns = ["drill", "guitar", "camera", "stroller", "blender", "monitor", "jacket", "bicycle", "console", "speaker", "keyboard", "lamp", "watch", "skillet", "router", "tent", "scooter", "mixer", "printer", "headphones", "projector", "vacuum", "saw", "amplifier", "helmet"];
const adjs = ["pro", "mini", "ultra", "classic", "compact", "wireless", "portable", "deluxe", "sport", "studio", "travel", "digital"];
const name = () => {
  const code = `${String.fromCharCode(97 + Math.floor(R() * 26))}${Math.floor(R() * 900 + 100)}`;
  return [pick(brands), pick(nouns), R() < 0.7 ? code : "", R() < 0.5 ? pick(adjs) : "", R() < 0.2 ? `${pick([16, 32, 64, 128, 256, 512])}GB` : ""].filter(Boolean).join(" ");
};
const mb = (n: number) => Math.round(n / 1048576);
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

async function run(n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-benchres-"));
  const file = path.join(dir, "scout.db");
  new Store(file).close();
  const db = new DatabaseSync(file);
  db.exec("BEGIN");
  const insP = db.prepare("INSERT INTO products (id, name, category, created_at) VALUES (?, ?, ?, ?)");
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const nm = name();
    names.push(nm);
    insP.run(`p${i.toString().padStart(6, "0")}`, nm, "Other", i);
  }
  db.exec("COMMIT");
  db.close();
  const store = new Store(file, { identityFoundation: true });
  while (!store.identity!.backfillStep(50).done) {
    /* drain */
  }
  const entries = names.map((nm, i) => ({ id: `p${i.toString().padStart(6, "0")}`, name: nm }));
  const titles = Array.from({ length: 300 }, () => `${pick(names)} ${pick(["used", "great shape", "works", "obo", "with box", "like new"])}`);
  const docs = titles.map((t, i) => ({ text: t, origin: `seller:${i % 50}`, kind: "listing" as const }));

  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const ctx = buildContext(entries, docs);
  const buildMs = performance.now() - t0;
  gc();
  const heap1 = process.memoryUsage().heapUsed;

  const pairs = 200000;
  const tp = performance.now();
  let k = 0;
  for (let i = 0; i < pairs; i++) {
    const a = ctx.info(entries[(i * 7919) % n].id)!;
    const b = ctx.info(entries[(i * 104729 + 13) % n].id)!;
    if (a.id !== b.id) compareProducts(a, b, ctx);
    k++;
  }
  const pairMs = performance.now() - tp;

  const idx: number[] = [];
  const idxRetrieve: number[] = [];
  for (const t of titles) {
    const s = performance.now();
    const cands = store.identity!.candidates(t, 30);
    idxRetrieve.push(performance.now() - s);
    resolveListing(t, cands.map((c) => ({ id: c.productId, name: c.name })), ctx, {});
    idx.push(performance.now() - s);
  }
  const brute: number[] = [];
  const bruteN = n >= 10000 ? 10 : 60;
  for (const t of titles.slice(0, bruteN)) {
    const s = performance.now();
    resolveListing(t, entries, ctx, {});
    brute.push(performance.now() - s);
  }
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    products: n, contextBuildMs: Math.round(buildMs), contextHeapMB: mb(heap1 - heap0), rssGrowthMB: mb(process.memoryUsage().rss - rss0),
    pairCompare: { pairs: k, microsecondsPerPair: Number(((pairMs * 1000) / k).toFixed(2)) },
    listingViaIndex: { n: idx.length, p50Ms: Number(pct(idx, 0.5).toFixed(2)), p95Ms: Number(pct(idx, 0.95).toFixed(2)), maxMs: Number(Math.max(...idx).toFixed(2)), retrievalOnlyP50Ms: Number(pct(idxRetrieve, 0.5).toFixed(2)) },
    listingBruteForceAllEntries: { n: brute.length, p50Ms: Number(pct(brute, 0.5).toFixed(2)), p95Ms: Number(pct(brute, 0.95).toFixed(2)) },
  };
}
(async () => {
  const out = [];
  for (const n of [1000, 10000]) out.push(await run(n));
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync(process.argv[2] ?? path.join(os.tmpdir(), "bench_resolver.json"), JSON.stringify(out, null, 2));
})();
