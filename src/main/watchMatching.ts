// Pure Watch condition-evaluation functions — same relationship to
// scrapeEngine.ts that scorer.ts already has (scrapeEngine.ts calls in,
// this never calls back out to it, to avoid a circular import — see
// evaluateWatchConditions' own listingAgeHours param for why that one
// value is passed in rather than computed here).
import type { ScoredListing, SearchItem, Watch, WatchTerm } from "./types.js";
import { DEFAULT_EBAY_NET_PERCENT } from "./resaleMath.js";
import type { Store } from "./store.js";
import { matchSearchItem } from "./scorer.js";

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
    minSellerRatingPercent: watch.minSellerRatingPercent,
  };
}

// eBay Watch's optional minimum seller rating (percent positive feedback).
// No requirement set -> always passes. A requirement with no rating to check
// it against (a brand-new seller eBay reports no percentage for) does NOT
// pass: same posture as the profit/discount conditions below, where a
// condition that can't be confirmed counts as unmet rather than guessed.
export function passesWatchSellerRating(minPercent: number | null | undefined, sellerPercent: number | null | undefined): boolean {
  if (minPercent === null || minPercent === undefined) return true;
  if (sellerPercent === null || sellerPercent === undefined || Number.isNaN(sellerPercent)) return false;
  return sellerPercent >= minPercent;
}

// One of a Facebook Watch's terms as the SearchItem shape the matching
// primitives read (same idea as watchAsSearchItem above, but for any term).
export function termAsSearchItem(watch: Watch, term: WatchTerm): SearchItem {
  return {
    item: term.phrase,
    matchKeywords: term.matchKeywords,
    typicalResaleUsd: 0,
    linkedProductId: term.linkedProductId,
    minPriceUsd: watch.minPriceUsd,
    maxPriceUsd: watch.maxPriceUsd,
    minSellerRatingPercent: watch.minSellerRatingPercent,
  };
}

/** Every term of the Watch as a SearchItem (a Facebook Watch looks for several things). */
export function watchAsSearchItems(watch: Watch): SearchItem[] {
  return watch.terms.map((term) => termAsSearchItem(watch, term));
}

/**
 * Which of the Watch's terms a listing title is clearly about, or null. This is the
 * strict title match (every keyword of the term present, accessory-only and
 * wrong-variant titles rejected) — the first of the Watch's "high confidence" checks.
 * When several terms match, the one with the longest (most specific) keyword wins.
 */
export function matchWatchTerm(watch: Watch, title: string): WatchTerm | null {
  const items = watchAsSearchItems(watch);
  const hit = matchSearchItem(title, items);
  if (!hit) return null;
  return watch.terms.find((t) => t.phrase === hit.item) ?? null;
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
// `linkedProductId` is the matched term's own link (a Facebook Watch has several
// terms); it defaults to the Watch's first term's.
export function deriveWatchReferencePrice(watch: Watch, store: Store, linkedProductId: string | null = watch.linkedProductId): number | null {
  if (!linkedProductId) return null;
  const product = store.getProductById(linkedProductId);
  if (!product) return null;
  // Real eBay data (the estimate, else the sold average) outranks the AI's own resale guess.
  // What a buyer pays in total (item + shipping): the estimate, else the sold average with its average shipping.
  const ebayValue = product.ebayEstimatedValueUsd ?? (product.ebayAvgSoldPriceUsd !== null ? product.ebayAvgSoldPriceUsd + Math.max(0, product.ebayAvgShippingUsd ?? 0) : null);
  if (ebayValue !== null && ebayValue > 0) return ebayValue;
  if (product.resalePriceUsd !== null && product.resalePriceUsd > 0) return product.resalePriceUsd;
  const fbStats = store.getFacebookPriceStats(linkedProductId);
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
export function evaluateWatchConditions(
  watch: Watch,
  price: number,
  referencePrice: number | null,
  listingAgeHours: number | null,
  // The user resells on eBay and keeps ~84% of the sale price, so a Watch's profit is that, not the full reference
  // price, minus what the purchase costs (price + any shipping charge). See resaleMath.ts.
  resale: { netPercent?: number; shippingUsd?: number } = {}
): WatchConditionResult {
  const netPercent = resale.netPercent ?? DEFAULT_EBAY_NET_PERCENT;
  const profitUsd = referencePrice !== null ? (referencePrice * netPercent) / 100 - (price + (resale.shippingUsd ?? 0)) : null;
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
