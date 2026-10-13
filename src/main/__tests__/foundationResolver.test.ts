// Phase 4 stage 3b (shadow): the foundation-based resolver on held-out and adversarial cases across many categories. Expectations were written from the design
// before the resolver was run on them. "uncertain" is a legitimate, explicit answer; what must never happen is a confident wrong answer.
import { buildContext, compareProducts, resolveListing, type ResolverContext } from "../identity/foundationResolver.js";
import { check, run, section } from "./_testkit.js";

const NAMES = [
  "Xbox Wireless Controller", "Xbox 360 Wireless Controller", "Xbox Series S", "Xbox Series S 512GB", "Xbox", "Nintendo", "Nintendo Switch", "Nintendo Switch Dock", "Nintendo 3DS",
  "Pokémon Y (Nintendo 3DS)", "Samsung Galaxy S21", "Samsung Galaxy S21 Ultra", "Canon EOS R5 Body", "Canon EOS R", "DeWalt DCD791 20V Drill", "KitchenAid Stand Mixer", "Trek Domane",
  "Trek Domane SL5", "Fender Stratocaster", "iPhone 16", "iPhone 16e", "Weber Genesis II Grill", "Lodge 12 inch Cast Iron Skillet", "Lodge 10 inch Cast Iron Skillet", "Funko Pop Batman",
  "Sennheiser HD 600", "Sennheiser HD 650", "Madden NFL 25 (Xbox 360)", "Madden NFL 25 (PlayStation 3)", "PlayStation 5 Slim", "Sony PlayStation 5 Digital Edition Slim 848GB (PS5 Slim Digital 848GB)",
  "Ps5 digital edition", "Xbox Series X 1TB Special Edition (Halo Infinite)", "Halo Infinite", "Bosch 18V Drill Driver", "Bosch 18V Drill Driver with 2 batteries", "Apple iPhone 12 128GB",
  "Apple iPhone 12 64GB", "iPhone 12", "Strap for Canon EOS R5 Body", "Gibson Les Paul",
];
const entries = NAMES.map((name, i) => ({ id: `e${i}`, name }));
const byName = (n: string) => entries.find((e) => e.name === n)!;
const baseDocs = [
  { text: "Microsoft Xbox 360 wireless controller", origin: "seller:a", kind: "listing" as const },
  { text: "Xbox 360 controller black", origin: "seller:b", kind: "listing" as const },
  { text: "Fallout New Vegas Xbox 360", origin: "seller:c", kind: "listing" as const },
  { text: "Madden NFL Xbox 360 sealed", origin: "seller:d", kind: "listing" as const },
];
const ctx = buildContext(entries, baseDocs);
const cmp = (a: string, b: string, c: ResolverContext = ctx) => compareProducts(c.info(byName(a).id)!, c.info(byName(b).id)!, c);
const list = (title: string, c: ResolverContext = ctx, opts = {}) => resolveListing(title, entries, c, opts);

