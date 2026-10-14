// Phase 11.6 server load test. Runs ONLY against the throw-away test stack (compose project clynx-lan-test, http://10.0.0.81:8796); refuses any other address.
// Simulated users sign up, register a device and then run a closed loop of the calls a scanning desktop makes (no think time, so this measures saturation, not typical use).
// It never calls a third-party service: the AI/eBay proxy is only exercised on its "not configured" refusal path (no key exists on the test stack).
//   node audit/phase116/loadtest.cjs            -> writes audit/phase116/loadtest_result.json
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BASE = process.env.LOAD_BASE || "http://10.0.0.81:8796";
if (!/^http:\/\/10\.0\.0\.81:8796$/.test(BASE)) throw new Error("refusing: the load test only runs against the throw-away test stack");
const DURATION_S = Number(process.env.LOAD_SECONDS || 25);
const LEVELS = (process.env.LOAD_LEVELS || "2,5,10,25").split(",").map(Number);
const PW = "load-test-password-1";

const pct = (arr, p) => (arr.length ? +arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(1) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipCounter = 10;
const nextIp = () => `198.51.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

async function call(u, method, url, body, stats, label) {
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-forwarded-for": u.ip, ...(u.access ? { authorization: `Bearer ${u.access}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    status = res.status;
    var text = await res.text();
    if (stats) {
      const s = (stats[label] ??= { ms: [], ok: 0, bad: 0, statuses: {} });
      s.ms.push(performance.now() - t0);
      (status < 400 ? (s.ok++) : (s.bad++));
      s.statuses[status] = (s.statuses[status] || 0) + 1;
    }
    try { return { status, json: JSON.parse(text) }; } catch { return { status, json: null }; }
  } catch (e) {
    if (stats) { const s = (stats[label] ??= { ms: [], ok: 0, bad: 0, statuses: {} }); s.bad++; s.statuses.error = (s.statuses.error || 0) + 1; }
    return { status: 0, json: null };
  }
}

async function makeUser(stats) {
  const u = { email: `load-${crypto.randomUUID()}@load.test`, ip: nextIp() };
  const r = await call(u, "POST", "/auth/register", { email: u.email, password: PW }, stats, "register");
  if (r.status !== 201) throw new Error("register failed " + r.status + JSON.stringify(r.json));
  u.access = r.json.accessToken; u.refresh = r.json.refreshToken; u.id = r.json.userId;
  const d = await call(u, "POST", "/devices/register", { platform: "windows", clientVersion: "0.3.0-beta.3" }, stats, "device_register");
  u.device = d.json.id;
  u.watchLocal = crypto.randomUUID(); u.productLocal = crypto.randomUUID(); u.rev = 1;
  return u;
}

function listings(u, n) {
  const now = Date.now();
  return Array.from({ length: n }, () => ({ source: "facebook", sourceListingId: `L${crypto.randomUUID()}`, title: "Xbox Series S 512GB console with controller", description: "Works great, selling because upgrading. Pickup only. ".repeat(4), price: 150 + Math.floor(Math.random() * 100), url: "https://www.facebook.com/marketplace/item/1/", images: ["https://example.test/a.jpg", "https://example.test/b.jpg", "https://example.test/c.jpg"], locationText: "Austin, TX", listingAge: "2 hours ago", sellerName: "Seller", firstSeenAt: now }));
}

async function cycle(u, stats) {
  await call(u, "POST", "/listings/ingest", { listings: listings(u, 50) }, stats, "ingest50");
  await call(u, "GET", "/watches?since=0", undefined, stats, "get_watches");
  await call(u, "GET", "/products?since=0", undefined, stats, "get_products");
  await call(u, "GET", "/feedback?since=0", undefined, stats, "get_feedback");
  await call(u, "POST", `/devices/${u.device}/heartbeat`, undefined, stats, "heartbeat");
  u.rev++;
  await call(u, "PUT", `/watches/${u.watchLocal}`, { name: "Xbox", searchPhrase: "xbox series s", matchKeywords: [], locationMode: "country", enabled: true, createdAt: Date.now(), updatedAt: Date.now() + u.rev }, stats, "put_watch");
  await call(u, "PUT", `/products/${u.productLocal}`, { name: "Xbox Series S", createdAt: Date.now(), updatedAt: Date.now() + u.rev, resalePriceUsd: 200 }, stats, "put_product");
}

function dockerStatsSampler() {
  const samples = [];
  let stop = false;
  const loop = async () => {
    while (!stop) {
      await new Promise((resolve) => execFile("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"], (err, out) => {
        if (!err) for (const line of out.split("\n")) {
          const [name, cpu, mem] = line.trim().split("|");
          if (!/clynx-lan-test/.test(name || "")) continue;
          const m = /([\d.]+)(MiB|GiB|KiB)/.exec(mem || "");
          samples.push({ name: name.replace("clynx-lan-test-", "").replace("-1", ""), cpu: parseFloat(cpu), memMiB: m ? (m[2] === "GiB" ? +m[1] * 1024 : m[2] === "KiB" ? +m[1] / 1024 : +m[1]) : null });
        }
        resolve();
      }));
    }
  };
  const p = loop();
  return { async finish() { stop = true; await p; const by = {}; for (const s of samples) { const b = (by[s.name] ??= { cpuPeak: 0, memPeakMiB: 0 }); b.cpuPeak = Math.max(b.cpuPeak, s.cpu || 0); b.memPeakMiB = Math.max(b.memPeakMiB, s.memMiB || 0); } for (const k of Object.keys(by)) { by[k].cpuPeak = +by[k].cpuPeak.toFixed(1); by[k].memPeakMiB = +by[k].memPeakMiB.toFixed(0); } return by; } };
}

