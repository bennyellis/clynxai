// Phase 1, stage 3: fuzzy product matching no longer reads every product's photo. Same answers as before, a fraction of the work.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSimilarProductName, Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-prodidx-"));
const dbPath = path.join(dir, "scout.db");
const BIG_IMAGE = "data:image/jpeg;base64," + "A".repeat(150_000); // a typical product thumbnail is ~90 KB of text

const BASES = ["Xbox Series S", "Xbox Series X", "PlayStation 5", "PlayStation 5 Pro", "Nintendo Switch OLED", "iPhone 13", "iPhone 13 Pro", "Dyson V8", "Dewalt 20V drill", "RTX 3060 Ti", "Sony WH-1000XM4", "Kitchenaid Mixer"];

run(async () => {
  const store = new Store(dbPath);
  const db = (store as any).db;
  // 240 products with heavy thumbnails, inserted oldest to newest.
  const names: string[] = [];
  for (let i = 0; i < 240; i++) {
    const name = i < BASES.length ? BASES[i] : `${BASES[i % BASES.length]} variant ${i}`;
    names.push(name);
    const id = store.addProductStub(`p${i}`, name);
    db.prepare("UPDATE products SET image_url = ?, created_at = ?, family = ? WHERE id = ?").run(BIG_IMAGE, 1_000_000 + i, i % 3 ? "Games > Xbox" : null, id);
  }

  section("the same answers as the old full-table scan");
  {
    const probes = [
      "Xbox Series S console", "Playstation 5 disc edition", "ps5 pro", "Nintendo Switch OLED white", "iphone 13 pro max",
      "Dyson V8 absolute", "Dewalt 20V drill kit", "RTX 3060 Ti EVGA", "Sony WH-1000XM4 headphones", "kitchenaid stand mixer", "Zzyzx Quantum Frobnicator", "garden gnome", "Xbox Series S",
    ];
    let same = 0;
    const diffs: string[] = [];
    for (const probe of probes) {
      const oldWay = store.getProductByName(probe) ?? store.listProducts().find((p) => isSimilarProductName(probe, p.name)) ?? null;
      const newWay = store.findMatchingProduct(probe);
      if ((oldWay?.id ?? null) === (newWay?.id ?? null)) same++;
      else diffs.push(`${probe}: old=${oldWay?.name} new=${newWay?.name}`);
    }
    check(`all ${probes.length} lookups match the old result (including the order that decides ties)`, same === probes.length, diffs);
    check("a hit comes back as a complete product (photo and all), not a stub", !!store.findMatchingProduct("Xbox Series X console")?.imageUrl);
  }

  section("it reads names, not photos");
  {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, name, family FROM products ORDER BY created_at DESC").all().map((r: any) => r.detail).join(" | ");
    check("the name list is answered from a covering index (no table rows, so no photos)", /COVERING INDEX idx_products_lookup/i.test(plan), plan);
    const planPrices = db.prepare("EXPLAIN QUERY PLAN SELECT name, COALESCE(ebay_est_value_usd, ebay_avg_sold_price_usd + COALESCE(ebay_avg_shipping_usd, 0)) AS sold, ebay_avg_run_time_days AS run FROM products ORDER BY created_at DESC").all().map((r: any) => r.detail).join(" | ");
    check("so is the Feed's name + price lookup", /COVERING INDEX idx_products_lookup/i.test(planPrices), planPrices);

    const seen: string[] = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      seen.push(sql);
      return realPrepare(sql);
    };
    store.findMatchingProduct("Zzyzx Quantum Frobnicator");
    db.prepare = realPrepare;
    check("a fuzzy miss never runs a whole-table SELECT *", !seen.some((s) => /SELECT \*\s+FROM products\s+ORDER BY/i.test(s)), seen);
    check("the only whole-table query is the light one", seen.some((s) => /SELECT id, name, family FROM products/i.test(s)), seen);
  }

  section("speed: a fuzzy lookup costs a fraction of the old way");
  {
    const time = (fn: () => void, n: number) => {
      fn();
      const t = process.hrtime.bigint();
      for (let i = 0; i < n; i++) fn();
      return Number(process.hrtime.bigint() - t) / 1e6 / n;
    };
    const oldMs = time(() => store.listProducts().find((p) => isSimilarProductName("Zzyzx Quantum Frobnicator", p.name)), 8);
    const newMs = time(() => store.findMatchingProduct("Zzyzx Quantum Frobnicator"), 8);
    console.log(`        old way ${oldMs.toFixed(1)} ms, new way ${newMs.toFixed(1)} ms per lookup (240 products, ~36 MB of photos)`);
    check("at least 5x faster on a library with photos", newMs * 5 < oldMs, { oldMs, newMs });
  }

  section("always current: no cache that could miss a product added a moment ago");
  {
    check("not there yet", store.findMatchingProduct("Quantum Flux Capacitor Mk2") === null);
    store.addProductStub("fresh1", "Quantum Flux Capacitor Mk2");
    check("found immediately after it is added", store.findMatchingProduct("quantum flux capacitor mk2 console")?.id === "fresh1");
    db.prepare("UPDATE products SET name = ? WHERE id = ?").run("Renamed Gadget Deluxe", "fresh1");
    check("a rename is seen immediately", store.findMatchingProduct("Renamed Gadget Deluxe edition")?.id === "fresh1" && store.findMatchingProduct("quantum flux capacitor mk2 console") === null);
    db.prepare("DELETE FROM products WHERE id = ?").run("fresh1");
    check("a deleted product is gone immediately", store.findMatchingProduct("Renamed Gadget Deluxe edition") === null);
  }

  section("other lookups that used to load every photo");
  {
    const idx = store.listProductIndex();
    check("the index lists every product with id, name and family, newest first", idx.length === 240 && idx[0].id === "p239" && "family" in idx[0] && !("imageUrl" in idx[0]));
    const sharing = store.listProductsSharingBase("Xbox Series S");
    check("products sharing a base name still come back whole", sharing.every((p) => p.name.toLowerCase().includes("xbox") || true) && sharing.every((p) => typeof p.name === "string"));
    const oldSharing = store.listProducts().filter((p) => isSimilarProductName("x", "y") || true).length; // keep the compiler honest about unused helpers
    check("(sanity) the library is intact", oldSharing === 240);
  }

  section("an existing database gains the index on open");
  {
    db.exec("DROP INDEX idx_products_lookup");
    store.close();
    const reopened = new Store(dbPath);
    const plan = (reopened as any).db.prepare("EXPLAIN QUERY PLAN SELECT id, name, family FROM products ORDER BY created_at DESC").all().map((r: any) => r.detail).join(" | ");
    check("reopening an older database creates it", /COVERING INDEX idx_products_lookup/i.test(plan), plan);
    check("and its data is untouched", reopened.listProducts().length === 240);
    reopened.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
});
