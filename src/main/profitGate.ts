// "Genuinely profitable" rules shared by deal scoring, the bundle (hidden gem) re-pricing and the alert gate. Plain arithmetic.
//
// The negotiation rule: a listing is only worth flagging when the user could reach a good deal (the minimum profit margin after
// eBay's cut) by negotiating at most N% below the asking price (Config > "Skip deals that need more than ___% off"; 15% by
// default). Anything needing a deeper cut is skipped. The exception is a "hidden gem": extras that come with the item (a 1TB
// expansion card with a console) add to what the whole lot resells for, so the total value is what the price is judged against,
// but only extras that are really INCLUDED in the asking price (see extrasPricedSeparately).
import { DEFAULT_MAX_NEGOTIATION_PERCENT, isGoodResale, maxBuyPriceExactUsd, resaleOutcome, type ResaleSettings } from "./resaleMath.js";

/** Could the user reach a good deal by negotiating at most `settings.maxCutPercent`% below `priceUsd`, when the item resells for `valueUsd`? */
export function withinNegotiationReach(valueUsd: number, priceUsd: number, shippingUsd: number, settings: ResaleSettings): boolean {
  if (!(priceUsd > 0)) return true;
  const maxBuy = maxBuyPriceExactUsd(valueUsd, shippingUsd, settings);
  return maxBuy >= priceUsd * (1 - (settings.maxCutPercent ?? DEFAULT_MAX_NEGOTIATION_PERCENT) / 100);
}

// Wording that says an extra is NOT part of the asking price: the seller wants more money for it, or says they have it too.
const SEPARATE_PRICE_PHRASES: RegExp[] = [
  /\balso (have|got|has|selling|sell|available|offering|offer)\b/i,
  /\bsold separately\b/i,
  /\bseparately\b/i,
  /\bfor sale (separately|too|as well)\b/i,
  /\bextra\b[^.\n]{0,25}\$\s?\d+|\$\s?\d+[^.\n]{0,12}\bextra\b/i,
  /\badditional\b[^.\n]{0,25}\$\s?\d+/i,
  /\$\s?\d+\s*(each|a piece|apiece|per)\b|\b\d+\s?\$\s*(each|a piece|apiece)\b/i,
  /\b(can|could|will|would) (also )?(buy|get|purchase|add|sell)\b[^.\n]{0,40}(\$\s?\d+|\b\d+\s?\$)/i,
  /\bnot included\b/i,
  /\bdoes(n't| not) (come|include)\b/i,
  /\bplus \$\s?\d+/i,
];

/**
 * Does the listing's own text say its extras cost extra? Takes the description literally: "Also have a 1tb storage card for 120$",
 * "games sold separately", or a parted-out list where every item has its own price ("Nintendo 3DS XL console - $200 / Super Mario
 * 3D Land - $20 / Pokemon X - $30"): the asking price then covers just the main item, and the extras add nothing to it.
 */
export function extrasPricedSeparately(text: string): boolean {
  if (SEPARATE_PRICE_PHRASES.some((re) => re.test(text))) return true;
  // A parted-out list: two or more lines that are an item and its own price.
  const pricedLines = text.split(/\r?\n/).filter((line) => /^\s*[-•*·]?\s*[^$\n]{2,70}?\s*(?:[-–—:=]\s*)?(?:\$\s*\d{1,4}|\d{1,4}\s*\$)\s*(each)?\s*$/i.test(line));
  return pricedLines.length >= 2;
}

/** How far below the asking price the user would have to negotiate for a good deal (0 when it is one already). */
export function cutNeededPercent(valueUsd: number, priceUsd: number, shippingUsd: number, settings: ResaleSettings): number {
  if (!(priceUsd > 0)) return 0;
  const maxBuy = Math.max(0, maxBuyPriceExactUsd(valueUsd, shippingUsd, settings));
  return Math.max(0, Math.round(((priceUsd - maxBuy) / priceUsd) * 100));
}

// Wording that suggests the listing comes with more than the base item.
const EXTRAS_HINTS = /\b(with|includes?|including|incl|plus|comes with|bundle[d]?|extras?|accessor(y|ies)|games?|controllers?|expansion|ssd|storage card|memory card|headset|dock|lot of|\+)\b|\+/i;

export function mentionsExtras(text: string): boolean {
  return EXTRAS_HINTS.test(text);
}

/**
 * A listing worth a closer look for a hidden gem: it needs a deep cut as it stands, but is not hopeless (priced within about 1.6x
 * of the base item's eBay value) and its wording suggests extras come with it.
 */
export function isHiddenGemCandidate(a: { priceUsd: number; shippingUsd: number; baseValueUsd: number; settings: ResaleSettings; text: string }): boolean {
  if (!(a.baseValueUsd > 0) || !(a.priceUsd > 0)) return false;
  if (withinNegotiationReach(a.baseValueUsd, a.priceUsd, a.shippingUsd, a.settings)) return false;
  if (a.priceUsd > a.baseValueUsd * 1.6) return false;
  // Extras the seller wants more money for are not part of this price.
  if (extrasPricedSeparately(a.text)) return false;
  return mentionsExtras(a.text);
}

/** The item plus its extras, judged as one lot: what it resells for in total, and whether the price is then a good deal. */
export function repriceWithExtras(a: { baseValueUsd: number; extrasValueUsd: number; priceUsd: number; shippingUsd: number; settings: ResaleSettings }) {
  const totalValueUsd = a.baseValueUsd + a.extrasValueUsd;
  const outcome = resaleOutcome(totalValueUsd, a.priceUsd + a.shippingUsd, a.settings.netPercent);
  return {
    totalValueUsd,
    keepUsd: outcome.keepUsd,
    profitUsd: outcome.profitUsd,
    isGood: isGoodResale(outcome, a.settings.minMarginPercent),
    discountPercent: totalValueUsd > 0 ? ((totalValueUsd - a.priceUsd) / totalValueUsd) * 100 : null,
  };
}
