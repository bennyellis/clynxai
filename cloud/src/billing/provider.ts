import { createHmac, timingSafeEqual } from "node:crypto";

// The billing provider boundary. Everything else in the app talks to this interface, so tests use a fake and the real adapter (Stripe, below) can be swapped or extended.

export interface CheckoutRequest {
  userId: string;
  email: string;
  priceId: string;
  trialDays: number;
  successUrl: string;
  cancelUrl: string;
  customerId: string | null;
}
export interface ProviderEvent {
  id: string;
  type: string;
  /** The provider's event time, seconds since the epoch. */
  created: number;
  object: Record<string, unknown>;
}
export interface BillingProvider {
  readonly name: string;
  createCheckoutSession(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  /** Cancels a subscription immediately (used when an account is deleted, so nobody keeps being charged). */
  cancelSubscription(subscriptionId: string): Promise<void>;
  /** Verifies the signature of a webhook delivery over the RAW body and returns the parsed event, or null when it is not authentic. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSeconds?: number): ProviderEvent | null;
}

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Stripe's webhook signature scheme: the header carries `t=<unix seconds>` and one or more `v1=<hex hmac-sha256>` of `"<t>.<raw body>"` with the endpoint secret. Valid when any v1
 * matches (compared in constant time) and t is within the tolerance (replay protection).
 */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string, nowSeconds: number, toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): boolean {
  if (!header || !secret) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") sigs.push(v);
  }
  if (t === null || !Number.isFinite(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Signs a payload the way Stripe does (used by tests and by the local webhook simulator). */
export function signStripePayload(rawBody: Buffer | string, secret: string, t: number): string {
  const sig = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  return `t=${t},v1=${sig}`;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
}

export class StripeProvider implements BillingProvider {
  readonly name = "stripe";
  constructor(private cfg: StripeConfig, private fetchFn: typeof fetch = fetch) {}

  private async post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = (data.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      throw new Error(`Stripe request failed: ${msg}`);
    }
    return data;
  }

  async createCheckoutSession(req: CheckoutRequest): Promise<{ id: string; url: string }> {
    const form: Record<string, string> = {
      mode: "subscription",
      "line_items[0][price]": req.priceId,
      "line_items[0][quantity]": "1",
      client_reference_id: req.userId,
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      allow_promotion_codes: "true",
      "subscription_data[metadata][user_id]": req.userId,
    };
    if (req.customerId) form.customer = req.customerId;
    else form.customer_email = req.email;
    if (req.trialDays > 0) form["subscription_data[trial_period_days]"] = String(req.trialDays);
    const data = await this.post("checkout/sessions", form);
    if (typeof data.url !== "string" || typeof data.id !== "string") throw new Error("Stripe returned no checkout URL");
    return { id: data.id, url: data.url };
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const data = await this.post("billing_portal/sessions", { customer: customerId, return_url: returnUrl });
    if (typeof data.url !== "string") throw new Error("Stripe returned no portal URL");
    return { url: data.url };
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    const res = await this.fetchFn(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.cfg.secretKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Stripe cancel failed: HTTP ${res.status}`);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): ProviderEvent | null {
    if (!verifyStripeSignature(rawBody, signatureHeader, this.cfg.webhookSecret, nowSeconds)) return null;
    try {
      const e = JSON.parse(rawBody.toString("utf8")) as { id?: unknown; type?: unknown; created?: unknown; data?: { object?: unknown } };
      if (typeof e.id !== "string" || typeof e.type !== "string" || typeof e.created !== "number") return null;
      return { id: e.id, type: e.type, created: e.created, object: (e.data?.object ?? {}) as Record<string, unknown> };
    } catch {
      return null;
    }
  }
}
