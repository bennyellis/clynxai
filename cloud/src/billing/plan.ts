// What plan a subscription row entitles a user to RIGHT NOW. Pure and time-based: a lapsed grace period or an expired period takes effect without any background job, and a
// webhook that never arrived cannot leave someone on a paid plan forever (a subscription whose period ended more than STALE_SLACK ago, with no newer event, is treated as lapsed).
import type { Plan } from "../entitlements/plans.js";

export interface SubscriptionState {
  status: string;
  current_period_end: Date | null;
  trial_end: Date | null;
  past_due_since: Date | null;
  cancel_at_period_end: boolean;
}

export type SubscriptionPhase = "none" | "trialing" | "active" | "canceling" | "past_due_grace" | "past_due_lapsed" | "canceled" | "ended" | "incomplete";

const DAY = 86_400_000;
export const STALE_SLACK_MS = 3 * DAY;

export interface Resolution {
  plan: Plan;
  phase: SubscriptionPhase;
  /** When a past-due account loses the paid plan unless payment succeeds. */
  graceEndsAt: Date | null;
}

export function resolveSubscription(sub: SubscriptionState | null, now: Date, graceDays: number): Resolution {
  if (!sub) return { plan: "free", phase: "none", graceEndsAt: null };
  const t = now.getTime();
  const periodEnd = sub.current_period_end?.getTime() ?? null;
  const stale = periodEnd !== null && t > periodEnd + STALE_SLACK_MS;
  switch (sub.status) {
    case "trialing":
      return stale ? { plan: "free", phase: "ended", graceEndsAt: null } : { plan: "pro", phase: "trialing", graceEndsAt: null };
    case "active":
      if (stale) return { plan: "free", phase: "ended", graceEndsAt: null };
      return { plan: "pro", phase: sub.cancel_at_period_end ? "canceling" : "active", graceEndsAt: null };
    case "past_due": {
      const since = sub.past_due_since?.getTime() ?? t;
      const ends = new Date(since + graceDays * DAY);
      return t < ends.getTime() ? { plan: "pro", phase: "past_due_grace", graceEndsAt: ends } : { plan: "free", phase: "past_due_lapsed", graceEndsAt: ends };
    }
    case "incomplete":
      return { plan: "free", phase: "incomplete", graceEndsAt: null };
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
    case "paused":
      return { plan: "free", phase: "canceled", graceEndsAt: null };
    default:
      return { plan: "free", phase: "ended", graceEndsAt: null };
  }
}
