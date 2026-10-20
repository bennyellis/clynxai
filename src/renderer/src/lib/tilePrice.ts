// The price printed over each Library thumbnail (owner request 2026-10-20): what the product typically SELLS for on eBay, so you can tell at a glance whether something you have found is worth
// flipping. It is the same number the product page leads with (the buyer's total: sold price plus shipping), labelled by what it rests on: sold sales, a mix, or only what sellers are asking.
// Pure: the product's stored numbers go in, the words come out. Nothing is fetched or changed.
import { keepRangeUsd } from "../../../main/resaleMath.js";

export interface TilePriceInput {
  ebayEstimatedValueUsd: number | null;
  ebayEstimateBasis: "sold" | "blend" | "active" | null;
  ebayAvgSoldPriceUsd: number | null;
  ebayAvgShippingUsd: number | null;
  ebayCompsSampleSize: number | null;
  ebayActiveSampleSize: number | null;
}

export type TilePriceTone = "sold" | "few" | "asking" | "none";

export interface TilePrice {
  /** "$1,087", or "No price yet". */
  text: string;
  /** A few words under it: "avg sold", "avg sold · 2 sales", "asking, not sold", "". */
  sub: string;
  tone: TilePriceTone;
  /** The full sentence for the hover text. */
  title: string;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function tilePrice(p: TilePriceInput): TilePrice {
  const sold = p.ebayAvgSoldPriceUsd !== null && (p.ebayCompsSampleSize ?? 0) > 0 ? p.ebayAvgSoldPriceUsd + Math.max(0, p.ebayAvgShippingUsd ?? 0) : null;
  const value = p.ebayEstimatedValueUsd !== null && p.ebayEstimatedValueUsd > 0 ? p.ebayEstimatedValueUsd : sold;
  if (value === null || !(value > 0)) {
    return { text: "No price yet", sub: "", tone: "none", title: "Clynx has no eBay sales or asking prices it trusts for this one yet." };
  }
  const sales = p.ebayCompsSampleSize ?? 0;
  const asks = p.ebayActiveSampleSize ?? 0;
  const keep = keepRangeUsd(value);
  const keepLine = `After fees you would keep about ${money(keep.lowUsd)}-${money(keep.highUsd)}.`;
  // What the number rests on. With no sold sales the estimate can only come from asking prices (sellers hope; buyers pay less), and it says so.
  const basis = p.ebayEstimateBasis ?? (sales > 0 ? "sold" : "active");
  if (basis === "active" || sales === 0) {
    return { text: money(value), sub: "asking, not sold", tone: "asking", title: `About ${money(value)} to a buyer, going only by what ${plural(asks, "seller")} ask on eBay right now (no sold prices found). Treat it as a ceiling, not proof. ${keepLine}` };
  }
  if (sales < 3) {
    return { text: money(value), sub: `avg sold · ${plural(sales, "sale")}`, tone: "few", title: `About ${money(value)} to a buyer, from only ${plural(sales, "sold sale")}, so it is a rough guess. ${keepLine}` };
  }
  return { text: money(value), sub: "avg sold", tone: "sold", title: `The average eBay buyer pays about ${money(value)} in total (${plural(sales, "sold sale")}${basis === "blend" ? ", blended with asking prices" : ""}). ${keepLine}` };
}
