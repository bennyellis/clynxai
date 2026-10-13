// Phase 4 validation corpus: 16 product categories NONE of which the resolver was tuned on (the Database it was built against is mostly games and phones). Each category has
// its own small library of entries and a set of hand-labelled pairs: the same product written differently, a different model / size / generation / edition, an accessory or
// part, a bundle, a family-level entry. The safety properties are asserted absolutely (they must hold in every category); the recall of "same product" is measured and held to
// a floor, because the resolver is deliberately conservative (it answers "uncertain" rather than guess).
import { buildContext, compareProducts } from "../identity/foundationResolver.js";
import { evaluateMatch } from "../identity/safeguard.js";
import { check, run, section } from "./_testkit.js";

type Truth = "same" | "different" | "accessory";
interface Pair {
  a: string;
  b: string;
  truth: Truth;
}
interface Category {
  name: string;
  entries: string[];
  pairs: Pair[];
}

const CATEGORIES: Category[] = [
  {
    name: "headphones",
    entries: ["Sony WH-1000XM4 Wireless Headphones", "Sony WH-1000XM5 Wireless Headphones", "Bose QuietComfort 45", "Bose QuietComfort 35 II", "AirPods Pro 2nd Generation", "AirPods Pro", "Sennheiser HD 600", "Sennheiser HD 650"],
    pairs: [
      { a: "Sony WH-1000XM4 Wireless Headphones", b: "sony wh-1000xm4 wireless headphones", truth: "same" },
      { a: "Sony WH-1000XM4 Wireless Headphones", b: "Sony WH-1000XM5 Wireless Headphones", truth: "different" },
      { a: "Bose QuietComfort 45", b: "Bose QuietComfort 35 II", truth: "different" },
      { a: "AirPods Pro 2nd Generation", b: "AirPods Pro", truth: "different" },
      { a: "Sennheiser HD 600", b: "Sennheiser HD 650", truth: "different" },
      { a: "Replacement ear pads for Sennheiser HD 600", b: "Sennheiser HD 600", truth: "accessory" },
    ],
  },
  {
    name: "cameras",
    entries: ["Canon EOS R6", "Canon EOS R6 Mark II", "Canon RF 24-70mm f/2.8L Lens", "Canon RF 70-200mm f/2.8L Lens", "Sony A7 III", "Sony A7 IV", "Nikon Z6 II", "GoPro Hero 11"],
    pairs: [
      { a: "Canon EOS R6", b: "canon eos r6", truth: "same" },
      { a: "Sony A7 III", b: "Sony A7 IV", truth: "different" },
      { a: "Canon RF 24-70mm f/2.8L Lens", b: "Canon RF 70-200mm f/2.8L Lens", truth: "different" },
      { a: "Camera strap for Canon EOS R6", b: "Canon EOS R6", truth: "accessory" },
      { a: "Battery grip for Nikon Z6 II", b: "Nikon Z6 II", truth: "accessory" },
    ],
  },
  {
    name: "power tools",
    entries: ["DeWalt DCD791 20V Drill", "DeWalt DCD771 20V Drill", "Milwaukee M18 Fuel Impact Driver", "Milwaukee M12 Fuel Impact Driver", "Makita XPH12 Hammer Drill", "Bosch GSB 18V Drill"],
    pairs: [
      { a: "DeWalt DCD791 20V Drill", b: "dewalt dcd791 20v drill", truth: "same" },
      { a: "DeWalt DCD791 20V Drill", b: "DeWalt DCD771 20V Drill", truth: "different" },
      { a: "Milwaukee M18 Fuel Impact Driver", b: "Milwaukee M12 Fuel Impact Driver", truth: "different" },
      { a: "Battery charger for Milwaukee M18", b: "Milwaukee M18 Fuel Impact Driver", truth: "accessory" },
    ],
  },
  {
    name: "kitchen appliances",
    entries: ["KitchenAid Artisan Stand Mixer", "KitchenAid Classic Stand Mixer", "Instant Pot Duo 6 Quart", "Instant Pot Duo 8 Quart", "Ninja Foodi Air Fryer", "Vitamix 5200 Blender", "Vitamix E310 Blender"],
    pairs: [
      { a: "KitchenAid Artisan Stand Mixer", b: "kitchenaid artisan stand mixer", truth: "same" },
      { a: "KitchenAid Artisan Stand Mixer", b: "KitchenAid Classic Stand Mixer", truth: "different" },
      { a: "Instant Pot Duo 6 Quart", b: "Instant Pot Duo 8 Quart", truth: "different" },
      { a: "Vitamix 5200 Blender", b: "Vitamix E310 Blender", truth: "different" },
      { a: "Replacement bowl for KitchenAid Artisan Stand Mixer", b: "KitchenAid Artisan Stand Mixer", truth: "accessory" },
    ],
  },
  {
    name: "vacuums and home",
    entries: ["Dyson V11 Vacuum", "Dyson V15 Detect Vacuum", "Shark Navigator Lift-Away", "Roomba i7", "Roomba j7", "Keurig K-Elite Coffee Maker"],
    pairs: [
      { a: "Dyson V11 Vacuum", b: "dyson v11 vacuum", truth: "same" },
      { a: "Dyson V11 Vacuum", b: "Dyson V15 Detect Vacuum", truth: "different" },
      { a: "Roomba i7", b: "Roomba j7", truth: "different" },
      { a: "Replacement filter for Dyson V11", b: "Dyson V11 Vacuum", truth: "accessory" },
    ],
  },
  {
    name: "guitars and music gear",
    entries: ["Fender Player Stratocaster", "Fender American Professional II Stratocaster", "Gibson Les Paul Standard", "Gibson Les Paul Studio", "Boss DS-1 Distortion", "Boss DS-1X Distortion", "Yamaha P-45 Digital Piano", "Roland FP-30X Digital Piano"],
    pairs: [
      { a: "Fender Player Stratocaster", b: "fender player stratocaster", truth: "same" },
      { a: "Gibson Les Paul Standard", b: "Gibson Les Paul Studio", truth: "different" },
      { a: "Fender Player Stratocaster", b: "Fender American Professional II Stratocaster", truth: "different" },
      { a: "Yamaha P-45 Digital Piano", b: "Roland FP-30X Digital Piano", truth: "different" },
      { a: "Hard case for Gibson Les Paul Standard", b: "Gibson Les Paul Standard", truth: "accessory" },
    ],
  },
  {
    name: "sneakers and clothing",
    entries: ["Nike Air Jordan 1 High OG", "Nike Air Jordan 1 Low", "Nike Dunk Low Panda", "Adidas Yeezy Boost 350 V2", "Levi's 501 Original Jeans 32x30", "Levi's 501 Original Jeans 34x32", "Patagonia Better Sweater"],
    pairs: [
      { a: "Nike Air Jordan 1 High OG", b: "nike air jordan 1 high og", truth: "same" },
      { a: "Nike Air Jordan 1 High OG", b: "Nike Air Jordan 1 Low", truth: "different" },
      { a: "Levi's 501 Original Jeans 32x30", b: "Levi's 501 Original Jeans 34x32", truth: "different" },
      { a: "Shoe laces for Nike Dunk Low Panda", b: "Nike Dunk Low Panda", truth: "accessory" },
    ],
  },
  {
    name: "watches",
    entries: ["Casio G-Shock GA-2100", "Casio G-Shock GA-2100 Carbon", "Seiko 5 Sports SRPD", "Apple Watch Series 8 45mm", "Apple Watch Series 8 41mm", "Garmin Forerunner 245"],
    pairs: [
      { a: "Casio G-Shock GA-2100", b: "casio g-shock ga-2100", truth: "same" },
      { a: "Casio G-Shock GA-2100", b: "Casio G-Shock GA-2100 Carbon", truth: "different" },
      { a: "Apple Watch Series 8 45mm", b: "Apple Watch Series 8 41mm", truth: "different" },
      { a: "Replacement band for Apple Watch Series 8 45mm", b: "Apple Watch Series 8 45mm", truth: "accessory" },
    ],
  },
  {
    name: "vehicles",
    entries: ["2015 Honda Civic EX", "2015 Honda Civic Si", "2018 Toyota Camry SE", "2018 Toyota Camry LE", "2012 Ford F-150 XLT", "1984 Chevrolet Corvette C4"],
    pairs: [
      { a: "2015 Honda Civic EX", b: "2015 honda civic ex", truth: "same" },
      { a: "2015 Honda Civic EX", b: "2015 Honda Civic Si", truth: "different" },
      { a: "2018 Toyota Camry SE", b: "2018 Toyota Camry LE", truth: "different" },
      { a: "Tail lights for 1984 Chevrolet Corvette C4", b: "1984 Chevrolet Corvette C4", truth: "accessory" },
    ],
  },
  {
    name: "furniture",
    entries: ["IKEA Kallax Shelf Unit 4x4", "IKEA Kallax Shelf Unit 2x2", "IKEA Billy Bookcase", "Herman Miller Aeron Chair Size B", "Herman Miller Aeron Chair Size C"],
    pairs: [
      { a: "IKEA Kallax Shelf Unit 4x4", b: "ikea kallax shelf unit 4x4", truth: "same" },
      { a: "IKEA Kallax Shelf Unit 4x4", b: "IKEA Kallax Shelf Unit 2x2", truth: "different" },
      { a: "Herman Miller Aeron Chair Size B", b: "Herman Miller Aeron Chair Size C", truth: "different" },
      { a: "Inserts for IKEA Kallax Shelf Unit 4x4", b: "IKEA Kallax Shelf Unit 4x4", truth: "accessory" },
    ],
  },
  {
    name: "books and collectibles",
    entries: ["The Hobbit Hardcover", "The Hobbit Paperback", "Harry Potter and the Sorcerer's Stone Hardcover", "Pokemon Charizard Base Set 1st Edition Card", "Pokemon Charizard Base Set Unlimited Card", "Funko Pop Batman 01"],
    pairs: [
      { a: "The Hobbit Hardcover", b: "the hobbit hardcover", truth: "same" },
      { a: "The Hobbit Hardcover", b: "The Hobbit Paperback", truth: "different" },
      { a: "Pokemon Charizard Base Set 1st Edition Card", b: "Pokemon Charizard Base Set Unlimited Card", truth: "different" },
      { a: "Card sleeves for Pokemon Charizard Base Set 1st Edition Card", b: "Pokemon Charizard Base Set 1st Edition Card", truth: "accessory" },
    ],
  },
  {
    name: "computers and components",
    entries: ["MacBook Air M1 2020 256GB", "MacBook Air M2 2022 256GB", "Dell XPS 13 9310", "Dell XPS 15 9510", "NVIDIA GeForce RTX 3070", "NVIDIA GeForce RTX 3070 Ti", "AMD Ryzen 7 5800X", "AMD Ryzen 7 5700X"],
    pairs: [
      { a: "MacBook Air M1 2020 256GB", b: "macbook air m1 2020 256gb", truth: "same" },
      { a: "MacBook Air M1 2020 256GB", b: "MacBook Air M2 2022 256GB", truth: "different" },
      { a: "Dell XPS 13 9310", b: "Dell XPS 15 9510", truth: "different" },
      { a: "NVIDIA GeForce RTX 3070", b: "NVIDIA GeForce RTX 3070 Ti", truth: "different" },
      { a: "AMD Ryzen 7 5800X", b: "AMD Ryzen 7 5700X", truth: "different" },
      { a: "Charger for Dell XPS 13 9310", b: "Dell XPS 13 9310", truth: "accessory" },
    ],
  },
  {
    name: "outdoor and sports",
    entries: ["Yeti Tundra 45 Cooler", "Yeti Tundra 65 Cooler", "Trek Domane SL5", "Trek Domane SL6", "Osprey Atmos AG 65 Backpack", "Garmin inReach Mini 2", "Coleman Sundome 4 Person Tent", "Coleman Sundome 6 Person Tent"],
    pairs: [
      { a: "Yeti Tundra 45 Cooler", b: "yeti tundra 45 cooler", truth: "same" },
      { a: "Yeti Tundra 45 Cooler", b: "Yeti Tundra 65 Cooler", truth: "different" },
      { a: "Trek Domane SL5", b: "Trek Domane SL6", truth: "different" },
      { a: "Coleman Sundome 4 Person Tent", b: "Coleman Sundome 6 Person Tent", truth: "different" },
      { a: "Rainfly for Coleman Sundome 4 Person Tent", b: "Coleman Sundome 4 Person Tent", truth: "accessory" },
    ],
  },
  {
    name: "toys and games",
    entries: ["LEGO Star Wars Millennium Falcon 75257", "LEGO Star Wars Millennium Falcon 75192", "Hot Wheels Super Treasure Hunt Camaro", "Monopoly Classic Edition", "Catan Board Game", "Catan Seafarers Expansion"],
    pairs: [
      { a: "LEGO Star Wars Millennium Falcon 75257", b: "lego star wars millennium falcon 75257", truth: "same" },
      { a: "LEGO Star Wars Millennium Falcon 75257", b: "LEGO Star Wars Millennium Falcon 75192", truth: "different" },
      { a: "Catan Board Game", b: "Catan Seafarers Expansion", truth: "different" },
    ],
  },
  {
    name: "baby and kids",
    entries: ["Graco 4Ever DLX Car Seat", "Graco Extend2Fit Car Seat", "UPPAbaby Vista V2 Stroller", "UPPAbaby Cruz V2 Stroller", "Fisher-Price Rock n Play Sleeper", "Ergobaby Omni 360 Carrier"],
    pairs: [
      { a: "UPPAbaby Vista V2 Stroller", b: "uppababy vista v2 stroller", truth: "same" },
      { a: "UPPAbaby Vista V2 Stroller", b: "UPPAbaby Cruz V2 Stroller", truth: "different" },
      { a: "Graco 4Ever DLX Car Seat", b: "Graco Extend2Fit Car Seat", truth: "different" },
      { a: "Rain cover for UPPAbaby Vista V2 Stroller", b: "UPPAbaby Vista V2 Stroller", truth: "accessory" },
    ],
  },
  {
    name: "phones and tablets (other brands)",
    entries: ["Samsung Galaxy S21", "Samsung Galaxy S21 Ultra", "Samsung Galaxy S22", "Google Pixel 7", "Google Pixel 7 Pro", "iPad Air 4th Generation 64GB", "iPad Air 5th Generation 64GB"],
    pairs: [
      { a: "Samsung Galaxy S21", b: "samsung galaxy s21", truth: "same" },
      { a: "Samsung Galaxy S21", b: "Samsung Galaxy S21 Ultra", truth: "different" },
      { a: "Google Pixel 7", b: "Google Pixel 7 Pro", truth: "different" },
      { a: "iPad Air 4th Generation 64GB", b: "iPad Air 5th Generation 64GB", truth: "different" },
      { a: "Case for Samsung Galaxy S21", b: "Samsung Galaxy S21", truth: "accessory" },
    ],
  },
  {
    name: "appliances and electronics",
    entries: ["LG OLED C2 55 inch TV", "LG OLED C2 65 inch TV", "Samsung QN90B 55 inch TV", "Sonos One Gen 2", "Sonos One SL", "Kindle Paperwhite 11th Generation", "Kindle Paperwhite 10th Generation"],
    pairs: [
      { a: "LG OLED C2 55 inch TV", b: "lg oled c2 55 inch tv", truth: "same" },
      { a: "LG OLED C2 55 inch TV", b: "LG OLED C2 65 inch TV", truth: "different" },
      { a: "Sonos One Gen 2", b: "Sonos One SL", truth: "different" },
      { a: "Kindle Paperwhite 11th Generation", b: "Kindle Paperwhite 10th Generation", truth: "different" },
      { a: "Wall mount for LG OLED C2 55 inch TV", b: "LG OLED C2 55 inch TV", truth: "accessory" },
    ],
  },
];

