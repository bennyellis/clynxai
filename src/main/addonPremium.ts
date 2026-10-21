// Phase 5 of the Beta 30 plan: what an add-on REALLY adds, measured from sold pairs. The console's value comes from console-only sales (no double counting); the premium is the median of the sales that
// include the add-on minus the median of the sales that do not, for the same model, edition and condition, over the same period. It is never more than the add-on sells for on its own, never more
// than half of the base, and deal scoring uses only its LOW end. With too few sales it falls back to a cautious prior that says it is a guess. Pure: sales in, numbers out.
import { ACCESSORY_WEIGHT, EXTRA_WEIGHT } from "./bundleBreakdown.js";

export const MIN_SALES_PER_SIDE = 5;
export const PREMIUM_CEILING_OF_BASE = 0.5;

export interface PremiumInput {
  /** Total prices (item plus shipping) of sales that INCLUDE the add-on. */
  withUsd: ReadonlyArray<number>;
  /** Total prices of sales of the same thing WITHOUT it. */
  withoutUsd: ReadonlyArray<number>;
  /** What the add-on sells for on its own, when known. */
  standaloneUsd: number | null;
  /** The base's value from console-only sales. */
  baseUsd: number | null;
  role?: "expected" | "bonus";
}

export interface PremiumResult {
  /** The best estimate, in dollars. null when nothing can be said. */
  midUsd: number | null;
  /** The LOW end: the only part deal scoring may count. */
  lowUsd: number | null;
  highUsd: number | null;
  basis: "measured" | "prior" | "none";
  sampleWith: number;
  sampleWithout: number;
  /** true when it is a cautious guess, not measured. */
  guess: boolean;
  note: string;
}

const median = (v: ReadonlyArray<number>) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const variance = (v: ReadonlyArray<number>) => {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1);
};
const money = (n: number) => `$${Math.round(n)}`;

export function measurePremium(i: PremiumInput): PremiumResult {
  const base = i.baseUsd !== null && i.baseUsd > 0 ? i.baseUsd : null;
  const stand = i.standaloneUsd !== null && i.standaloneUsd > 0 ? i.standaloneUsd : null;
  const ceiling = Math.min(stand ?? Infinity, base !== null ? base * PREMIUM_CEILING_OF_BASE : Infinity);
  const clamp = (n: number) => Math.max(0, Math.min(n, Number.isFinite(ceiling) ? ceiling : n));
  const nW = i.withUsd.length;
  const nO = i.withoutUsd.length;

  if (nW >= MIN_SALES_PER_SIDE && nO >= MIN_SALES_PER_SIDE) {
    const raw = median(i.withUsd) - median(i.withoutUsd);
    const se = Math.sqrt(variance(i.withUsd) / nW + variance(i.withoutUsd) / nO);
    const mid = clamp(raw);
    // the low end is one standard error under the measured gap: when the two groups overlap a lot, the premium may be nothing at all
    const low = clamp(raw - se);
    const high = clamp(raw + se);
    return {
      midUsd: Math.round(mid),
      lowUsd: Math.round(low),
      highUsd: Math.round(high),
      basis: "measured",
      sampleWith: nW,
      sampleWithout: nO,
      guess: false,
      note: `Measured from sold pairs: ${nW} sales with it (median ${money(median(i.withUsd))}) and ${nO} without (median ${money(median(i.withoutUsd))}). ${raw <= 0 ? "Sales with it did not sell for more." : raw > mid ? `The gap was ${money(raw)}, kept to ${money(mid)} (never more than it sells for alone, or half the base).` : `The gap is about ${money(mid)}.`}`,
    };
  }
  if (stand !== null && base !== null) {
    const weight = i.role === "bonus" ? EXTRA_WEIGHT : ACCESSORY_WEIGHT;
    const mid = clamp(stand * weight);
    return {
      midUsd: Math.round(mid),
      lowUsd: Math.round(mid * 0.5),
      highUsd: Math.round(mid),
      basis: "prior",
      sampleWith: nW,
      sampleWithout: nO,
      guess: true,
      note: `A guess, not measured: only ${nW} sale${nW === 1 ? "" : "s"} with it and ${nO} without (${MIN_SALES_PER_SIDE} of each are needed). Counted at about ${Math.round(weight * 100)}% of the ${money(stand)} it sells for alone.`,
    };
  }
  return { midUsd: null, lowUsd: null, highUsd: null, basis: "none", sampleWith: nW, sampleWithout: nO, guess: true, note: "Not enough to say what this adds: no matching sales and no price for it on its own." };
}

/** Splits sales of one base product into those that mention an add-on and those that do not, by words in the title ("w/ controller", "with controller", "+ controller"). */
export function splitByInclusion<T extends { title: string }>(sales: ReadonlyArray<T>, addonWords: ReadonlyArray<string>): { withIt: T[]; withoutIt: T[] } {
  const words = addonWords.map((w) => w.toLowerCase()).filter(Boolean);
  const cue = (title: string) => {
    const t = title.toLowerCase();
    if (!words.every((w) => t.includes(w))) return "none" as const;
    // "no controller", "without controller", "console only" say it is NOT there
    if (new RegExp(`(?:\\bno|\\bwithout|\\bw/o|\\bmissing)\\s+(?:\\w+\\s+){0,2}${words[0]}`).test(t)) return "absent" as const;
    // a sale that bundles several other things (games, a headset, "bundle", "lot") is not a clean "with it": it is left out of both sides
    if (/\b(?:games?|headsets?|headphones?|bundle|lot|accessor(?:y|ies)|cables?|\d+\s*controllers?)\b/.test(t.replace(new RegExp(words.join("|"), "g"), " "))) return "lot" as const;
    return "present" as const;
  };
  const withIt: T[] = [];
  const withoutIt: T[] = [];
  for (const s of sales) {
    const c = cue(s.title);
    if (c === "present") withIt.push(s);
    else if (c === "absent" || (c === "none" && !/\b(?:bundle|lot|\+|w\/|with|includes?|comes with)\b/i.test(s.title))) withoutIt.push(s);
    // a title that lists other extras but not this one is left out: it is neither clean "with" nor clean "without"
  }
  return { withIt, withoutIt };
}
