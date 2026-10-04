// Centralized plan/entitlements definitions — Phase 9 foundation.
//
// The point of this module is to give the rest of the app ONE place to ask
// "what is this plan allowed to do" instead of scattering
// `if (user.plan === "pro")` checks throughout routes as paid features get
// added later. Nothing calls `getEntitlementsForPlan` yet outside of
// GET /me/entitlements (see ./routes.ts) — existing routes (watches,
// devices, products, feedback, listings) do not consult this module and
// their behavior is unchanged by its existence.

export type Plan = "free" | "pro";

/**
 * Per-plan limits and feature flags.
 *
 * Convention: for numeric limit fields, `null` means "unlimited". We use
 * `null` rather than `Infinity` because these values round-trip through
 * JSON (the /me/entitlements response, and eventually request/response
 * bodies elsewhere) — `Infinity` silently becomes `null` under
 * `JSON.stringify`, so using `null` as the actual unlimited sentinel keeps
 * the in-memory type and the wire format identical instead of having one
 * silently decay into the other.
 */
export interface Entitlements {
  /** Max number of Watches a user may have synced at once. */
  maxWatches: number | null;
  /** Max number of devices a user may register. */
  maxDevices: number | null;
  /**
   * Max number of "Search For" items per watch. Not cloud-synced yet
   * (desktop-only today), but the limit is defined here now so the
   * eventual sync work doesn't have to retrofit an entitlements concept.
   */
  maxSearchItems: number | null;
  /** Whether AI-assisted research (e.g. web research / vision scoring) is enabled for this plan. */
  aiResearchEnabled: boolean;
}

// Placeholder limits — exact numbers don't matter yet since nothing
// enforces them. What matters is the shape being centralized and sensible.
const ENTITLEMENTS_BY_PLAN: Record<Plan, Entitlements> = {
  free: {
    maxWatches: 5,
    maxDevices: 2,
    maxSearchItems: 10,
    aiResearchEnabled: false,
  },
  pro: {
    maxWatches: null,
    maxDevices: null,
    maxSearchItems: null,
    aiResearchEnabled: true,
  },
};

/**
 * Pure function: given a plan, returns its entitlements. Returns a shallow
 * copy so callers can't mutate the shared plan definitions.
 */
export function getEntitlementsForPlan(plan: Plan): Entitlements {
  const entitlements = ENTITLEMENTS_BY_PLAN[plan];
  return { ...entitlements };
}
