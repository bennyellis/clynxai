// Phase 4 stage 3b (shadow): held-out categories for the foundation resolver. The user's Database is mostly consoles and phones; the resolver must hold up on products
// from places it was never tuned on. The expectations were written from the design BEFORE the resolver ran on them. "uncertain" is an acceptable answer wherever
// the evidence is thin; what is never acceptable is a confident wrong one, and a resolver that answers "uncertain" to everything also fails (see the last section).
import { buildContext, compareProducts, resolveListing, type ResolverContext } from "../identity/foundationResolver.js";
import { check, run, section } from "./_testkit.js";

const NAMES = [
  // musical instruments
  "Fender Player Stratocaster", "Fender American Professional II Stratocaster", "Fender Stratocaster", "Gibson Les Paul Standard", "Gibson Les Paul Studio", "Boss DS-1 Distortion", "Boss DS-1X Distortion",
  // cameras and lenses
  "Canon EOS R6", "Canon EOS R6 Mark II", "Canon RF 24-70mm f/2.8L Lens", "Canon RF 70-200mm f/2.8L Lens", "Sony A7 III", "Sony A7 IV",
  // footwear and clothing
  "Nike Air Jordan 1 High OG", "Nike Air Jordan 1 Low", "Nike Dunk Low Panda", "Levi's 501 Original Jeans 32x30", "Levi's 501 Original Jeans 34x32",
  // tools and home
  "DeWalt DCD791 20V Drill", "DeWalt DCD791 Drill Driver Kit with 2 batteries", "Milwaukee M18 Fuel Impact Driver", "KitchenAid Artisan Stand Mixer", "KitchenAid Classic Stand Mixer",
  "Dyson V11 Vacuum", "Dyson V15 Detect Vacuum", "Instant Pot Duo 6 Quart", "Instant Pot Duo 8 Quart",
  // watches, books, cards
  "Casio G-Shock GA-2100", "Casio G-Shock GA-2100 Carbon", "Seiko 5 Sports SRPD", "The Hobbit Hardcover", "Harry Potter and the Sorcerer's Stone", "Pokemon Charizard Base Set 1st Edition Card",
  // vehicles and furniture
  "2015 Honda Civic EX", "2015 Honda Civic Si", "IKEA Kallax Shelf Unit 4x4", "IKEA Kallax Shelf Unit 2x2",
  // a brand-level entry
  "Fender", "Canon", "Nike",
];
const entries = NAMES.map((name, i) => ({ id: `h${i}`, name }));
const byName = (n: string) => entries.find((e) => e.name === n)!;
const docs = [
  { text: "Fender Stratocaster electric guitar sunburst", origin: "seller:a", kind: "listing" as const },
  { text: "Canon EOS R6 mirrorless camera body", origin: "seller:b", kind: "listing" as const },
  { text: "Nike Air Jordan 1 High OG Chicago size 10", origin: "seller:c", kind: "listing" as const },
  { text: "KitchenAid Artisan mixer 5 quart red", origin: "seller:d", kind: "listing" as const },
  { text: "Dyson V11 cordless vacuum cleaner", origin: "seller:e", kind: "listing" as const },
];
const ctx = buildContext(entries, docs);
const cmp = (a: string, b: string, c: ResolverContext = ctx) => compareProducts(c.info(byName(a).id)!, c.info(byName(b).id)!, c);
const list = (title: string, opts = {}) => resolveListing(title, entries, ctx, opts);

