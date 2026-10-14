// T17: the app as INSTALLED by Clynx-Beta-Setup (not the dev layout). Run with INSTALLED_EXE and EXPECT_COMMIT. Uses a throwaway --user-data-dir (never %APPDATA%\Clynx), a fake cloud
// server that must receive no request, and opens a real Chrome/Edge window on facebook.com WITHOUT logging in, to prove the packaged Playwright + stealth stack can launch a browser.
const L = require("./lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const EXE = process.env.INSTALLED_EXE;
const COMMIT = process.env.EXPECT_COMMIT || "";
const installDir = path.dirname(EXE);
const text = (win) => win.evaluate(() => document.body.innerText);
const clickText = (win, re) => win.evaluate((src) => { const r = new RegExp(src, "i"); const b = [...document.querySelectorAll("button")].find((x) => r.test(x.textContent.trim())); if (b) b.click(); return !!b; }, re.source);
const FAKE_KEY = "sk-test-" + "Zy9X8w7V6u5T4s3R2q1P0o9N";

// CLEAN_PATH: run the installed app the way a tester's computer would be - no Node.js, npm, git or developer tools on PATH.
function cleanEnv() {
  const env = { ...process.env, OPENAI_API_KEY: "" };
  if (process.env.CLEAN_PATH) {
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
    env.Path = process.env.CLEAN_PATH;
    for (const k of Object.keys(env)) if (/^(npm_|NODE_|PLAYWRIGHT_)/i.test(k)) delete env[k];
  }
  return env;
}
async function launch(userData, root, out) {
  // cwd = the install folder, exactly like the shortcut's "Start in"
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: installDir, env: cleanEnv(), timeout: 60000 });
  app.process().stdout?.on("data", (d) => out.push(String(d)));
  app.process().stderr?.on("data", (d) => out.push(String(d)));
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  return { app, win, errors };
}
async function quit(h) {
  const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  return Promise.race([exited, L.sleep(20000).then(() => false)]);
}
const procsFor = (needle) => {
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object -ExpandProperty Name"`, { encoding: "utf8" });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-integ-t17-"));
  const userData = path.join(root, "userdata");
  fs.mkdirSync(userData, { recursive: true });
  const cloud = await L.startFakeCloud(18787);
  fs.writeFileSync(path.join(userData, "app-settings.json"), JSON.stringify({ cloudApiUrl: cloud.url }));
  const out = [];
  let h;
  try {
    h = await launch(userData, root, out);
    await h.win.waitForSelector('[data-testid="beta-welcome"]', { timeout: 40000 });
    const welcome = await text(h.win);
    L.check("[1] the installed app opens on the beta welcome screen with its version", /BETA 0\.3\.0-beta\.2/.test(welcome), welcome.slice(0, 160));
    const info = await h.app.evaluate(({ app: a }) => ({ packaged: a.isPackaged, appPath: a.getAppPath(), version: a.getVersion() }));
    L.check("[1] it is the installed build running from app.asar", info.packaged && /app\.asar$/.test(info.appPath) && info.version === "0.3.0-beta.2", info);
    await h.win.click('[data-testid="start-local"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
    L.check("[2] Start Clynx reaches the Dashboard", true);
    const dbFile = path.join(userData, "data", "users", "local-beta", "scout.db");
    L.check("[2] a fresh Database was created in the user-data folder (not in the install folder)", fs.existsSync(dbFile) && !fs.existsSync(path.join(installDir, "data")), fs.readdirSync(userData));
    L.check("[2] the Database starts empty and identity enforcement / Review Apply are off", (await h.win.evaluate(() => window.api.listProducts())).length === 0 && (await h.win.evaluate(() => window.api.getConfig())).databaseReview?.apply !== true);
    await L.sleep(2500);
    L.check("[2] no request reached the (fake) cloud server", cloud.requests.length === 0, cloud.requests);

    // Config > Account
    await clickText(h.win, /^Config$/);
    await L.sleep(500);
    await clickText(h.win, /^account$/);
    await h.win.waitForSelector('[data-testid="about-block"]', { timeout: 15000 });
    const body = await text(h.win);
    L.check("[3] About shows this build's version and git commit", /Clynx 0\.3\.0-beta\.2/.test(body) && (!COMMIT || body.includes(`Build ${COMMIT}`)), body.match(/Build [0-9a-f]+/)?.[0]);
    L.check("[3] the browser check finds a browser on this computer", (await h.win.locator('[data-testid="browser-ok"]').count()) === 1, await h.win.locator('[data-testid="browser-block"]').innerText());
    await h.win.fill('[data-testid="openai-key"]', FAKE_KEY);
    await h.win.click('[data-testid="openai-save"]');
    await L.sleep(700);
    L.check("[3] a key typed by the tester is saved in the user-data folder only", fs.readFileSync(path.join(userData, ".env"), "utf-8").includes(FAKE_KEY) && !fs.existsSync(path.join(installDir, ".env")));

    // the packaged Playwright + stealth stack can open the tester's browser
    const profileNeedle = path.basename(root);
    await h.win.evaluate(() => { window.__logs = []; window.api.onLog((l) => window.__logs.push(l.message)); });
    const loginPromise = h.win.evaluate(() => window.api.login("default")).catch(() => null);
    let browserProcs = [];
    for (let i = 0; i < 40 && browserProcs.length === 0; i++) {
      await L.sleep(1000);
      browserProcs = procsFor(profileNeedle).filter((n) => /chrome|msedge/i.test(n));
    }
    L.check("[4] 'Log in to Facebook' opens a real Chrome/Edge window from the installed app", browserProcs.length > 0, browserProcs);
    const launched = out.join("").match(/\[browser\] Launched via ([^.\n]+)\./)?.[1];
    L.check("[4] the app reports which browser it used", !!launched, launched);
    await L.sleep(4000);
    const logs = await h.win.evaluate(() => window.__logs);
    L.check("[4] the Activity log says the Facebook window opened and what to do", logs.some((m) => /Facebook window opened/.test(m)), logs.slice(-3));
    // close the browser window we opened (never logged in)
    try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profileNeedle}*' -and $_.Name -match 'chrome|msedge' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" }); } catch {}
    await L.sleep(1500);
    void loginPromise;

    // a backup and a support report from the installed app
    await h.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, path.join(root, "report.txt"));
    const rep = await h.win.evaluate(() => window.api.support.saveReport());
    const reportText = fs.existsSync(path.join(root, "report.txt")) ? fs.readFileSync(path.join(root, "report.txt"), "utf-8") : "";
    L.check("[5] the support report works and holds no key, user name or cookie", rep.ok && !reportText.includes(FAKE_KEY) && !new RegExp(os.userInfo().username, "i").test(reportText) && !/cookie/i.test(reportText.replace(/cookies? are NOT/i, "")), rep);
    const bk = await h.win.evaluate(() => window.api.backups.backupNow());
    L.check("[5] 'Back up now' writes a verified backup from the installed app", bk.ok === true && fs.readdirSync(path.join(userData, "data", "users", "local-beta", "backups")).some((f) => /^clynx-\d{8}-\d{6}\.db$/.test(f)), bk);
    await h.win.evaluate((c) => window.api.saveConfig({ ...c, minProfitMarginPercent: 41 }), await h.win.evaluate(() => window.api.getConfig()));

    // close, reopen
    const closed = await quit(h);
    L.check("[6] closing the window quits the app", closed === true);
    h = null;
    await L.sleep(1500);
    L.check("[6] no Clynx process is left running from this install", procsFor("clynx-integ-t17").filter((n) => /Clynx/i.test(n)).length === 0, procsFor("clynx-integ-t17"));
    h = await launch(userData, root, out);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
    L.check("[7] reopening goes straight into the app", (await h.win.locator('[data-testid="beta-welcome"]').count()) === 0);
    L.check("[7] the setting, the key and the Database persisted", (await h.win.evaluate(() => window.api.getConfig())).minProfitMarginPercent === 41 && (await h.win.evaluate(() => window.api.beta.info())).hasOpenAIKey === true && fs.existsSync(dbFile));
    L.check("[*] no page errors", h.errors.length === 0, h.errors.slice(0, 3));
    L.check("[*] no uncaught errors in the app's output", out.join("").split("\n").filter((l) => /uncaught|TypeError|ReferenceError|Cannot find module/i.test(l)).length === 0);
    await quit(h);
    h = null;
    fs.writeFileSync(path.join(root, "state.txt"), userData);
    console.log("USER_DATA=" + userData);
    console.log("BAD LINES:", out.join("").split(String.fromCharCode(10)).filter((l) => /uncaught|TypeError|ReferenceError|Cannot find module/i.test(l)).slice(0, 5).join(" || "));
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    console.log("MAIN OUTPUT (tail):", out.join("").slice(-1200));
  } finally {
    if (h) { try { await h.app.close(); } catch {} }
    await cloud.close();
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
