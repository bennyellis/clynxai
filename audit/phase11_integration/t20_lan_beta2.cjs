// T20 (Phase 11): the INSTALLED Windows Beta 2 against a REAL Dockerised Clynx Cloud stack reached over the computer's LAN address (not localhost), end to end:
//   server address + Test connection, account registration and device registration, Owner recognition, shared-AI routing, local data persistence, server stop/start (offline and
//   automatic reconnection), a server update while a client is connected, and signed automatic updates (install, health, rollback) with a REAL installer swap.
// It uses a throw-away copy of the stack (compose project "clynx-lan-test", port 8796, its own volumes) and a throw-away --user-data-dir; it never touches the real stack on 8788,
// the developer stack on 8787, or %APPDATA%\Clynx. NO paid API is called: the test server has no OpenAI/eBay credentials, so the shared-AI route answers "not configured".
//
// Environment:  BETA2_EXE (Clynx-Beta-Setup-0.3.0-beta.2.exe)  BETA3_EXE (a test-only 0.3.0-beta.3 build)  SIGN_KEY (update-private.pem)
const L = require("./lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, execSync, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const BETA2 = process.env.BETA2_EXE, BETA3 = process.env.BETA3_EXE, SIGN_KEY = process.env.SIGN_KEY;
if (!BETA2 || !BETA3 || !SIGN_KEY) { console.error("set BETA2_EXE, BETA3_EXE and SIGN_KEY"); process.exit(2); }
const HOST = process.env.LAN_HOST || "10.0.0.81", PORT = 8796, SERVER = `http://${HOST}:${PORT}`;
const STATE = "C:\\Users\\biggt\\ClynxLanTest", ENVFILE = path.join(STATE, ".env.lan");
const COMPOSE = path.join(L.PROJECT, "cloud", "docker-compose.lan.yml");
const composeEnv = { ...process.env, LAN_BIND: HOST, LAN_PORT: String(PORT), CLYNX_ENV_FILE: ENVFILE, CLYNX_IMAGE: "clynx-lan-test-api:latest" };
const dc = (...a) => execFileSync("docker", ["compose", "-p", "clynx-lan-test", "-f", COMPOSE, "--env-file", ENVFILE, ...a], { env: composeEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const envVals = Object.fromEntries(fs.readFileSync(ENVFILE, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const psql = (sql) => dc("exec", "-T", "postgres", "psql", "-U", envVals.POSTGRES_USER, "-d", envVals.POSTGRES_DB, "-tAc", sql).trim();


// An installer that finds a PER-MACHINE ("all users") registration of Clynx elevates itself, which shows a Windows UAC prompt on the screen and waits for a click. A test must never do that:
// stop here instead (uninstall the stale "Clynx (beta)" entry in Settings > Apps first).
{
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match 'Clynx' } | ForEach-Object { $_.DisplayName }"], { encoding: "utf8" });
  if (r.stdout.trim()) { console.error("REFUSING TO RUN: a per-machine Clynx install is registered (" + r.stdout.trim() + "). Its installer would pop up a UAC prompt. Uninstall it in Settings > Apps first."); process.exit(3); }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t20-"));
const installDir = path.join(root, "install");
const userData = path.join(root, "userdata");
fs.mkdirSync(userData, { recursive: true });
const EXE = path.join(installDir, "Clynx.exe");
const EMAIL = `owner-${crypto.randomBytes(3).toString("hex")}@lan.test`, PW = "lan-test-pass-1234";
const text = (win) => win.evaluate(() => document.body.innerText);
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const until = async (fn, ms, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await L.sleep(every); } return null; };
// The program file's version is only numeric (0.3.0.0), so "which build is installed" is read from the packaged app itself: the hash of resourcespp.asar.
const asarHash = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(installDir, "resources", "app.asar"))).digest("hex").slice(0, 16);
const running = () => spawnSync("powershell", ["-NoProfile", "-Command", `Get-Process Clynx -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${installDir}*' } | Select-Object -ExpandProperty Id`], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean);
const killInstalled = () => { for (const p of running()) { try { execSync(`taskkill /pid ${p} /T /F`, { stdio: "ignore" }); } catch { /* gone */ } } };
function install(exe) { const r = spawnSync(exe, ["/S", "/currentuser", `/D=${installDir}`], { timeout: 600000 }); return r.status; }

async function launch() {
  const out = [];
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: installDir, env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 90000 });
  app.process().stdout?.on("data", (d) => out.push(String(d)));
  app.process().stderr?.on("data", (d) => out.push(String(d)));
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  return { app, win, out, errors };
}
async function quit(h) {
  const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  await Promise.race([exited, L.sleep(25000)]);
  killInstalled();
}
const gotoAccount = async (h) => { await clickText(h.win, /^Config$/); await L.sleep(500); await clickText(h.win, /^account$/); await h.win.waitForSelector('[data-testid="about-block"]', { timeout: 20000 }); };
const notices = (h) => h.win.evaluate(() => window.api.listNotices()).then((l) => l.map((n) => n.id));

