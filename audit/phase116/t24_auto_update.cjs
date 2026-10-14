// T24 (updates are automatic): the PACKAGED app (dist\win-unpacked, Beta 4 candidate) signs in to a throw-away test server (compose project clynx-lan-test, http://10.0.0.81:8796) that has a newer
// SIGNED release published, and nobody touches the app. It must: find the update, download and verify it, wait out the start-up grace period, install it by itself (quit + hand the installer over),
// reopen on the same data, and NOT try the same version again when that "installer" did not really update anything.
// The "installer" is a harmless copy of Windows' hostname.exe (it ignores the update switches and exits), so nothing is installed and no administrator prompt can appear.
// The release is signed with the real offline update key, on the throw-away server only; nothing is published on the real server.
const L = require("../phase115_integration/lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const EXE = path.join(L.PROJECT, "dist", "win-unpacked", "Clynx.exe");
const HOST = "10.0.0.81", PORT = 8796, LAN = `http://${HOST}:${PORT}`;
const STATE = "C:\\Users\\biggt\\ClynxLanTest", ENVFILE = path.join(STATE, ".env.lan");
const WIN = path.join(L.PROJECT, "cloud", "deploy", "windows");
const SIGN_KEY = "C:\\Users\\biggt\\ClynxKeys\\update-signing\\update-private.pem";
const NEW_VERSION = process.env.NEW_VERSION || "0.3.0-beta.5";
const env = Object.fromEntries(fs.readFileSync(ENVFILE, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
const psql = (sql) => docker("exec", "clynx-lan-test-postgres-1", "psql", "-U", env.POSTGRES_USER, "-d", env.POSTGRES_DB, "-tAc", sql).trim();
const ps = (script, ...args) => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(WIN, script), ...args], { env: { ...process.env, LAN_BIND: HOST, LAN_PORT: String(PORT), CLYNX_ENV_FILE: ENVFILE, CLYNX_IMAGE: "clynx-lan-test-api:latest", CLYNX_LAN_DIR: STATE, CLYNX_COMPOSE_PROJECT: "clynx-lan-test" }, encoding: "utf8", timeout: 600000 });
const sleep = L.sleep;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t24-"));
const userData = path.join(root, "userdata");
fs.mkdirSync(userData, { recursive: true });
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
// Clynx processes started from THIS build folder with THIS data folder (never the installed app of the user)
const mine = () => {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='Clynx.exe'" | Where-Object { $_.CommandLine -like '*${userData}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -ExpandProperty ProcessId`], { encoding: "utf8" });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
};
const killMine = () => { for (const p of mine()) { try { execFileSync("taskkill", ["/PID", String(p), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } } };
const findState = () => { const walk = (d) => { for (const f of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === "update-state.json") return p; } return null; }; return walk(userData) || walk(path.join(path.dirname(EXE), "data")); };

(async () => {
  const OWNER = `own-${crypto.randomBytes(3).toString("hex")}@beta.test`, USER = `usr-${crypto.randomBytes(3).toString("hex")}@beta.test`, PW = "auto-update-pass-1";
  let app = null;
  const t0 = Date.now();
  try {
    L.check("[0] packaged Beta 4 candidate with the automatic default", fs.existsSync(EXE) && JSON.parse(fs.readFileSync(path.join(L.PROJECT, "resources", "build-info.json"), "utf8")).version === "0.3.0-beta.4");

    // ---- an Owner on the throw-away server, a signed release published there
    const post = async (url, body, headers = {}) => { const r = await fetch(LAN + url, { method: "POST", headers: { "content-type": "application/json", origin: LAN, ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null), setCookie: r.headers.get("set-cookie") }; };
    L.check("[A] owner account created on the test server", (await post("/auth/register", { email: OWNER, password: PW })).status === 201);
    psql(`update users set role='admin' where email='${OWNER}'`);
    const login = await post("/web/login", { email: OWNER, password: PW });
    const cookie = (login.setCookie || "").split(";")[0], csrf = login.json?.csrfToken;
    L.check("[A] the Owner signs in to the console API", login.status === 200 && !!cookie && !!csrf);
    const fake = path.join(root, `Clynx-Beta-Setup-${NEW_VERSION}.exe`);
    fs.copyFileSync("C:\\Windows\\System32\\hostname.exe", fake);
    const reg = ps("Register-ClynxRelease.ps1", "-Installer", fake, "-Version", NEW_VERSION, "-Channel", "beta", "-SigningKey", SIGN_KEY);
    L.check("[A] the release is registered as a signed draft", reg.status === 0 && /DRAFT with a verified signed manifest/.test(reg.stdout), (reg.stdout || "").slice(-300) + (reg.stderr || "").slice(-300));
    const relId = psql(`select id from releases where version='${NEW_VERSION}'`);
    const admin = (url) => post(url, url.endsWith("publish") ? { confirmVersion: NEW_VERSION } : {}, { cookie, "x-csrf-token": csrf });
    L.check("[A] approve + publish (test server only)", (await admin(`/admin/releases/${relId}/approve`)).status === 200 && (await admin(`/admin/releases/${relId}/publish`)).status === 200);

    // ---- a tester installs/opens the app, signs in, and then nobody touches it
    app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: path.dirname(EXE), env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 90000 });
    const launchedAt = Date.now();
    const exited = new Promise((r) => app.process().once("exit", (code) => r({ at: Date.now(), code })));
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
    await clickText(win, /I have a Clynx Cloud account/);
    await win.waitForSelector('[data-testid="server-url-input"]');
    await win.fill('[data-testid="server-url-input"]', `${HOST}:${PORT}`);
    await win.waitForSelector('[data-testid="server-ok"]', { timeout: 30000 });
    await clickText(win, /Need an account/);
    await win.fill('input[type="email"]', USER);
    await win.fill('input[type="password"]', PW);
    await win.click('button[type="submit"]');
    await win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    const info = await win.evaluate(() => window.api.updates.getStatus());
    L.check("[B] a fresh install defaults to the AUTOMATIC mode", info.mode === "automatic", info.mode);
    const signedInAt = Date.now();

    // ---- wait for the app to update itself (first check ~2 min after start, then a 60 s look; allow 7 min)
    const res = await Promise.race([exited, sleep(7 * 60_000).then(() => null)]);
    L.check("[C] with nobody touching it, the app found the update, downloaded and verified it, and CLOSED ITSELF to install it", !!res, "still running after 7 minutes");
    if (res) console.log(`   (closed itself ${Math.round((res.at - launchedAt) / 1000)} s after it was started)`);
    L.check("[C] ...not in the first 90 seconds after start (start-up grace)", !!res && res.at - launchedAt > 90_000, res && res.at - launchedAt);
    const stateFile = findState();
    const st = stateFile ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
    L.check("[C] the update state records the hand-over to the new version", !!st && st.pending?.version === NEW_VERSION && st.pending?.from === "0.3.0-beta.4", st);
    const staged = stateFile ? fs.readdirSync(path.join(path.dirname(stateFile), "staging", NEW_VERSION)).length : 0;
    L.check("[C] the installer it was handed is the one that was downloaded and verified", staged >= 1);

    // ---- it reopens by itself on the same data, and does NOT loop
    let pid = null;
    for (let i = 0; i < 40 && !pid; i++) { await sleep(1500); pid = mine()[0] ?? null; }
    L.check("[D] Clynx reopened by itself (the hand-over starts it again on the same data folder)", !!pid);
    const firstPid = pid;
    console.log(`   waiting 5 more minutes to prove it does not keep restarting...`);
    await sleep(5 * 60_000);
    const later = mine();
    L.check("[D] the reopened app is still the same process 5 minutes later: no update loop for a version whose installer did not finish", later.length >= 1 && later.includes(firstPid), { firstPid, later });
    const st2 = JSON.parse(fs.readFileSync(findState(), "utf8"));
    L.check("[D] the failed hand-over is recorded and that version is not retried", st2.lastFailure?.version === NEW_VERSION && !st2.pending, st2.lastFailure);
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
  } finally {
    killMine();
    try { await app?.close(); } catch { /* gone */ }
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(failed ? 1 : 0);
})();
