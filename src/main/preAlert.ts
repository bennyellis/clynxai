// The market check that runs before a deal notification goes out. The Database's price for a product can be days old (or
// from a handful of sales), so Clynx looks the product up on WatchCount and eBay first (sold prices, what sellers are asking
// now), files what it found in the Database, and only then works out the stars and decides whether the deal still deserves a
// push. The look-up itself lives in index.ts (it needs the browser, the Database and eBay); this file is the decision.
import { buildAlertSummary, type AlertSummary, type SignalSource } from "./dealSummary.js";
import type { ScoredListing } from "./types.js";
import { isSuspiciousPrice, placeholderPriceReason } from "./placeholderPrice.js";

export interface MarketCheck {
  productId: string | null;
  productName: string | null;
  // What the product sells for on eBay now (sold prices blended with asking prices); null when there is nothing to go on.
  valueUsd: number | null;
  // True when WatchCount and eBay were just asked; false when the Database's recent answer for this exact product was reused.
  refreshed: boolean;
  note: string;
}

// purpose "bundle": the product is one item of a listing that holds several, priced on its own (not an alert check).
export type MarketChecker = (listing: { title: string; matchedItem: string | null; purpose?: "bundle" }) => Promise<MarketCheck | null>;

export interface PreparedAlert {
  send: boolean;
  summary: AlertSummary;
  market: MarketCheck | null;
}

export async function prepareAlert(args: {
  check?: MarketChecker;
  source: SignalSource | null;
  scored: ScoredListing;
  netPercent: number;
  minMarginPercent?: number;
  // Config > "Skip deals that need more than ___% off the asking price" (default 15).
  maxCutPercent?: number;
  referencePriceUsd?: number | null;
  // A deal Clynx found on its own can be held back when the fresh numbers sink it; a Watch the user set up themselves is
  // always delivered (the user asked for it), just rated on the fresh numbers.
  canWithhold: boolean;
  log: (message: string) => void;
}): Promise<PreparedAlert> {
  const { scored } = args;
  // Last line of defence: a placeholder price ($0, $1, $1234...) never gets a notification, whatever found the listing (a Watch
  // included). The scanners skip these long before this point; this covers anything that slips through.
  if (scored.listing.price !== null && isSuspiciousPrice(scored.listing.price)) {
    args.log(`Skipped the alert for "${scored.listing.title}": ${placeholderPriceReason(scored.listing.price)}.`);
    return { send: false, summary: buildAlertSummary(args.source, scored, { netPercent: args.netPercent, minMarginPercent: args.minMarginPercent, maxCutPercent: args.maxCutPercent, referencePriceUsd: args.referencePriceUsd }), market: null };
  }
  let market: MarketCheck | null = null;
  try {
    // A broken / for-parts deal is checked against its Database variant, not the working product.
    const variant = scored.extraction.brokenVariant;
    market = (await args.check?.({ title: variant ?? scored.listing.title, matchedItem: variant ?? scored.extraction.matchedItem })) ?? null;
  } catch (err) {
    args.log(`Market check failed (${(err as Error).message}), using what the Database already knows.`);
  }
  if (market?.note) args.log(market.note);
  const summary = buildAlertSummary(args.source, scored, {
    netPercent: args.netPercent,
    minMarginPercent: args.minMarginPercent,
    maxCutPercent: args.maxCutPercent,
    referencePriceUsd: args.referencePriceUsd,
    marketValueUsd: market?.valueUsd ?? null,
  });
  // The negotiation rule: when the user would have to negotiate more than the limit (15% by default) below the asking price to
  // reach a good deal (the minimum margin after eBay's cut), the alert is skipped. Extras that are really included in the price
  // count towards the value (a hidden gem), which is already in `summary`. A Watch the user set up is always delivered, and
  // with no sales data there is nothing to judge by.
  const skip = args.canWithhold && summary.reachable === false;
  if (skip) {
    const limit = args.maxCutPercent ?? 15;
    args.log(`Skipped the alert for "${scored.listing.title}": the price would need negotiating ${summary.cutNeededPercent ?? `over ${limit}`}% below the asking price to be a good deal (your limit is ${limit}%).`);
  }
  return { send: !skip, summary, market };
}
