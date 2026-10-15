// Beta 13 audit — DIAGNOSTIC probe #2: real Store (throw-away SQLite file in the OS temp dir), scripted data, no network, no AI. Prints what filing / merging / gallery code does today.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, isSimilarProductName } from "../../src/main/store.js";
import { listingMayFeedProduct, judgeCandidateByText } from "../../src/main/photoIdentity.js";
import { cleanFilingName } from "../../src/main/research.js";

const line = (s = "") => console.log(s);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b13-store-"));
const store = new Store(path.join(dir, "scout.db"));
const PIX = "data:image/png;base64,iVBORw0KGgo=";
let n = 0;
const mk = (name: string, family: string | null = "Xbox", category = "Video Games & Consoles") => {
  const id = "p" + ++n;
  const real = store.addProductStub(id, name);
  store.updateProductProfile(real, { aiSummary: `${name} summary`, category, family, imageUrl: null });
  return real;
};

line("== 1. Which existing entry does findMatchingProduct pick for a vision-named subject? (the scanner files under THIS)");
const sX = mk("Xbox Series X"), sS = mk("Xbox Series S"), sSb = mk("Xbox Series S (Black)"), sGen = mk("Xbox Series");
const sw = mk("Nintendo Switch", "Nintendo"), swLite = mk("Nintendo Switch Lite", "Nintendo");
const nameOf = (id: string | undefined) => (id ? store.getProductById(id)?.name : null) ?? null;
for (const subject of [
  "Xbox Series S (White)", "Xbox Series X (White)", "Xbox Series X Robot White", "Xbox Series X 1TB Carbon Black", "Xbox Series X Digital Edition",
  "Halo Infinite (Xbox Series X)", "Forza Horizon 5 Xbox Series X", "Xbox Series X Controller",
  "Metroid Dread (Nintendo Switch)", "Super Mario Odyssey Nintendo Switch", "Nintendo Switch Dock", "Nintendo Switch Joy-Con Pair", "Nintendo Switch Game Case", "Nintendo Switch OLED",
]) line(`  subject "${subject}" -> findMatchingProduct = ${nameOf(store.findMatchingProduct(subject)?.id)}`);
line("  isSimilarProductName pairs: " + [["Xbox Series", "Xbox Series S"], ["Xbox Series", "Xbox Series X"], ["Nintendo Switch", "Super Mario Odyssey Nintendo Switch"], ["Nintendo Switch", "Nintendo Switch Dock"], ["Nintendo Switch", "Metroid Dread Nintendo Switch"], ["Xbox Series X", "Xbox Series X Controller"]].map(([a, b]) => `${a}~${b}=${isSimilarProductName(a, b)}`).join(" | "));

line("\n== 2. What the vision-subject cleaner does with platform-named games / accessories (cleanFilingName)");
for (const raw of ["Xbox Series S", "Xbox Series X (front view)", "Metroid Dread (Nintendo Switch)", "Nintendo Switch Joy-Con", "Power Adapter", "Nintendo Switch Game Case", "Xbox Series X Robot White 1TB"]) {
  const v = cleanFilingName(raw);
  line(`  "${raw}" -> ${JSON.stringify(v)}`);
}

line("\n== 3. addProductImage has no identity check: a Series X photo (source title says Series X) goes into the Series S gallery");
const SRC = "MICROSOFT XBOX SERIES X - CONSOLE - 1TB - 1882 (G4P004519)";
store.addProductImage(sS, PIX, SRC);
line(`  accepted. Series S gallery source titles: ${JSON.stringify(store.listProductPhotoTitles(sS, 5))}`);
line(`  would the existing Beta 12 gate have refused it? listingMayFeedProduct("Xbox Series S", SRC) = ${listingMayFeedProduct("Xbox Series S", SRC)} (false = refuse). The write path never asks.`);
line(`  gate on the gallery audit's own move target: findMatchingProduct("Xbox Series S (White)") = ${nameOf(store.findMatchingProduct("Xbox Series S (White)")?.id)}; judge(title)=${judgeCandidateByText("Xbox Series S", SRC).status}`);

