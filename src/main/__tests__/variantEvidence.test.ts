// Universal variant recognition: the evidence check (variantEvidence.ts) and the name logic under it (variantIdentity.ts). No network: search and page
// fetch are faked. Xbox Series X 2TB Galaxy Black Special Edition is the case that failed in the field; nothing here special-cases it, and the other
// cases (a phone color, a themed console, a seller-invented name, an accessory, a bundle, something that does not exist) go through the same code.
import {
  nameScore as nameScoreFn,
  assessEvidence as assessLive,
  assessEvidence,
  classifySource,
  describeVerdictForAi,
  reconcileVerdict,
  verifyVariant,
  type VerifyDeps,
} from "../variantEvidence.js";
import { buildSearchPlan, distinguishingTokens, extractVariantAttributes, findParentCandidate, isMoreSpecific, parentGuess } from "../variantIdentity.js";
import { check, run, section } from "./_testkit.js";

interface FakePage {
  url: string;
  title: string;
  text: string;
}

/** A tiny fake web: a search returns the pages whose text contains EVERY word of the query (site: filters by host), like a real engine returns what matches. */
function fakeWeb(pages: FakePage[], blockedHosts: string[] = []): VerifyDeps & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      const site = /site:(\S+)/.exec(query)?.[1];
      const words = query
        .replace(/site:\S+/, "")
        .replace(/"/g, "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      return pages
        .filter((p) => !site || new URL(p.url).hostname.endsWith(site))
        .filter((p) => {
          const hay = `${p.title} ${p.text} ${new URL(p.url).hostname.replace(/\./g, " ")}`.toLowerCase().replace(/(\d)\s+(tb|gb)/g, "$1$2");
          return words.every((w) => hay.includes(w.replace(/(\d)\s+(tb|gb)/, "$1$2")));
        })
        .map((p) => ({ title: p.title, url: p.url, snippet: p.text.slice(0, 160) }));
    },
    async fetchText(url) {
      if (blockedHosts.some((h) => url.includes(h))) return null;
      return pages.find((p) => p.url === url)?.text ?? null;
    },
  };
}

const XBOX_PAGE: FakePage = {
  url: "https://www.xbox.com/en-us/consoles/xbox-series-x",
  title: "Xbox Series X | Xbox",
  text: "Xbox Series X – 1TB Carbon Black. Xbox Series X – 2TB Galaxy Black Special Edition. Xbox Series X – 2TB Digital Edition White. Play thousands of games.",
};


// Strings taken from the first LIVE run of the verifier (the user's PC, 2026-10-15): real pages put a claim's words in captions and buttons.
{
  const real = [
    ["An XBOX Series X Galaxy and an adaptive joystick controller.", "Xbox Series X Galaxy"],
    ["Buy Halo Infinite XBOX Series X", "Xbox Series X Halo Infinite Edition"],
  ] as const;
  for (const [text, claim] of real) {
    check(`a live caption / button is not a product name: "${text}"`, nameScoreFn(text, claim) < 0, nameScoreFn(text, claim));
  }
  for (const [text, claim] of [
    ["Microsoft Xbox Series X Halo Infinite Limited Edition", "Xbox Series X Halo Infinite Edition"],
    ["Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy"],
    ["Halo Infinite Limited Edition Xbox Series X + Controller", "Xbox Series X Halo Infinite Edition"],
  ] as const) {
    check(`a product title reads as a name: "${text}"`, nameScoreFn(text, claim) >= 0, nameScoreFn(text, claim));
  }
  const v = assessLive("Xbox Series X Galaxy", [{ title: "Xbox | Microsoft Store", url: "https://www.microsoft.com/en-us/store/b/xbox", excerpt: "Shop consoles\nAn XBOX Series X Galaxy and an adaptive joystick controller.\nGames" }]);
  check("the claim still verifies from that page, but the caption is never used as the product's name", v.status === "verified" && v.officialName === undefined, { status: v.status, name: v.officialName });
  const h = assessLive("Xbox Series X Halo Infinite Edition", [
    { title: "Xbox", url: "https://www.xbox.com/en-US/games/halo-infinite", excerpt: "Buy Halo Infinite XBOX Series X" },
    { title: "Walmart", url: "https://www.walmart.com/ip/halo", excerpt: "Microsoft Xbox Series X Halo Infinite Limited Edition\nIn stock" },
  ]);
  check("the product title (not the 'Buy ...' button) becomes the official name", h.officialName === "Microsoft Xbox Series X Halo Infinite Limited Edition", h.officialName);
}

