// Phase 4 stage 1.1: an identifier in a listing title only matters when evidence shows it is a real model / version marker. Inventory codes, ordinals,
// prices and the like must not downgrade a listing or start research, and genuinely different products must stay protected. Categories are mixed on purpose.
import { aliasCovered, definingCodes } from "../identity/codes.js";
import { assessCodes, CodeIndex, specificResearchName, type EvidenceDoc } from "../identity/credibility.js";
import { check, run, section } from "./_testkit.js";

let n = 0;
const prod = (name: string): EvidenceDoc => ({ text: name, origin: `product:p${++n}`, kind: "product" });
const listing = (title: string, seller: string): EvidenceDoc => ({ text: title, origin: `seller:${seller}`, kind: "listing" });
const photo = (title: string): EvidenceDoc => ({ text: title, origin: `title:${title.toLowerCase()}`, kind: "photo" });
const assess = (entry: string, title: string, docs: EvidenceDoc[], extra: { independentTexts?: string[]; seller?: string } = {}) =>
  assessCodes({ entryId: "entry", entryName: entry, title, index: new CodeIndex(docs), ...extra });
const credible = (a: ReturnType<typeof assess>) => a.credible.map((c) => c.code).join();
const unverified = (a: ReturnType<typeof assess>) => a.unverified.map((c) => c.code).join();

// A Database like the real one: a lot of entries that mention "360", the iPhone 16e entry, game entries that name their platform, one-off seller listings.
const database: EvidenceDoc[] = [
  prod("Xbox Wireless Controller"), prod("Xbox Series S"), prod("Xbox Series S 512GB"), prod("PlayStation 5 Slim"), prod("iPhone 16"), prod("iPhone 16e"),
  prod("Fallout: New Vegas (Xbox 360)"), prod("Battlefield 3 (Xbox 360)"), prod("Homefront (Xbox 360)"), prod("Xbox 360 Slim"),
  prod("NBA 2K27 (PS5)"), prod("Pokémon Y (Nintendo 3DS)"),
  listing("Xbox 360 controller used", "ann"), listing("Microsoft Xbox 360 wireless controller", "bob"),
];

