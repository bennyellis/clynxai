// Isolated integration harness for the real Clynx Electron app. NOTHING here touches the real user's data:
//  - the app is copied (out/ + package.json) into a throwaway folder, so app.getAppPath() (= baseDir of an unpackaged app) is that folder;
//  - Electron is started with --user-data-dir pointing into the same throwaway folder;
//  - node_modules is a directory junction to the project's (read only use);
//  - the cloud server is a fake one on 127.0.0.1 (never the user's real server on 8787);
//  - the working directory is the throwaway folder, so no .env (no API keys) is picked up.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execSync, spawnSync } = require("node:child_process");

const PROJECT = "C:/Users/biggt/OneDrive/Documents/Claude/Sessions/fb-marketplace-scout";
const REAL_DB_DIR = path.join(PROJECT, "data");
const { _electron } = require(path.join(PROJECT, "node_modules", "playwright"));
const electronExe = require(path.join(PROJECT, "node_modules", "electron"));

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSandbox(name, appSource = PROJECT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clynx-integ-${name}-`));
  const appDir = path.join(root, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(appSource, "out"), path.join(appDir, "out"), { recursive: true });
  fs.copyFileSync(path.join(appSource, "package.json"), path.join(appDir, "package.json"));
  fs.symlinkSync(path.join(PROJECT, "node_modules"), path.join(appDir, "node_modules"), "junction");
  const userData = path.join(root, "userdata");
  fs.mkdirSync(userData, { recursive: true });
  return { root, appDir, userData, name };
}
function writeAppSettings(sb, cloudUrl) {
  fs.writeFileSync(path.join(sb.appDir, "app-settings.json"), JSON.stringify({ cloudApiUrl: cloudUrl }));
}
// Per-user folder of the (single) user in this sandbox.
function userFolder(sb) {
  const usersDir = path.join(sb.appDir, "data", "users");
  const ids = fs.existsSync(usersDir) ? fs.readdirSync(usersDir) : [];
  return ids.length ? path.join(usersDir, ids[0]) : null;
}

// A stand-in for the Clynx Cloud server. Records every request. mode.refresh: "ok" | "reject" | "down".
function startFakeCloud(port, extra) {
  const requests = [];
  const mode = { refresh: "ok" };
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (extra && extra(req, send, body)) return;
      const tokens = () => ({ accessToken: "at-" + ++n, refreshToken: "rt-" + n, userId: "test-user-1", email: "tester@example.test" });
      if (req.url === "/health") return send(200, { ok: true });
      if (req.url === "/auth/login" || req.url === "/auth/register") return send(200, tokens());
      if (req.url === "/auth/refresh") {
        if (mode.refresh === "down") { req.socket.destroy(); return; }
        if (mode.refresh === "reject") return send(401, { error: "Invalid refresh token" });
        return send(200, tokens());
      }
      if (req.url === "/devices/register") return send(200, { id: "test-device-1" });
      if (/^\/(watches|feedback|products|listings)/.test(req.url) || /\/heartbeat/.test(req.url)) return send(200, { watches: [], feedback: [], products: [], listings: [], accepted: 0, cursor: null });
      return send(200, {});
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, requests, mode, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })));
}

// Launches the real app. Collects everything it prints and every renderer error.
async function launch(sb, { env = {} } = {}) {
  const t0 = Date.now();
  const mainOut = [];
  const app = await _electron.launch({
    executablePath: electronExe,
    args: [sb.appDir, `--user-data-dir=${sb.userData}`],
    cwd: sb.root,
    env: { ...process.env, OPENAI_API_KEY: "", ...env },
    timeout: 60000,
  });
  app.process().stdout?.on("data", (d) => mainOut.push(String(d)));
  app.process().stderr?.on("data", (d) => mainOut.push(String(d)));
  const win = await app.firstWindow();
  const tWindow = Date.now() - t0;
  const rendererErrors = [];
  win.on("pageerror", (e) => rendererErrors.push("pageerror: " + e.message));
  win.on("console", (m) => { if (m.type() === "error") rendererErrors.push("console.error: " + m.text()); });
  await win.waitForLoadState("domcontentloaded");
  return { app, win, mainOut, rendererErrors, tWindow, t0 };
}

// Closes the app the way a user would. Clynx asks before closing a window that has unsaved Config edits ("Unsaved Config changes" - Save, Cancel or Discard & close), and
// app.close() waits for that answer, so a suite that leaves an edit unsaved used to hang here. Answer it with "Discard & close", as a user who just wants out would.
async function closeApp(h) {
  const closing = (async () => { try { await h.app.close(); } catch { /* already gone */ } })();
  let done = false;
  closing.then(() => { done = true; });
  for (let i = 0; i < 20 && !done; i++) {
    await sleep(250);
    try {
      const win = h.win;
      if (win && !win.isClosed()) {
        const btn = win.getByRole("button", { name: /discard & close/i });
        if (await btn.count()) { await btn.first().click({ timeout: 1000 }); }
      }
    } catch { /* the window is going away */ }
  }
  await Promise.race([closing, sleep(15000)]);
  await sleep(500);
}

// Kills any Electron started from inside this sandbox that the harness no longer controls (a relaunched instance).
function killSandboxProcesses(sb) {
  try {
    const needle = sb.root.replace(/\\/g, "\\\\").replace(/'/g, "''");
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(sb.root)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" });
  } catch { /* nothing to kill */ }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "   " + JSON.stringify(detail).slice(0, 500) : ""));
}
function note(name, text) { results.push({ name, ok: null, detail: text }); console.log("NOTE " + name + ": " + text); }

module.exports = { PROJECT, REAL_DB_DIR, fs, path, os, sha, sleep, makeSandbox, writeAppSettings, userFolder, startFakeCloud, launch, closeApp, killSandboxProcesses, check, note, results, execSync, spawnSync };
