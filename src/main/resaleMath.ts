// What a resale is actually worth to the user. Everything here is plain arithmetic, shared by the deal scoring
// (scorer.ts) and the Watch profit checks (watchMatching.ts) so they can't disagree.
//
// eBay takes about 13.75% of a sale, so the user estimates keeping ~84% of what a comp sold for. It doesn't matter
// whether the buyer paid "$100 + free shipping" or "$90 + $10 shipping": the sold price is the total, and the user
// keeps roughly 84% of it (their own range is 80-86%).

export const DEFAULT_EBAY_NET_PERCENT = 84;
// How far under the money the user keeps a purchase has to be to count as a deal: (kept - cost) / kept.
export const DEFAULT_MIN_PROFIT_MARGIN_PERCENT = 20;

// How far below the asking price a good deal may need negotiating, at most: a deal that would need a deeper cut is skipped.
export const DEFAULT_MAX_NEGOTIATION_PERCENT = 15;

export interface ResaleSettings {
  netPercent: number;
  minMarginPercent: number;
  // Config > "Skip deals that need more than ___% off the asking price".
  maxCutPercent?: number;
}

export const DEFAULT_RESALE_SETTINGS: ResaleSettings = {
  netPercent: DEFAULT_EBAY_NET_PERCENT,
  minMarginPercent: DEFAULT_MIN_PROFIT_MARGIN_PERCENT,
  maxCutPercent: DEFAULT_MAX_NEGOTIATION_PERCENT,
};

export function clampMaxCutPercent(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(60, Math.max(0, value)) : DEFAULT_MAX_NEGOTIATION_PERCENT;
}

export function clampNetPercent(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(95, Math.max(60, value)) : DEFAULT_EBAY_NET_PERCENT;
}

export function clampMarginPercent(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(90, Math.max(0, value)) : DEFAULT_MIN_PROFIT_MARGIN_PERCENT;
}

export function resaleSettingsFrom(config: { ebayNetPercent?: number; minProfitMarginPercent?: number; maxNegotiationPercent?: number }): ResaleSettings {
  return {
    netPercent: clampNetPercent(config.ebayNetPercent),
    minMarginPercent: clampMarginPercent(config.minProfitMarginPercent),
    maxCutPercent: clampMaxCutPercent(config.maxNegotiationPercent),
  };
}

// How much of a product's value is assumed to remain when the listing flags a condition problem (a minor flaw: 60%, a major one
// such as "for parts": 25%). The same factors scorer.ts's CONDITION_VALUE_MULTIPLIER uses (a test keeps the two in step).
export const CONDITION_VALUE_FACTOR = { none: 1, unknown: 1, minor: 0.6, major: 0.25 } as const;

export interface ResaleOutcome {
  // What the user keeps after eBay's cut.
  keepUsd: number;
  // keepUsd minus what it costs to buy (price + shipping).
  profitUsd: number;
  // profit as a share of what is kept.
  marginPercent: number;
}

/** `valueUsd` is what the item sells for on eBay; `costUsd` everything paid to get it (price + shipping). */
export function resaleOutcome(valueUsd: number, costUsd: number, netPercent: number): ResaleOutcome {
  const keepUsd = (valueUsd * netPercent) / 100;
  const profitUsd = keepUsd - costUsd;
  return { keepUsd, profitUsd, marginPercent: keepUsd > 0 ? (profitUsd / keepUsd) * 100 : -Infinity };
}

/**
 * The most the user could pay (item + shipping) and still make the minimum profit margin when it sells for `valueUsd` on
 * eBay: cost <= kept * (1 - margin). Rounded DOWN to a price a person would actually offer ($5 steps from $25, else $1).
 * 0 when there is no such price.
 */
export function maxBuyPriceUsd(valueUsd: number, shippingUsd: number, settings: ResaleSettings): number {
  const item = maxBuyPriceExactUsd(valueUsd, shippingUsd, settings);
  if (!(item > 0)) return 0;
  return item >= 25 ? Math.floor(item / 5) * 5 : Math.floor(item);
}

/** The same, not rounded (and negative when no price at all would make the margin). */
export function maxBuyPriceExactUsd(valueUsd: number, shippingUsd: number, settings: ResaleSettings): number {
  const keep = (valueUsd * settings.netPercent) / 100;
  const maxCost = keep * (1 - settings.minMarginPercent / 100);
  return maxCost - Math.max(0, shippingUsd);
}

export function isGoodResale(outcome: ResaleOutcome, minMarginPercent: number): boolean {
  return outcome.profitUsd > 0 && outcome.marginPercent >= minMarginPercent;
}

// What the user keeps varies a little from sale to sale (their own range is 80-86% of the sold price), so anything
// shown to them is a dollar range, not a single hard percentage. The deal scoring above still works from the one
// configured middle figure (netPercent).
export const KEEP_RANGE_LOW_PERCENT = 80;
export const KEEP_RANGE_HIGH_PERCENT = 86;

export function keepRangeUsd(valueUsd: number): { lowUsd: number; highUsd: number } {
  return { lowUsd: (valueUsd * KEEP_RANGE_LOW_PERCENT) / 100, highUsd: (valueUsd * KEEP_RANGE_HIGH_PERCENT) / 100 };
}
