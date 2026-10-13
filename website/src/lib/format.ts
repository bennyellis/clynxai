export function formatBytes(n: number | null | undefined): string {
  if (!n || n < 0) return "-";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "unlimited" for null, otherwise the number. */
export const limitText = (n: number | null | undefined): string => (n === null || n === undefined ? "Unlimited" : n.toLocaleString());

export interface SubscriptionView {
  status: string;
  phase: string;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: string | null;
}

/** Plain-language subscription state for the account page (mirrors what the desktop app says). */
export function describeSubscription(plan: "free" | "pro", s: SubscriptionView | null, interval: string | null): { headline: string; detail: string; tone: "ok" | "warn" | "plain" } {
  const name = plan === "pro" ? "Clynx Pro" : "Free";
  const every = interval === "year" ? " (billed yearly)" : interval === "month" ? " (billed monthly)" : "";
  if (!s) return { headline: name, detail: plan === "pro" ? "Pro is included with your account." : "You are on the free plan.", tone: "plain" };
  switch (s.phase) {
    case "trialing":
      return s.cancelAtPeriodEnd
        ? { headline: `Clynx Pro - free trial${every}`, detail: `Your trial ends ${formatDate(s.trialEnd)} and you will NOT be charged: cancellation is scheduled.`, tone: "warn" }
        : { headline: `Clynx Pro - free trial${every}`, detail: `Your trial ends ${formatDate(s.trialEnd)}. You will be charged then unless you cancel first.`, tone: "ok" };
    case "active":
      return { headline: `Clynx Pro${every}`, detail: s.currentPeriodEnd ? `Renews ${formatDate(s.currentPeriodEnd)}.` : "Active.", tone: "ok" };
    case "canceling":
      return { headline: `Clynx Pro${every} - cancellation scheduled`, detail: `Pro stays until ${formatDate(s.currentPeriodEnd)}, then your account returns to Free. You can resume until then.`, tone: "warn" };
    case "past_due_grace":
      return { headline: "Clynx Pro - payment problem", detail: `Your last payment failed. Update your payment method${s.graceEndsAt ? ` before ${formatDate(s.graceEndsAt)}` : ""} to keep Pro.`, tone: "warn" };
    case "past_due_lapsed":
      return { headline: "Free - Pro ended", detail: "Your payment failed and the grace period has passed. Update your payment method to get Pro back.", tone: "warn" };
    case "canceled":
    case "ended":
      return { headline: name, detail: "Your subscription has ended.", tone: "plain" };
    case "incomplete":
      return { headline: name, detail: "Your checkout was not completed.", tone: "plain" };
    default:
      return { headline: name, detail: "", tone: "plain" };
  }
}

/** Copies text; resolves false when the browser refuses. */
export async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}
