// Phase 2.2 / 2.4 of the Beta 30 plan: the dry run ("N entries become M"), the merge that keeps the oldest entry, and the exact undo. Throwaway Database with the duplicates made by raw rows
// (the creation paths no longer make them), nothing of the owner's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { describePlan } from "../duplicateCleanup.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-cleanup-"));
  const store = new Store(path.join(dir, "scout.db"));
  const db = (store as any).db;
  let t = 1000;
  const raw = (id: string, name: string, category = "Video Games & Consoles") => db.prepare("INSERT INTO products (id, name, category, loading, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(id, name, category, t++, t);
  const photo = (id: string, productId: string) => db.prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at) VALUES (?, ?, 'data:image/png;base64,AA', 't', 1)").run(id, productId);
  const count = () => (db.prepare("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL").get() as { n: number }).n;

  raw("x1", "Xbox Series X");
  raw("x2", "Xbox Series X (1TB)");
  raw("x3", "Microsoft Xbox Series X 1TB Carbon Black");
  raw("s1", "Xbox Series S 512GB", "Video Games & Consoles");
  raw("s2", "Xbox Series S 1TB White");
  raw("s3", "Xbox Series S 1TB Black");
  raw("k1", "KitchenAid Artisan Empire Red", "Home & Garden");
  raw("k2", "KitchenAid Artisan Onyx Black", "Home & Garden");
  raw("k3", "KitchenAid Artisan Contour Silver", "Home & Garden");
  raw("kp", "KitchenAid Professional 600", "Home & Garden");
  raw("g1", "Xbox Series X", "Video Games");
  raw("u1", "Zorblax 3000");
  raw("u2", "Zorblax 3000 Deluxe");
  photo("i1", "x2"); photo("i2", "x3"); photo("i3", "k2");
  db.prepare("UPDATE products SET observed_notes = 'seen at 400' WHERE id = 'x2'").run();
  db.prepare("UPDATE products SET ai_summary = 'A console.' WHERE id = 'x3'").run();
  db.prepare("INSERT INTO listings (id, title, url, first_seen_at, product_id) VALUES ('l1', 'x', 'u', 1, 'x3')").run();
  db.prepare("INSERT INTO watches (id, name, search_phrase, match_keywords, linked_product_id, terms_json, created_at, updated_at) VALUES ('w1', 'w', 'p', 'k', 'x2', ?, 1, 1)").run(JSON.stringify([{ linkedProductId: "x2" }]));
  db.prepare("INSERT INTO products (id, name, loading, created_at, updated_at, parent_product_id) VALUES ('child', 'Xbox Series X Galaxy Edition', 0, 5000, 5000, 'x3')").run();
  const before = count();

  section("the dry run changes nothing and says what it would do");
  const plan = store.planDuplicateCleanup();
  const keptOf = (name: string) => plan.groups.find((g) => g.canonical === name);
  check("read-only: the entry count and the rows are untouched", count() === before && plan.before === before);
  check("'Xbox Series X' + '(1TB)' + the Microsoft Carbon Black name become one, keeping the oldest", keptOf("Xbox Series X (Black)")?.keep.id === "x1" && keptOf("Xbox Series X (Black)")?.fold.map((f) => f.id).sort().join() === "x2,x3", plan.groups);
  check("the three KitchenAid colours become one", keptOf("KitchenAid Artisan")?.keep.id === "k1" && keptOf("KitchenAid Artisan")?.fold.length === 2);
  check("the Professional mixer is not part of it", !plan.groups.some((g) => [g.keep.id, ...g.fold.map((f) => f.id)].includes("kp")));
  check("Series S 512GB, 1TB white and 1TB black stay three entries", !plan.groups.some((g) => [g.keep.id, ...g.fold.map((f) => f.id)].some((id) => ["s2", "s3"].includes(id))));
  check("a game and a console with the same name are left alone, and the report says so", plan.skipped.some((s) => s.names.includes("Xbox Series X") && /categor/.test(s.why)) && !plan.groups.some((g) => g.fold.some((f) => f.id === "g1")), plan.skipped);
  check("names that only share words stay for the Needs review list", !plan.groups.some((g) => [g.keep.id, ...g.fold.map((f) => f.id)].includes("u2")));
  check("a parent and its own child never merge", !plan.groups.some((g) => [g.keep.id, ...g.fold.map((f) => f.id)].includes("child")));
  check("the report reads 'N entries would become M' and says nothing was changed", /entries would become/.test(describePlan(plan)) && /Nothing has been changed/.test(describePlan(plan)) && plan.after === before - 4, describePlan(plan));

  section("the merge keeps the oldest and moves everything onto it");
  const batch = "batch1";
  const merged = new Map<string, string>();
  for (const g of plan.groups) for (const [k, v] of store.mergeEntriesWithUndo(g, batch)) merged.set(k, v);
  check("the folded entries are gone, the kept ones remain", count() === plan.after && !db.prepare("SELECT 1 FROM products WHERE id IN ('x2','x3','k2','k3')").get() && !!db.prepare("SELECT 1 FROM products WHERE id = 'x1'").get());
  check("photos, the listing, the Watch and its terms, and the child moved to the kept entry", (db.prepare("SELECT COUNT(*) n FROM product_images WHERE product_id = 'x1'").get() as any).n === 2 && (db.prepare("SELECT COUNT(*) n FROM product_images WHERE product_id = 'k1'").get() as any).n === 1 && (db.prepare("SELECT product_id FROM listings WHERE id = 'l1'").get() as any).product_id === "x1" && (db.prepare("SELECT linked_product_id, terms_json FROM watches WHERE id = 'w1'").get() as any).linked_product_id === "x1" && (db.prepare("SELECT parent_product_id FROM products WHERE id = 'child'").get() as any).parent_product_id === "x1");
  const kept = store.getProductById("x1")!;
  check("notes and the summary were filled in from the folded entries", /seen at 400/.test(kept.observedNotes ?? "") && kept.aiSummary === "A console.");
  check("the other names are kept as aliases, so old names still find it", store.findMatchingProduct("Microsoft Xbox Series X 1TB Carbon Black")?.id === "x1" && store.listProductAliases("x1").some((a) => a.alias === "Xbox Series X (1TB)"));
  check("the cloud delete is queued only now, for the folded entries", store.listPendingCloudDeletes?.("product")?.includes?.("x2") ?? (db.prepare("SELECT 1 FROM pending_cloud_deletes WHERE resource_type = 'product' AND local_id = 'x2'").get() !== undefined));
  check("the run shows up as one undoable batch", store.listMergeBatches().length === 1 && store.listMergeBatches()[0].folded === 4 && !store.listMergeBatches()[0].undone);

  section("undo puts everything back exactly");
  check("undoing returns every folded entry", store.undoMergeBatch(batch) === 4 && count() === before);
  const row = (id: string) => db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  check("the folded entries are back with their own notes and summary", row("x2")?.observed_notes === "seen at 400" && row("x3")?.ai_summary === "A console." && row("x2")?.name === "Xbox Series X (1TB)");
  check("the kept entry has its own columns again", row("x1")?.ai_summary == null && row("x1")?.observed_notes == null);
  check("photos, listing, Watch, terms and child are back where they were", (db.prepare("SELECT product_id FROM product_images WHERE id = 'i1'").get() as any).product_id === "x2" && (db.prepare("SELECT product_id FROM product_images WHERE id = 'i3'").get() as any).product_id === "k2" && (db.prepare("SELECT product_id FROM listings WHERE id = 'l1'").get() as any).product_id === "x3" && (db.prepare("SELECT linked_product_id, terms_json FROM watches WHERE id = 'w1'").get() as any).linked_product_id === "x2" && (db.prepare("SELECT parent_product_id FROM products WHERE id = 'child'").get() as any).parent_product_id === "x3" && JSON.parse((db.prepare("SELECT terms_json FROM watches WHERE id = 'w1'").get() as any).terms_json)[0].linkedProductId === "x2");
  check("the aliases the merge added are gone, and the queued cloud deletes are cancelled", store.listProductAliases("x1").length === 0 && !db.prepare("SELECT 1 FROM pending_cloud_deletes WHERE resource_type = 'product' AND local_id IN ('x2','x3','k2','k3')").get());
  check("the batch cannot be undone twice", store.undoMergeBatch(batch) === 0 && store.listMergeBatches()[0].undone === true);
  check("and the plan is the same again (nothing was lost)", store.planDuplicateCleanup().fingerprint === plan.fingerprint);

  section("a failed merge changes nothing");
  const g0 = plan.groups[0];
  let threw = false;
  const g1 = plan.groups[1];
  try {
    store.mergeEntriesWithUndo({ keep: g0.keep, fold: g0.fold }, "bad");
    db.exec("DROP TABLE merge_undo");
    store.mergeEntriesWithUndo({ keep: g1.keep, fold: g1.fold }, "bad2");
  } catch {
    threw = true;
  }
  check("the second merge threw (its undo record could not be written) and its entries are all still there", threw && count() >= before - g0.fold.length && !!db.prepare("SELECT 1 FROM products WHERE id = ?").get(g1.fold[0].id));
  check("nothing was queued for the cloud by the failed one", !db.prepare("SELECT 1 FROM pending_cloud_deletes WHERE local_id = ?").get(g1.fold[0].id));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
