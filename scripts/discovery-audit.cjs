// Beta 12 audit tool: where did the listings Clynx "investigated" go, and which of them looks like a MISSED profitable opportunity?
//
//   node scripts\discovery-audit.cjs "C:\path\to\scout.db"        (your real database; it is COPIED first and never modified)
//   node scripts\discovery-audit.cjs --selftest                    (a throw-away database with known cases: proves the tool itself works)
//   add  --since-hours 48   to look at only the newest listings;  --csv out.csv  to write the review list.
//
// It makes NO network call, spends no AI credits, touches no setting and writes nothing but its own report files (discovery-audit-results.json and, with
// --csv, the review list). Real database location on Windows: %APPDATA%\<Clynx app folder>\...\scout.db (search for scout.db in your user folder).
//
// Part 1 - listing accounting: every saved listing by how it ended (research status/code), and how many were never opened.
// Part 2 - missed-opportunity replay, using ONLY data already saved: for each listing that did not become a deal,
//   (a) the Database's own eBay value for the product the title names (Store.getEbayValueForTitle, the same lookup the scanner uses) and the profit that leaves
//       under the default resale settings (84% kept, 20% minimum margin, 15% negotiation reach), with the condition discount the scanner applied;
//   (b) the same maths with NO condition discount: a listing that qualifies only that way was cut down by its condition wording ("no damage" counts as damage);
//   (c) listings whose condition wording is negated ("no damage", "not cracked") yet were discounted;
//   (d) listings of products the Database has no value for that ended as rejected / unclear / out of look budget: the candidates for a manual look.
// Everything is a LEAD for a person to check, not a verdict: a replayed listing is not re-opened, re-photographed or re-priced.
const { buildSync } = require("esbuild");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-discovery-audit-"));
const out = path.join(tmp, "audit.cjs");
const entry = path.join(tmp, "audit-entry.ts");
fs.writeFileSync(
  entry,
  `
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from ${JSON.stringify(path.join(root, "src/main/store.ts"))};
import { resaleOutcome, DEFAULT_RESALE_SETTINGS, CONDITION_VALUE_FACTOR, maxBuyPriceExactUsd } from ${JSON.stringify(path.join(root, "src/main/resaleMath.ts"))};
import { withinNegotiationReach } from ${JSON.stringify(path.join(root, "src/main/profitGate.ts"))};
import { detectConditionImpact } from ${JSON.stringify(path.join(root, "src/main/scorer.ts"))};
import { analyzeCondition } from ${JSON.stringify(path.join(root, "src/main/conditionParser.ts"))};
import { listingOwnText } from ${JSON.stringify(path.join(root, "src/main/listingText.ts"))};

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const settings = DEFAULT_RESALE_SETTINGS;
const NEGATED = /\\b(no|not|without|never|nothing|zero|free of)\\b[^.,;\\n]{0,24}\\b(damage[ds]?|crack(ed|s)?|broken|dead|defect(s|ive)?|scratch(es|ed)?|issues?|problems?)\\b/i;

const MAJ_RE: RegExp[] = [/\\bfor parts\\b/i, /\\bparts only\\b/i, /\\bnot working\\b/i, /\\bdoesn'?t work\\b/i, /\\bwon'?t (turn on|power on|charge)\\b/i, /\\bno power\\b/i, /\\bdead\\b/i, /\\bdefective\\b/i, /\\bicloud locked\\b/i, /\\bblacklisted\\b/i, /\\bneeds repair\\b/i, /\\brepair needed\\b/i];
const MIN_RE: RegExp[] = [/\\bbroken\\b/i, /\\bcrack(ed)?\\b/i, /\\bshatter(ed)?\\b/i, /\\bdamage[ds]?\\b/i, /\\bwater damage\\b/i, /\\bas.?is\\b/i, /\\bmissing (charger|remote|controller|cable)\\b/i];
// Which words triggered the condition discount, with a little text around them and whether they were in the title or the page text.
function conditionWhy(title: string, description: string): string {
  const hits: string[] = [];
  for (const [label, list] of [["MAJOR", MAJ_RE], ["minor", MIN_RE]] as const) {
    for (const re of list) {
      for (const [where, text] of [["title", title], ["page", description]] as const) {
        const m = re.exec(text || "");
        if (m) hits.push(label + " in " + where + ": ..." + text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\\s+/g, " ") + "...");
      }
    }
  }
  return hits.slice(0, 3).join(" | ");
}

// The listing's OWN text: the stored page text cut where Facebook's "Send seller a message" / "Related searches" / "Today's picks" begin (other sellers' cards).
function ownText(page: string): { text: string; cut: boolean } {
  let end = page.length;
  for (const re of [new RegExp("Send seller a message", "i"), new RegExp("Related searches", "i"), new RegExp("Today.s picks", "i")]) {
    const m = re.exec(page);
    if (m && m.index < end) end = m.index;
  }
  return { text: page.slice(0, end), cut: end < page.length };
}

function verdictAt(valueUsd: number, price: number, impact: string): "profitable" | "negotiable" | "no" {
  const factor = (CONDITION_VALUE_FACTOR as any)[impact] ?? 1;
  const lot = valueUsd * factor;
  const o = resaleOutcome(lot, price, settings.netPercent);
  if (o.profitUsd > 0 && o.marginPercent >= settings.minMarginPercent) return "profitable";
  return withinNegotiationReach(lot, price, 0, settings) ? "negotiable" : "no";
}

function selftest(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-discovery-selftest-"));
  const p = path.join(dir, "scout.db");
  const s = new Store(p);
  const id = s.addProductStub("selftest-xbox", "Xbox Series X");
  s.updateProductEbayComps(id, { avgSoldPriceUsd: 400, avgRunTimeDays: 5, avgShippingUsd: 0, sampleSize: 8, activeMedianUsd: 420, activeSampleSize: 6, estimatedValueUsd: 400, estimateBasis: "sold" } as any);
  const mk = (n: number, title: string, price: number, description: string, impact: string, research: { status: string; code: string; reason: string }, isDeal = false) =>
    s.saveScored({
      research,
      listing: { id: "L" + n, title, price, url: "https://example.invalid/" + n, thumbnailUrl: null, imageUrls: [], hasVideo: false, hasOfficialShipping: false, mentionsEbay: false, description, shippingMentioned: false, locationText: "Testville, ST", seller: { joinedFacebookYear: 2015, rating: null, ratingCount: null, hasProfilePhoto: true, name: "t" }, listingAge: "2 hours ago", source: "facebook" } as any,
      extraction: { matchedItem: null, extractedAttributes: "", conditionImpact: impact, confidence: "low", reasoning: research.reason },
      referencePriceUsd: null, discountPercent: null, isDeal, dealTier: isDeal ? "search" : null, estimatedValueRange: null, offTopicSuggestion: null,
    } as any);
  // 1: a clear Database-priced profitable listing the scanner (wrongly) cut with "no damage" wording -> must be flagged "only because of condition wording"
  mk(1, "Xbox Series X console 1TB", 250, "Works perfectly, no damage, not cracked.", "minor", { status: "confirmed_unprofitable", code: "UNPROFITABLE_AT_PRICE", reason: "x" });
  // 2: genuinely unprofitable even with no discount
  mk(2, "Xbox Series X console", 390, "Great shape.", "none", { status: "confirmed_unprofitable", code: "UNPROFITABLE_AT_PRICE", reason: "x" });
  // 3: already a deal (must not be listed as missed)
  mk(3, "Xbox Series X", 260, "Like new.", "none", { status: "researched", code: "DEAL", reason: "x" }, true);
  // 4: unknown product, rejected on the AI's own estimate -> manual-look candidate
  mk(4, "Vintage Leica M6 camera body", 450, "Film camera, tested.", "none", { status: "rejected", code: "AI_ESTIMATE", reason: "x" });
  // 5: never opened (instant skip)
  mk(5, "Gaming console works great", 120, "", "unknown", { status: "unresearched", code: "LOOK_BUDGET", reason: "x" });
  // 6: the seller's own text is clean; the "for parts" wording is another seller's card further down the page
  mk(6, "Xbox Series X", 200, "Used - like new, works.\\nSend seller a message\\nToday's picks\\n$300\\nSony PlayStation 5 as is for parts\\nRichmond, VA", "major", { status: "confirmed_unprofitable", code: "UNPROFITABLE_AT_PRICE", reason: "x" });
  s.close();
  return p;
}

(async () => {
  const given = args.find((a) => !a.startsWith("--") && a !== opt("--since-hours") && a !== opt("--csv") && a !== opt("--show"));
  const isSelf = flag("--selftest");
  const src = isSelf ? selftest() : given;
  if (!src || !fs.existsSync(src)) { console.error("Give the path to scout.db, or --selftest."); process.exit(2); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-discovery-copy-"));
  const copy = path.join(work, "scout.db");
  fs.copyFileSync(src, copy);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);

  const showId = opt("--show");
  if (showId) {
    const d = new DatabaseSync(copy, { readOnly: true });
    const row = d.prepare("SELECT title, price, listing_age, description FROM listings WHERE url LIKE ? OR id = ?").get("%" + showId + "%", showId) as any;
    if (!row) { console.log("No listing matches " + showId); process.exit(0); }
    console.log("TITLE: " + row.title + "  PRICE: " + row.price + "  AGE: " + row.listing_age + "\\n----- stored page text (first 4000 characters, what the scanner reads) -----\\n" + row.description);
    process.exit(0);
  }
  const store = new Store(copy);
  const db = new DatabaseSync(copy, { readOnly: true });
  const sinceH = Number(opt("--since-hours") ?? 0);
  const cutoff = sinceH > 0 ? Date.now() - sinceH * 3600_000 : 0;
  const rows = db.prepare("SELECT id, title, price, url, description, condition_impact, confidence, reasoning, is_deal, deal_status, matched_item, research_status, research_code, research_reason, first_seen_at, listing_age, image_urls FROM listings WHERE first_seen_at >= ? ORDER BY first_seen_at DESC").all(cutoff) as any[];

  // ---- Part 1: accounting
  const byOutcome: Record<string, number> = {};
  let opened = 0, neverOpened = 0, deals = 0, waiting = 0;
  for (const r of rows) {
    const key = (r.research_status ?? "(none)") + " / " + (r.research_code ?? "(none)");
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
    const wasOpened = !!(r.description && String(r.description).length > 0);
    if (wasOpened) opened++; else neverOpened++;
    if (r.is_deal) deals++;
    if (r.research_code === "PHOTOS_QUEUED") waiting++;
  }

  // ---- Part 2: replay
  const leads: any[] = [];
  const summary = { dbPriced: 0, dbPricedProfitableNow: 0, dbPricedNegotiable: 0, onlyBecauseOfCondition: 0, negatedConditionDiscounted: 0, unknownProductCandidates: 0, noPrice: 0 };
  const TEXT_ONLY_CODES = new Set(["AI_ESTIMATE", "IDENTITY_UNCLEAR", "LOOK_BUDGET", "LOW_PRICE", "PHOTOS_UNCLEAR", "NO_RESALE_NUMBERS", "TEXT_JUDGE_UNAVAILABLE", "NAME_REFUSED", "AI_UNAVAILABLE", "INTERRUPTED", "RESEARCH_FAILED", "PHOTO_ANALYSIS_FAILED"]);
  for (const r of rows) {
    if (r.is_deal || r.price == null) { if (r.price == null) summary.noPrice++; continue; }
    if (r.research_code === "TOO_OLD" || r.research_code === "SCAM_BOT" || r.research_code === "UNSHIPPABLE" || r.research_code === "BLACKLISTED" || r.research_code === "PLACEHOLDER_PRICE") continue; // intentional filters
    const text = (r.title ?? "") + " " + (r.description ?? "");
    const known = store.getEbayValueForTitle(r.title);
    const stored = r.condition_impact === "minor" || r.condition_impact === "major" ? r.condition_impact : "none";
    const redetected = detectConditionImpact(text);
    if (known) {
      summary.dbPriced++;
      const asScanned = verdictAt(known.value, r.price, stored);
      const noCondition = verdictAt(known.value, r.price, "none");
      if (asScanned === "profitable") summary.dbPricedProfitableNow++;
      if (asScanned === "negotiable") summary.dbPricedNegotiable++;
      const missedByCondition = asScanned === "no" && noCondition !== "no";
      if (missedByCondition) summary.onlyBecauseOfCondition++;
      const negated = (stored !== "none" || redetected !== "none") && NEGATED.test(text);
      if (negated) summary.negatedConditionDiscounted++;
      if (asScanned !== "no" || missedByCondition || negated) {
        leads.push({ firstSeen: new Date(r.first_seen_at).toISOString().slice(0, 16), conditionWhy: stored !== "none" ? conditionWhy(r.title ?? "", r.description ?? "") : "", kind: asScanned !== "no" ? "database-priced, qualifies on the saved numbers but was not a deal" : missedByCondition ? "qualifies only without the condition discount" : "condition wording is negated", title: r.title, price: r.price, product: known.name, databaseValueUsd: Math.round(known.value), maxBuyAtNoDiscountUsd: Math.floor(maxBuyPriceExactUsd(known.value, 0, settings)), appliedCondition: stored, ended: r.research_status + "/" + r.research_code, reasoning: String(r.research_reason ?? r.reasoning ?? "").slice(0, 160), url: r.url });
      }
    } else if (TEXT_ONLY_CODES.has(r.research_code) || (r.research_status === "rejected" && r.research_code === "AI_ESTIMATE")) {
      summary.unknownProductCandidates++;
      leads.push({ firstSeen: new Date(r.first_seen_at).toISOString().slice(0, 16), conditionWhy: stored !== "none" ? conditionWhy(r.title ?? "", r.description ?? "") : "", kind: "unknown to the Database; decided without market numbers", title: r.title, price: r.price, product: null, databaseValueUsd: null, appliedCondition: stored, ended: r.research_status + "/" + r.research_code, reasoning: String(r.research_reason ?? r.reasoning ?? "").slice(0, 160), url: r.url });
    }
  }
  // ---- Part 3: the same pages read from the listing's own text only
  const own = { pagesWithMarker: 0, opened: 0, conditionDroppedToNone: 0, conditionDropped: [] as any[], shippingFlagFromOtherCards: 0, ebayFlagFromOtherCards: 0, shippingFlagged: 0, ebayFlagged: 0, becameQualifying: 0 };
  const SHIP_RE = /\\bships for \\$|\\bestimated arrival\\b|\\bdoor drop[- ]?off\\b/i;
  const EBAY_RE = /\\bebay\\b/i;
  for (const r of rows) {
    if (!r.description) continue;
    own.opened++;
    const o = ownText(String(r.description));
    if (o.cut) own.pagesWithMarker++;
    const stored = r.condition_impact === "minor" || r.condition_impact === "major" ? r.condition_impact : "none";
    const ownCond = detectConditionImpact((r.title ?? "") + " " + o.text);
    if (stored !== "none" && ownCond === "none") {
      own.conditionDroppedToNone++;
      const known = store.getEbayValueForTitle(r.title);
      const was = known && r.price != null ? verdictAt(known.value, r.price, stored) : null;
      const now = known && r.price != null ? verdictAt(known.value, r.price, "none") : null;
      if (known && was === "no" && now !== "no") own.becameQualifying++;
      own.conditionDropped.push({ title: r.title, price: r.price, was: stored, product: known?.name ?? null, value: known ? Math.round(known.value) : null, qualifiesNow: now, url: r.url });
    }
    if (r.research_code === "OFFICIAL_SHIPPING") { own.shippingFlagged++; if (!SHIP_RE.test(o.text)) own.shippingFlagFromOtherCards++; }
    if (r.research_code === "MENTIONS_EBAY") { own.ebayFlagged++; if (!EBAY_RE.test(o.text)) own.ebayFlagFromOtherCards++; }
  }
  // ---- Part 4: what the Beta 12 reading would have decided (own text + negation-aware parser) for listings priced from the Database
  const b12 = { dbPriced: 0, wouldQualifyNow: 0, wasNotDeal: 0, examples: [] as any[] };
  for (const r of rows) {
    if (!r.description || r.price == null || r.is_deal) continue;
    if (["TOO_OLD", "SCAM_BOT", "UNSHIPPABLE", "BLACKLISTED", "PLACEHOLDER_PRICE", "OFFICIAL_SHIPPING", "MENTIONS_EBAY"].includes(r.research_code)) continue;
    const known = store.getEbayValueForTitle(r.title);
    if (!known) continue;
    b12.dbPriced++;
    const o = listingOwnText(String(r.description));
    const impact = analyzeCondition((r.title ?? "") + " " + (o.cut ? o.text : (r.title ?? ""))).impact;
    const stored = r.condition_impact === "minor" || r.condition_impact === "major" ? r.condition_impact : "none";
    const before = verdictAt(known.value, r.price, stored);
    const after = verdictAt(known.value, r.price, impact);
    if (before === "no" && after !== "no") { b12.wouldQualifyNow++; if (b12.examples.length < 15) b12.examples.push({ title: r.title, price: r.price, product: known.name, valueUsd: Math.round(known.value), was: stored, now: impact, verdict: after, url: r.url }); }
  }
  // ---- Part 5: how old were the listings that were rejected as too old? (is the age being read correctly, and is it the feed that returns old listings?)
  const ageBuckets: Record<string, number> = {};
  for (const r of rows) {
    if (r.research_code !== "TOO_OLD") continue;
    const m = /(\\d+|a|an|about an|one|two|three|four|five|six|seven)\\s+(minute|hour|day|week|month|year)s?/i.exec(String(r.listing_age ?? ""));
    const key = m ? m[2].toLowerCase() + "s" : r.listing_age ? "other: " + String(r.listing_age).slice(0, 20) : "(age text not saved)";
    ageBuckets[key] = (ageBuckets[key] ?? 0) + 1;
  }
  const result = { source: isSelf ? "(self-test database)" : src, copiedTo: copy, listings: rows.length, opened, neverOpened, deals, stillWaitingForPhotos: waiting, byOutcome, replay: summary, ownTextReplay: own, beta12Replay: b12, tooOldByUnit: ageBuckets, leads: leads.slice(0, 500) };
  fs.writeFileSync(path.join(${JSON.stringify(root)}, "discovery-audit-results.json"), JSON.stringify(result, null, 2));
  const csvPath = opt("--csv");
  if (csvPath) {
    const esc = (v: any) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    fs.writeFileSync(csvPath, ["kind,title,price,product,databaseValueUsd,appliedCondition,ended,firstSeen,conditionWhy,url", ...leads.map((l) => [l.kind, l.title, l.price, l.product, l.databaseValueUsd, l.appliedCondition, l.ended, l.firstSeen, l.conditionWhy, l.url].map(esc).join(","))].join("\\n"));
  }
  console.log("Listings in the database copy: " + rows.length + (sinceH ? " (last " + sinceH + " h)" : ""));
  console.log("  opened (detail page read): " + opened + "   never opened (skipped from the search card): " + neverOpened + "   deals: " + deals + "   still waiting for photos: " + waiting);
  console.log("How they ended:");
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) console.log("  " + String(v).padStart(5) + "  " + k);
  console.log("Replay (leads for a person to check, not verdicts):");
  console.log("  priced from the Database's own eBay value: " + summary.dbPriced + " (profitable on saved numbers: " + summary.dbPricedProfitableNow + ", within negotiation reach: " + summary.dbPricedNegotiable + ")");
  console.log("  qualify ONLY without the condition discount: " + summary.onlyBecauseOfCondition + "   negated condition wording that was still discounted: " + summary.negatedConditionDiscounted);
  console.log("  unknown to the Database, decided on text/estimate alone: " + summary.unknownProductCandidates);
  console.log("Own-text replay (page cut where other sellers' cards begin; shipping/eBay checks can only be tested on the stored first 4000 characters, so those are lower bounds):");
  console.log("  opened pages: " + own.opened + ", with the cut marker found: " + own.pagesWithMarker);
  console.log("  condition discount came ONLY from other cards: " + own.conditionDroppedToNone + " (of which would now qualify on Database numbers: " + own.becameQualifying + ")");
  console.log("  OFFICIAL_SHIPPING rejections: " + own.shippingFlagged + ", of which the wording is NOT in the listing's own text: " + own.shippingFlagFromOtherCards);
  console.log("  MENTIONS_EBAY rejections: " + own.ebayFlagged + ", of which 'eBay' is NOT in the listing's own text: " + own.ebayFlagFromOtherCards);
  console.log("Beta 12 reading (the listing's own text + negation-aware condition parser) on Database-priced listings: " + b12.dbPriced + " checked, " + b12.wouldQualifyNow + " were not deals but qualify on the saved numbers once read correctly (examples in the JSON).");
  console.log("Rejected as too old, by the unit of their age: " + (Object.entries(ageBuckets).map(([k, v]) => k + "=" + v).join(", ") || "none"));
  console.log("Details: discovery-audit-results.json" + (csvPath ? " and " + csvPath : ""));
  store.close();
  db.close();
})();
`
);
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "error",
  external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"],
});
const modules = path.join(root, "node_modules");
const r = require("node:child_process").spawnSync(process.execPath, ["--no-warnings", out, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
});
process.exit(r.status ?? 1);
