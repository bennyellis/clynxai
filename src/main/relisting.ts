// Beta 12 — when an already-seen listing deserves another look, and how a stored listing is turned back into something the Deal Quality Gate can judge (pure).
//
// Until now a Facebook listing id was evaluated exactly once, forever: a seller dropping the price was never noticed, a listing first seen while the AI was unavailable, a look budget
// was spent, or Clynx was closed was never revisited, and a market check that finished late updated the Database but not the listing that asked for it.
// Everything here is bounded: a cooldown, a retry limit, a short list of reasons, and nothing that re-opens a listing already alerted on or older than the freshness window.
import type { ListingDetail, ListingRecord, ResearchStatus, ScoredListing } from "./types.js";

export interface SavedListingState {
  price: number | null;
  researchStatus: ResearchStatus | null;
  researchCode: string | null;
  isDeal: boolean;
  notified: boolean;
  firstSeenAt: number;
  reevalCount: number;
  lastReevalAt: number | null;
}

export const REEVAL_COOLDOWN_MS = 30 * 60_000;
export const REEVAL_MAX_PER_LISTING = 2;
export const REEVAL_MAX_PER_VISIT = 3;
// Price must fall by at least this share and amount before a listing is opened again for it.
export const PRICE_DROP_MIN_FRACTION = 0.05;
export const PRICE_DROP_MIN_USD = 5;

// Outcomes that mean "the evidence was missing", not "this was judged": worth another page visit once something may have changed.
const RETRY_CODES = new Set(["INTERRUPTED", "RESEARCH_FAILED", "PHOTO_ANALYSIS_FAILED", "AI_UNAVAILABLE", "TEXT_JUDGE_UNAVAILABLE", "LOOK_BUDGET", "PHOTOS_QUEUED"]);
// Outcomes the Deal Quality Gate can settle again from the saved record alone (no page visit): the listing was kept as "worth a look" for lack of numbers or certainty.
export const REQUALIFY_CODES = ["AI_UNVERIFIED", "WEAK_EVIDENCE", "NO_RESALE_NUMBERS", "IDENTITY_UNCONFIRMED", "IDENTITY_UNVERIFIED", "HIDDEN_GEM_UNVERIFIED"] as const;

export type ReevalReason = "price_drop" | "no_outcome" | "evidence_missing" | "now_in_focus";

export function reevaluationReason(saved: SavedListingState, cardPrice: number | null, now: number, o: { maxAgeHours: number | null; generalDealOn: boolean }): ReevalReason | null {
  if (saved.isDeal || saved.notified) return null;
  if (saved.reevalCount >= REEVAL_MAX_PER_LISTING) return null;
  if (o.maxAgeHours !== null && now - saved.firstSeenAt > o.maxAgeHours * 3_600_000) return null; // it would only be rejected as too old
  if (now - (saved.lastReevalAt ?? saved.firstSeenAt) < REEVAL_COOLDOWN_MS) return null;
  const code = saved.researchCode;
  if (code === "TOO_OLD" || code === "SCAM_BOT" || code === "UNSHIPPABLE" || code === "BLACKLISTED" || code === "PLACEHOLDER_PRICE" || code === "OFFICIAL_SHIPPING" || code === "MENTIONS_EBAY") return null;
  if (cardPrice !== null && saved.price !== null && saved.price - cardPrice >= PRICE_DROP_MIN_USD && cardPrice <= saved.price * (1 - PRICE_DROP_MIN_FRACTION)) return "price_drop";
  if (saved.researchStatus === null && saved.researchCode === null) return "no_outcome";
  if (code && RETRY_CODES.has(code)) return "evidence_missing";
  if (code === "NOT_FOCUSED" && o.generalDealOn) return "now_in_focus";
  return null;
}

/** Can the saved record be re-judged by the gate without visiting the page? */
export function requalifyEligible(r: Pick<ListingRecord, "isDeal" | "notified" | "matchedItem" | "price" | "researchStatus" | "researchCode">): boolean {
  if (r.isDeal || r.notified || !r.matchedItem || r.price === null) return false;
  return r.researchStatus === "insufficient_evidence" && (REQUALIFY_CODES as readonly string[]).includes(r.researchCode ?? "");
}

function hoursOf(text: string | null): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/just now|moment|minute/.test(t)) return 0.5;
  const h = /(\d+|an?|about an?)\s*hours?/.exec(t);
  if (h) return /^\d+/.test(h[1]) ? parseInt(h[1], 10) : 1;
  return null;
}

/**
 * The saved listing's age NOW: the age the page showed when it was seen, plus the time since. null when the saved age was not understood: such a listing is never re-gated
 * (an unknown age can never be a verified deal).
 */
export function currentAgeText(savedAgeText: string | null, firstSeenAt: number, now: number, estimate: (t: string) => number | null): string | null {
  const then = savedAgeText ? estimate(savedAgeText) ?? hoursOf(savedAgeText) : null;
  if (then === null) return null;
  const total = then + Math.max(0, now - firstSeenAt) / 3_600_000;
  return total < 1 ? "less than an hour ago" : `${Math.ceil(total)} hours ago`;
}

/** A stored listing as something qualifyScoredListing can judge again. isDeal is set because the gate treats a flagged listing without a reference price as an AI-only find. */
export function scoredFromRecord(r: ListingRecord, ageText: string | null): ScoredListing {
  const listing: ListingDetail = {
    id: r.id,
    title: r.title,
    price: r.price,
    url: r.url,
    thumbnailUrl: r.thumbnailUrl,
    locationText: r.locationText,
    description: r.description,
    shippingMentioned: r.shippingMentioned,
    seller: { joinedFacebookYear: r.sellerJoinedYear, rating: r.sellerRating, ratingCount: r.sellerRatingCount, hasProfilePhoto: r.sellerHasProfilePhoto, name: r.sellerName },
    imageUrls: r.imageUrls,
    hasVideo: false,
    hasOfficialShipping: false,
    mentionsEbay: false,
    listingAge: ageText,
    source: r.source,
    ebayShippingUsd: r.shippingCostUsd,
  } as ListingDetail;
  return {
    listing,
    extraction: { matchedItem: r.matchedItem, extractedAttributes: r.extractedAttributes, conditionImpact: r.conditionImpact, confidence: r.confidence, reasoning: r.reasoning },
    referencePriceUsd: r.referencePriceUsd,
    discountPercent: r.discountPercent,
    isDeal: true,
    dealTier: r.dealTier ?? "general",
    estimatedValueRange: r.estimatedValueRange,
    offTopicSuggestion: null,
  } as ScoredListing;
}
