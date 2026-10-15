// Beta 13 audit — READ-ONLY report on a COPY of your scout.db: how contaminated are the Library galleries, which entries would fuzzily collide, and which schema/build are you really on.
//   node scripts\beta13-audit.cjs library-db-audit "C:\path\to\scout.db"      (the file is copied to a temp folder first; the copy is opened read-only; nothing is modified)
//   node scripts\beta13-audit.cjs library-db-audit --selftest                  (builds a small synthetic database and reports on it)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, isSimilarProductName } from "../../src/main/store.js";
import { judgeCandidateByText, kindOfName } from "../../src/main/photoIdentity.js";

const args = process.argv.slice(2);
const line = (s = "") => console.log(s);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b13-dbaudit-"));
let source = args.find((a) => !a.startsWith("--"));
if (args.includes("--selftest")) {
  const s = new Store(path.join(tmp, "synthetic.db"));
  const mk = (id: string, name: string, family: string) => { s.addProductStub(id, name); s.updateProductProfile(id, { aiSummary: "x", category: "Video Games & Consoles", family, imageUrl: null }); };
  mk("a", "Xbox Series S", "Xbox"); mk("b", "Xbox Series", "Xbox"); mk("c", "Nintendo Switch", "Nintendo");
  s.addProductImage("a", "data:image/png;base64,AAAA", "MICROSOFT XBOX SERIES X - CONSOLE - 1TB - 1882 (G4P004519)");
  s.addProductImage("c", "data:image/png;base64,BBBB", "Metroid Dread - Nintendo Switch (game case)");
  s.addProductImage("c", "data:image/png;base64,CCCC", null);
  s.appendProductWatchNote("a", 'Correction: auto-removed a reference photo that actually showed "Xbox Series S (White)" — white console.');
  (s as any).db.close?.();
  source = path.join(tmp, "synthetic.db");
}
if (!source || !fs.existsSync(source)) { console.error("Give the path to a scout.db (or --selftest)."); process.exit(2); }
const copy = path.join(tmp, "copy.db");
fs.copyFileSync(source, copy);
for (const ext of ["-wal", "-shm"]) if (fs.existsSync(source + ext)) fs.copyFileSync(source + ext, copy + ext);
const db = new DatabaseSync(copy, { readOnly: true });
const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
const has = (t: string) => !!one("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", t);

line("== 1. Which build/schema is this database from?");
line(`  Beta 12 table listing_reeval present: ${has("listing_reeval")}   (false = this database was last opened by a build older than Beta 12)`);
line(`  schema_flags: ${has("schema_flags") ? JSON.stringify(all("SELECT name FROM schema_flags ORDER BY name").map((r) => r.name)) : "none"}`);
line(`  foreign keys declared on product_images: ${JSON.stringify(all("PRAGMA foreign_key_list(product_images)").map((r) => `${r.from}->${r.table}.${r.to}`))}   (non-empty = deleting a product that still has photos fails on this schema)`);
const productCols = all("PRAGMA table_info(products)").map((r) => r.name);
line(`  products columns: ${productCols.length}; has parent_product_id=${productCols.includes("parent_product_id")}, has family=${productCols.includes("family")}`);

const products = all("SELECT id, name, family, category, created_at, lookout_notes, image_url FROM products ORDER BY created_at DESC");
const images = all("SELECT id, product_id, source_title, kind, created_at, length(image_data) AS bytes FROM product_images");
line(`\n== 2. Size: ${products.length} products, ${images.length} reference images (${Math.round(images.reduce((a, i) => a + (i.bytes || 0), 0) / 1024 / 1024)} MB), ${images.filter((i) => !i.source_title).length} with NO source title (cannot be judged from text)`);
const per = new Map<string, number>(); for (const i of images) per.set(i.product_id, (per.get(i.product_id) ?? 0) + 1);
line(`  galleries of 20 (the cap; oldest photos get pruned past it): ${[...per.values()].filter((n) => n >= 20).length}; galleries under 3 or 10 photos (the gallery audit never runs below 3 for colour-named entries / 10 otherwise): ${[...per.values()].filter((n) => n < 10).length}`);

