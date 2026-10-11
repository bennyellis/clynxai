// Clynx's take on a PRODUCT (not a listing, not a seller): is this thing worth flipping, and why or why not? Worked out only from
// what the Database knows about the product: what it sells for on eBay, how fast, how much evidence there is, and what the user's
// profit settings leave on the table. Plain arithmetic, so it never costs an AI call and is the same every time.
import { keepRangeUsd, maxBuyPriceUsd, type ResaleSettings } from "./resaleMath.js";

export type FlipLevel = "strong" | "decent" | "thin" | "pass" | "unknown";

export interface FlipReason {
  kind: "good" | "bad" | "info";
  text: string;
}

export interface FlipVerdict {
  level: FlipLevel;
  headline: string;
  reasons: FlipReason[];
  // The most the user could pay for one and still make their minimum margin (null when that can't be worked out).
  ceilingUsd: number | null;
  valueUsd: number | null;
}

// The fields of a Database product the verdict reads (ProductProfile has them all).
export interface VerdictProduct {
  name: string;
  ebayEstimatedValueUsd: number | null;
  ebayEstimateBasis: "sold" | "blend" | "active" | null;
  ebayAvgSoldPriceUsd: number | null;
  ebayAvgShippingUsd: number | null;
  ebayCompsSampleSize: number | null;
  ebayActiveMedianUsd: number | null;
  ebayActiveSampleSize: number | null;
  ebayAvgRunTimeDays: number | null;
}

const money = (n: number) => `$${Math.round(n)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const HEADLINE: Record<FlipLevel, string> = {
  strong: "A good one to flip",
  decent: "Worth flipping at the right price",
  thin: "A marginal flip",
  pass: "Probably not worth flipping",
  unknown: "Can't judge it yet",
};

export function judgeProduct(p: VerdictProduct, settings: ResaleSettings): FlipVerdict {
  const sample = p.ebayCompsSampleSize ?? 0;
  const soldTotal = p.ebayAvgSoldPriceUsd !== null && sample > 0 ? p.ebayAvgSoldPriceUsd + Math.max(0, p.ebayAvgShippingUsd ?? 0) : null;
  const valueUsd = p.ebayEstimatedValueUsd ?? soldTotal;
  if (valueUsd === null || !(valueUsd > 0)) {
    return {
      level: "unknown",
      headline: HEADLINE.unknown,
      reasons: [{ kind: "info", text: "I don't have sales or asking prices for this one yet, so I can't say what a flip would earn." }],
      ceilingUsd: null,
      valueUsd: null,
    };
  }

  const reasons: FlipReason[] = [];
  let points = 0;

  const keep = keepRangeUsd(valueUsd);
  reasons.push({ kind: "info", text: `It's worth about ${money(valueUsd)} to a buyer on eBay, so after fees you'd keep about ${money(keep.lowUsd)}-${money(keep.highUsd)}.` });

  // What a flip can earn at best: buying at the ceiling that still clears the user's minimum margin.
  const ceiling = maxBuyPriceUsd(valueUsd, 0, settings);
  const keepMid = (valueUsd * settings.netPercent) / 100;
  const bestProfit = keepMid * (settings.minMarginPercent / 100);
  if (ceiling > 0) {
    reasons.push({ kind: "info", text: `To keep your ${settings.minMarginPercent}% margin you'd need to buy it for ${money(ceiling)} or less.` });
  } else {
    reasons.push({ kind: "bad", text: `At that value no purchase price leaves your ${settings.minMarginPercent}% margin.` });
    points -= 2;
  }
  if (bestProfit >= 40) {
    reasons.push({ kind: "good", text: `A well-priced one leaves about ${money(bestProfit)} profit each, enough to be worth the effort.` });
    points += 2;
  } else if (bestProfit >= 15) {
    points += 1;
  } else if (ceiling > 0) {
    reasons.push({ kind: "bad", text: `Even a well-priced one only leaves about ${money(bestProfit)} profit, which shipping and hassle can easily eat.` });
    points -= 2;
  }

  // How fast they sell (only trusted with a few sales behind it).
  if (p.ebayAvgRunTimeDays !== null && sample >= 3) {
    const d = p.ebayAvgRunTimeDays;
    const days = d < 1 ? "under a day" : `about ${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
    if (d <= 7) {
      reasons.push({ kind: "good", text: `It sells fast, in ${days}, so your money doesn't sit.` });
      points += 1;
    } else if (d >= 14) {
      reasons.push({ kind: "bad", text: `It's slow to sell (${days}), which ties up your money.` });
      points -= 1;
    } else {
      reasons.push({ kind: "info", text: `It usually sells in ${days}.` });
    }
  }

  // How much evidence the number rests on.
  if (p.ebayEstimateBasis === "active" || (sample === 0 && p.ebayActiveSampleSize)) {
    reasons.push({ kind: "bad", text: "That number comes from asking prices only: I haven't confirmed what it actually sells for." });
    points -= 1;
  } else if (sample >= 8) {
    reasons.push({ kind: "good", text: `It rests on ${plural(sample, "sale")}, so I trust the number.` });
    points += 1;
  } else if (sample < 3) {
    reasons.push({ kind: "bad", text: `Only ${plural(sample, "sale")} to go on, so treat the number cautiously.` });
    points -= 1;
  }

  // Sellers' hopes versus what actually happened.
  if (soldTotal !== null && p.ebayActiveMedianUsd !== null && (p.ebayActiveSampleSize ?? 0) >= 3) {
    if (p.ebayActiveMedianUsd > soldTotal * 1.25) {
      reasons.push({ kind: "info", text: `Sellers are asking about ${money(p.ebayActiveMedianUsd)}, but it really sells for less. I go by the sales.` });
    } else if (p.ebayActiveMedianUsd < soldTotal * 0.8) {
      reasons.push({ kind: "bad", text: `Current asking prices (about ${money(p.ebayActiveMedianUsd)}) are below what it recently sold for, so the market may be cooling.` });
      points -= 1;
    }
  }

  if (/\(for parts \/ broken\)/i.test(p.name)) {
    reasons.push({ kind: "info", text: "This is the broken / for-parts version: it sells to people who repair it, so the real price depends on the fault." });
  }

  const level: FlipLevel = points >= 3 ? "strong" : points >= 1 ? "decent" : points >= -1 ? "thin" : "pass";
  return { level, headline: HEADLINE[level], reasons, ceilingUsd: ceiling > 0 ? ceiling : null, valueUsd };
}
