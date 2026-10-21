// Per-entry sold statistics from the sales Clynx has accepted for it: how many, the middle price, how many in the last 30 / 90 days (only when the source gives dates), and how much of what
// is for sale actually sells. Never a made-up number: where a figure needs data the source does not give, it says so. Pure.
import type { SoldComp } from "./types.js";

export interface SoldStats {
  count: number;
  medianUsd: number | null;
  /** Item plus shipping, over the sales that state shipping (null when fewer than half do). */
  medianDeliveredUsd: number | null;
  count30: number | null;
  count90: number | null;
  /** true when every sale has a date, so the 30 / 90-day counts are real. */
  datesKnown: boolean;
  /** Active asking listings seen for the same product (null: not looked at). */
  activeAsks: number | null;
  /** Share of (sold + for sale) that sold, 0..1. null when either side is unknown. */
  sellThrough: number | null;
  /** Average days a listing ran before it sold; only when the source gives it. */
  avgDaysToSell: number | null;
  note: string;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const DAY = 86_400_000;

export function soldStats(sales: ReadonlyArray<Pick<SoldComp, "soldPrice" | "shippingCost" | "soldAt" | "currency">>, activeAsks: number | null, avgDaysToSell: number | null, now: number = Date.now()): SoldStats {
  const usd = sales.filter((s) => s.currency === "USD");
  const dated = usd.filter((s) => s.soldAt !== null);
  const datesKnown = usd.length > 0 && dated.length === usd.length;
  const delivered = usd.filter((s) => s.shippingCost !== null);
  const sellThrough = usd.length > 0 && activeAsks !== null && usd.length + activeAsks > 0 ? usd.length / (usd.length + activeAsks) : null;
  const notes: string[] = [];
  if (usd.length === 0) notes.push("No accepted sales yet.");
  else if (!datesKnown) notes.push("The source does not give sale dates, so there are no 30 / 90-day counts or days-to-sell.");
  if (sellThrough !== null) notes.push("Sell-through is sold sales against listings still for sale right now: a rough guide, not a rate over time.");
  return {
    count: usd.length,
    medianUsd: usd.length ? Math.round(median(usd.map((s) => s.soldPrice)) * 100) / 100 : null,
    medianDeliveredUsd: delivered.length * 2 >= usd.length && usd.length > 0 ? Math.round(median(delivered.map((s) => s.soldPrice + (s.shippingCost ?? 0))) * 100) / 100 : null,
    count30: datesKnown ? dated.filter((s) => now - (s.soldAt as number) <= 30 * DAY).length : null,
    count90: datesKnown ? dated.filter((s) => now - (s.soldAt as number) <= 90 * DAY).length : null,
    datesKnown,
    activeAsks,
    sellThrough,
    avgDaysToSell: datesKnown || avgDaysToSell !== null ? avgDaysToSell : null,
    note: notes.join(" "),
  };
}
