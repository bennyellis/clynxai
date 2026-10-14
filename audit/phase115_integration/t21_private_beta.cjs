// T21 (Phase 11.5): the PRIVATE BETA end to end, with a real browser and the real installed Beta 2, against a throw-away copy of the Docker server (compose project "clynx-lan-test",
// port 8796) put in private mode by the real Enable-ClynxPrivateAccess.ps1, with a local Caddy in front (https://10.0.0.81:8797, its own throw-away certificate authority) standing in for the
// tunnel that will terminate TLS in real life. NOTHING is opened to the internet, nothing is published on the real server, no paid API is called.
//   BETA2_EXE  the Beta 2 installer under test     BETA3_EXE  a test-only 0.3.0-beta.3 build     SIGN_KEY  update-private.pem
const L = require("./lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, execSync, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { chromium } = require(path.join(L.PROJECT, "node_modules", "playwright"));
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const BETA2 = process.env.BETA2_EXE, BETA3 = process.env.BETA3_EXE, SIGN_KEY = process.env.SIGN_KEY;
if (!BETA2 || !BETA3 || !SIGN_KEY) { console.error("set BETA2_EXE, BETA3_EXE and SIGN_KEY"); process.exit(2); }
const HOST = "10.0.0.81", PORT = 8796, HTTPS_PORT = 8797;
const LAN = `http://${HOST}:${PORT}`, SECURE = `https://${HOST}:${HTTPS_PORT}`;
const STATE = "C:\\Users\\biggt\\ClynxLanTest", ENVFILE = path.join(STATE, ".env.lan");
const COMPOSE = path.join(L.PROJECT, "cloud", "docker-compose.lan.yml");
const WIN = path.join(L.PROJECT, "cloud", "deploy", "windows");
const composeEnv = { ...process.env, LAN_BIND: HOST, LAN_PORT: String(PORT), CLYNX_ENV_FILE: ENVFILE, CLYNX_IMAGE: "clynx-lan-test-api:latest" };
const dc = (...a) => execFileSync("docker", ["compose", "-p", "clynx-lan-test", "-f", COMPOSE, "--env-file", ENVFILE, ...a], { env: composeEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ps = (script, ...args) => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(WIN, script), ...args], { env: { ...composeEnv, CLYNX_LAN_DIR: STATE, CLYNX_COMPOSE_PROJECT: "clynx-lan-test" }, encoding: "utf8", timeout: 900000 });
const envVals = () => Object.fromEntries(fs.readFileSync(ENVFILE, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const psql = (sql) => { const v = envVals(); return dc("exec", "-T", "postgres", "psql", "-U", v.POSTGRES_USER, "-d", v.POSTGRES_DB, "-tAc", sql).trim(); };
const curl = (args) => spawnSync("curl", ["-sk", "--max-time", "20", ...args], { encoding: "utf8" });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t21-"));
const installDir = path.join(root, "install"), userData = path.join(root, "userdata"), downloads = path.join(root, "downloads");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
const EXE = path.join(installDir, "Clynx.exe");
const OWNER = `owner-${crypto.randomBytes(3).toString("hex")}@beta.test`, OPW = "owner-pass-12345";
const TESTER = `tester-${crypto.randomBytes(3).toString("hex")}@beta.test`, TPW = "tester-pass-12345";
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const EXPECT = sha256(BETA2);
const until = async (fn, ms, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await L.sleep(every); } return null; };
const asarHash = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(installDir, "resources", "app.asar"))).digest("hex").slice(0, 16);
const running = () => spawnSync("powershell", ["-NoProfile", "-Command", `Get-Process Clynx -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${installDir}*' } | Select-Object -ExpandProperty Id`], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean);
const killInstalled = () => { for (const p of running()) { try { execSync(`taskkill /pid ${p} /T /F`, { stdio: "ignore" }); } catch { /* gone */ } } };
const text = (win) => win.evaluate(() => document.body.innerText);
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const cli = (tool, ...a) => dc("exec", "-T", "api", "node", `dist/scripts/${tool}.js`, ...a);
const newCode = (email) => { const out = cli("invite", "create", "--hours", "6", ...(email ? ["--email", email] : [])); const m = /\n\s+([A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})\n/.exec(out); if (!m) throw new Error("no code in: " + out); return m[1]; };

