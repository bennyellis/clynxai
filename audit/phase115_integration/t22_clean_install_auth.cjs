// T22 (Phase 11.5 fix): sign-in on a computer that has NEVER had a Clynx server of its own - the "localhost:8787" failure.
// Root cause being guarded: every build before this one started the sign-in at the developer address http://localhost:8787 and wrote it into app-settings.json; an installed copy that was
// updated or reinstalled kept it, so on another PC the sign-in tried "localhost" (that PC) and failed. This test runs the PACKAGED app (the same app.asar the installer carries) with:
//   S1 a clean profile            S2 a Beta-1-style profile (settings file holding localhost:8787, local mode on)   S3 the same without local mode
//   S4 a full register + sign-out + sign-in + restart on a private invitation-only Docker server (throw-away copy, port 8796)
//   S5 the localhost error message   S6 proof that nothing reached the developer server on localhost:8787 during the whole run
// It never types a password anywhere but the throw-away server, never contacts localhost:8787, and uses no installer (so no UAC prompt). With INSTALLED_EXE=<...\Clynx.exe> it runs the same
// checks against an installed copy instead.
//   env: DEFAULT_SERVER (the address baked into the build, e.g. https://ben.tail0e333d.ts.net)
const L = require("./lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const EXE = process.env.INSTALLED_EXE || path.join(L.PROJECT, "dist", "win-unpacked", "Clynx.exe");
const FUNNEL = process.env.DEFAULT_SERVER || "";
const HOST = "10.0.0.81", PORT = 8796, LAN = `http://${HOST}:${PORT}`;
const STATE = "C:\\Users\\biggt\\ClynxLanTest", ENVFILE = path.join(STATE, ".env.lan");
const COMPOSE = path.join(L.PROJECT, "cloud", "docker-compose.lan.yml");
const WIN = path.join(L.PROJECT, "cloud", "deploy", "windows");
const composeEnv = { ...process.env, LAN_BIND: HOST, LAN_PORT: String(PORT), CLYNX_ENV_FILE: ENVFILE, CLYNX_IMAGE: "clynx-lan-test-api:latest" };
const dc = (...a) => execFileSync("docker", ["compose", "-p", "clynx-lan-test", "-f", COMPOSE, "--env-file", ENVFILE, ...a], { env: composeEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ps = (script, ...args) => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(WIN, script), ...args], { env: { ...composeEnv, CLYNX_LAN_DIR: STATE, CLYNX_COMPOSE_PROJECT: "clynx-lan-test" }, encoding: "utf8", timeout: 900000 });
const envVals = () => Object.fromEntries(fs.readFileSync(ENVFILE, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const psql = (sql) => { const v = envVals(); return dc("exec", "-T", "postgres", "psql", "-U", v.POSTGRES_USER, "-d", v.POSTGRES_DB, "-tAc", sql).trim(); };
const newCode = () => { const out = dc("exec", "-T", "api", "node", "dist/scripts/invite.js", "create", "--hours", "6"); const m = /\n\s+([A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})\n/.exec(out); if (!m) throw new Error("no code: " + out); return m[1]; };
// requests the developer server on localhost:8787 has seen (it must see NONE from this test)
const devRequests = () => { try { return execFileSync("docker", ["logs", "clynx-cloud-api", "--since", "5h"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter((l) => /incoming request/.test(l)).length; } catch { return -1; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t22-"));
let n = 0;
const profile = (settings) => {
  const dir = path.join(root, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  if (settings) fs.writeFileSync(path.join(dir, "app-settings.json"), JSON.stringify(settings));
  return dir;
};
const text = (win) => win.evaluate(() => document.body.innerText);
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const until = async (fn, ms, every = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await L.sleep(every); } return null; };
async function launch(userData) {
  const out = [];
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: path.dirname(EXE), env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 90000 });
  app.process().stdout?.on("data", (d) => out.push(String(d)));
  app.process().stderr?.on("data", (d) => out.push(String(d)));
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win, out };
}
async function quit(h) {
  const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  await Promise.race([exited, L.sleep(25000)]);
}
const toCloudForm = async (h) => {
  await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 60000 });
  await clickText(h.win, /I have a Clynx Cloud account/);
  await h.win.waitForSelector('[data-testid="server-url-input"]', { timeout: 15000 });
};

(async () => {
  let h = null;
  const devBefore = devRequests();
  try {
    L.check("[0] the app under test is a PACKAGED build (resources\\app.asar), not a development run", fs.existsSync(path.join(path.dirname(EXE), "resources", "app.asar")));
    // the private, invitation-only server (a throw-away copy of the real stack)
    const en = ps("Enable-ClynxPrivateAccess.ps1");
    L.check("[0] the throw-away server is private + invitation-only", en.status === 0 && /access = private, registration = invite/.test(en.stdout), (en.stdout || "").slice(-200));

    // ============================================================ S1. a clean profile (a new PC)
    h = await launch(profile(null));
    await toCloudForm(h);
    const input = h.win.locator('[data-testid="server-url-input"]');
    L.check("[S1] the Server address box is VISIBLE on the sign-in form (not hidden under 'Advanced')", await input.isVisible());
    L.check("[S1] a clean install starts at the address built into this release (or empty if none), never localhost", (await input.inputValue()) === FUNNEL && !/localhost|127\.0\.0\.1|8787/.test(await text(h.win)), await input.inputValue());
    if (FUNNEL) {
      await h.win.waitForSelector('[data-testid="server-ok"], [data-testid="server-fail"]', { timeout: 40000 });
      const okText = (await h.win.locator('[data-testid="server-ok"]').count()) ? await h.win.textContent('[data-testid="server-ok"]') : await h.win.textContent('[data-testid="server-fail"]');
      L.check("[S1] the address is checked automatically and the REAL private server answers over https (valid certificate): 'Connected to ...'", (await h.win.locator('[data-testid="server-ok"]').count()) === 1, okText);
      const sess = await h.win.evaluate(() => window.api.auth.getSession());
      L.check("[S1] the session reports that server address", sess.apiUrl === FUNNEL, sess);
    }
    await quit(h);
    h = null;

    // ============================================================ S2. a Beta-1-style profile: settings file with the old developer default AND local mode on
    const legacyDir = profile({ cloudApiUrl: "http://localhost:8787", localMode: true });
    h = await launch(legacyDir);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[S2] the tester's local-mode choice is preserved (the app opens straight into local mode)", (await h.win.evaluate(() => window.api.beta.info())).localMode === true);
    const info = await h.win.evaluate(() => window.api.beta.info());
    L.check("[S2] ...but the saved server address is no longer localhost:8787", info.cloudApiUrl === FUNNEL, info.cloudApiUrl);
    await clickText(h.win, /^Config$/);
    await L.sleep(500);
    await clickText(h.win, /^account$/);
    await h.win.waitForSelector('[data-testid="leave-local"]', { timeout: 20000 });
    await h.win.click('[data-testid="leave-local"]');
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 20000 });
    await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('[data-testid="server-url-input"]', { timeout: 15000 });
    L.check("[S2] after leaving local mode the sign-in form shows the real server, not localhost", (await h.win.locator('[data-testid="server-url-input"]').inputValue()) === FUNNEL && !/localhost|8787/.test(await text(h.win)));
    const saved = JSON.parse(fs.readFileSync(path.join(legacyDir, "app-settings.json"), "utf8"));
    L.check("[S2] the settings file on disk no longer holds the old default", !/8787/.test(JSON.stringify(saved)), saved);
    await quit(h);
    h = null;

    // ============================================================ S3. the same legacy file, never in local mode
    h = await launch(profile({ cloudApiUrl: "http://127.0.0.1:8787" }));
    await toCloudForm(h);
    L.check("[S3] a legacy 127.0.0.1:8787 settings file also starts at the real server", (await h.win.locator('[data-testid="server-url-input"]').inputValue()) === FUNNEL);
    await quit(h);
    h = null;

    // ============================================================ S4. register with an invitation, sign out, SIGN IN, restart - on the private server
    const EMAIL = `clean-${crypto.randomBytes(3).toString("hex")}@beta.test`, PW = "clean-install-pass-1";
    const dir4 = profile({ cloudApiUrl: "http://localhost:8787" }); // the poisoned legacy file, then the person types the real address
    h = await launch(dir4);
    await toCloudForm(h);
    await h.win.fill('[data-testid="server-url-input"]', `${HOST}:${PORT}`);
    await h.win.waitForSelector('[data-testid="server-ok"]', { timeout: 30000 });
    L.check("[S4] typing the server's address is checked at once: 'Connected', private server noticed", /Clynx TEST server|Connected to/.test(await h.win.textContent('[data-testid="server-ok"]')));
    await clickText(h.win, /Need an account/);
    await h.win.waitForSelector('[data-testid="invite-code-input"]', { timeout: 20000 });
    await h.win.fill('input[type="email"]', EMAIL);
    await h.win.fill('input[type="password"]', PW);
    await h.win.fill('[data-testid="invite-code-input"]', newCode());
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    const s4 = await h.win.evaluate(() => window.api.auth.getSession());
    L.check("[S4] registration with the invitation works and the app is signed in to the typed address (not localhost)", s4.authenticated && s4.apiUrl === LAN && psql(`select count(*) from users where email='${EMAIL}'`) === "1", s4);
    L.check("[S4] the computer registered itself as a device", !!(await until(() => psql(`select count(*) from devices d join users u on u.id=d.user_id where u.email='${EMAIL}'`) === "1", 30000, 2000)));
    L.check("[S4] the saved address on disk is the real server", JSON.parse(fs.readFileSync(path.join(dir4, "app-settings.json"), "utf8")).cloudApiUrl === LAN);
    // sign out (Config > Account > Log out)
    await clickText(h.win, /^Config$/);
    await L.sleep(500);
    await clickText(h.win, /^account$/);
    await h.win.waitForSelector('[data-testid="account-section"]', { timeout: 30000 });
    const loggedOut = await h.win.evaluate(() => window.api.auth.logout());
    await h.win.waitForFunction(() => !!document.querySelector('input[type="password"], [data-testid="beta-welcome"]'), null, { timeout: 30000 }).catch(() => {});
    L.check("[S4] signing out returns to the sign-in screen", !/Start Scanner/i.test(await text(h.win)) || loggedOut?.ok === true);
    if ((await h.win.locator('[data-testid="beta-welcome"]').count()) > 0) await clickText(h.win, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('[data-testid="server-url-input"]', { timeout: 20000 });
    L.check("[S4] the sign-in form remembers the server the person used", (await h.win.locator('[data-testid="server-url-input"]').inputValue()) === LAN);
    await h.win.waitForSelector('[data-testid="server-ok"]', { timeout: 30000 });
    await h.win.fill('input[type="email"]', EMAIL);
    await h.win.fill('input[type="password"]', "wrong-password-1");
    await h.win.click('button[type="submit"]');
    await L.sleep(2500);
    L.check("[S4] a wrong password is refused in plain words, still on the real server", /not right|Invalid credentials|do not match/i.test(await text(h.win)) && !/localhost/.test(await text(h.win)));
    await h.win.fill('input[type="password"]', PW);
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 60000 });
    L.check("[S4] signing IN (not registering) with the right password works", (await h.win.evaluate(() => window.api.auth.getSession())).apiUrl === LAN);
    await quit(h);
    h = await launch(dir4);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[S4] after a restart the app signs in by itself", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    L.check("[S4] private-beta rules still hold: a stranger still gets 401 and a stranger cannot register without a code", spawnSync("curl", ["-s", "-o", "NUL", "-w", "%{http_code}", "-H", "Accept: text/html", `${LAN}/`], { encoding: "utf8" }).stdout === "401" && spawnSync("curl", ["-s", "-X", "POST", "-H", "Content-Type: application/json", "-d", JSON.stringify({ email: "x@y.test", password: "password-123" }), "-o", "NUL", "-w", "%{http_code}", `${LAN}/auth/register`], { encoding: "utf8" }).stdout === "403");
    await quit(h);
    h = null;

    // ============================================================ S5. a wrong "localhost" address explains itself (nothing listens on 8799)
    h = await launch(profile(null));
    await toCloudForm(h);
    await h.win.fill('[data-testid="server-url-input"]', "http://localhost:8799");
    await h.win.waitForSelector('[data-testid="server-fail"]', { timeout: 30000 });
    const msg = await h.win.textContent('[data-testid="server-fail"]');
    L.check("[S5] localhost with nothing listening says 'localhost means THIS computer' and what to do", /THIS computer/.test(msg) && /server/i.test(msg), msg);
    await h.win.fill('input[type="email"]', "someone@example.com");
    await h.win.fill('input[type="password"]', "never-sent-123");
    await h.win.click('button[type="submit"]');
    await L.sleep(1500);
    L.check("[S5] sign-in is NOT attempted against an address that did not answer as a Clynx server", /THIS computer|Clynx server|did not answer|refused/i.test(await text(h.win)) && !/Start Scanner/i.test(await text(h.win)));
    await quit(h);
    h = null;

    // ============================================================ S6. nothing reached the developer server on localhost:8787
    const devAfter = devRequests();
    L.check("[S6] the developer server on localhost:8787 received NO request from any of these runs", devBefore === devAfter, { devBefore, devAfter });
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    if (h) console.log("MAIN OUTPUT (tail):", h.out.join("").slice(-1500));
  } finally {
    try { if (h) await quit(h); } catch { /* ignore */ }
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
