// T27 (Beta 7): the PACKAGED app opens a COPY of a real, older Database (no research columns), twice, and nothing already in it changes.
//   env: DB_COPY=<path to a copy of an older scout.db>   (default: the copy made for the Phase 13 analysis)
//        EXE=<path to Clynx.exe>                        (default: dist-b7\win-unpacked\Clynx.exe)
// Everything happens in a throw-away profile; the original database is never opened. No server is contacted except what the app does by itself.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const PROJECT = path.resolve(__dirname, "..", "..");
const { _electron } = require(path.join(PROJECT, "node_modules", "playwright"));

const EXE = process.env.EXE || path.join(PROJECT, "dist-b7", "win-unpacked", "Clynx.exe");
const DB_COPY = process.env.DB_COPY || "C:/Users/biggt/AppData/Local/Temp/claude/C--Users-biggt-OneDrive-Documents-Claude-Sessions-fb-marketplace-scout/8933f2fd-7ac1-4f5d-b693-08c739583a05/scratchpad/snap/b.db";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n        " + JSON.stringify(detail).slice(0, 400) : "")); } };

const STABLE = {
  listings: "id, title, price, url, matched_item, reasoning, is_deal, first_seen_at",
  products: "id, name, category, family, ai_summary, created_at",
  blacklist_terms: "id, term",
  watches: "id, name",
};
function snapshot(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  const out = { integrity: d.prepare("PRAGMA integrity_check").get().integrity_check, tables: {} };
  for (const [t, cols] of Object.entries(STABLE)) {
    const rows = d.prepare(`SELECT ${cols} FROM ${t} ORDER BY 1`).all();
    out.tables[t] = { n: rows.length, hash: crypto.createHash("sha256").update(JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? String(v) : v))).digest("hex").slice(0, 16) };
  }
  out.researchColumns = d.prepare("PRAGMA table_info(listings)").all().map((c) => c.name).filter((c) => /^research_/.test(c));
  d.close();
  return out;
}
async function launch(userData) {
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: path.dirname(EXE), env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 90000 });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}
async function quit(h) {
  const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  await Promise.race([exited, sleep(25000)]);
}

(async () => {
  check("(setup) the app under test is a PACKAGED build", fs.existsSync(path.join(path.dirname(EXE), "resources", "app.asar")), EXE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t27-"));
  const userData = path.join(root, "profile");
  const dbDir = path.join(userData, "data", "users", "local-beta");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, "scout.db");
  fs.copyFileSync(DB_COPY, dbFile);
  fs.writeFileSync(path.join(userData, "app-settings.json"), JSON.stringify({ localMode: true }));
  const before = snapshot(dbFile);
  check("(setup) the copy is an older database: it has no research columns", before.researchColumns.length === 0, before.researchColumns);
  console.log("  before:", JSON.stringify(Object.fromEntries(Object.entries(before.tables).map(([k, v]) => [k, v.n]))));

  for (const run of [1, 2]) {
    const h = await launch(userData);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 90000 });
    check(`[run ${run}] the packaged app opens the older database and shows its main screen`, true);
    await sleep(5000);
    await quit(h);
    const after = snapshot(dbFile);
    check(`[run ${run}] the database passes SQLite's integrity check`, after.integrity === "ok", after.integrity);
    check(`[run ${run}] the three research columns were added`, ["research_status", "research_code", "research_reason"].every((c) => after.researchColumns.includes(c)), after.researchColumns);
    for (const t of Object.keys(STABLE)) check(`[run ${run}] ${t}: same rows, nothing changed (${before.tables[t].n})`, after.tables[t].n === before.tables[t].n && after.tables[t].hash === before.tables[t].hash, { before: before.tables[t], after: after.tables[t] });
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("T27 FAILED", e && e.stack || e); process.exit(1); });
