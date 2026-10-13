import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { aiUsageToday, effectivePlanFor } from "../entitlements/enforce.js";
import { hit } from "../security/rateLimit.js";
import type { BillingProvider } from "./provider.js";
import { applyBillingEvent } from "./service.js";

const checkoutSchema = z.object({ plan: z.enum(["pro_monthly", "pro_yearly"]) });
const priceFor = (plan: "pro_monthly" | "pro_yearly") => (plan === "pro_yearly" ? config.billing.priceProYearly : config.billing.priceProMonthly);

/** The billing endpoints. `provider` is null when billing is not configured: status still works, everything that needs the provider answers 503 billing_not_configured. */
export function billingRoutes(provider: BillingProvider | null) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // ---------------------------------------------------------------- the webhook: NOT authenticated by a user; authenticated by the provider's signature over the raw body
    app.register(async (hook) => {
      hook.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
      hook.post("/billing/webhook", async (request, reply) => {
        if (!provider) return reply.code(503).send({ error: "billing_not_configured" });
        const raw = request.body as Buffer;
        const sig = request.headers["stripe-signature"];
        const event = Buffer.isBuffer(raw) ? provider.verifyWebhook(raw, typeof sig === "string" ? sig : undefined) : null;
        if (!event) return reply.code(400).send({ error: "invalid_signature" });
        try {
          const r = await applyBillingEvent(event);
          return reply.code(200).send({ received: true, duplicate: r.duplicate });
        } catch (err) {
          request.log.error({ err, eventId: event.id }, "billing event failed");
          // a 5xx makes the provider redeliver the event; it is recorded and will be processed again
          return reply.code(500).send({ error: "processing_failed" });
        }
      });
    });

    // ---------------------------------------------------------------- everything below is the signed-in user's own
    app.register(async (authed) => {
      authed.addHook("preHandler", requireAuth);

      authed.get("/billing/status", async (request, reply) => {
        const eff = await effectivePlanFor(request.userId as string);
        if (!eff) return reply.code(404).send({ error: "User not found" });
        const usage = await aiUsageToday(request.userId as string);
        const subRow = await query<{ billing_interval: string | null }>("SELECT billing_interval FROM subscriptions WHERE user_id = $1", [request.userId]);
        const verified = await query<{ email_verified_at: Date | null }>("SELECT email_verified_at FROM users WHERE id = $1", [request.userId]);
        return reply.code(200).send({
          configured: !!provider,
          interval: subRow.rows[0]?.billing_interval ?? null,
          // a free trial is offered once: only an account that has never had a subscription can start one
          trialEligible: !subRow.rows[0] && config.billing.trialDays > 0,
          emailVerified: !!verified.rows[0]?.email_verified_at,
          verifiedEmailRequired: config.web.requireVerifiedEmailForBilling,
          plan: eff.plan,
          basePlan: eff.basePlan,
          entitlements: eff.entitlements,
          subscription: eff.subscription.status === null ? null : {
            status: eff.subscription.status,
            phase: eff.subscription.phase,
            currentPeriodEnd: eff.subscription.currentPeriodEnd,
            trialEnd: eff.subscription.trialEnd,
            cancelAtPeriodEnd: eff.subscription.cancelAtPeriodEnd,
            graceEndsAt: eff.subscription.graceEndsAt,
          },
          canManage: eff.subscription.hasCustomer,
          usage: { aiRequestsToday: usage.requests, aiImagesToday: usage.images },
          trialDays: config.billing.trialDays,
        });
      });

      authed.post("/billing/checkout", async (request, reply) => {
        if (!provider) return reply.code(503).send({ error: "billing_not_configured" });
        const parsed = checkoutSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
        const rl = await hit(`checkout:${request.userId}`, 10, 3600);
        if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
        const priceId = priceFor(parsed.data.plan);
        if (!priceId) return reply.code(400).send({ error: "plan_not_available" });
        if (config.web.requireVerifiedEmailForBilling) {
          const v = await query<{ email_verified_at: Date | null }>("SELECT email_verified_at FROM users WHERE id = $1", [request.userId]);
          if (!v.rows[0]?.email_verified_at) return reply.code(403).send({ error: "email_not_verified", message: "Confirm your email address before subscribing." });
        }
        const eff = await effectivePlanFor(request.userId as string);
        if (eff && (eff.subscription.phase === "active" || eff.subscription.phase === "trialing" || eff.subscription.phase === "canceling" || eff.subscription.phase === "past_due_grace")) {
          return reply.code(409).send({ error: "already_subscribed", message: "You already have a subscription. Manage it from the billing portal." });
        }
        const u = await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [request.userId]);
        const sub = await query<{ provider_customer_id: string | null }>("SELECT provider_customer_id FROM subscriptions WHERE user_id = $1", [request.userId]);
        // a free trial is offered once: an account that has ever had a subscription row does not get another
        const trialDays = sub.rows[0] ? 0 : config.billing.trialDays;
        try {
          const session = await provider.createCheckoutSession({
            userId: request.userId as string, email: u.rows[0].email, priceId, trialDays,
            successUrl: config.billing.successUrl, cancelUrl: config.billing.cancelUrl, customerId: sub.rows[0]?.provider_customer_id ?? null,
          });
          return reply.code(200).send({ url: session.url, trialDays });
        } catch (err) {
          request.log.error({ err }, "checkout session failed");
          return reply.code(502).send({ error: "provider_error" });
        }
      });

      // Subscription changes. Each one asks the provider and then waits for the provider's webhook to update our records (the webhook is the only writer of `subscriptions`).
      const liveSubscription = async (userId: string) => {
        const r = await query<{ provider_subscription_id: string | null; status: string; price_id: string | null }>("SELECT provider_subscription_id, status, price_id FROM subscriptions WHERE user_id = $1", [userId]);
        const row = r.rows[0];
        return row?.provider_subscription_id && ["trialing", "active", "past_due"].includes(row.status) ? row : null;
      };
      authed.post("/billing/change-plan", async (request, reply) => {
        if (!provider) return reply.code(503).send({ error: "billing_not_configured" });
        const parsed = checkoutSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
        const rl = await hit(`changeplan:${request.userId}`, 10, 3600);
        if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
        const priceId = priceFor(parsed.data.plan);
        if (!priceId) return reply.code(400).send({ error: "plan_not_available" });
        const sub = await liveSubscription(request.userId as string);
        if (!sub) return reply.code(409).send({ error: "no_active_subscription" });
        if (sub.price_id === priceId) return reply.code(409).send({ error: "already_on_plan" });
        try {
          await provider.changePrice(sub.provider_subscription_id as string, priceId);
          return reply.code(200).send({ ok: true, pending: true });
        } catch (err) {
          request.log.error({ err }, "change plan failed");
          return reply.code(502).send({ error: "provider_error" });
        }
      });
      authed.post("/billing/cancel", async (request, reply) => {
        if (!provider) return reply.code(503).send({ error: "billing_not_configured" });
        const sub = await liveSubscription(request.userId as string);
        if (!sub) return reply.code(409).send({ error: "no_active_subscription" });
        try {
          await provider.setCancelAtPeriodEnd(sub.provider_subscription_id as string, true);
          return reply.code(200).send({ ok: true, pending: true });
        } catch (err) {
          request.log.error({ err }, "cancel failed");
          return reply.code(502).send({ error: "provider_error" });
        }
      });
      authed.post("/billing/resume", async (request, reply) => {
        if (!provider) return reply.code(503).send({ error: "billing_not_configured" });
        const sub = await liveSubscription(request.userId as string);
        if (!sub) return reply.code(409).send({ error: "no_active_subscription" });
        try {
          await provider.setCancelAtPeriodEnd(sub.provider_subscription_id as string, false);
          return reply.code(200).send({ ok: true, pending: true });
        } catch (err) {
          request.log.error({ err }, "resume failed");
          return reply.code(502).send({ error: "provider_error" });
        }
      });

      authed.post("/billing/portal", async (request, reply) => {
        if (!provider) return reply.code(503).send({ error: "billing_not_configured" });
        const sub = await query<{ provider_customer_id: string | null }>("SELECT provider_customer_id FROM subscriptions WHERE user_id = $1", [request.userId]);
        const customer = sub.rows[0]?.provider_customer_id;
        if (!customer) return reply.code(404).send({ error: "no_subscription" });
        try {
          const portal = await provider.createPortalSession(customer, config.billing.returnUrl);
          return reply.code(200).send({ url: portal.url });
        } catch (err) {
          request.log.error({ err }, "portal session failed");
          return reply.code(502).send({ error: "provider_error" });
        }
      });
    });
  };
}
