// Final qualification of a scored listing, run once every score adjustment (vision, bundles, hidden gems) has been made, and
// before anything is pushed. It does three things:
//
//   1. Works out how reliable the resale value is (Database evidence, or a reference price the user typed).
//   2. Validates it: before an AI-only find, or anything about to be pushed, is trusted, Clynx looks the product up on
//      WatchCount and eBay (the market check; the Database's number may be days old or from a handful of sales), files what it
//      found in the Database, and uses the fresh evidence.
//   3. Runs the Deal Quality Gate (dealGate.ts) and returns the listing with its final, persistable verdict: isDeal now means
//      "qualified" (Profitable Now or Negotiation Opportunity), and a Watch match no longer counts as a deal unless it passes.
//
// The look-up itself lives in index.ts (it needs the browser, the Database and eBay); this file is the decision.
import { buildAlertSummary, composeGateAlert, composeWatchAlert, type AlertSummary, type SignalSource } from "./dealSummary.js";
import { evidenceFromSignals, qualifyListing, toGateSnapshot, userEvidence, type GateExtras, type GateInput, type GateVerdict, type ValueEvidence } from "./dealGate.js";
import { assessListingAge } from "./listingAge.js";
import { codesMissingFrom } from "./identity/codes.js";
import { isSuspiciousPrice } from "./placeholderPrice.js";
import type { ResaleSettings } from "./resaleMath.js";
import type { ScoredListing } from "./types.js";

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
export type MarketChecker = (listing: { title: string; matchedItem: string | null; purpose?: "bundle"; identityTexts?: string[]; listingId?: string }) => Promise<MarketCheck | null>;

export interface QualifyArgs {
  scored: ScoredListing;
  source: SignalSource | null;
  settings: ResaleSettings;
  // The account's general freshness window (hours), null = none.
  maxAgeHours: number | null;
  check?: MarketChecker;
  // Ask WatchCount/eBay before deciding (anything that may be pushed). The check also runs when the listing would qualify, or when
  // the only thing behind the deal is the AI's own opinion: a verdict that would trigger a push is always validated first.
  refreshMarket: boolean;
  // Extras that come with the item, split into what may be counted (corroborated, capped) and what may not.
  extras?: GateExtras | null;
  visionMismatch?: boolean;
  hardCapExceeded?: boolean;
  // The product names the photo analysis gave this listing: independent evidence that a code in the title is a real marker.
  identityTexts?: string[];
  // Phase 3: what the identity step (scanIdentity.ts) could not settle about WHICH model this is; non-empty keeps the listing from being called a deal.
  ladderUnconfirmed?: string[];
  // Beta 13: the defect-specific condition adjustment (conditionAdjust.ts), given the clean value; absent = the flat condition multiplier as before.
  conditionAdjust?: GateInput["conditionAdjust"];
  log: (message: string) => void;
}

export interface Qualification {
  // The listing as it should now be saved: gate attached, isDeal = qualified, tier cleared when it did not qualify.
  scored: ScoredListing;
  verdict: GateVerdict;
  market: MarketCheck | null;
}

function pathwayOf(scored: ScoredListing): "search" | "database" | "general" | "ebay" {
  if (scored.listing.source === "ebay") return "ebay";
  if (scored.dealTier === "general" || !scored.extraction.matchedItem) return "general";
  return scored.referencePriceUsd !== null && scored.extraction.reasoning.startsWith("Recognised from the Database") ? "database" : "search";
}

/**
 * The resale evidence behind a scored listing. The scorer's reference price is the Database's value when there is one (so the
 * Database's evidence applies) and otherwise the reference the user typed for the Search For item. With no reference price at all
 * (an AI-only find) it is whatever the Database knows about the product the listing is about, if anything.
 */
export function resolveEvidence(scored: ScoredListing, source: SignalSource | null, now: number = Date.now(), identityTexts?: string[]): ValueEvidence | null {
  const { listing, extraction } = scored;
  let signals = null;
  try {
    signals = source?.getProductSignals(extraction.brokenVariant ?? extraction.matchedItem, listing.title, identityTexts) ?? null;
  } catch {
    signals = null;
  }
  const ref = scored.referencePriceUsd;
  if (ref !== null && ref > 0) {
    // The scorer used the Database's value: its evidence applies. Otherwise the reference is the user's own typed price.
    if (signals?.valueUsd && Math.abs(signals.valueUsd - ref) <= Math.max(1, ref * 0.01)) return evidenceFromSignals(signals, now);
    return userEvidence(ref);
  }
  return evidenceFromSignals(signals, now);
}

