// Phase 3 of the Beta 30 plan: "resolve before giving up". Pure logic for a listing whose identity is not settled: how sure Clynx is (settled / likely / vague, with the reason), whether
// resolving it can change the decision at all, the ladder of cheaper-to-dearer ways to find out (stopping at the first rung that is confident), and the budgets, cache and re-check rules that
// keep it from running forever. Rungs are supplied by the caller (the scanner wires real photo / OCR / search steps; tests wire fakes). Nothing here does I/O or sends anything to anyone.

export type Confidence = "settled" | "likely" | "vague";

/** One thing the listing could be, with what it would be worth. */
export interface Candidate {
  name: string;
  valueUsd: number | null;
}

export type RungId = "text_and_specifics" | "all_photos" | "labels_and_codes" | "image_search" | "line_research" | "seller_question";
/** Cheapest and most certain first. */
export const RUNGS: ReadonlyArray<RungId> = ["text_and_specifics", "all_photos", "labels_and_codes", "image_search", "line_research", "seller_question"];

export interface Identity {
  candidates: Candidate[];
  confidence: Confidence;
  /** Plain words for the "Vague" marker: what is missing. */
  missing: string[];
  /** Rungs already tried, with what each found, for "what was already tried". */
  tried: Array<{ rung: RungId; found: string }>;
}

export interface RungResult {
  /** The candidates still possible after this rung. */
  candidates: Candidate[];
  confidence: Confidence;
  found: string;
  missing?: string[];
}
export type Rung = (identity: Identity) => Promise<RungResult>;

export type Relevance = "deal_under_every_candidate" | "no_deal_under_any" | "differs" | "unknown";

/** Whether finding out what it is could change deal vs not-deal. A listing that is a deal under every candidate (or under none) is never researched further. */
export function decisionRelevance(askingUsd: number, candidates: ReadonlyArray<Candidate>, isDeal: (askingUsd: number, valueUsd: number) => boolean): Relevance {
  if (candidates.length === 0) return "unknown";
  if (candidates.some((c) => c.valueUsd === null)) return "unknown";
  const verdicts = candidates.map((c) => isDeal(askingUsd, c.valueUsd as number));
  if (verdicts.every(Boolean)) return "deal_under_every_candidate";
  if (verdicts.every((v) => !v)) return "no_deal_under_any";
  return "differs";
}

export interface LadderBudget {
  perListing: number;
  perDay: number;
}
export const DEFAULT_BUDGET: LadderBudget = { perListing: 4, perDay: 40 };

export interface LadderState {
  /** rung steps spent per listing and the day's total. */
  stepsToday: number;
  day: string;
  byListing: Map<string, { steps: number; identity: Identity; lastAt: number; evidenceKey: string }>;
}
export const newLadderState = (): LadderState => ({ stepsToday: 0, day: "", byListing: new Map() });

/** A longer wait before trying the same listing again without new evidence. */
export const RETRY_WAIT_MS = 6 * 3600_000;

export interface ResolveInput {
  listingId: string;
  askingUsd: number;
  start: Identity;
  /** A fingerprint of everything known about the listing (photo count, description, price): when it changes, there is new evidence and the listing may be looked at again. */
  evidenceKey: string;
  isDeal: (askingUsd: number, valueUsd: number) => boolean;
  rungs: Partial<Record<RungId, Rung>>;
  now?: number;
  budget?: LadderBudget;
}

export interface Resolution {
  identity: Identity;
  relevance: Relevance;
  /** Why the ladder stopped. */
  stop: "settled" | "not_relevant" | "budget_listing" | "budget_day" | "waiting" | "out_of_rungs" | "cached";
  stepsUsed: number;
  /** Alert allowed? Never for an identity that is not settled or likely-and-a-deal-under-every-candidate. */
  mayAlert: boolean;
  /** The price used for the decision: the lowest candidate's value until the identity is settled. */
  valueUsd: number | null;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function lowestValue(candidates: ReadonlyArray<Candidate>): number | null {
  const values = candidates.map((c) => c.valueUsd).filter((v): v is number => v !== null);
  return values.length ? Math.min(...values) : null;
}

export function finalize(identity: Identity, relevance: Relevance, stop: Resolution["stop"], stepsUsed: number): Resolution {
  const mayAlert = identity.confidence === "settled" || (relevance === "deal_under_every_candidate" && identity.confidence !== "vague");
  return { identity, relevance, stop, stepsUsed, mayAlert, valueUsd: identity.confidence === "settled" && identity.candidates.length === 1 ? identity.candidates[0].valueUsd : lowestValue(identity.candidates) };
}

export async function resolveIdentity(state: LadderState, input: ResolveInput): Promise<Resolution> {
  const now = input.now ?? Date.now();
  const budget = input.budget ?? DEFAULT_BUDGET;
  if (state.day !== dayOf(now)) {
    state.day = dayOf(now);
    state.stepsToday = 0;
  }
  const relevanceOf = (id: Identity) => decisionRelevance(input.askingUsd, id.candidates, input.isDeal);
  let identity = input.start;
  let relevance = relevanceOf(identity);
  if (identity.confidence === "settled") return finalize(identity, relevance, "settled", 0);
  if (relevance === "deal_under_every_candidate" || relevance === "no_deal_under_any") return finalize(identity, relevance, "not_relevant", 0);

  const cached = state.byListing.get(input.listingId);
  if (cached) {
    if (cached.evidenceKey === input.evidenceKey) {
      // nothing new: the cached answer stands, and the listing is not retried before the wait is over
      return finalize(cached.identity, relevanceOf(cached.identity), now - cached.lastAt < RETRY_WAIT_MS ? "waiting" : "cached", 0);
    }
    identity = cached.identity.confidence === "vague" ? input.start : cached.identity;
  }
  let steps = cached && cached.evidenceKey === input.evidenceKey ? cached.steps : 0;
  let used = 0;
  let stop: Resolution["stop"] = "out_of_rungs";
  for (const rungId of RUNGS) {
    const rung = input.rungs[rungId];
    if (!rung || identity.tried.some((t) => t.rung === rungId)) continue;
    if (steps >= budget.perListing) {
      stop = "budget_listing";
      break;
    }
    if (state.stepsToday >= budget.perDay) {
      stop = "budget_day";
      break;
    }
    steps++;
    used++;
    state.stepsToday++;
    const r = await rung(identity);
    identity = { candidates: r.candidates, confidence: r.confidence, missing: r.missing ?? [], tried: [...identity.tried, { rung: rungId, found: r.found }] };
    relevance = relevanceOf(identity);
    if (identity.confidence === "settled") {
      stop = "settled";
      break;
    }
    // it no longer matters what it is exactly: stop spending
    if (relevance === "deal_under_every_candidate" || relevance === "no_deal_under_any") {
      stop = "not_relevant";
      break;
    }
  }
  state.byListing.set(input.listingId, { steps, identity, lastAt: now, evidenceKey: input.evidenceKey });
  return finalize(identity, relevance, stop, used);
}

/** The plain-words marker for a listing or entry that is not settled: what is missing and what was already tried. Empty when settled. */
export function vagueMarker(identity: Identity): string {
  if (identity.confidence === "settled") return "";
  const tried = identity.tried.length ? ` Already tried: ${identity.tried.map((t) => t.found).join("; ")}.` : "";
  const missing = identity.missing.length ? `Missing: ${identity.missing.join(", ")}.` : "Not enough to tell which model it is.";
  return `${identity.confidence === "likely" ? "Likely, not certain." : "Vague."} ${missing}${tried}`.trim();
}
