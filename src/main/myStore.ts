// The user's own eBay store as a source of price references. Distinct from the market data (WatchCount's sold prices and
// eBay's current asking prices across all sellers): this is what THIS reseller lists the same product for, so Clynx can be
// tailored to them. Read from eBay's public Browse API by seller username (no sign-in); there is no price history there, so
// these are the user's active Buy-It-Now listings.
import { hasEbayCredentials, searchEbaySellerItems } from "./ebayClient.js";
import { titleLooksLikeProduct } from "./compFilter.js";
import { classifyComparable, usableForValuation } from "./compIdentity.js";
import { median } from "./marketValue.js";
import type { MyStoreReference } from "./types.js";

/** An eBay username from what the user typed: the name itself, or a link to their profile or store. Null when it isn't one. */
export function parseSellerName(input: string): string | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  const fromUrl = text.match(/ebay\.[a-z.]+\/(?:usr|str|sch\/[^/]+)\/([A-Za-z0-9._-]{2,64})/i);
  const name = (fromUrl ? fromUrl[1] : text).replace(/^@/, "");
  return /^[A-Za-z0-9._-]{2,64}$/.test(name) ? name : null;
}

/**
 * What the user's store lists this product for right now. Null when eBay isn't available, or none of their active listings
 * is this exact product (text check on the title, no AI). Never throws.
 */
export async function fetchMyStoreReference(seller: string, productName: string): Promise<MyStoreReference | null> {
  if (!hasEbayCredentials()) return null;
  try {
    const items = await searchEbaySellerItems(seller, productName, 50);
    const mine = items.filter(
      (i) =>
        i.sellerUsername?.toLowerCase() === seller.toLowerCase() &&
        i.priceCurrency === "USD" &&
        i.priceValue !== null &&
        Number.isFinite(Number(i.priceValue)) &&
        titleLooksLikeProduct(productName, i.title) &&
        usableForValuation(classifyComparable({ name: productName }, i.title).verdict)
    );
    if (mine.length === 0) return null;
    const prices = mine.map((i) => Number(i.priceValue));
    return {
      seller,
      medianUsd: median(prices) as number,
      lowUsd: Math.min(...prices),
      highUsd: Math.max(...prices),
      sampleSize: prices.length,
      items: mine.slice(0, 5).map((i) => ({ title: i.title.slice(0, 120), priceUsd: Number(i.priceValue), url: i.itemWebUrl })),
      checkedAt: Date.now(),
    };
  } catch (err) {
    console.error(`[myStore] "${productName}" lookup for ${seller} failed: ${(err as Error).message}`);
    return null;
  }
}
