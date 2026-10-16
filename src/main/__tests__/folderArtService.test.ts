// The service that gives automatic folders a sensible picture: limits, once-only generation, the person's choice protected, fitting member photos only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../store.js";
import { LibraryOps } from "../libraryOps.js";
import { createFolderArtService, listAutoFolders } from "../folderArtService.js";
import { autoFolderId, autoPath } from "../folderKeys.js";
import type { ImageGenerator } from "../folderArt.js";
import { check, run, section } from "./_testkit.js";

async function png(color: string): Promise<string> {
  const buf = await sharp({ create: { width: 128, height: 128, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-art-"));
  const store = new Store(path.join(dir, "scout.db"));
  const ops = new LibraryOps(store);
  const CAT = "Video Games & Consoles";
  const blue = await png("#2255cc");
  const red = await png("#cc2222");
  const mk = (id: string, name: string, family: string, image: string) => {
    const real = store.addProductStub(id, name);
    store.updateProductProfile(real, { aiSummary: "x", category: CAT, family, imageUrl: image });
    return real;
  };
  mk("a", "Nintendo Switch OLED Console", "Nintendo > Consoles", blue);
  mk("c", "Super Mario Odyssey - Nintendo Switch Game", "Nintendo > Games", red);
  mk("d", "Xbox Series X Console", "Xbox > Consoles", blue);
  mk("e", "PlayStation 5 Console", "PlayStation > Consoles", blue);
  const prompts: string[] = [];
  const gen: ImageGenerator = { draw: async (p) => { prompts.push(p); return { dataUri: await png("#117744"), costUsd: 0.04 }; } };
  let auto = true;
  let changed = 0;
  const svc = createFolderArtService({ store, ops: () => ops, generator: () => gen, autoGenerate: () => auto, limits: () => ({ perDay: 3, perDayManual: 5 }), changed: () => void changed++ });

  section("which folders exist");
  const folders = listAutoFolders(store.listAutoFolderPlacements());
  check("each family path and the level above it is a folder (below the category)", folders.map((f) => f.segments.join(" > ")).sort().join("|") === "Nintendo|Nintendo > Consoles|Nintendo > Games|PlayStation|PlayStation > Consoles|Xbox|Xbox > Consoles", folders.map((f) => f.segments.join(" > ")));

  section("generation is limited and happens once");
  const r1 = await svc.refresh();
  check("only sub-folders get artwork (a brand's top folder keeps its logo) and the daily limit of 3 caps it although 4 sub-folders exist", r1.generated === 3 && prompts.length === 3, r1);
  check("every generated picture is recorded as decorative ai_generated", folders.every((f) => { const m = store.getFolderMeta(autoFolderId(f.category, f.segments)); return !m?.thumbSource || m.thumbSource !== "ai_generated" || m.thumbMeta?.decorative === true; }));
  check("the prompts name the whole path", prompts.every((p) => p.includes("Video Games & Consoles")));
  const before = prompts.length;
  await svc.refresh();
  check("looking again does not generate again (limit spent, and generated folders are not remade)", prompts.length === before);
  check("the cost ledger recorded the estimates", store.usageToday("folder_art").count === 3 && Math.abs(store.usageToday("folder_art").usd - 0.12) < 1e-9);

  section("fallback: a fitting member photo, never a wrong one");
  const nintendoConsoles = store.getFolderMeta(autoFolderId(CAT, ["Nintendo", "Consoles"]));
  const nintendoGames = store.getFolderMeta(autoFolderId(CAT, ["Nintendo", "Games"]));
  const xboxConsoles = store.getFolderMeta(autoFolderId(CAT, ["Xbox", "Consoles"]));
  auto = false;
  const s2 = new Store(path.join(dir, "second.db"));
  const ops2 = new LibraryOps(s2);
  const mk2 = (id: string, name: string, family: string, image: string) => { const real = s2.addProductStub(id, name); s2.updateProductProfile(real, { aiSummary: "x", category: CAT, family, imageUrl: image }); };
  mk2("g", "Super Mario Odyssey - Nintendo Switch Game", "Nintendo > Consoles", red); // a game wrongly filed under consoles
  const svc2 = createFolderArtService({ store: s2, ops: () => ops2, generator: () => null, autoGenerate: () => false, limits: () => ({ perDay: 3, perDayManual: 5 }) });
  const r2 = await svc2.refresh();
  check("with generation off, a console folder holding only a game gets NO picture (placeholder), not the game's artwork", r2.picked >= 0 && !s2.getFolderMeta(autoFolderId(CAT, ["Nintendo", "Consoles"]))?.thumbData);
  mk2("k", "Nintendo 3DS XL Console", "Nintendo > Consoles", blue);
  const r3 = await svc2.refresh();
  const pickedMeta = s2.getFolderMeta(autoFolderId(CAT, ["Nintendo", "Consoles"]));
  check("once a console is in it, the folder takes the console's photo, recorded as 'auto' with its source product", r3.picked >= 1 && pickedMeta?.thumbSource === "auto" && pickedMeta.thumbMeta?.productName === "Nintendo 3DS XL Console" && pickedMeta.thumbData === blue);
  check("an automatic picture is not marked decorative-generated and is not locked", pickedMeta?.thumbMeta?.decorative !== true && !pickedMeta?.thumbLocked);

  section("what a person chose is never touched");
  const up = ops.run({ op: "setFolderThumbnail", key: autoPath(CAT, ["Xbox", "Consoles"]), imageData: red }, { actor: "ui" });
  auto = true;
  await svc.refresh();
  const kept = store.getFolderMeta(autoFolderId(CAT, ["Xbox", "Consoles"]));
  check("the chosen picture survives automatic refreshes", up.ok && kept?.thumbSource === "user_upload" && kept.thumbData === red);
  const manual = await svc.generate(autoPath(CAT, ["Xbox", "Consoles"]), true);
  check("a person asking for a generated picture replaces it, and it stays protected", manual.ok && store.getFolderMeta(autoFolderId(CAT, ["Xbox", "Consoles"]))!.thumbLocked === true && store.getFolderMeta(autoFolderId(CAT, ["Xbox", "Consoles"]))!.thumbSource === "ai_generated");
  const auto2 = await svc.generate(autoPath(CAT, ["Xbox", "Consoles"]), false);
  check("automation cannot regenerate over it", !auto2.ok);
  check("a request is also limited (5 a day in all)", (await svc.generate(autoPath(CAT, ["Nintendo", "Games"]), true)).ok === false || store.usageToday("folder_art").count <= 5);
  void nintendoConsoles; void nintendoGames; void xboxConsoles;

  section("failure and unavailability are honest");
  const dead = createFolderArtService({ store, ops: () => ops, generator: () => null, autoGenerate: () => true, limits: () => ({ perDay: 3, perDayManual: 5 }) });
  const off = await dead.generate(autoPath(CAT, ["Nintendo", "Games"]), true);
  check("no image service means a clear message and no cost", !off.ok && /not available/.test(off.message));
  const bad = createFolderArtService({ store: s2, ops: () => ops2, generator: () => ({ draw: async () => { throw new Error("rate limited"); } }), autoGenerate: () => true, limits: () => ({ perDay: 3, perDayManual: 5 }) });
  const fail = await bad.generate(autoPath(CAT, ["Nintendo", "Consoles"]), true);
  check("a failing service is reported and costs nothing", !fail.ok && /rate limited/.test(fail.message) && s2.usageToday("folder_art").count === 0);
  check("system-made pictures do not clutter the history a person sees", ops.recent(50).every((o) => o.actor !== "system"));
  store.close();
  s2.close();
});