// ---- admin helpers (website API as the Owner) ----
let cookie = "", csrf = "";
const web = async (method, url, body, extra = {}) => {
  const r = await fetch(SERVER + url, { method, headers: { origin: SERVER, cookie, "x-csrf-token": csrf, ...(body !== undefined && !extra.raw ? { "content-type": "application/json" } : {}), ...(extra.headers || {}) }, body: extra.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j, headers: r.headers };
};
async function webLogin() { const r = await web("POST", "/web/login", { email: EMAIL, password: PW }); cookie = (r.headers.get("set-cookie") || "").split(";")[0]; csrf = r.body.csrfToken; return r.status; }
function signManifest(manifestObj, keyPath) {
  const inFile = path.join(root, "m.json"), outFile = path.join(root, "m.signed.json");
  fs.writeFileSync(inFile, JSON.stringify(manifestObj));
  execFileSync("node", [path.join(L.PROJECT, "scripts", "update-keys.cjs"), "sign", keyPath, inFile, outFile]);
  return JSON.parse(fs.readFileSync(outFile, "utf8"));
}
async function publishRelease(version, exePath, signKey, notes) {
  const created = await web("POST", "/admin/releases", { version, channel: "beta", notes, knownIssues: "" });
  const id = created.body.id;
  const up = await web("PUT", `/admin/releases/${id}/file?name=${encodeURIComponent(path.basename(exePath))}`, undefined, { raw: fs.readFileSync(exePath), headers: { "content-type": "application/octet-stream" } });
  const tpl = (await web("GET", `/admin/releases/${id}/update-manifest-template`)).body.manifest;
  const signed = signManifest(tpl, signKey);
  const att = await web("PUT", `/admin/releases/${id}/update-manifest`, signed);
  const ap = await web("POST", `/admin/releases/${id}/approve`, {});
  const pub = await web("POST", `/admin/releases/${id}/publish`, { confirmVersion: version });
  return { id, up: up.status, att: att.status, attBody: att.body, ap: ap.status, pub: pub.status };
}

(async () => {
  let h = null;
  try {
    // the test server allows only one Owner: remove one left by an earlier run of this test
    try {
      const st = dc("exec", "-T", "api", "node", "dist/scripts/owner.js", "status");
      const prev = /([\w.+-]+@[\w.-]+)/.exec(st);
      if (prev) dc("exec", "-T", "api", "node", "dist/scripts/owner.js", "revoke", prev[1], "--yes");
    } catch { /* none */ }
    // ================================================================ 0. install the real Beta 2 installer
    const code = install(BETA2);
    L.check("[0] the real Beta 2 installer installs silently", code === 0 && fs.existsSync(EXE), code);
    const B2_ASAR = asarHash();
    L.check("[0] the install folder holds only the program (no .env / database / source)", !fs.existsSync(path.join(installDir, ".env")) && !fs.existsSync(path.join(installDir, "data")) && !fs.existsSync(path.join(installDir, "src")));

    // ================================================================ A. connect to a server by address, testing first
    h = await launch();
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
    await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('input[type="password"]', { timeout: 15000 });
    const urlInput = h.win.locator('[data-testid="server-url-input"]');
    L.check("[A] a fresh installed app starts with NO server address (no localhost assumption)", (await urlInput.count()) === 1 && (await urlInput.inputValue()) === "" && !/localhost|127\.0\.0\.1/.test(await text(h.win)), await urlInput.inputValue());
    await h.win.click('[data-testid="server-test"]');
    await L.sleep(500);
    L.check("[A] Test connection with nothing entered asks for an address", /Enter the address/i.test(await text(h.win)));
    await urlInput.fill("http://203.0.113.9:8796");
    await h.win.click('[data-testid="server-test"]');
    await h.win.waitForSelector('[data-testid="server-fail"]', { timeout: 10000 });
    L.check("[A] an unencrypted internet address is refused with an explanation", /must start with https/i.test(await h.win.textContent('[data-testid="server-fail"]')));
    await urlInput.fill(`${HOST}:1`);
    await h.win.click('[data-testid="server-test"]');
    await h.win.waitForSelector('[data-testid="server-fail"]', { timeout: 20000 });
    L.check("[A] a closed port gives a plain-language reason, not a stack trace", /(refused|did not answer|reach)/i.test(await h.win.textContent('[data-testid="server-fail"]')), await h.win.textContent('[data-testid="server-fail"]'));
    await urlInput.fill(`${HOST}:${PORT}`);
    await h.win.click('[data-testid="server-test"]');
    await h.win.waitForSelector('[data-testid="server-ok"]', { timeout: 20000 });
    const okText = await h.win.textContent('[data-testid="server-ok"]');
    L.check("[A] the real LAN server is recognised: its name and version are shown", /Clynx TEST server/.test(okText) && /version 0\.1\.0/.test(okText), okText);
    L.check("[A] it reports no shared AI yet (the Owner has not entered a key)", !/Shared AI is available/.test(okText));

    // ================================================================ B. register, device registration
    await clickText(h.win, /Need an account/);
    await h.win.fill('input[type="email"]', EMAIL);
    await h.win.fill('input[type="password"]', PW);
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    const sess = await h.win.evaluate(() => window.api.auth.getSession());
    L.check("[B] registration over the LAN works and the app is signed in to the LAN address", sess.authenticated && sess.apiUrl === SERVER, sess);
    L.check("[B] the account exists on the Docker server's database", psql(`select count(*) from users where email='${EMAIL}'`) === "1");
    const devSql = `select count(*) from devices d join users u on u.id = d.user_id where u.email = '${EMAIL}'`;
    const dev = await until(() => psql(devSql) === "1", 30000, 2000);
    L.check("[B] the computer registered itself as a device", !!dev, psql(devSql));
    L.check("[B] the cloud session on disk holds no password", !/password/i.test(fs.readFileSync(path.join(userData, "cloud-session.json"), "utf8")));
    const userFolder = path.join(userData, "data", "users", sess.userId);
    L.check("[B] the account's Database is in the user-data folder, not the install folder", fs.existsSync(path.join(userFolder, "scout.db")) && !fs.existsSync(path.join(installDir, "data")));
    await gotoAccount(h);
    await h.win.waitForSelector('[data-testid="account-section"]', { timeout: 30000 });
    const t0 = await text(h.win);
    L.check("[B] Config > Account shows the server address and 'Connected'", /Connected/.test(t0) && t0.includes(SERVER));
    L.check("[B] an ordinary customer is on the Free plan (not Owner)", /Free/.test(t0) && !/Owner — Full Access/.test(t0));
    await quit(h);

    // ================================================================ C. make this account the Owner on the SERVER; the app recognises it
    const begin = dc("exec", "-T", "api", "node", "dist/scripts/owner.js", "begin", EMAIL);
    const codeM = /\n\s+([A-Za-z0-9_-]{8,})\n/.exec(begin);
    const done = codeM ? dc("exec", "-T", "api", "node", "dist/scripts/owner.js", "complete", EMAIL, codeM[1]) : "";
    L.check("[C] the server-side Owner procedure works from the host", !!codeM && /owner/i.test(done), done.slice(0, 120));
    h = await launch();
    // granting Owner signs the account out everywhere: the app is told its sign-in ended
    await h.win.waitForFunction(() => !!document.querySelector('input[type="password"], [data-testid="beta-welcome"]') || /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    const signedOut = (await h.win.locator('input[type="password"]').count()) > 0 || (await h.win.locator('[data-testid="beta-welcome"]').count()) > 0;
    L.check("[C] granting Owner ended the old sign-in (as designed), so the app asks to sign in again", signedOut);
    if ((await h.win.locator('[data-testid="beta-welcome"]').count()) > 0) await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('input[type="password"]', { timeout: 15000 });
    L.check("[C] the sign-in form remembers the server address", (await h.win.locator('[data-testid="server-url-input"]').count()) === 0 || (await h.win.locator('[data-testid="server-url-input"]').inputValue()).includes(`${HOST}:${PORT}`));
    await h.win.fill('input[type="email"]', EMAIL);
    await h.win.fill('input[type="password"]', PW);
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    await gotoAccount(h);
    await h.win.waitForSelector('[data-testid="account-section"]', { timeout: 20000 });
    const t1 = await text(h.win);
    L.check("[C] the desktop shows 'Owner — Full Access' (no subscription, no upgrade buttons)", /Owner — Full Access/.test(t1) && (await h.win.locator('[data-testid="account-upgrade-monthly"]').count()) === 0 && (await h.win.locator('[data-testid="account-owner"]').count()) === 1);

    // ================================================================ D. shared-AI routing (no paid call: the server has no key)
    const chat = await h.win.evaluate(() => new Promise((resolve) => {
      const id = "t20-" + Math.random();
      const off1 = window.api.onChatError((rid, msg) => { if (rid === id) resolve({ kind: "error", msg }); });
      const off2 = window.api.onChatDone((rid, full) => { if (rid === id) resolve({ kind: "done", msg: full }); });
      window.api.startChat(id, "hello", [], {});
      setTimeout(() => resolve({ kind: "timeout", msg: "" }), 45000);
      void off1; void off2;
    }));
    const aiCalls = dc("logs", "--no-log-prefix", "api").split("\n").filter((l) => /"url":"\/ai\//.test(l));
    L.check("[D] the AI request went to the Clynx server's /ai route, not to OpenAI", aiCalls.length > 0, aiCalls.slice(0, 2));
    L.check("[D] with no company key configured the app shows a plain 'temporarily unavailable', not a crash or a key prompt", chat.kind === "error" && /unavailable|not available|paused/i.test(chat.msg) && !/sk-|api key/i.test(chat.msg), chat);
    L.check("[D] no 'add your OpenAI key' notice is shown to a cloud customer", !(await notices(h)).includes("no-ai-key"));

    // ================================================================ E. local data persistence across restarts
    const sessId = (await h.win.evaluate(() => window.api.auth.getSession())).userId;
    const dbFile = path.join(userData, "data", "users", sessId, "scout.db");
    await quit(h);
    h = null;
    {
      const d = new DatabaseSync(dbFile);
      const need = d.prepare("PRAGMA table_info(products)").all().filter((c) => c.notnull && c.dflt_value == null && !c.pk);
      d.prepare(`INSERT INTO products (${["id", ...need.map((c) => c.name)].join(",")}) VALUES (${["id", ...need].map(() => "?").join(",")})`).run("lan-product-1", ...need.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : "lan persistence check")));
      d.close();
    }
    h = await launch();
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[E] after a restart the app signs back in by itself (no login screen)", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    L.check("[E] the local Database row is still there", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "lan-product-1"));

    // ================================================================ F. the server goes away and comes back
    const tStop = Date.now();
    dc("stop", "api", "worker");
    const sawOffline = await until(async () => (await notices(h)).includes("cloud-offline"), 120000, 2000);
    L.check(`[F] with the server stopped the app says 'working offline' (after ${Math.round((Date.now() - tStop) / 1000)} s)`, !!sawOffline);
    L.check("[F] ...and keeps working with its own data", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "lan-product-1") && /Start Scanner/i.test(await text(h.win)));
    await gotoAccount(h);
    await h.win.waitForSelector('[data-testid="server-status"]', { timeout: 30000 });
    L.check("[F] Config > Account shows 'Not connected' with a Retry button", /Not connected/.test(await text(h.win)) && (await h.win.locator('[data-testid="server-retry"]').count()) === 1);
    const tStart = Date.now();
    dc("start", "api", "worker");
    const back = await until(async () => !(await notices(h)).includes("cloud-offline"), 120000, 2000);
    L.check(`[F] when the server returns the app reconnects BY ITSELF (${Math.round((Date.now() - tStart) / 1000)} s)`, !!back);
    await L.sleep(3000);
    await gotoAccount(h);
    await h.win.waitForSelector('[data-testid="account-section"]', { timeout: 30000 });
    L.check("[F] ...and the account page shows Connected and Owner again", /Connected/.test(await text(h.win)) && /Owner — Full Access/.test(await text(h.win)));
    L.check("[F] the account is still signed in (the outage did not log it out)", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);

    // ================================================================ G. the server is updated while the client is connected
    const usersBefore = psql("select count(*) from users");
    const upd = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(L.PROJECT, "cloud", "deploy", "windows", "Update-ClynxLan.ps1")], { env: { ...composeEnv, CLYNX_LAN_DIR: STATE, CLYNX_COMPOSE_PROJECT: "clynx-lan-test" }, encoding: "utf8", timeout: 600000 });
    L.check("[G] the server update script (backup, rebuild, restart, health check) succeeds", upd.status === 0 && /Updated\. Server version/.test(upd.stdout), (upd.stdout || "").slice(-300) + (upd.stderr || "").slice(-200));
    L.check("[G] it took a backup first", fs.readdirSync(path.join(STATE, "backups")).some((f) => /pre-update.*\.sql\.gz$/.test(f)));
    L.check("[G] all accounts survived the update", psql("select count(*) from users") === usersBefore);
    const backAgain = await until(async () => (await h.win.evaluate(() => window.api.cloud.getStatus())).online === true, 90000, 2000);
    L.check("[G] the connected desktop reconnected by itself after the server restarted", !!backAgain);

    // ================================================================ H. signed automatic updates, for real
    L.check("[H] the Owner can use the website API from the desktop's computer (admin login)", (await webLogin()) === 200);
    // an update signed with the WRONG key is refused by the server itself
    const wrongKey = path.join(root, "wrong-private.pem");
    fs.writeFileSync(wrongKey, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    {
      const cr = await web("POST", "/admin/releases", { version: "9.9.9-beta.1", channel: "beta", notes: "wrong key", knownIssues: "" });
      await web("PUT", `/admin/releases/${cr.body.id}/file?name=x.exe`, undefined, { raw: Buffer.from("MZ not a real installer".repeat(100)), headers: { "content-type": "application/octet-stream" } });
      const tpl = (await web("GET", `/admin/releases/${cr.body.id}/update-manifest-template`)).body.manifest;
      const bad = await web("PUT", `/admin/releases/${cr.body.id}/update-manifest`, signManifest(tpl, wrongKey));
      L.check("[H] the server refuses a manifest signed with a key that is not the update key", bad.status === 422, bad);
      await web("DELETE", `/admin/releases/${cr.body.id}`);
    }
    const r2 = await publishRelease("0.3.0-beta.2", BETA2, SIGN_KEY, "Windows Beta 2 (published to the TEST server only)");
    L.check("[H] Beta 2 is uploaded, its manifest signed offline with the real update key and accepted, and published (test server)", r2.up === 200 && r2.att === 200 && r2.ap === 200 && r2.pub === 200, r2);
    let info = await h.win.evaluate(() => window.api.updates.check());
    L.check("[H] the installed Beta 2 sees it is up to date", info.status.state === "up-to-date", info.status);
    L.check("[H] this build has the update key (updates enabled)", info.enabled === true);
    const r3 = await publishRelease("0.3.0-beta.3", BETA3, SIGN_KEY, "Test-only build for the update chain");
    L.check("[H] a newer build (0.3.0-beta.3, test-only) is published with its signed manifest", r3.up === 200 && r3.att === 200 && r3.pub === 200, r3);
    info = await h.win.evaluate(() => window.api.updates.check());
    L.check("[H] the installed app finds it; in the default mode it downloads and verifies it in the background", info.status.state === "ready" && info.status.version === "0.3.0-beta.3", info.status);
    L.check("[H] nothing was installed yet (it waits for the person)", asarHash() === B2_ASAR && running().length > 0);
    const notice = (await h.win.evaluate(() => window.api.listNotices())).find((n) => n.id === "update");
    L.check("[H] a notice offers 'Restart and install'", notice && notice.action === "install-update", notice);
    const backupsBefore = fs.existsSync(path.join(userData, "data", "users", sessId, "backups")) ? fs.readdirSync(path.join(userData, "data", "users", sessId, "backups")).length : 0;
    const staged = path.join(userData, "updates", "staging", "0.3.0-beta.3");
    L.check("[H] the downloaded installer is byte-identical to the published one", fs.readdirSync(staged).length === 1 && crypto.createHash("sha256").update(fs.readFileSync(path.join(staged, fs.readdirSync(staged)[0]))).digest("hex") === crypto.createHash("sha256").update(fs.readFileSync(BETA3)).digest("hex"));
    const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
    const inst = await h.win.evaluate(() => window.api.updates.install());
    L.check("[H] clicking 'Restart and install' starts the installer", inst.ok === true, inst);
    L.check("[H] the app closes itself so the installer can replace it", !!(await Promise.race([exited, L.sleep(60000).then(() => false)])));
    const upgraded = await until(() => asarHash() !== B2_ASAR, 180000, 2000);
    L.check("[H] the installer replaced the program in place (the packaged app changed)", !!upgraded, asarHash());
    await L.sleep(8000);
    const relaunched = running().length > 0;
    L.check("[H] the installer reopens Clynx by itself, on the same data folder", relaunched, running());
    L.check("[H] the user's data folder is untouched by the install (database file still there)", fs.existsSync(dbFile));
    killInstalled();
    await L.sleep(1500);
    h = await launch();
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    const ver = await h.app.evaluate(({ app: a }) => a.getVersion());
    L.check("[H] the new version starts, signs in by itself and reports 0.3.0-beta.3", ver === "0.3.0-beta.3" && (await h.win.evaluate(() => window.api.auth.getSession())).authenticated, ver);
    L.check("[H] the Database row from before the update is still there", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "lan-product-1"));
    let st = JSON.parse(fs.readFileSync(path.join(userData, "updates", "update-state.json"), "utf8"));
    L.check("[H] the update is being watched until it proves healthy", st.pending?.version === "0.3.0-beta.3" && st.pending.from === "0.3.0-beta.2", st.pending);
    L.note("[H] waiting for the new version to prove healthy", "about 2 minutes");
    const healthy = await until(() => { st = JSON.parse(fs.readFileSync(path.join(userData, "updates", "update-state.json"), "utf8")); return st.pending === null && st.lastGoodVersion === "0.3.0-beta.3"; }, 170000, 5000);
    L.check("[H] after two minutes of running well it is marked healthy", !!healthy, st);
    L.check("[H] the way back to Beta 2 is known", (await h.win.evaluate(() => window.api.updates.getStatus())).canRollback === true && st.previousVersion === "0.3.0-beta.2", st);

    // ================================================================ I. rollback (user-approved), to the signed earlier version from the server
    const exited2 = new Promise((r) => h.app.process().once("exit", () => r(true)));
    const rb = await h.win.evaluate(() => window.api.updates.rollback());
    L.check("[I] 'Go back to 0.3.0-beta.2' downloads the signed earlier build, verifies it and starts the installer", rb.ok === true, rb);
    await Promise.race([exited2, L.sleep(60000)]);
    const reverted = await until(() => asarHash() === B2_ASAR, 180000, 2000);
    L.check("[I] the program is byte-for-byte the Beta 2 build again", !!reverted, asarHash());
    await L.sleep(8000);
    killInstalled();
    await L.sleep(1500);
    h = await launch();
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[I] after the rollback the app starts, is signed in, and the data is intact", (await h.app.evaluate(({ app: a }) => a.getVersion())) === "0.3.0-beta.2" && (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "lan-product-1"));
    st = JSON.parse(fs.readFileSync(path.join(userData, "updates", "update-state.json"), "utf8"));
    L.check("[I] the version that was rolled back from is remembered as bad and will not be offered again", st.badVersions.includes("0.3.0-beta.3"), st.badVersions);
    info = await h.win.evaluate(() => window.api.updates.check());
    L.check("[I] a check now says up to date (0.3.0-beta.3 is not re-offered)", info.status.state === "up-to-date", info.status);
    L.check("[*] no renderer errors during the whole run", h.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, h.errors.slice(0, 3));
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    if (h) console.log("MAIN OUTPUT (tail):", h.out.join("").slice(-2500));
  } finally {
    try { if (h) await quit(h); } catch { /* ignore */ }
    killInstalled();
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  console.log("temp folder (install + user data):", root);
  process.exit(failed ? 1 : 0);
})();
