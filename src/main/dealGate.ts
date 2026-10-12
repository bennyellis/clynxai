// The Deal Quality Gate: ONE pure function every recommended deal and every profit-based alert must pass.
//
// It takes the FINAL state of a scored listing (after vision, bundle and hidden-gem adjustments) plus how reliable the resale
// numbers are, and returns one of four statuses:
//
//   profitable_now  a good deal at the asking price (margin after eBay's cut >= the user's minimum)
//   negotiation     a good deal if the seller comes down: the verdict says how much (required discount, target price)
//   worth_a_look    interesting but NOT verified: unknown age, no/weak resale evidence, AI-only find, unverified extras.
//                   Visible in the Feed, never pushed by default
//   pass            not a deal: too old, a photo mismatch, over a hard price cap, or it needs more off than the user's limit
//
// "Qualified" = profitable_now or negotiation. Only qualified listings count as Deals (Feed, Dashboard) and trigger deal
// notifications. Weak evidence lowers CONFIDENCE rather than discarding a find: a rare product with few comparable sales is
// kept as worth_a_look, or stays qualified (at low confidence) when the gap between price and value is large.
//
// No I/O here: callers gather the evidence (store, market check) and persist/act on the verdict.
import { rateDeal, type ProductSignals } from "./dealSummary.js";
import { cutNeededPercent, withinNegotiationReach } from "./profitGate.js";
import type { AgeAssessment } from "./listingAge.js";
import { CONDITION_VALUE_FACTOR, maxBuyPriceUsd, resaleOutcome, type ResaleSettings } from "./resaleMath.js";
import type { DealStatus, GateSnapshot } from "./types.js";

export type { DealStatus };
export type EvidenceLevel = "strong" | "moderate" | "weak" | "none";
export type Confidence = "high" | "medium" | "low";

export const QUALIFIED_STATUSES: readonly DealStatus[] = ["profitable_now", "negotiation"];
export function isQualifiedStatus(status: DealStatus | null | undefined): boolean {
  return status === "profitable_now" || status === "negotiation";
}

// ---------- how reliable is the resale value?

export interface ValueEvidence {
  valueUsd: number | null;
  // sold: WatchCount sold comps. blend: sold nudged by asking prices. active: asking prices only. user: a reference price the
  // user (or the assistant on their behalf) typed in.
  basis: "sold" | "blend" | "active" | "user" | null;
  // How many sold comps stand behind the value (null: not applicable or unknown).
  sampleSize: number | null;
  // How old the comps are, in days (null: unknown).
  ageDays: number | null;
}

export const EVIDENCE_RULES = {
  strongSamples: 5,
  moderateSamples: 3,
  // Comps older than this lose a level once they are past staleDays, and cannot be "strong" past freshDays.
  freshDays: 30,
  staleDays: 90,
  // With only weak evidence a listing can still qualify if the margin at the asking price is at least this many times the
  // minimum margin (a big gap is what an undervalued or rare find looks like); otherwise it is worth_a_look.
  weakEvidenceMarginMultiple: 2,
} as const;

const LEVELS: EvidenceLevel[] = ["none", "weak", "moderate", "strong"];
function lower(level: EvidenceLevel): EvidenceLevel {
  return LEVELS[Math.max(0, LEVELS.indexOf(level) - 1)];
}

export function evidenceLevel(e: ValueEvidence | null | undefined): EvidenceLevel {
  if (!e || e.valueUsd === null || !(e.valueUsd > 0)) return "none";
  if (e.basis === "user") return "moderate";
  if (e.basis === "active") return "weak";
  const samples = e.sampleSize ?? 0;
  let level: EvidenceLevel = samples >= EVIDENCE_RULES.strongSamples ? "strong" : samples >= EVIDENCE_RULES.moderateSamples ? "moderate" : "weak";
  if (e.ageDays !== null) {
    if (e.ageDays > EVIDENCE_RULES.staleDays) level = lower(level);
    else if (e.ageDays > EVIDENCE_RULES.freshDays && level === "strong") level = "moderate";
  }
  return level;
}

/** Evidence from what the Database knows about a product (see store.getProductSignals). */
export function evidenceFromSignals(signals: ProductSignals | null | undefined, now: number = Date.now()): ValueEvidence | null {
  if (!signals || signals.valueUsd === null || !(signals.valueUsd > 0)) return null;
  return {
    valueUsd: signals.valueUsd,
    basis: signals.basis ?? (signals.compSample ? "sold" : null),
    sampleSize: signals.compSample ?? null,
    ageDays: signals.checkedAt ? Math.max(0, (now - signals.checkedAt) / 86_400_000) : null,
  };
}

