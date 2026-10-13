// Cost of the veto-only safeguard on a SYNTHETIC library (made-up names, a temp folder; no real data, no network): the one-off cost of building its view of the Database, the
// extra time per valuation / filing / signals lookup with the safeguard off, in shadow and enforcing, and the memory it holds. At 1,000 and 10,000 products.
//   node audit/phase4_shadow/build.cjs bench_safeguard && node --expose-gc audit/phase4_shadow/bench_safeguard.cjs [output.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const R = rng(11);
const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
const brands = Array.from({ length: 400 }, (_, i) => `Brand${i.toString(36)}x`);
const nouns = ["drill", "guitar", "camera", "stroller", "blender", "monitor", "jacket", "bicycle", "console", "speaker", "keyboard", "lamp", "watch", "skillet", "router", "tent", "scooter", "mixer", "printer", "headphones"];
const adjs = ["pro", "mini", "ultra", "classic", "compact", "wireless", "portable", "deluxe", "sport", "studio"];
const name = () => {
  const code = `${String.fromCharCode(97 + Math.floor(R() * 26))}${Math.floor(R() * 900 + 100)}`;
  return [pick(brands), pick(nouns), R() < 0.7 ? code : "", R() < 0.5 ? pick(adjs) : "", R() < 0.2 ? `${pick([16, 32, 64, 128, 256, 512])}GB` : ""].filter(Boolean).join(" ");
};
const mb = (n: number) => Math.round(n / 1048576);
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const summarize = (a: number[]) => ({ n: a.length, p50Ms: Number(pct(a, 0.5).toFixed(3)), p95Ms: Number(pct(a, 0.95).toFixed(3)), maxMs: Number(Math.max(...a).toFixed(3)) });

async function run(n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-benchguard-"));
  const file = path.join(dir, "scout.db");
  new Store(file).close();
  const db = new DatabaseSync(file);
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO products (id, name, category, created_at, ebay_avg_sold_price_usd, ebay_comps_sample_size) VALUES (?, ?, 'Other', ?, ?, 6)");
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const nm = name();
    names.push(nm);
    ins.run(`p${i.toString().padStart(6, "0")}`, nm, i, 20 + Math.floor(R() * 400));
  }
  const insL = db.prepare("INSERT INTO listings (id, title, url, first_seen_at, source, seller_name) VALUES (?, ?, ?, ?, 'facebook', ?)");
  for (let i = 0; i < Math.min(n, 3000); i++) insL.run(`L${i}`, `${pick(names)} ${pick(["used", "great shape", "works", "obo"])}`, `https://x/${i}`, i, `s${i % 300}`);
  db.exec("COMMIT");
  db.close();

  const titles = Array.from({ length: 400 }, () => {
    const nm = pick(names);
    return R() < 0.5 ? `${nm} ${pick(["used", "like new", "with box"])}` : `${pick(names)} bundle`; // half are about the entry, half about another
  });
  const out: Record<string, unknown> = { products: n };
  for (const mode of ["off", "shadow", "enforce"] as const) {
    const store = new Store(file);
    gc();
    const heap0 = process.memoryUsage().heapUsed;
    store.setIdentitySafeguard(mode, mode === "off" ? null : () => {});
    const lat: number[] = [];
    const valuation: number[] = [];
    let first = 0;
    for (let i = 0; i < titles.length; i++) {
      const t = titles[i];
      const matched = names.find((nm) => t.startsWith(nm)) ?? names[i % names.length];
      const s = performance.now();
      store.getEbayValueForProductName(matched, t);
      const ms = performance.now() - s;
      if (i === 0) first = ms;
      valuation.push(ms);
      const s2 = performance.now();
      store.getProductSignals(matched, t);
      lat.push(performance.now() - s2);
    }
    gc();
    out[mode] = {
      firstCallMs: Number(first.toFixed(1)), valuationLookup: summarize(valuation.slice(1)), signalsLookup: summarize(lat.slice(1)), heapHeldMB: mb(process.memoryUsage().heapUsed - heap0),
      safeguard: { ...store.safeguard.stats, totalMs: Math.round(store.safeguard.stats.totalMs), contextBuildMs: Math.round(store.safeguard.stats.contextBuildMs), maxMs: Number(store.safeguard.stats.maxMs.toFixed(2)) },
    };
    store.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
(async () => {
  const all = [];
  for (const n of [1000, 10000]) all.push(await run(n));
  console.log(JSON.stringify(all, null, 1));
  fs.writeFileSync(process.argv[2] ?? path.join(os.tmpdir(), "bench_safeguard.json"), JSON.stringify(all, null, 2));
})();
