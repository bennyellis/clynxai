// Universal comparable-sale identity validation (compIdentity.ts): a WatchCount sale or an eBay listing is only used for a price after its title has been
// compared with the identity of the product being priced. Phones, consoles, computers, appliances, collectibles, accessories, bundles, special editions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyComparable, describeSummary, listingContradictsEntry, usableForValuation, type CompVerdict } from "../compIdentity.js";
import { Store } from "../store.js";
import { analyzeEbayComps, type EbayComp } from "../watchcount.js";
import { check, run, section } from "./_testkit.js";

function verdictOf(name: string, title: string, extra: { query?: string; sourceTitle?: string; requiredTerms?: string[] } = {}): CompVerdict {
  return classifyComparable({ name, ...extra }, title).verdict;
}
function expectV(name: string, title: string, want: CompVerdict | CompVerdict[], extra: Parameters<typeof verdictOf>[2] = {}): void {
  const got = classifyComparable({ name, ...extra }, title);
  const wants = Array.isArray(want) ? want : [want];
  check(`${name}  vs  "${title}"  ->  ${wants.join("/")}`, wants.includes(got.verdict), { got: got.verdict, why: got.reasons.map((r) => r.code) });
}
const comp = (title: string, price: number): EbayComp => ({ title, priceUsd: price, shippingUsd: 0, runTimeDays: 3, condition: "Used", imageUrl: null }) as EbayComp;

