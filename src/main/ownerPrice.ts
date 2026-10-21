// Phase 4a / 4b of the Beta 30 plan: "Your price" - what the owner knows an item sells for, kept as evidence with where it came from, used (at its LOW end) when real sold prices are missing, and
// compared against real sold prices when they arrive (the "Wow" toast). Also the rules for how often Clynx may ask. Pure: nothing here reads or writes the Database.

export const OWNER_PRICE_TTL_DAYS = 90;
export const MAX_PRICE_PROMPTS_PER_DAY = 3;
export const PROMPT_COOLDOWN_DAYS = 90;
export const LATER_COOLDOWN_DAYS = 7;
const DAY = 86_400_000;

export interface OwnerPrice {
  productId: string;
  lowUsd: number;
  highUsd: number;
  /** "used - good", "new in box"... as the owner said it. */
  condition: string | null;
  /** What came with it, in the owner's words. */
  includes: string | null;
  /** "last month", "this week"... */
  recency: string | null;
  /** true when the number is what a BUYER pays in total (item plus shipping). */
  buyerTotal: boolean;
  setAt: number;
  /** Set when real sold prices took over (the number stays visible beside them). */
  replacedAt: number | null;
}

/** The value deal scoring may use from the owner's number: the low end of the range, until it expires, drifts from the asking prices, or real sold prices have replaced it. */
export function ownerValueUsd(p: OwnerPrice | null, now: number = Date.now(), activeMedianUsd: number | null = null): number | null {
  if (!p || p.replacedAt !== null || !(p.lowUsd > 0)) return null;
  if (now - p.setAt > OWNER_PRICE_TTL_DAYS * DAY) return null;
  if (activeMedianUsd !== null && activeMedianUsd > 0 && askingDrifted(p, activeMedianUsd)) return null;
  return p.lowUsd;
}

/** Asking prices have moved well away from the owner's range (they sell for what they sell for, but a very different asking market means the number is probably stale). */
export function askingDrifted(p: Pick<OwnerPrice, "lowUsd" | "highUsd">, activeMedianUsd: number): boolean {
  const mid = (p.lowUsd + p.highUsd) / 2;
  return activeMedianUsd > mid * 1.6 || activeMedianUsd < mid * 0.5;
}

export interface OwnerAnswerInput {
  lowUsd: number;
  highUsd?: number;
  condition?: string | null;
  includes?: string | null;
  recency?: string | null;
  buyerTotal?: boolean;
}

/** A sane price range from what the owner typed, or an error in plain words. */
export function cleanOwnerAnswer(input: OwnerAnswerInput): { ok: true; lowUsd: number; highUsd: number } | { ok: false; error: string } {
  const low = Number(input.lowUsd);
  const high = input.highUsd === undefined || input.highUsd === null || Number.isNaN(Number(input.highUsd)) ? low : Number(input.highUsd);
  if (!Number.isFinite(low) || low <= 0) return { ok: false, error: "Type what it usually sells for, in dollars." };
  if (low > 100_000 || high > 100_000) return { ok: false, error: "That is more than Clynx can use. Check the number." };
  if (high < low) return { ok: false, error: "The high end is lower than the low end." };
  return { ok: true, lowUsd: Math.round(low * 100) / 100, highUsd: Math.round(high * 100) / 100 };
}

// ---- the Wow toast

export interface SoldFacts {
  medianUsd: number;
  /** accepted samples */
  n: number;
  identitySettled: boolean;
  /** same condition and inclusions as the owner's number */
  likeForLike: boolean;
}
export const WOW_MIN_SAMPLES = 5;
export const WOW_MIN_GAP_PERCENT = 10;
export const WOW_MIN_GAP_USD = 10;

export interface WowResult {
  kind: "higher" | "lower";
  ownerUsd: number;
  soldUsd: number;
  message: string;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Whether real sold prices beat (or undercut) the owner's own number by enough to say so. The owner's number to compare is the middle of the range they gave. */
export function compareWithSold(productName: string, p: OwnerPrice, sold: SoldFacts): WowResult | null {
  if (p.replacedAt !== null) return null;
  if (sold.n < WOW_MIN_SAMPLES || !sold.identitySettled || !sold.likeForLike || !(sold.medianUsd > 0)) return null;
  const owner = (p.lowUsd + p.highUsd) / 2;
  const gap = sold.medianUsd - owner;
  if (Math.abs(gap) < WOW_MIN_GAP_USD || Math.abs(gap) / owner < WOW_MIN_GAP_PERCENT / 100) return null;
  const kind = gap > 0 ? "higher" : "lower";
  const message =
    kind === "higher"
      ? `Wow! The ${productName} you thought went for ${money(owner)} actually goes for ${money(sold.medianUsd)}!`
      : `Heads up: the ${productName} you thought went for ${money(owner)} actually goes for ${money(sold.medianUsd)}. I've updated your numbers.`;
  return { kind, ownerUsd: owner, soldUsd: sold.medianUsd, message };
}

/** Several toasts at once become one line. */
export function combineWows(items: ReadonlyArray<{ message: string }>): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0].message;
  return `${items.length} prices of yours were checked against real sales: ${items.length} changed. Open Recent changes to see them.`;
}

// ---- when to ask

export type PromptState = "asked" | "answered" | "later" | "never";
export interface PromptRecord {
  productId: string;
  state: PromptState;
  at: number;
}

/** The entries Clynx may ask about now: not asked within ~90 days, not "ask me later" within a week, never the ones set to "don't ask", and at most a few per day. */
export function pickPricePrompts<T extends { productId: string }>(candidates: ReadonlyArray<T>, history: ReadonlyArray<PromptRecord>, now: number = Date.now(), perDay: number = MAX_PRICE_PROMPTS_PER_DAY): T[] {
  const askedToday = history.filter((h) => h.state === "asked" && now - h.at < DAY).length;
  let room = Math.max(0, perDay - askedToday);
  const out: T[] = [];
  for (const c of candidates) {
    if (room <= 0) break;
    const mine = history.filter((h) => h.productId === c.productId);
    if (mine.some((h) => h.state === "never")) continue;
    if (mine.some((h) => (h.state === "asked" || h.state === "answered") && now - h.at < PROMPT_COOLDOWN_DAYS * DAY)) continue;
    if (mine.some((h) => h.state === "later" && now - h.at < LATER_COOLDOWN_DAYS * DAY)) continue;
    out.push(c);
    room--;
  }
  return out;
}

// ---- how to check sold prices yourself

/** eBay's sold-items search for a name, opened in the owner's OWN browser (nothing is automated). */
export function soldSearchUrl(name: string): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(name)}&LH_Sold=1&LH_Complete=1&_sop=13`;
}

export const HOW_TO_CHECK_SOLD: ReadonlyArray<string> = [
  "Search the exact name on eBay.",
  "Open Filters, then tick Sold items (the prices turn green).",
  "Pick the condition that matches yours, and sort by Recently ended.",
  "Look at 10 to 15 sales. Ignore parts-only, broken and bundles of many things.",
  "Take the middle price, not the highest. Add what the buyer paid for shipping if it is shown.",
  "Seller Hub and Terapeak show the same data in a table if you have them; you can paste or import that into Clynx.",
];
