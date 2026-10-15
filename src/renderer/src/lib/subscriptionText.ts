import type { BillingStatus } from "../../../main/types.js";

export const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "");

export function describeSubscription(b: BillingStatus): { headline: string; detail: string; tone: "ok" | "warn" | "plain" } {
  if (b.owner === true) return { headline: "Owner — Full Access", detail: "Every feature, with no subscription or plan limits. Safety limits that protect the shared service (rate limits and the daily spending cap) still apply.", tone: "ok" };
  // A beta tester: an ordinary account with the plan limits lifted by the operator.
  if (b.plan === "tester") return { headline: "Beta Tester — Unlimited access", detail: "Plan limits are lifted for beta testers. Safety limits that protect the shared service (rate limits and a daily spending cap) still apply.", tone: "ok" };
  const s = b.subscription;
  const planName = b.plan === "pro" ? "Clynx Pro" : "Free";
  if (!s) return { headline: planName, detail: b.plan === "pro" ? "Pro is included with your account." : "No subscription.", tone: "plain" };
  switch (s.phase) {
    case "trialing":
      if (s.cancelAtPeriodEnd) return { headline: "Clynx Pro — free trial", detail: s.trialEnd ? `Your trial ends ${dateText(s.trialEnd)} and you will not be charged: cancellation is scheduled.` : "Your trial will end without a charge: cancellation is scheduled.", tone: "warn" };
      return { headline: "Clynx Pro — free trial", detail: s.trialEnd ? `Your trial ends ${dateText(s.trialEnd)}. You will be charged then unless you cancel.` : "You are on a free trial.", tone: "ok" };
    case "active":
      return { headline: "Clynx Pro", detail: s.currentPeriodEnd ? `Renews ${dateText(s.currentPeriodEnd)}.` : "Active.", tone: "ok" };
    case "canceling":
      return { headline: "Clynx Pro — cancellation scheduled", detail: s.currentPeriodEnd ? `Pro stays until ${dateText(s.currentPeriodEnd)}, then your account returns to Free.` : "Pro ends at the end of this period.", tone: "warn" };
    case "past_due_grace":
      return { headline: "Clynx Pro — payment problem", detail: `Your last payment failed. Update your card${s.graceEndsAt ? ` before ${dateText(s.graceEndsAt)}` : ""} to keep Pro.`, tone: "warn" };
    case "past_due_lapsed":
      return { headline: "Free — Pro ended", detail: "Your payment failed and the grace period has passed. Update your card to get Pro back.", tone: "warn" };
    case "canceled":
    case "ended":
      return { headline: planName, detail: "Your subscription has ended.", tone: "plain" };
    case "incomplete":
      return { headline: planName, detail: "Your checkout was not completed.", tone: "plain" };
    default:
      return { headline: planName, detail: "", tone: "plain" };
  }
}

