// Pure Watch condition-evaluation functions — same relationship to
// scrapeEngine.ts that scorer.ts already has (scrapeEngine.ts calls in,
// this never calls back out to it, to avoid a circular import — see
// evaluateWatchConditions' own listingAgeHours param for why that one
// value is passed in rather than computed here).
import type { ScoredListing, SearchItem, Watch } from "./types.js";
import type { Store } from "./store.js";

// Per explicit instruction — Watch reuses the EXACT SAME matching
// primitives a SearchItem already does (matchSearchItem/
// findGreenFlagCandidate in scorer.ts) — they only ever read
// item/matchKeywords/typicalResaleUsd/minPriceUsd/maxPriceUsd off a
// SearchItem-shaped object, so a Watch row supplies those directly, no
// adapter type needed. typicalResaleUsd is left at 0 on purpose — Watch
// derives its OWN reference price (see deriveWatchReferencePrice below),
// deliberately independent of the SearchItem-oriented scoring pipeline.
export function watchAsSearchItem(watch: Watch): SearchItem {
  return {
    item: watch.searchPhrase,
    matchKeywords: watch.matchKeywords,
    typicalResaleUsd: 0,
    linkedProductId: watch.linkedProductId,
    minPriceUsd: watch.minPriceUsd,
    maxPriceUsd: watch.maxPriceUsd,
  };
}

// Cheap price pre-check — same posture as evaluateListing's existing
// per-SearchItem price gate, just against this watch's own bounds, before
// anything expensive (detail page load, seller risk, scoring) runs.
export function passesWatchPriceGate(watch: Watch, price: number): boolean {
  if (watch.maxPriceUsd !== null && price > watch.maxPriceUsd) return false;
  if (watch.minPriceUsd !== null && price < watch.minPriceUsd) return false;
  return true;
}

// Per explicit instruction — found during verification, not in the
// original spec: scorer.ts's scoreListing has its OWN independent early
// return when general (unverified) deal detection is off
// (referencePriceUsd: null, zero AI call spent) — an expected, normal
// Watch operating state per the spec ("even if the normal Scanner is
// stopped"). Watch can't lean on scored.referencePriceUsd for its own
// profit/discount conditions; it derives its own instead, preferring the
// linked product's own real numbers over anything AI-guessed: the user's
// own logged resalePriceUsd (real sale history) > real eBay sold comps >
// a live average of what this exact product has actually asked for on
// Facebook Marketplace. Returns null — not a guess — when nothing is
// linked or the linked product has no pricing data yet; see
// evaluateWatchConditions below for what that means for a profit/discount
// condition.
export function deriveWatchReferencePrice(watch: Watch, store: Store): number | null {
  if (!watch.linkedProductId) return null;
  const product = store.getProductById(watch.linkedProductId);
  if (!product) return null;
  if (product.resalePriceUsd !== null && product.resalePriceUsd > 0) return product.resalePriceUsd;
  if (product.ebayAvgSoldPriceUsd !== null && product.ebayAvgSoldPriceUsd > 0) return product.ebayAvgSoldPriceUsd;
  const fbStats = store.getFacebookPriceStats(watch.linkedProductId);
  if (fbStats && fbStats.avgPriceUsd > 0) return fbStats.avgPriceUsd;
  return null;
}

export interface WatchConditionResult {
  satisfied: boolean;
  profitUsd: number | null;
  discountPercent: number | null;
}

// The full condition check for one listing against one watch, given its
// price already passed passesWatchPriceGate and a reference price already
// derived (see deriveWatchReferencePrice above). Per explicit instruction
// — a profit/discount condition is only ever satisfied when a real
// reference price is determinable; an unconfirmable condition counts as
// NOT satisfied rather than guessed at, to avoid a false-positive alert.
// Location/radius is deliberately NOT checked here — passive matching has
// no per-listing distance data to enforce it against (only the active
// scheduler, which controls exactly where the page navigates, can be
// radius-precise — see the Watch plan's own §3/§4). listingAgeHours is
// passed in rather than this module importing scrapeEngine.ts's own
// estimateListingAgeHours, to avoid a circular import between the two
// files (scrapeEngine.ts already calls that for its own stale-listing
// gate — same value, just handed down instead of recomputed).
export function evaluateWatchConditions(watch: Watch, price: number, referencePrice: number | null, listingAgeHours: number | null): WatchConditionResult {
  const profitUsd = referencePrice !== null ? referencePrice - price : null;
  const discountPercent = referencePrice !== null && referencePrice > 0 ? ((referencePrice - price) / referencePrice) * 100 : null;

  if (watch.minProfitUsd !== null && (profitUsd === null || profitUsd < watch.minProfitUsd)) {
    return { satisfied: false, profitUsd, discountPercent };
  }
  if (watch.minDiscountPercent !== null && (discountPercent === null || discountPercent < watch.minDiscountPercent)) {
    return { satisfied: false, profitUsd, discountPercent };
  }
  if (watch.maxListingAgeMinutes !== null) {
    const maxHours = watch.maxListingAgeMinutes / 60;
    // Same >= boundary as scrapeEngine.ts's own isListingTooOld — treating
    // exactly-maxHours as still fresh would let some genuinely-stale
    // listings through right at the boundary that matters most.
    if (listingAgeHours === null || listingAgeHours >= maxHours) {
      return { satisfied: false, profitUsd, discountPercent };
    }
  }
  return { satisfied: true, profitUsd, discountPercent };
}
