// READ-ONLY audit harness #2: the reported Xbox 360 controller listing run through the app's REAL lookup / pricing / Deal Quality Gate code,
// against a THROW-AWAY database (never the real one). Nothing is written outside a temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/main/store.ts";
import { scoreListing } from "../../src/main/scorer.ts";
import { qualifyScoredListing } from "../../src/main/preAlert.ts";
import { resaleSettingsFrom } from "../../src/main/resaleMath.ts";
import { listingHasExtraDetail, decideIdentityAction } from "../../src/main/productIdentity.ts";
import { titleLooksLikeProduct, compMatchesSpecs } from "../../src/main/compFilter.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-audit4-"));
const store = new Store(path.join(dir, "scout.db"));
const give = (id: string, name: string, sold: number, n: number, ageDays = 1) => {
  const real = store.addProductStub(id, name);
  store.updateProductEbayComps(real, { avgSoldPriceUsd: sold, avgRunTimeDays: 5, avgShippingUsd: 0, sampleSize: n, activeMedianUsd: sold, activeSampleSize: 6, estimatedValueUsd: sold, estimateBasis: "sold" });
  return real;
};

// What the Database realistically holds before this listing: the Series X|S controller entry, valued like one (about $48 after many sales).
const generic = give("p-generic", "Xbox Wireless Controller", 48, 40);
console.log(`Database entry "Xbox Wireless Controller" valued at $48 (Series X|S pads).`);

const TITLE = "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad";
const DESC = "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad. Works great.";
console.log(`\nListing: "${TITLE}"  asking $15 (a real 360 pad sells for roughly $15-25 sold)`);

// 1. Which Database entry does the listing land in?
const hit = store.findMatchingProduct("Xbox Wireless Controller");
const hitFull = store.findMatchingProduct("Microsoft Xbox 360 Wireless Controller 1403");
console.log(`\n[1] findMatchingProduct("Xbox Wireless Controller") -> ${hit?.name}`);
console.log(`    findMatchingProduct("Microsoft Xbox 360 Wireless Controller 1403") -> ${hitFull?.name ?? "(no match: would create a new entry)"}`);

// 2. The identity second look: only asked when the title has >=2 unfamiliar words
console.log(`\n[2] listingHasExtraDetail(title, "Xbox Wireless Controller") = ${listingHasExtraDetail(TITLE, "Xbox Wireless Controller")}  (true = the AI identity check is asked)`);
const cand = [{ id: generic, name: "Xbox Wireless Controller", summary: "", seenAs: [] }];
for (const verdict of [
  { decision: "generic", matchId: null, confidence: "high", specificName: null, reason: "" },
  { decision: "match", matchId: generic, confidence: "medium", specificName: null, reason: "" },
  { decision: "match", matchId: generic, confidence: "high", specificName: null, reason: "" },
  { decision: "new", matchId: null, confidence: "high", specificName: "Microsoft Xbox 360 Wireless Controller", reason: "" },
] as const) {
  const a = decideIdentityAction(verdict as any, cand, generic, generic, generic);
  console.log(`    AI says ${verdict.decision}/${verdict.confidence}${verdict.specificName ? ` ("${verdict.specificName}")` : ""} -> ${a.kind}${a.kind === "create" ? ` "${a.name}"` : a.kind === "attach" ? " (photo + note filed into the generic entry)" : " (note only)"}`);
}

// 3. Valuation of the listing
const valueFor = (item: string, title?: string) => store.getEbayValueForProductName(item, title);
const engineConfig: any = {
  searchItems: [{ item: "Xbox Wireless Controller", matchKeywords: [], typicalResaleUsd: 0, minPriceUsd: null, maxPriceUsd: null, linkedProductId: null }],
  generalDeal: { enabled: false, minConfidence: "high" },
  customInstructions: "", ebayNetPercent: 84, minProfitMarginPercent: 20, maxNegotiationPercent: 25,
};
const listing: any = { id: "L1", title: TITLE, price: 15, url: "https://example.test/1", thumbnailUrl: null, description: DESC, shippingMentioned: false, seller: {}, imageUrls: [], hasVideo: false, hasOfficialShipping: false, source: "facebook", listingAge: "2 hours ago" };
(async () => {
  const scored = await scoreListing(listing, engineConfig, [], [], valueFor);
  console.log(`\n[3] scoreListing: matchedItem="${scored.extraction.matchedItem}"  reference value $${scored.referencePriceUsd}  isDeal=${scored.isDeal}`);
  console.log(`    reasoning: ${scored.extraction.reasoning}`);
  const q = await qualifyScoredListing({ scored, source: store as any, settings: resaleSettingsFrom(engineConfig), maxAgeHours: null, refreshMarket: false, log: () => {} });
  console.log(`[4] Deal Quality Gate -> status "${q.verdict.status}", qualified=${q.verdict.qualified}; headline: ${q.verdict.headline}`);
  console.log(`    evidence it used: ${JSON.stringify(q.verdict.evidence ?? (q.scored as any).gate?.evidence ?? null)}`);

  // 5. The reverse harm: a real Series X|S pad is judged against a Database value polluted by cheap 360/One pads
  const polluted = give("p-poll", "Xbox Wireless Controller Polluted", 29, 40);
  console.log(`\n[5] comps contamination: a generic entry whose comps mix 360 ($18), One ($28) and Series ($48) pads averages ~$29. A real Series pad listed at $30 then looks like a ${Math.round(((29 - 30) / 29) * 100)}% "discount"; a 360 pad at $15 looks like ${Math.round(((29 - 15) / 29) * 100)}% off.`);

  // 6. Exactness test used by the pre-alert market check
  console.log(`\n[6] titleLooksLikeProduct("Xbox Wireless Controller", 360 title) = ${titleLooksLikeProduct("Xbox Wireless Controller", TITLE)}  (true = treated as "this exact product")`);
  console.log(`    compMatchesSpecs("Xbox Wireless Controller", 360 title) = ${compMatchesSpecs("Xbox Wireless Controller", TITLE)}`);
  const sig = store.getProductSignals("Xbox Wireless Controller", TITLE);
  console.log(`    getProductSignals -> "${sig?.name}" value $${sig?.valueUsd}, sample ${sig?.compSample}; alert would be titled with the Database name "${sig?.name}", not the listing's real product.`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
})();