run(() => {
  section("product vs product: mention is not identity, brackets are classified, hosts matter");
  {
    const r1 = cmp("Pokémon Y (Nintendo 3DS)", "Nintendo 3DS");
    check("a game naming its platform is related 'goes-with', never the platform", r1.verdict === "related" && r1.relation === "goes-with", r1);
    const r1b = cmp("Strap for Canon EOS R5 Body", "Canon EOS R5 Body");
    check("'X for Y' is goes-with Y", r1b.verdict === "related" && r1b.relation === "goes-with", r1b);
    check("the same title for different platforms is a different product", cmp("Madden NFL 25 (Xbox 360)", "Madden NFL 25 (PlayStation 3)").verdict === "different");
    const r3 = cmp("Xbox Series X 1TB Special Edition (Halo Infinite)", "Halo Infinite");
    check("a bracketed edition theme is NOT treated as the host it names (the known bracketed-edition error)", r3.relation !== "goes-with" && r3.verdict === "different", r3);
    const r4 = cmp("Sony PlayStation 5 Digital Edition Slim 848GB (PS5 Slim Digital 848GB)", "Ps5 digital edition");
    check("a bracket that repeats the product's own name is an alternate name, not a host (the known false-host error); the entry is the narrower one", r4.relation !== "goes-with" && r4.verdict === "related" && r4.moreSpecific === "a", r4);
    const r5 = cmp("Bosch 18V Drill Driver with 2 batteries", "Bosch 18V Drill Driver");
    check("a kit that includes the product plus extras is a bundle", r5.verdict === "related" && r5.relation === "bundle" && r5.moreSpecific === "a", r5);
    check("identical wording is confirmed", cmp("Weber Genesis II Grill", "Weber Genesis II Grill").verdict === "confirmed");
    const fp = buildContext([{ id: "a", name: "Ps5 (For Parts / Broken)" }, { id: "b", name: "PlayStation 5" }, { id: "c", name: "Ps5" }, { id: "d", name: "Nintendo Switch (Nintendo Switch 2)" }, { id: "e", name: "Nintendo Switch" }]);
    const cm = (p: string, q: string) => compareProducts(fp.info(p)!, fp.info(q)!, fp);
    check("a condition bracket ('For Parts / Broken') is never an alternate name: not the working product", cm("a", "b").verdict !== "confirmed" && cm("a", "c").verdict !== "confirmed", [cm("a", "b"), cm("a", "c")]);
    check("a bracket that adds a word ('Nintendo Switch 2') is new information, not an alternate name", cm("d", "e").verdict !== "confirmed", cm("d", "e"));
  }

  section("different models, capacities and sizes are different products");
  {
    check("capacity differs", cmp("Apple iPhone 12 128GB", "Apple iPhone 12 64GB").verdict === "different");
    check("size numbers differ", cmp("Lodge 12 inch Cast Iron Skillet", "Lodge 10 inch Cast Iron Skillet").verdict === "different");
    check("model numbers differ", cmp("Sennheiser HD 600", "Sennheiser HD 650").verdict === "different");
    check("unrelated products", cmp("Fender Stratocaster", "Gibson Les Paul").verdict === "different");
    check("a code or number extra is a variant, not the same", cmp("Trek Domane SL5", "Trek Domane").verdict === "related" && cmp("Trek Domane SL5", "Trek Domane").relation === "variant" && cmp("Canon EOS R5 Body", "Canon EOS R").relation === "variant");
    check("one states a capacity the other does not: a variant", cmp("iPhone 12", "Apple iPhone 12 128GB").verdict !== "confirmed");
  }

  section("generic and brand-level entries do not absorb specific products");
  {
    const g1 = cmp("Nintendo", "Nintendo Switch");
    const g2 = cmp("Xbox", "Xbox Series S");
    check("a one-word entry and a member are 'related: family', never confirmed", g1.verdict === "related" && g1.relation === "family" && g2.verdict === "related" && g2.relation === "family", { g1, g2 });
    check("the one-word entries are marked generic, the specific ones are not", ctx.info(byName("Nintendo").id)!.generic && ctx.info(byName("Xbox").id)!.generic && !ctx.info(byName("Nintendo Switch").id)!.generic && !ctx.info(byName("Xbox Series S").id)!.generic);
  }

  section("plain extra words are NEVER confirmed: they stay uncertain, saying what is missing");
  {
    for (const [a, b] of [["Nintendo Switch Dock", "Nintendo Switch"], ["Samsung Galaxy S21 Ultra", "Samsung Galaxy S21"], ["Funko Pop Batman", "Funko Pop Batman"], ["Canon EOS R5 Body", "Canon EOS R5 Body"]] as const) {
      void a; void b;
    }
    const u1 = cmp("Nintendo Switch Dock", "Nintendo Switch");
    const u2 = cmp("Samsung Galaxy S21 Ultra", "Samsung Galaxy S21");
    check("a dock is not the console and is not wrongly confirmed", u1.verdict === "uncertain" && u1.unresolved.length > 0, u1);
    check("'Ultra' is not wrongly confirmed (it is a different product; nothing structural proves it, so it says so)", u2.verdict === "uncertain" && u2.lean !== "same", u2);
    // adversarial: even when the extra word is very common beside the base name in the data, it must not be confirmed
    const crowd = [...Array(8)].map((_, i) => ({ text: `iPhone 11 Pro ${i} unlocked`, origin: `seller:p${i}`, kind: "listing" as const }));
    const es = [{ id: "a", name: "iPhone 11 Pro" }, { id: "b", name: "iPhone 11" }, { id: "x1", name: "Galaxy A" }, { id: "x2", name: "Galaxy B" }];
    const c2 = buildContext(es, crowd);
    const v = compareProducts(c2.info("a")!, c2.info("b")!, c2);
    check("a variant word that is common in the data ('pro') still cannot confirm a match", v.verdict !== "confirmed" && v.verdict !== "different" ? true : v.verdict !== "confirmed", v);
  }

  section("aliases: genuine short forms are preserved when the data backs them, and only then confirmed");
  {
    const es = [{ id: "a", name: "PS5 Slim" }, { id: "b", name: "PlayStation 5 Slim" }];
    const without = buildContext(es);
    check("with no independent document using both forms: uncertain, leaning same (a probable alias, not a match)", ((v) => v.verdict === "uncertain" && v.relation === "alias" && v.lean === "same")(compareProducts(without.info("a")!, without.info("b")!, without)));
    const docs = [{ text: "PS5 slim digital console", origin: "seller:1", kind: "listing" as const }, { text: "Sony ps5 slim 1TB", origin: "seller:2", kind: "listing" as const }];
    const withDocs = buildContext(es, docs);
    check("with two independent documents using the short form with the same words: confirmed alias", ((v) => v.verdict === "confirmed" && v.relation === "alias")(compareProducts(withDocs.info("a")!, withDocs.info("b")!, withDocs)));
    const es2 = [{ id: "a", name: "The Division" }, { id: "b", name: "Nintendo 2DS" }];
    const c3 = buildContext(es2);
    check("a coincidental short form ('ds' inside 'division') is never an alias", compareProducts(c3.info("a")!, c3.info("b")!, c3).verdict === "different");
  }

  section("listing vs entries");
  {
    const l1 = list("Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad");
    check("the reported controller resolves to the 360 entry, not the generic one", l1.product?.name === "Xbox 360 Wireless Controller" && l1.verdict === "confirmed", l1);
    check("...and the unproven '1403' is explicit, not silent", l1.sureness !== "high" && l1.unresolved.some((u) => /1403/.test(u)), l1.unresolved);
    const l2 = list("Used Xbox wireless controller works great");
    check("an ordinary listing resolves to the plain entry", l2.product?.name === "Xbox Wireless Controller" && l2.verdict === "confirmed", l2);
    const l3 = list("Xbox Series S 512GB Console O1766");
    check("a seller code is flagged but the match holds", l3.product?.name === "Xbox Series S 512GB" && l3.verdict === "confirmed" && l3.unresolved.some((u) => /o1766/.test(u)), l3);
    const l4 = list("Nintendo Switch console with dock and charger");
    check("a console WITH a dock is the console; the dock is a bundle item, not the match", l4.product?.name === "Nintendo Switch" && l4.alsoMentions.some((m) => m.name === "Nintendo Switch Dock" && m.as === "bundle"), l4);
    const l5 = list("Nintendo Switch Dock only");
    check("the dock listing is the dock", l5.product?.name === "Nintendo Switch Dock", l5);
    const l6 = list("Cable for Xbox Series S");
    check("an accessory FOR a console is not the console", l6.verdict === "related" && l6.relation === "goes-with" && l6.product?.name === "Xbox Series S", l6);
    const l13 = list("Pokémon Y (Nintendo 3DS) brand new sealed");
    check("a game listing with its platform resolves to the game entry", l13.product?.name === "Pokémon Y (Nintendo 3DS)" && l13.verdict === "confirmed", l13);
    const l16 = list("Xbox 360 console");
    check("only a brand-level entry fits: related family with the family named, never confirmed as that entry", l16.verdict === "related" && l16.relation === "family" && l16.newModel?.family === "Xbox", l16);
  }

  section("a genuine new model with no entry is recognised, not folded into a generic one");
  {
    const l7 = list("Samsung Galaxy S27 Ultra 256GB");
    check("a new member of the S21 family is a new model, naming the family", l7.verdict === "uncertain" && l7.newModel?.family?.startsWith("Samsung Galaxy S21") === true && l7.newModel!.codes.includes("s27"), l7);
    const l8 = list("iPhone 17 Pro");
    check("a new numbered model is recognised as new", l8.newModel !== null && /iPhone 16/.test(l8.newModel.family ?? ""), l8);
    const l12 = list("Trek Domane SL6 disc");
    check("SL6 beside an SL5 entry is a new model of the family, not the generic Domane", l12.verdict === "related" && l12.newModel?.codes.includes("sl6") === true && l12.product?.name !== "Trek Domane SL5", l12);
    const l9 = list("Zorblax 9000 Pro quantum");
    check("a product with no entry and no family is explicitly unknown", l9.verdict === "uncertain" && l9.product === null && l9.unresolved.join(" ").includes("unknown product"), l9);
    const l14 = list("Nintendo Switch OLED console");
    check("a variant word with no entry ('oled') is listed as unresolved, the match is not claimed as high", l14.product?.name === "Nintendo Switch" && l14.sureness !== "high" && l14.unresolved.some((u) => /oled/.test(u)), l14);
  }

  section("regressions found while building the veto-only safeguard (each was a real wrong answer)");
  {
    const E = [
      "Joy-Con Pair", "Nintendo Switch", "Nintendo Switch (Nintendo Switch 2)", "Switch 2", "Xbox Series S", "Xbox Series S 512GB", "Xbox Series S Console (includes wireless controller)", "Terraria",
      "Fender Stratocaster", "Mixer Pro 5", "Mixer Pro 5 with 2 bowls",
    ].map((name, i) => ({ id: `q${i}`, name }));
    const c = buildContext(E, []);
    const L = (t: string) => resolveListing(t, E, c, {});
    const r1 = L("For Nintendo Switch Wireless Joy Con Pair L+R");
    check("a title that BEGINS with 'for' is the item, not an accessory for what follows", !(r1.verdict === "related" && r1.relation === "goes-with"), r1);
    const r2 = L("Nintendo Switch (Nintendo Switch 2) console");
    check("a bracket that repeats the name and adds a word is the same name written out, not a host", !(r2.verdict === "related" && r2.relation === "goes-with"), r2);
    const r3 = L("Microsoft Xbox Series S 512GB Console Gaming System White Tested");
    check("a title that states 512GB resolves to the 512GB entry, not a bundle entry whose contents it never states", r3.verdict === "confirmed" && r3.product?.name === "Xbox Series S 512GB", r3);
    const r4 = L("Terraria - Xbox One - Sealed");
    check("a one-word game title is a product, not a family-level entry (no 'family' relation, no 'member of this family')", !(r4.relation === "family"), r4);
    const r5 = L("Mixer Pro 5 with 2 bowls and a dough hook");
    check("a bundle entry fits a title that states its contents", r5.verdict === "confirmed" && r5.product?.name === "Mixer Pro 5 with 2 bowls", r5);
    const r6 = L("Mixer Pro 5 stand mixer red");
    check("and the plain entry is chosen when the contents are not stated", r6.product?.name !== "Mixer Pro 5 with 2 bowls", r6);
    const v = compareProducts(c.info("q8")!, c.info("q8")!, c);
    check("a product is the same as itself", v.verdict === "confirmed");
  }

  section("never confident-and-wrong on the adversarial set");
  {
    const wrongConfirm = [
      ["Strap for Canon EOS R5 Body", "Canon EOS R5 Body"],
      ["Madden NFL 25 (Xbox 360)", "Madden NFL 25 (PlayStation 3)"],
      ["Nintendo Switch Dock", "Nintendo Switch"],
      ["Samsung Galaxy S21 Ultra", "Samsung Galaxy S21"],
      ["Apple iPhone 12 128GB", "Apple iPhone 12 64GB"],
      ["Sennheiser HD 600", "Sennheiser HD 650"],
      ["Lodge 12 inch Cast Iron Skillet", "Lodge 10 inch Cast Iron Skillet"],
      ["Trek Domane SL5", "Trek Domane"],
      ["Bosch 18V Drill Driver with 2 batteries", "Bosch 18V Drill Driver"],
      ["Xbox", "Xbox Series S"],
    ].filter(([a, b]) => cmp(a, b).verdict === "confirmed");
    check("none of these different products is ever 'confirmed'", wrongConfirm.length === 0, wrongConfirm);
    const rejectsEverything = ["Weber Genesis II Grill"].every((n) => cmp(n, n).verdict !== "confirmed");
    check("and the resolver does confirm real matches (it does not reject everything)", !rejectsEverything);
  }
});