line("\n== 4. A gallery holds anything: game box + Metroid art + console photo filed under Nintendo Switch; nothing flags it");
for (const t of ["Nintendo Switch Console Neon Joy-Con", "Metroid Dread - Nintendo Switch (game case)", "Metroid Prime 4 Beyond key art", null]) store.addProductImage(sw, PIX, t);
line(`  Switch gallery: ${store.listProductImages(sw).length} images; titles: ${JSON.stringify(store.listProductPhotoTitles(sw, 10))}; untitled image present: ${store.listProductImages(sw).some((i) => i.sourceTitle === null)}`);
line("  kinds the gate would give those titles: " + ["Nintendo Switch Console Neon Joy-Con", "Metroid Dread - Nintendo Switch (game case)"].map((t) => `${t.slice(0, 22)}...=${judgeCandidateByText("Nintendo Switch", t).status}`).join(" | "));

line("\n== 5. Reference-photo selection: which image is 'the reference'? (scrapeEngine uses listProductImages(...)[0] and .slice(0,2))");
const sel = mk("Probe Camera Alpha", "Probe");
for (let i = 0; i < 3; i++) { store.addProductImage(sel, `data:image/png;base64,AAAA${i}`, `title ${i}`); }
line(`  order returned (index 0 first): ${JSON.stringify(store.listProductImages(sel).map((i) => i.sourceTitle))}  => the NEWEST photo is the representative ground truth.`);

line("\n== 6. Gallery cap prunes the OLDEST image, including a manually added/curated one");
const cap = mk("Probe Camera Beta", "Probe");
store.addProductImage(cap, "data:image/png;base64,MANUAL", null);
for (let i = 0; i < 20; i++) store.addProductImage(cap, `data:image/png;base64,AUTO${i}`, `auto ${i}`);
line(`  after 1 manual + 20 automatic: ${store.listProductImages(cap).length} images; the manual one survives = ${store.listProductImages(cap).some((i) => i.imageData.endsWith("MANUAL"))}`);

line("\n== 7. mergeDuplicateProducts moves whole galleries without re-checking them");
const dupA = mk("Probe Console One", "Probe"); const dupB = "dupB";
(store as any).db.prepare("INSERT INTO products (id, name, loading, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(dupB, "probe console one", Date.now(), Date.now());
store.addProductImage(dupA, PIX, "Probe Console One - console");
store.addProductImage(dupB, PIX, "Some Game Title (Probe Console One) disc");
const merged = store.mergeDuplicateProducts();
line(`  merged ${JSON.stringify([...merged])}; surviving gallery titles: ${JSON.stringify(store.listProductPhotoTitles([...merged.values()][0] ?? dupA, 5))}`);

line("\n== 8. deleteProduct is a hard delete (no soft delete / trash)");
const del = mk("Probe Delete Me", "Probe"); store.addProductImage(del, PIX, "x");
try { store.deleteProduct(del); line(`  deleted; product exists=${!!store.getProductById(del)}, images left=${store.listProductImages(del).length}`); }
catch (err) { line(`  deleteProduct THREW for a product that has a reference photo: ${(err as Error).message} (product still exists=${!!store.getProductById(del)}, images=${store.listProductImages(del).length})`); }
const del2 = mk("Probe Delete Me Too", "Probe");
try { store.deleteProduct(del2); line(`  a product with no photos deletes fine: exists=${!!store.getProductById(del2)}`); } catch (err) { line(`  threw: ${(err as Error).message}`); }

line("\n== 9. Folders are strings on products.family (no folder table)");
const rows = (store as any).db.prepare("SELECT name, category, family FROM products WHERE name LIKE 'Xbox%' OR name LIKE 'Nintendo%' ORDER BY name").all();
line("  " + JSON.stringify(rows));
line("  resolveFamilyName fuzzy segment merge: 'Xbox' ~ 'Xbox One'? -> " + store.resolveFamilyName("Xbox One > Games") + " ; 'Switch'~'Nintendo Switch' -> " + store.resolveFamilyName("Switch"));
fs.rmSync(dir, { recursive: true, force: true });
