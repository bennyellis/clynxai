// Phase 3 stage 3: the library is no longer read in full at startup. The photo counts and blank-entry lookups answer from small indexes and
// never read the photos; results are identical to the old full scans.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-startupq-"));
const dbPath = path.join(dir, "scout.db");
const BIG = "data:image/jpeg;base64," + "A".repeat(110_000);

run(() => {
  const store = new Store(dbPath);
  const db = (store as any).db;
  for (let i = 0; i < 200; i++) {
    store.addProductStub(`p${i}`, `Product number ${i}`);
    // 1 in 4 has no thumbnail (null), a few have an empty string, the rest a big one
    const thumb = i % 4 === 0 ? null : i % 37 === 0 ? "" : BIG + i;
    db.prepare("UPDATE products SET image_url = ?, loading = 0 WHERE id = ?").run(thumb, `p${i}`);
    const normals = i % 6; // 0..5 reference photos
    for (let k = 0; k < normals; k++) db.prepare("INSERT INTO product_images (id, product_id, image_data, created_at, kind) VALUES (?,?,?,?, 'normal')").run(`i${i}-${k}`, `p${i}`, BIG + k, 1);
    if (i % 5 === 0) db.prepare("INSERT INTO product_images (id, product_id, image_data, created_at, kind) VALUES (?,?,?,?, 'poor_condition')").run(`x${i}`, `p${i}`, BIG, 1);
  }

  section("photo counts: same answer, from an index that does not touch the photos");
  {
    const counts = store.countNormalImagesByProduct();
    const old = new Map((db.prepare("SELECT product_id, COUNT(*) AS n FROM product_images WHERE kind = 'normal' GROUP BY product_id").all() as any[]).map((r) => [r.product_id, r.n]));
    check("counts equal the plain grouped query", counts.size === old.size && [...counts].every(([k, v]) => old.get(k) === v));
    check("poor-condition photos are not counted", counts.get("p0") === undefined && !counts.has("p0"), counts.get("p0"));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT product_id, COUNT(*) as n FROM product_images WHERE kind = 'normal' GROUP BY product_id").all().map((r: any) => r.detail).join(" | ");
    check("the query is answered from idx_product_images_kind (a covering index)", /idx_product_images_kind/.test(plan) && /COVERING/i.test(plan), plan);
    const time = (fn: () => void, n: number) => { fn(); const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(); return Number(process.hrtime.bigint() - t) / 1e6 / n; };
    const withIndex = time(() => store.countNormalImagesByProduct(), 10);
    db.exec("DROP INDEX idx_product_images_kind");
    const without = time(() => store.countNormalImagesByProduct(), 10);
    db.exec("CREATE INDEX idx_product_images_kind ON product_images(product_id, kind)");
    console.log(`        ~${(200 * 5 * 0.11).toFixed(0)} MB of photos: ${without.toFixed(1)} ms without the index, ${withIndex.toFixed(1)} ms with it`);
    check("at least 5x faster with the index", withIndex * 5 < without, { withIndex, without });
  }

  section("entries without a thumbnail: same set, no photos read for the others");
  {
    const blanks = store.listBlankProductIndex();
    const old = store.listProducts().filter((p) => !p.imageUrl).map((p) => p.id).sort();
    check("the same entries as filtering the full library", blanks.map((b) => b.id).sort().join() === old.join() && blanks.length > 40, blanks.length);
    check("each is just an id and a name", blanks.every((b) => Object.keys(b).sort().join() === "id,name"));
    check("an entry with an empty-string thumbnail counts as blank, as before", blanks.some((b) => b.id === "p37"));
  }

  section("the light product list");
  {
    const idx = store.listProductIndex();
    check("every product, id/name/family only, no image field", idx.length === 200 && idx.every((p) => !("imageUrl" in p) && !("image_url" in p)));
    const json = JSON.stringify(idx).length;
    check("a few KB instead of tens of MB (200 products with ~110 KB thumbnails)", json < 20_000 && JSON.stringify(store.listProducts()).length > 10_000_000, json);
  }

  section("an existing database gains the index on open and keeps its data");
  {
    db.exec("DROP INDEX idx_product_images_kind");
    store.close();
    const again = new Store(dbPath);
    const plan = (again as any).db.prepare("EXPLAIN QUERY PLAN SELECT product_id, COUNT(*) as n FROM product_images WHERE kind = 'normal' GROUP BY product_id").all().map((r: any) => r.detail).join(" | ");
    check("the index is back", /idx_product_images_kind/.test(plan), plan);
    check("all products and photos are still there", again.listProductIndex().length === 200 && again.countNormalImagesByProduct().size > 100);
    again.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
