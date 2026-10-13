// The two-line ntfy notification:
//
//   🟦 $300 - Xbox Series X - Listed 2 hours ago
//   About $120 profit, sells in 1 day - ⭐⭐⭐⭐
//
// The first emoji is a blue square for a Facebook listing and a green one for eBay; the stars come last.
//
// The product is the thing the listing is really about (not the seller's full title), and the stars are Clynx's own
// verdict on the deal (1 to 5 whole stars, drawn as ⭐ emojis: every phone with ntfy can show those), worked out from what it already knows: what the product sells for on eBay, how fast, what other
// Facebook listings of it cost, and the listing's condition. The one-line reason says what decided the rating.
import { DEFAULT_MIN_PROFIT_MARGIN_PERCENT, keepRangeUsd, resaleOutcome } from "./resaleMath.js";
import { cutNeededPercent, withinNegotiationReach } from "./profitGate.js";
import type { ScoredListing } from "./types.js";
import type { GateVerdict } from "./dealGate.js";

export interface ProductSignals {
  id: string;
  name: string;
  // What the product sells for on eBay (the Database estimate), when known.
  valueUsd: number | null;
  runTimeDays: number | null;
  compSample: number | null;
  // When WatchCount/eBay were last asked about it (null: never).
  checkedAt?: number | null;
  // What the user's own linked eBay store lists it for (their own price, not the market's).
  storeValueUsd?: number | null;
  // What the value rests on: sold comps, sold nudged by asking prices ("blend"), or asking prices only ("active"). null: unknown.
  basis?: "sold" | "blend" | "active" | null;
  // Whether the comps behind the value are the market of exactly this product ("approximate": mixed comps, the cheapest group stood in).
  identity?: "exact" | "approximate" | "unresolved" | null;
  // Defining codes the listing states that the product's name lacks (see identity/codes.ts); empty/absent = nothing unconfirmed.
  unconfirmedCodes?: string[];
}

export interface SignalSource {
  getProductSignals(matchedItem: string | null, title: string): ProductSignals | null;
  getFacebookPriceStats(productId: string): { avgPriceUsd: number; sampleSize: number } | null;
}

export interface DealFacts {
  priceUsd: number;
  shippingUsd: number;
  // What it sells for on eBay; null when Clynx has no sales data for it.
  valueUsd: number | null;
  netPercent: number;
  // The user's minimum profit margin, used to tell a bad price on a worthwhile product from a hopeless one.
  minMarginPercent?: number;
  // How far below the asking price a good deal may need negotiating (Config); see profitGate.ts.
  maxCutPercent?: number;
  // The listing is a broken / for-parts copy, priced from its Database variant (so no further condition discount applies).
  broken?: boolean;
  // What extras that come with the item add to its eBay value (a hidden gem): the whole lot is judged.
  extrasUsd?: number;
  conditionImpact: "none" | "minor" | "major" | "unknown";
  runTimeDays: number | null;
  compSample: number | null;
  fbAvgPriceUsd: number | null;
  fbSample: number | null;
}

// A flagged condition scales the value down before the profit is worked out (same factors scorer.ts uses).
const CONDITION_VALUE: Record<DealFacts["conditionImpact"], number> = { none: 1, unknown: 1, minor: 0.6, major: 0.25 };

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function days(d: number): string {
  return d < 1 ? "under a day" : plural(Math.round(d), "day");
}

/** At most `max` words, so the reason always stays short. */
function limitWords(text: string, max = 9): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : words.slice(0, max).join(" ").replace(/[,;:]$/, "");
}

