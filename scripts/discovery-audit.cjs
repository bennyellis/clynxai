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

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const settings = DEFAULT_RESALE_SETTINGS;
const NEGATED = /\\b(no|not|without|never|nothing|zero|free of)\\b[^.,;\\n]{0,24}\\b(damage[ds]?|crack(ed|s)?|broken|dead|defect(s|ive)?|scratch(es|ed)?|issues?|problems?)\\b/i;

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
  s.close();
  return p;
}

(async () => {
  const given = args.find((a) => !a.startsWith("--") && a !== opt("--since-hours") && a !== opt("--csv"));
  const isSelf = flag("--selftest");
  const src = isSelf ? selftest() : given;
  if (!src || !fs.existsSync(src)) { console.error("Give the path to scout.db, or --selftest."); process.exit(2); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-discovery-copy-"));
  const copy = path.join(work, "scout.db");
  fs.copyFileSync(src, copy);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);

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
        leads.push({ kind: asScanned !== "no" ? "database-priced, qualifies on the saved numbers but was not a deal" : missedByCondition ? "qualifies only without the condition discount" : "condition wording is negated", title: r.title, price: r.price, product: known.name, databaseValueUsd: Math.round(known.value), maxBuyAtNoDiscountUsd: Math.floor(maxBuyPriceExactUsd(known.value, 0, settings)), appliedCondition: stored, ended: r.research_status + "/" + r.research_code, reasoning: String(r.research_reason ?? r.reasoning ?? "").slice(0, 160), url: r.url });
      }
    } else if (TEXT_ONLY_CODES.has(r.research_code) || (r.research_status === "rejected" && r.research_code === "AI_ESTIMATE")) {
      summary.unknownProductCandidates++;
      leads.push({ kind: "unknown to the Database; decided without market numbers", title: r.title, price: r.price, product: null, databaseValueUsd: null, appliedCondition: stored, ended: r.research_status + "/" + r.research_code, reasoning: String(r.research_reason ?? r.reasoning ?? "").slice(0, 160), url: r.url });
    }
  }
  const result = { source: isSelf ? "(self-test database)" : src, copiedTo: copy, listings: rows.length, opened, neverOpened, deals, stillWaitingForPhotos: waiting, byOutcome, replay: summary, leads: leads.slice(0, 500) };
  fs.writeFileSync(path.join(${JSON.stringify(root)}, "discovery-audit-results.json"), JSON.stringify(result, null, 2));
  const csvPath = opt("--csv");
  if (csvPath) {
    const esc = (v: any) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    fs.writeFileSync(csvPath, ["kind,title,price,product,databaseValueUsd,appliedCondition,ended,url", ...leads.map((l) => [l.kind, l.title, l.price, l.product, l.databaseValueUsd, l.appliedCondition, l.ended, l.url].map(esc).join(","))].join("\\n"));
  }
  console.log("Listings in the database copy: " + rows.length + (sinceH ? " (last " + sinceH + " h)" : ""));
  console.log("  opened (detail page read): " + opened + "   never opened (skipped from the search card): " + neverOpened + "   deals: " + deals + "   still waiting for photos: " + waiting);
  console.log("How they ended:");
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) console.log("  " + String(v).padStart(5) + "  " + k);
  console.log("Replay (leads for a person to check, not verdicts):");
  console.log("  priced from the Database's own eBay value: " + summary.dbPriced + " (profitable on saved numbers: " + summary.dbPricedProfitableNow + ", within negotiation reach: " + summary.dbPricedNegotiable + ")");
  console.log("  qualify ONLY without the condition discount: " + summary.onlyBecauseOfCondition + "   negated condition wording that was still discounted: " + summary.negatedConditionDiscounted);
  console.log("  unknown to the Database, decided on text/estimate alone: " + summary.unknownProductCandidates);
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