line("\n== 3. Photos whose OWN source title contradicts the product they are filed under (same rules as the Beta 12 gate)");
const byId = new Map(products.map((p) => [p.id, p]));
const contradictions: Array<{ product: string; title: string; rawProductCreated: number; why: string; at: number }> = [];
let weak = 0;
for (const i of images) {
  const p = byId.get(i.product_id); if (!p || !i.source_title || i.kind !== "normal") continue;
  const label = i.source_title.replace(/^eBay listing(?: photo)?\s*(?:—|-|:)\s*/i, "");
  const v = judgeCandidateByText(p.name, label);
  if (v.status === "mismatch") contradictions.push({ product: p.name, title: i.source_title, rawProductCreated: p.created_at, why: v.reasons[0] ?? "", at: i.created_at });
  else if (v.status === "insufficient") weak++;
}
line(`  ${contradictions.length} contradicting photos; ${weak} more are only weakly confirmed (title does not fully state the entry)`);
const grouped = new Map<string, number>(); for (const c of contradictions) grouped.set(c.product, (grouped.get(c.product) ?? 0) + 1);
for (const [name, n] of [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 15)) line(`    ${String(n).padStart(3)}  ${name}`);
for (const c of contradictions.slice(0, 25)) line(`      • [filed ${new Date(c.at).toISOString().slice(0, 16).replace("T", " ")}] "${c.product}"  <-  RAW LABEL "${c.title.slice(0, 110)}"  (entry created ${new Date(c.rawProductCreated).toISOString().slice(0, 16).replace("T", " ")} UTC)  [${c.why.slice(0, 60)}]`);

const buckets = new Map<string, number>(); for (const i of images) { const k = new Date(i.created_at).toISOString().slice(0, 15) + "0"; buckets.set(k, (buckets.get(k) ?? 0) + 1); }
line("\n== 3b. When photos were filed (UTC, 10-minute buckets, busiest first): " + JSON.stringify([...buckets].sort((a, b) => b[1] - a[1]).slice(0, 8)));
line("\n== 4. Moves made by the appearance-based gallery audit (it writes a note on the SOURCE product)");
for (const p of products) {
  for (const note of String(p.lookout_notes ?? "").split("\n---\n")) {
    const m = /auto-removed a reference photo that actually showed "([^"]+)"/.exec(note);
    if (m) line(`  "${p.name}" lost a photo to "${m[1]}"`);
  }
}

line("\n== 5. Entries that fuzzily match each other (findMatchingProduct returns the FIRST in newest-first order, not the best)");
let pairs = 0;
const cap = Math.min(products.length, 1500);
for (let a = 0; a < cap && pairs < 40; a++) for (let b = a + 1; b < cap && pairs < 40; b++) {
  if (isSimilarProductName(products[a].name, products[b].name)) { pairs++; line(`  "${products[a].name}"  ~  "${products[b].name}"   (a name like the first resolves to: ${products[a].name})`); }
}
if (!pairs) line("  none");

line("\n== 6. Library folders: strings on products.family");
const fam = new Map<string, number>(); for (const p of products) { const f = p.family ?? "(none)"; fam.set(f, (fam.get(f) ?? 0) + 1); }
line(`  ${fam.size} distinct paths; ${products.filter((p) => !p.family).length} products have no folder; paths: ${JSON.stringify([...fam].sort().slice(0, 40))}`);
const top = new Map<string, Set<string>>(); for (const f of fam.keys()) { const t = f.split(">")[0].trim(); const k = t.toLowerCase(); if (!top.has(k)) top.set(k, new Set()); top.get(k)!.add(t); }
line(`  top-level spellings that differ only by case: ${JSON.stringify([...top.values()].filter((s) => s.size > 1).map((s) => [...s]))}`);
const kinds = new Map<string, Set<string>>(); for (const p of products) { const f = (p.family ?? "").split(">")[0].trim(); if (!f) continue; if (!kinds.has(f)) kinds.set(f, new Set()); kinds.get(f)!.add(kindOfName(p.name)); }
line(`  kinds of thing per top-level folder (hardware/game/accessory): ${JSON.stringify([...kinds].map(([k, v]) => [k, [...v]]).slice(0, 15))}`);
line("\n(read-only: your original file was only copied; nothing was changed)");
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