run(() => {
  section("the nine cases found in the Stage 0b shadow run");
  {
    const entryXboxS = "Xbox Series S";
    const cases: Array<[string, string, string, "credible" | "unverified" | "dismissed" | "none"]> = [
      ["Xbox Series X", "Xbox Series X 1TB Complete Console Bundle 2 Controllers 8 Games Resident Evil 7 Friday the 13th", "13th", "none"],
      ["iPhone 16", "iPhone 16e", "16e", "credible"],
      ["Xbox Series S 512GB", "Xbox Series S 512GB Console O1766", "o1766", "unverified"],
      ["Xbox Series S (Black) 1TB", "Xbox Series S 1TB Black Unlocked T3586", "t3586", "unverified"],
      [entryXboxS, "Xbox Series S JTM7-CE", "jtm7", "unverified"],
      [entryXboxS, "Xbox Series S Console Z7UX", "z7ux", "unverified"],
      ["Xbox Series S (White)", "Xbox Series S White D6306", "d6306", "unverified"],
      [entryXboxS, "NBA 2k27 xbox series s with 2k27 2 builds 95 overall and mlb the show 26", "2k27", "unverified"],
      ["PlayStation 5 Slim", "Playstation 5 PS5 848GB Digital Edition Slim Console For Sale", "ps5", "dismissed"],
    ];
    for (const [entry, title, code, want] of cases) {
      const a = assess(entry, title, database);
      const got = a.credible.some((c) => c.code === code) ? "credible" : a.unverified.some((c) => c.code === code) ? "unverified" : a.dismissed.some((c) => c.code === code) ? "dismissed" : "none";
      check(`${code.padEnd(6)} in "${title.slice(0, 44)}" -> ${want}`, got === want, a);
    }
    check("only the real new model (16e) is credible; it names its known sibling entry", assess("iPhone 16", "iPhone 16e", database).credible[0]?.siblingName === "iPhone 16e");
  }

  section("what counts as an identifier");
  {
    check("an ordinal is not one", definingCodes("Friday the 13th and the 2nd one").length === 0);
    check("a price, a discount and a time are not", definingCodes("$100 firm, 20% off, pickup 9pm, 15 dollars").length === 0);
    check("a phone number or order id is not", definingCodes("call 5551234567 order 12345678").length === 0);
    check("a quantity is not, but a size is", definingCodes("2x").length === 0 && definingCodes("IKEA Kallax 4x4").join() === "4x4");
    check("model markers still are", definingCodes("DCD791 M18 RTX3060 CFI-1200 16e 360 0114012").join() === "dcd791,m18,rtx3060,1200,16e,360,0114012", definingCodes("DCD791 M18 RTX3060 CFI-1200 16e 360 0114012"));
  }

  section("equivalent naming without unsafe matching");
  {
    check("ps5 is a short form of 'PlayStation 5'", aliasCovered("ps5", "Sony PlayStation 5 Slim"));
    check("...but not of an unrelated name", !aliasCovered("ps5", "Nintendo Switch 5") && !aliasCovered("ds2", "Nintendo Switch 2"));
    const a = assess("PlayStation 5 Slim", "PS5 Pro CFI-7000 Playstation 5", [...database, prod("PlayStation 5 Pro CFI-7000"), listing("PS5 CFI-7000 console", "zed")]);
    check("a short form does not hide a different real model (7000 is still credible, via the related entry)", a.credible.some((c) => c.code === "7000" && c.reason === "related-product") && !a.credible.some((c) => c.code === "ps5"), a);
  }

  section("genuinely different products stay protected, in unfamiliar categories");
  {
    const cases: Array<[string, string, string, EvidenceDoc[], string]> = [
      ["the reported controller (generation vouched for by many entries)", "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad", "360", database, "Xbox Wireless Controller"],
      ["power tool model", "DeWalt 20V Max Drill DCD791 brand new", "dcd791", [prod("DeWalt DCD791 20V Max Drill"), prod("DeWalt 20V Max Drill")], "DeWalt 20V Max Drill"],
      ["camera body", "Canon EOS R5 mirrorless camera body", "r5", [prod("Canon EOS R5 Body"), prod("Canon EOS R")], "Canon EOS R"],
      ["stand mixer model seen on two sellers", "KitchenAid KSM150PSER Artisan stand mixer red", "ksm150pser", [listing("KitchenAid KSM150PSER stand mixer", "cara"), listing("Kitchenaid stand mixer KSM150PSER", "dan"), prod("KitchenAid Stand Mixer")], "KitchenAid Stand Mixer"],
      ["guitar series (reference photo titles)", "Fender Stratocaster 0114012 American Professional II", "0114012", [photo("Fender Stratocaster 0114012 American Professional"), photo("Fender American Professional II Stratocaster 0114012 maple"), prod("Fender Stratocaster")], "Fender Stratocaster"],
      ["bike frame size/model", "Trek Domane SL5 road bike", "sl5", [prod("Trek Domane SL5"), prod("Trek Domane")], "Trek Domane"],
    ];
    for (const [label, title, code, docs, entry] of cases) {
      const a = assess(entry, title, docs);
      check(`${label}: ${code} is credible, so the listing is not trusted at the generic value`, a.credible.some((c) => c.code === code), a);
    }
    // fresh database, no entries at all: the photo analysis vouching is enough evidence
    const fresh = assess("Xbox Wireless Controller", "Official Microsoft Xbox 360 Wireless Controller 1403 OEM", [prod("Xbox Wireless Controller")], { independentTexts: ["Xbox 360 Wireless Controller"] });
    check("with an empty Database, the photo analysis naming the generation protects it", fresh.credible.some((c) => c.code === "360") && fresh.credible[0].reason === "photo-analysis", fresh);
    const none = assess("Xbox Wireless Controller", "Official Microsoft Xbox 360 Wireless Controller 1403 OEM", [prod("Xbox Wireless Controller")]);
    check("with no evidence at all it is neither claimed exact nor suppressed: unverified", none.credible.length === 0 && none.unverified.length === 2, none);
  }

  section("codes that must NOT count, in several categories");
  {
    const a1 = assess("KitchenAid Stand Mixer", "KitchenAid stand mixer R7741", [prod("KitchenAid Stand Mixer"), listing("KitchenAid stand mixer R7741 red", "same-seller"), listing("KitchenAid stand mixer R7741 black", "same-seller")]);
    check("the same seller repeating a code is one source, not corroboration", a1.credible.length === 0 && unverified(a1) === "r7741", a1);
    const a2 = assess("Xbox Series S", "Xbox Series S bundle with NBA 2K27", [...database, prod("NBA 2K27 (Xbox Series S)"), prod("NBA 2K27 (Xbox One)"), listing("NBA 2K27 (Xbox Series S) sealed", "e")]);
    check("games that only name the product in brackets do not vouch for the game's own code", a2.credible.length === 0 && unverified(a2) === "2k27", a2);
    const a3 = assess("Fender Stratocaster", "Fender Stratocaster SN 123456789", [prod("Fender Stratocaster")]);
    check("a serial / id number is not an identifier at all", a3.credible.length === 0 && a3.unverified.length === 0);
    const a4 = assess("Dyson Vacuum", "Dyson vacuum 2 filters 5 attachments", [prod("Dyson Vacuum")]);
    check("small counts are not identifiers", a4.credible.length === 0 && a4.unverified.length === 0);
  }

  section("unverified codes never start research and never invent a name");
  {
    const a = assess("Xbox Series S", "Xbox Series S Console Z7UX", database);
    check("no name to research for an unverified code", specificResearchName("Xbox Series S", a, "Xbox Series S Console Z7UX") === null);
    const b = assess("iPhone 16", "iPhone 16e", database);
    check("a credible code with a known sibling researches that sibling, by its own name", specificResearchName("iPhone 16", b, "iPhone 16e") === "iPhone 16e");
    const c = assess("Xbox Wireless Controller", "Official Microsoft Xbox 360 Wireless Controller 1403", database);
    check("a credible code without a sibling gets a name with ONLY the credible code (not the unverified 1403)", specificResearchName("Xbox Wireless Controller", c, "Official Microsoft Xbox 360 Wireless Controller 1403") === "Xbox Wireless Controller 360", c);
  }
});
