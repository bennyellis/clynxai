// Phase 12 (Beta 6): the real Docker stack (throw-away copy, http://10.0.0.81:8796) under the failures that broke Phase 11.6:
//   Redis stopped  -> sign-in, listing upload, AI and /health/ready must answer quickly (they hung forever)
//   Postgres stopped -> the API must NOT crash (it did) and must answer 503 quickly, then recover by itself
//   DELETE with a JSON content type and no body -> must not be a 400
//   the search planner -> refused to a customer
// Refuses to run against anything but the throw-away stack. No third-party service is contacted (the AI call is refused by the server for lack of a key on the test stack).
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const BASE = "http://10.0.0.81:8796";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }).trim();
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "   " + JSON.stringify(detail)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, url, { token, body, headers = {}, ms = 8000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, json: null, error: String(e.message || e) };
  }
}
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return Date.now(); await sleep(500); } return null; };
const apiState = () => JSON.parse(docker("inspect", "clynx-lan-test-api-1", "--format", "{\"restarts\":{{.RestartCount}},\"started\":\"{{.State.StartedAt}}\"}"));

(async () => {
  const email = `outage-${crypto.randomBytes(3).toString("hex")}@beta.test`, pw = "outage-test-pass-1";
  const reg = await call("POST", "/auth/register", { body: { email, password: pw } });
  check("[0] the throw-away stack answers and a test account is created", reg.status === 201, reg);
  const token = reg.json.accessToken;
  const before = apiState();

  // ---- DELETE with a JSON content type and no body
  const w = await call("PUT", `/watches/${crypto.randomUUID()}`, { token, body: { name: "w", searchPhrase: "p", matchKeywords: [], locationMode: "country", enabled: true, createdAt: 1, updatedAt: 1 } });
  const del = await call("DELETE", `/watches/${w.json.watch.id}`, { token, headers: { "content-type": "application/json" } });
  check("[1] DELETE with 'content-type: application/json' and no body is a 200 (it was a 400)", del.status === 200, del);
  const delAgain = await call("DELETE", `/watches/${w.json.watch.id}`, { token, headers: { "content-type": "application/json" } });
  check("[1] ...and the Watch is really gone (second delete is 404)", delAgain.status === 404, delAgain);

  // ---- the search planner
  const sp = await call("GET", "/search-planner/demand", { token });
  check("[2] a customer cannot read the search planner (403)", sp.status === 403, sp);

  // ---- Redis stopped
  docker("stop", "clynx-lan-test-redis-1");
  await sleep(2500);
  const r1 = await call("GET", "/health/ready");
  check("[3] Redis stopped: /health/ready answers 503 quickly (it hung)", r1.status === 503 && r1.ms < 3000 && r1.json?.checks?.redis === "down", r1);
  const r2 = await call("POST", "/auth/login", { body: { email, password: pw } });
  check("[3] Redis stopped: sign-in still works and answers in under 3 s (it hung)", r2.status === 200 && r2.ms < 3000, r2);
  const r3 = await call("POST", "/auth/login", { body: { email, password: "wrong-password-1" } });
  check("[3] Redis stopped: a wrong password is still refused (401)", r3.status === 401 && r3.ms < 3000, r3);
  const r4 = await call("POST", "/listings/ingest", { token, body: { source: "facebook", sourceListingId: `redis-down-${Date.now()}`, title: "t", url: "https://x.test/1", firstSeenAt: 1 } });
  check("[3] Redis stopped: a listing upload is stored and answers in under 6 s (it hung)", r4.status === 200 && r4.ms < 6000, r4);
  const r5 = await call("POST", "/ai/chat/completions", { token, body: { model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] } });
  check("[3] Redis stopped: an AI request is answered (here: refused for lack of a key) in under 3 s (it hung)", r5.status > 0 && r5.ms < 3000, r5);
  const r6 = await call("GET", "/watches", { token });
  check("[3] Redis stopped: ordinary data calls are unaffected", r6.status === 200, r6);
  docker("start", "clynx-lan-test-redis-1");
  const back = await until(async () => (await call("GET", "/health/ready")).status === 200, 60000);
  check("[3] Redis started again: the API reports ready by itself, no restart", !!back && apiState().restarts === before.restarts && apiState().started === before.started, { back: !!back, now: apiState(), before });

  // ---- Postgres stopped
  docker("stop", "clynx-lan-test-postgres-1");
  await sleep(4000);
  const d1 = await call("GET", "/health");
  check("[4] Postgres stopped: the API process is still ALIVE and /health answers 503 quickly (it crashed)", d1.status === 503 && d1.ms < 8000, d1);
  const d2 = await call("POST", "/auth/login", { body: { email, password: pw } });
  check("[4] Postgres stopped: sign-in answers with an error in under 8 s instead of hanging or dying", d2.status >= 500 && d2.ms < 8000, d2);
  const mid = apiState();
  check("[4] the API container was NOT restarted by the outage", mid.restarts === before.restarts && mid.started === before.started, { mid, before });
  docker("start", "clynx-lan-test-postgres-1");
  const t0 = Date.now();
  const ok = await until(async () => (await call("GET", "/health")).status === 200, 90000);
  check("[4] Postgres started again: the API serves requests again by itself", !!ok, null);
  console.log(`   (recovered ${ok ? Math.round((ok - t0) / 1000) : "-"} s after Postgres was started; before this fix the API crashed and Docker had to restart it)`);
  const login = await call("POST", "/auth/login", { body: { email, password: pw } });
  check("[4] ...sign-in works again and the account and data survived", login.status === 200, login);
  const after = apiState();
  check("[4] the API process was the same one all along (no restart)", after.restarts === before.restarts && after.started === before.started, { after, before });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
