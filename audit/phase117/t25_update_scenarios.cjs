// T25 (Phase 11.7): the packaged app against a throw-away test server (compose project clynx-lan-test, http://10.0.0.81:8796). Run one scenario at a time:
//   SCENARIO=A  a REQUIRED update with the person's setting on "off" AND the first download cut off half way: it must resume, verify and install by itself
//   SCENARIO=B  an update is downloaded, then the Owner WITHDRAWS it: the app must not install it
//   SCENARIO=C  the real BETA 3 build (unpacked from its installer): it downloads by itself but waits for one click; a "required" mark does not move it (documents what Beta 3 cannot do)
// The "installer" is a harmless copy of hostname.exe; the release is signed with the real offline update key on the throw-away server only. Nothing touches the real server.
const L = require("../phase115_integration/lib.cjs");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const SCENARIO = process.env.SCENARIO || "A";
const EXE = SCENARIO === "C" ? process.env.BETA3_EXE : path.join(L.PROJECT, "dist", "win-unpacked", "Clynx.exe");
const HOST = "10.0.0.81", PORT = 8796, PROXY_PORT = 8797, LAN = `http://${HOST}:${PORT}`;
const STATE = "C:\\Users\\biggt\\ClynxLanTest", ENVFILE = path.join(STATE, ".env.lan");
const WIN = path.join(L.PROJECT, "cloud", "deploy", "windows");
const SIGN_KEY = "C:\\Users\\biggt\\ClynxKeys\\update-signing\\update-private.pem";
const NEW_VERSION = process.env.NEW_VERSION;
if (!NEW_VERSION) throw new Error("set NEW_VERSION (a version nobody used before on the test server)");
const env = Object.fromEntries(fs.readFileSync(ENVFILE, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
const psql = (sql) => docker("exec", "clynx-lan-test-postgres-1", "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-tAc", sql).trim();
const ps = (script, ...args) => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(WIN, script), ...args], { env: { ...process.env, LAN_BIND: HOST, LAN_PORT: String(PORT), CLYNX_ENV_FILE: ENVFILE, CLYNX_IMAGE: "clynx-lan-test-api:latest", CLYNX_LAN_DIR: STATE, CLYNX_COMPOSE_PROJECT: "clynx-lan-test" }, encoding: "utf8", timeout: 600000 });
const sleep = L.sleep;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t25-"));
const userData = path.join(root, "userdata");
fs.mkdirSync(userData, { recursive: true });
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const mine = () => spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='Clynx.exe'" | Where-Object { $_.CommandLine -like '*${userData}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -ExpandProperty ProcessId`], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean).map(Number);
const killMine = () => { for (const p of mine()) { try { execFileSync("taskkill", ["/PID", String(p), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } } };
const findState = () => { const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === "update-state.json") return p; } return null; }; return walk(userData); };
const status = (win) => win.evaluate(() => window.api.updates.getStatus());

