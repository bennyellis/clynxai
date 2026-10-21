// Turns what eBay buyers actually paid (sold comps) and what sellers are asking right now (active listings)
// into one estimate of what a product is worth. Sold prices are the evidence; asking prices only fill in when
// sold data is thin, and are never allowed to override a solid sold sample.

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Mean after dropping prices wildly off the middle one (a $5 case, a $9,000 typo), once there are enough to tell. */
export function trimmedMean(values: number[]): { value: number | null; used: number } {
  if (values.length === 0) return { value: null, used: 0 };
  const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
  if (values.length < 5) return { value: mean(values), used: values.length };
  const mid = median(values) as number;
  const kept = values.filter((v) => v >= mid * 0.5 && v <= mid * 2);
  return kept.length >= 3 ? { value: mean(kept), used: kept.length } : { value: mean(values), used: values.length };
}

/**
 * What the buyer paid in total: the sold item price plus the shipping they paid (null when nothing sold). Values are all
 * "buyer total": eBay's cut, and so the user's take-home percentage, apply to the whole amount.
 */
export function buyerTotalUsd(itemPriceUsd: number | null, shippingUsd: number | null): number | null {
  return itemPriceUsd === null ? null : itemPriceUsd + Math.max(0, shippingUsd ?? 0);
}

export type EstimateBasis = "sold" | "blend" | "active";

export interface MarketEstimate {
  valueUsd: number | null;
  basis: EstimateBasis | null;
}

// Sellers list above what things sell for; this is how much of the asking price to believe.
const ASK_TO_SELL = 0.92;
const MIN_ACTIVE_SAMPLE = 3;
// Enough accepted asking prices to stand in when ONE sold sale disagrees with them wildly.
const MANY_ASKS = 8;
// With this many sold comps, the sold figure stands on its own when the asking prices disagree wildly.
const SOLID_SOLD_SAMPLE = 5;

export function estimateMarketValue(sold: { mean: number | null; n: number }, active: { median: number | null; n: number }): MarketEstimate {
  const haveSold = sold.mean !== null && sold.n > 0;
  const haveActive = active.median !== null && active.n >= MIN_ACTIVE_SAMPLE;
  const askAdjusted = haveActive ? (active.median as number) * ASK_TO_SELL : null;

  if (!haveSold && askAdjusted !== null) return { valueUsd: askAdjusted, basis: "active" };
  if (!haveSold) return { valueUsd: null, basis: null };
  if (askAdjusted === null) return { valueUsd: sold.mean, basis: "sold" };

  const soldMean = sold.mean as number;
  const ratio = askAdjusted / soldMean;
  if (sold.n >= SOLID_SOLD_SAMPLE && (ratio < 0.6 || ratio > 1.6)) return { valueUsd: soldMean, basis: "sold" };
  // Sold and asking prices that wildly disagree mean one of them is about a different thing (a "PS5" search full of $40 games next
  // to a $385 console sale). With a couple of sales those stand; with one sale there is no way to tell which is right, and a blended
  // number would be wrong either way (it used to come out at a $128 PS5), so there is no estimate until a better lookup settles it.
  if (ratio < 0.6 || ratio > 1.6) {
    if (sold.n >= 2) return { valueUsd: soldMean, basis: "sold" };
    // One sale against MANY accepted asking prices: a single sale is the weaker evidence (it may be a part-out, a broken unit or a typo), so with a real asking sample the estimate comes from the asking
    // side, labelled as asking prices only. This used to leave a product with 22 accepted asks showing "no price yet".
    if (active.n >= MANY_ASKS) return { valueUsd: askAdjusted, basis: "active" };
    return { valueUsd: null, basis: null };
  }

  // Sold comps count fully (up to 20); asking prices count a fraction as much each (up to 10 of them).
  const soldWeight = Math.min(sold.n, 20);
  const activeWeight = Math.min(active.n, 10) * 0.4;
  const valueUsd = (soldMean * soldWeight + askAdjusted * activeWeight) / (soldWeight + activeWeight);
  return { valueUsd, basis: activeWeight / (soldWeight + activeWeight) < 0.1 ? "sold" : "blend" };
}
