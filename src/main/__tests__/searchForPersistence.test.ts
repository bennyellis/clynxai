// Beta 12 (late change): the active Search For list persists across restarts, with each entry's own settings, using the existing config.json (no second store).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, normalizeSearchItems, saveConfig } from "../config.js";
import { pushRecentSearch, removeRecentSearch } from "../recentSearches.js";
import { matchSearchItem } from "../scorer.js";
import { check, run, section } from "./_testkit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-sf-"));
let n = 0;
const file = () => path.join(dir, `config-${n++}.json`);
const item = (name: string, over: Record<string, unknown> = {}): any => ({ item: name, typicalResaleUsd: 0, matchKeywords: [name.toLowerCase()], minPriceUsd: null, maxPriceUsd: null, linkedProductId: null, ...over });

run(() => {
  section("restart: the complete active list comes back with every entry's own settings");
  const f = file();
  const cfg: any = { ...DEFAULT_CONFIG };
  cfg.searchItems = [item("iPhone 15", { acceptVariants: true, maxPriceUsd: 500, minPriceUsd: 200 }), item("Xbox Series X", { includeBroken: true, linkedProductId: "p-1", typicalResaleUsd: 400 }), item("PS5")];
  saveConfig(f, cfg);
  const back = loadConfig(f);
  check("all three entries restored, in order", back.searchItems.map((s) => s.item).join("|") === "iPhone 15|Xbox Series X|PS5", back.searchItems);
  check("the variants toggle is restored as set", back.searchItems[0].acceptVariants === true && !back.searchItems[1].acceptVariants && !back.searchItems[2].acceptVariants);
  check("price range, include-broken, linked product and reference price are restored", back.searchItems[0].minPriceUsd === 200 && back.searchItems[0].maxPriceUsd === 500 && back.searchItems[1].includeBroken === true && back.searchItems[1].linkedProductId === "p-1" && back.searchItems[1].typicalResaleUsd === 400);
  check("a restored variants entry really behaves as variants (matching still works after the round trip)", matchSearchItem("Apple iPhone 15 Pro Max", [back.searchItems[0]]) !== null && matchSearchItem("Apple iPhone 15 Pro Max", [back.searchItems[2]]) === null);
  const twice = loadConfig(f);
  check("loading twice gives the same list (nothing is consumed or reset)", JSON.stringify(twice.searchItems) === JSON.stringify(back.searchItems));

  section("restoring entries starts nothing");
  const cfgSrc = fs.readFileSync(path.join(process.cwd(), "src/main/config.ts"), "utf8");
  check("config.ts imports no engine and starts nothing", !/ScrapeEngine|\.start\(|startAll/.test(cfgSrc));
  const indexSrc = fs.readFileSync(path.join(process.cwd(), "src/main/index.ts"), "utf8");
  const coupled = indexSrc.split("\n").filter((l) => /searchItems/.test(l) && /(\.start\(|startAllEngines|startEngine|searchForItemOnActiveAccounts)/.test(l));
  check("no line of index.ts starts an engine because of searchItems", coupled.length === 0, coupled);
  check("there is no auto-start on launch", !/autoStart|startOnLaunch|resumeScanning/i.test(indexSrc));

  section("legacy configurations");
  const legacy = file();
  fs.writeFileSync(legacy, JSON.stringify({ searchItems: [{ item: "Nintendo Switch", typicalResaleUsd: 150, matchKeywords: ["switch"] }, { item: "  Steam Deck ", typicalResaleUsd: "x" }, { item: "nintendo switch" }, { nope: 1 }, null, "junk"] }));
  const l = loadConfig(legacy);
  check("entries saved before the new fields exist load, with acceptVariants false and price range null", l.searchItems.length === 2 && l.searchItems[0].item === "Nintendo Switch" && !l.searchItems[0].acceptVariants && l.searchItems[0].minPriceUsd === null && l.searchItems[0].maxPriceUsd === null, l.searchItems);
  check("a usable entry with a damaged field is kept and repaired (name trimmed, price 0, keywords empty)", l.searchItems[1].item === "Steam Deck" && l.searchItems[1].typicalResaleUsd === 0 && l.searchItems[1].matchKeywords.length === 0, l.searchItems[1]);
  check("duplicates (same name, any case) and junk rows are dropped, nothing else", normalizeSearchItems([item("A"), item("a"), 5, {}]).length === 1);
  const none = file();
  fs.writeFileSync(none, JSON.stringify({ pollIntervalMinutes: 7 }));
  check("a config with no Search For list at all loads with an empty list", loadConfig(none).searchItems.length === 0);
  check("normalizing is not destructive to other fields of an entry (e.g. minSellerRatingPercent)", normalizeSearchItems([{ item: "X", typicalResaleUsd: 1, matchKeywords: ["x"], minSellerRatingPercent: 90 }])[0].minSellerRatingPercent === 90);
  const oldReferencePrices = file();
  fs.writeFileSync(oldReferencePrices, JSON.stringify({ referencePrices: [{ item: "Old Thing", typicalResaleUsd: 50, matchKeywords: ["old thing"] }] }));
  const m = loadConfig(oldReferencePrices);
  check("a config from before the Search For rename still migrates its old list once", m.searchItems.length === 1 && m.searchItems[0].item === "Old Thing");
  saveConfig(oldReferencePrices, { ...m, searchItems: [] } as any);
  check("...but once the user empties the list, the old referencePrices do NOT come back on the next launch", loadConfig(oldReferencePrices).searchItems.length === 0);

  section("add, edit and remove are saved (config.json is the only store)");
  let c: any = loadConfig(file());
  const g = file();
  const add = (e: any) => { c = { ...c, searchItems: [...c.searchItems, e], recentSearches: pushRecentSearch(c.recentSearches, { item: e.item, minPriceUsd: e.minPriceUsd, maxPriceUsd: e.maxPriceUsd, includeBroken: !!e.includeBroken, acceptVariants: !!e.acceptVariants, linkedProductId: null }) }; saveConfig(g, c); };
  add(item("iPhone 15"));
  add(item("PS5", { acceptVariants: true }));
  check("after two adds a restart sees both", loadConfig(g).searchItems.length === 2 && loadConfig(g).recentSearches.length === 2);
  c = { ...c, searchItems: c.searchItems.map((s: any) => (s.item === "iPhone 15" ? { ...s, acceptVariants: true } : s)) }; // the toggle (filters:setSearchItemVariants)
  saveConfig(g, c);
  check("editing the variants toggle persists", loadConfig(g).searchItems.find((s) => s.item === "iPhone 15")?.acceptVariants === true);
  c = { ...c, searchItems: c.searchItems.map((s: any) => (s.item === "iPhone 15" ? (({ acceptVariants, ...rest }: any) => rest)(s) : s)) };
  saveConfig(g, c);
  check("switching it back off persists", !loadConfig(g).searchItems.find((s) => s.item === "iPhone 15")?.acceptVariants);
  c = { ...c, searchItems: c.searchItems.filter((s: any) => s.item !== "PS5") };
  saveConfig(g, c);
  check("deleting persists (the other entry stays, the deleted one does not come back)", loadConfig(g).searchItems.map((s) => s.item).join() === "iPhone 15");
  check("Recent searches are untouched by all of it and still remember each variant setting", loadConfig(g).recentSearches.length === 2 && loadConfig(g).recentSearches.some((r) => r.item === "PS5" && r.acceptVariants === true));
  check("removing a recent search is independent of the active list", (() => { const r = removeRecentSearch(c.recentSearches, { item: "PS5", minPriceUsd: null, maxPriceUsd: null, acceptVariants: true }); return r.length === 1 && c.searchItems.length === 1; })());
  c = { ...c, searchItems: [] };
  saveConfig(g, c);
  check("deleting the last entry persists an empty list", loadConfig(g).searchItems.length === 0);
  check("every handler that changes the list writes config.json (add, remove, variants toggle, remove-from-chip)", ["searchItems: [...config.searchItems, newItem]", "config.searchItems.filter((s) => s.item.trim().toLowerCase() !== item)", "s.item === args.item ? { ...s, acceptVariants }", "config.searchItems.filter((s) => s.item !== args.item)"].every((needle) => {
    const at = indexSrc.indexOf(needle);
    return at > 0 && /saveConfig\(CONFIG_PATH, config\)/.test(indexSrc.slice(at, at + 1800));
  }));

  section("general Discovery settings stay independent of the Search For list");
  const gen = file();
  saveConfig(gen, { ...DEFAULT_CONFIG, searchItems: [item("PS5")], generalDeal: { enabled: false, minConfidence: "high" }, customInstructions: "only cheap stuff", listingsPerLocation: 35, maxListingAgeHours: 48 } as any);
  const gl = loadConfig(gen);
  check("the Search For list is restored", gl.searchItems.length === 1);
  check("general detection and custom instructions keep their existing start-fresh behavior (unchanged by this change)", gl.generalDeal.enabled === DEFAULT_CONFIG.generalDeal.enabled && gl.customInstructions === "");
  check("the other settings (items per location, freshness window, confidence) persist exactly as before", gl.listingsPerLocation === 35 && gl.maxListingAgeHours === 48 && gl.generalDeal.minConfidence === "high");
  const off = file();
  saveConfig(off, { ...DEFAULT_CONFIG, searchItems: [], generalDeal: { enabled: true, minConfidence: "medium" } } as any);
  check("with an empty Search For list general detection is still on", loadConfig(off).generalDeal.enabled === true);
});
