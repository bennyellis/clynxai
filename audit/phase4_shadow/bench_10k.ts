// Scaling benchmark for the identity foundation on a SYNTHETIC library (made-up names, a temp folder; no real data). Measures the full backfill (step times),
// indexed candidate retrieval, and memory, at 1,000 and 10,000 products.
//   node audit/phase4_shadow/build.cjs bench_10k && node audit/phase4_shadow/bench_10k.cjs
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
const R = rng(42);
const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
const brands = Array.from({ length: 400 }, (_, i) => `Brand${i.toString(36)}x`);
const nouns = ["drill", "guitar", "camera", "stroller", "blender", "monitor", "jacket", "bicycle", "console", "speaker", "keyboard", "lamp", "watch", "skillet", "router", "tent", "scooter", "mixer", "printer", "headphones", "projector", "vacuum", "saw", "amplifier", "helmet"];
const adjs = ["pro", "mini", "ultra", "classic", "compact", "wireless", "portable", "deluxe", "sport", "studio", "travel", "digital"];
const name = () => {
  const code = `${String.fromCharCode(97 + Math.floor(R() * 26))}${Math.floor(R() * 900 + 100)}`;
  const parts = [pick(brands), pick(nouns), R() < 0.7 ? code : "", R() < 0.5 ? pick(adjs) : "", R() < 0.2 ? `${pick([16, 32, 64, 128, 256, 512])}GB` : ""];
  return parts.filter(Boolean).join(" ");
};

async function run(n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-bench10k-"));
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
  const insL = db.prepare("INSERT INTO listings (id, title, url, first_seen_at, source, seller_name, product_id) VALUES (?, ?, ?, ?, 'facebook', ?, ?)");
  for (let i = 0; i < n / 5; i++) insL.run(`L${i.toString().padStart(6, "0")}`, `${pick(names)} ${pick(["used", "great shape", "works", "obo"])}`, `https://x/${i}`, i, `s${i % 400}`, null);
  db.exec("COMMIT");
  db.close();

  const store = new Store(file, { identityFoundation: true });
  const rssBefore = process.memoryUsage().rss;
  const times: number[] = [];
  const slow: Array<{ phase: string; ms: number }> = [];
  const t0 = Date.now();
  for (;;) {
    const phase = store.identity!.backfillStatus().phase;
    const s = performance.now();
    const r = store.identity!.backfillStep(20);
    const ms = performance.now() - s;
    times.push(ms);
    if (ms > 50) slow.push({ phase, ms: Math.round(ms) });
    if (r.done) break;
  }
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  const heapAfterGc = Math.round(process.memoryUsage().heapUsed / 1048576);
  const total = Date.now() - t0;
  const sorted = [...times].sort((a, b) => a - b);
  const q = (f: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))].toFixed(1));
  // candidate retrieval: 500 queries built from real names plus noise words
  const lat: number[] = [];
  let hits = 0;
  for (let i = 0; i < 500; i++) {
    const base = names[Math.floor(R() * names.length)];
    const s = performance.now();
    const c = store.identity!.candidates(`${base} used works great ${pick(adjs)}`, 20);
    lat.push(performance.now() - s);
    if (c.some((x) => x.name === base)) hits++;
  }
  lat.sort((a, b) => a - b);
  const stats = store.identity!.stats();
  const rssAfter = process.memoryUsage().rss;
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      products: n,
      listings: n / 5,
      backfill: { totalSeconds: Number((total / 1000).toFixed(1)), steps: times.length, stepP50Ms: q(0.5), stepP95Ms: q(0.95), stepMaxMs: Number(sorted[sorted.length - 1].toFixed(1)), stepsOver50Ms: times.filter((t) => t > 50).length },
      retrieval: { queries: 500, p50Ms: Number(lat[250].toFixed(2)), p95Ms: Number(lat[475].toFixed(2)), maxMs: Number(lat[499].toFixed(2)), foundTheNamedProductInTop20: `${hits}/500` },
      rows: stats,
      slowSteps: Object.entries(slow.reduce<Record<string, number[]>>((m, x) => ((m[x.phase] ??= []).push(x.ms), m), {})).map(([k, v]) => `${k}: ${v.length} (max ${Math.max(...v)} ms)`),
      memoryMB: { rssBefore: Math.round(rssBefore / 1048576), rssAfter: Math.round(rssAfter / 1048576), heapUsedAfterGc: heapAfterGc },
    })
  );
}

(async () => {
  await run(1000);
  await run(10000);
})();
