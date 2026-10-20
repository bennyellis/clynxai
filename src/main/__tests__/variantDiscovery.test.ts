// Owner decisions 2026-10-20 (CLYNX_VARIANTS_AND_ADDONS_AUDIT): versions found from sources in a fixed order, kept in a queue that never drops a name, one source = a suggestion, and add-ons
// always get their own accessory entry. Fakes and a throwaway Database only: no network, no model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyComparable, usableForValuation } from "../compIdentity.js";
import type { EditionFinding } from "../editionDiscovery.js";
import { Store } from "../store.js";
import type { VariantVerdict } from "../variantEvidence.js";
import {
  addonCandidatesFromPages,
  addonFromListing,
  addonEntryKey,
  sameAddonLoosely,
  decideVariant,
  findingsToCandidates,
  memoryHints,
  mergeCandidates,
  parseAspectRefinements,
  specificsToCandidates,
  type AspectDistribution,
  type Candidate,
  type PageText,
} from "../variantDiscovery.js";
import { gatherCandidates, runQueueTick, type GatherDeps, type TickDeps } from "../variantQueue.js";
import { check, run, section } from "./_testkit.js";

const BASE = "Xbox Series X";
const verdict = (claim: string, status: VariantVerdict["status"], hosts: string[] = []): VariantVerdict => ({
  claim,
  status,
  basis: "test",
  sources: hosts.map((h) => ({ title: h, url: `https://${h}/x`, host: h, sourceClass: "retailer" as const, matched: [], missing: [], fullMatch: true, negative: false })),
  matchedAttributes: [],
  missingAttributes: [],
  searched: [],
  checkedAt: 1,
});
const finding = (name: string, support: "confirmed" | "reported", url = "https://xbox.com/a"): EditionFinding => ({ name, support, sources: [{ url, quality: "official", quote: name }], models: [], themeTerms: [] });

const ASPECTS: AspectDistribution[] = [
  { name: "Storage Capacity", values: [{ value: "1 TB", count: 220 }, { value: "2 TB", count: 61 }, { value: "512 GB", count: 2 }, { value: "N/A", count: 40 }] },
  { name: "Color", values: [{ value: "Black", count: 250 }, { value: "Carbon Black", count: 30 }, { value: "Galaxy Black", count: 12 }, { value: "Robot White", count: 9 }, { value: "Multicolor", count: 20 }] },
  { name: "Edition", values: [{ value: "Halo Infinite Limited Edition", count: 8 }, { value: "Digital Edition", count: 5 }, { value: "Series X", count: 300 }, { value: "Series S", count: 90 }, { value: "Standard", count: 2 }] },
  { name: "Brand", values: [{ value: "Microsoft", count: 400 }] },
];

