import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { FAKE_WEBHOOK_SECRET, FakeStripe } from "../src/billing/fakeProvider.js";
import { signStripePayload } from "../src/billing/provider.js";
import { randomUUID } from "node:crypto";
import { asWeb, signup, type WebUser, lastEmailToken } from "./helpers/web.js";

// The subscription flow end to end, through the website's cookie session, the SIMULATED hosted pages (the local Stripe stand-in) and signed webhooks that go through the real
// verification and event-application code. This is a simulation: nothing here talks to Stripe.
let app: FastifyInstance;
let provider: FakeStripe;
const runId = randomUUID(); // event ids are unique per run: the test database keeps events between runs
const MONTHLY = "price_monthly_sim";
const YEARLY = "price_yearly_sim";

beforeAll(async () => {
  config.billing.priceProMonthly = MONTHLY;
  config.billing.priceProYearly = YEARLY;
  config.billing.trialDays = 7;
  provider = new FakeStripe();
  app = buildApp({ billing: provider });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await closePool();
});
beforeEach(() => {
  config.web.requireVerifiedEmailForBilling = false;
});

const status = async (u: WebUser) => (await app.inject({ method: "GET", url: "/billing/status", headers: { cookie: u.cookie } })).json();

async function checkout(u: WebUser, plan: "pro_monthly" | "pro_yearly", outcome: "pay" | "decline" | "cancel" = "pay") {
  const start = await app.inject({ method: "POST", url: "/billing/checkout", headers: asWeb(u), payload: { plan } });
  expect(start.statusCode).toBe(200);
  const hosted = new URL(start.json().url);
  const page = await app.inject({ method: "GET", url: hosted.pathname });
  expect(page.statusCode).toBe(200);
  expect(page.body).toMatch(/SIMULATED PAYMENT PAGE/);
  const done = await app.inject({ method: "POST", url: `${hosted.pathname}/complete`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `outcome=${outcome}` });
  expect(done.statusCode).toBe(303);
  return { start: start.json(), redirect: String(done.headers.location) };
}

async function portal(u: WebUser, action: string) {
  const p = await app.inject({ method: "POST", url: "/billing/portal", headers: asWeb(u) });
  expect(p.statusCode).toBe(200);
  const url = new URL(p.json().url).pathname;
  const res = await app.inject({ method: "POST", url: `${url}/act`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `action=${action}` });
  expect(res.statusCode).toBe(303);
}

