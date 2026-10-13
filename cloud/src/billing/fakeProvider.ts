import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { type BillingProvider, type CheckoutRequest, type ProviderEvent, signStripePayload, verifyStripeSignature } from "./provider.js";
import { applyBillingEvent } from "./service.js";

// DEVELOPMENT ONLY - a local stand-in for Stripe so the whole customer flow (checkout, upgrade, downgrade, cancel, failed payment) can be tried without any Stripe account.
// It is switched on only by BILLING_FAKE=true and is refused when NODE_ENV=production. Everything it does goes through the REAL path: its events are signed with Stripe's
// signature scheme, verified by the same verifyWebhook code, and applied by the same applyBillingEvent that real Stripe events use. No card, no money, no network.

export const FAKE_WEBHOOK_SECRET = "whsec_local_fake_provider_secret";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export class FakeStripe implements BillingProvider {
  readonly name = "fake-local";
  private sessions = new Map<string, CheckoutRequest>();
  private lastCreated = 0;

  async createCheckoutSession(req: CheckoutRequest) {
    const id = `cs_fake_${randomBytes(8).toString("hex")}`;
    this.sessions.set(id, req);
    return { id, url: `${config.web.publicUrl}/dev/billing/checkout/${id}` };
  }
  async createPortalSession(customerId: string) {
    return { url: `${config.web.publicUrl}/dev/billing/portal/${encodeURIComponent(customerId)}` };
  }
  async cancelSubscription(subscriptionId: string) {
    const row = await this.rowBySubscription(subscriptionId);
    if (row) await this.emit("customer.subscription.deleted", this.subObject(row, { status: "canceled" }));
  }
  async changePrice(subscriptionId: string, priceId: string) {
    const row = await this.rowBySubscription(subscriptionId);
    if (row) await this.emit("customer.subscription.updated", this.subObject(row, { priceId, cancelAtPeriodEnd: false }));
  }
  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean) {
    const row = await this.rowBySubscription(subscriptionId);
    if (row) await this.emit("customer.subscription.updated", this.subObject(row, { cancelAtPeriodEnd: cancel }));
  }
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): ProviderEvent | null {
    if (!verifyStripeSignature(rawBody, signatureHeader, FAKE_WEBHOOK_SECRET, nowSeconds)) return null;
    const e = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
    return { id: e.id, type: e.type, created: e.created, object: e.data.object };
  }

  // ---- the "provider" side: build an event, sign it, verify it, and apply it exactly as a real delivery would be
  async emit(type: string, object: Record<string, unknown>): Promise<void> {
    this.lastCreated = Math.max(Math.floor(Date.now() / 1000), this.lastCreated + 1);
    const raw = Buffer.from(JSON.stringify({ id: `evt_fake_${randomBytes(8).toString("hex")}`, type, created: this.lastCreated, data: { object } }));
    const event = this.verifyWebhook(raw, signStripePayload(raw, FAKE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000)));
    if (!event) throw new Error("fake provider produced an event it could not verify");
    await applyBillingEvent(event);
  }

  private async rowBySubscription(id: string) {
    const r = await query<SubRow>("SELECT user_id, provider_customer_id, provider_subscription_id, status, price_id, current_period_end, trial_end, cancel_at_period_end FROM subscriptions WHERE provider_subscription_id = $1", [id]);
    return r.rows[0] ?? null;
  }
  private async rowByCustomer(id: string) {
    const r = await query<SubRow>("SELECT user_id, provider_customer_id, provider_subscription_id, status, price_id, current_period_end, trial_end, cancel_at_period_end FROM subscriptions WHERE provider_customer_id = $1", [id]);
    return r.rows[0] ?? null;
  }
  private interval(priceId: string | null) {
    return priceId && priceId === config.billing.priceProYearly ? "year" : "month";
  }
  subObject(row: SubRow, over: { status?: string; priceId?: string; cancelAtPeriodEnd?: boolean; periodEnd?: Date | null; trialEnd?: Date | null } = {}): Record<string, unknown> {
    const priceId = over.priceId ?? row.price_id ?? config.billing.priceProMonthly ?? "price_fake";
    const periodEnd = over.periodEnd ?? row.current_period_end ?? new Date(Date.now() + 30 * 86400_000);
    const trialEnd = over.trialEnd === undefined ? row.trial_end : over.trialEnd;
    return {
      id: row.provider_subscription_id,
      customer: row.provider_customer_id,
      status: over.status ?? row.status,
      current_period_end: Math.floor(periodEnd.getTime() / 1000),
      trial_end: trialEnd ? Math.floor(trialEnd.getTime() / 1000) : null,
      cancel_at_period_end: over.cancelAtPeriodEnd ?? row.cancel_at_period_end,
      metadata: { user_id: row.user_id },
      items: { data: [{ price: { id: priceId, recurring: { interval: this.interval(priceId) } } }] },
    };
  }

  // ---- the simulated hosted pages
  routes() {
    return async (app: FastifyInstance): Promise<void> => {
      app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
      const page = (title: string, body: string) =>
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#0f0b1e;color:#eee;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:460px;width:100%;padding:28px}
.card{background:#1a1433;border:1px solid #3a2f6b;border-radius:14px;padding:24px}.warn{background:#4a2c00;color:#ffd48a;padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:16px}
button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #5a4aa8;background:#2a2150;color:#fff;cursor:pointer;margin:4px 6px 4px 0}button.primary{background:#7c5cff;border-color:#7c5cff}
h1{font-size:20px;margin:0 0 8px}small{color:#aaa}</style></head><body><main><div class="warn"><b>SIMULATED PAYMENT PAGE</b> - local development only. No card is used and no money moves. In production this is Stripe's own page.</div><div class="card">${body}</div></main></body></html>`;
      const send = (reply: import("fastify").FastifyReply, html: string) => {
        reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.code(200).send(html);
      };

      app.get("/dev/billing/checkout/:sid", async (request, reply) => {
        const sid = (request.params as { sid: string }).sid;
        const req = this.sessions.get(sid);
        if (!req) return reply.code(404).send({ error: "Unknown checkout session" });
        const yearly = req.priceId === config.billing.priceProYearly;
        return send(reply, page("Simulated checkout", `<h1>Clynx Pro (${yearly ? "yearly" : "monthly"})</h1><p>${esc(req.email)}</p><p>${req.trialDays > 0 ? `${req.trialDays}-day free trial, then billed.` : "Billed today."}</p>
<form method="post" action="/dev/billing/checkout/${esc(sid)}/complete"><button class="primary" name="outcome" value="pay">Pay with test card 4242 4242 4242 4242</button><button name="outcome" value="decline">Use a declining test card</button><button name="outcome" value="cancel">Go back</button></form><small>Session ${esc(sid)}</small>`));
      });

      app.post("/dev/billing/checkout/:sid/complete", async (request, reply) => {
        const sid = (request.params as { sid: string }).sid;
        const req = this.sessions.get(sid);
        if (!req) return reply.code(404).send({ error: "Unknown checkout session" });
        const outcome = String((request.body as Record<string, unknown> | undefined)?.outcome ?? "");
        if (outcome === "cancel") return reply.redirect(config.billing.cancelUrl, 303);
        const customer = req.customerId ?? `cus_fake_${randomBytes(6).toString("hex")}`;
        const subscription = `sub_fake_${randomBytes(6).toString("hex")}`;
        const periodEnd = new Date(Date.now() + (req.trialDays > 0 ? req.trialDays : 30) * 86400_000);
        await this.emit("checkout.session.completed", { id: sid, client_reference_id: req.userId, customer, subscription });
        const base: SubRow = { user_id: req.userId, provider_customer_id: customer, provider_subscription_id: subscription, status: "incomplete", price_id: req.priceId, current_period_end: periodEnd, trial_end: req.trialDays > 0 ? periodEnd : null, cancel_at_period_end: false };
        if (outcome === "decline") {
          await this.emit("customer.subscription.created", this.subObject(base, { status: "incomplete" }));
          return reply.redirect(config.billing.cancelUrl, 303);
        }
        await this.emit("customer.subscription.created", this.subObject(base, { status: req.trialDays > 0 ? "trialing" : "active" }));
        return reply.redirect(config.billing.successUrl, 303);
      });

      app.get("/dev/billing/portal/:customer", async (request, reply) => {
        const customer = (request.params as { customer: string }).customer;
        const row = await this.rowByCustomer(customer);
        if (!row) return reply.code(404).send({ error: "Unknown customer" });
        const yearly = row.price_id === config.billing.priceProYearly;
        const act = (value: string, label: string, primary = false) => `<button${primary ? ' class="primary"' : ""} name="action" value="${value}">${label}</button>`;
        return send(reply, page("Simulated billing portal", `<h1>Billing portal</h1><p>Status: <b>${esc(row.status)}</b> - ${yearly ? "yearly" : "monthly"}${row.cancel_at_period_end ? " - cancels at period end" : ""}</p>
<form method="post" action="/dev/billing/portal/${esc(customer)}/act">${act(yearly ? "to-monthly" : "to-yearly", yearly ? "Switch to monthly" : "Switch to yearly", true)}${row.cancel_at_period_end ? act("resume", "Resume subscription") : act("cancel", "Cancel at period end")}${act("fail", "Simulate failed renewal")}${act("recover", "Simulate payment recovered")}${act("back", "Back to Clynx")}</form>`));
      });

      app.post("/dev/billing/portal/:customer/act", async (request, reply) => {
        const customer = (request.params as { customer: string }).customer;
        const row = await this.rowByCustomer(customer);
        if (!row) return reply.code(404).send({ error: "Unknown customer" });
        const action = String((request.body as Record<string, unknown> | undefined)?.action ?? "");
        const sub = row.provider_subscription_id as string;
        if (action === "to-monthly" && config.billing.priceProMonthly) await this.changePrice(sub, config.billing.priceProMonthly);
        else if (action === "to-yearly" && config.billing.priceProYearly) await this.changePrice(sub, config.billing.priceProYearly);
        else if (action === "cancel") await this.setCancelAtPeriodEnd(sub, true);
        else if (action === "resume") await this.setCancelAtPeriodEnd(sub, false);
        else if (action === "fail") {
          await this.emit("invoice.payment_failed", { customer, subscription: sub });
          await this.emit("customer.subscription.updated", this.subObject((await this.rowByCustomer(customer)) ?? row, { status: "past_due" }));
        } else if (action === "recover") {
          await this.emit("invoice.paid", { customer, subscription: sub });
          await this.emit("customer.subscription.updated", this.subObject((await this.rowByCustomer(customer)) ?? row, { status: "active" }));
        }
        return reply.redirect(config.billing.returnUrl, 303);
      });
    };
  }
}

interface SubRow {
  user_id: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: string;
  price_id: string | null;
  current_period_end: Date | null;
  trial_end: Date | null;
  cancel_at_period_end: boolean;
}