run(async () => {
  section("Xbox Series X 2TB Galaxy Black Special Edition: the exact title finds nothing, the plan keeps going until the manufacturer's page");
  {
    const web = fakeWeb([XBOX_PAGE]);
    // The exact quoted title matches nothing on this fake engine (the engine matches words in the page text; the quote forces all of them: the page has them,
    // so make the engine stricter by hiding it from the first two queries: only site: and variants searches reveal it).
    const strict: VerifyDeps = {
      ...web,
      async search(q, n) {
        web.queries.push(q);
        if (!/site:|editions colors storage/.test(q)) return [];
        return web.search(q, n);
      },
    };
    web.queries.length = 0;
    const v = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", strict, {});
    check("verified, from the manufacturer", v.status === "verified" && v.sources.some((s) => s.sourceClass === "manufacturer" && s.fullMatch), v);
    check("the exact title was tried first", web.queries[0]?.startsWith('"Xbox Series X 2TB Galaxy Black Special Edition"'), web.queries);
    check("then it widened beyond the exact title", web.queries.length > 1, web.queries);
    check("the basis names the manufacturer's site", /xbox\.com/.test(v.basis), v.basis);
    check("every identifying word was matched", v.missingAttributes.length === 0, v.missingAttributes);
  }

  section("a different edition on the same page does not verify this one");
  {
    const v = assessEvidence("Xbox Series X 2TB Diamond Gold Special Edition", [{ title: XBOX_PAGE.title, url: XBOX_PAGE.url, excerpt: XBOX_PAGE.text }]);
    check("unverified (the page covers the line, not this edition)", v.status === "unverified", v);
    check("it says which words are missing, not that the product is fake", v.missingAttributes.includes("diamond") && !/fake|does not exist/i.test(v.basis) || /not ruled out|does not mean/i.test(v.basis), v);
  }

  section("an empty search is UNVERIFIED, never disproven");
  {
    const v = await verifyVariant("Zorblax Quantum Console 7TB Aurora Edition", fakeWeb([]), {});
    check("unverified", v.status === "unverified", v);
    check("the basis says absence proves nothing", /does not mean it does not exist/i.test(v.basis), v.basis);
    check("every attempt is recorded", v.searched.length >= 3, v.searched);
    check("the AI is told not to call it fake", /Do NOT say it is fake/.test(describeVerdictForAi(v)));
  }

  section("legitimate variants across categories (same code, nothing special-cased)");
  const legit: Array<[string, FakePage]> = [
    ["iPhone 15 Pro 256GB Natural Titanium", { url: "https://www.apple.com/iphone-15-pro/specs/", title: "iPhone 15 Pro - Technical Specifications", text: "iPhone 15 Pro. Capacity 128GB 256GB 512GB 1TB. Finishes: Natural Titanium, Blue Titanium, White Titanium, Black Titanium." }],
    ["Nintendo Switch OLED Zelda Edition", { url: "https://www.nintendo.com/us/switch/oled-model-zelda-edition/", title: "Nintendo Switch OLED Model The Legend of Zelda: Tears of the Kingdom Edition", text: "Nintendo Switch OLED Model Zelda Edition console with golden Triforce dock." }],
    ["Samsung Galaxy S24 Ultra 512GB Titanium Violet", { url: "https://www.samsung.com/us/smartphones/galaxy-s24-ultra/", title: "Galaxy S24 Ultra", text: "Galaxy S24 Ultra 512GB in Titanium Violet, Titanium Gray, Titanium Black." }],
    ["Dyson V8 Absolute Nickel Iron", { url: "https://www.dyson.com/vacuum-cleaners/cordless/v8/absolute-nickel-iron", title: "Dyson V8 Absolute", text: "Dyson V8 Absolute vacuum, Nickel Iron." }],
    ["PS5 Slim Digital 1TB Marvel's Spider-Man 2 Limited Edition Bundle", { url: "https://www.playstation.com/en-us/ps5/spider-man-2-bundle/", title: "PS5 Slim Digital Edition Marvel's Spider-Man 2 Limited Edition Bundle", text: "PS5 Slim Digital 1TB with Marvels Spider-Man 2 limited edition bundle." }],
  ];
  for (const [name, page] of legit) {
    const v = await verifyVariant(name, fakeWeb([page]), {});
    check(`${name}: verified`, v.status === "verified", { status: v.status, basis: v.basis, missing: v.missingAttributes });
  }

  section("a seller-invented name: only seller listings use it, so it is unverified (and the answer says why)");
  {
    const web = fakeWeb([
      { url: "https://www.ebay.com/itm/1234567890", title: "Xbox Series X Diamond Gold Edition Console", text: "Xbox Series X Diamond Gold Edition console custom shell." },
      { url: "https://www.facebook.com/marketplace/item/999", title: "Xbox Series X Diamond Gold Edition", text: "Xbox Series X Diamond Gold Edition for sale." },
    ]);
    const v = await verifyVariant("Xbox Series X Diamond Gold Edition", web, {});
    check("unverified", v.status === "unverified", v);
    check("it explains that sellers use the name", /seller listings/i.test(v.basis), v.basis);
    check("marketplace sources are classed as marketplace", v.sources.every((s) => s.sourceClass === "marketplace"), v.sources);
  }

  section("a source that says it is not official disproves it; a manufacturer page that lists it overrides that");
  {
    const denial: FakePage = { url: "https://www.theverge.com/xbox-diamond-gold", title: "No, the Xbox Series X Diamond Gold Edition is not real", text: "The Xbox Series X Diamond Gold Edition is not an official Microsoft product. It is an aftermarket custom-painted console." };
    const web = fakeWeb([denial]);
    const v = await verifyVariant("Xbox Series X Diamond Gold Edition", web, {});
    check("disproven by a reference source", v.status === "disproven" && /theverge\.com/.test(v.basis), v);
    const both = assessEvidence("Xbox Series X Diamond Gold Edition", [
      { title: denial.title, url: denial.url, excerpt: denial.text },
      { title: "Xbox Series X Diamond Gold Edition", url: "https://www.xbox.com/en-us/consoles/diamond-gold", excerpt: "Xbox Series X Diamond Gold Edition. Buy now." },
    ]);
    check("the manufacturer listing it wins over a denial", both.status === "verified", both);
  }

  section("a retailer page the user supplied: read first, supported at most (it may be a third-party seller); an unreadable one is unverified, not fake");
  {
    const walmart: FakePage = { url: "https://www.walmart.com/ip/Microsoft-Xbox-Series-X-2TB-Console-Galaxy-Black-Special-Edition/14579873332", title: "Microsoft Xbox Series X 2TB Console Galaxy Black Special Edition", text: "Microsoft Xbox Series X 2TB Console Galaxy Black Special Edition. Sold and shipped by a seller." };
    const readable = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", fakeWeb([]), { userUrls: [walmart.url], maxSteps: 0, ...{} });
    check("no page text, no verdict beyond unverified", readable.status === "unverified", readable);
    const web = fakeWeb([walmart]);
    const v = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", web, { userUrls: [walmart.url], maxSteps: 2 });
    check("the retailer page supports it", v.status === "supported" || v.status === "verified", v);
    check("a retailer page alone is not called verified", v.status === "supported", v);
    const blocked = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", fakeWeb([], ["walmart.com"]), { userUrls: [walmart.url], maxSteps: 1 });
    check("an unreadable page is recorded as such", blocked.searched.some((s) => /could not read/.test(s)), blocked.searched);
    check("and never turns into 'fake'", blocked.status === "unverified", blocked);
  }

  section("conversation consistency: a later, thinner look never overturns what was verified");
  {
    const verified = assessEvidence("Xbox Series X 2TB Galaxy Black Special Edition", [{ title: XBOX_PAGE.title, url: XBOX_PAGE.url, excerpt: XBOX_PAGE.text }]);
    const thin = assessEvidence("Xbox Series X 2TB Galaxy Black Special Edition", []);
    const merged = reconcileVerdict(verified, thin);
    check("verified stays verified", merged.status === "verified", merged);
    check("a better look replaces a weaker one", reconcileVerdict(thin, verified).status === "verified");
    const denial = assessEvidence("Xbox Series X 2TB Galaxy Black Special Edition", [{ title: "x", url: "https://www.theverge.com/a", excerpt: "The Xbox Series X 2TB Galaxy Black Special Edition is not an official product, it is fake." }]);
    const held = reconcileVerdict(verified, denial);
    check("a denial does not flip a verified product on its own", held.status === "verified" && /later source disagrees/i.test(held.basis), held);
    check("a different claim is not reconciled with it", reconcileVerdict(verified, assessEvidence("Something Else Entirely", [])).claim === "Something Else Entirely");
  }

  section("source classes");
  check("xbox.com is the manufacturer of an Xbox", classifySource("https://www.xbox.com/x", "Xbox Series X") === "manufacturer");
  check("apple.com is the manufacturer of an iPhone", classifySource("https://www.apple.com/iphone", "iPhone 15 Pro") === "manufacturer");
  check("a brand hint names the manufacturer of a line nobody listed", classifySource("https://www.zorblax-corp.com/p", "Zorblax Hub", ["zorblaxcorp"]) === "manufacturer");
  check("walmart.com is a retailer", classifySource("https://www.walmart.com/ip/1", "Xbox Series X") === "retailer");
  check("ebay.com is a marketplace", classifySource("https://www.ebay.com/itm/1", "Xbox Series X") === "marketplace");
  check("a regional marketplace address is still a marketplace", classifySource("https://www.ebay.co.uk/itm/1", "Xbox Series X") === "marketplace");
  check("wikipedia is a reference", classifySource("https://en.wikipedia.org/wiki/Xbox_Series_X", "Xbox Series X") === "reference");
  check("a random blog is other", classifySource("https://someblog.net/post", "Xbox Series X") === "other");
  check("the product's own retailer-maker counts as the maker (dell.com for a Dell)", classifySource("https://www.dell.com/xps", "Dell XPS 13 512GB") === "manufacturer");

  section("a model letter is not enough on its own: a Series S page does not verify a Series X");
  {
    const v = assessEvidence("Xbox Series X 2TB Galaxy Black", [{ title: "Xbox Series S", url: "https://www.xbox.com/consoles/series-s", excerpt: "Xbox Series S 512GB Robot White. Also X|S bundles. 2TB expansion Galaxy Black storage card." }]);
    check("not verified", v.status !== "verified", v);
  }

  section("variant attributes, parents and what makes a name more specific");
  {
    const a = extractVariantAttributes("Xbox Series X 2 TB Galaxy Black Special Edition");
    check("capacity found (2 TB = 2tb)", a.capacities.includes("2tb"), a);
    check("color found", a.colors.includes("black"), a);
    check("edition marker found", a.editionTerms.includes("special"), a);
    check("a themed edition word is captured", extractVariantAttributes("Nintendo Switch Zelda Edition").editionTerms.includes("zelda"));
    check("a color before 'edition' is a color, not a theme", !extractVariantAttributes("Xbox Series X Black Edition").editionTerms.includes("black"));
    check("regions", extractVariantAttributes("Nintendo Switch Japanese Model").regions.includes("japanese"));
    check("a bundle is recognised", extractVariantAttributes("PS5 Pro with 2 controllers and a 2TB external hard drive").kind === "bundle");
    check("an accessory is recognised", extractVariantAttributes("Xbox Wireless Controller Carbon Black").kind === "accessory");
    check("a console is a base product", extractVariantAttributes("Xbox Series X 1TB").kind === "base");

    const d = distinguishingTokens("Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X");
    check("a theme word no list knows is still distinguishing", d.other.includes("galaxy"), d);
    check("capacity, color and edition are split out", d.capacities.includes("2tb") && d.colors.includes("black") && d.editionTerms.includes("special"), d);
    check("a name that adds nothing is not more specific", !isMoreSpecific("Xbox Series X Console", "Xbox Series X"));
    check("a name that adds a theme is more specific", isMoreSpecific("Xbox Series X Galaxy", "Xbox Series X"));
    check("parentGuess drops capacity, color and edition words", parentGuess("Xbox Series X 2TB Galaxy Black Special Edition") === "Xbox Series X Galaxy", parentGuess("Xbox Series X 2TB Galaxy Black Special Edition"));
  }

  section("parent products and verified variants stay separate and related");
  {
    const db = [{ name: "Xbox Series X" }, { name: "Xbox Series S" }, { name: "Xbox Series X 1TB Carbon Black" }, { name: "PlayStation 5" }, { name: "iPhone 15 Pro" }];
    check("the variant's parent is the product line", findParentCandidate("Xbox Series X 2TB Galaxy Black Special Edition", db)?.name === "Xbox Series X");
    check("a different lettered model is never the parent", findParentCandidate("Xbox Series S 512GB Robot White", db) === null || findParentCandidate("Xbox Series S 512GB Robot White", db)?.name === "Xbox Series S");
    check("a black variant is not filed under a white entry", findParentCandidate("Xbox Series X Robot White", [{ name: "Xbox Series X Carbon Black" }]) === null);
    check("an accessory is not a variant of the console", findParentCandidate("Xbox Series X Wireless Controller Carbon Black", db) === null, findParentCandidate("Xbox Series X Wireless Controller Carbon Black", db));
    check("a Pro is a different product, not a variant", findParentCandidate("iPhone 15 Pro Max 256GB", db) === null);
    check("a phone color variant goes under the phone", findParentCandidate("iPhone 15 Pro 256GB Natural Titanium", db)?.name === "iPhone 15 Pro");
    check("a bundle keeps its relation to the console", findParentCandidate("PlayStation 5 with 2 controllers and 2TB drive", db)?.name === "PlayStation 5");
    check("the most specific entry wins", findParentCandidate("Xbox Series X 1TB Carbon Black Halo Edition", db)?.name === "Xbox Series X 1TB Carbon Black");
    check("a new product with no related entry has no parent", findParentCandidate("Zorblax Hub 7TB", db) === null);
  }

  section("the search plan: manufacturer first-hand sources, the product line, alternate spellings, no hardcoded product");
  {
    const plan = buildSearchPlan("Xbox Series X 2TB Galaxy Black Special Edition");
    check("exact title first", plan[0].purpose === "exact" && plan[0].query.startsWith('"Xbox Series X 2TB'), plan);
    check("a parent+attributes search", plan.some((s) => s.purpose === "parent_attributes" && /xbox series x/i.test(s.query) && /black/i.test(s.query)), plan);
    check("a manufacturer-site search", plan.some((s) => s.purpose === "manufacturer_site" && /site:xbox\.com/.test(s.query)), plan);
    check("a search for the line's own editions and options", plan.some((s) => s.purpose === "parent_variants"), plan);
    check("an alternate spelling of the capacity", plan.some((s) => /2 TB/i.test(s.query)), plan);
    check("brand hints aim a second site search", buildSearchPlan("Xbox Series X Galaxy", { brandHints: ["Microsoft"] }).some((s) => /site:microsoft\.com/.test(s.query)));
    check("no duplicate searches", new Set(plan.map((s) => s.query.toLowerCase())).size === plan.length);
    const car = buildSearchPlan("2024 Toyota Camry XSE Hybrid");
    check("works for a name with no capacity, color or edition", car.length >= 2 && car[0].purpose === "exact", car);
  }
});
