// Beta 13, WP0/WP1: feature flags, additive migrations on a Beta-12-shaped database (idempotent), the delete-order fix (audit LB-02), soft delete / Trash, protected photos under the cap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store.js";
import { beta13Flags, BETA13_DEFAULTS } from "../beta13.js";
import { check, run, section } from "./_testkit.js";

const PIX = (n: string) => `data:image/png;base64,${n}`;

run(() => {
  section("flags");
  check("defaults when missing", JSON.stringify(beta13Flags(undefined)) === JSON.stringify(BETA13_DEFAULTS));
  check("a valid mode is kept, an invalid one falls back", beta13Flags({ beta13: { identityGate: "shadow", resolver: "bogus" } }).identityGate === "shadow" && beta13Flags({ beta13: { resolver: "bogus" } }).resolver === BETA13_DEFAULTS.resolver);
  check("booleans are kept", beta13Flags({ beta13: { chatChoices: false } }).chatChoices === false);

  section("a Beta-12-shaped database migrates, twice, without losing anything");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b13-"));
  const file = path.join(dir, "scout.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, ai_summary TEXT, ai_summary_generated_at INTEGER, image_url TEXT, category TEXT NOT NULL DEFAULT 'Other', family TEXT, family_logo_url TEXT, loading INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, observed_notes TEXT, resale_price_usd REAL, resale_time_to_sell TEXT, lookout_notes TEXT, keep_thumbnail INTEGER NOT NULL DEFAULT 0, desired_price_usd REAL, hard_cap_at_desired_price INTEGER NOT NULL DEFAULT 0, prioritized INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE product_images (id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), image_data TEXT NOT NULL, source_title TEXT, created_at INTEGER NOT NULL);
    INSERT INTO products (id, name, created_at) VALUES ('old1', 'Xbox Series S', 1);
    INSERT INTO product_images (id, product_id, image_data, source_title, created_at) VALUES ('img1', 'old1', 'data:image/png;base64,OLD', 'a title', 1);
  `);
  old.close();
  let store = new Store(file);
  const cols = (t: string) => ((store as any).db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
  check("product_images gained the Beta 13 columns", ["status", "source_kind", "source_url", "verdict_json", "content_hash", "sort_order", "is_primary", "origin_product_id", "deleted_at"].every((c) => cols("product_images").includes(c)), cols("product_images"));
  check("products gained the Beta 13 columns", ["folder_id", "name_locked", "deleted_at", "identity_json", "identity_status", "suggested_family", "thumbnail_image_id"].every((c) => cols("products").includes(c)));
  check("the new tables exist", ["library_folders", "library_ops", "review_items", "listing_condition"].every((t) => cols(t).length > 0));
  check("the old photo is still there, as 'legacy'", store.listProductImages("old1").length === 1 && store.listProductImages("old1")[0].status === "legacy");
  (store as any).db.close();
  store = new Store(file); // second open: idempotent
  check("a second open changes nothing", store.listProductImages("old1").length === 1 && store.getProductById("old1")?.name === "Xbox Series S");

  section("delete order (audit LB-02): a product WITH photos deletes");
  store.addProductImage("old1", PIX("B"), "second");
  let threw = false;
  try { store.deleteProduct("old1"); } catch { threw = true; }
  check("deleteProduct no longer throws with photos", !threw);
  check("the product and its photos are gone", store.getProductById("old1") === null && store.listProductImages("old1").length === 0);

  section("soft delete / Trash");
  const id = store.addProductStub("p1", "Nintendo Switch");
  store.addProductImage(id, PIX("S"), "t");
  check("soft delete reports success once", store.softDeleteProduct(id) === true && store.softDeleteProduct(id) === false);
  check("a trashed product is in no list or lookup", store.listProducts().every((p) => p.id !== id) && store.listProductIndex().every((p) => p.id !== id) && store.getProductByName("Nintendo Switch") === null && store.findMatchingProduct("Nintendo Switch") === null);
  check("it is in the Trash, photos kept", store.listTrashedProducts().some((p) => p.id === id) && store.listProductImages(id).length === 1);
  check("a trashed name can be used again (no duplicate-key block)", store.addProductStub("p2", "Nintendo Switch") === "p2");
  check("restore brings it back", store.restoreProduct(id) === true && store.listProducts().some((p) => p.id === id));
  store.softDeleteProduct(id);
  check("purge removes only what is old enough", store.purgeTrash(60_000) === 0 && store.purgeTrash(-1) === 1 && store.getProductById(id) === null);

  section("the 20-photo cap never prunes a user, primary or lowest-value-protected photo");
  const cap = store.addProductStub("cap1", "Probe Camera");
  store.addProductImage(cap, PIX("USER"), null, "normal", { status: "user" });
  store.addProductImage(cap, PIX("PRIME"), "p", "normal", { status: "trusted", isPrimary: true });
  store.addProductImage(cap, PIX("BAD"), "b", "normal", { status: "quarantined" });
  for (let i = 0; i < 21; i++) store.addProductImage(cap, PIX("A" + i), "auto " + i);
  const left = store.listProductImages(cap);
  check("still 20 photos", left.length === 20, left.length);
  check("the user photo survived", left.some((i) => i.imageData.endsWith("USER")));
  check("the primary photo survived and is listed first", left[0].imageData.endsWith("PRIME"));
  check("the quarantined photo was pruned first", !left.some((i) => i.imageData.endsWith("BAD")));
  check("metadata listing carries no picture bytes", store.listProductImageMeta(cap).every((m) => !("imageData" in m)));

  section("the comparison lists only offer photos that may be used as a reference");
  const ref = store.addProductStub("ref1", "Probe Console");
  store.addProductImage(ref, PIX("OK"), "t", "normal", { status: "trusted" });
  store.addProductImage(ref, PIX("NO"), "t", "normal", { status: "needs_review" });
  const set = store.listProductsWithImages(10).find((x) => x.product.id === ref);
  check("needs_review photos are excluded from the comparison set", !!set && set.images.length === 1 && set.images[0].imageData.endsWith("OK"));

  section("cloud upsert does not touch the local-only Beta 13 columns");
  (store as any).db.prepare("UPDATE products SET folder_id = 'f1', name_locked = 1 WHERE id = ?").run(ref);
  store.upsertProductFromCloud({ ...store.getProductById(ref)!, name: "Probe Console (renamed on another device)", updatedAt: Date.now() + 1000 });
  const kept = (store as any).db.prepare("SELECT folder_id, name_locked FROM products WHERE id = ?").get(ref);
  check("folder_id and name_locked survive a cloud upsert", kept.folder_id === "f1" && kept.name_locked === 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
