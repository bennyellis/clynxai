// Centralized plan/entitlements definitions. ONE place to ask "what is this plan allowed to do" (routes call getEntitlementsForPlan / the helpers in ./enforce.ts instead of
// scattering `if (user.plan === "pro")`). Numeric limits: `null` means unlimited (it survives JSON, unlike Infinity).
//
// The limits are ENFORCED only when ENFORCE_ENTITLEMENTS=true (staged activation: with the default of false nothing a user could do yesterday is refused today). See ./enforce.ts.

export type Plan = "free" | "pro";

export interface Entitlements {
  /** Max number of Watches a user may have synced at once. */
  maxWatches: number | null;
  /** Max number of devices a user may register. */
  maxDevices: number | null;
  /** Max number of "Search For" items per watch (desktop-only today; defined here so a later sync does not have to retrofit it). */
  maxSearchItems: number | null;
  /** Whether AI-assisted research (web research, vision scoring, chat) is enabled for this plan. */
  aiResearchEnabled: boolean;
  /** AI requests (chat, scoring, vision) a user may make per UTC day through the shared proxy. */
  aiRequestsPerDay: number | null;
  /** Image generations per UTC day. */
  aiImagesPerDay: number | null;
}

const ENTITLEMENTS_BY_PLAN: Record<Plan, Entitlements> = {
  free: { maxWatches: 5, maxDevices: 2, maxSearchItems: 10, aiResearchEnabled: true, aiRequestsPerDay: 150, aiImagesPerDay: 10 },
  pro: { maxWatches: null, maxDevices: null, maxSearchItems: null, aiResearchEnabled: true, aiRequestsPerDay: 3000, aiImagesPerDay: 100 },
};

/** The Owner has every feature, with no count limits and no daily request quota. (Infrastructure safety limits - spending caps, concurrency, rate limits - still apply to the Owner; see ../integrations/controls.ts.) */
export function getOwnerEntitlements(): Entitlements {
  return { maxWatches: null, maxDevices: null, maxSearchItems: null, aiResearchEnabled: true, aiRequestsPerDay: null, aiImagesPerDay: null };
}

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pro";
}

/** Pure function: given a plan, returns its entitlements (a copy, so callers cannot mutate the shared definitions). */
export function getEntitlementsForPlan(plan: Plan): Entitlements {
  return { ...ENTITLEMENTS_BY_PLAN[plan] };
}

export const PLAN_ORDER: Plan[] = ["free", "pro"];
export function higherPlan(a: Plan, b: Plan): Plan {
  return PLAN_ORDER.indexOf(a) >= PLAN_ORDER.indexOf(b) ? a : b;
}