function summarize(stats) {
  const out = {};
  for (const [k, s] of Object.entries(stats)) out[k] = { n: s.ms.length + (s.statuses.error || 0), p50: pct(s.ms, 0.5), p95: pct(s.ms, 0.95), p99: pct(s.ms, 0.99), max: pct(s.ms, 1), errors: s.bad, statuses: s.statuses };
  return out;
}

(async () => {
  const result = { startedAt: new Date().toISOString(), base: BASE, durationSecondsPerLevel: DURATION_S };

  // ---- 0. baseline latency, one user, idle server
  {
    const stats = {};
    const u = await makeUser(stats);
    for (let i = 0; i < 20; i++) await call(u, "POST", "/auth/login", { email: u.email, password: PW, deviceId: u.device }, stats, "login");
    for (let i = 0; i < 20; i++) await call(u, "POST", "/auth/refresh", { refreshToken: (await call(u, "POST", "/auth/login", { email: u.email, password: PW }, null, "x")).json.refreshToken, deviceId: u.device }, stats, "login_then_refresh");
    for (let i = 0; i < 40; i++) await cycle(u, stats);
    result.baselineOneUser = summarize(stats);
  }

  // ---- 1. concurrent sign-ups / logins (password hashing is the expensive step)
  for (const n of [5, 25]) {
    const sampler = dockerStatsSampler();
    const stats = {};
    const t0 = performance.now();
    const users = await Promise.all(Array.from({ length: n }, () => makeUser(stats)));
    const regMs = performance.now() - t0;
    const t1 = performance.now();
    await Promise.all(users.map((u) => call(u, "POST", "/auth/login", { email: u.email, password: PW }, stats, "login_burst")));
    result[`burst_signup_${n}`] = { wallSignupMs: Math.round(regMs), wallLoginMs: Math.round(performance.now() - t1), latency: summarize(stats), containers: await sampler.finish() };
  }

  // ---- 2. closed-loop load at 2 / 5 / 10 / 25 simulated users
  result.levels = {};
  for (const n of LEVELS) {
    const setupStats = {};
    const users = await Promise.all(Array.from({ length: n }, () => makeUser(setupStats)));
    await sleep(1500);
    const stats = {};
    const sampler = dockerStatsSampler();
    const end = Date.now() + DURATION_S * 1000;
    let cycles = 0;
    const t0 = performance.now();
    await Promise.all(users.map(async (u) => { while (Date.now() < end) { await cycle(u, stats); cycles++; } }));
    const secs = (performance.now() - t0) / 1000;
    const total = Object.values(stats).reduce((a, s) => a + s.ms.length + (s.statuses.error || 0), 0);
    result.levels[n] = { users: n, seconds: +secs.toFixed(1), cycles, requests: total, requestsPerSecond: +(total / secs).toFixed(1), listingsIngestedPerSecond: +((stats.ingest50?.ms.length || 0) * 50 / secs).toFixed(0), latency: summarize(stats), containers: await sampler.finish() };
    await sleep(3000);
  }

  // ---- 3. the paid-API gate with nothing configured: how fast is a refusal, and does one user's burst affect another's normal calls
  {
    const stats = {};
    const noisy = await makeUser(null), quiet = await makeUser(null);
    const bursts = Array.from({ length: 10 }, async () => { for (let i = 0; i < 30; i++) await call(noisy, "POST", "/ai/chat/completions", { model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }, stats, "ai_refused_noisy_user"); });
    const during = (async () => { for (let i = 0; i < 40; i++) { await call(quiet, "GET", "/watches?since=0", undefined, stats, "quiet_user_get_during_ai_burst"); await sleep(50); } })();
    await Promise.all([...bursts, during]);
    result.aiRefusalPathAndFairness = summarize(stats);
  }

  // ---- 4. rate-limit identity: with TRUST_PROXY on (as on the real server) does a client-chosen X-Forwarded-For escape the failed-login limit?
  {
    const victim = await makeUser(null);
    const same = []; const rotating = [];
    const probeSame = { ip: "203.0.113.200" };
    for (let i = 0; i < 12; i++) same.push((await call(probeSame, "POST", "/auth/login", { email: victim.email, password: "wrong-password-" + i }, null, "x")).status);
    for (let i = 0; i < 12; i++) rotating.push((await call({ ip: `203.0.113.${100 + i}` }, "POST", "/auth/login", { email: victim.email, password: "wrong-password-" + i }, null, "x")).status);
    result.failedLoginLimit = { sameForwardedFor: same, rotatingForwardedFor: rotating };
  }

  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "loadtest_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ levels: Object.fromEntries(Object.entries(result.levels).map(([k, v]) => [k, { rps: v.requestsPerSecond, ingestPerSec: v.listingsIngestedPerSecond, ingestP95: v.latency.ingest50?.p95, getP95: v.latency.get_watches?.p95, errors: Object.values(v.latency).reduce((a, s) => a + s.errors, 0), containers: v.containers }])), failedLoginLimit: result.failedLoginLimit }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
