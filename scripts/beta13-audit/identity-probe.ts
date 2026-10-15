// Beta 13 audit — DIAGNOSTIC probe, not a test: it prints what today's identity code says about the screenshot cases (no assertions, no I/O, no network).
import { judgeCandidateByText, listingMayFeedProduct, fileableWithoutPicture } from "../../src/main/photoIdentity.js";
import { classifyComparable } from "../../src/main/compIdentity.js";
import { isSimilarProductName } from "../../src/main/store.js";
import { listingHasExtraDetail } from "../../src/main/productIdentity.js";
import { editionConflict, distinguishingTokens, findParentCandidate, extractVariantAttributes } from "../../src/main/variantIdentity.js";
import { kindOfName } from "../../src/main/productKind.js";

const line = (s = "") => console.log(s);
const j = (product: string, title: string) => {
  const v = judgeCandidateByText(product, title);
  const c = classifyComparable({ name: product }, title);
  return `text=${v.status}/${v.strength} comp=${c.verdict}[${c.reasons.map((r) => r.code).join(",")}] feedsProduct=${listingMayFeedProduct(product, title)} fileableNoPic=${fileableWithoutPicture(v)}`;
};

line("== A. white Series X photo, source title says Series X; which gallery would accept it?");
const A_TITLE = "MICROSOFT XBOX SERIES X - CONSOLE - 1TB - 1882 (G4P004519)";
for (const p of ["Xbox Series S", "Xbox Series S (White)", "Xbox Series S 512GB", "Xbox Series X", "Xbox Series X (White)", "Xbox Series", "Xbox", "Microsoft Xbox Series X 1TB Console"]) {
  line(`  product "${p}" vs title -> ${j(p, A_TITLE)}  similarName=${isSimilarProductName(p, A_TITLE)}`);
}
line("  title-less candidate (image search result) vs Series S: " + JSON.stringify(judgeCandidateByText("Xbox Series S", null)));
line("  listingHasExtraDetail(title, 'Xbox Series S (White)') = " + listingHasExtraDetail(A_TITLE, "Xbox Series S (White)"));

line("\n== B. Series X configurations: do they conflate?");
const X = [
  "Microsoft Xbox Series X 1TB Carbon Black Console with disc drive",
  "Microsoft Xbox Series X 1TB Robot White All-Digital Console",
  "Microsoft Xbox Series X 2TB Galaxy Black Special Edition Console",
  "Microsoft Xbox Series X Halo Infinite Limited Edition 1TB Console",
  "Xbox Series X",
];
for (let a = 0; a < X.length; a++) for (let b = a + 1; b < X.length; b++) {
  const c = classifyComparable({ name: X[a] }, X[b]);
  line(`  [${a}] vs [${b}]  similarName=${isSimilarProductName(X[a], X[b])}  comp=${c.verdict}[${c.reasons.map((r) => r.code).join(",")}]  editionConflict=${editionConflict(X[a], X[b])}`);
}
line("  attributes: " + X.map((n, i) => `[${i}]=${JSON.stringify(extractVariantAttributes(n))}`).join(" | "));
line("  generic title vs each configuration (comp verdict of 'Xbox Series X 1TB' as the entry):");
for (const t of X.slice(0, 4)) line(`    ${j("Xbox Series X 1TB", t)}  <- ${t}`);
line("  disc vs digital: " + j("Xbox Series X", "Xbox Series X All-Digital Edition no disc drive") + " | " + j("Xbox Series X 1TB Carbon Black Console with disc drive", "Xbox Series X 1TB Robot White All-Digital Console"));

line("\n== C. Nintendo Switch gallery candidates");
for (const t of [
  "Nintendo Switch Console Neon Blue Red Joy-Con 32GB HAC-001",
  "Nintendo Switch Lite Turquoise",
  "Nintendo Switch OLED Model White",
  "Metroid Dread - Nintendo Switch",
  "Metroid Prime Remastered Nintendo Switch Game Case",
  "Nintendo Switch Metroid Dread Special Edition Console",
  "Nintendo Switch Joy-Con Controller Pair",
  "Nintendo Switch Dock Set",
  "Super Mario Odyssey (Nintendo Switch)",
  "Nintendo Switch Carrying Case Pouch",
]) line(`  "Nintendo Switch" vs "${t}" -> ${j("Nintendo Switch", t)}  kind=${kindOfName(t)}`);

line("\n== D. MSI RTX 2070 SUPER, different cards");
const MSI = ["MSI GeForce RTX 2070 SUPER Gaming X Trio 8GB", "MSI GeForce RTX 2070 SUPER Ventus OC 8GB", "MSI RTX 2070 Super Armor OC", "MSI GeForce RTX 2070 SUPER 8GB GDDR6 Graphics Card", "EVGA RTX 2070 SUPER XC Ultra"];
for (const t of MSI) {
  line(`  entry "MSI RTX 2070 SUPER" vs "${t}" -> ${j("MSI RTX 2070 SUPER", t)}`);
}
for (let a = 0; a < MSI.length; a++) for (let b = a + 1; b < MSI.length; b++) line(`  [${a}] vs [${b}] similarName=${isSimilarProductName(MSI[a], MSI[b])} comp=${classifyComparable({ name: MSI[a] }, MSI[b]).verdict}`);
line("  entry 'MSI RTX 2070 SUPER' and listingHasExtraDetail (Ventus OC title) = " + listingHasExtraDetail(MSI[1], "MSI GeForce RTX 2070 SUPER 8GB Graphics Card"));
line("  parent candidate for a Gaming X Trio name: " + JSON.stringify(findParentCandidate(MSI[0], [{ name: "MSI GeForce RTX 2070 SUPER" }, { name: "NVIDIA GeForce RTX 2070 SUPER" }])));
line("  distinguishing tokens: " + JSON.stringify(distinguishingTokens(MSI[0], "MSI GeForce RTX 2070 SUPER")));

line("\n== E. Accessory / non-console titles: does the COMPARABLE-SALE model (used for valuation) and the photo gate agree? (console entry 'Nintendo Switch')");
for (const t of ["Nintendo Switch Carrying Case Pouch", "Nintendo Switch Screen Protector Tempered Glass", "Nintendo Switch Charger AC Adapter", "Nintendo Switch Console Stand", "Nintendo Switch Joy-Con Grip", "Nintendo Switch Pro Controller", "Nintendo Switch HDMI Cable", "Nintendo Switch Skin Decal", "Nintendo Switch Console Neon Blue Red (Joy-Con included)", "Nintendo Switch Console with Dock and Joy-Con Controllers HAC-001"]) {
  line(`  "${t}" -> ${j("Nintendo Switch", t)}`);
}
line("\n== F. Hardware configuration attributes the identity model cannot see: optical drive, region, board design, storage-less");
for (const [a, b] of [["PlayStation 5 Disc Edition", "PlayStation 5 Digital Edition"], ["Xbox Series X", "Xbox Series X All-Digital no disc drive"], ["Xbox Series X", "Xbox Series X Disc Drive 1TB"], ["MSI RTX 2070 SUPER Gaming X Trio", "MSI RTX 2070 SUPER Ventus OC"], ["iPhone 13 128GB Unlocked", "iPhone 13 128GB Verizon locked"], ["Nintendo Switch HAC-001", "Nintendo Switch HAC-001(-01) V2 battery"], ["Nintendo Switch Japan Import", "Nintendo Switch US"]] as const) {
  const c = classifyComparable({ name: a }, b);
  line(`  "${a}" vs "${b}" -> ${c.verdict}[${c.reasons.map((r) => r.code).join(",")}] edition conflict=${editionConflict(a, b)}`);
}