// a forwarding proxy in front of the test server that cuts the FIRST full installer download after 10 000 bytes (scenario A)
function startProxy() {
  const log = { cuts: 0, ranges: [], downloads: [] };
  const server = http.createServer((req, res) => {
    const up = http.request({ host: HOST, port: PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `${HOST}:${PORT}` } }, (ur) => {
      const isDownload = /^\/releases\/[0-9a-f-]+\/download/.test(req.url);
      if (isDownload) log.downloads.push({ range: req.headers.range ?? null, status: ur.statusCode });
      if (isDownload && !req.headers.range && log.cuts === 0 && ur.statusCode === 200) {
        log.cuts++;
        res.writeHead(200, ur.headers);
        let sent = 0;
        ur.on("data", (d) => { if (sent >= 10_000) return; const part = d.subarray(0, 10_000 - sent); sent += part.length; res.write(part); if (sent >= 10_000) { res.socket.destroy(); ur.destroy(); } });
        return;
      }
      if (req.headers.range) log.ranges.push(req.headers.range);
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, HOST, () => resolve({ server, log })));
}

(async () => {
  const OWNER = `own-${crypto.randomBytes(3).toString("hex")}@beta.test`, USER = `usr-${crypto.randomBytes(3).toString("hex")}@beta.test`, PW = "scenario-pass-1";
  let app = null, proxy = null;
  const t0 = Date.now();
  try {
    L.check(`[0] scenario ${SCENARIO}: the app under test exists`, fs.existsSync(EXE), EXE);
    const post = async (url, body, headers = {}) => { const r = await fetch(LAN + url, { method: "POST", headers: { "content-type": "application/json", origin: LAN, ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null), setCookie: r.headers.get("set-cookie") }; };
    await post("/auth/register", { email: OWNER, password: PW });
    psql(`update users set role='admin' where email='${OWNER}'`);
    // the Owner role cannot be set by SQL (a database guard); releases are Owner-only now, so open the guard for these statements on the THROW-AWAY database
    psql(`select set_config('clynx.owner_change','on',false)`);
    execFileSync("docker", ["exec", "clynx-lan-test-postgres-1", "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-c", `select set_config('clynx.owner_change','on',false); update users set role='user' where role='owner'; update users set role='owner' where email='${OWNER}'`], { stdio: "ignore" });
    L.check("[A0] the Owner exists on the test server", psql(`select role from users where email='${OWNER}'`) === "owner");
    const login = await post("/web/login", { email: OWNER, password: PW });
    const cookie = (login.setCookie || "").split(";")[0], csrf = login.json?.csrfToken;
    const adminCall = (url, body = {}) => post(url, body, { cookie, "x-csrf-token": csrf });
    const fake = path.join(root, `Clynx-Beta-Setup-${NEW_VERSION}.exe`);
    fs.copyFileSync("C:\\Windows\\System32\\hostname.exe", fake);
    const reg = ps("Register-ClynxRelease.ps1", "-Installer", fake, "-Version", NEW_VERSION, "-Channel", "beta", "-SigningKey", SIGN_KEY);
    L.check("[A0] the release is registered as a signed draft", reg.status === 0, (reg.stdout || "").slice(-300) + (reg.stderr || "").slice(-300));
    const relId = psql(`select id from releases where version='${NEW_VERSION}'`);
    L.check("[A0] approve + publish (test server only)", (await adminCall(`/admin/releases/${relId}/approve`)).status === 200 && (await adminCall(`/admin/releases/${relId}/publish`, { confirmVersion: NEW_VERSION })).status === 200);
    psql(`update releases set status='withdrawn', required_at=NULL, required_deadline=NULL where status='published' and id <> '${relId}'`); // earlier test releases on this throw-away server must not be offered
    if (SCENARIO === "A" || SCENARIO === "C") {
      const r = await adminCall(`/admin/releases/${relId}/require`, { hours: 1 });
      L.check("[A0] the Owner marks it REQUIRED (1 hour)", r.status === 200);
      psql(`update releases set required_at = now() - interval '5 hours', required_deadline = now() - interval '4 hours' where id='${relId}'`); // the deadline has already passed
    }

    let serverForApp = `${HOST}:${PORT}`;
    if (SCENARIO === "A") {
      proxy = await startProxy();
      serverForApp = `${HOST}:${PROXY_PORT}`;
      fs.writeFileSync(path.join(userData, "app-settings.json"), JSON.stringify({ updateMode: "off" })); // the person chose "do not announce updates"
    }

    app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: path.dirname(EXE), env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 90000 });
    const launchedAt = Date.now();
    const exited = new Promise((r) => app.process().once("exit", (code) => r({ at: Date.now(), code })));
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
    await clickText(win, /I have a Clynx Cloud account/);
    await win.waitForSelector('[data-testid="server-url-input"]');
    await win.fill('[data-testid="server-url-input"]', serverForApp);
    await win.waitForSelector('[data-testid="server-ok"]', { timeout: 30000 });
    await clickText(win, /Need an account/);
    await win.fill('input[type="email"]', USER);
    await win.fill('input[type="password"]', PW);
    await win.click('button[type="submit"]');
    await win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    const info0 = await status(win);
    console.log(`   app version ${info0.currentVersion}, update mode ${info0.mode}`);

    if (SCENARIO === "A") {
      L.check("[A] the person's setting is 'off'", info0.mode === "off", info0.mode);
      const res = await Promise.race([exited, sleep(14 * 60_000).then(() => null)]);
      L.check("[A] a REQUIRED update with the setting on 'off', and the first download cut off half way: the app resumed, verified, and CLOSED ITSELF to install it", !!res, "still running after 14 minutes");
      if (res) console.log(`   (closed itself ${Math.round((res.at - launchedAt) / 1000)} s after it was started)`);
      L.check("[A] the proxy really cut one download", proxy.log.cuts === 1, proxy.log);
      L.check("[A] the second try asked only for the REST of the file (Range) and got a 206", proxy.log.ranges.length >= 1 && /^bytes=10000-$/.test(proxy.log.ranges[0]) && proxy.log.downloads.some((d) => d.status === 206), proxy.log);
      const st = findState() ? JSON.parse(fs.readFileSync(findState(), "utf8")) : null;
      L.check("[A] the state records the hand-over to the new version and the required mark", !!st && st.pending?.version === NEW_VERSION && st.required?.version === NEW_VERSION, st);
      let pid = null;
      for (let i = 0; i < 40 && !pid; i++) { await sleep(1500); pid = mine()[0] ?? null; }
      L.check("[A] Clynx reopened by itself on the same data", !!pid);
    }

    if (SCENARIO === "B") {
      const ready = await (async () => { for (let i = 0; i < 100; i++) { const s = await status(win); if (s.status.state === "ready") return s; await sleep(3000); } return null; })();
      L.check("[B] the app downloaded and verified the update by itself (status: ready)", !!ready, (await status(win)).status);
      const wd = await adminCall(`/admin/releases/${relId}/withdraw`);
      L.check("[B] the Owner withdraws the release on the server", wd.status === 200);
      const t1 = Date.now();
      const res = await Promise.race([exited, sleep(5 * 60_000).then(() => null)]);
      L.check("[B] five minutes later the app has NOT installed the withdrawn update (it is still running)", res === null, res);
      const s2 = await status(win).catch(() => null);
      L.check("[B] ...and it no longer says an update is ready", !!s2 && s2.status.state !== "ready" && s2.status.state !== "installing", s2 && s2.status);
      const st = findState() ? JSON.parse(fs.readFileSync(findState(), "utf8")) : null;
      L.check("[B] no install was handed over", !st || !st.pending, st && st.pending);
      console.log(`   (waited ${Math.round((Date.now() - t1) / 1000)} s after the withdrawal)`);
    }

    if (SCENARIO === "C") {
      L.check("[C] this really is Beta 3", info0.currentVersion === "0.3.0-beta.3", info0.currentVersion);
      const ready = await (async () => { for (let i = 0; i < 100; i++) { const s = await status(win); if (s.status.state === "ready") return s; await sleep(3000); } return null; })();
      L.check("[C] Beta 3 downloads and verifies the new release by itself", !!ready, (await status(win)).status);
      const res = await Promise.race([exited, sleep(4 * 60_000).then(() => null)]);
      L.check("[C] ...but it does NOT install it by itself, even though the Owner marked it required (Beta 3 has no such logic): it waits for one click", res === null, res);
      const click = await win.evaluate(() => window.api.updates.install());
      L.check("[C] one click on 'Restart and install' (the same call the button makes) hands it over", click.ok === true, click);
      const res2 = await Promise.race([exited, sleep(60_000).then(() => null)]);
      L.check("[C] Beta 3 closes to install it", !!res2);
      let pid = null;
      for (let i = 0; i < 40 && !pid; i++) { await sleep(1500); pid = mine()[0] ?? null; }
      L.check("[C] and reopens by itself", !!pid);
    }
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
  } finally {
    killMine();
    try { await app?.close(); } catch { /* gone */ }
    try { proxy?.server.close(); } catch { /* gone */ }
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(failed ? 1 : 0);
})();
