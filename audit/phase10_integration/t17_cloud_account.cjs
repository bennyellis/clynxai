// T17 (Phase 10) in the REAL app, sandboxed, against a REAL Clynx Cloud server (its own throwaway database and Redis database; simulated payments; no OpenAI, eBay, Stripe or
// email involved): signing in from the desktop with the local beta data copied across, shared AI/eBay mode without keys, saved keys kept until the person decides, optional key
// protection, working offline when the server is down, and a revoked device being signed out.
const L = require("./lib.cjs");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn, execSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const CLOUD_DIR = L.path.join(L.PROJECT, "cloud");
const PORT = 8793;
const BASE = `http://localhost:${PORT}`;
const DB = "clynx_desktop_integ";
const DB_URL = `postgres://clynx:clynx_dev_password@localhost:5432/${DB}`;
const env = {
  ...process.env,
  DATABASE_URL: DB_URL, REDIS_URL: "redis://localhost:6379/7", PORT: String(PORT), PUBLIC_URL: BASE, COOKIE_SECURE: "false", OPENAI_API_KEY: "",
  JWT_ACCESS_SECRET: crypto.randomBytes(24).toString("hex"), JWT_REFRESH_SECRET: crypto.randomBytes(24).toString("hex"),
  CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"), BILLING_FAKE: "true", STRIPE_PRICE_PRO_MONTHLY: "price_x", RATE_LIMIT_REGISTER_PER_HOUR: "1000", NODE_ENV: "test",
  WEBSITE_DIR: L.path.join(L.os.tmpdir(), "no-website-here"),
};
let server = null;
async function startServer() {
  server = spawn("npx", ["tsx", "src/index.ts"], { cwd: CLOUD_DIR, env, shell: true, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
    await L.sleep(500);
  }
  throw new Error("the cloud server did not start");
}
function stopServer() {
  if (!server) return;
  try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  server = null;
}

const FAKE_KEY = "sk-test-" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2";
const EMAIL = `desktop-${crypto.randomBytes(3).toString("hex")}@example.com`;
const PW = "desktop-pass-1234";
const text = (h) => h.win.evaluate(() => document.body.innerText);
const clickText = (h, re) => h.win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const gotoAccount = async (h) => {
  await clickText(h, /^Config$/);
  await L.sleep(500);
  await clickText(h, /^account$/);
  await h.win.waitForSelector('[data-testid="about-block"]', { timeout: 15000 });
};
const writeBuildInfo = (sb) => {
  fs.mkdirSync(L.path.join(sb.appDir, "resources"), { recursive: true });
  fs.writeFileSync(L.path.join(sb.appDir, "resources", "build-info.json"), JSON.stringify({ product: "clynx", version: "0.3.0-beta.1", channel: "beta", commit: "abc123def456", dirty: false, builtAt: "2026-10-14T00:00:00.000Z" }));
};
const envFile = (sb) => { try { return fs.readFileSync(L.path.join(sb.appDir, ".env"), "utf-8"); } catch { return ""; } };
const accountFolders = (sb) => {
  const d = L.path.join(sb.appDir, "data", "users");
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};
const noisy = (h) => h.mainOut.join("").split("\n").filter((l) => /uncaught|TypeError|ReferenceError|Cannot read|SyntaxError/i.test(l));

(async () => {
  execSync(`npx tsx src/scripts/createdb.ts ${DB} --reset`, { cwd: CLOUD_DIR, stdio: "ignore", shell: true });
  execSync("npx tsx src/db/migrate.ts", { cwd: CLOUD_DIR, stdio: "ignore", shell: true, env });
  await startServer();
  const sb = L.makeSandbox("t17");
  writeBuildInfo(sb);
  L.writeAppSettings(sb, BASE);
  let h;
  try {
    // ------------------------------------------------------------ A. a beta tester uses local mode, saves a key and gets some data
    h = await L.launch(sb);
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 30000 });
    await h.win.click('[data-testid="start-local"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 30000 });
    L.check("[A] the key is saved in local mode", (await h.win.evaluate((k) => window.api.saveOpenAIKey(k), FAKE_KEY)).ok === true);
    const localFolder = L.userFolder(sb);
    await L.closeApp(h);
    h = null;
    const d = new DatabaseSync(L.path.join(localFolder, "scout.db"));
    const need = d.prepare("PRAGMA table_info(products)").all().filter((c) => c.notnull && c.dflt_value == null && !c.pk);
    d.prepare(`INSERT INTO products (${["id", ...need.map((c) => c.name)].join(",")}) VALUES (${["id", ...need].map(() => "?").join(",")})`).run("beta-product-1", ...need.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 1 : "beta data")));
    d.close();
    const dbHashBefore = L.sha(L.path.join(localFolder, "scout.db"));

    // ------------------------------------------------------------ B. signing up from the desktop, copying the local data across
    h = await L.launch(sb);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 30000 });
    await gotoAccount(h);
    await h.win.click('[data-testid="leave-local"]');
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 15000 });
    await clickText(h, /I have a Clynx Cloud account/);
    await h.win.waitForSelector('input[type="password"]', { timeout: 10000 });
    await clickText(h, /Need an account/);
    L.check("[B] the sign-in form offers to copy the local beta data", (await h.win.locator('[data-testid="import-local"]').count()) === 1);
    await h.win.fill('input[type="email"]', EMAIL);
    await h.win.fill('input[type="password"]', PW);
    await h.win.locator('[data-testid="import-local"] input').check();
    await h.win.click('button[type="submit"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 45000 });
    L.check("[B] the account was created on the REAL server and the desktop is signed in", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);
    const probe = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) });
    L.check("[B] ...on THIS test's server (the sign-in form started from the saved server address), not any other", probe.status === 200, probe.status);
    L.check("[B] the saved server address is the test server", (await h.win.evaluate(() => window.api.auth.getSession())).apiUrl === BASE);
    const folders = accountFolders(sb);
    L.check("[B] the account has its own data folder and the local beta folder is still there", folders.length === 2 && folders.includes("local-beta"), folders);
    L.check("[B] the local beta Database file is byte-for-byte unchanged (copied, never moved)", L.sha(L.path.join(localFolder, "scout.db")) === dbHashBefore);
    L.check("[B] the account sees the copied data", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "beta-product-1"));
    L.check("[B] the saved key was not touched by signing in", envFile(sb).includes(FAKE_KEY));
    const notices = await h.win.evaluate(() => window.api.listNotices());
    L.check("[B] a notice says the local data was copied", notices.some((n) => n.id === "local-import"), notices.map((n) => n.id));

    // ------------------------------------------------------------ C. cloud mode: shared AI/eBay, no keys needed, saved keys kept until the person decides
    await gotoAccount(h);
    let info = await h.win.evaluate(() => window.api.beta.info());
    L.check("[C] with keys already saved the app keeps using them until told otherwise", info.apiSource === "own" && info.hasSavedKeys === true && info.localMode === false, info);
    L.check("[C] the page explains cloud mode and offers the shared service", (await h.win.locator('[data-testid="apis-own"]').count()) === 1 && /Cloud mode/.test(await text(h)));
    L.check("[C] the key entry form is NOT shown in cloud mode (no key is required)", (await h.win.locator('[data-testid="keys-block"]').count()) === 0 && (await h.win.locator('[data-testid="openai-key"]').count()) === 0);
    await h.win.click('[data-testid="use-shared"]');
    await h.win.waitForSelector('[data-testid="apis-shared"]', { timeout: 10000 });
    info = await h.win.evaluate(() => window.api.beta.info());
    L.check("[C] switching to the shared service takes effect", info.apiSource === "shared");
    L.check("[C] ...and says plainly that no key is needed", /do not need an OpenAI or eBay key/i.test(await text(h)));
    L.check("[C] ...and the saved key is still on this computer, untouched", envFile(sb).includes(FAKE_KEY) && info.hasSavedKeys === true);
    L.check("[C] AI counts as available through the account (no 'add your OpenAI key' notice)", !(await h.win.evaluate(() => window.api.listNotices())).some((n) => n.id === "no-ai-key"));

    // optional protection of the saved keys
    L.check("[C] the protection option is offered, off by default", (await h.win.locator('[data-testid="protect-keys"]').count()) === 1 && info.keyProtection?.on === false && info.keyProtection?.plain >= 1);
    await h.win.click('[data-testid="protect-keys"]');
    await h.win.waitForSelector('[data-testid="protect-note"]', { timeout: 10000 });
    const protectedEnv = envFile(sb);
    L.check("[C] protecting encrypts the key in the file", !protectedEnv.includes(FAKE_KEY) && /OPENAI_API_KEY=enc:v1:/.test(protectedEnv), protectedEnv.replace(/enc:v1:[A-Za-z0-9+/=]+/g, "enc:v1:<...>"));
    const copies = fs.readdirSync(sb.appDir).filter((f) => f.startsWith(".env.backup-"));
    L.check("[C] ...after a full copy of the old file was kept", copies.length === 1 && fs.readFileSync(L.path.join(sb.appDir, copies[0]), "utf-8").includes(FAKE_KEY), copies);
    L.check("[C] ...and the app still has the key (it read it back)", (await h.win.evaluate(() => window.api.beta.info())).hasSavedKeys === true);
    await L.closeApp(h);
    h = null;

    // ------------------------------------------------------------ D. restart: protected key still works; server DOWN => offline, not locked out
    stopServer();
    h = await L.launch(sb);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    L.check("[D] with the server down the app still opens with the account's data", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "beta-product-1"));
    L.check("[D] the protected key was decrypted at start", (await h.win.evaluate(() => window.api.beta.info())).hasSavedKeys === true);
    await L.sleep(1500);
    const off = await h.win.evaluate(() => window.api.listNotices());
    L.check("[D] a notice says the app is working offline", off.some((n) => n.id === "cloud-offline"), off.map((n) => n.id));
    L.check("[D] the account is still signed in (not logged out by an unreachable server)", (await h.win.evaluate(() => window.api.auth.getSession())).authenticated === true);

    // the server comes back: the app reconnects by itself, without a restart
    await startServer();
    let online = false;
    for (let i = 0; i < 40 && !online; i++) {
      await L.sleep(3000);
      online = !(await h.win.evaluate(() => window.api.listNotices())).some((n) => n.id === "cloud-offline");
    }
    L.check("[D] when the server returns the offline notice clears by itself", online);

    // turn protection off again, then delete the leftovers and the keys
    await gotoAccount(h);
    await h.win.click('[data-testid="unprotect-keys"]');
    await L.sleep(1000);
    L.check("[D] turning protection off restores the key as plain text", envFile(sb).includes(FAKE_KEY));
    await h.win.click('[data-testid="delete-key-copies"]');
    await L.sleep(800);
    L.check("[D] the old copies of the keys file can be deleted on request", fs.readdirSync(sb.appDir).filter((f) => f.startsWith(".env.backup-") || f === ".env.bak").length === 0, fs.readdirSync(sb.appDir));
    await h.win.click('[data-testid="delete-keys"]');
    await h.win.click('[data-testid="delete-keys-confirm"]');
    await L.sleep(800);
    info = await h.win.evaluate(() => window.api.beta.info());
    L.check("[D] deleting the saved keys removes them from the file and the app", !envFile(sb).includes(FAKE_KEY) && info.hasSavedKeys === false && info.apiSource === "shared", { env: envFile(sb), info });
    L.check("[D] AI is still available through the account without any key (no 'add your OpenAI key' notice)", !(await h.win.evaluate(() => window.api.listNotices())).some((n) => n.id === "no-ai-key"));

    // ------------------------------------------------------------ E. a device revoked from the website is signed out
    const login = await fetch(`${BASE}/web/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: EMAIL, password: PW }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const csrf = (await login.json()).csrfToken;
    const devs = await (await fetch(`${BASE}/devices`, { headers: { cookie } })).json();
    const list = devs.devices ?? devs;
    L.check("[E] the website lists the desktop as a device", Array.isArray(list) && list.length >= 1, devs);
    if (Array.isArray(list) && list.length) {
      for (const dv of list) {
        const r = await fetch(`${BASE}/devices/${dv.id}`, { method: "DELETE", headers: { cookie, "x-csrf-token": csrf, origin: BASE } });
        L.check(`[E] the website revokes the device (${r.status})`, r.ok, r.status);
      }
    }
    await L.closeApp(h);
    h = null;
    h = await L.launch(sb);
    await h.win.waitForFunction(() => !!document.querySelector('input[type="password"]') || /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    const sess = await h.win.evaluate(() => window.api.auth.getSession());
    L.check("[E] after the device is revoked the desktop is signed out (login screen, not the app)", sess.authenticated === false && (await h.win.locator('input[type="password"]').count()) >= 0 && !/Start Scanner/i.test(await text(h)), sess);
    L.check("[E] signing out did not delete the local data", fs.existsSync(L.path.join(localFolder, "scout.db")) && L.sha(L.path.join(localFolder, "scout.db")) === dbHashBefore);
    L.check("[*] no renderer errors / unhandled exceptions", h.rendererErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0 && noisy(h).length === 0, { r: h.rendererErrors.slice(0, 3), m: noisy(h).slice(0, 3) });
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    if (h) console.log("MAIN OUTPUT (tail):", h.mainOut.join("").slice(-2000));
  } finally {
    if (h) await L.closeApp(h);
    L.killSandboxProcesses(sb);
    stopServer();
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