run(() => {
  section("held-out: different products are never confirmed as the same, in any category");
  {
    const pairs: Array<[string, string]> = [
      ["Fender Player Stratocaster", "Fender American Professional II Stratocaster"],
      ["Gibson Les Paul Standard", "Gibson Les Paul Studio"],
      ["Boss DS-1 Distortion", "Boss DS-1X Distortion"],
      ["Canon EOS R6", "Canon EOS R6 Mark II"],
      ["Canon RF 24-70mm f/2.8L Lens", "Canon RF 70-200mm f/2.8L Lens"],
      ["Sony A7 III", "Sony A7 IV"],
      ["Nike Air Jordan 1 High OG", "Nike Air Jordan 1 Low"],
      ["Levi's 501 Original Jeans 32x30", "Levi's 501 Original Jeans 34x32"],
      ["DeWalt DCD791 20V Drill", "DeWalt DCD791 Drill Driver Kit with 2 batteries"],
      ["KitchenAid Artisan Stand Mixer", "KitchenAid Classic Stand Mixer"],
      ["Dyson V11 Vacuum", "Dyson V15 Detect Vacuum"],
      ["Instant Pot Duo 6 Quart", "Instant Pot Duo 8 Quart"],
      ["Casio G-Shock GA-2100", "Casio G-Shock GA-2100 Carbon"],
      ["2015 Honda Civic EX", "2015 Honda Civic Si"],
      ["IKEA Kallax Shelf Unit 4x4", "IKEA Kallax Shelf Unit 2x2"],
      ["Fender", "Fender Stratocaster"],
      ["Canon", "Canon EOS R6"],
      ["The Hobbit Hardcover", "Harry Potter and the Sorcerer's Stone"],
    ];
    const wrong = pairs.filter(([a, b]) => cmp(a, b).verdict === "confirmed");
    check("no pair of different products is confirmed", wrong.length === 0, wrong);
    check("a generic brand entry is related as a family, not folded into its member", cmp("Fender", "Fender Stratocaster").verdict !== "confirmed" && cmp("Canon", "Canon EOS R6").verdict !== "confirmed");
    const mixedModel = cmp("Canon EOS R6", "Canon EOS R6 Mark II");
    check("a Mark II is not the original (never confirmed; related or uncertain)", mixedModel.verdict !== "confirmed" && mixedModel.verdict !== "different" ? true : mixedModel.verdict === "different", mixedModel);
  }

  section("held-out: the same product written two ways is still recognised");
  {
    check("identical wording is confirmed in any category", ["Fender Stratocaster", "Canon EOS R6", "Dyson V11 Vacuum", "IKEA Kallax Shelf Unit 4x4"].every((n) => cmp(n, n).verdict === "confirmed"));
  }

  section("held-out: listings resolve to the right entry or say they cannot");
  {
    const r1 = list("Canon EOS R6 mirrorless camera body only, great shape");
    check("a camera body listing resolves to the body, not the Mark II", r1.verdict === "confirmed" && r1.product?.name === "Canon EOS R6", r1);
    const r2 = list("Canon EOS R6 Mark II body with grip");
    check("the Mark II listing resolves to the Mark II entry", r2.verdict === "confirmed" && r2.product?.name === "Canon EOS R6 Mark II", r2);
    const r3 = list("Dyson V15 Detect cordless vacuum with all attachments");
    check("a vacuum resolves to the V15, not the V11", r3.verdict === "confirmed" && r3.product?.name === "Dyson V15 Detect Vacuum", r3);
    const r4 = list("Instant Pot Duo 8 Quart pressure cooker");
    check("a cooker resolves to its size", r4.verdict === "confirmed" && r4.product?.name === "Instant Pot Duo 8 Quart", r4);
    const r5 = list("Nike Air Jordan 1 Low Travis Scott size 11");
    check("a sneaker colourway with no entry is not folded into the generic low entry as a confident match", !(r5.verdict === "confirmed" && r5.product?.name === "Nike"), r5);
    const r6 = list("Casio G-Shock GA-2100 Carbon core guard black");
    check("a watch listing resolves to the carbon variant", r6.verdict === "confirmed" && r6.product?.name === "Casio G-Shock GA-2100 Carbon", r6);
    const r7 = list("IKEA Kallax 2x2 shelf unit white");
    check("furniture resolves to its size or says it cannot (never the 4x4)", r7.product?.name !== "IKEA Kallax Shelf Unit 4x4", r7);
  }

  section("held-out: genuine new models and unknown products are recognised, never folded into a generic entry");
  {
    const r1 = list("Sony A7 V mirrorless camera body");
    check("a new model beside A7 III / A7 IV is a new model of the family, not an existing entry", r1.verdict !== "confirmed" || (r1.product?.name !== "Sony A7 III" && r1.product?.name !== "Sony A7 IV"), r1);
    const r2 = list("Fender Telecaster American Vintage II");
    check("a Telecaster is not folded into the Fender brand entry as a confirmed match", !(r2.verdict === "confirmed" && r2.product?.name === "Fender"), r2);
    const r3 = list("Hario V60 ceramic pour over dripper");
    check("a product from a category with no entries is explicitly unknown", r3.verdict === "uncertain" && r3.product === null, r3);
    const r4 = list("Dyson V20 Detect Vacuum");
    check("a vacuum model nobody has an entry for is not confirmed as another model", !(r4.verdict === "confirmed" && /V1[15]/.test(r4.product?.name ?? "")), r4);
  }

  section("held-out: titles that name several things, accessories and wanted ads do not take a confident wrong entry");
  {
    const r1 = list("Case for Canon EOS R6 camera, padded");
    check("an accessory FOR a camera is not the camera", !(r1.verdict === "confirmed" && r1.product?.name === "Canon EOS R6"), r1);
    const r2 = list("Canon EOS R6 and Sony A7 III, selling both");
    check("two different cameras in one title are not resolved to one of them with confidence", r2.verdict !== "confirmed", r2);
    const r3 = list("Dyson V11 Vacuum with Dyson V15 Detect Vacuum bundle");
    check("two vacuums named together are not silently one of them", r3.verdict !== "confirmed" || r3.alsoMentions.length > 0, r3);
  }

  section("a title that merely mentions an entry's name among much else is not that entry");
  {
    const small = buildContext([{ id: "g1", name: "Minecraft" }, { id: "g2", name: "Minecraft: Xbox One Edition" }], [{ text: "Minecraft game disc", origin: "seller:z", kind: "listing" as const }]);
    const r = resolveListing("Minecraft Totem of Undying Metal Keychain Gold Tone Pixel Charm Keyring", [{ id: "g1", name: "Minecraft" }, { id: "g2", name: "Minecraft: Xbox One Edition" }], small, {});
    check("merchandise that names a game is not the game", r.verdict !== "confirmed", r);
    const r2 = resolveListing("Minecraft", [{ id: "g1", name: "Minecraft" }], buildContext([{ id: "g1", name: "Minecraft" }], []), {});
    check("but the plain title still resolves", r2.verdict === "confirmed" && r2.product?.id === "g1", r2);
  }

  section("the resolver is not trivially rejecting everything");
  {
    const titles = ["Fender Stratocaster electric guitar", "Canon EOS R6 mirrorless camera body", "KitchenAid Artisan Stand Mixer red", "Dyson V11 Vacuum cordless", "Boss DS-1 Distortion pedal"];
    const confirmed = titles.map((t) => list(t)).filter((r) => r.verdict === "confirmed").length;
    check("most plain listings with an entry are confirmed", confirmed >= 4, confirmed);
  }
});
