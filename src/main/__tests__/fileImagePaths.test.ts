// Beta 13 WP3: the single picture writer (audit ID-01/ID-02). The screenshot cases and the repo-wide rule that nothing else writes pictures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { decideFiling, fileImage, type FileImageEvidence } from "../fileImage.js";
import { topUpReferencePhotos } from "../referencePhotos.js";
import { check, run, section } from "./_testkit.js";

const SRC = "MICROSOFT XBOX SERIES X - CONSOLE - 1TB - 1882 (G4P004519)";
const ev = (title: string | null, extra: Partial<FileImageEvidence> = {}): FileImageEvidence => ({ sourceKind: "listing", title, proposer: "test", ...extra });
const pic = (n: string) => `data:image/png;base64,${n}`;

run(async () => {
  section("decideFiling: the rules in order");
  check("the Series X title can never enter a Series S gallery (refused)", decideFiling("Xbox Series S", ev(SRC), []).outcome === "rejected");
  check("...and an image already in the Library is quarantined instead", decideFiling("Xbox Series S", ev(SRC, { existingImage: true }), []).outcome === "quarantined");
  check("a picture check that said yes cannot override a contradicting title", decideFiling("Xbox Series S", ev(SRC, { picture: { verdict: "yes" } }), []).outcome === "rejected");
  check("game cases are refused for the console", decideFiling("Nintendo Switch", ev("Metroid Dread - Nintendo Switch (game case)"), []).outcome === "rejected");
  check("a person's own photo is always kept", decideFiling("Xbox Series S", ev(null, { userAuthored: true, sourceKind: "user" }), []).outcome === "user");
  check("a picture check 'yes' with no objection is trusted", decideFiling("Xbox Series S", ev(null, { picture: { verdict: "yes" } }), []).outcome === "trusted");
  check("'no' from the picture is a refusal", decideFiling("Xbox Series S", ev("Xbox Series S console", { picture: { verdict: "no" } }), []).outcome === "rejected");
  check("'cannot tell' is unverified, not trusted", decideFiling("Xbox Series S", ev("Xbox Series S console", { picture: { verdict: "cannot_tell" } }), []).outcome === "unverified");
  check("no picture check + exact title = trusted", decideFiling("Xbox Series S 512GB", ev("Microsoft Xbox Series S 512GB console"), []).outcome === "trusted");
  check("no picture check + a title that leaves the colour of a colour-named entry open = unverified", decideFiling("Xbox Series S (Black)", ev("Microsoft Xbox Series S console"), []).outcome === "unverified");
  check("no words and no picture check = not stored", decideFiling("Xbox Series S", ev(null), []).outcome === "rejected");
  check("...unless it is a deliberate untitled search", decideFiling("Xbox Series S", ev(null, { allowUntitled: true }), []).outcome === "unverified");
  check("a second card design is set aside, a same-design photo is fine", decideFiling("MSI RTX 2070 SUPER", ev("MSI RTX 2070 SUPER Gaming X Trio"), ["MSI GeForce RTX 2070 SUPER Ventus OC"]).outcome === "quarantined" && decideFiling("MSI RTX 2070 SUPER", ev("MSI RTX 2070 SUPER Ventus 3X"), ["MSI GeForce RTX 2070 SUPER Ventus OC"]).outcome === "trusted");
  check("a disc console photo is set aside in an all-digital gallery", decideFiling("Xbox Series X", ev("Xbox Series X 1TB Disc Drive Carbon Black"), ["Xbox Series X All-Digital Robot White 1TB"]).outcome === "quarantined");

  section("fileImage on a real Store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b13-fi-"));
  const store = new Store(path.join(dir, "scout.db"));
  const mk = (id: string, name: string) => { store.addProductStub(id, name); return id; };
  const s = mk("s", "Xbox Series S"), sw = mk("sw", "Nintendo Switch"), gpu = mk("g", "MSI RTX 2070 SUPER");
  const r1 = fileImage(store, s, pic("A1"), ev(SRC));
  check("Series X photo into Series S: refused and NOT stored", r1.outcome === "rejected" && store.listProductImages(s).length === 0);
  const r2 = fileImage(store, sw, pic("A2"), ev("Metroid Dread - Nintendo Switch (game case)"));
  check("game case into the Switch gallery: refused", r2.outcome === "rejected" && store.listProductImages(sw).length === 0);
  const r3 = fileImage(store, sw, pic("A3"), ev("Nintendo Switch Console Neon Blue Red Joy-Con 32GB HAC-001"));
  check("a real Switch console title is accepted (no longer mistaken for an accessory)", r3.outcome === "trusted" && store.listProductImages(sw).length === 1, r3);
  check("a console bundle title is accepted as a console photo", fileImage(store, sw, pic("A4"), ev("Nintendo Switch with 2 games and charger HAC-001 32GB")).outcome !== "rejected");
  const g1 = fileImage(store, gpu, pic("G1"), ev("MSI GeForce RTX 2070 SUPER Ventus OC 8GB"));
  const g2 = fileImage(store, gpu, pic("G2"), ev("MSI RTX 2070 SUPER Gaming X Trio"));
  check("the first MSI design establishes the gallery; a different design is quarantined", g1.outcome === "trusted" && g2.outcome === "quarantined" && g2.image?.status === "quarantined");
  check("...with a review item that names the reason", store.listReviewItems().some((i) => i.subjectId === g2.image?.id && /design/.test(i.reasons.join(" "))));
  check("a quarantined photo is not offered as a reference", (store.listProductsWithImages(10).find((x) => x.product.id === gpu)?.images ?? []).every((i) => i.id !== g2.image?.id));
  check("the same picture twice is a duplicate", fileImage(store, gpu, pic("G1"), ev("MSI GeForce RTX 2070 SUPER Ventus OC 8GB")).outcome === "duplicate" && store.listProductImages(gpu).length === 2);
  const u = fileImage(store, gpu, pic("U1"), ev(null, { userAuthored: true, sourceKind: "user" }));
  check("a user photo is kept as 'user'", u.image?.status === "user");

  section("modes");
  const shadow = fileImage(store, s, pic("S1"), ev(SRC), { mode: "shadow" });
  check("shadow records the decision but stores it the way it always was (legacy)", shadow.outcome === "rejected" && shadow.image?.status === "legacy");
  const off = fileImage(store, s, pic("S2"), ev(SRC), { mode: "off" });
  check("off does no checking at all", off.image?.status === "legacy");

  section("the reference-search path (topUpReferencePhotos) goes through the gate");
  const t = mk("t", "Xbox Series S 512GB");
  const result = await topUpReferencePhotos({
    store: store as never, id: t, name: "Xbox Series S 512GB", want: 4, limit: 20,
    find: async () => ({ examined: 3, photos: [
      { imageData: pic("T1"), label: "eBay listing: Microsoft Xbox Series S 512GB White", text: "Microsoft Xbox Series S 512GB White", verified: true },
      { imageData: pic("T2"), label: "eBay listing: Xbox Series X 1TB", text: "Xbox Series X 1TB", verified: true },
      { imageData: pic("T3"), label: "Image search — example.com", text: null, verified: false },
    ] }),
  });
  check("only the photo whose words and picture agree is saved", result.added === 1 && store.listProductImages(t).length === 1 && store.listProductImages(t)[0].status === "trusted", result);

  section("repo rule: nothing but the Store and fileImage writes a picture");
  const root = process.cwd(); // the test runner runs from the repository root
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(f); continue; }
      if (!/\.(ts|tsx)$/.test(e.name) || /^(store|fileImage)\.ts$/.test(e.name)) continue;
      const text = fs.readFileSync(f, "utf8");
      if (/[.\s]addProductImage\(/.test(text.replace(/\/\/.*$/gm, ""))) offenders.push(path.relative(root, f));
    }
  };
  walk(path.join(root, "src", "main"));
  check("no other module calls addProductImage( directly", offenders.length === 0, offenders);
  fs.rmSync(dir, { recursive: true, force: true });
});
