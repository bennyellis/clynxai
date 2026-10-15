// Where each saved listing is in its life, so "Listings evaluated" can mean what it says (pure).
//
// The Dashboard used to show COUNT(*) of every saved row as "Listings evaluated": on a real database 64 of 329 had never been opened and 127 of the opened ones were rejected as too
// old straight after the page loaded. Every saved listing now falls into exactly ONE stage here (so the stages add up to the saved total), and the headline number is the listings
// that actually received a verdict backed by something other than a rule or a guess.
export type LifecycleStage =
  | "prefiltered" // skipped from the search card, never opened
  | "postfiltered" // opened, then ruled out by a rule (too old, Facebook shipping, eBay mention, scam bot, seller risk, hard cap, placeholder price)
  | "pending" // waiting for its photos / research
  | "profitable" // a deal (profitable now or a negotiation opportunity)
  | "unprofitable" // judged on real numbers (or a confident photo/identity check) and not worth it
  | "uncertain" // kept as worth a look, or judged only on Clynx's own estimate: missing evidence, not a verdict
  | "failed" // the research itself failed or was interrupted
  | "deferred"; // not looked at (allowance used, price too low, photos off, not in focus) and may be revisited

export interface LifecycleCounts {
  total: number;
  /** Stage -> count. Every saved listing is in exactly one stage. */
  stages: Record<LifecycleStage, number>;
  /** Opened pages (a detail page was read). */
  opened: number;
  /** Listings that got a real verdict: profitable + unprofitable. */
  fullyEvaluated: number;
}

const POST = new Set(["TOO_OLD", "OFFICIAL_SHIPPING", "MENTIONS_EBAY", "SCAM_BOT", "SELLER_RISK", "HARD_PRICE_CAP", "PLACEHOLDER_PRICE", "OVER_MAX_PRICE", "UNDER_MIN_PRICE"]);
const FAILED = new Set(["RESEARCH_FAILED", "PHOTO_ANALYSIS_FAILED", "AI_UNAVAILABLE", "TEXT_JUDGE_UNAVAILABLE", "INTERRUPTED"]);
const UNCERTAIN = new Set(["AI_UNVERIFIED", "WEAK_EVIDENCE", "IDENTITY_UNCONFIRMED", "IDENTITY_UNVERIFIED", "HIDDEN_GEM_UNVERIFIED", "AGE_UNKNOWN", "NO_RESALE_NUMBERS", "NAME_REFUSED", "PHOTOS_UNCLEAR", "IDENTITY_UNCLEAR", "AI_ESTIMATE", "NO_PHOTOS", "WORTH_A_LOOK"]);

export function lifecycleOf(status: string | null, code: string | null, isDeal: boolean, opened: boolean): LifecycleStage {
  if (isDeal || code === "DEAL" || code === "NEGOTIATION") return "profitable";
  if (code === "PHOTOS_QUEUED") return "pending";
  if (code && FAILED.has(code)) return "failed";
  if (status === "confirmed_unprofitable" || code === "UNPROFITABLE_AT_PRICE" || code === "PHOTOS_MISMATCH" || code === "GATE_PASS") return "unprofitable";
  if (code && POST.has(code)) return opened ? "postfiltered" : "prefiltered";
  if (code && UNCERTAIN.has(code)) return "uncertain";
  if (status === "insufficient_evidence") return "uncertain";
  if (!opened) return status === null ? "deferred" : "prefiltered";
  if (status === "unresearched") return "deferred";
  if (status === "rejected") return "postfiltered";
  return status === "researched" ? "uncertain" : "deferred";
}

export function countLifecycle(rows: Array<{ status: string | null; code: string | null; isDeal: boolean; opened: boolean; n: number }>): LifecycleCounts {
  const stages: Record<LifecycleStage, number> = { prefiltered: 0, postfiltered: 0, pending: 0, profitable: 0, unprofitable: 0, uncertain: 0, failed: 0, deferred: 0 };
  let total = 0;
  let opened = 0;
  for (const r of rows) {
    stages[lifecycleOf(r.status, r.code, r.isDeal, r.opened)] += r.n;
    total += r.n;
    if (r.opened) opened += r.n;
  }
  return { total, stages, opened, fullyEvaluated: stages.profitable + stages.unprofitable };
}
