// Phase 11.6 - local database benchmark (the desktop's SQLite store, the source of truth for Feed / Database / Watch).
// Run:  node audit/phase116/run_bench_store.cjs      (bundles this file with esbuild exactly like scripts/run-tests.cjs, then runs it with Node)
import { Store } from "../../src/main/store.js";
import { scoredListing } from "../../src/main/__tests__/_fixtures.js";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ms = (t0: number) => +(performance.now() - t0).toFixed(2);
function time<T>(fn: () => T, reps: number): { p50: number; p95: number; max: number; last: T } {
  const t: number[] = [];
  let last!: T;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    last = fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { p50: +t[Math.floor(t.length * 0.5)].toFixed(2), p95: +t[Math.floor(t.length * 0.95)].toFixed(2), max: +t[t.length - 1].toFixed(2), last };
}

const dir = mkdtempSync(path.join(tmpdir(), "clynx-bench-"));
const file = path.join(dir, "bench.db");
const out: Record<string, unknown> = {};
for (const N of [1_000, 10_000, 50_000]) {
  const f = path.join(dir, `b${N}.db`);
  const store = new Store(f);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) store.saveScored(scoredListing(`Item ${i} Xbox Series S 512GB console bundle`, 100 + (i % 400), { isDeal: i % 17 === 0 }, { id: `bench-${i}`, listingAge: `${(i % 30) + 1} days ago` }));
  const insertMs = ms(t0);
  const products = Math.min(N / 5, 5000);
  for (let i = 0; i < products; i++) store.addProductStub(`p-${i}`, `Product model ${i} Pro ${i % 97}`);
  const r: Record<string, unknown> = {
    listings: N,
    products,
    insertPerListingMs: +(insertMs / N).toFixed(3),
    dbSizeMB: +(statSync(f).size / 1048576).toFixed(1),
    feedFirstPage200: time(() => store.listRecent(200, 0), 30),
    feedDeepPage200: time(() => store.listRecent(200, Math.max(0, N - 400)), 30),
    countListings: time(() => store.countListings(), 30),
    getById: time(() => store.getById(`bench-${Math.floor(N / 2)}`), 100),
    unsyncedBatch50: time(() => store.listUnsyncedListings(50), 30),
    productIndex: time(() => store.listProductIndex(), 20),
    findMatchingProduct: time(() => store.findMatchingProduct("Product model 4000 Pro 20"), 50),
  };
  for (const k of Object.keys(r)) if (r[k] && typeof r[k] === "object") delete (r[k] as { last?: unknown }).last;
  out[`N=${N}`] = r;
}
console.log(JSON.stringify(out, null, 2));
rmSync(dir, { recursive: true, force: true });