export function rateDeal(f: DealFacts): { stars: number; reason: string; reachable: boolean | null; cutNeededPercent: number | null } {
  // Without sales data there is nothing to measure the price against: a middling, honestly-labelled score.
  if (f.valueUsd === null || f.valueUsd <= 0) {
    let stars = 3;
    let reason = "No sales data yet to judge the price";
    if (f.fbAvgPriceUsd !== null && (f.fbSample ?? 0) >= 3) {
      if (f.priceUsd > f.fbAvgPriceUsd * 1.1) {
        stars = 2;
        reason = "Priced above other listings, no sales data";
      } else if (f.priceUsd <= f.fbAvgPriceUsd * 0.8) {
        stars = 3.5;
        reason = "Cheaper than other listings, no sales data";
      }
    }
    if (f.conditionImpact === "major") stars = Math.max(1, stars - 1);
    else if (f.conditionImpact === "minor") stars = Math.max(1, stars - 0.5);
    // Nothing to measure the price against, so no verdict on whether a good deal is within reach.
    return { stars: Math.floor(stars), reason: limitWords(reason), reachable: null, cutNeededPercent: null };
  }

  const cost = f.priceUsd + f.shippingUsd;
  const extras = Math.max(0, f.extrasUsd ?? 0);
  const lotValue = f.valueUsd * CONDITION_VALUE[f.conditionImpact] + extras;
  const outcome = resaleOutcome(lotValue, cost, f.netPercent);
  const margin = outcome.marginPercent;
  const profit = Math.round(outcome.profitUsd);
  // Could a good deal be reached by negotiating at most 25% below the asking price? (see profitGate.ts and preAlert.ts)
  const settings = { netPercent: f.netPercent, minMarginPercent: f.minMarginPercent ?? DEFAULT_MIN_PROFIT_MARGIN_PERCENT, maxCutPercent: f.maxCutPercent };
  const reachable = withinNegotiationReach(lotValue, f.priceUsd, f.shippingUsd, settings);
  const cutNeeded = cutNeededPercent(lotValue, f.priceUsd, f.shippingUsd, settings);
  // What the Database says this product sells for on eBay, as what the user keeps after fees: the same dollar range the
  // Database page shows under "You'd keep".
  const keep = keepRangeUsd(f.valueUsd);
  const typical = `${f.broken ? "Broken ones typically sell" : "Typically sells"} for $${Math.round(keep.lowUsd)}-$${Math.round(keep.highUsd)} after eBay fees`;

  let stars: number;
  let marginReason: string;
  if (outcome.profitUsd <= 0) {
    stars = 1;
    marginReason = typical;
  } else if (margin < 8) {
    stars = 1.5;
    marginReason = typical;
  } else if (margin < 15) {
    stars = 2.5;
    marginReason = `Thin margin, about $${profit} profit after fees`;
  } else if (margin < 22) {
    stars = 3;
    marginReason = `Decent margin, about $${profit} profit`;
  } else if (margin < 30) {
    stars = 3.5;
    marginReason = `Solid deal, about $${profit} profit after fees`;
  } else if (margin < 40) {
    stars = 4;
    marginReason = `Strong margin, about $${profit} profit`;
  } else if (margin < 50) {
    stars = 4.5;
    marginReason = `Priced well under sold value, about $${profit} profit`;
  } else {
    stars = 5;
    marginReason = `Priced far under sold value, about $${profit} profit`;
  }

  // What else Clynx knows about this product, each nudging the rating up or down by half a star.
  const notes: Array<{ delta: number; reason: string }> = [];
  if (f.runTimeDays !== null && (f.compSample ?? 0) >= 3) {
    if (f.runTimeDays <= 3) notes.push({ delta: 0.5, reason: `sells in ${days(f.runTimeDays)}` });
    else if (f.runTimeDays >= 14) notes.push({ delta: -0.5, reason: `Slow seller, about ${days(f.runTimeDays)} to sell` });
  }
  if (f.fbAvgPriceUsd !== null && (f.fbSample ?? 0) >= 3) {
    if (f.priceUsd > f.fbAvgPriceUsd * 1.1) notes.push({ delta: -0.5, reason: "Listing is higher priced than others" });
    else if (f.priceUsd <= f.fbAvgPriceUsd * 0.8) notes.push({ delta: 0.5, reason: "cheaper than other listings" });
  }
  // A deal that loses money, or barely makes any, can't be rescued by a nice extra: only the drawbacks count.
  const usable = margin < 8 ? notes.filter((n) => n.delta < 0) : notes;
  stars += usable.reduce((sum, n) => sum + n.delta, 0);
  // A value worked out from only a couple of sales isn't one to be sure about.
  const fewSales = f.compSample !== null && f.compSample < 3;
  const cappedByFewSales = fewSales && roundHalf(stars) > 4;
  if (fewSales) stars = Math.min(stars, 4);
  stars = Math.min(5, Math.max(1, roundHalf(stars)));
  if (outcome.profitUsd <= 0) stars = 1;

  // The reason names what decided the rating: a held-back score names what held it back; a good one names why it's good.
  const negative = notes.filter((n) => n.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  const positive = notes.filter((n) => n.delta > 0)[0];
  let reason: string;
  // Losing money (or nearly) is the whole story, whatever else is true. If it would have been profitable but for the
  // item's condition, that is the story.
  const profitableAtFullValue = f.conditionImpact !== "none" && f.conditionImpact !== "unknown" && resaleOutcome(f.valueUsd, cost, f.netPercent).profitUsd > 0;
  if (outcome.profitUsd <= 0 && profitableAtFullValue) reason = "Condition issues cut the value below the price";
  else if (margin < 8) reason = marginReason;
  else if (negative && stars < 4) reason = negative.reason;
  else if (stars < 4 && f.conditionImpact !== "none" && f.conditionImpact !== "unknown") reason = "Condition issues cut the resale value";
  else if (stars < 4 && fewSales) reason = `Only ${plural(f.compSample ?? 0, "sale")} to judge the price`;
  else if (cappedByFewSales) reason = `About $${profit} profit, only ${plural(f.compSample ?? 0, "sale")} to go on`;
  // A good deal with a second thing going for it: the profit and that ("About $120 profit, sells in 1 day").
  else if (positive && stars >= 4) reason = `About $${profit} profit, ${positive.reason}`;
  else reason = marginReason;
  // A hidden gem: extras that come with the item are what make the lot worth buying.
  if (extras > 0 && stars >= 3) reason = `Hidden gem: extras add ~$${Math.round(extras)}, about $${profit} profit`;
  // Worked out in half steps (so the nudges above can be small), shown in whole stars: a half rounds DOWN, so a star is earned.
  return { stars: Math.min(5, Math.max(1, Math.floor(stars))), reason: limitWords(reason), reachable, cutNeededPercent: cutNeeded };
}

/** The rating as ⭐ emoji, 1 to 5 whole ones (emoji show on every device, unlike half-star symbols). */
export function starsText(stars: number): string {
  return "⭐".repeat(Math.min(5, Math.max(1, Math.round(stars))));
}

/** The first emoji of an alert says where the listing was found: a blue square for Facebook, a green one for eBay. */
export function sourceSquare(source?: string | null): string {
  return source === "ebay" ? "🟩" : "🟦";
}

// Words that describe the seller's listing, not the product.
const NOISE_WORDS = new Set(
  (
    "used new like mint great good excellent condition fully functional working works work obo firm price must sell selling sale pickup only local cash " +
    "sealed open box boxed original owner clean tested perfect brand very nice barely lightly gently excellent everything included w with and the for of a an " +
    "black white blue red green pink purple gray grey silver gold yellow orange brown beige cream teal navy console system unit " +
    "space unlocked locked midnight starlight graphite"
  ).split(" ")
);
const MAKER_WORDS = new Set(["microsoft", "sony", "apple", "samsung", "google", "amazon", "meta"]);

// "PS5 Pro with 2 controllers and a 2TB hard drive" is about the PS5 Pro: whatever comes after the first separator is the extras.
const BUNDLE_SEPARATOR = /\s+(?:with|w\/|and|plus|includes?|including|incl)\s+|\s*[+,&]\s*/i;

function cleanTitle(title: string): string {
  const first = title.split(BUNDLE_SEPARATOR)[0]?.trim();
  const words = (first && first.length >= 3 ? first : title)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z0-9+.\- ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NOISE_WORDS.has(w.toLowerCase()))
    .filter((w) => !/^\d+(\.\d+)?(gb|tb|mb)$/i.test(w))
    .filter((w) => !MAKER_WORDS.has(w.toLowerCase()));
  return words.slice(0, 4).join(" ");
}