/** Evidence from a reference price the user typed for a Search For item. */
export function userEvidence(valueUsd: number | null | undefined): ValueEvidence | null {
  return valueUsd && valueUsd > 0 ? { valueUsd, basis: "user", sampleSize: null, ageDays: null } : null;
}

// ---------- the gate

export interface GateExtras {
  // What the extras add to the lot's value and that the gate may count: corroborated (named in the listing text, or priced
  // item by item) and capped by the caller.
  countedUsd: number;
  // What more the extras might add that is NOT corroborated (a photo-only guess, an estimated price). Never counted toward a
  // deal; if counting it would have made the listing qualify, it becomes worth_a_look ("possible hidden gem").
  uncountedUsd: number;
}

export interface GateInput {
  pathway: "search" | "database" | "general" | "ebay";
  priceUsd: number;
  shippingUsd?: number;
  conditionImpact: "none" | "minor" | "major" | "unknown";
  // A broken / for-parts copy priced from its own Database variant (no further condition discount).
  broken?: boolean;
  evidence: ValueEvidence | null;
  extras?: GateExtras | null;
  age: AgeAssessment;
  // The model (not the arithmetic) called this a deal: used to explain an unverified AI find.
  aiFlagged?: boolean;
  // Hard stops decided elsewhere.
  placeholderPrice?: boolean;
  visionMismatch?: boolean;
  hardCapExceeded?: boolean;
  settings: ResaleSettings;
  // Optional context for the star rating.
  market?: { runTimeDays?: number | null; fbAvgPriceUsd?: number | null; fbSample?: number | null };
}

export type GateReasonCode =
  | "PLACEHOLDER_PRICE"
  | "AGE_STALE"
  | "AGE_UNKNOWN"
  | "PHOTO_MISMATCH"
  | "HARD_CAP"
  | "NO_EVIDENCE"
  | "AI_UNVERIFIED"
  | "WEAK_EVIDENCE"
  | "RARE_FIND"
  | "MARGIN_OK"
  | "NEEDS_DISCOUNT"
  | "UNREACHABLE"
  | "HIDDEN_GEM"
  | "HIDDEN_GEM_UNVERIFIED";

export interface GateReason {
  code: GateReasonCode;
  // good: counts in its favor. warn: held it back to worth_a_look / lowered confidence. bad: ruled it out. info: context.
  severity: "good" | "warn" | "bad" | "info";
  text: string;
}

export interface GateFacts {
  valueUsd: number | null;
  lotValueUsd: number | null;
  evidenceLevel: EvidenceLevel;
  basis: ValueEvidence["basis"];
  sampleSize: number | null;
  ageState: AgeAssessment["state"];
  ageHours: number | null;
  profitAtAskUsd: number | null;
  marginAtAskPercent: number | null;
  // negotiation only: how far below the asking price, and the price to offer.
  requiredDiscountPercent: number | null;
  targetPriceUsd: number | null;
  profitAtTargetUsd: number | null;
  extrasCountedUsd: number;
}

export interface GateVerdict {
  status: DealStatus;
  qualified: boolean;
  confidence: Confidence;
  stars: number | null;
  headline: string;
  reasons: GateReason[];
  facts: GateFacts;
}

/** The part of a verdict that is saved with the listing (what the Feed, Dashboard and notifications read back). */
export function toGateSnapshot(v: GateVerdict): GateSnapshot {
  return {
    status: v.status,
    confidence: v.confidence,
    stars: v.stars,
    headline: v.headline,
    reasons: v.reasons.map((r) => ({ code: r.code, severity: r.severity, text: r.text })),
    requiredDiscountPercent: v.facts.requiredDiscountPercent,
    targetPriceUsd: v.facts.targetPriceUsd,
  };
}

