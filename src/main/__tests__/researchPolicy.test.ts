// Database discovery policy (research.ts): which listings get a photo look, what a product may be filed under, how a skip is worded.
import { cleanFilingName, discoverySettings, planPhotoLook, titleIsVague, type LookPlanInput } from "../research.js";
import { check, run, section } from "./_testkit.js";

const base: LookPlanInput = {
  lowAiMode: true,
  photosEnabled: true,
  hasPhotos: true,
  aiAvailable: true,
  title: "Gaming console works great",
  price: 100,
  isDeal: false,
  matchedItem: null,
  confidence: "low",
  category: "",
  judgeUnavailable: false,
  greenFlag: false,
  watchCandidate: false,
  hiddenGem: false,
  speculativeLeftVisit: 3,
  speculativeLeftPass: 30,
};

run(() => {
  section("titles that say nothing are vague, titles that name something are not");
  for (const t of ["Gaming console works great", "Selling my stuff, moving", "Marcus", "Console", "Laptop for sale", "Headphones", "Handheld game", "Misc household items", "Old stuff"]) {
    check(`"${t}" is vague`, titleIsVague(t));
  }
  for (const t of ["Xbox Series S", "PS5 slim digital", "Dyson V8 cordless vacuum", "Apple iPhone 14 Pro", "Sony WH-1000XM4 headphones", "Canon EOS Rebel T7", "Nintendo Switch OLED console", "Steam Deck 256GB", "RTX 3060 Ti"]) {
    check(`"${t}" is not vague`, !titleIsVague(t));
  }
  check("a capacity alone does not make a title specific", titleIsVague("128gb phone"));

  section("photo look: the reasons that always earned one still do");
  check("a deal", planPhotoLook({ ...base, isDeal: true }).vision && planPhotoLook({ ...base, isDeal: true }).priority === 0);
  check("a near match (green flag)", planPhotoLook({ ...base, greenFlag: true }).vision);
  check("a hidden gem", planPhotoLook({ ...base, hiddenGem: true }).vision);
  check("a Watch candidate comes after a deal", planPhotoLook({ ...base, watchCandidate: true }).priority === 1);
  check("a required look does not spend the speculative allowance", !planPhotoLook({ ...base, isDeal: true }).speculative);

  section("photo look: a listing the text could not settle gets one, within the allowance");
  {
    const p = planPhotoLook(base);
    check("vague title, unsure read: a speculative look, lowest priority of the looks", p.vision && p.speculative && p.priority === 2, p);
    check("and it says why", !!p.why && /title/.test(p.why), p.why);
  }
  check("the AI read of the text was unavailable: a look", planPhotoLook({ ...base, title: "Sony WH-1000XM4 headphones", confidence: "high", judgeUnavailable: true }).vision);
  check("the AI read was unsure about a titled item: a look", planPhotoLook({ ...base, title: "Canon camera with lens and bag", confidence: "low", category: "camera" }).vision);
  {
    const p = planPhotoLook({ ...base, speculativeLeftVisit: 0 });
    check("this location's allowance used up: no look, and it says so (not researched)", !p.vision && p.skip?.status === "unresearched" && p.skip.code === "LOOK_BUDGET", p.skip);
  }
  check("the pass's allowance used up: no look", !planPhotoLook({ ...base, speculativeLeftPass: 0 }).vision);
  {
    const ordinary = planPhotoLook({ ...base, unremarkablePrice: true });
    check("an ordinary price (not a multiple of 5) is never a reason to skip: it still gets the look, but behind the others", ordinary.vision && ordinary.speculative && ordinary.priority === 3, ordinary);
    check("and it does not change a deal's look at all", planPhotoLook({ ...base, isDeal: true, unremarkablePrice: true }).priority === 0);
  }
  {
    const p = planPhotoLook({ ...base, price: 20 });
    check("too cheap to be worth a look: not researched, LOW_PRICE", !p.vision && p.skip?.code === "LOW_PRICE", p.skip);
  }
  check("a confident 'not a deal' on a titled item costs nothing", !planPhotoLook({ ...base, title: "iPhone 13", confidence: "high", category: "smartphone" }).vision);
  check("a confident answer for a vague title with a category (clothing) is left alone", !planPhotoLook({ ...base, title: "Dress", confidence: "medium", category: "clothing" }).vision);
  check("a keyword match with a reference price is never looked at speculatively", !planPhotoLook({ ...base, title: "Xbox Series S", matchedItem: "Xbox Series S", confidence: "high" }).vision);

  section("photo look: when no look is possible, the reason is not a rejection");
  check("photo analysis off: not researched", planPhotoLook({ ...base, photosEnabled: false, isDeal: true }).skip?.code === "PHOTOS_OFF");
  check("no photos: not enough evidence", planPhotoLook({ ...base, hasPhotos: false }).skip?.status === "insufficient_evidence");
  {
    const p = planPhotoLook({ ...base, isDeal: true, aiAvailable: false });
    check("AI unavailable: not enough evidence, and not a rejection", !p.vision && p.skip?.status === "insufficient_evidence" && p.skip.code === "AI_UNAVAILABLE" && /not a rejection/i.test(p.skip.reason), p.skip);
  }

  section("AI saving off: every listing with photos is looked at, as before");
  {
    const p = planPhotoLook({ ...base, lowAiMode: false, title: "iPhone 13", confidence: "high", category: "smartphone" });
    check("looked at, at the lowest priority", p.vision && p.priority === 3 && !p.speculative, p);
  }

  section("filing names: view, bundle and condition asides are dropped");
  {
    const v = cleanFilingName("iPhone 13 128GB (front view)");
    check('"iPhone 13 128GB (front view)" is filed as "iPhone 13 128GB"', v.ok && v.name === "iPhone 13 128GB" && v.changed, v);
  }
  {
    const v = cleanFilingName("Sony PlayStation 5 Slim with Ultra HD Blu-ray Disc Drive (bundle includes two DualSense controllers and two games)");
    check("a bundle aside is dropped, the console's own name stays", v.ok && v.name === "Sony PlayStation 5 Slim with Ultra HD Blu-ray Disc Drive", v);
  }
  check('"Joy-Con (pair)" loses the quantity aside', (() => { const v = cleanFilingName("Joy-Con (pair)"); return v.ok && v.name === "Joy-Con"; })());
  check("a colour that tells products apart is kept", (() => { const v = cleanFilingName("Xbox Series S (Black)"); return v.ok && v.name === "Xbox Series S (Black)" && !v.changed; })());
  check("the broken-copy variant name the Database itself makes is kept", (() => { const v = cleanFilingName("Xbox Series S (For Parts / Broken)"); return v.ok && v.name === "Xbox Series S (For Parts / Broken)"; })());
  check("a clean canonical name passes untouched", (() => { const v = cleanFilingName("NVIDIA GeForce RTX 3060 Ti Founders Edition 8GB"); return v.ok && !v.changed; })());

  section("filing names: checked against names that are really in a user's Database (581 products)");
  {
    const cases: Array<[string, string]> = [
      ["Microsoft Xbox Series X 1TB Console (includes two Xbox Wireless Controllers and charging dock)", "Microsoft Xbox Series X 1TB Console"],
      ["Microsoft Xbox One S Console (with Wireless Controller and 4 Games)", "Microsoft Xbox One S Console"],
      ["Mini refrigerator (top-freezer style)", "Mini refrigerator (top-freezer style)"],
      ["PlayStation 4 500 Million Limited Edition (Jet Black with gold logo)", "PlayStation 4 500 Million Limited Edition (Jet Black with gold logo)"],
      ["Xbox Series S Fortnite Bundle", "Xbox Series S Fortnite Bundle"],
      ["Xbox One Elite Bundle (Limited Edition)", "Xbox One Elite Bundle (Limited Edition)"],
      ["Microsoft Xbox 360 S (Slim) Console", "Microsoft Xbox 360 S (Slim) Console"],
      ["iPhone 15 Pro Max (Natural Titanium)", "iPhone 15 Pro Max (Natural Titanium)"],
      ["Tarantula fursuit partial (head, 4 legs, 2 hands, tail) - handmade/custom", "Tarantula fursuit partial (head, 4 legs, 2 hands, tail)"],
      ["Sony PlayStation 5 Slim, like new, works great", "Sony PlayStation 5 Slim"],
    ];
    for (const [raw, want] of cases) {
      const v = cleanFilingName(raw);
      check(`"${raw}" -> "${want}"`, v.ok && v.name === want, v);
    }
    for (const raw of ["iPhone (front view)", "Power cable for Xbox Series S", "Nintendo AC Adapter (3DS)", "Tempered glass screen protector", "HDMI cable", "Power Adapter"]) {
      const v = cleanFilingName(raw);
      check(`"${raw}" is refused`, !v.ok, v);
    }
  }

  section("filing names: things that are not a product of their own are refused");
  for (const n of ["Power Adapter", "Tempered glass screen protector", "Nintendo Switch AC Adapter (Charger)", "HDMI cable", "Phone case"]) {
    const v = cleanFilingName(n);
    check(`"${n}" is an accessory`, !v.ok && v.code === "NAME_ACCESSORY", v);
  }
  for (const n of ["Phone", "Console", "iPhone", "Xbox", "Laptop", "controller"]) {
    const v = cleanFilingName(n);
    check(`"${n}" only names a kind of thing`, !v.ok && v.code === "NAME_TOO_GENERIC", v);
  }
  {
    const v = cleanFilingName("PS5 and two controllers and a charging dock bundle includes games, headset, cables and a carrying bag");
    check("a description of a listing is not a name", !v.ok && v.code === "NAME_NOT_CANONICAL", v);
  }
  check("an empty name is refused", !cleanFilingName("   ").ok);
  check("real names with digits and hyphens are fine", ["Sony WH-1000XM4", "Dyson V8", "Steam Deck 256GB", "Xbox Series X", "Nintendo 3DS"].every((n) => cleanFilingName(n).ok));

  section("the discovery allowances come from config.json, with safe defaults");
  {
    const d = discoverySettings(undefined);
    check("defaults", d.speculativeLooksPerVisit === 3 && d.speculativeLooksPerPass === 30 && d.marketLooksPerVisit === 2 && d.marketLooksPerPass === 12, d);
    const custom = discoverySettings({ speculativeLooksPerLocation: 0, marketLooksPerLocation: 5 });
    check("0 turns the extra looks off, other numbers are taken", custom.speculativeLooksPerVisit === 0 && custom.marketLooksPerVisit === 5, custom);
    const junk = discoverySettings({ speculativeLooksPerLocation: -4, speculativeLooksPerPass: Number.NaN, marketLooksPerPass: 2.9 } as never);
    check("a nonsense value falls back, a fraction is rounded down", junk.speculativeLooksPerVisit === 3 && junk.speculativeLooksPerPass === 30 && junk.marketLooksPerPass === 2, junk);
  }
});
