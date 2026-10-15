// Variant identity (variants.ts): what is a distinct variant of a parent product, what is an accessory, and how a variant is valued apart from its parent.
// No product is special-cased: the Xbox Galaxy Black case that exposed the problem runs through the same rules as every other row.
import { compMatchesSpecs } from "../compFilter.js";
import {
  MIN_VARIANT_COMPS,
  ensureQueryHasTokens,
  filterCompsForParent,
  filterCompsForVariant,
  inferDistinguishingTokens,
  parseVariantAttributes,
  requiredVariantTokens,
  titleHasTokens,
  variantRelation,
  variantTitleGate,
  variantValuationEvidence,
} from "../variants.js";
import { check, run, section } from "./_testkit.js";

run(() => {
  section("the Xbox Series X 2TB Galaxy Black Special Edition is a variant of Xbox Series X, however it is written");
  const parent = "Xbox Series X";
  for (const name of [
    "Xbox Series X 2TB Galaxy Black Special Edition",
    "Microsoft Xbox Series X – 2TB Galaxy Black Special Edition",
    "Xbox Series X 2 TB Disc Drive Galaxy Black Special Edition Bundle",
    "Xbox Series X Galaxy Black 2TB",
    "xbox series x galaxy",
  ]) {
    check(`"${name}" is a variant`, variantRelation(name, parent) === "variant", variantRelation(name, parent));
  }
  check("the same product written differently is the same", variantRelation("Xbox Series X Console", parent) === "same");
  check("the same name is the same", variantRelation("xbox series x", parent) === "same");
  check("a different lettered model is a different product", variantRelation("Xbox Series S", parent) === "different");
  check("an unrelated product is different", variantRelation("PlayStation 5", parent) === "different");
  check("its required words are the capacity, the colour and the edition's name, not marketing noise", JSON.stringify(requiredVariantTokens("Xbox Series X 2 TB Disc Drive Galaxy Black Special Edition Bundle", parent).sort()) === JSON.stringify(["2tb", "black", "galaxy"]), requiredVariantTokens("Xbox Series X 2 TB Disc Drive Galaxy Black Special Edition Bundle", parent));
  check("a single distinguishing word is required on its own", JSON.stringify(requiredVariantTokens("xbox series x galaxy", parent)) === JSON.stringify(["galaxy"]));
  check("a same-product wording requires nothing extra", requiredVariantTokens("Xbox Series X Console", parent).length === 0);
  check("no parent, no requirement", requiredVariantTokens("Xbox Series X 2TB Galaxy Black", null).length === 0);

  section("accessories and neighbours are not variants");
  check("a controller for the console", variantRelation("Xbox Series X Controller", parent) === "accessory");
  check("an expansion card made for it ('for ...' names the target)", variantRelation("Seagate 2TB Storage Expansion Card for Xbox Series X", parent) === "accessory");
  check("a case made for it", variantRelation("Carrying Case for Xbox Series X", parent) === "accessory");
  check("a charging dock for a phone", variantRelation("Charging Dock for iPhone 15", "iPhone 15") === "accessory");
  check("a screen protector", variantRelation("iPhone 15 Screen Protector", "iPhone 15") === "accessory");
  check("an accessory word does not hide a real version (2TB + edition + disc drive)", variantRelation("Xbox Series X 2TB Disc Drive Galaxy Black Special Edition", parent) === "variant");

  section("real variants in other categories (capacity, colour, edition, bundle, generation, region, trim)");
  const rows: Array<[string, string, string]> = [
    ["iPhone 15 Pro 256GB Blue Titanium", "iPhone 15", "variant"],
    ["iPhone 15 256GB", "iPhone 15", "variant"],
    ["Samsung Galaxy S24 Ultra 512GB Titanium Violet", "Samsung Galaxy S24", "variant"],
    ["Nintendo Switch OLED Zelda Edition", "Nintendo Switch OLED", "variant"],
    ["Nintendo Switch OLED Model White", "Nintendo Switch OLED", "same"],
    ["PlayStation 5 God of War Ragnarok Limited Edition Bundle", "PlayStation 5", "variant"],
    ["Xbox Series S Fortnite Bundle", "Xbox Series S", "variant"],
    ["Dyson V8 Absolute", "Dyson V8", "variant"],
    ["Toyota Camry XLE 2019", "Toyota Camry", "variant"],
    ["Kindle Paperwhite 16GB 11th Gen International Version", "Kindle Paperwhite", "variant"],
    ["Apple AirPods Pro 2nd Generation", "Apple AirPods Pro", "variant"],
    ["Sony WH-1000XM5 Midnight Blue", "Sony WH-1000XM5", "same"],
    ["Steam Deck OLED 1TB Limited Edition", "Steam Deck OLED", "variant"],
    ["GoPro HERO12 Black Creator Edition", "GoPro HERO12 Black", "variant"],
    ["Canon EOS R6 Mark II", "Canon EOS R6", "variant"],
    ["Meta Quest 3 512GB", "Meta Quest 3", "variant"],
    ["Meta Quest 3 Controller", "Meta Quest 3", "accessory"],
    ["Samsung Galaxy S24 Ultra", "Xbox Series X", "different"],
  ];
  for (const [name, par, expected] of rows) check(`"${name}" vs "${par}" -> ${expected}`, variantRelation(name, par) === expected, variantRelation(name, par));

  section("a seller-invented name is still a structural variant (evidence, not wording, decides whether it is real)");
  check("'Cosmic Quantum Edition 8TB' needs 'cosmic', 'quantum' and '8tb'", JSON.stringify(requiredVariantTokens("Xbox Series X Cosmic Quantum Edition 8TB", parent).sort()) === JSON.stringify(["8tb", "cosmic", "quantum"]), requiredVariantTokens("Xbox Series X Cosmic Quantum Edition 8TB", parent));

  section("attributes are read generically");
  const a = parseVariantAttributes("Xbox Series X 2 TB Galaxy Black Special Edition Bundle");
  check("capacity '2 TB' is read as 2tb", a.capacity.includes("2tb"), a);
  check("colour", a.colors.includes("black"));
  check("edition words in front of 'edition'", a.edition.includes("galaxy") && a.edition.includes("special"), a.edition);
  check("bundle", a.bundle);
  check("generation and region", parseVariantAttributes("Kindle 11th Gen International").generation.length === 1 && parseVariantAttributes("Kindle 11th Gen International").region.includes("international"));
  check("free-form inference for a chat search", JSON.stringify(inferDistinguishingTokens("Xbox Series X 2TB Galaxy Black Special Edition").sort()) === JSON.stringify(["2tb", "black", "galaxy"]), inferDistinguishingTokens("Xbox Series X 2TB Galaxy Black Special Edition"));
  check("a plain name has nothing to verify", inferDistinguishingTokens("Xbox Series X").length === 0);

  section("valuation: a variant is never priced off the standard model's sales");
  const childName = "Xbox Series X 2TB Galaxy Black Special Edition";
  const comps = [
    { title: "Microsoft Xbox Series X 1TB Black Console", priceUsd: 450 },
    { title: "Xbox Series X 1TB Console Black - Used", priceUsd: 430 },
    { title: "Xbox Series X 2TB Galaxy Black Special Edition Console", priceUsd: 560 },
    { title: "Microsoft Xbox Series X Galaxy Black 2 TB", priceUsd: 575 },
    { title: "Xbox Series X Digital", priceUsd: 380 },
  ];
  const forVariant = filterCompsForVariant(childName, parent, comps);
  check("only comps naming the variant's words are kept", forVariant.kept.length === 2 && forVariant.dropped === 3, forVariant);
  check("'2 TB' written with a space still counts", forVariant.kept.some((c) => c.title.includes("2 TB")));
  const forParent = filterCompsForParent(parent, [childName], comps);
  check("the parent's comps exclude its variant's sales", forParent.kept.length === 3 && forParent.kept.every((c) => !/galaxy/i.test(c.title)), forParent);
  check("(the existing spec filter alone would have let the special edition into the parent's price)", compMatchesSpecs(parent, "Xbox Series X 2TB Galaxy Black Special Edition Console") === true);
  const parentGate = variantTitleGate(parent, null, [childName]);
  check("the parent's gate rejects the variant's title and accepts the standard one", !parentGate("Xbox Series X 2TB Galaxy Black Special Edition Console") && parentGate("Microsoft Xbox Series X 1TB Black"));
  const childGate = variantTitleGate(childName, parent, []);
  check("the variant's gate rejects the standard model", !childGate("Microsoft Xbox Series X 1TB Black") && childGate("Xbox Series X Galaxy Black 2TB"));
  check("a product with no variants and no parent gates nothing", variantTitleGate("Dyson V8", null, [])("anything at all"));

  section("insufficient evidence is reported, not a substituted number");
  const none = variantValuationEvidence(childName, parent, 0, 0, 5);
  check("no matching comps -> not enough", !none.enough);
  check("the reason says insufficient evidence and that standard-model sales were set aside", !none.enough && /Insufficient evidence/.test(none.reason) && /5 sold listings/.test(none.reason) && /set aside/.test(none.reason), none);
  check("one sold comp is still not enough", !variantValuationEvidence(childName, parent, MIN_VARIANT_COMPS - 1, 0, 0).enough);
  check("enough sold comps", variantValuationEvidence(childName, parent, MIN_VARIANT_COMPS, 0, 0).enough);
  check("or enough matched asking prices", variantValuationEvidence(childName, parent, 0, 3, 0).enough);
  check("a product that is not a variant is never held to this", variantValuationEvidence("Xbox Series X", null, 0, 0, 0).enough);

  section("helpers");
  check("a search query regains the words it lost", ensureQueryHasTokens("xbox series x console", ["2tb", "galaxy"]) === "xbox series x console 2tb galaxy");
  check("and is left alone when it has them", ensureQueryHasTokens("xbox series x 2tb galaxy", ["2tb", "galaxy"]) === "xbox series x 2tb galaxy");
  check("titleHasTokens reads capacities written with spaces", titleHasTokens("Console 2 TB", ["2tb"]) && !titleHasTokens("Console 1 TB", ["2tb"]));
});
