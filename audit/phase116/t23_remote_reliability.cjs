// T23 (Phase 11.6): the PACKAGED desktop app against the throw-away test stack (compose project clynx-lan-test, http://10.0.0.81:8796):
//   timings (cold start, sign-in, memory, idle CPU) and failure recovery (server down, database down, Redis down, backend restart, hard crash of the app, "host restart" = whole stack stopped and started).
// Never touches the real server, the real %APPDATA%\Clynx, a real Facebook session or any paid service. Creates one throw-away account on the test stack.
const L = require("../phase115_integration/lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const EXE = process.env.INSTALLED_EXE || path.join(L.PROJECT, "dist", "win-unpacked", "Clynx.exe");
const HOST = "10.0.0.81", PORT = 8796, LAN = `http://${HOST}:${PORT}`;
const ENVFILE = "C:\\Users\\biggt\\ClynxLanTest\\.env.lan";
const env = Object.fromEntries(fs.readFileSync(ENVFILE, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
const psql = (sql) => docker("exec", "clynx-lan-test-postgres-1", "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-tAc", sql).trim();
const curlStatus = (url, method = "GET", body, maxS = 20) => { const a = ["-s", "-o", "NUL", "-m", String(maxS), "-w", "%{http_code}", "-X", method, url]; if (body) a.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body)); return spawnSync("curl", a, { encoding: "utf8" }).stdout; };
const sleep = L.sleep;
const until = async (fn, ms, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return Date.now(); } catch { /* retry */ } await sleep(every); } return null; };
const text = (win) => win.evaluate(() => document.body.innerText);
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const R = {}; // measurements
const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t23-"));
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function launch(userData) {
  const t0 = Date.now();
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: path.dirname(EXE), env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 90000 });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  const out = [];
  app.process().stdout?.on("data", (d) => out.push(String(d)));
  app.process().stderr?.on("data", (d) => out.push(String(d)));
  app.process().once("exit", (code, sig) => { console.log(`[app pid ${app.process().pid}] EXITED code=${code} signal=${sig} at ${new Date().toISOString()}`); });
  return { app, win, t0, pid: app.process().pid, out };
}
async function quit(h) {
  let exited;
  try { exited = new Promise((r) => h.app.process().once("exit", () => r(true))); } catch { return; }
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  await Promise.race([exited, sleep(25000)]);
}
async function metrics(h) {
  const m = await h.app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, ws: p.memory.workingSetSize, priv: p.memory.privateBytes ?? 0, cpu: p.cpu.percentCPUUsage })));
  return { processes: m.length, workingSetMB: Math.round(m.reduce((a, p) => a + p.ws, 0) / 1024), privateMB: Math.round(m.reduce((a, p) => a + p.priv, 0) / 1024), cpuPercentSum: +m.reduce((a, p) => a + p.cpu, 0).toFixed(1) };
}
const cloudCount = (email, table) => Number(psql(`select count(*) from ${table} t join users u on u.id=t.user_id where u.email='${email}'`));

