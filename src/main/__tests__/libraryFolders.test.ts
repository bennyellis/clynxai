// The Library's AUTOMATIC folders: rename, delete (safe workflow), thumbnails with provenance, and what survives a restart and a research refresh. Real Store on disk, closed and reopened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../store.js";
import { LibraryOps, toLibraryOp, type LibraryOp, type OpResult } from "../libraryOps.js";
import { toolsForContext } from "../chat.js";
import { autoFolderId, autoPath, cleanFolderLabel, folderMeaning, isUserThumb } from "../folderKeys.js";
import { checkFolderImage, folderPrompt, generateFolderPicture, normalizeFolderImage, pickMemberImage, type ImageGenerator } from "../folderArt.js";
import { check, run, section } from "./_testkit.js";

async function png(color: string, size = 96): Promise<string> {
  const buf = await sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-folders-"));
  const file = path.join(dir, "scout.db");
  let store = new Store(file);
  let ops = new LibraryOps(store);
  const go = (op: LibraryOp, confirm?: string): OpResult => ops.run(op, { actor: "ui", confirm });
  const confirmed = (op: LibraryOp): OpResult => {
    const first = go(op);
    return first.needsConfirmation ? go(op, first.needsConfirmation.token) : first;
  };
  const trashed = (id: string) => store.listTrashedProducts().some((p) => p.id === id);
  const CAT = "Video Games & Consoles";
  const mk = (id: string, name: string, family: string | null, image: string | null = null) => {
    const real = store.addProductStub(id, name);
    store.updateProductProfile(real, { aiSummary: "x", category: CAT, family, imageUrl: image });
    return real;
  };
  const blue = await png("#2255cc");
  const red = await png("#cc2222");
  const n1 = mk("a", "Nintendo Switch OLED Console", "Nintendo > Consoles", blue);
  const n2 = mk("b", "Nintendo 3DS XL Console", "Nintendo > Consoles", blue);
  const g1 = mk("c", "Super Mario Odyssey - Nintendo Switch Game", "Nintendo > Games", red);
  const x1 = mk("d", "Xbox Series X", "Xbox > Consoles");
  const KEY = autoPath(CAT, ["Nintendo", "Consoles"]);
  const ID = autoFolderId(CAT, ["Nintendo", "Consoles"]);

  section("what a folder means (from its whole path)");
  check("Nintendo > Consoles is console hardware, not games", folderMeaning(CAT, ["Nintendo", "Consoles"]).wants === "hardware" && /Nintendo/.test(folderMeaning(CAT, ["Nintendo", "Consoles"]).subject));
  check("Nintendo > Games is game software", folderMeaning(CAT, ["Nintendo", "Games"]).wants === "games");
  check("accessories are their own meaning", folderMeaning(CAT, ["Xbox", "Controllers"]).wants === "accessories");
  const prompt = folderPrompt(CAT, ["Nintendo", "Consoles"]);
  check("the prompt names the full path, the subject and what to avoid, and forbids text", /Video Games & Consoles > Nintendo > Consoles/.test(prompt) && /hardware/.test(prompt) && /Do not show: .*game cases/.test(prompt) && /no text/i.test(prompt));
  check("names reject the path separator and control characters", !cleanFolderLabel("a > b").ok && !cleanFolderLabel("  ").ok && cleanFolderLabel("  Nintendo   Hardware ").ok);

  section("rename an automatic folder");
  const r1 = go({ op: "renameAutoFolder", key: KEY, name: "Nintendo Hardware" });
  check("rename works and says what it did", r1.ok && /Nintendo Hardware/.test(r1.summary), r1);
  check("products and their placement are untouched", store.getProductById(n1)!.family === "Nintendo > Consoles" && store.getProductById(g1)!.family === "Nintendo > Games");
  check("a sibling clash is refused", !go({ op: "renameAutoFolder", key: KEY, name: "games" }).ok);
  check("a missing folder is refused", !go({ op: "renameAutoFolder", key: autoPath(CAT, ["Nintendo", "Nope"]), name: "x" }).ok);
  check("a top-level category cannot be renamed this way", !go({ op: "renameAutoFolder", key: CAT, name: "x" }).ok);
  store.updateProductProfile(n1, { aiSummary: "refreshed", category: CAT, family: "Nintendo > Consoles", imageUrl: null });
  check("a research refresh does not undo the name", store.getFolderMeta(ID)?.displayName === "Nintendo Hardware");
  const nv = mk("n", "Nintendo Switch Lite Console", "Nintendo > Consoles", blue);
  check("a NEW product arriving on that path lands in the same (renamed) folder", !!nv && store.listAutoFolderPlacements().find((p) => p.family === "Nintendo > Consoles")?.count === 3 && store.getFolderMeta(ID)?.displayName === "Nintendo Hardware");

  section("thumbnails: provenance, manual wins, restore");
  const gen = await png("#117744");
  const rec = go({ op: "recordFolderThumbnail", key: KEY, imageData: gen, source: "ai_generated", meta: { prompt, costUsd: 0.04 } });
  const m1 = store.getFolderMeta(ID)!;
  check("a generated picture is recorded as ai_generated and decorative", rec.ok && m1.thumbSource === "ai_generated" && m1.thumbMeta?.decorative === true && !m1.thumbLocked);
  const photo = store.listProductImages(n1)[0];
  const uploaded = await png("#aa33aa", 128);
  const up = go({ op: "setFolderThumbnail", key: KEY, imageData: uploaded, fileName: "mine.png" });
  const m2 = store.getFolderMeta(ID)!;
  check("an upload becomes user_upload and is locked", up.ok && m2.thumbSource === "user_upload" && m2.thumbLocked && isUserThumb(m2.thumbSource));
  check("automation cannot replace a chosen picture", !go({ op: "recordFolderThumbnail", key: KEY, imageData: gen, source: "ai_generated" }).ok && store.getFolderMeta(ID)!.thumbSource === "user_upload");
  check("the automatic chooser cannot either", !go({ op: "recordFolderThumbnail", key: KEY, imageData: blue, source: "auto" }).ok);
  check("a person asking for a generated picture may replace it, and it stays protected", go({ op: "recordFolderThumbnail", key: KEY, imageData: gen, source: "ai_generated", byRequest: true }).ok && store.getFolderMeta(ID)!.thumbLocked === true && store.getFolderMeta(ID)!.thumbSource === "ai_generated");
  const sel = photo ? go({ op: "setFolderThumbnail", key: KEY, imageId: photo.id }) : { ok: true, summary: "" };
  check("choosing an existing photo is recorded as user_selected (when a product photo exists)", !photo || (sel.ok && store.getFolderMeta(ID)!.thumbSource === "user_selected"));
  check("junk is refused", !go({ op: "setFolderThumbnail", key: KEY, imageData: "data:image/png;base64,AAAA" }).ok && !go({ op: "setFolderThumbnail", key: KEY, imageData: "data:image/svg+xml;base64,AAAA" }).ok && !checkFolderImage("hello").ok);
  const rest = go({ op: "restoreFolderThumbnail", key: KEY });
  check("restoring automatic selection clears the choice and the lock", rest.ok && store.getFolderMeta(ID)!.thumbData === null && !store.getFolderMeta(ID)!.thumbLocked && store.getFolderMeta(ID)!.displayName === "Nintendo Hardware");
  check("a generated picture is never a product photo", store.listProductImages(n1).every((i) => i.imageData !== gen) && (store.database.prepare("SELECT COUNT(*) AS n FROM product_images WHERE image_data = ?").get(gen) as { n: number }).n === 0);

  section("picking an automatic picture from member products only when it fits");
  const members = [
    { productId: g1, name: "Super Mario Odyssey - Nintendo Switch Game", imageUrl: red },
    { productId: n1, name: "Nintendo Switch OLED Console", imageUrl: blue },
  ];
  check("a console folder never takes a game's picture", pickMemberImage(members, "hardware")?.productId === n1);
  check("a games folder takes the game", pickMemberImage(members, "games")?.productId === g1);
  check("nothing fitting means nothing (a placeholder, not a wrong picture)", pickMemberImage([members[0]], "hardware") === null);

  section("the picture file itself");
  const norm = await normalizeFolderImage(uploaded);
  const meta = norm.ok ? await sharp(Buffer.from(norm.dataUri.split(",")[1], "base64")).metadata() : null;
  check("any accepted picture is stored as a 512 px square jpeg", norm.ok && meta?.width === 512 && meta?.height === 512 && meta?.format === "jpeg");
  check("a tiny picture is refused", !(await normalizeFolderImage(await png("#000", 16))).ok);
  check("something that is not an image is refused", !(await normalizeFolderImage("data:image/png;base64," + Buffer.from("not an image at all, just text").toString("base64"))).ok);
  const fake: ImageGenerator = { draw: async () => ({ dataUri: await png("#334455", 256), costUsd: 0.04 }) };
  const made = await generateFolderPicture(CAT, ["Nintendo", "Consoles"], fake);
  check("generation returns a normalised picture, the prompt and an estimated cost", made.ok && made.prompt.includes("Nintendo") && made.costUsd === 0.04);
  check("a failing image service is a reason, not a crash", !(await generateFolderPicture(CAT, ["x"], { draw: async () => { throw new Error("boom"); } })).ok && !(await generateFolderPicture(CAT, ["x"], { draw: async () => null })).ok);

  section("delete an automatic folder, the safe way");
  const del = go({ op: "deleteAutoFolder", key: autoPath(CAT, ["Nintendo", "Games"]), mode: "move_contents_up" });
  check("moving contents up needs no scary question for a small folder and moves the product up", del.ok && store.getProductById(g1)!.family === "Nintendo" && !trashed(g1), del);
  store.updateProductProfile(g1, { aiSummary: "again", category: CAT, family: "Nintendo > Games", imageUrl: null });
  check("research does not drag it back (the person placed it)", store.getProductById(g1)!.family === "Nintendo");
  const t = go({ op: "deleteAutoFolder", key: autoPath(CAT, ["Xbox", "Consoles"]), mode: "trash_with_contents" });
  check("sending a folder and its contents to the Trash asks first", !t.ok && !!t.needsConfirmation);
  check("nothing was deleted by asking", !trashed(x1));
  const t2 = confirmed({ op: "deleteAutoFolder", key: autoPath(CAT, ["Xbox", "Consoles"]), mode: "trash_with_contents" });
  check("confirmed: the product is in the Trash, not gone", t2.ok && store.listTrashedProducts().some((p) => p.id === x1) && !!store.getProductById(x1));
  const u = go({ op: "undo", opId: t2.opId! });
  check("undo restores it", u.ok && !trashed(x1));
  const u2 = go({ op: "undo", opId: del.opId! });
  check("undoing the move puts the product back where it was", u2.ok && store.getProductById(g1)!.family === "Nintendo > Games");
  check("a top-level category cannot be deleted", !go({ op: "deleteAutoFolder", key: CAT }).ok);
  check("product identity and value are untouched by all of this", store.getProductById(n1)!.name === "Nintendo Switch OLED Console");

  section("the chat reaches the same operations");
  const argsFor: Record<string, Record<string, unknown>> = {
    createFolder: { name: "x" }, renameFolder: { id: "i", name: "x" }, moveFolder: { id: "i" }, deleteFolder: { id: "i" }, moveProduct: { productId: "p" }, renameProduct: { id: "i", name: "x" },
    trashProduct: { id: "i" }, restoreProduct: { id: "i" }, removeImage: { imageId: "i" }, restoreImage: { imageId: "i" }, setPrimaryImage: { productId: "p", imageId: "i" }, setThumbnail: { productId: "p" },
    reassignImage: { imageId: "i", toProductId: "p" }, renameAutoFolder: { key: KEY, name: "x" }, deleteAutoFolder: { key: KEY }, setFolderThumbnail: { key: KEY, imageId: "i" },
    restoreFolderThumbnail: { key: KEY }, undo: { opId: "o" },
  };
  const libTool = toolsForContext("global").find((t) => t.function.name === "library_op")!;
  const enumOps = ((libTool.function.parameters as any).properties.op.enum as string[]);
  const unmapped = enumOps.filter((o) => o !== "generateFolderThumbnail" && "error" in toLibraryOp({ op: o, ...(argsFor[o] ?? {}) }));
  check("every operation the chat tool offers maps to a Library operation (generation is handled by the picture service)", unmapped.length === 0 && enumOps.includes("generateFolderThumbnail"), unmapped);
  const chatRename = toLibraryOp({ op: "renameAutoFolder", key: KEY, name: "Nintendo Hardware 2" });
  check("a chat rename runs through the same backend and persists", !("error" in chatRename) && ops.run(chatRename, { actor: "chat" }).ok && store.getFolderMeta(ID)!.displayName === "Nintendo Hardware 2");
  const chatDel = toLibraryOp({ op: "deleteAutoFolder", key: autoPath(CAT, ["Xbox", "Consoles"]), deleteContents: true });
  const asked = !("error" in chatDel) ? ops.run(chatDel, { actor: "chat" }) : null;
  check("a chat delete-with-contents needs the person's confirmation and changes nothing until then", !!asked?.needsConfirmation && !trashed(x1));
  check("the chat can read the automatic folders and the history", toolsForContext("global").some((t) => t.function.name === "library_list") && ops.recent(5).length > 0);
  ops.run({ op: "renameAutoFolder", key: KEY, name: "Nintendo Hardware" }, { actor: "ui" });

  section("it all survives a restart");
  ops.run({ op: "setFolderThumbnail", key: KEY, imageData: uploaded }, { actor: "ui" });
  const opIds = ops.recent(50).length;
  store.close();
  store = new Store(file);
  ops = new LibraryOps(store);
  const back = store.getFolderMeta(ID)!;
  check("the new name persists", back.displayName === "Nintendo Hardware");
  check("the chosen picture persists with its provenance and lock", back.thumbSource === "user_upload" && back.thumbLocked && !!back.thumbData);
  check("the history persists", ops.recent(50).length === opIds && opIds > 5);
  store.updateProductProfile(n1, { aiSummary: "after restart", category: CAT, family: "Nintendo > Consoles", imageUrl: null });
  check("a research refresh after the restart changes neither", store.getFolderMeta(ID)!.displayName === "Nintendo Hardware" && store.getFolderMeta(ID)!.thumbSource === "user_upload");
  check("the usage ledger counts per day and in total", (() => { store.addUsage("folder_art", 1, 0.04); store.addUsage("folder_art", 1, 0.04); return store.usageToday("folder_art").count === 2 && Math.abs(store.usageTotal("folder_art").usd - 0.08) < 1e-9; })());
  store.close();
});
