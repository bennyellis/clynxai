import type { EbayItemDetailRaw } from "./ebayClient.js";
import type { ListingDetail } from "./types.js";

// Facebook's own vague relative phrasing verbatim ("3 weeks ago") is what
// scrapeEngine.ts's estimateListingAgeHours already parses (anchored regex
// ^(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\b — anything after
// the matched unit, like " ago", is irrelevant to it). eBay's
// itemCreationDate is a REAL ISO timestamp — a strictly better signal —
// formatted here into that exact same leading-unit vocabulary so the
// freshness gate and every Watch/age-condition check keep working
// completely unmodified, with no eBay-specific parsing path needed
// anywhere downstream. Coarsened to roughly the same granularity Facebook's
// own phrasing would show at a given age, so Feed/Activity read
// consistently across both platforms.
function formatListingAge(itemCreationDate: string | null): string | null {
  if (!itemCreationDate) return null;
  const createdAtMs = new Date(itemCreationDate).getTime();
  if (Number.isNaN(createdAtMs)) return null;
  const diffMs = Date.now() - createdAtMs;
  if (diffMs < 60_000) return "just now";
  const minutes = diffMs / 60_000;
  if (minutes < 60) return `${Math.floor(minutes)} minutes ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} hours ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)} days ago`;
  const weeks = days / 7;
  if (weeks < 4) return `${Math.floor(weeks)} weeks ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

// listings.price is an INTEGER column and every discount/profit
// calculation and notification string in this app already assumes whole
// dollars ("$${listing.price}", no decimals) — eBay returns a decimal
// string ("24.99"). Rounding to the nearest dollar here is a deliberate,
// confirmable simplification, not a precision bug: at the price points
// this app cares about, a few cents of rounding never changes a deal call.
function roundToWholeDollar(priceValue: string | null, currency: string | null): number | null {
  if (priceValue === null || currency !== "USD") return null;
  const n = Number(priceValue);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Converts a raw eBay item (from ebayClient.ts's getEbayItemDetail — the
// richer, single-item shape, a superset of the plain search summary) into
// this app's own ListingDetail, so it can flow through the EXACT same
// scoreListing/evaluateSellerRisk/dedup/notify pipeline every Facebook
// listing already does, with no separate eBay-specific evaluation logic.
export function normalizeEbayListing(raw: EbayItemDetailRaw): ListingDetail {
  return {
    // ebay- prefix guarantees no collision with Facebook's own raw numeric
    // listing ids in the shared listings.id PRIMARY KEY.
    id: `ebay-${raw.itemId}`,
    url: raw.itemWebUrl,
    title: raw.title,
    price: roundToWholeDollar(raw.priceValue, raw.priceCurrency),
    thumbnailUrl: raw.imageUrls[0] ?? null,
    locationText: raw.itemLocationCity,
    source: "ebay",
    description: raw.description ?? "",
    ebayShippingUsd: raw.shippingCostUsd,
    // eBay listings are inherently shipped — the platform's whole point —
    // unlike Facebook's own "did the seller happen to mention shipping in
    // the text" signal, which this field otherwise represents. Purely
    // stored/displayed today, never a scoring gate (verified: only read by
    // store.ts's own save/row-mapping and the Feed's display layer).
    shippingMentioned: true,
    seller: {
      // Facebook-specific signals — always null for an eBay listing.
      // evaluateSellerRisk (sellerRisk.ts) already null-guards every one of
      // these, so every FB-specific check silently no-ops rather than
      // needing any eBay-specific adaptation there.
      joinedFacebookYear: null,
      rating: null,
      ratingCount: null,
      hasProfilePhoto: null,
      name: raw.sellerUsername,
      // eBay's own trust signals — see types.ts's SellerSignals doc comment
      // for why these are deliberately separate fields, never aliased into
      // rating above. undefined (not null) when eBay didn't return one, so
      // notify.ts's buildSellerTrustLine can tell "no eBay data" apart from
      // "a genuine zero."
      ebayFeedbackScore: raw.sellerFeedbackScore ?? undefined,
      ebayFeedbackPercentage: raw.sellerFeedbackPercentage ?? undefined,
    },
    imageUrls: raw.imageUrls,
    hasVideo: false,
    // Both Facebook-specific instant-skip signals — inert for an eBay
    // listing (evaluateListing, the only reader of either, is never called
    // on the eBay path at all — see ebayEngine.ts), set false just to
    // satisfy the type.
    hasOfficialShipping: false,
    mentionsEbay: false,
    listingAge: formatListingAge(raw.itemCreationDate),
  };
}
