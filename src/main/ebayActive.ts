// What sellers are asking on eBay right now for a product, used beside the sold comps (see marketValue.ts).
// Uses the same Browse API the eBay scanner already has credentials for; nothing here needs WatchCount.
import { hasEbayCredentials, searchEbayItems } from "./ebayClient.js";
import { titleLooksLikeBrokenProduct } from "./brokenVariant.js";
import type { PhotoCheck } from "./compPhotoCheck.js";
import { compMatchesSpecs, specReference } from "./compFilter.js";
import { median } from "./marketValue.js";
import { judgeSameProduct } from "./watchcount.js";
import { editionConflict } from "./variantIdentity.js";

export interface ActiveAsks {
  // Listings dropped because their photo showed a different product than the product's reference photos.
  photoRejected: number;
  medianUsd: number | null;
  sampleSize: number;
  // Photos of the listings confirmed to be this exact product, best match first: real pictures of the real thing,
  // offered as candidate reference photos (they still get checked before being kept).
  photos: Array<{ url: string; label: string }>;
}

const NO_ASKS: ActiveAsks = { photoRejected: 0, medianUsd: null, sampleSize: 0, photos: [] };
const PHOTO_CANDIDATES = 12;
const ACTIVE_LISTINGS_TO_FETCH = 60;

/**
 * A search for a generic name ("PS5", "xbox") also returns games, controllers and parts that mention it, which drag the asking price
 * far below the console's. For a console product (its Database family says "... > Consoles") only listings filed under a console
 * category count (eBay's "Video Game Consoles"), not accessories, VR headsets or games.
 */
export function onlyRightCategory<T extends { categories: Array<{ name: string }> }>(items: T[], familyHint?: string | null): T[] {
  if (!familyHint || !/(^|>)\s*consoles?\s*($|>)/i.test(familyHint)) return items;
  return items.filter((i) => i.categories.some((c) => /\bconsoles?\b/i.test(c.name) && !/accessor|controller|attachment|headset|\bvr\b|cable|mount|case|cover/i.test(c.name)));
}

/**
 * What a buyer would pay in total for a listing: the item price plus the seller's shipping charge (eBay's cut, and so the user's
 * take-home percentage, is on all of it). Shipping eBay doesn't state (calculated, local pickup) counts as nothing.
 */
export function askedTotalUsd(item: { priceValue: string | null; shippingCostUsd: number | null }): number {
  return Number(item.priceValue) + (item.shippingCostUsd ?? 0);
}

function isNewCondition(condition: string | null): boolean {
  return !!condition && /^new/i.test(condition) && !/open/i.test(condition);
}

/**
 * Median asking price of the active Buy-It-Now listings that are really this product. Never throws: no eBay
 * credentials, an API error or an AI hiccup all just mean "no asking-price data", and the sold comps stand alone.
 * `soldCondition` ("New"/"Used" from the sold comps) keeps new items from being compared against used ones.
 */
export async function fetchActiveAsks(
  query: string,
  productName: string,
  soldCondition: string | null,
  photoCheck?: PhotoCheck | null,
  broken = false,
  // The product's Database family ("PlayStation > Consoles"): for a console, only listings filed under a console category count.
  familyHint: string | null = null,
  // See watchcount.ts's analyzeEbayComps: the words that separate this product from its general parent.
  requiredTerms: string[] = []
): Promise<ActiveAsks> {
  if (!hasEbayCredentials()) return NO_ASKS;
  if (broken) return fetchBrokenAsks(query, productName, familyHint, requiredTerms);
  try {
    const items = onlyRightCategory(await searchEbayItems(query, { limit: ACTIVE_LISTINGS_TO_FETCH }), familyHint);
    const reference = specReference(query, productName);
    // Parts-only / not-working listings say nothing about what a working one is worth.
    const candidates = items.filter(
      (i) => i.priceCurrency === "USD" && i.priceValue !== null && Number.isFinite(Number(i.priceValue)) && !/parts|not working/i.test(i.condition ?? "") && compMatchesSpecs(reference, i.title) && !editionConflict(`${query} ${productName}`, i.title, requiredTerms)
    );
    if (candidates.length === 0) return NO_ASKS;

    let kept = (await judgeSameProduct(query, candidates.map((i) => i.title))).map((idx) => candidates[idx]).filter(Boolean);
    // Cross-check each listing's photo against the product's reference photos (see compPhotoCheck.ts).
    let photoRejected = 0;
    if (photoCheck && kept.length > 0) {
      const keep = await photoCheck(kept.map((i) => ({ title: i.title, imageUrl: i.imageUrl })));
      const survivors = kept.filter((_, idx) => keep[idx] !== false);
      photoRejected = kept.length - survivors.length;
      kept = survivors;
    }
    let pool = kept;
    if (soldCondition) {
      const wantNew = soldCondition === "New";
      const sameCondition = kept.filter((i) => isNewCondition(i.condition) === wantNew);
      if (sameCondition.length >= 3) pool = sameCondition;
    }
    const prices = pool.map(askedTotalUsd);
    const photos = kept
      .filter((i) => !!i.imageUrl)
      .slice(0, PHOTO_CANDIDATES)
      // Search results carry a small thumbnail (s-l225); the same picture is available larger.
      .map((i) => ({ url: (i.imageUrl as string).replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, "/s-l800.$1"), label: `eBay listing: ${i.title.slice(0, 90)}` }));
    return { photoRejected, medianUsd: median(prices), sampleSize: prices.length, photos };
  } catch (err) {
    console.error(`[ebayActive] active listings lookup failed for "${query}": ${(err as Error).message}`);
    return NO_ASKS;
  }
}

/**
 * What sellers ask for BROKEN / for-parts copies of the product (query = its base name): eBay's own "For parts or not working"
 * condition, whose titles are then checked to be this product and not a loose part. Plain text checks, no AI.
 */
async function fetchBrokenAsks(query: string, productName: string, familyHint: string | null, requiredTerms: string[] = []): Promise<ActiveAsks> {
  try {
    const items = onlyRightCategory(await searchEbayItems(query, { limit: ACTIVE_LISTINGS_TO_FETCH, conditionIds: ["7000"] }), familyHint);
    const reference = specReference(query, productName);
    const kept = items.filter(
      (i) => i.priceCurrency === "USD" && i.priceValue !== null && Number.isFinite(Number(i.priceValue)) && titleLooksLikeBrokenProduct(query, i.title, true) && compMatchesSpecs(reference, i.title) && !editionConflict(`${query} ${productName}`, i.title, requiredTerms)
    );
    const all = kept.map(askedTotalUsd);
    // A loose part or accessory listed in the same condition (a $40 power supply) is far under the consoles: drop what is under
    // a third of the middle price.
    const mid = median(all);
    const prices = mid === null ? all : all.filter((p) => p >= mid / 3);
    return { photoRejected: 0, medianUsd: median(prices), sampleSize: prices.length, photos: [] };
  } catch (err) {
    console.error(`[ebayActive] broken-listings lookup failed for "${query}": ${(err as Error).message}`);
    return NO_ASKS;
  }
}