run(async () => {
  section("eBay item specifics: the first source, deterministic, noise-free");
  const spec = specificsToCandidates(BASE, ASPECTS, 420);
  const names = spec.map((c) => c.name);
  check("storage, colour and edition values become versions of the base", ["Xbox Series X 1TB", "Xbox Series X 2TB", "Xbox Series X Carbon Black", "Xbox Series X Galaxy Black", "Xbox Series X Robot White", "Xbox Series X Halo Infinite Limited Edition", "Xbox Series X Digital Edition"].every((n) => names.includes(n)), names);
  check("a placeholder, a rare value and an unrelated aspect are not versions", !names.some((n) => /N\/A|Multicolor|512GB|Microsoft|Standard/i.test(n)), names);
  check("another model of the line ('Series S') and the base's own words are not versions", !names.some((n) => /Series S\b/.test(n)) && !names.includes("Xbox Series X Series X"), names);
  check("every candidate says it came from eBay listings and how many", spec.every((c) => c.sources.join() === "ebay_specifics" && /eBay listings \(\d+ use/.test(c.evidence[0])));
  const shuffled = specificsToCandidates(BASE, [...ASPECTS].reverse().map((a) => ({ ...a, values: [...a.values].reverse() })), 420).map((c) => c.name);
  check("the same input in a different order gives the SAME list in the SAME order", JSON.stringify(shuffled) === JSON.stringify(names), { shuffled, names });
  check("capacities are normalised ('2 TB' and '2TB' are one)", specificsToCandidates(BASE, [{ name: "Storage Capacity", values: [{ value: "2 TB", count: 10 }, { value: "2TB", count: 10 }] }], 20).map((c) => c.name).filter((n) => n === "Xbox Series X 2TB").length >= 1);
  check("refinements are read from eBay's response shape, and a malformed one is just empty", parseAspectRefinements({ refinement: { aspectDistributions: [{ localizedAspectName: "Color", aspectValueDistributions: [{ localizedAspectValue: "Carbon Black", matchCount: 30 }, { localizedAspectValue: "x" }] }, { nope: 1 }] } }).length === 1 && parseAspectRefinements(null).length === 0 && parseAspectRefinements({}).length === 0);

  section("catalogues and the model's memory");
  const cat = findingsToCandidates(BASE, [finding("Xbox Series X Starfield Limited Edition", "confirmed"), finding("Xbox Series X Cyberpunk 2077 Limited Edition", "reported"), finding("Xbox Wireless Controller Starfield", "confirmed"), finding("Xbox Series S Starfield Edition", "confirmed")]);
  check("editions the catalogues name are candidates with their support; a controller and another console are not", cat.map((c) => c.name).join() === "Xbox Series X Starfield Limited Edition,Xbox Series X Cyberpunk 2077 Limited Edition" && cat[0].support === "confirmed" && cat[1].support === "reported", cat);
  const mem = memoryHints(BASE, ["Xbox Series X Forza Horizon 5 Edition", "Xbox Series S", "Xbox One X"]);
  check("memory suggests only versions of THIS product", mem.map((c) => c.name).join() === "Xbox Series X Forza Horizon 5 Edition" && mem[0].sources.join() === "memory");
  const merged = mergeCandidates(spec, cat, mem, memoryHints(BASE, ["xbox series x 1tb"]));
  const one = merged.find((c) => c.name === "Xbox Series X 1TB");
  check("the same version named by two sources becomes one candidate with both", !!one && one.sources.includes("ebay_specifics") && one.sources.includes("memory") && merged.filter((c) => /1TB/i.test(c.name)).length === 1, one);
  check("confirmed catalogue findings are listed first, deterministically", merged[0].support === "confirmed" && JSON.stringify(mergeCandidates(spec, cat, mem).map((c) => c.name)) === JSON.stringify(mergeCandidates(spec.slice().reverse(), cat.slice().reverse(), mem).map((c) => c.name)));

  section("the one-source rule");
  const solo = (sources: Candidate["sources"], support?: Candidate["support"]): Candidate => ({ name: "Xbox Series X Starfield Limited Edition", kind: "variant", sources, support, evidence: [] });
  check("verified (the maker names it) -> entry", decideVariant(solo(["catalogue"]), verdict("x", "verified", ["xbox.com"])).action === "create");
  check("supported by ONE retailer, one source kind -> only a suggestion", decideVariant(solo(["catalogue"], "reported"), verdict("x", "supported", ["bestbuy.com"])).action === "suggest");
  check("supported by one retailer AND named by eBay listings too -> entry (two voices)", decideVariant(solo(["catalogue", "ebay_specifics"], "reported"), verdict("x", "supported", ["bestbuy.com"])).action === "create");
  check("supported by two different retailers -> entry", decideVariant(solo(["catalogue"], "reported"), verdict("x", "supported", ["bestbuy.com", "walmart.com"])).action === "create");
  check("a confirmed catalogue finding that the evidence check supports -> entry", decideVariant(solo(["catalogue"], "confirmed"), verdict("x", "supported", ["bestbuy.com"])).action === "create");
  check("eBay specifics alone, or the model's memory alone, never create", decideVariant(solo(["ebay_specifics"]), verdict("x", "unverified")).action === "suggest" && decideVariant(solo(["memory"]), verdict("x", "unverified")).action === "suggest" && decideVariant(solo(["memory"]), verdict("x", "supported", ["bestbuy.com"])).action === "suggest");
  check("eBay specifics plus a confirmed catalogue create even before the page check is conclusive", decideVariant(solo(["ebay_specifics", "catalogue"], "confirmed"), verdict("x", "unverified")).action === "create");
  check("a real listing that uses the name confirms it", decideVariant(solo(["listing"]), null).action === "create");
  check("disproven -> rejected", decideVariant(solo(["catalogue"]), verdict("x", "disproven")).action === "reject");

  section("add-ons: named in a source, never from memory");
  const pages: PageText[] = [
    { url: "https://www.xbox.com/en-US/accessories", sourceClass: "manufacturer", text: "Shop the Xbox Wireless Controller in Carbon Black. The Xbox Wireless Controller pairs over Bluetooth. Seagate Storage Expansion Card for Xbox Series X|S adds 1TB. Xbox Stereo Headset. Xbox Elite Wireless Controller Series 2." },
    { url: "https://www.example-review.com/best", sourceClass: "reference", text: "We tested the Xbox Wireless Controller and the Seagate Storage Expansion Card. The Controller is great. With the headset you get more. Xbox Series X Console is the base." },
    { url: "https://www.ebay.com/itm/123", sourceClass: "marketplace", text: "Cheap Xbox Mega Charging Dock Xbox Mega Charging Dock" },
  ];
  const addons = addonCandidatesFromPages(BASE, pages);
  const addonNames = addons.map((a) => a.name);
  check("accessories the pages print are candidates, most-named first", addonNames[0] === "Xbox Wireless Controller" && addonNames.includes("Seagate Storage Expansion Card") && addonNames.includes("Xbox Stereo Headset"), addonNames);
  check("a name needs a source: marketplace pages and sentence fragments are ignored", !addonNames.some((n) => /Mega Charging Dock|^The |^With /.test(n)), addonNames);
  check("the base product itself is not its own add-on", !addonNames.some((n) => /Series X Console/.test(n)));
  check("two sites, or the maker, make it 'confirmed'; each says where it was read", addons.find((a) => a.name === "Xbox Wireless Controller")?.support === "confirmed" && addons[0].evidence.includes("xbox.com") && addons.every((a) => a.kind === "addon"));
  check("a name printed only once on a non-maker page is not enough", addonCandidatesFromPages(BASE, [{ url: "https://blog.example.com/a", sourceClass: "other", text: "I like the Xbox Wireless Controller." }]).length === 0);
  check("a scanned listing's extra is a candidate; filler and non-accessories are not", addonFromListing("Second Wireless Controller", "L1")?.sources.join() === "listing" && addonFromListing("Xbox Series X Galaxy Black", null) === null && addonFromListing("(", null) === null);

  section("an add-on entry never prices a console, and a console never prices it");
  const controllerPricesConsole = classifyComparable({ name: "Xbox Series X" }, "Xbox Wireless Controller Carbon Black");
  const consolePricesController = classifyComparable({ name: "Xbox Wireless Controller" }, "Xbox Series X 1TB Console Black");
  check("a controller listing does not price the console", !usableForValuation(controllerPricesConsole.verdict), controllerPricesConsole);
  check("a console listing does not price the controller entry", !usableForValuation(consolePricesController.verdict), consolePricesController);
  check("the controller entry's own listings do price it", usableForValuation(classifyComparable({ name: "Xbox Wireless Controller" }, "Microsoft Xbox Wireless Controller Carbon Black").verdict));

  section("the queue: nothing is dropped by a cap, and each tick is throttled");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-vd-"));
  const store = new Store(path.join(dir, "scout.db"));
  const baseId = store.addProductStub("base", BASE);
  const ebayDown = { aspects: ASPECTS, total: 420 };
  const gdeps = (over: Partial<GatherDeps> = {}): GatherDeps => ({
    store,
    ebaySpecifics: async () => ebayDown,
    editions: async () => [finding("Xbox Series X Starfield Limited Edition", "confirmed"), finding("Xbox Series X Cyberpunk 2077 Limited Edition", "reported")],
    memory: async () => ["Xbox Series X Forza Horizon 5 Edition", "Xbox Series X Diablo IV Limited Edition", "Xbox Series X 20th Anniversary Limited Edition"],
    addonPages: async () => pages,
    ...over,
  });
  const g1 = await gatherCandidates({ id: baseId, name: BASE }, gdeps());
  const found = store.listCandidates(baseId, "variant").map((c) => c.name);
  check("EVERY source's version is queued (the old cap of 3 is gone)", found.length >= 11 && ["Xbox Series X 2TB", "Xbox Series X Starfield Limited Edition", "Xbox Series X Diablo IV Limited Edition", "Xbox Series X 20th Anniversary Limited Edition", "Xbox Series X Digital Edition"].every((n) => found.includes(n)), found);
  check("Series S and One X are not versions", !found.some((n) => /Series S\b|One X/.test(n)));
  check("add-ons are queued too, and the result says what each source gave", g1.queued.addons >= 3 && g1.sources.length === 4 && g1.sources.every((s) => s.length > 10), g1);
  check("every candidate starts as 'found, not yet checked'", store.listCandidates(baseId).every((c) => c.status === "queued"));
  const g2 = await gatherCandidates({ id: baseId, name: BASE }, gdeps());
  check("gathering again adds nothing new (same input, same list)", g2.queued.variants === 0 && g2.queued.addons === 0 && store.listCandidates(baseId).length === found.length + g1.queued.addons);

  const created: string[] = [];
  const suggested: string[] = [];
  const addonEntries: string[] = [];
  const tdeps = (over: Partial<TickDeps> = {}): TickDeps => ({
    store,
    parentOf: (id) => (id === baseId ? { id: baseId, name: BASE } : null),
    verify: async (name) => (/Starfield|Halo|1TB|2TB/.test(name) ? verdict(name, "verified", ["xbox.com"]) : /Digital/.test(name) ? verdict(name, "supported", ["bestbuy.com"]) : verdict(name, "unverified")),
    createVariant: async (name) => (created.push(name), `id-${name}`),
    rememberSuggestion: (_p, v) => void suggested.push(v.claim),
    createAddonEntry: async (name) => (addonEntries.push(name), `addon-${name}`),
    paused: () => false,
    sleep: async () => {},
    ...over,
  });
  const t1 = await runQueueTick(tdeps());
  check("one tick checks at most 3 versions and 3 add-ons, and the rest stay queued", t1.added.length + t1.suggested.length + t1.rejected.length <= 3 && t1.addonsAdded.length === 3 && t1.deferred > 0, t1);
  let ticks = 1;
  while (store.nextQueuedCandidates("variant", 1).length + store.nextQueuedCandidates("addon", 1).length > 0 && ticks < 60) {
    await runQueueTick(tdeps());
    ticks++;
  }
  check("repeated ticks work through the WHOLE queue", store.nextQueuedCandidates("variant", 1).length === 0 && store.nextQueuedCandidates("addon", 1).length === 0 && ticks > 2, { ticks });
  const status = (n: string) => store.listCandidates(baseId).find((c) => c.name === n)?.status;
  check("verified versions became entries", status("Xbox Series X Starfield Limited Edition") === "added" && status("Xbox Series X 2TB") === "added" && created.includes("Xbox Series X Halo Infinite Limited Edition"));
  check("a version one retailer supports, with eBay as a second voice, became an entry", status("Xbox Series X Digital Edition") === "added", status("Xbox Series X Digital Edition"));
  check("versions only the model remembered, or only one catalogue reported, stay suggestions", status("Xbox Series X Diablo IV Limited Edition") === "suggestion" && status("Xbox Series X Cyberpunk 2077 Limited Edition") === "suggestion" && suggested.includes("Xbox Series X Diablo IV Limited Edition"));
  check("every add-on found in a source got its own entry", addonEntries.includes("Xbox Wireless Controller") && addonEntries.includes("Seagate Storage Expansion Card") && store.listCandidates(baseId, "addon").every((c) => c.status === "added"), addonEntries);
  check("the entry id and the reason are kept for the 'found' list", store.listCandidates(baseId).filter((c) => c.status === "added").every((c) => !!c.entryId && !!c.note));

  section("pause, failures and a deleted base keep the queue intact");
  const base2 = store.addProductStub("b2", "PlayStation 5");
  store.upsertCandidates(base2, [{ name: "PlayStation 5 Slim", kind: "variant", sources: ["catalogue"], support: "confirmed", evidence: ["sony.com"] }, { name: "PlayStation 5 Pro", kind: "variant", sources: ["catalogue"], evidence: [] }]);
  const paused = await runQueueTick(tdeps({ parentOf: (id) => ({ id, name: "PlayStation 5" }), paused: () => true }));
  check("a paused AI stops the tick and leaves everything queued", paused.stopped === "the AI is paused" && store.listCandidates(base2).every((c) => c.status === "queued"), paused);
  const failing = await runQueueTick(tdeps({ parentOf: (id) => ({ id, name: "PlayStation 5" }), verify: async () => { throw new Error("search down"); } }));
  check("a failed check leaves the name queued for next time (not dropped, not 'rejected')", store.listCandidates(base2).every((c) => c.status === "queued") && failing.deferred >= 2 && store.listCandidates(base2).every((c) => c.attempts === 1 && (c.nextTryAt ?? 0) > Date.now()), failing);
  const gone = await runQueueTick(tdeps({ parentOf: () => null, now: () => Date.now() + 30 * 86400_000 }));
  check("a name whose base was deleted is skipped", store.listCandidates(base2).every((c) => c.status === "skipped"), gone);
  store.deleteProduct(baseId);
  check("deleting a product deletes its found list", store.listCandidates(baseId).length === 0 && store.listCandidates(base2).length === 2);

  section("a suggestion that gains a second kind of source is checked again");
  const base3 = store.addProductStub("b3", "Switch");
  store.upsertCandidates(base3, [{ name: "Switch Lite", kind: "variant", sources: ["catalogue"], evidence: ["a.com"] }]);
  store.setCandidateStatus(base3, "variant", "lite switch", "suggestion", "one source");
  store.upsertCandidates(base3, [{ name: "Switch Lite", kind: "variant", sources: ["ebay_specifics"], evidence: ["eBay listings (9 use Model: Lite)"] }]);
  check("the second source re-queues it, keeping both sources", store.listCandidates(base3)[0].status === "queued" && store.listCandidates(base3)[0].sources.length === 2, store.listCandidates(base3));
  check("an add-on row is created or linked to its entry, switched off, and a dismissed one gets nothing", (() => {
    const a = store.linkResearchedAddon(base3, "Switch Pro Controller", "entry-1");
    const dismissedRow = store.addAddon(base3, { name: "Carrying case", enabled: false });
    store.setAddonStatus(dismissedRow!.id, "dismissed");
    return !!a && a.addonProductId === "entry-1" && a.enabled === false && a.source === "researched_related" && a.status === "suggested" && store.linkResearchedAddon(base3, "Carrying case", "entry-2") === null;
  })());

  section("TESTER's review: a name that always fails never starves the good ones");
  const base4 = store.addProductStub("b4", "Nintendo Switch OLED");
  store.upsertCandidates(base4, ["Bad One", "Bad Two", "Bad Three"].map((n) => ({ name: `Nintendo Switch OLED ${n}`, kind: "variant" as const, sources: ["catalogue" as const], evidence: [] })), 1);
  store.upsertCandidates(base4, [{ name: "Nintendo Switch OLED Zelda Edition", kind: "variant", sources: ["catalogue"], support: "confirmed", evidence: ["nintendo.com"] }], 2);
  let clock = 1_000_000;
  const flaky = tdeps({ parentOf: (id) => ({ id, name: "Nintendo Switch OLED" }), now: () => clock, verify: async (n) => { if (/Bad/.test(n)) throw new Error("page unreadable"); return verdict(n, "verified", ["nintendo.com"]); } });
  await runQueueTick(flaky, { variants: 3 });
  clock += 60_000;
  await runQueueTick(flaky, { variants: 3 });
  check("the good name is reached on the SECOND tick, not never", store.listCandidates(base4).find((c) => /Zelda/.test(c.name))?.status === "added", store.listCandidates(base4).map((c) => `${c.name}:${c.status}:${c.attempts}`));
  check("the failing names are backing off, with the reason kept short", store.listCandidates(base4).filter((c) => /Bad/.test(c.name)).every((c) => c.status === "queued" && c.attempts === 1 && (c.nextTryAt ?? 0) > clock && /could not be checked just now/.test(c.note ?? "")));
  check("a name still in its back-off is not offered", store.nextQueuedCandidates("variant", 10, clock).every((c) => !/Bad/.test(c.name)) && store.nextQueuedCandidates("variant", 10, clock + 7 * 3600_000).some((c) => /Bad/.test(c.name)));
  for (let i = 0; i < 5; i++) {
    clock += 7 * 3600_000;
    await runQueueTick(flaky, { variants: 3 });
  }
  check("after four failed tries a name is set aside with a visible note, not retried forever", store.listCandidates(base4).filter((c) => /Bad/.test(c.name)).every((c) => c.status === "skipped" && /set aside/.test(c.note ?? "")), store.listCandidates(base4).map((c) => `${c.name}:${c.status}:${c.attempts}`));

  section("TESTER's review: only real versions come out of eBay's item specifics");
  const messy: AspectDistribution[] = [
    { name: "Type", values: [{ value: "Home Console", count: 300 }, { value: "Console Only", count: 80 }] },
    { name: "Style", values: [{ value: "Standard", count: 100 }, { value: "Console with Controller", count: 40 }] },
    { name: "Bundle Description", values: [{ value: "With 2 Controllers", count: 20 }, { value: "Console + Game", count: 15 }] },
    { name: "Version", values: [{ value: "NTSC-U/C (US/Canada)", count: 200 }] },
    { name: "Series", values: [{ value: "Series X", count: 300 }] },
    { name: "Edition", values: [{ value: "Standard Edition", count: 60 }, { value: "Console Only", count: 9 }, { value: "Halo Infinite Limited Edition", count: 8 }, { value: "Refurbished Edition", count: 7 }] },
    { name: "Storage Capacity", values: [{ value: "1 TB", count: 200 }, { value: "2 TB", count: 60 }] },
  ];
  const clean = specificsToCandidates("Xbox Series X", messy, 500).map((c) => c.name);
  check("only storage, colour and a real edition remain", clean.join() === "Xbox Series X 1TB,Xbox Series X 2TB,Xbox Series X Halo Infinite Limited Edition", clean);
  check("a phone and a camera get no description words either", specificsToCandidates("iPhone 15 Pro Max", [{ name: "Type", values: [{ value: "Smartphone", count: 90 }, { value: "Bar", count: 40 }] }, { name: "Storage Capacity", values: [{ value: "256 GB", count: 50 }] }], 200).map((c) => c.name).join() === "iPhone 15 Pro Max 256GB" && specificsToCandidates("Canon EOS R6 Mark II", [{ name: "Type", values: [{ value: "Mirrorless", count: 50 }, { value: "Body Only", count: 30 }, { value: "With 24-105mm Lens", count: 20 }] }], 100).length === 0);
  check("eBay specifics plus a source page that does not state the whole name are not two voices", decideVariant(solo(["ebay_specifics"]), { ...verdict("x", "supported", ["bestbuy.com"]), sources: [{ ...verdict("x", "supported", ["bestbuy.com"]).sources[0], fullMatch: false }] }).action === "suggest");

  section("TESTER's review: marketing copy and other platforms are not add-ons");
  const adPages: PageText[] = [
    { url: "https://www.xbox.com/shop", sourceClass: "manufacturer", text: "Add to Cart Stand by for deals. Free Shipping Cable included. Shop All Controller options. Xbox Game Pass Controller offers. New Wireless Headset bundles. Xbox Cloud Gaming Remote Play. Windows 11 PC Controller. Used Controller, Open Box Controller, Refurbished Controller." },
    { url: "https://retail.example.com/x", sourceClass: "retailer", text: "Black Friday Stand sale. Nintendo Switch Pro Controller. PlayStation DualSense Wireless Controller. PS5 Dock. Xbox Series X Console." },
  ];
  check("none of that becomes an add-on", addonCandidatesFromPages("Xbox Series X", adPages).length === 0, addonCandidatesFromPages("Xbox Series X", adPages).map((c) => c.name));
  const goodPage: PageText[] = [{ url: "https://www.xbox.com/accessories", sourceClass: "manufacturer", text: "The Xbox Wireless Controller. Compatible with Xbox Series X|S: the Seagate Storage Expansion Card for Xbox Series X is 1TB. Pair the Wireless Headset for Xbox with it." }];
  const goodNames = addonCandidatesFromPages("Xbox Series X", goodPage).map((c) => c.name);
  check("a real accessory on the maker's page is kept: with the product line in its name, or 'for <product>' beside it", goodNames.includes("Xbox Wireless Controller") && goodNames.includes("Seagate Storage Expansion Card"), goodNames);
  check("one mention on a retailer page is not enough", addonCandidatesFromPages("Xbox Series X", [{ url: "https://r.example.com", sourceClass: "retailer", text: "Xbox Wireless Controller" }]).length === 0);

  section("TESTER's review: a scanned listing's extra becomes ONE clean add-on name for the base product");
  check("'Second Wireless Controller' becomes 'Xbox Wireless Controller'", addonFromListing("Second Wireless Controller", "L1", "Xbox Series X")?.name === "Xbox Wireless Controller");
  check("a leading 'spare' is dropped and a generic name gains the product line; one generic noun is refused", addonFromListing("spare Battery Pack", null, "Xbox Series X")?.name === "Xbox Battery Pack" && addonFromListing("extra Controller", null, "Xbox Series X") === null && addonFromListing("2 controllers", null, "Xbox Series X") === null && addonFromListing("case", null, "Xbox Series X") === null && addonFromListing("headset", null, "Xbox Series X") === null);
  check("the seller's own brand and model words are kept as written, digits included (nothing is invented)", addonFromListing("Seagate expansion card", null, "Xbox Series X")?.name === "Seagate expansion card" && addonFromListing("Turtle Beach headset", null, "Xbox Series X")?.name === "Turtle Beach headset" && addonFromListing("Elite Series 2 controller", null, "Xbox Series X")?.name === "Elite Series 2 controller");
  check("a plural becomes singular", addonFromListing("Wireless Controllers", null, "Xbox Series X")?.name === "Xbox Wireless Controller");
  check("lists and non-accessories are refused", ["charger + 2 games", "HDMI cable and power cord", "Xbox Series X Galaxy Black", "controller, headset", "box"].every((n) => addonFromListing(n, null, "Xbox Series X") === null));
  check("a bare 'Controller' with no product line to add stays refused", addonFromListing("Controller", null) === null);

  section("TESTER's review: a dismissed add-on stays dismissed under another spelling");
  check("same accessory, said differently", [["Xbox Wireless Controller", "Microsoft Xbox Wireless Controller - Carbon Black"], ["Xbox Wireless Controller", "Xbox Controller"], ["Xbox Wireless Controller", "Xbox Wireless Controllers"], ["Xbox Wireless Controller", "xbox wireless controller"]].every(([a, b]) => sameAddonLoosely(a, b)));
  check("different accessories are not the same", !sameAddonLoosely("Xbox Wireless Controller", "Xbox Stereo Headset") && !sameAddonLoosely("Xbox Elite Wireless Controller", "Xbox Stereo Headset") && !sameAddonLoosely("Xbox Wireless Controller", "Xbox Elite Wireless Controller") && !sameAddonLoosely("Xbox Wireless Controller", "Xbox Adaptive Controller"));
  check("plurals and spellings share one entry key, so a second entry is not made", addonEntryKey("Xbox Wireless Controllers") === addonEntryKey("Xbox Wireless Controller") && addonEntryKey("Microsoft Xbox Controller") === addonEntryKey("Xbox Wireless Controller") && addonEntryKey("Xbox Wireless Controller Pulse Red") !== addonEntryKey("Xbox Wireless Controller Carbon Black") && sameAddonLoosely("Xbox Wireless Controller Pulse Red", "Xbox Wireless Controller - Carbon Black") && addonEntryKey("Xbox Series X Case") !== addonEntryKey("Xbox Series X"));

  section("TESTER's review: accessory entries and device entries do not price each other");
  const ctrl = (title: string) => classifyComparable({ name: "Xbox Wireless Controller" }, title);
  check("a console 'with controller' listing does not price the controller entry", !usableForValuation(ctrl("Xbox Series X Console with Controller").verdict), ctrl("Xbox Series X Console with Controller"));
  check("a real controller listing 'for Series X' is not refused as a game", usableForValuation(ctrl("Xbox Wireless Controller for Series X Carbon Black").verdict), ctrl("Xbox Wireless Controller for Series X Carbon Black"));
  const consoleRef = (title: string) => classifyComparable({ name: "Xbox Series X" }, title);
  check("a storage card, dock or case 'for Xbox Series X' does not price the console", ["Seagate Storage Expansion Card 1TB for Xbox Series X", "Xbox Series X Charging Dock", "Carrying Case for Xbox Series X", "Xbox Series X Memory Card"].every((t) => !usableForValuation(consoleRef(t).verdict)));
  check("the console's own listing still prices the console", usableForValuation(consoleRef("Microsoft Xbox Series X 1TB Console Black").verdict));

  section("sources that fail are reported, never read as 'no versions'");
  const quiet = await gatherCandidates({ id: base3, name: "Switch" }, gdeps({ ebaySpecifics: async () => null, editions: async () => null, memory: async () => null, addonPages: async () => null }));
  check("every source explains why it gave nothing", quiet.sources.length === 4 && /no item specifics/.test(quiet.sources[0]) && /blocked or unavailable/.test(quiet.sources[1]) && /not asked/.test(quiet.sources[2]) && /no add-ons were looked for/.test(quiet.sources[3]), quiet.sources);
  const throwing = await gatherCandidates({ id: base3, name: "Switch" }, gdeps({ ebaySpecifics: async () => { throw new Error("401"); } }));
  check("a source that throws is reported and the others still run", /no item specifics/.test(throwing.sources[0]) && throwing.sources.length === 4);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
