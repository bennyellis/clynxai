// Mixed galleries end to end on a throwaway Database: the proposal becomes a Review item, the approved split is one undoable action, and undo puts every photo back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { LibraryOps } from "../libraryOps.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-split-"));
  const store = new Store(path.join(dir, "scout.db"));
  const db = (store as any).db;
  const ops = new LibraryOps(store);
  const x = store.addProductStub("x", "Xbox Series X");
  db.prepare("UPDATE products SET loading = 0, category = 'Video Games & Consoles', family = 'Xbox > Consoles' WHERE id = 'x'").run();
  const photo = (id: string, title: string, primary = 0) => db.prepare("INSERT INTO product_images (id, product_id, image_data, source_title, created_at, kind, status, is_primary) VALUES (?, 'x', 'data:image/png;base64,AA' || ?, ?, 1, 'normal', 'trusted', ?)").run(id, id, title, primary);
  photo("c1", "Microsoft Xbox Series X 1TB Console", 1);
  photo("g1", "Titanfall 2 - Xbox One - Brand New");
  photo("g2", "Titanfall 2 Xbox One game case");

  section("the proposal");
  check("one Review item is queued, lighting the attention dot", store.queueGallerySplits() === 1 && store.attentionSummary().items.some((i) => i.kind === "split" && i.productIds[0] === x));
  check("queuing again adds nothing new", store.queueGallerySplits() === 0 && store.listReviewItems("open").filter((i) => i.kind === "split").length === 1);
  const item = store.listReviewItems("open").find((i) => i.kind === "split")!;
  const ev = item.evidence as { name: string; imageIds: string[]; family: string };

  section("the split is one undoable action");
  const op = { op: "splitGallery" as const, productId: x, imageIds: ev.imageIds, name: ev.name, family: ev.family };
  const ask = ops.run(op, { actor: "ui" });
  check("it asks first (and nothing moved yet)", !!ask.needsConfirmation && (db.prepare("SELECT COUNT(*) n FROM product_images WHERE product_id = 'x'").get() as any).n === 3);
  const done = ops.run(op, { actor: "ui", confirm: ask.needsConfirmation!.token });
  const gameId = done.data?.productId;
  check("a new entry for the game exists in the Games folder, with the two photos", done.ok && !!gameId && (db.prepare("SELECT family, name FROM products WHERE id = ?").get(gameId) as any).family === "Xbox > Games" && (db.prepare("SELECT COUNT(*) n FROM product_images WHERE product_id = ?").get(gameId) as any).n === 2, done);
  check("the console keeps its own photo", (db.prepare("SELECT id FROM product_images WHERE product_id = 'x'").all() as any[]).map((r) => r.id).join() === "c1");
  const undo = ops.run({ op: "undo", opId: done.opId! }, { actor: "ui" });
  check("undo puts both photos back and removes the entry it made", undo.ok && (db.prepare("SELECT COUNT(*) n FROM product_images WHERE product_id = 'x'").get() as any).n === 3 && !db.prepare("SELECT 1 FROM products WHERE id = ?").get(gameId), undo);

  section("a game that already has its entry gets the photos, nothing is duplicated");
  const existing = store.addProductStub("t2", "Titanfall 2");
  const ask2 = ops.run(op, { actor: "ui" });
  const done2 = ops.run(op, { actor: "ui", confirm: ask2.needsConfirmation!.token });
  check("the photos moved into the existing entry and no second entry was made", done2.ok && (db.prepare("SELECT COUNT(*) n FROM product_images WHERE product_id = ?").get(existing) as any).n === 2 && (db.prepare("SELECT COUNT(*) n FROM products WHERE LOWER(name) LIKE 'titanfall%'").get() as any).n === 1, done2);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
