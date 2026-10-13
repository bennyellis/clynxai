import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { resolveSubscription, STALE_SLACK_MS } from "../src/billing/plan.js";
import { signStripePayload, verifyStripeSignature, type BillingProvider, type CheckoutRequest, type ProviderEvent } from "../src/billing/provider.js";

const SECRET = "whsec_test_secret_value_1234567890";
const DAY = 86_400_000;

// A fake provider: real signature verification (the same function the Stripe adapter uses), canned sessions, recorded calls. No network, no credentials.
class FakeBilling implements BillingProvider {
  readonly name = "fake";
  checkouts: CheckoutRequest[] = [];
  portals: string[] = [];
  cancelled: string[] = [];
  failCancel = false;
  async createCheckoutSession(req: CheckoutRequest) {
    this.checkouts.push(req);
    return { id: "cs_test_1", url: "https://checkout.example.test/session/cs_test_1" };
  }
  async createPortalSession(customerId: string) {
    this.portals.push(customerId);
    return { url: "https://portal.example.test/session/1" };
  }
  async cancelSubscription(id: string) {
    if (this.failCancel) throw new Error("provider down");
    this.cancelled.push(id);
  }
  verifyWebhook(raw: Buffer, sig: string | undefined, now = Math.floor(Date.now() / 1000)): ProviderEvent | null {
    if (!verifyStripeSignature(raw, sig, SECRET, now)) return null;
    const e = JSON.parse(raw.toString("utf8"));
    return { id: e.id, type: e.type, created: e.created, object: e.data.object };
  }
}

let app: FastifyInstance;
let fake: FakeBilling;

beforeEach(async () => {
  config.billing.priceProMonthly = "price_monthly_test";
  config.billing.priceProYearly = "price_yearly_test";
  fake = new FakeBilling();
  app = buildApp({ billing: fake });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await closePool();
});