const money = (n: number) => `$${Math.round(n)}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function emptyFacts(level: EvidenceLevel, input: GateInput): GateFacts {
  return {
    valueUsd: input.evidence?.valueUsd ?? null,
    lotValueUsd: null,
    evidenceLevel: level,
    basis: input.evidence?.basis ?? null,
    sampleSize: input.evidence?.sampleSize ?? null,
    ageState: input.age.state,
    ageHours: input.age.hours,
    profitAtAskUsd: null,
    marginAtAskPercent: null,
    requiredDiscountPercent: null,
    targetPriceUsd: null,
    profitAtTargetUsd: null,
    extrasCountedUsd: 0,
  };
}

function confidenceFor(level: EvidenceLevel): Confidence {
  return level === "strong" ? "high" : level === "moderate" ? "medium" : "low";
}

function verdict(status: DealStatus, level: EvidenceLevel, facts: GateFacts, reasons: GateReason[], headline: string, stars: number | null, confidence?: Confidence): GateVerdict {
  return { status, qualified: isQualifiedStatus(status), confidence: confidence ?? confidenceFor(level), stars, headline, reasons, facts };
}

export function qualifyListing(input: GateInput): GateVerdict {
  const level = evidenceLevel(input.evidence);
  const facts = emptyFacts(level, input);
  const reasons: GateReason[] = [];
  const settings = input.settings;
  const shipping = Math.max(0, input.shippingUsd ?? 0);

  // ---- hard stops
  if (input.placeholderPrice || !(input.priceUsd > 0)) {
    reasons.push({ code: "PLACEHOLDER_PRICE", severity: "bad", text: `$${input.priceUsd} looks like a placeholder price, not a real one.` });
    return verdict("pass", level, facts, reasons, reasons[0].text, null);
  }
  if (input.age.state === "stale") {
    reasons.push({ code: "AGE_STALE", severity: "bad", text: `Listed ${input.age.text ?? "a while ago"}, older than your freshness window.` });
    return verdict("pass", level, facts, reasons, reasons[0].text, null);
  }
  if (input.visionMismatch) {
    reasons.push({ code: "PHOTO_MISMATCH", severity: "bad", text: "The photos show something different from what the listing claims." });
    return verdict("pass", level, facts, reasons, reasons[0].text, null);
  }
  if (input.hardCapExceeded) {
    reasons.push({ code: "HARD_CAP", severity: "bad", text: "Priced above the hard price cap you set for this product." });
    return verdict("pass", level, facts, reasons, reasons[0].text, null);
  }

  // ---- no reliable resale value at all: cannot be a verified deal. Kept visible (an AI-only find is worth a look).
  if (level === "none" || !input.evidence || input.evidence.valueUsd === null) {
    const text = input.aiFlagged
      ? "Clynx's own read says this looks cheap, but there are no resale numbers yet to confirm it."
      : "No resale numbers to judge this price against yet.";
    reasons.push({ code: input.aiFlagged ? "AI_UNVERIFIED" : "NO_EVIDENCE", severity: "warn", text });
    if (input.age.state === "unknown") reasons.push({ code: "AGE_UNKNOWN", severity: "warn", text: "The listing's age couldn't be read." });
    return verdict("worth_a_look", level, facts, reasons, text, null, "low");
  }

  // ---- the arithmetic: the user's own margin and negotiation settings, on the lot's value
  const factor = input.broken ? 1 : CONDITION_VALUE_FACTOR[input.conditionImpact] ?? 1;
  const baseValue = input.evidence.valueUsd * factor;
  const counted = Math.max(0, input.extras?.countedUsd ?? 0);
  const uncounted = Math.max(0, input.extras?.uncountedUsd ?? 0);
  const lot = baseValue + counted;
  const outcome = resaleOutcome(lot, input.priceUsd + shipping, settings.netPercent);
  facts.lotValueUsd = Math.round(lot);
  facts.profitAtAskUsd = Math.round(outcome.profitUsd);
  facts.marginAtAskPercent = Math.round(outcome.marginPercent * 10) / 10;
  facts.extrasCountedUsd = Math.round(counted);

  const profitableNow = outcome.profitUsd > 0 && outcome.marginPercent >= settings.minMarginPercent;
  const reachable = withinNegotiationReach(lot, input.priceUsd, shipping, settings);
  let base: "profitable_now" | "negotiation" | "pass" = profitableNow ? "profitable_now" : reachable ? "negotiation" : "pass";

  // A target price (what to offer) for a negotiation: the most that still earns the minimum margin, never above the ask.
  let target: number | null = null;
  if (base === "negotiation") {
    const t = maxBuyPriceUsd(lot, shipping, settings);
    target = t > 0 && t < input.priceUsd ? t : null;
    if (target === null) base = "pass"; // reachable only by an offer too small to name: treat as out of reach
  }

  if (base === "pass") {
    const cut = cutNeededPercent(lot, input.priceUsd, shipping, settings);
    // A lot that WOULD work if the unverified extras were real is a possible hidden gem, not a pass.
    if (uncounted > 0) {
      const lot2 = lot + uncounted;
      const out2 = resaleOutcome(lot2, input.priceUsd + shipping, settings.netPercent);
      const works = (out2.profitUsd > 0 && out2.marginPercent >= settings.minMarginPercent) || withinNegotiationReach(lot2, input.priceUsd, shipping, settings);
      if (works) {
        reasons.push({ code: "HIDDEN_GEM_UNVERIFIED", severity: "warn", text: `Possible hidden gem: it only works if the extras (worth an unverified ~${money(uncounted)}) really come with it.` });
        return verdict("worth_a_look", level, facts, reasons, reasons[0].text, null, "low");
      }
    }
    reasons.push({
      code: "UNREACHABLE",
      severity: "bad",
      text: outcome.profitUsd <= 0 ? `At ${money(input.priceUsd)} it loses about ${money(-outcome.profitUsd)} after eBay's cut (worth about ${money(lot)}).` : `It would need about ${cut}% off the asking price to hit your minimum margin (your limit is ${settings.maxCutPercent ?? 15}%).`,
    });
    return verdict("pass", level, facts, reasons, reasons[0].text, null);
  }

  // ---- it would qualify on the numbers; now evidence and age decide how far to trust that
  let confidence = confidenceFor(level);
  if (counted > 0) reasons.push({ code: "HIDDEN_GEM", severity: "good", text: `The lot is worth about ${money(lot)} with the extras that come with it (+${money(counted)}).` });

  const wantsMargin = settings.minMarginPercent;
  const bigGap = outcome.marginPercent >= wantsMargin * EVIDENCE_RULES.weakEvidenceMarginMultiple && outcome.profitUsd > 0;
  if (level === "weak") {
    const why =
      input.evidence.basis === "active"
        ? "That value comes from asking prices only: nothing has confirmed what it actually sells for."
        : `Only ${plural(input.evidence.sampleSize ?? 0, "sale")} to go on${input.evidence.ageDays !== null && input.evidence.ageDays > EVIDENCE_RULES.staleDays ? ", and they are old" : ""}.`;
    if (base === "profitable_now" && bigGap) {
      // Scarce comparables on a big price gap is exactly what a rare or undervalued product looks like: keep it, at low confidence.
      reasons.push({ code: "RARE_FIND", severity: "warn", text: `${why} The gap is large, so it stays a deal, at low confidence.` });
      confidence = "low";
    } else {
      reasons.push({ code: "WEAK_EVIDENCE", severity: "warn", text: why });
      return verdict("worth_a_look", level, facts, reasons, why, null, "low");
    }
  }

  if (input.age.state === "unknown") {
    const text = "The listing's age couldn't be read, so it can't be confirmed as fresh.";
    reasons.push({ code: "AGE_UNKNOWN", severity: "warn", text });
    return verdict("worth_a_look", level, facts, reasons, text, null, confidence === "high" ? "medium" : confidence);
  }

  // ---- qualified: stars and wording
  const ratingBase = {
    shippingUsd: shipping,
    valueUsd: input.evidence.valueUsd,
    netPercent: settings.netPercent,
    minMarginPercent: settings.minMarginPercent,
    maxCutPercent: settings.maxCutPercent,
    broken: !!input.broken,
    extrasUsd: counted,
    conditionImpact: input.broken ? ("none" as const) : input.conditionImpact,
    runTimeDays: input.market?.runTimeDays ?? null,
    compSample: input.evidence.sampleSize,
    fbAvgPriceUsd: input.market?.fbAvgPriceUsd ?? null,
    fbSample: input.market?.fbSample ?? null,
  };

  if (base === "profitable_now") {
    const rated = rateDeal({ ...ratingBase, priceUsd: input.priceUsd });
    reasons.push({ code: "MARGIN_OK", severity: "good", text: `About ${money(outcome.profitUsd)} profit after eBay's cut (${Math.round(outcome.marginPercent)}% margin at the asking price).` });
    const stars = Math.min(rated.stars, confidence === "low" ? 3 : 5);
    return verdict("profitable_now", level, facts, reasons, rated.reason, stars, confidence);
  }

  // negotiation
  const targetPrice = target as number;
  const discount = Math.round(((input.priceUsd - targetPrice) / input.priceUsd) * 100);
  const atTarget = resaleOutcome(lot, targetPrice + shipping, settings.netPercent);
  facts.requiredDiscountPercent = discount;
  facts.targetPriceUsd = targetPrice;
  facts.profitAtTargetUsd = Math.round(atTarget.profitUsd);
  reasons.push({
    code: "NEEDS_DISCOUNT",
    severity: "warn",
    text: `Needs ${discount}% off the asking price: offer about ${money(targetPrice)} (asking ${money(input.priceUsd)}) to clear your ${settings.minMarginPercent}% margin.`,
  });
  const ratedAtTarget = rateDeal({ ...ratingBase, priceUsd: targetPrice });
  // Contingent on the seller agreeing, so it never rates above three stars.
  const stars = Math.min(ratedAtTarget.stars, 3);
  return verdict("negotiation", level, facts, reasons, `Offer ~${money(targetPrice)} (${discount}% off): about ${money(atTarget.profitUsd)} profit`, stars, confidence);
}
