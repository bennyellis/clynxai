// Phase 6 desktop side: the account / subscription helpers. The URL guard that decides what may be opened in the user's browser, the plain-language subscription text, and the
// account calls to the cloud (against a stubbed fetch, never a real server).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudClient, isBillingStatus } from "../cloudClient.js";
import { safeExternalUrl } from "../safeExternalUrl.js";
import { describeSubscription } from "../../renderer/src/lib/subscriptionText.js";
import type { BillingStatus, Config } from "../types.js";
import { check, run, section } from "./_testkit.js";

const base: BillingStatus = {
  configured: true,
  plan: "pro",
  basePlan: "free",
  entitlements: { maxWatches: null, maxDevices: null, maxSearchItems: null, aiResearchEnabled: true, aiRequestsPerDay: 3000, aiImagesPerDay: 100 },
  subscription: null,
  canManage: true,
  usage: { aiRequestsToday: 4, aiImagesToday: 0 },
  trialDays: 7,
};
const sub = (phase: string, extra: Record<string, unknown> = {}): BillingStatus => ({
  ...base,
  subscription: { status: phase, phase, currentPeriodEnd: "2026-11-01T00:00:00Z", trialEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null, ...extra },
});

run(async () => {
  section("safeExternalUrl: only secure addresses are ever opened");
  {
    check("https is allowed", safeExternalUrl("https://checkout.stripe.com/c/pay/abc").ok === true);
    check("http on localhost is allowed (dev server)", safeExternalUrl("http://localhost:8787/x").ok === true && safeExternalUrl("http://127.0.0.1:8787/x").ok === true);
    check("http on a real host is refused", safeExternalUrl("http://example.com/pay").ok === false);
    check("file:, javascript: and custom protocols are refused", ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id", "smb://host/share"].every((u) => safeExternalUrl(u).ok === false));
    check("garbage and non-strings are refused", safeExternalUrl("not a url").ok === false && safeExternalUrl(undefined).ok === false && safeExternalUrl({}).ok === false);
    check("credentials in the address are refused", safeExternalUrl("https://user:pw@example.com/").ok === false);
  }

  section("isBillingStatus: an unexpected server answer never reaches the screen");
  {
    check("a real status passes", isBillingStatus(base) && isBillingStatus(sub("active")));
    check("an empty object, null, a string and an error body are refused", [{}, null, "x", { error: "nope" }, []].every((v) => !isBillingStatus(v)));
    check("a status missing entitlements or usage is refused", !isBillingStatus({ ...base, entitlements: undefined }) && !isBillingStatus({ ...base, usage: undefined }));
    check("an unknown plan name is refused", !isBillingStatus({ ...base, plan: "enterprise" }));
  }

  section("describeSubscription");
  {
    check("no subscription, free plan", describeSubscription({ ...base, plan: "free" }).headline === "Free");
    const trial = describeSubscription(sub("trialing", { trialEnd: "2026-10-20T00:00:00Z" }));
    check("a trial says when it ends and that a charge follows", /trial/i.test(trial.headline) && /charged/i.test(trial.detail) && trial.tone === "ok", trial);
    check("active says it renews", /Renews/.test(describeSubscription(sub("active")).detail));
    const canceling = describeSubscription(sub("canceling"));
    check("a scheduled cancellation keeps Pro until the period ends", /stays until/.test(canceling.detail) && canceling.tone === "warn", canceling);
    const grace = describeSubscription(sub("past_due_grace", { graceEndsAt: "2026-10-20T00:00:00Z" }));
    check("a failed payment in grace asks for a new card", /payment/i.test(grace.headline) && /Update your card/.test(grace.detail) && grace.tone === "warn", grace);
    check("a lapsed failed payment says Pro ended", /Pro ended/.test(describeSubscription({ ...sub("past_due_lapsed"), plan: "free" }).headline));
    check("every phase produces a headline", ["trialing", "active", "canceling", "past_due_grace", "past_due_lapsed", "canceled", "ended", "incomplete", "weird"].every((p) => describeSubscription(sub(p)).headline.length > 0));
  }

  section("cloud client account calls (stubbed fetch)");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-billing-"));
    const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    let nextStatus = 200;
    let nextBody: unknown = base;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null });
      if (url.endsWith("/auth/login")) return new Response(JSON.stringify({ accessToken: "tok", refreshToken: "ref", userId: "u1" }), { status: 200 });
      if (url.endsWith("/devices")) return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
      return new Response(JSON.stringify(nextBody), { status: nextStatus });
    }) as typeof fetch;
    try {
      const client = new CloudClient(() => ({}) as Config, path.join(dir, "cloud-session.json"));
      const before = await client.getBillingStatus();
      check("refused before sign-in, no request sent", before.ok === false && calls.length === 0);

      const login = await client.login("http://localhost:8787/", "a@example.com", "pw-pw-pw-pw");
      check("sign-in works against the stub", login.ok === true);
      calls.length = 0;

      const st = await client.getBillingStatus();
      check("billing status is read with the bearer token", st.ok && st.data?.plan === "pro" && calls[0].url === "http://127.0.0.1:8787/billing/status" && calls[0].auth === "Bearer tok", calls[0]);

      nextBody = { url: "https://checkout.stripe.com/x", trialDays: 7 };
      const co = await client.createCheckout("pro_monthly");
      check("checkout posts the chosen plan and returns the server address", co.ok && co.data?.url.startsWith("https://") && calls.at(-1)?.method === "POST" && (calls.at(-1)?.body as { plan: string }).plan === "pro_monthly", calls.at(-1));

      await client.changePassword("old-old-old", "new-new-new");
      check("password change posts both passwords to /me/password", calls.at(-1)?.url.endsWith("/me/password") === true && (calls.at(-1)?.body as { newPassword: string }).newPassword === "new-new-new");

      await client.deleteAccount("pw");
      const del = calls.at(-1);
      check("account deletion sends DELETE /me with the password and the explicit confirmation", del?.method === "DELETE" && del.url.endsWith("/me") && (del.body as { confirm: string }).confirm === "DELETE", del);

      nextStatus = 401;
      nextBody = { error: "unauthorized" };
      const dead = await client.getBillingStatus();
      const after = await client.getBillingStatus();
      check("a 401 clears the session so nothing keeps hammering a dead token", dead.ok === false && after.ok === false && (after.error ?? "").includes("Not authenticated"), after);
      client.stopAuthRefresh();
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