const email = () => `billing-${randomUUID()}@example.com`;
async function register(): Promise<{ accessToken: string; userId: string }> {
  return (await app.inject({ method: "POST", url: "/auth/register", payload: { email: email(), password: "correct-horse-battery" } })).json();
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
let evSeq = 0;
function event(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000), id = `evt_${randomUUID()}_${++evSeq}`) {
  return { id, type, created, data: { object } };
}
async function deliver(e: ReturnType<typeof event>, opts: { secret?: string; t?: number } = {}) {
  const raw = JSON.stringify(e);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  return app.inject({ method: "POST", url: "/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(raw, opts.secret ?? SECRET, t) }, payload: raw });
}
const sub = (userId: string, over: Record<string, unknown> = {}) => ({
  id: over.id ?? `sub_${userId.slice(0, 8)}`, customer: over.customer ?? `cus_${userId.slice(0, 8)}`, status: "active",
  current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000), trial_end: null, cancel_at_period_end: false, metadata: { user_id: userId }, ...over,
});
const status = async (token: string) => (await app.inject({ method: "GET", url: "/billing/status", headers: auth(token) })).json();

describe("webhook signature (Stripe's scheme)", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  const sig = (secret = SECRET, t = now, b = body) => signStripePayload(b, secret, t);
  it("accepts a correct signature", () => expect(verifyStripeSignature(body, sig(), SECRET, now)).toBe(true));
  it("rejects a wrong secret, a tampered body, a missing or malformed header", () => {
    expect(verifyStripeSignature(body, sig("whsec_other_secret_value_000"), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body + " ", sig(), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, "garbage", SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${now},v1=zz`, SECRET, now)).toBe(false);
  });
  it("rejects a replay outside the tolerance, in either direction", () => {
    expect(verifyStripeSignature(body, sig(SECRET, now - 301), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, sig(SECRET, now + 301), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, sig(SECRET, now - 299), SECRET, now)).toBe(true);
  });
  it("accepts when ANY of several v1 signatures matches (secret rotation)", () => {
    const good = sig().split(",")[1];
    expect(verifyStripeSignature(body, `t=${now},v1=${"0".repeat(64)},${good}`, SECRET, now)).toBe(true);
  });
});

describe("what plan a subscription entitles a user to", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const base = { current_period_end: new Date(now.getTime() + 10 * DAY), trial_end: null, past_due_since: null, cancel_at_period_end: false };
  it("none, trial, active, canceling", () => {
    expect(resolveSubscription(null, now, 7).plan).toBe("free");
    expect(resolveSubscription({ ...base, status: "trialing" }, now, 7)).toMatchObject({ plan: "pro", phase: "trialing" });
    expect(resolveSubscription({ ...base, status: "active" }, now, 7)).toMatchObject({ plan: "pro", phase: "active" });
    expect(resolveSubscription({ ...base, status: "active", cancel_at_period_end: true }, now, 7)).toMatchObject({ plan: "pro", phase: "canceling" });
  });
  it("past due keeps the paid plan only inside the grace period", () => {
    const since = new Date(now.getTime() - 3 * DAY);
    expect(resolveSubscription({ ...base, status: "past_due", past_due_since: since }, now, 7)).toMatchObject({ plan: "pro", phase: "past_due_grace" });
    expect(resolveSubscription({ ...base, status: "past_due", past_due_since: new Date(now.getTime() - 8 * DAY) }, now, 7)).toMatchObject({ plan: "free", phase: "past_due_lapsed" });
  });
  it("ended states are free, and a subscription whose period ended long ago with no newer event is not trusted forever", () => {
    for (const s of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) expect(resolveSubscription({ ...base, status: s }, now, 7).plan).toBe("free");
    const old = new Date(now.getTime() - STALE_SLACK_MS - 1000);
    expect(resolveSubscription({ ...base, status: "active", current_period_end: old }, now, 7)).toMatchObject({ plan: "free", phase: "ended" });
    expect(resolveSubscription({ ...base, status: "active", current_period_end: new Date(now.getTime() - 1000) }, now, 7).plan).toBe("pro"); // inside the slack for a late renewal event
  });
});

describe("billing webhook", () => {
  it("is not configured without a provider, and refuses an unsigned or wrongly signed delivery", async () => {
    const bare = buildApp({ billing: null });
    await bare.ready();
    const r = await bare.inject({ method: "POST", url: "/billing/webhook", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(503);
    await bare.close();
    const { userId } = await register();
    expect((await deliver(event("customer.subscription.created", sub(userId)), { secret: "whsec_wrong_secret_value_000000" })).statusCode).toBe(400);
    const unsigned = await app.inject({ method: "POST", url: "/billing/webhook", headers: { "content-type": "application/json" }, payload: JSON.stringify(event("x", {})) });
    expect(unsigned.statusCode).toBe(400);
    expect((await pool.query("SELECT 1 FROM billing_events WHERE event_type = 'customer.subscription.created' AND payload->'object'->'metadata'->>'user_id' = $1", [userId])).rows.length).toBe(0);
  });

  it("a trial then a paid subscription: the plan follows", async () => {
    const { accessToken, userId } = await register();
    expect((await status(accessToken)).plan).toBe("free");
    const trialEnd = Math.floor((Date.now() + 7 * DAY) / 1000);
    expect((await deliver(event("checkout.session.completed", { client_reference_id: userId, customer: `cus_${userId.slice(0, 8)}`, subscription: `sub_${userId.slice(0, 8)}` }))).statusCode).toBe(200);
    expect((await status(accessToken)).plan).toBe("free"); // checkout alone is not a subscription yet
    await deliver(event("customer.subscription.created", sub(userId, { status: "trialing", trial_end: trialEnd })));
    let s = await status(accessToken);
    expect(s).toMatchObject({ plan: "pro", subscription: { status: "trialing", phase: "trialing" }, canManage: true });
    expect(s.entitlements.maxWatches).toBeNull();
    await deliver(event("customer.subscription.updated", sub(userId, { status: "active" }), Math.floor(Date.now() / 1000) + 5));
    s = await status(accessToken);
    expect(s.subscription.phase).toBe("active");
  });

  it("is idempotent: a redelivered event is processed once", async () => {
    const { userId } = await register();
    const e = event("customer.subscription.created", sub(userId));
    const first = await deliver(e);
    const second = await deliver(e);
    expect(first.json()).toMatchObject({ received: true, duplicate: false });
    expect(second.json()).toMatchObject({ received: true, duplicate: true });
    expect((await pool.query("SELECT count(*)::int AS n FROM billing_events WHERE event_id = $1", [e.id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1", [userId])).rows[0].n).toBe(1);
  });

  it("is order-safe: an older event never overwrites a newer state", async () => {
    const { accessToken, userId } = await register();
    const now = Math.floor(Date.now() / 1000);
    await deliver(event("customer.subscription.updated", sub(userId, { status: "canceled" }), now + 100));
    const older = event("customer.subscription.updated", sub(userId, { status: "active" }), now);
    const stale = await deliver(older);
    expect(stale.statusCode).toBe(200);
    expect((await status(accessToken)).plan).toBe("free");
    expect((await pool.query("SELECT outcome FROM billing_events WHERE event_id = $1", [older.id])).rows[0].outcome).toBe("ignored-stale");
  });

  it("failed payments: a grace period, then free; a successful payment restores it", async () => {
    const { accessToken, userId } = await register();
    const now = Math.floor(Date.now() / 1000);
    await deliver(event("customer.subscription.created", sub(userId), now));
    await deliver(event("invoice.payment_failed", { customer: `cus_${userId.slice(0, 8)}`, subscription: `sub_${userId.slice(0, 8)}` }, now + 10));
    let s = await status(accessToken);
    expect(s).toMatchObject({ plan: "pro", subscription: { status: "past_due", phase: "past_due_grace" } });
    expect(s.subscription.graceEndsAt).toBeTruthy();
    await pool.query("UPDATE subscriptions SET past_due_since = now() - interval '8 days' WHERE user_id = $1", [userId]);
    s = await status(accessToken);
    expect(s).toMatchObject({ plan: "free", subscription: { phase: "past_due_lapsed" } });
    await deliver(event("invoice.paid", { customer: `cus_${userId.slice(0, 8)}`, subscription: `sub_${userId.slice(0, 8)}` }, now + 20));
    s = await status(accessToken);
    expect(s).toMatchObject({ plan: "pro", subscription: { status: "active" } });
  });

  it("cancellation: scheduled keeps the plan until the period ends; deletion ends it", async () => {
    const { accessToken, userId } = await register();
    const now = Math.floor(Date.now() / 1000);
    await deliver(event("customer.subscription.updated", sub(userId, { cancel_at_period_end: true }), now));
    expect((await status(accessToken)).subscription).toMatchObject({ phase: "canceling", cancelAtPeriodEnd: true });
    expect((await status(accessToken)).plan).toBe("pro");
    await deliver(event("customer.subscription.deleted", sub(userId, { status: "canceled" }), now + 10));
    expect(await status(accessToken)).toMatchObject({ plan: "free", subscription: { status: "canceled" } });
  });

  it("an event for an unknown user, or of an unknown type, is recorded and ignored without error", async () => {
    const stranger = randomUUID();
    const a = await deliver(event("customer.subscription.created", sub(stranger)));
    expect(a.statusCode).toBe(200);
    const b = await deliver(event("balance.available", { x: 1 }));
    expect(b.statusCode).toBe(200);
    expect((await pool.query("SELECT outcome FROM billing_events WHERE event_type = 'balance.available' ORDER BY received_at DESC LIMIT 1")).rows[0].outcome).toBe("ignored-type");
  });

  it("a processing failure answers 5xx (so the provider retries) and leaves the event unprocessed", async () => {
    const { userId } = await register();
    const bad = event("customer.subscription.updated", sub(userId, { current_period_end: 1e20 }));
    const r = await deliver(bad);
    expect(r.statusCode).toBe(500);
    const rec = await pool.query("SELECT processed_at, outcome FROM billing_events WHERE event_id = $1", [bad.id]);
    expect(rec.rows[0].processed_at).toBeNull();
    expect(rec.rows[0].outcome).toBe("error");
  });
});

describe("checkout, portal and status", () => {
  it("require sign-in; status works for everyone", async () => {
    expect((await app.inject({ method: "POST", url: "/billing/checkout", payload: { plan: "pro_monthly" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/billing/portal" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/billing/status" })).statusCode).toBe(401);
  });

  it("billing not configured: status says so, checkout and portal answer 503", async () => {
    const bare = buildApp({ billing: null });
    await bare.ready();
    const { accessToken } = (await bare.inject({ method: "POST", url: "/auth/register", payload: { email: email(), password: "correct-horse-battery" } })).json();
    expect((await bare.inject({ method: "GET", url: "/billing/status", headers: auth(accessToken) })).json()).toMatchObject({ configured: false, plan: "free" });
    expect((await bare.inject({ method: "POST", url: "/billing/checkout", headers: auth(accessToken), payload: { plan: "pro_monthly" } })).statusCode).toBe(503);
    await bare.close();
  });

  it("checkout validates the plan, offers the trial once, and refuses a second subscription", async () => {
    const { accessToken, userId } = await register();
    expect((await app.inject({ method: "POST", url: "/billing/checkout", headers: auth(accessToken), payload: { plan: "platinum" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/billing/checkout", headers: auth(accessToken), payload: { plan: "pro_yearly" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toContain("checkout.example.test");
    expect(fake.checkouts[0]).toMatchObject({ userId, priceId: "price_yearly_test", trialDays: config.billing.trialDays, customerId: null });
    expect(fake.checkouts[0].successUrl).toMatch(/^https:/);
    // the account has now had a subscription row: the trial is not offered again
    await deliver(event("customer.subscription.updated", sub(userId, { status: "canceled" })));
    await app.inject({ method: "POST", url: "/billing/checkout", headers: auth(accessToken), payload: { plan: "pro_monthly" } });
    expect(fake.checkouts[1]).toMatchObject({ priceId: "price_monthly_test", trialDays: 0, customerId: `cus_${userId.slice(0, 8)}` });
    await deliver(event("customer.subscription.updated", sub(userId, { status: "active" }), Math.floor(Date.now() / 1000) + 50));
    const again = await app.inject({ method: "POST", url: "/billing/checkout", headers: auth(accessToken), payload: { plan: "pro_monthly" } });
    expect(again.statusCode).toBe(409);
  });

  it("the portal needs a customer; a user only ever sees their own subscription", async () => {
    const a = await register();
    const b = await register();
    expect((await app.inject({ method: "POST", url: "/billing/portal", headers: auth(a.accessToken) })).statusCode).toBe(404);
    await deliver(event("customer.subscription.created", sub(a.userId)));
    expect((await app.inject({ method: "POST", url: "/billing/portal", headers: auth(a.accessToken) })).json().url).toContain("portal.example.test");
    expect(fake.portals).toEqual([`cus_${a.userId.slice(0, 8)}`]);
    expect((await status(b.accessToken)).subscription).toBeNull();
    expect((await status(b.accessToken)).plan).toBe("free");
    expect((await app.inject({ method: "POST", url: "/billing/portal", headers: auth(b.accessToken) })).statusCode).toBe(404);
  });

  it("/me/entitlements reports the effective plan", async () => {
    const { accessToken, userId } = await register();
    await deliver(event("customer.subscription.created", sub(userId)));
    const r = (await app.inject({ method: "GET", url: "/me/entitlements", headers: auth(accessToken) })).json();
    expect(r.plan).toBe("pro");
    expect(r.entitlements.maxWatches).toBeNull();
  });
});

describe("account deletion with a subscription", () => {
  it("cancels the subscription first; if that fails the account is kept", async () => {
    const { accessToken, userId } = await register();
    await deliver(event("customer.subscription.created", sub(userId)));
    fake.failCancel = true;
    const refused = await app.inject({ method: "DELETE", url: "/me", headers: auth(accessToken), payload: { password: "correct-horse-battery", confirm: "DELETE" } });
    expect(refused.statusCode).toBe(502);
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [userId])).rows.length).toBe(1);
    fake.failCancel = false;
    const done = await app.inject({ method: "DELETE", url: "/me", headers: auth(accessToken), payload: { password: "correct-horse-battery", confirm: "DELETE" } });
    expect(done.statusCode).toBe(200);
    expect(fake.cancelled).toEqual([`sub_${userId.slice(0, 8)}`]);
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [userId])).rows.length).toBe(0);
    expect((await pool.query("SELECT 1 FROM subscriptions WHERE user_id = $1", [userId])).rows.length).toBe(0);
  });
});