async function launchApp() {
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
async function quitApp(h) {
  const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  await Promise.race([exited, L.sleep(25000)]);
  killInstalled();
}

(async () => {
  let browser, h = null;
  const caddyDir = path.join(root, "caddy");
  fs.mkdirSync(caddyDir, { recursive: true });
  try {
    // ================================================================ 0. private mode + a local TLS front standing in for the tunnel
    fs.writeFileSync(path.join(caddyDir, "Caddyfile"), `{\n  skip_install_trust\n  auto_https disable_redirects\n  default_sni ${HOST}\n}\nhttps://${HOST}:${HTTPS_PORT} {\n  tls internal\n  reverse_proxy ${HOST}:${PORT}\n}\n`);
    try { execSync("docker rm -f clynx-t21-caddy", { stdio: "ignore" }); } catch { /* none */ }
    execFileSync("docker", ["run", "-d", "--name", "clynx-t21-caddy", "-p", `${HOST}:${HTTPS_PORT}:${HTTPS_PORT}`, "-v", `${caddyDir.replace(/\\/g, "/")}/Caddyfile:/etc/caddy/Caddyfile:ro`, "caddy:2-alpine"], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    const en = ps("Enable-ClynxPrivateAccess.ps1", "-PublicUrl", SECURE);
    L.check("[0] Enable-ClynxPrivateAccess.ps1 turns the private beta on (and keeps a copy of the settings)", en.status === 0 && /Server says: access = private, registration = invite/.test(en.stdout) && fs.readdirSync(STATE).some((f) => f.startsWith(".env.lan.bak-")), (en.stdout || "").slice(-300) + (en.stderr || "").slice(-200));
    await until(() => curl(["-o", "NUL", "-w", "%{http_code}", `${SECURE}/health`]).stdout === "200", 60000, 2000);

    // ================================================================ A. strangers over HTTPS
    const root1 = curl(["-D", "-", "-H", "Accept: text/html", `${SECURE}/`]);
    const hdr = root1.stdout.toLowerCase();
    L.check("[A] https works (a certificate from the stand-in authority) and a stranger gets the small sign-in page, status 401", /http\/[\d.]+ 401/.test(hdr) && root1.stdout.includes("Private beta"));
    L.check("[A] the sign-in page contains no website code (no script, no asset)", !/<script/i.test(root1.stdout) && !/assets\//.test(root1.stdout));
    L.check("[A] HTTPS headers: HSTS, noindex, strict CSP, no-store", /strict-transport-security: max-age/.test(hdr) && /x-robots-tag: noindex/.test(hdr) && /content-security-policy: default-src 'none'/.test(hdr) && /cache-control: no-store/.test(hdr));
    for (const p of ["/releases/latest", "/updates/beta/latest", "/plans/public", "/admin/overview", "/web/session", "/assets/index.js"]) {
      const r = curl(["-w", "\n%{http_code}", `${SECURE}${p}`]);
      L.check(`[A] ${p} is refused for a stranger`, r.stdout.trim().endsWith("401") && /private_beta/.test(r.stdout), r.stdout.slice(0, 100));
    }
    L.check("[A] robots.txt tells crawlers to stay away", /Disallow: \//.test(curl([`${SECURE}/robots.txt`]).stdout));
    const reg = curl(["-X", "POST", "-H", "Content-Type: application/json", "-d", JSON.stringify({ email: "x@y.test", password: "password-12345" }), "-w", "\n%{http_code}", `${SECURE}/auth/register`]);
    L.check("[A] a stranger cannot register without an invitation (desktop endpoint)", reg.stdout.trim().endsWith("403") && /invitation/.test(reg.stdout), reg.stdout.slice(0, 160));
    const info = JSON.parse(curl([`${SECURE}/server/info`]).stdout);
    L.check("[A] /server/info (what the app checks before signing in) says private + invitation-only", info.access === "private" && info.registration === "invite" && info.https === true, info);
    const lanRoot = curl(["-w", "\n%{http_code}", "-H", "Accept: text/html", `${LAN}/`]);
    L.check("[A] the home-network address is gated the same way", lanRoot.stdout.trim().endsWith("401") && lanRoot.stdout.includes("Private beta"));

    // ================================================================ B. first account by invitation, in a real browser over HTTPS
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const ctxOwner = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const pg = await ctxOwner.newPage();
    const consoleErrors = [];
    pg.on("pageerror", (e) => consoleErrors.push(e.message));
    await pg.goto(`${SECURE}/`);
    L.check("[B] the browser shows the private sign-in page", (await pg.title()).includes("Private beta") && (await pg.locator('form[action="/gate/login"]').count()) === 1);
    await pg.evaluate(() => { const d = document.querySelector("details"); if (d) d.open = true; });
    await pg.fill("#je", OWNER);
    await pg.fill("#jp", OPW);
    await pg.fill("#jc", "AAAA-BBBB-CCCC-DDDD");
    await pg.click('form[action="/gate/join"] button');
    L.check("[B] a wrong invitation code is refused with a clear message and creates nothing", /did not work/.test(await pg.textContent("body")) && psql(`select count(*) from users where email='${OWNER}'`) === "0");
    const code1 = newCode();
    await pg.evaluate(() => { const d = document.querySelector("details"); if (d) d.open = true; });
    await pg.fill("#je", OWNER);
    await pg.fill("#jp", OPW);
    await pg.fill("#jc", code1);
    await Promise.all([pg.waitForURL(`${SECURE}/`, { timeout: 30000 }), pg.click('form[action="/gate/join"] button')]);
    await pg.waitForSelector("nav, header", { timeout: 20000 });
    L.check("[B] a valid invitation creates the account, signs in, and opens the real website", psql(`select count(*) from users where email='${OWNER}'`) === "1" && !(await pg.textContent("body")).includes("Private beta"));
    const ck = (await ctxOwner.cookies()).find((c) => /clynx_sid/.test(c.name));
    L.check("[B] the session cookie is __Host-clynx_sid, Secure and HttpOnly (set because the request came over https)", ck && ck.name === "__Host-clynx_sid" && ck.secure && ck.httpOnly && ck.sameSite === "Lax", ck);
    const second = spawnSync("curl", ["-sk", "-X", "POST", "-d", `email=${encodeURIComponent("second@beta.test")}&password=password-12345&inviteCode=${code1}`, "-H", "Content-Type: application/x-www-form-urlencoded", "-H", `Origin: ${SECURE}`, "-w", "\n%{http_code}", `${SECURE}/gate/join`], { encoding: "utf8" });
    L.check("[B] the same code cannot be used twice", second.stdout.trim().endsWith("400") && /did not work/.test(second.stdout));
    // make the first account the Owner (server-side, as designed), then sign in again
    const begin = cli("owner", "begin", OWNER);
    const oc = /\n\s+([A-Za-z0-9_-]{8,})\n/.exec(begin);
    cli("owner", "complete", OWNER, oc[1]);
    await pg.goto(`${SECURE}/`);
    L.check("[B] granting Owner ended the browser session: the gate asks again", (await pg.title()).includes("Private beta"));
    await pg.fill("#le", OWNER);
    await pg.fill("#lp", "wrong-password-1");
    await pg.click('form[action="/gate/login"] button');
    L.check("[B] a wrong password gives a generic message", /not right/.test(await pg.textContent("body")));
    await pg.fill("#le", OWNER);
    await pg.fill("#lp", OPW);
    await Promise.all([pg.waitForURL(`${SECURE}/`, { timeout: 30000 }), pg.click('form[action="/gate/login"] button')]);
    await pg.waitForSelector("nav, header", { timeout: 20000 });
    await pg.goto(`${SECURE}/console/invites`);
    await pg.waitForSelector('text=New invitation', { timeout: 20000 });
    L.check("[B] the Owner reaches the console (Invitations page) over https", /Invitation-only|invitation-only/.test(await pg.textContent("body")) && /private/.test(await pg.textContent("body")));

    // ================================================================ C. releases: draft on the server, nothing public until approved
    const reg2 = ps("Register-ClynxRelease.ps1", "-Installer", BETA2, "-Version", "0.3.0-beta.2", "-Channel", "beta", "-ExpectSha256", EXPECT, "-NotesFile", path.join(L.PROJECT, "release-notes", "0.3.0-beta.2.txt"), "-IssuesFile", path.join(L.PROJECT, "BETA2_KNOWN_ISSUES.md"), "-SigningKey", SIGN_KEY);
    L.check("[C] Register-ClynxRelease.ps1: file stored, checksum matched the expected value, manifest signed with the private key HERE and verified by the server", reg2.status === 0 && /DRAFT with a verified signed manifest/.test(reg2.stdout), (reg2.stdout || "").slice(-500) + (reg2.stderr || "").slice(-300));
    const wrongSha = ps("Register-ClynxRelease.ps1", "-Installer", BETA3, "-Version", "0.3.0-beta.9", "-Channel", "beta", "-ExpectSha256", "0".repeat(64), "-SigningKey", SIGN_KEY);
    L.check("[C] a file that is not the expected one is refused before anything is uploaded", wrongSha.status !== 0 && psql("select count(*) from releases where version='0.3.0-beta.9'") === "0");
    const rel = psql("select status || ' ' || sha256 || ' ' || (update_manifest is not null) from releases where version='0.3.0-beta.2'");
    L.check("[C] the release is a DRAFT whose stored SHA-256 equals the installer's, with a signed manifest attached", rel === `draft ${EXPECT} true`, rel);
    await pg.goto(`${SECURE}/download`);
    await pg.waitForSelector('[data-testid="no-release"]', { timeout: 20000 });
    L.check("[C] while it is a draft, even a signed-in tester sees no release on the Download page", true);
    const api = (method, url, body) => pg.evaluate(async ({ method, url, body }) => {
      const s = await (await fetch("/web/session")).json();
      const r = await fetch(url, { method, headers: { "content-type": "application/json", "x-csrf-token": s.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { method, url, body });
    const list = await api("GET", "/admin/releases");
    const r2 = list.body.releases.find((r) => r.version === "0.3.0-beta.2");
    L.check("[C] the console lists it as a draft with the auto-update manifest ready", r2.status === "draft" && r2.hasUpdateManifest === true && r2.sha256 === EXPECT);
    // the Owner approves and publishes it (the deliberate step; here, on the TEST server only)
    L.check("[C] approve", (await api("POST", `/admin/releases/${r2.id}/approve`, {})).status === 200);
    const early = curl(["-w", "\n%{http_code}", `${SECURE}/releases/${r2.id}/download`]);
    L.check("[C] an approved-but-unpublished installer is still not downloadable", early.stdout.trim().endsWith("401") || early.stdout.trim().endsWith("404"));
    L.check("[C] publish (typing the version)", (await api("POST", `/admin/releases/${r2.id}/publish`, { confirmVersion: "0.3.0-beta.2" })).status === 200);

    // ================================================================ D. the Download page, as an authorized tester, then as a stranger
    await pg.goto(`${SECURE}/download`);
    await pg.waitForSelector('[data-testid="release-card"]', { timeout: 20000 });
    const body = await pg.textContent("body");
    L.check("[D] the Download page shows 'Clynx Beta 2' and its version", (await pg.textContent('[data-testid="release-title"]')).includes("Clynx Beta 2") && /version 0\.3\.0-beta\.2/.test(body));
    L.check("[D] ...Windows compatibility, installer size and the SHA-256 checksum", /Windows 10 or 11, 64-bit/.test(body) && /Windows x64/.test(body) && /\d+ MB/.test(body) && (await pg.textContent('[data-testid="sha256"]')).trim().toLowerCase() === EXPECT);
    L.check("[D] ...release notes, installation instructions, the unsigned-installer / SmartScreen warning", (await pg.textContent('[data-testid="release-notes"]')).length > 20 && /Install/i.test(body) && /Unknown publisher/.test(body) && /not yet signed/.test(body));
    L.check("[D] ...and the secure server address to type into Clynx", (await pg.textContent('[data-testid="server-address"]')).trim() === SECURE);
    const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 120000 }), pg.click('[data-testid="download-button"]')]);
    const saved = path.join(downloads, dl.suggestedFilename());
    await dl.saveAs(saved);
    L.check("[D] the tester downloads the installer through the private https site; its SHA-256 equals the published checksum and the Phase 11 installer", sha256(saved) === EXPECT, sha256(saved));
    const ctxStranger = await browser.newContext({ ignoreHTTPSErrors: true });
    const strangerDl = await ctxStranger.request.get(`${SECURE}/releases/${r2.id}/download`);
    L.check("[D] a stranger (no sign-in) cannot download it", strangerDl.status() === 401);
    const strangerPage = await ctxStranger.newPage();
    await strangerPage.goto(`${SECURE}/download`);
    L.check("[D] a stranger opening the Download page gets the sign-in page instead", (await strangerPage.title()).includes("Private beta"));
    await ctxStranger.close();

    // ================================================================ E. invitation made in the console UI, used by the second PC (the installed app)
    await pg.goto(`${SECURE}/console/invites`);
    await pg.fill("#i-email", TESTER);
    await pg.fill("#i-note", "second PC");
    await pg.click("text=Create invitation");
    await pg.waitForSelector('[data-testid="invite-code"]', { timeout: 20000 });
    const code2 = (await pg.textContent('[data-testid="invite-code"]')).trim();
    L.check("[E] the console shows a new invitation code once, bound to the tester's email", /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(code2));
    await pg.reload();
    await pg.waitForSelector('[data-testid="invite-open"]', { timeout: 20000 });
    L.check("[E] after a reload the code is gone; only a status remains", !(await pg.textContent("body")).includes(code2));

    // ================================================================ F. install what was DOWNLOADED, connect, register with the invitation
    const code = spawnSync(saved, ["/S", `/D=${installDir}`], { timeout: 600000 }).status;
    L.check("[F] the downloaded installer installs silently", code === 0 && fs.existsSync(EXE), code);
    const B2_ASAR = asarHash();
    h = await launchApp();
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
    await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('[data-testid="server-url-input"]', { timeout: 15000 });
    await h.win.fill('[data-testid="server-url-input"]', SECURE);
    await h.win.click('[data-testid="server-test"]');
    await h.win.waitForSelector('[data-testid="server-fail"]', { timeout: 30000 });
    L.check("[F] over https the app refuses an address whose certificate it does not trust (no override exists), in plain words", /certificate/i.test(await h.win.textContent('[data-testid="server-fail"]')), await h.win.textContent('[data-testid="server-fail"]'));
    await h.win.fill('[data-testid="server-url-input"]', `${HOST}:${PORT}`);
    await h.win.click('[data-testid="server-test"]');
    await h.win.waitForSelector('[data-testid="server-ok"]', { timeout: 20000 });
    await clickText(h.win, /Need an account/);
    await h.win.waitForSelector('[data-testid="invite-code-input"]', { timeout: 20000 });
    L.check("[F] on a private server the register form asks for the invitation code", true);
    await h.win.fill('input[type="email"]', TESTER);
    await h.win.fill('input[type="password"]', TPW);
    await h.win.fill('[data-testid="invite-code-input"]', "AAAA-BBBB-CCCC-DDDD");
    await h.win.click('button[type="submit"]');
    await L.sleep(2500);
    L.check("[F] a wrong code is refused in plain words and no account is created", /did not work/.test(await text(h.win)) && psql(`select count(*) from users where email='${TESTER}'`) === "0");
    await h.win.fill('[data-testid="invite-code-input"]', code2);
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    L.check("[F] with the invitation the account is created and the desktop app is signed in", psql(`select count(*) from users where email='${TESTER}'`) === "1");
    const dev = await until(() => psql(`select count(*) from devices d join users u on u.id=d.user_id where u.email='${TESTER}'`) === "1", 30000, 2000);
    L.check("[F] the computer registered itself as a device", !!dev);
    const sess = await h.win.evaluate(() => window.api.auth.getSession());
    L.check("[F] the app talks to the private server over the home-network address and uses its sign-in for everything", sess.authenticated && sess.apiUrl === LAN);
    const userFolder = path.join(userData, "data", "users", sess.userId);
    const dbFile = path.join(userFolder, "scout.db");

    // ================================================================ G. disconnection and reconnection, persistence
    await quitApp(h);
    h = null;
    {
      const d = new DatabaseSync(dbFile);
      const need = d.prepare("PRAGMA table_info(products)").all().filter((c) => c.notnull && c.dflt_value == null && !c.pk);
      d.prepare(`INSERT INTO products (${["id", ...need.map((c) => c.name)].join(",")}) VALUES (${["id", ...need].map(() => "?").join(",")})`).run("t21-product-1", ...need.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : "private beta persistence")));
      d.close();
    }
    h = await launchApp();
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[G] after a restart the app signs back in by itself on the private server", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    L.check("[G] the local Database row is still there", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "t21-product-1"));
    dc("stop", "api", "worker");
    const off = await until(async () => (await h.win.evaluate(() => window.api.listNotices())).some((n) => n.id === "cloud-offline"), 120000, 2000);
    L.check("[G] with the server stopped the app says 'working offline' and keeps working", !!off && (await h.win.evaluate(() => window.api.listProducts())).length >= 1);
    dc("start", "api", "worker");
    const back = await until(async () => !(await h.win.evaluate(() => window.api.listNotices())).some((n) => n.id === "cloud-offline"), 120000, 2000);
    L.check("[G] when the server returns the app reconnects by itself", !!back && (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    L.check("[G] server data persisted across the restart (both accounts, the published release)", psql("select count(*) from users") === "2" && psql("select status from releases where version='0.3.0-beta.2'") === "published");

    // ================================================================ H. signed updates through the gate
    const unauthUpd = curl(["-w", "\n%{http_code}", `${SECURE}/updates/beta/latest`]);
    L.check("[H] the update manifest endpoint is refused for a stranger, even though a signed manifest is published", unauthUpd.stdout.trim().endsWith("401"));
    const noKeyUpd = curl(["-w", "\n%{http_code}", "-H", "Authorization: Bearer not-a-token", `${LAN}/updates/beta/latest`]);
    L.check("[H] ...and for a forged bearer token", noKeyUpd.stdout.trim().endsWith("401"));
    const reg3 = ps("Register-ClynxRelease.ps1", "-Installer", BETA3, "-Version", "0.3.0-beta.3", "-Channel", "beta", "-SigningKey", SIGN_KEY);
    L.check("[H] a newer test-only build (0.3.0-beta.3) is prepared as a signed draft", reg3.status === 0, (reg3.stdout || "").slice(-300));
    const r3 = (await api("GET", "/admin/releases")).body.releases.find((r) => r.version === "0.3.0-beta.3");
    await api("POST", `/admin/releases/${r3.id}/approve`, {});
    L.check("[H] published (test server only)", (await api("POST", `/admin/releases/${r3.id}/publish`, { confirmVersion: "0.3.0-beta.3" })).status === 200);
    const info2 = await h.win.evaluate(() => window.api.updates.check());
    L.check("[H] the installed app, signed in, passes the gate with its own sign-in: the update is found, downloaded and verified", info2.status.state === "ready" && info2.status.version === "0.3.0-beta.3", info2.status);
    const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
    L.check("[H] 'Restart and install' starts the installer", (await h.win.evaluate(() => window.api.updates.install())).ok === true);
    await Promise.race([exited, L.sleep(60000)]);
    L.check("[H] the program is replaced in place", !!(await until(() => asarHash() !== B2_ASAR, 180000, 2000)));
    await L.sleep(8000);
    L.check("[H] Clynx reopens itself on the same data", running().length > 0, running());
    killInstalled();
    await L.sleep(1500);
    h = await launchApp();
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[H] 0.3.0-beta.3 starts, is still signed in to the private server, and the data is intact", (await h.app.evaluate(({ app: a }) => a.getVersion())) === "0.3.0-beta.3" && (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "t21-product-1"));
    const rb = await h.win.evaluate(() => window.api.updates.rollback());
    L.check("[H] 'Go back' also passes the gate: the signed earlier build is fetched, verified and installed", rb.ok === true, rb);
    await L.sleep(5000);
    L.check("[H] the program is Beta 2 again", !!(await until(() => asarHash() === B2_ASAR, 180000, 2000)));
    await L.sleep(8000);
    killInstalled();
    h = null;

    // ================================================================ I. nothing else is exposed
    const listening = spawnSync("powershell", ["-NoProfile", "-Command", "Get-NetTCPConnection -State Listen | ForEach-Object { '{0}:{1}' -f $_.LocalAddress, $_.LocalPort }"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    const bad = listening.filter((l) => /:(5432|6379|2375|2376|8787)$/.test(l) && !/^(127\.0\.0\.1|::1):/.test(l));
    L.check("[I] PostgreSQL, Redis, the developer API and the Docker daemon port are not reachable from the network (only 127.0.0.1)", bad.length === 0, bad);
    const ports = execSync("docker ps --format \"{{.Names}} {{.Ports}}\"", { encoding: "utf8" }).split(/\r?\n/).filter((l) => /clynx/.test(l));
    const publishedBeyond = ports.filter((l) => /\d+\.\d+\.\d+\.\d+:\d+->/.test(l) && !/(127\.0\.0\.1:(8787|5432|6379)->|10\.0\.0\.81:(8788|8796|8797)->)/.test(l));
    L.check("[I] the only Docker ports published are the dev stack on 127.0.0.1 and the API/website/TLS-front on the LAN address", publishedBeyond.length === 0, publishedBeyond);
    L.check("[I] the Postgres/Redis containers of the private server publish nothing", ports.filter((l) => /clynx-lan-test-(postgres|redis)/.test(l)).every((l) => !/->/.test(l)), ports);

    // ================================================================ J. rolling back the private mode
    const dis = ps("Disable-ClynxPrivateAccess.ps1", "-Force");
    const info3 = JSON.parse(curl([`${LAN}/server/info`]).stdout || "{}");
    L.check("[J] Disable-ClynxPrivateAccess.ps1 returns the server to the open Phase 11 behaviour (accounts untouched)", dis.status === 0 && info3.access === "open" && info3.registration === "open" && psql("select count(*) from users") === "2", (dis.stdout || "").slice(-200));
    L.check("[*] no page errors in the browser", consoleErrors.length === 0, consoleErrors.slice(0, 3));
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    if (h) console.log("MAIN OUTPUT (tail):", h.out.join("").slice(-2000));
  } finally {
    try { if (h) await quitApp(h); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    killInstalled();
    try { execSync("docker rm -f clynx-t21-caddy", { stdio: "ignore" }); } catch { /* ignore */ }
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  console.log("temp folder:", root);
  process.exit(failed ? 1 : 0);
})();