describe("checkout", () => {
  it("a new customer is trial-eligible, completes the simulated checkout, and gets Pro through the webhook", async () => {
    const u = await signup(app);
    const before = await status(u);
    expect(before.plan).toBe("free");
    expect(before.trialEligible).toBe(true);
    const { start, redirect } = await checkout(u, "pro_monthly");
    expect(start.trialDays).toBe(7);
    expect(redirect).toBe(config.billing.successUrl);
    const after = await status(u);
    expect(after.plan).toBe("pro");
    expect(after.subscription.phase).toBe("trialing");
    expect(after.interval).toBe("month");
    expect(after.trialEligible).toBe(false); // the trial is used
    expect(after.canManage).toBe(true);
    // the events really went through the real path: signature-verified and recorded
    const ev = await pool.query("SELECT event_type, outcome FROM billing_events WHERE payload::text LIKE $1 ORDER BY received_at", [`%${u.id}%`]);
    expect(ev.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(["checkout.session.completed", "customer.subscription.created"]));
    expect(ev.rows.every((r) => r.outcome === "applied")).toBe(true);
  });

  it("a yearly checkout records the yearly interval; a second checkout is refused", async () => {
    const u = await signup(app);
    await checkout(u, "pro_yearly");
    expect((await status(u)).interval).toBe("year");
    const again = await app.inject({ method: "POST", url: "/billing/checkout", headers: asWeb(u), payload: { plan: "pro_monthly" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_subscribed");
  });

  it("a declined card or a cancelled checkout leaves the customer on Free", async () => {
    const a = await signup(app);
    await checkout(a, "pro_monthly", "decline");
    expect((await status(a)).plan).toBe("free");
    const b = await signup(app);
    const { redirect } = await checkout(b, "pro_monthly", "cancel");
    expect(redirect).toBe(config.billing.cancelUrl);
    expect((await status(b)).plan).toBe("free");
    expect((await status(b)).trialEligible).toBe(true); // nothing was subscribed, so the trial is still available
  });

  it("checkout through the website needs the CSRF token", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "POST", url: "/billing/checkout", headers: { cookie: u.cookie }, payload: { plan: "pro_monthly" } })).statusCode).toBe(403);
  });

  it("when a verified email is required (staged setting), an unverified customer is stopped and a verified one is not", async () => {
    config.web.requireVerifiedEmailForBilling = true;
    const u = await signup(app);
    const blocked = await app.inject({ method: "POST", url: "/billing/checkout", headers: asWeb(u), payload: { plan: "pro_monthly" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("email_not_verified");
    await app.inject({ method: "POST", url: "/web/email/verify", payload: { token: await lastEmailToken(u.email, "verify_email") } });
    expect((await app.inject({ method: "POST", url: "/billing/checkout", headers: asWeb(u), payload: { plan: "pro_monthly" } })).statusCode).toBe(200);
  });
});

describe("changing and cancelling", () => {
  it("switches monthly to yearly and back (prorated by the provider), and refuses a no-op", async () => {
    const u = await signup(app);
    await checkout(u, "pro_monthly");
    expect((await app.inject({ method: "POST", url: "/billing/change-plan", headers: asWeb(u), payload: { plan: "pro_monthly" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/billing/change-plan", headers: asWeb(u), payload: { plan: "pro_yearly" } })).statusCode).toBe(200);
    expect((await status(u)).interval).toBe("year");
    expect((await app.inject({ method: "POST", url: "/billing/change-plan", headers: asWeb(u), payload: { plan: "pro_monthly" } })).statusCode).toBe(200);
    expect((await status(u)).interval).toBe("month");
    expect((await status(u)).plan).toBe("pro"); // a plan change never interrupts access
  });

  it("cancel keeps access until the period ends, resume undoes it", async () => {
    const u = await signup(app);
    await checkout(u, "pro_monthly");
    expect((await app.inject({ method: "POST", url: "/billing/cancel", headers: asWeb(u) })).statusCode).toBe(200);
    const s = await status(u);
    expect(s.subscription.cancelAtPeriodEnd).toBe(true);
    expect(["trialing", "canceling"]).toContain(s.subscription.phase); // during a trial the phase stays "trialing"; the flag is what says it will end
    expect(s.plan).toBe("pro");
    expect((await app.inject({ method: "POST", url: "/billing/resume", headers: asWeb(u) })).statusCode).toBe(200);
    expect((await status(u)).subscription.cancelAtPeriodEnd).toBe(false);
  });

  it("changing, cancelling or resuming without a subscription is refused", async () => {
    const u = await signup(app);
    for (const url of ["/billing/change-plan", "/billing/cancel", "/billing/resume"]) {
      const res = await app.inject({ method: "POST", url, headers: asWeb(u), payload: { plan: "pro_yearly" } });
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error).toBe("no_active_subscription");
    }
  });

  it("the customer portal only works for the customer's own subscription", async () => {
    const a = await signup(app);
    const b = await signup(app);
    await checkout(a, "pro_monthly");
    expect((await app.inject({ method: "POST", url: "/billing/portal", headers: asWeb(b) })).statusCode).toBe(404); // b has no customer record
    expect((await app.inject({ method: "POST", url: "/billing/portal", headers: asWeb(a) })).statusCode).toBe(200);
  });
});

describe("failed payments and recovery", () => {
  it("a failed renewal starts a grace period, keeps Pro during it, and recovery clears it", async () => {
    const u = await signup(app);
    await checkout(u, "pro_monthly");
    await portal(u, "fail");
    const failed = await status(u);
    expect(failed.subscription.phase).toBe("past_due_grace");
    expect(failed.subscription.graceEndsAt).toBeTruthy();
    expect(failed.plan).toBe("pro");
    await portal(u, "recover");
    const ok = await status(u);
    expect(ok.subscription.phase).toBe("active");
    expect(ok.subscription.graceEndsAt).toBeNull();
  });

  it("a payment that stays failed past the grace period drops the account to Free", async () => {
    const u = await signup(app);
    await checkout(u, "pro_monthly");
    await portal(u, "fail");
    await pool.query("UPDATE subscriptions SET past_due_since = now() - interval '30 days' WHERE user_id = $1", [u.id]);
    const s = await status(u);
    expect(s.subscription.phase).toBe("past_due_lapsed");
    expect(s.plan).toBe("free");
  });
});

describe("webhook security and ordering", () => {
  const send = (obj: object, secret = FAKE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) => {
    const raw = Buffer.from(JSON.stringify(obj));
    return app.inject({ method: "POST", url: "/billing/webhook", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(raw, secret, t) }, payload: raw });
  };
  const ev = (id: string, type: string, object: object, created = Math.floor(Date.now() / 1000)) => ({ id, type, created, data: { object } });

  it("refuses a wrong signature, a stale timestamp and an unsigned delivery", async () => {
    const e = ev(`evt_bad_${runId}`, "customer.subscription.updated", {});
    expect((await send(e, "whsec_wrong")).statusCode).toBe(400);
    expect((await send(e, FAKE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600)).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/billing/webhook", headers: { "content-type": "application/json" }, payload: JSON.stringify(e) })).statusCode).toBe(400);
  });

  it("a duplicate delivery changes nothing; an older event never overwrites a newer state", async () => {
    const u = await signup(app);
    await checkout(u, "pro_monthly");
    const row = (await pool.query("SELECT provider_customer_id AS c, provider_subscription_id AS s, last_event_created AS t FROM subscriptions WHERE user_id = $1", [u.id])).rows[0];
    const now = Number(row.t) + 100;
    const sub = (status: string, price: string) => ({ id: row.s, customer: row.c, status, current_period_end: now + 86400, trial_end: null, cancel_at_period_end: false, metadata: { user_id: u.id }, items: { data: [{ price: { id: price, recurring: { interval: price === YEARLY ? "year" : "month" } } }] } });
    const newer = ev(`evt_order_new_${runId}`, "customer.subscription.updated", sub("active", YEARLY), now);
    expect((await send(newer)).json()).toMatchObject({ received: true, duplicate: false });
    expect((await send(newer)).json()).toMatchObject({ received: true, duplicate: true });
    expect((await status(u)).interval).toBe("year");
    const older = ev(`evt_order_old_${runId}`, "customer.subscription.updated", sub("canceled", MONTHLY), now - 50);
    await send(older);
    const after = await status(u);
    expect(after.interval).toBe("year");
    expect(after.plan).toBe("pro");
    expect((await pool.query("SELECT outcome FROM billing_events WHERE event_id = $1", [`evt_order_old_${runId}`])).rows[0].outcome).toBe("ignored-stale");
  });

  it("an event for an unknown account is recorded and ignored", async () => {
    const res = await send(ev(`evt_unknown_${runId}`, "customer.subscription.created", { id: "sub_x", customer: "cus_x", status: "active", metadata: { user_id: "00000000-0000-4000-8000-000000000000" } }));
    expect(res.statusCode).toBe(200);
    expect((await pool.query("SELECT outcome FROM billing_events WHERE event_id = $1", [`evt_unknown_${runId}`])).rows[0].outcome).toBe("ignored-unknown-user");
  });
});

describe("the public plans", () => {
  it("lists the plans and limits with NO invented prices until they are configured", async () => {
    const was = { ...config.web.priceDisplay };
    config.web.priceDisplay.proMonthly = null;
    config.web.priceDisplay.proYearly = null;
    const res = await app.inject({ method: "GET", url: "/plans/public" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pricesApproved).toBe(false);
    expect(body.plans.find((p: { id: string }) => p.id === "pro").price).toEqual({ monthly: null, yearly: null });
    expect(body.plans.find((p: { id: string }) => p.id === "free").entitlements.maxWatches).toBe(5);
    expect(body.trialDays).toBe(7);
    config.web.priceDisplay.proMonthly = "PLACEHOLDER-ONLY";
    expect((await app.inject({ method: "GET", url: "/plans/public" })).json().plans[1].price.monthly).toBe("PLACEHOLDER-ONLY");
    Object.assign(config.web.priceDisplay, was);
  });
});