/** The thing the listing is really about: the Database's name for it, the tracked item, the AI's category, or a cleaned-up title. */
export function focalProductName(args: { signalName: string | null; matchedItem: string | null; category: string | null; title: string }): string {
  const pick = args.signalName?.trim() || args.matchedItem?.trim() || (args.category && args.category.trim().length <= 40 ? args.category.trim() : "") || cleanTitle(args.title) || args.title;
  return pick.length > 60 ? `${pick.slice(0, 57).trim()}...` : pick;
}

export interface AlertSummary {
  productName: string;
  stars: number;
  reason: string;
  // Whether a good deal is within reach by negotiating at most 25% below the asking price (null: no sales data to tell). Internal:
  // it decides whether the alert is sent (see preAlert.ts).
  reachable: boolean | null;
  // How far below the asking price a good deal would need negotiating (percent); null with no sales data.
  cutNeededPercent: number | null;
  title: string;
  message: string;
}

/** "Listed 2 hours ago": the listing's own age text, or nothing when the listing didn't say. */
function listedText(age: string | null): string | null {
  const text = age?.trim();
  if (!text) return null;
  return /^(just|a few|moments)/i.test(text) ? `Listed ${text.toLowerCase()}` : `Listed ${text}`;
}

export function composeAlert(args: { priceUsd: number | null; age: string | null; productName: string; stars: number; reason: string; reachable?: boolean | null; cutNeededPercent?: number | null; source?: string | null }): AlertSummary {
  const parts = [args.priceUsd !== null ? `$${args.priceUsd}` : "$?", args.productName, listedText(args.age)].filter((p): p is string => !!p);
  return {
    productName: args.productName,
    stars: args.stars,
    reason: args.reason,
    reachable: args.reachable ?? null,
    cutNeededPercent: args.cutNeededPercent ?? null,
    title: `${sourceSquare(args.source)} ${parts.join(" - ")}`,
    message: `${args.reason} - ${starsText(args.stars)}`,
  };
}

