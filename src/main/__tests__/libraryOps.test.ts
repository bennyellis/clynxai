// Beta 13 WP5: the Library operations service (folders, placement, photos, trash, undo, confirmation) on a real Store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { LibraryOps, type LibraryOp, type OpResult } from "../libraryOps.js";
import { fileImage } from "../fileImage.js";
import { check, run, section } from "./_testkit.js";

const pic = (n: string) => `data:image/png;base64,${n}`;

run(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b13-ops-"));
  const store = new Store(path.join(dir, "scout.db"));
  const changes: Array<{ productIds: string[]; folders: boolean }> = [];
  const ops = new LibraryOps(store, (c) => changes.push(c));
  const go = (op: LibraryOp, confirm?: string): OpResult => ops.run(op, { actor: "ui", confirm });
  const confirmed = (op: LibraryOp): OpResult => {
    const first = go(op);
    return first.needsConfirmation ? go(op, first.needsConfirmation.token) : first;
  };
  const mk = (id: string, name: string, family = "Xbox") => { const real = store.addProductStub(id, name); store.updateProductProfile(real, { aiSummary: "x", category: "Video Games & Consoles", family, imageUrl: null }); return real; };
  const folderId = (r: OpResult) => store.listFolders().find((f) => r.summary.includes(`"${f.name}"`))?.id ?? "";

  section("folders: create, nest, rename, collisions, reserved names, depth, cycles");
  const a = go({ op: "createFolder", parentId: null, name: "Flips" });
  check("a folder is created", a.ok && store.listFolders().length === 1, a);
  const flips = store.listFolders()[0].id;
  check("a sibling with the same name (any case) is refused", !go({ op: "createFolder", parentId: null, name: "  flips " }).ok);
  const b = go({ op: "createFolder", parentId: flips, name: "Consoles" });
  const consoles = store.listFolders().find((f) => f.name === "Consoles")!.id;
  check("nesting works and the path is 'Flips > Consoles'", b.ok && store.folderPath(consoles) === "Flips > Consoles");
  check("the same name under another parent is fine", go({ op: "createFolder", parentId: null, name: "Consoles" }).ok);
  check("reserved root names are refused", !go({ op: "createFolder", parentId: null, name: "Trash" }).ok && !go({ op: "createFolder", parentId: null, name: "Needs review" }).ok);
  check("bad characters are refused", !go({ op: "createFolder", parentId: null, name: "a > b" }).ok && !go({ op: "createFolder", parentId: null, name: "x".repeat(81) }).ok);
  check("a folder cannot move into itself or its own child (cycle)", !go({ op: "moveFolder", id: flips, newParentId: consoles }).ok && !go({ op: "moveFolder", id: flips, newParentId: flips }).ok);
  let parent: string | null = consoles; let levels = 0; let refused = false;
  for (let i = 0; i < 12; i++) {
    const r = go({ op: "createFolder", parentId: parent, name: "L" + i });
    if (!r.ok) { refused = true; break; }
    levels++;
    parent = store.listFolders().find((f) => f.name === "L" + i)!.id;
  }
  check("nesting stops at the depth limit (8 levels in all)", refused && levels === 6, { levels });
  const rn = go({ op: "renameFolder", id: flips, name: "Resale" });
  check("rename a folder", rn.ok && store.folderPath(consoles) === "Resale > Consoles");

  section("placing and renaming products; identity and value are untouched");
  const s = mk("s", "Xbox Series S"), x = mk("x", "Xbox Series X");
  store.updateProductEbayComps?.length;
  const mv = go({ op: "moveProduct", productId: s, folderId: consoles });
  check("a product moves into a folder and shows that path", mv.ok && store.getProductById(s)?.folderPath === "Resale > Consoles" && store.getProductById(s)?.folderId === consoles);
  check("its name, family and category did not change", store.getProductById(s)?.name === "Xbox Series S" && store.getProductById(s)?.family === "Xbox");
  store.updateProductProfile(s, { aiSummary: "refreshed", category: "Electronics", family: "Microsoft > Consoles", imageUrl: null });
  check("a research refresh does NOT move a product the person placed", store.getProductById(s)?.folderPath === "Resale > Consoles");
  check("moving back restores the auto place", go({ op: "moveProduct", productId: s, folderId: null }).ok && store.getProductById(s)?.folderPath == null);
  check("a rename needs no confirmation when it keeps the same product, and locks the name", go({ op: "renameProduct", id: s, name: "Xbox Series S 512GB" }).ok && store.getProductById(s)?.nameLocked === true);
  const risky = go({ op: "renameProduct", id: s, name: "Xbox Series X 1TB" });
  check("a rename to a different product asks first", !risky.ok && !!risky.needsConfirmation);
  check("a name another product already has is refused", !confirmed({ op: "renameProduct", id: x, name: "xbox series s 512gb" }).ok);

  section("confirmation tokens");
  const bulk = Array.from({ length: 12 }, (_, i) => mk("b" + i, "Probe Item " + i, "Probe"));
  const bigOp: LibraryOp = { op: "moveProducts", productIds: bulk, folderId: consoles };
  const first = go(bigOp);
  check("more than 10 products asks first and moves nothing", !first.ok && !!first.needsConfirmation && store.getProductById(bulk[0])?.folderId == null);
  check("a made-up token does nothing", !go(bigOp, "forged").ok);
  check("the issued token runs it, once", go(bigOp, first.needsConfirmation!.token).ok && !go(bigOp, first.needsConfirmation!.token).ok && store.getProductById(bulk[0])?.folderId === consoles);
  const other = go({ op: "moveProducts", productIds: bulk.slice(0, 11), folderId: null });
  check("a token only works for the exact operation it was issued for", !go({ op: "moveProducts", productIds: bulk, folderId: null }, other.needsConfirmation!.token).ok);

  section("Trash: products, folders, and the two delete modes");
  const t = go({ op: "trashProduct", id: x });
  check("a product goes to the Trash, is in no list, and restores", t.ok && store.listProducts().every((p) => p.id !== x) && store.listTrashedProducts().some((p) => p.id === x) && go({ op: "restoreProduct", id: x }).ok && store.listProducts().some((p) => p.id === x));
  go({ op: "moveProduct", productId: s, folderId: consoles });
  const del = go({ op: "deleteFolder", id: consoles });
  check("deleting a folder (default) moves its contents up and trashes only the folder", del.ok && store.getProductById(s)?.folderId === flips && !store.listFolders().some((f) => f.id === consoles));
  const sub = go({ op: "createFolder", parentId: flips, name: "Temp" }); const temp = store.listFolders().find((f) => f.name === "Temp")!.id;
  go({ op: "moveProduct", productId: x, folderId: temp });
  const tw = go({ op: "deleteFolder", id: temp, mode: "trash_with_contents" });
  check("trashing a folder WITH contents asks first", !tw.ok && !!tw.needsConfirmation && sub.ok);
  check("...then trashes the folder and its products", go({ op: "deleteFolder", id: temp, mode: "trash_with_contents" }, tw.needsConfirmation!.token).ok && store.listTrashedProducts().some((p) => p.id === x));

  section("photos: remove / restore / replace / reorder / primary / thumbnail");
  const p1 = mk("ph", "Probe Camera", "Probe");
  const im = (n: string) => fileImage(store, p1, pic(n), { sourceKind: "listing", title: "Probe Camera " + n, proposer: "test" }).image!;
  const i1 = im("AAA1"), i2 = im("BBB2"), i3 = im("CCC3");
  check("remove sends a photo to the Trash and restore brings it back", go({ op: "removeImage", imageId: i2.id }).ok && store.listProductImages(p1).length === 2 && go({ op: "restoreImage", imageId: i2.id }).ok && store.listProductImages(p1).length === 3);
  check("reorder sets the order", go({ op: "reorderImages", productId: p1, orderedIds: [i3.id, i1.id, i2.id] }).ok && store.listProductImages(p1).map((i) => i.id).join() === [i3.id, i1.id, i2.id].join());
  check("a foreign photo id in a reorder is refused", !go({ op: "reorderImages", productId: p1, orderedIds: ["nope"] }).ok);
  check("primary goes first", go({ op: "setPrimaryImage", productId: p1, imageId: i2.id }).ok && store.listProductImages(p1)[0].id === i2.id);
  check("thumbnail from a photo (and kept)", go({ op: "setThumbnail", productId: p1, imageId: i1.id }).ok && store.getProductById(p1)?.imageUrl === i1.imageData && store.getProductById(p1)?.keepThumbnail === true);
  const rp = confirmed({ op: "replaceImage", imageId: i3.id, imageData: pic("DDD4") });
  check("replace asks, then swaps in a user photo and trashes the old one", rp.ok && store.listProductImages(p1).some((i) => i.imageData.endsWith("DDD4") && i.status === "user") && !store.listProductImages(p1).some((i) => i.id === i3.id));
  check("a non-image is refused", !confirmed({ op: "replaceImage", imageId: i1.id, imageData: "data:text/html;base64,AAAA" }).ok);

  section("moving a photo to another product (the gate advises, the person decides)");
  const sSeries = mk("sx", "Xbox Series S 512GB Edition", "Xbox"), pX = mk("px", "Xbox Series X 1TB", "Xbox");
  const wrong = fileImage(store, sSeries, pic("WR1"), { sourceKind: "listing", title: "Xbox Series X 1TB console", proposer: "gallery-audit", existingImage: true }).image;
  check("the gate quarantined the Series X photo in the Series S gallery", wrong?.status === "quarantined" && store.listReviewItems().some((r) => r.subjectId === wrong.id));
  const mvImg = go({ op: "reassignImage", imageId: wrong!.id, toProductId: pX });
  check("moving it where its title says it belongs needs no confirmation and settles the review item", mvImg.ok && store.listProductImages(pX).some((i) => i.id === wrong!.id && i.status === "user") && store.listReviewItems().every((r) => r.subjectId !== wrong!.id));
  const against = fileImage(store, sSeries, pic("WR2"), { sourceKind: "listing", title: "Xbox Series S 512GB white", proposer: "test" }).image!;
  check("moving a photo somewhere its title contradicts asks first", !!go({ op: "reassignImage", imageId: against.id, toProductId: pX }).needsConfirmation);
  const ne = go({ op: "newEntryFromImage", imageId: against.id, name: "Xbox Series S 512GB White Edition" });
  check("a new entry can be made from a photo", ne.ok && !!ne.data?.productId && store.listProductImages(ne.data!.productId!).length === 1);

  section("undo restores exactly what was changed");
  const u1 = go({ op: "moveProduct", productId: sSeries, folderId: flips });
  check("undo of a move", ops.run({ op: "undo", opId: u1.opId! }, { actor: "ui" }).ok && store.getProductById(sSeries)?.folderId == null);
  check("undoing twice is refused", !ops.run({ op: "undo", opId: u1.opId! }, { actor: "ui" }).ok);
  const u2 = go({ op: "createFolder", parentId: null, name: "Scratch" });
  check("undo of a folder creation removes it", ops.run({ op: "undo", opId: u2.opId! }, { actor: "ui" }).ok && !store.listFolders().some((f) => f.name === "Scratch"));
  const u3 = go({ op: "trashProduct", id: sSeries });
  check("undo of a trash restores the product", ops.run({ op: "undo", opId: u3.opId! }, { actor: "ui" }).ok && store.listProducts().some((p) => p.id === sSeries));
  check("undo of 'new entry' puts the photo back and removes the entry", ops.run({ op: "undo", opId: ne.opId! }, { actor: "ui" }).ok && store.getProductById(ne.data!.productId!) === null && store.listProductImages(sSeries).some((i) => i.id === against.id));
  check("undo of a replace brings the old photo back", ops.run({ op: "undo", opId: rp.opId! }, { actor: "ui" }).ok && store.listProductImages(p1).some((i) => i.id === i3.id) && !store.listProductImages(p1).some((i) => i.imageData.endsWith("DDD4")));
  check("every operation was written to the audit log", ops.recent(100).length >= 15 && ops.recent(100).every((r) => r.actor === "ui"));

  section("merging is proposed, then needs a confirmation and re-checks the photos it moves");
  const d1 = mk("d1", "Probe Console One", "Probe"); (store as any).database.prepare("INSERT INTO products (id, name, loading, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run("d2", "probe console one", Date.now(), Date.now());
  fileImage(store, d1, pic("MG1"), { sourceKind: "listing", title: "Probe Console One console", proposer: "t" });
  check("duplicates are listed without changing anything", store.findDuplicateGroups().some((g) => g.ids.includes(d1) && g.ids.includes("d2")) && store.getProductById("d2") !== null);
  const mg = go({ op: "mergeProducts", ids: [d1, "d2"] });
  check("merging asks first", !mg.ok && !!mg.needsConfirmation && store.getProductById("d2") !== null);
  check("with the token it merges", go({ op: "mergeProducts", ids: [d1, "d2"] }, mg.needsConfirmation!.token).ok && (store.getProductById("d2") === null || store.getProductById(d1) === null));
  check("changes were announced to the UI", changes.length > 10 && changes.some((c) => c.folders));
  fs.rmSync(dir, { recursive: true, force: true });
});