run(() => {
  let sameN = 0;
  let sameConfirmed = 0;
  const falseConfirmed: string[] = [];
  const falseDifferentOnSame: string[] = [];
  const vetoOnSame: string[] = [];
  const missedVeto: string[] = [];
  let hardTotal = 0;
  let hardVetoed = 0;

  for (const c of CATEGORIES) {
    const entries = c.entries.map((name, i) => ({ id: `${c.name}-${i}`, name }));
    const idOf = (n: string) => entries.find((e) => e.name === n)?.id;
    // the pair members that are not entries (a lower-cased copy, an accessory listing) are added as their own entries so both sides exist in the Database, like a real library
    const extra: Array<{ id: string; name: string }> = [];
    for (const p of c.pairs) for (const n of [p.a, p.b]) if (!idOf(n) && !extra.find((e) => e.name === n)) extra.push({ id: `${c.name}-x${extra.length}`, name: n });
    const all = [...entries, ...extra];
    const ctx = buildContext(all, c.entries.map((t, i) => ({ text: t, origin: `seller:${i}`, kind: "listing" as const })));
    const find = (n: string) => all.find((e) => e.name === n)!;
    for (const p of c.pairs) {
      const A = find(p.a);
      const B = find(p.b);
      const v = compareProducts(ctx.info(A.id)!, ctx.info(B.id)!, ctx);
      if (p.truth === "same") {
        sameN++;
        if (v.verdict === "confirmed") sameConfirmed++;
        if (v.verdict === "different") falseDifferentOnSame.push(`${c.name}: ${p.a} || ${p.b}`);
        // listing "a" matched to entry "b" by the existing matcher: the safeguard must never veto a right match
        if (evaluateMatch({ title: p.a, matchedName: null, entry: B }, all, ctx).decision === "veto") vetoOnSame.push(`${c.name}: ${p.a} -> ${p.b}`);
      } else {
        if (v.verdict === "confirmed") falseConfirmed.push(`${c.name}: ${p.a} || ${p.b}`);
        // an accessory or a different model matched to the other entry: count how often the safeguard catches it
        if (p.truth === "accessory") {
          hardTotal++;
          if (evaluateMatch({ title: p.a, matchedName: null, entry: B }, all, ctx).decision === "veto") hardVetoed++;
          else missedVeto.push(`${c.name}: ${p.a} -> ${p.b}`);
        }
      }
    }
  }

  section(`safety across ${CATEGORIES.length} unfamiliar categories (${CATEGORIES.reduce((n, c) => n + c.pairs.length, 0)} labelled pairs)`);
  check("no pair of different products, or a product and its accessory, is ever CONFIRMED as the same", falseConfirmed.length === 0, falseConfirmed);
  check("no pair of the same product is ever called DIFFERENT", falseDifferentOnSame.length === 0, falseDifferentOnSame);
  check("the veto never rejects a right match", vetoOnSame.length === 0, vetoOnSame);

  section("recognition and blocking (measured; floors, not guarantees)");
  check(`the same product written with different case is confirmed (${sameConfirmed} of ${sameN})`, sameN > 0 && sameConfirmed === sameN, { sameN, sameConfirmed });
  check(`most accessories matched to the product they go with are vetoed (${hardVetoed} of ${hardTotal})`, hardTotal > 0 && hardVetoed / hardTotal >= 0.6, missedVeto);
});
