// Beta 13 WP2: best-match resolution (audit ID-03). The subjects are the real ones from store-probe section 1 and the owner's database (Appendix B).
import { resolveProduct, type ResolveCandidate } from "../productResolver.js";
import { galleryConflict, extractIdentityAttributes, attributeFindings } from "../identityModel.js";
import { check, run, section } from "./_testkit.js";

const mk = (names: string[]): ResolveCandidate[] => names.map((n, i) => ({ id: "p" + i, name: n }));
const nameOf = (subject: string, names: string[]) => resolveProduct(subject, mk(names)).best?.name ?? null;
const status = (subject: string, names: string[]) => resolveProduct(subject, mk(names)).status;

run(() => {
  const XBOX = ["Xbox Series", "Xbox Series X", "Xbox Series S", "Xbox Series S (Black)", "Xbox Wireless Controller", "Xbox One X"];
  const SWITCH = ["Nintendo Switch", "Nintendo Switch Lite", "Nintendo Switch OLED", "Super Mario Odyssey (Nintendo Switch)"];

  section("a generic entry never absorbs a model-level name; the specific entry wins");
  check("Xbox Series S (White) -> Xbox Series S (not the generic one)", nameOf("Xbox Series S (White)", XBOX) === "Xbox Series S", resolveProduct("Xbox Series S (White)", mk(XBOX)));
  check("Xbox Series X (White) -> Xbox Series X", nameOf("Xbox Series X (White)", XBOX) === "Xbox Series X");
  check("Xbox Series X 1TB Carbon Black -> Xbox Series X", nameOf("Xbox Series X 1TB Carbon Black", XBOX) === "Xbox Series X");
  check("with ONLY the generic entry, a Series S name is unresolved and the generic one is only a parent suggestion", status("Xbox Series S (White)", ["Xbox Series"]) === "unresolved" && resolveProduct("Xbox Series S (White)", mk(["Xbox Series"])).parentSuggestion?.name === "Xbox Series");
  check("a black Series S entry does not take a white one", nameOf("Xbox Series S (White)", ["Xbox Series S (Black)"]) === null);
  check("a stated colour entry beats the plain one for that colour", nameOf("Xbox Series S (Black)", ["Xbox Series S", "Xbox Series S (Black)"]) === "Xbox Series S (Black)");

  section("games and accessories never resolve to the console");
  for (const s of ["Metroid Dread (Nintendo Switch)", "Nintendo Switch Dock", "Nintendo Switch Joy-Con Pair", "Nintendo Switch Game Case", "Halo Infinite (Xbox Series X)", "Xbox Series X Controller", "Forza Horizon 5 Xbox Series X", "Power cable for Xbox Series S"]) {
    const n = nameOf(s, [...XBOX, ...SWITCH]);
    check(`"${s}" is not a console (resolved: ${n})`, n === null || !/^(Nintendo Switch|Xbox Series [XS]?)( \(Black\))?$/.test(n), n);
  }
  check("the Super Mario game name resolves to the game entry", nameOf("Super Mario Odyssey Nintendo Switch", SWITCH) === "Super Mario Odyssey (Nintendo Switch)");

  section("tiers and models");
  check("Nintendo Switch OLED name -> OLED entry, never the base one", nameOf("Nintendo Switch OLED Model White", SWITCH) === "Nintendo Switch OLED");
  check("Nintendo Switch Lite name -> Lite entry", nameOf("Nintendo Switch Lite Turquoise", SWITCH) === "Nintendo Switch Lite");
  check("plain Switch name -> plain entry", nameOf("Nintendo Switch Console Neon", SWITCH) === "Nintendo Switch");
  check("an exact name wins at once", nameOf("xbox series s", XBOX) === "Xbox Series S");

  section("hardware configuration attributes (identityModel)");
  const f = (ref: string, title: string) => attributeFindings(ref, title).map((x) => x.code);
  check("Series X vs its All-Digital version is a DRIVE difference", f("Xbox Series X", "Xbox Series X All-Digital no disc drive").includes("DRIVE"));
  check("the Series S 'Digital Edition' is NOT a contradiction (digital-only by design)", !f("Xbox Series S", "Xbox Series S Digital Edition").includes("DRIVE"));
  check("PS5 disc vs digital", f("PlayStation 5 Disc Edition", "PlayStation 5 Digital Edition").includes("DRIVE"));
  check("MSI Gaming X Trio vs Ventus is a BOARD_DESIGN difference", f("MSI RTX 2070 SUPER Gaming X Trio", "MSI RTX 2070 SUPER Ventus OC").includes("BOARD_DESIGN"));
  check("a generic GPU entry does not object to a design", f("MSI RTX 2070 SUPER", "MSI GeForce RTX 2070 SUPER Ventus OC 8GB").length === 0);
  check("a non-GPU 'dual' or 'pulse' is not a card design", extractIdentityAttributes("Dual Shock pulse headset").boardDesigns.length === 0);
  check("region: Japan import vs US", f("Nintendo Switch US", "Nintendo Switch Japan Import").includes("REGION") && f("Nintendo Switch", "Nintendo Switch Japanese version").includes("REGION"));
  check("carrier lock vs unlocked", f("iPhone 13 128GB Unlocked", "iPhone 13 128GB Verizon").includes("LOCK"));
  check("manufacturer code with another number", f("Nintendo Switch HAC-001", "Nintendo Switch HAC-002").includes("SKU") && !f("Nintendo Switch HAC-001", "Nintendo Switch HAC-001(-01)").includes("SKU"));

  section("a gallery stays consistent (audit: two different MSI cards in one entry)");
  const ventus = ["MSI GeForce RTX 2070 SUPER Ventus OC 8GB"];
  check("a Gaming X Trio photo is refused into a Ventus gallery", /card design/.test(galleryConflict(ventus, "MSI RTX 2070 SUPER Gaming X Trio") ?? ""));
  check("a second Ventus photo is fine", galleryConflict(ventus, "MSI RTX 2070 SUPER Ventus 3X") === null);
  check("a disc photo is refused into an all-digital gallery", /drive/.test(galleryConflict(["Xbox Series X All-Digital 1TB"], "Xbox Series X 1TB Disc Drive") ?? ""));
  check("a different capacity is refused", /capacity/.test(galleryConflict(["Xbox Series X 1TB"], "Xbox Series X 2TB") ?? ""));
  check("nothing stated on one side is no conflict", galleryConflict(["Xbox Series X"], "Xbox Series X 1TB Disc Drive") === null && galleryConflict([], "anything") === null);
});
