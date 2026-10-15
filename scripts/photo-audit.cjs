// Beta 12: report reference photos that look filed under the WRONG Database product, without changing anything.
//
//   node scripts\photo-audit.cjs "C:\path\to\scout.db" [--csv photos.csv]      (a COPY of your database is read; nothing is modified or deleted)
//   node scripts\photo-audit.cjs --selftest
//
// Uses only the words saved with each photo (its source title: an eBay title, a listing title) against the product it is filed under, with the same identity rules the app now
// applies before filing (photoIdentity.ts). A photo saved with no title (an image search result) cannot be judged from text: it is counted, not accused; the app's
// own picture-based gallery audit covers those. Suspects are LEADS for you to review; remove a photo yourself from the product's page if you agree.
const { buildSync } = require("esbuild");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-photo-audit-"));
const out = path.join(tmp, "audit.cjs");
const entry = path.join(tmp, "audit-entry.ts");
fs.writeFileSync(
  entry,
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from ${JSON.stringify(path.join(root, "src/main/store.ts"))};
import { judgeCandidateByText, titleFromLabel } from ${JSON.stringify(path.join(root, "src/main/photoIdentity.ts"))};

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const LABEL = /^(stock photo|image search|real-world photo|wikipedia)/i;

function selftest(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-photo-selftest-"));
  const p = path.join(dir, "scout.db");
  const s = new Store(p);
  const id = s.addProductStub("selftest-galaxy", "Xbox Series X Galaxy Black Edition");
  s.addProductImage(id, "data:image/jpeg;base64,AA==", "eBay listing photo — Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)");
  s.addProductImage(id, "data:image/jpeg;base64,AB==", "Stock photo — images.example.com");
  s.addProductImage(id, "data:image/jpeg;base64,AC==", "Xbox Series X 2TB Galaxy Black Special Edition Console");
  s.close();
  return p;
}

const given = args.find((a) => !a.startsWith("--") && a !== opt("--csv"));
const src = args.includes("--selftest") ? selftest() : given;
if (!src || !fs.existsSync(src)) { console.error("Give the path to scout.db, or --selftest."); process.exit(2); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-photo-copy-"));
const copy = path.join(work, "scout.db");
fs.copyFileSync(src, copy);
for (const ext of ["-wal", "-shm"]) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);
const db = new DatabaseSync(copy, { readOnly: true });
const rows = db.prepare("SELECT p.id AS pid, p.name AS name, i.id AS iid, i.source_title AS src, i.created_at AS at FROM product_images i JOIN products p ON p.id = i.product_id ORDER BY p.name, i.created_at").all() as any[];
let judged = 0, noText = 0, matched = 0;
const suspects: any[] = [];
for (const r of rows) {
  const raw = String(r.src ?? "").trim();
  const text = titleFromLabel(raw) ?? (raw && !LABEL.test(raw) ? raw : null);
  if (!text) { noText++; continue; }
  judged++;
  const v = judgeCandidateByText(r.name, text);
  if (v.status === "mismatch") suspects.push({ product: r.name, photoId: r.iid, source: raw.slice(0, 120), why: v.reasons[0] ?? "", savedAt: new Date(r.at).toISOString().slice(0, 16) });
  else matched++;
}
fs.writeFileSync(path.join(${JSON.stringify(root)}, "photo-audit-results.json"), JSON.stringify({ source: src, photos: rows.length, judgedByTitle: judged, noTitle: noText, suspects }, null, 2));
if (opt("--csv")) {
  const esc = (v: any) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  fs.writeFileSync(opt("--csv")!, ["product,photoId,source,why,savedAt", ...suspects.map((s) => [s.product, s.photoId, s.source, s.why, s.savedAt].map(esc).join(","))].join("\\\\n"));
}
console.log("Reference photos: " + rows.length + "   judged from their saved title: " + judged + "   saved with no title (cannot be judged from text): " + noText);
console.log("Suspected to be the WRONG product: " + suspects.length + (judged ? "  (" + Math.round((suspects.length / judged) * 100) + "% of the judged)" : ""));
for (const s of suspects.slice(0, 25)) console.log("  - " + s.product + "  <-  " + s.source + "\\n      " + s.why);
console.log("Nothing was changed or deleted. Details: photo-audit-results.json");
db.close();
`
);
buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"] });
const modules = path.join(root, "node_modules");
const r = require("node:child_process").spawnSync(process.execPath, ["--no-warnings", out, ...process.argv.slice(2)], { stdio: "inherit", cwd: root, env: { ...process.env, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) } });
process.exit(r.status ?? 1);