(async () => {
  let h = null;
  const EMAIL = `rel-${crypto.randomBytes(3).toString("hex")}@beta.test`, PW = "reliability-pass-1";
  const profile = path.join(root, "p1");
  fs.mkdirSync(profile, { recursive: true });
  try {
    L.check("[0] packaged build + throw-away stack reachable", fs.existsSync(path.join(path.dirname(EXE), "resources", "app.asar")) && curlStatus(`${LAN}/health`) === "200");

    // ------------------------------------------------ A. cold start of a brand-new install (first screen), 5 runs
    const cold = [];
    for (let i = 0; i < 5; i++) {
      const p = path.join(root, `cold${i}`);
      fs.mkdirSync(p, { recursive: true });
      const hh = await launch(p);
      await hh.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
      cold.push(Date.now() - hh.t0);
      await quit(hh);
    }
    R.coldStartToFirstScreenMs = { runs: cold, median: median(cold) };

    // ------------------------------------------------ B. register + sign-in timings through the real UI
    h = await launch(profile);
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
    await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('[data-testid="server-url-input"]');
    await h.win.fill('[data-testid="server-url-input"]', `${HOST}:${PORT}`);
    await h.win.waitForSelector('[data-testid="server-ok"]', { timeout: 30000 });
    await clickText(h.win, /Need an account/);
    await h.win.fill('input[type="email"]', EMAIL);
    await h.win.fill('input[type="password"]', PW);
    let t = Date.now();
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    R.registerClickToAppReadyMs = Date.now() - t;
    L.check("[B] registered through the app and signed in", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    await until(async () => (await h.win.evaluate(() => window.api.cloud.getStatus())).deviceId, 30000, 1000);

    // idle footprint after 20 s
    await sleep(20000);
    R.idleSignedIn = await metrics(h);
    await sleep(5000);
    R.idleSignedInAfter25s = await metrics(h);
    await quit(h);

    // warm start of a signed-in install, 5 runs (to the main screen)
    const warm = [];
    for (let i = 0; i < 5; i++) {
      h = await launch(profile);
      await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
      warm.push(Date.now() - h.t0);
      if (i < 4) await quit(h);
    }
    R.signedInStartToMainScreenMs = { runs: warm, median: median(warm) };

    // sign out / in latency through the UI
    await clickText(h.win, /^Config$/); await sleep(500); await clickText(h.win, /^account$/);
    await h.win.waitForSelector('[data-testid="account-section"]', { timeout: 30000 });
    await clickText(h.win, /^Log out$/);
    await h.win.waitForFunction(() => !!document.querySelector('input[type="password"], [data-testid="beta-welcome"]'), null, { timeout: 30000 });
    if ((await h.win.locator('[data-testid="beta-welcome"]').count()) > 0) await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('[data-testid="server-url-input"]', { timeout: 20000 });
    await h.win.waitForSelector('[data-testid="server-ok"]', { timeout: 30000 });
    await h.win.fill('input[type="email"]', EMAIL); await h.win.fill('input[type="password"]', PW);
    t = Date.now();
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    R.signInClickToAppReadyMs = Date.now() - t;

    // ------------------------------------------------ C. watches sync up; then the server goes away
    const mk = async (name) => { const w = await h.win.evaluate((n) => window.api.createWatch({ name: n, platform: "facebook", searchPhrase: n, linkedProductId: null, minPriceUsd: null, maxPriceUsd: null, minProfitUsd: null, minDiscountPercent: null, maxListingAgeMinutes: null, minSellerRatingPercent: null, locationMode: "country", selectedState: null, selectedCityOrZip: null, searchRadiusMiles: null }), name); await h.win.evaluate((id) => window.api.setWatchEnabled(id, false), w.id); return w; };
    await mk("Reliability watch 1");
    const syncedAt = await until(() => cloudCount(EMAIL, "watches") >= 1, 120000, 2000);
    L.check("[C] a Watch created in the app reaches the server by itself", !!syncedAt);
    R.watchSyncDelayMs = syncedAt ? syncedAt - t : null;

    docker("stop", "clynx-lan-test-api-1");
    await h.win.evaluate(() => window.api.cloud.retryNow()).catch(() => {});
    const offline = await until(async () => (await h.win.evaluate(() => window.api.cloud.getStatus())).online === false, 60000, 2000);
    L.check("[C] with the server stopped the app notices (online=false) and does not crash", !!offline && !/Application error|crashed/i.test(await text(h.win)));
    const w2 = await mk("Reliability watch 2 (made offline)");
    L.check("[C] a Watch can still be created while offline (local data is the source of truth)", (await h.win.evaluate(() => window.api.listWatches())).length === 2 && !!w2);
    L.check("[C] the signed-in state survives being offline", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    t = Date.now();
    docker("start", "clynx-lan-test-api-1");
    const back = await until(() => curlStatus(`${LAN}/health`) === "200", 90000, 1000);
    R.apiContainerRestartToHealthyMs = back ? back - t : null;
    await h.win.evaluate(() => window.api.cloud.retryNow()).catch(() => {});
    const caught = await until(() => cloudCount(EMAIL, "watches") === 2, 180000, 3000);
    R.offlineWatchCatchUpMs = caught ? caught - t : null;
    L.check("[C] after the server returns the offline Watch syncs, with no duplicate (exactly 2 on the server)", !!caught && cloudCount(EMAIL, "watches") === 2);
    L.check("[C] the app is reported online again", !!(await until(async () => (await h.win.evaluate(() => window.api.cloud.getStatus())).online === true, 90000, 2000)));

    // ------------------------------------------------ D. the database goes away under a running API
    docker("stop", "clynx-lan-test-postgres-1");
    await sleep(3000);
    const timed = (fn) => { const t0 = Date.now(); const v = fn(); return `${v} in ${Date.now() - t0} ms`; };
    const dbDown = { health: timed(() => curlStatus(`${LAN}/health`, "GET", undefined, 45)), ready: timed(() => curlStatus(`${LAN}/health/ready`, "GET", undefined, 45)), login: timed(() => curlStatus(`${LAN}/auth/login`, "POST", { email: EMAIL, password: PW }, 45)) };
    R.databaseDown = dbDown;
    L.check("[D] with the database down the API answers 503 on /health (KNOWN ISSUE F-06: the process crashes instead)", /^503 /.test(dbDown.health) && /^503 /.test(dbDown.ready) && /^5/.test(dbDown.login), dbDown);
    await h.win.evaluate(() => window.api.cloud.retryNow()).catch(() => {});
    L.check("[D] the app stays up and signed in", !/Application error/i.test(await text(h.win)) && (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    t = Date.now();
    docker("start", "clynx-lan-test-postgres-1");
    const dbBack = await until(() => curlStatus(`${LAN}/health`) === "200", 120000, 1000);
    R.apiRecoversAfterDatabaseReturnsMs = dbBack ? dbBack - t : null;
    L.check("[D] the API reconnects to the database BY ITSELF (no restart)", !!dbBack);
    L.check("[D] data survived the database stop (2 Watches, the account)", cloudCount(EMAIL, "watches") === 2 && psql(`select count(*) from users where email='${EMAIL}'`) === "1");

    // ------------------------------------------------ E. Redis goes away (rate limits, queue)
    docker("stop", "clynx-lan-test-redis-1");
    await sleep(3000);
    const t1 = Date.now();
    const redisDown = { ready: curlStatus(`${LAN}/health/ready`), login: curlStatus(`${LAN}/auth/login`, "POST", { email: EMAIL, password: PW }), loginMs: Date.now() - t1 };
    R.redisDown = redisDown;
    L.check("[E] with Redis down sign-in still works and /health/ready reports 'degraded' (KNOWN ISSUE F-07: they HANG instead)", redisDown.login === "200" && redisDown.ready === "503", redisDown);
    docker("start", "clynx-lan-test-redis-1");
    L.check("[E] Redis returns and the API reports ready again without a restart", !!(await until(() => curlStatus(`${LAN}/health/ready`) === "200", 90000, 2000)));

    // ------------------------------------------------ F. the backend is restarted (deploy), the app keeps its session
    docker("restart", "clynx-lan-test-api-1", "clynx-lan-test-worker-1");
    await until(() => curlStatus(`${LAN}/health`) === "200", 90000, 1000);
    await h.win.evaluate(() => window.api.cloud.retryNow()).catch(() => {});
    L.check("[F] after a backend restart the app is still signed in (tokens survive restarts) and online", !!(await until(async () => { const s = await h.win.evaluate(() => window.api.cloud.getStatus()); return s.online === true && s.authenticated === true; }, 90000, 2000)));

    // ------------------------------------------------ G. the desktop app is killed hard (crash / power loss) and reopened
    const devicesBeforeKill = psql(`select count(*) from devices d join users u on u.id=d.user_id where u.email='${EMAIL}'`);
    R.devicesAfterOneLogoutAndLogin = devicesBeforeKill; // a sign-out + sign-in earlier in this test registered a second device (finding F-11)
    const pidBefore = h.pid;
    spawnSync("taskkill", ["/PID", String(pidBefore), "/T", "/F"], { encoding: "utf8" });
    await sleep(3000);
    h = await launch(profile);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    R.restartAfterHardKillMs = Date.now() - h.t0;
    L.check("[G] after a hard kill the app reopens signed in with its local data (2 Watches)", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true && (await h.win.evaluate(() => window.api.listWatches())).length === 2);
    await sleep(15000);
    L.check("[G] and nothing is duplicated on the server after the next sync", cloudCount(EMAIL, "watches") === 2 && psql(`select count(*) from devices d join users u on u.id=d.user_id where u.email='${EMAIL}'`) === devicesBeforeKill);

    // ------------------------------------------------ H. the whole host stack stops and starts (what a restart of the host PC does to the containers)
    t = Date.now();
    docker("stop", "clynx-lan-test-api-1", "clynx-lan-test-worker-1", "clynx-lan-test-redis-1", "clynx-lan-test-postgres-1");
    await sleep(5000);
    L.check("[H] app survives the whole backend being away for 5+ s", !/Application error/i.test(await text(h.win)));
    docker("start", "clynx-lan-test-postgres-1", "clynx-lan-test-redis-1");
    await until(() => psql("select 1") === "1", 60000, 1000);
    docker("start", "clynx-lan-test-api-1", "clynx-lan-test-worker-1");
    const all = await until(() => curlStatus(`${LAN}/health/ready`) === "200", 120000, 1000);
    R.fullStackStartToReadyMs = all ? all - t : null;
    L.check("[H] the stack comes back ready and the data is intact", !!all && cloudCount(EMAIL, "watches") === 2);
    await h.win.evaluate(() => window.api.cloud.retryNow()).catch(() => {});
    L.check("[H] the app reconnects by itself", !!(await until(async () => (await h.win.evaluate(() => window.api.cloud.getStatus())).online === true, 90000, 2000)));
    await quit(h);
    h = null;
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    if (h) console.log("APP OUTPUT (tail):", h.out.join("").slice(-3000));
  } finally {
    try { if (h) await quit(h); } catch { /* ignore */ }
    for (const c of ["postgres", "redis", "api", "worker"]) { try { docker("start", `clynx-lan-test-${c}-1`); } catch { /* already running */ } }
  }
  fs.writeFileSync(path.join(__dirname, "t23_measurements.json"), JSON.stringify(R, null, 2));
  console.log(JSON.stringify(R, null, 2));
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