run(async () => {
  section("phones: the iPhone 14 mixed into an iPhone 16 search");
  const P16 = "Apple iPhone 16 Pro 256GB";
  expectV(P16, "Apple iPhone 16 Pro 256GB Unlocked", "exact");
  expectV(P16, "iPhone 14 Pro 256GB Unlocked", "rejected");
  expectV(P16, "iPhone14 Pro 256GB", "rejected");
  expectV(P16, "iPhone 15 Pro 256GB", "rejected");
  expectV(P16, "iPhone 16 Pro Max 256GB", "rejected");
  expectV(P16, "iPhone 16 256GB", "rejected");
  expectV(P16, "iPhone 16 Pro 128GB", "rejected");
  expectV(P16, "iPhone 16 Pro Unlocked", "uncertain");
  expectV(P16, "iPhone 15/16 Pro 256GB lot", "rejected");
  expectV(P16, "Apple iPhone 15 or 16 Pro 256GB", ["uncertain", "rejected"]);
  expectV(P16, "Clear case for iPhone 16 Pro 256GB", "rejected");
  expectV(P16, "iPhone 14 case compatible with iPhone 16 Pro 256GB", "rejected");
  expectV(P16, "iPhone 16 Pro 256GB Screen Protector", "rejected");
  expectV(P16, "iPhone 16 Pro 256GB for parts, not working", "rejected");
  expectV("Apple iPhone 16 Pro", "iPhone 16 Pro 256GB", "compatible");
  expectV("Samsung Galaxy S24 Ultra 512GB", "Samsung Galaxy S23 Ultra 512GB", "rejected");
  expectV("Samsung Galaxy S24 Ultra 512GB", "Samsung Galaxy S24 512GB", "rejected");
  expectV("Samsung Galaxy S24 Ultra 512GB", "Samsung Galaxy S24 Ultra 512GB Titanium Black", "exact");
  expectV("Google Pixel 8 Pro 128GB", "Google Pixel 7 Pro 128GB", "rejected");

  section("consoles");
  expectV("Xbox Series S 512GB", "Xbox Series X 1TB Console", "rejected");
  expectV("Xbox Series X", "Xbox One X 1TB Console", "rejected");
  expectV("Xbox Series X", "Microsoft Xbox Series X 1TB Console Black", ["exact", "compatible"]);
  expectV("Xbox Series X", "Xbox Series S 512GB", "rejected");
  expectV("PlayStation 5 Slim Digital", "PS5 Slim Digital Edition 1TB Console", ["exact", "compatible"]);
  expectV("PlayStation 5 Slim Digital", "PlayStation 4 Slim 1TB", "rejected");
  expectV("PS5 Pro", "PS5 Slim 1TB", "rejected");
  expectV("PS5 Slim", "PS5 Pro 2TB", "rejected");
  expectV("Nintendo Switch OLED", "Nintendo Switch Lite Turquoise", "rejected");
  expectV("Nintendo Switch", "Nintendo Switch OLED Model White", "rejected");
  expectV("Xbox Series S Black", "Xbox Series S Robot White 512GB", "rejected");
  expectV("Steam Deck 512GB", "Steam Deck OLED 512GB", "rejected");

  section("computers");
  expectV("MacBook Air M2 256GB", "Apple MacBook Air M1 256GB 2020", "rejected");
  expectV("MacBook Air M2 256GB", "Apple MacBook Air M2 256GB 8GB", "rejected");
  expectV("Dell XPS 13 9310 512GB", "Dell XPS 15 9510 512GB", "rejected");
  expectV("NVIDIA GeForce RTX 3060 Ti", "RTX 3060 12GB graphics card", "rejected");
  expectV("NVIDIA GeForce RTX 3060", "RTX 3070 8GB graphics card", "rejected");
  expectV("NVIDIA GeForce RTX 3060", "EVGA GeForce RTX 3060 12GB", ["exact", "compatible", "rejected"]);
  expectV("iPad Air 5th generation 64GB", "iPad Air 4th generation 64GB", "rejected");
  expectV("iPad Air 5th generation 64GB", "iPad Air 5th Gen 64GB WiFi", ["exact", "compatible"]);

  section("appliances");
  expectV("Dyson V8 Absolute", "Dyson V10 Absolute Cordless Vacuum", "rejected");
  expectV("Dyson V8 Absolute", "Dyson V8 Absolute Cordless Vacuum Cleaner", ["exact", "compatible"]);
  expectV("Instant Pot Duo 6 Quart", "Instant Pot Duo 8 Quart Pressure Cooker", "rejected");
  expectV("Instant Pot Duo 6 Quart", "Instant Pot Duo 6 Qt Pressure Cooker", ["exact", "compatible", "uncertain"]);
  expectV("KitchenAid Artisan Stand Mixer", "KitchenAid Artisan Stand Mixer 5 Qt Empire Red", ["exact", "compatible"]);

  section("collectibles");
  expectV("Funko Pop Batman 01", "Funko Pop Batman 02", "rejected");
  expectV("Funko Pop Batman 01", "Funko Pop! Batman #01 DC Heroes", ["exact", "compatible"]);
  expectV("Pokemon Charizard Base Set Holo 1st Edition", "Pokemon Charizard Base Set Holo 2nd Edition", "rejected");
  expectV("Pokemon Charizard Base Set Holo 1st Edition", "Pokemon Charizard Base Set Holo Unlimited", ["uncertain", "rejected"]);

  section("accessories are not the product, and the product is not the accessory");
  expectV("Xbox Wireless Controller Carbon Black", "Xbox Wireless Controller Robot White", "rejected");
  expectV("Xbox Wireless Controller Carbon Black", "Xbox Series X 1TB Console", ["uncertain", "rejected"]);
  expectV("Xbox Series X", "Xbox Series X Wireless Controller Carbon Black", "rejected");
  expectV("Apple AirPods Pro 2nd Generation", "AirPods Pro 1st Gen", "rejected");
  expectV("Apple AirPods Pro 2nd Generation", "AirPods Pro 2nd Generation Charging Case Replacement", "rejected");
  expectV("Apple AirPods Pro 2nd Generation", "Apple AirPods Pro 2nd Generation MagSafe USB-C", ["exact", "compatible"]);
  expectV("PlayStation 5 DualSense Controller", "PS5 DualSense Controller White", ["exact", "compatible"]);
  expectV("Sony WH-1000XM4", "Sony WH-1000XM5 Headphones", ["rejected", "uncertain"]);

  section("bundles and lots are not the single product");
  expectV("PlayStation 5 Slim", "PS5 Slim + 2 controllers bundle", "rejected");
  expectV("PlayStation 5 Slim", "Lot of 3 PS5 Slim consoles", "rejected");
  expectV("PlayStation 5 Slim", "PS5 Slim 2-pack", "rejected");
  expectV("PlayStation 5 Slim bundle with 2 controllers", "PS5 Slim bundle with 2 controllers", ["exact", "compatible"]);

  section("special editions");
  expectV("Xbox Series X 2TB Galaxy Black Special Edition", "Microsoft Xbox Series X 2TB Black Console", "rejected");
  expectV("Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X 2TB Galaxy Black Special Edition Console", ["exact", "compatible"]);
  expectV("Xbox Series X 1TB", "Xbox Series X 1TB Halo Infinite Limited Edition", "rejected");
  expectV("Nintendo Switch OLED Zelda Edition", "Nintendo Switch OLED White Console", "rejected");

  section("missing information is uncertainty, not a mismatch; a stated difference is a mismatch");
  expectV("Apple iPhone 16 Pro 256GB", "iPhone 16 Pro", "uncertain");
  expectV("Apple iPhone 16 Pro 256GB Blue", "Apple iPhone 16 Pro 256GB", "compatible");
  expectV("Apple iPhone 16 Pro 256GB Blue", "Apple iPhone 16 Pro 256GB Black", "rejected");
  check("only exact and compatible are used for a value", usableForValuation("exact") && usableForValuation("compatible") && !usableForValuation("uncertain") && !usableForValuation("rejected"));

  section("the loose search query cannot let a contradicting title through (the product's name still has to hold)");
  expectV("Apple iPhone 16 Pro", "iPhone 14 Pro 256GB", "rejected", { query: "iPhone Pro 256GB" });
  expectV("Apple iPhone 16 Pro", "iPhone 16 Pro Max 256GB", "rejected", { query: "iPhone 16 Pro Max 256GB" });
  expectV("Apple iPhone 16 Pro", "iPhone 16 Pro 256GB", ["exact", "compatible"], { query: "iPhone 16 Pro 256GB" });
  section("the Marketplace listing states what the name leaves open");
  expectV("Apple iPhone 16 Pro", "iPhone 16 Pro 128GB", "rejected", { sourceTitle: "iPhone 16 Pro 256GB blue titanium unlocked" });
  expectV("Apple iPhone 16 Pro", "iPhone 16 Pro 256GB", ["exact", "compatible"], { sourceTitle: "iPhone 16 Pro 256GB blue titanium unlocked" });
  expectV("Apple iPhone 16 Pro", "iPhone 16 Pro", "uncertain", { sourceTitle: "iPhone 16 Pro 256GB blue titanium unlocked" });

  section("results are counted and explained; only verified comps price the product");
  {
    const results: EbayComp[] = [
      ...[780, 790, 800, 810, 795].map((p) => comp("Apple iPhone 16 Pro 256GB Unlocked", p)),
      ...[500, 510, 520, 505].map((p) => comp("Apple iPhone 14 Pro 256GB Unlocked", p)),
      ...[430, 440].map((p) => comp("iPhone 15 Pro 256GB", p)),
      ...[880, 890].map((p) => comp("iPhone 16 Pro Max 256GB", p)),
      comp("Clear Case for iPhone 16 Pro 256GB", 12),
      comp("iPhone 16 Pro", 700),
      comp("iPhone 16 Pro 128GB", 650),
    ];
    const a = await analyzeEbayComps("iPhone 16 Pro 256GB", results, "Apple iPhone 16 Pro 256GB");
    const v = a.validation!;
    check("every result is accounted for", v.retrieved === results.length && v.exact + v.compatible + v.uncertain + v.rejected === results.length, v);
    check("5 accepted, 1 uncertain, the rest rejected", v.exact + v.compatible === 5 && v.uncertain === 1 && v.rejected === results.length - 6, v);
    check("the price is the iPhone 16 Pro 256GB's, not a blend with the 14, 15 or Pro Max", a.sampleSize === 5 && Math.round(a.avgSoldPriceUsd ?? 0) === 795, { n: a.sampleSize, avg: a.avgSoldPriceUsd });
    check("reasons are recorded", (v.reasons.MODEL_NUMBER ?? 0) >= 6 && (v.reasons.TIER ?? 0) >= 2 && (v.reasons.CAPACITY ?? 0) >= 1 && (v.reasons.ACCESSORY ?? 0) >= 1, v.reasons);
    console.log("  " + describeSummary("Sold results", v));
    check("and described for the log", /retrieved 16, accepted 5 \(5 exact, 0 compatible\), uncertain 1, rejected 10/.test(describeSummary("Sold results", v)) && /model number x/.test(describeSummary("Sold results", v)), describeSummary("Sold results", v));

    const onlyWrong = await analyzeEbayComps("iPhone 16 Pro 256GB", results.filter((r) => /14|15/.test(r.title)), "Apple iPhone 16 Pro 256GB");
    check("with only another model's sales there is NO value (no silent fallback)", onlyWrong.sampleSize === 0 && onlyWrong.avgSoldPriceUsd === null && onlyWrong.validation!.rejected === 6, onlyWrong);
    check("and the validation says why", (onlyWrong.validation!.reasons.MODEL_NUMBER ?? 0) === 6);
  }

  section("a listing is not valued from an entry whose identity its title contradicts");
  {
    check("iPhone 14 title vs iPhone 16 Pro entry", !!listingContradictsEntry("Apple iPhone 16 Pro", "iPhone 14 Pro 256GB used"));
    check("Series S title vs Series X entry", !!listingContradictsEntry("Xbox Series X", "Xbox Series S 512GB"));
    check("special edition title vs standard entry", !!listingContradictsEntry("Xbox Series X 1TB", "Xbox Series X 1TB Halo Limited Edition"));
    check("a listing of the entry itself is fine", listingContradictsEntry("Apple iPhone 16 Pro", "iPhone 16 Pro 256GB unlocked works great") === null);
    check("a bundle listing of the console is not a contradiction (its value is priced from the console's)", listingContradictsEntry("Xbox Series X", "Xbox Series X 1TB with 2 controllers and 8 games") === null);
    check("missing information is not a contradiction", listingContradictsEntry("Apple iPhone 16 Pro 256GB", "iPhone 16 Pro") === null);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-compid-"));
    const store = new Store(path.join(dir, "scout.db"));
    const id = store.addProductStub("p16", "Apple iPhone 16 Pro");
    store.updateProductProfile(id, { aiSummary: "x", category: "Phones & Tablets", family: "Apple", imageUrl: null });
    store.updateProductEbayComps(id, { avgSoldPriceUsd: 780, avgRunTimeDays: 3, avgShippingUsd: 0, sampleSize: 8, estimatedValueUsd: 780, estimateBasis: "sold", identity: "exact" });
    check("the entry's own listing is valued", store.getEbayValueForProductName("Apple iPhone 16 Pro", "Apple iPhone 16 Pro 256GB unlocked") === 780);
    check("an iPhone 14 listing matched to it is NOT valued at $780", store.getEbayValueForProductName("Apple iPhone 16 Pro", "Apple iPhone 14 Pro 256GB unlocked") === null);
    check("its signals are not offered either", store.getProductSignals("Apple iPhone 16 Pro", "Apple iPhone 14 Pro 256GB unlocked") === null);
    check("by title, the 14 gets nothing from the 16", store.getEbayValueForTitle("Apple iPhone 14 Pro 256GB") === null);
    check("by title, the 16 does", store.getEbayValueForTitle("Apple iPhone 16 Pro 256GB")?.value === 780);
    store.setProductCompsValidation(id, { at: 1, sold: { retrieved: 3, exact: 1, compatible: 0, uncertain: 0, rejected: 2, reasons: { MODEL_NUMBER: 2 }, examples: [] }, active: null });
    check("the validation is kept with the product and read back", store.getProductById(id)?.compsValidation?.sold?.rejected === 2);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