/**
 * A deal alert in the Deal Quality Gate's words: the gate's headline and stars replace the plain rating, a negotiation shows what
 * to offer (and how much off that is), and a low-confidence verdict says the sales data is limited.
 */
export function composeGateAlert(summary: AlertSummary, verdict: GateVerdict): AlertSummary {
  const stars = verdict.stars ?? summary.stars;
  const limited = verdict.confidence === "low" ? " (limited sales data)" : "";
  const reason = `${verdict.headline}${limited}`;
  const target = verdict.facts.targetPriceUsd;
  // "$450" -> "$450 (offer ~$400)": the first price in the title is the asking price.
  const title = verdict.status === "negotiation" && target !== null ? summary.title.replace(/\$(\d+)/, (m) => `${m} (offer ~$${Math.round(target)})`) : summary.title;
  return { ...summary, stars, reason, title, message: `${reason} - ${starsText(stars)}` };
}

/**
 * A Watch match is the user's own explicit request, so it is always delivered, but it is labelled as a Watch match and says
 * plainly whether it also passed the Deal Quality Gate. A match that IS a qualified deal is one combined notification (never two).
 */
export function composeWatchAlert(args: { summary: AlertSummary; verdict: GateVerdict; watchName: string }): AlertSummary {
  const { summary, verdict, watchName } = args;
  const [square, ...rest] = summary.title.split(" ");
  const qualified = verdict.qualified;
  const title = `${square} ${qualified ? "Watch match + deal" : "Watch match"} - ${rest.join(" ")}`;
  const gated = composeGateAlert(summary, verdict);
  const message = qualified
    ? `${watchName}: ${gated.message}`
    : `${watchName}: not a qualified deal${verdict.status === "pass" ? " (a pass)" : ""}. ${verdict.headline}`;
  return { ...summary, stars: verdict.stars ?? summary.stars, reason: verdict.headline, title, message };
}

/** Everything the notification needs, worked out from the scored listing and what the Database knows. */
export function buildAlertSummary(
  source: SignalSource | null,
  scored: ScoredListing,
  opts: { netPercent: number; minMarginPercent?: number; maxCutPercent?: number; referencePriceUsd?: number | null; marketValueUsd?: number | null }
): AlertSummary {
  const { listing, extraction } = scored;
  let signals: ProductSignals | null = null;
  try {
    // A broken / for-parts listing is judged by its Database variant (what broken ones sell for), not the working product.
    signals = source?.getProductSignals(extraction.brokenVariant ?? extraction.matchedItem, listing.title) ?? null;
  } catch {
    signals = null;
  }
  const fb = signals && source ? source.getFacebookPriceStats(signals.id) : null;
  // A value Clynx just checked on WatchCount and eBay beats everything; else the value the scoring itself used, the Watch's
  // reference price and the Database's estimate, in that order.
  const valueUsd = opts.marketValueUsd ?? scored.referencePriceUsd ?? opts.referencePriceUsd ?? signals?.valueUsd ?? signals?.storeValueUsd ?? null;
  const { stars, reason, reachable, cutNeededPercent: cutNeeded } = rateDeal({
    priceUsd: listing.price ?? 0,
    shippingUsd: listing.ebayShippingUsd ?? 0,
    valueUsd,
    netPercent: opts.netPercent,
    minMarginPercent: opts.minMarginPercent,
    maxCutPercent: opts.maxCutPercent,
    broken: !!extraction.brokenVariant,
    extrasUsd: scored.bundleValueUsd ?? 0,
    conditionImpact: extraction.brokenVariant ? "none" : extraction.conditionImpact,
    runTimeDays: signals?.runTimeDays ?? null,
    compSample: signals?.compSample ?? null,
    fbAvgPriceUsd: listing.source === "ebay" ? null : (fb?.avgPriceUsd ?? null),
    fbSample: listing.source === "ebay" ? null : (fb?.sampleSize ?? null),
  });
  const productName = focalProductName({ signalName: signals?.name ?? null, matchedItem: extraction.matchedItem, category: extraction.extractedAttributes || null, title: listing.title });
  return composeAlert({ priceUsd: listing.price, age: listing.listingAge, productName, stars, reason, reachable, cutNeededPercent: cutNeeded, source: listing.source ?? "facebook" });
}
