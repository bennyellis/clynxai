// Beta 12, Change 4: "Search for variants". The setting decides which listings Facebook already returned are accepted; it never changes what is searched.
import fs from "node:fs";
import path from "node:path";
import { getSearchQuery, getSearchTerms, isRelevantToSearchItems, isVariantOfEntry, matchSearchItem, scoreListing } from "../scorer.js";
import { pushRecentSearch, removeRecentSearch } from "../recentSearches.js";
import { baseConfig, detail, installFetchStub, resetNetwork, searchItem, setAiReply } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

const entry = (item: string, over: Record<string, unknown> = {}) => searchItem(item, 0, over);
const accepts = (e: any, title: string) => matchSearchItem(title, [e]) !== null;

run(async () => {
  installFetchStub();
  resetNetwork();

  section("iPhone 15: the table (OFF = exactly today's behavior, ON = the family's variants)");
  const off = entry("iPhone 15");
  const on = entry("iPhone 15", { acceptVariants: true });
  const rows: Array<[string, boolean, boolean]> = [
    ["iPhone 15", true, true],
    ["Apple iPhone 15 128GB Blue Unlocked", true, true],
    ["iPhone 15 Plus", false, true],
    ["iPhone 15 Pro", false, true],
    ["iPhone 15 Pro Max 256GB", false, true],
    ["iPhone 14", false, false],
    ["iPhone 16", false, false],
    ["iPhone 15 case", false, false],
    ["iPhone 15 parts only", false, false],
    ["iPhone 15 Pro Max screen protector", false, false],
    ["iPhone 15 charger cable", false, false],
    ["iPhone 14 Pro Max", false, false],
  ];
  for (const [title, wantOff, wantOn] of rows) {
    check(`"${title}": OFF ${wantOff ? "accept" : "reject"}`, accepts(off, title) === wantOff);
    check(`"${title}": ON ${wantOn ? "accept" : "reject"}`, accepts(on, title) === wantOn);
  }
  check("the pre-filter (isRelevantToSearchItems) agrees", isRelevantToSearchItems("iPhone 15 Pro Max", [on]) && !isRelevantToSearchItems("iPhone 15 Pro Max", [off]) && !isRelevantToSearchItems("iPhone 16 Pro", [on]));

  section("other product families (not hardcoded to iPhones)");
  const xbox = entry("Xbox Series X", { acceptVariants: true });
  const xboxOff = entry("Xbox Series X");
  for (const t of ["Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X 1TB Black", "Xbox Series X Digital Edition", "Halo Infinite Limited Edition Xbox Series X Console"]) {
    check(`Xbox ON accepts "${t}"`, accepts(xbox, t));
  }
  for (const t of ["Xbox Series S 512GB", "Xbox One X 1TB", "Xbox Series X Wireless Controller Carbon Black", "Xbox Series X cooling fan stand", "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)", "Call of Duty Black Ops 6 Xbox Series X Brand New", "Xbox Series X for parts only", "Xbox Series X skin"]) {
    check(`Xbox ON rejects "${t}"`, !accepts(xbox, t), matchSearchItem(t, [xbox]));
  }
  check("Xbox OFF is unchanged by the new code for the console titles", accepts(xboxOff, "Xbox Series X 1TB Black") && !accepts(xboxOff, "Xbox Series S 512GB"));
  const ps5 = entry("PS5", { acceptVariants: true });
  check("PS5 ON accepts Pro and Slim, rejects a PS4 and a DualSense", accepts(ps5, "PlayStation 5 Pro PS5 2TB") && accepts(ps5, "PS5 Slim Digital") && !accepts(ps5, "PS4 Pro 1TB") && !accepts(ps5, "PS5 DualSense controller"), 0);
  const sw = entry("Nintendo Switch", { acceptVariants: true });
  check("Switch ON accepts OLED / Lite, rejects Switch 2 games", accepts(sw, "Nintendo Switch OLED Model White") && accepts(sw, "Nintendo Switch Lite Turquoise") && !accepts(sw, "Mario Kart 8 Deluxe - Nintendo Switch game"));

  section("NO extra Facebook searches: the keyword is the entry's own text, flag or not");
  check("getSearchQuery is identical with and without the flag", getSearchQuery(on) === "iPhone 15" && getSearchQuery(off) === "iPhone 15" && getSearchQuery(on) === getSearchQuery(off));
  check("the match phrases are untouched by the flag", JSON.stringify(getSearchTerms(on)) === JSON.stringify(getSearchTerms(off)));
  const engineSrc = fs.readFileSync(path.join(process.cwd(), "src/main/scrapeEngine.ts"), "utf8");
  const searchCalls = (engineSrc.match(/searchMarketplace\(/g) ?? []).length;
  const queries = (engineSrc.match(/getSearchQuery\(/g) ?? []).length;
  check("every Marketplace search in the engine is built from getSearchQuery (no variant fan-out code path)", searchCalls >= 3 && queries >= searchCalls - 1 && !/acceptVariants/.test(engineSrc.slice(engineSrc.indexOf("async searchForItemNow"), engineSrc.indexOf("async runWatchCheck"))), { searchCalls, queries });
  const scraperSrc = fs.readFileSync(path.join(process.cwd(), "src/main/scraper.ts"), "utf8");
  check("the scraper never reads the setting", !/acceptVariants/.test(scraperSrc));

  section("each variant is valued as itself, never from the base model");
  const config = baseConfig({ searchItems: [on], generalDeal: { enabled: true, minConfidence: "medium" } });
  setAiReply({ isPotentialDeal: true, category: "phone", estimatedValueRangeUsd: "900-1000", confidence: "high", conditionImpact: "none", reasoning: "Cheap for a Pro Max.", offTopicSuggestion: null });
  const proMax = detail("Apple iPhone 15 Pro Max 256GB", 450, { description: "works" });
  const baseValue = (item: string) => (item === "iPhone 15" ? 600 : null);
  let usedBase = 0;
  const scoredNoVariantValue = await scoreListing(proMax, config, [], [], (i) => { usedBase++; return baseValue(i); }, () => null);
  check("isVariantOfEntry knows a Pro Max under an 'iPhone 15' search is a variant, the plain model is not", isVariantOfEntry(on, "Apple iPhone 15 Pro Max 256GB") && !isVariantOfEntry(on, "Apple iPhone 15 128GB") && !isVariantOfEntry(off, "Apple iPhone 15 Pro Max"));
  check("the base model's Database value is NOT used for the Pro Max", usedBase === 0 && scoredNoVariantValue.referencePriceUsd === null, { usedBase, ref: scoredNoVariantValue.referencePriceUsd });
  check("with no value of its own it is judged like an unpriced find (and later validated against its own market numbers)", scoredNoVariantValue.extraction.matchedItem === "iPhone 15" && scoredNoVariantValue.dealTier !== null && /variant/i.test(scoredNoVariantValue.extraction.reasoning), scoredNoVariantValue.extraction);
  const scoredOwnValue = await scoreListing(proMax, config, [], [], () => 600, (title) => (/pro max/i.test(title) ? { name: "Apple iPhone 15 Pro Max", value: 1000 } : null));
  check("a Database entry that IS the Pro Max prices it ($1,000, not the base $600)", scoredOwnValue.referencePriceUsd === 1000, scoredOwnValue.referencePriceUsd);
  const plain = detail("Apple iPhone 15 128GB", 300, { description: "works" });
  const scoredPlain = await scoreListing(plain, config, [], [], () => 600, () => null);
  check("the plain model is still priced from its own value", scoredPlain.referencePriceUsd === 600, scoredPlain.referencePriceUsd);
  setAiReply({});
  resetNetwork();

  section("persistence: the setting survives, old entries default to OFF, nothing existing is rewritten");
  const oldRecent: any[] = [{ item: "PS5", minPriceUsd: null, maxPriceUsd: 300, includeBroken: false, linkedProductId: null, at: 1 }]; // saved before Beta 12: no acceptVariants key
  const a = pushRecentSearch(oldRecent, { item: "PS5", minPriceUsd: null, maxPriceUsd: 300, includeBroken: false, linkedProductId: null });
  check("re-adding the same search WITHOUT variants keeps one entry (the old one is the same search)", a.length === 1 && !a[0].acceptVariants);
  const b = pushRecentSearch(oldRecent, { item: "PS5", minPriceUsd: null, maxPriceUsd: 300, includeBroken: false, linkedProductId: null, acceptVariants: true });
  check("the same search WITH variants is a different recent search (both kept)", b.length === 2 && b[0].acceptVariants === true && b[1].acceptVariants !== true, b);
  check("forgetting one leaves the other", removeRecentSearch(b, { item: "PS5", minPriceUsd: null, maxPriceUsd: 300, acceptVariants: true }).length === 1);
  check("an entry saved before Beta 12 has no flag and behaves exactly as before", accepts(searchItem("iPhone 15", 0), "iPhone 15") && !accepts(searchItem("iPhone 15", 0), "iPhone 15 Pro"));
  const indexSrc = fs.readFileSync(path.join(process.cwd(), "src/main/index.ts"), "utf8");
  check("a Search For entry added with the flag carries it; the toggle IPC exists and saves", /acceptVariants: true \} : \{\}/.test(indexSrc) && /filters:setSearchItemVariants/.test(indexSrc));
});
