import type { ListingRecord } from "../../../main/types.js";

// What a Feed card says about the money, built ONLY from the numbers the Deal Quality Gate saved with the verdict (ListingRecord.gateFacts).
// Nothing is recomputed or guessed here: a missing number is shown as unknown, and a thinly supported estimate says so in words.

export interface DealNumbers {
  // false when the gate had no resale value to work from (or the numbers were not saved): show the support line, no figures.
  hasFigures: boolean;
  resale: string | null; // "~$480"
  keep: string | null; // "~$403"
  profit: string | null; // "+$103" / "-$20"
  profitTone: "good" | "bad" | "muted";
  margin: string | null; // "26%"
  // How far to trust the estimate, in words.
  support: string;
  supportTone: "ok" | "warn" | "muted";
  // Negotiation only: "At a $400 offer: about +$130 profit".
  atTarget: string | null;
  // Up to two short reasons for the verdict, most important first (the headline is shown separately).
  reasons: string[];
  // Everything, for a tooltip.
  allReasons: string[];
}

const usd = (n: number) => `$${Math.round(Math.abs(n))}`;
const signed = (n: number) => `${n < 0 ? "-" : "+"}${usd(n)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Input = Pick<ListingRecord, "dealStatus" | "gateFacts" | "gateReasons" | "gateHeadline" | "targetPriceUsd">;

export function describeDealNumbers(r: Input): DealNumbers | null {
  if (!r.dealStatus) return null; // never gated (older listing): the card shows what it always did

  const order = { bad: 0, warn: 1, info: 2, good: 3 } as const;
  const shown = [...r.gateReasons]
    .filter((x) => x.code !== "MARGIN_OK") // restates the figures shown beside it
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((x) => x.text)
    .filter((t) => t !== r.gateHeadline);
  const base = { reasons: shown.slice(0, 2), allReasons: r.gateReasons.map((x) => x.text) };

  const f = r.gateFacts;
  if (!f) {
    return { hasFigures: false, resale: null, keep: null, profit: null, profitTone: "muted", margin: null, support: "The numbers behind this verdict weren't saved for this listing.", supportTone: "muted", atTarget: null, ...base };
  }

  const n = f.sampleSize ?? 0;
  let support: string;
  let supportTone: DealNumbers["supportTone"] = "ok";
  if (f.lotValueUsd === null || f.evidenceLevel === "none") {
    support = "No resale estimate yet: Clynx doesn't guess one.";
    supportTone = "muted";
  } else if (f.basis === "user") {
    support = "From the reference price you set.";
  } else if (f.basis === "active") {
    support = "Rough estimate: asking prices only, no confirmed sales.";
    supportTone = "warn";
  } else if (f.evidenceLevel === "weak") {
    support = n > 0 ? `Rough estimate: only ${plural(n, "sale")} to go on.` : "Rough estimate: no confirmed sales.";
    supportTone = "warn";
  } else {
    support = `Based on ${plural(n, f.evidenceLevel === "strong" ? "recent eBay sale" : "eBay sale")}.`;
  }
  if (f.extrasCountedUsd > 0 && f.lotValueUsd !== null) support += ` Includes ~${usd(f.extrasCountedUsd)} of extras.`;

  if (f.lotValueUsd === null) {
    return { hasFigures: false, resale: null, keep: null, profit: null, profitTone: "muted", margin: null, support, supportTone, atTarget: null, ...base };
  }

  const profit = f.profitAtAskUsd;
  const atTarget =
    r.dealStatus === "negotiation" && f.profitAtTargetUsd !== null && r.targetPriceUsd !== null
      ? `At a ${usd(r.targetPriceUsd)} offer: about ${signed(f.profitAtTargetUsd)} profit`
      : null;
  return {
    hasFigures: true,
    resale: `~${usd(f.lotValueUsd)}`,
    keep: f.netProceedsUsd !== null ? `~${usd(f.netProceedsUsd)}` : null,
    profit: profit !== null ? signed(profit) : null,
    profitTone: profit === null ? "muted" : profit > 0 ? "good" : "bad",
    margin: f.marginAtAskPercent !== null ? `${Math.round(f.marginAtAskPercent)}%` : null,
    support,
    supportTone,
    atTarget,
    ...base,
  };
}