function gateOnce(args: QualifyArgs, evidence: ValueEvidence | null, scored: ScoredListing, identityUnconfirmed?: string[]): GateVerdict {
  const { listing, extraction } = scored;
  let unconfirmed: string[] = identityUnconfirmed ?? [];
  const ladder = args.ladderUnconfirmed ?? [];
  let unverified: string[] = [];
  let market: { runTimeDays: number | null; fbAvgPriceUsd: number | null; fbSample: number | null } | undefined;
  try {
    const signals = args.source?.getProductSignals(extraction.brokenVariant ?? extraction.matchedItem, listing.title, args.identityTexts) ?? null;
    const fb = signals && args.source && listing.source !== "ebay" ? args.source.getFacebookPriceStats(signals.id) : null;
    market = { runTimeDays: signals?.runTimeDays ?? null, fbAvgPriceUsd: fb?.avgPriceUsd ?? null, fbSample: fb?.sampleSize ?? null };
    // Only a Database value can be the wrong product's value; a reference price the user typed stands as typed.
    if (evidence && evidence.basis !== "user") {
      if (identityUnconfirmed === undefined) unconfirmed = signals?.unconfirmedCodes ?? [];
      unverified = signals?.unverifiedCodes ?? [];
    }
  } catch {
    market = undefined;
  }
  return qualifyListing({
    pathway: pathwayOf(scored),
    priceUsd: listing.price ?? 0,
    shippingUsd: listing.ebayShippingUsd ?? 0,
    conditionImpact: extraction.conditionImpact,
    conditionAdjust: args.conditionAdjust ?? null,
    broken: !!extraction.brokenVariant,
    evidence,
    identityUnconfirmed: unconfirmed,
    identityVague: ladder,
    identityUnverified: unverified,
    extras: args.extras ?? null,
    age: assessListingAge(listing.listingAge, args.maxAgeHours),
    aiFlagged: scored.isDeal && scored.referencePriceUsd === null,
    placeholderPrice: listing.price !== null && isSuspiciousPrice(listing.price),
    visionMismatch: args.visionMismatch,
    hardCapExceeded: args.hardCapExceeded,
    settings: args.settings,
    market,
  });
}

export async function qualifyScoredListing(args: QualifyArgs): Promise<Qualification> {
  let scored = args.scored;
  let evidence = resolveEvidence(scored, args.source, Date.now(), args.identityTexts);
  let credibleBefore: string[] = [];
  try {
    credibleBefore = args.source?.getProductSignals(scored.extraction.brokenVariant ?? scored.extraction.matchedItem, scored.listing.title, args.identityTexts)?.unconfirmedCodes ?? [];
  } catch {
    credibleBefore = [];
  }
  let verdict = gateOnce(args, evidence, scored);

  // Validate before trusting: refresh the numbers for anything that may be pushed.
  let market: MarketCheck | null = null;
  const wantsCheck = args.refreshMarket || verdict.qualified || (scored.isDeal && scored.referencePriceUsd === null);
  const hardStop = verdict.status === "pass" && verdict.reasons.some((r) => ["AGE_STALE", "PHOTO_MISMATCH", "HARD_CAP", "PLACEHOLDER_PRICE"].includes(r.code));
  if (wantsCheck && args.check && !hardStop) {
    const variant = scored.extraction.brokenVariant;
    try {
      market = (await args.check({ title: variant ?? scored.listing.title, matchedItem: variant ?? scored.extraction.matchedItem, identityTexts: args.identityTexts, listingId: scored.listing.id })) ?? null;
    } catch (err) {
      args.log(`Market check failed (${(err as Error).message}), using what the Database already knows.`);
    }
    if (market?.note) args.log(market.note);
    if (market && market.valueUsd !== null && market.valueUsd > 0) {
      let fresh: ValueEvidence | null = null;
      try {
        const name = market.productName ?? variant ?? scored.extraction.matchedItem;
        fresh = evidenceFromSignals(args.source?.getProductSignals(name, scored.listing.title, args.identityTexts) ?? null);
      } catch {
        fresh = null;
      }
      // The check found a number but the Database has no record to back it with a sample: the fresh value replaces the old one and
      // keeps the old evidence's basis (a reference the user typed stays "typed"; with nothing before it, it is thin).
      evidence = fresh && fresh.valueUsd ? fresh : { valueUsd: market.valueUsd, basis: evidence?.basis ?? "blend", sampleSize: evidence?.sampleSize ?? null, ageDays: 0 };
      const ref = evidence.valueUsd as number;
      scored = { ...scored, referencePriceUsd: ref, discountPercent: scored.listing.price !== null ? ((ref - scored.listing.price) / ref) * 100 : scored.discountPercent };
      // The check priced a product under its own name: if the listing states nothing more than that name does, the doubt is gone.
      const checkedName = market.productName;
      const checked = checkedName ? credibleBefore.filter((c) => codesMissingFrom(checkedName, c).length > 0) : undefined;
      verdict = gateOnce(args, evidence, scored, evidence.basis === "user" ? [] : checked);
    }
  }

  const qualified = verdict.qualified;
  const final: ScoredListing = {
    ...scored,
    isDeal: qualified,
    dealTier: qualified ? (scored.dealTier ?? "search") : null,
    gate: toGateSnapshot(verdict),
  };
  args.log(`Deal Quality Gate: ${verdict.status.replace(/_/g, " ")}${verdict.headline ? ` - ${verdict.headline}` : ""}`);
  return { scored: final, verdict, market };
}

/** The notification text for a qualified deal, a Watch match, or a worth-a-look find, built from the final verdict. */
export function buildQualifiedAlert(args: {
  q: Qualification;
  source: SignalSource | null;
  settings: ResaleSettings;
  kind: "deal" | "watch" | "look";
  watchName?: string;
}): AlertSummary {
  const { q, source, settings } = args;
  const base = buildAlertSummary(source, q.scored, {
    netPercent: settings.netPercent,
    minMarginPercent: settings.minMarginPercent,
    maxCutPercent: settings.maxCutPercent,
    marketValueUsd: q.market?.valueUsd ?? null,
  });
  if (args.kind === "watch") return composeWatchAlert({ summary: base, verdict: q.verdict, watchName: args.watchName ?? "Watch" });
  return composeGateAlert(base, q.verdict);
}
