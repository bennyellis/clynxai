import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import { closePool, pool } from "../src/db/client.js";
import { hit, peek, reset } from "../src/security/rateLimit.js";
import { clampChatBody, clampImageBody } from "../src/ai/routes.js";

let app: FastifyInstance;
const realFetch = globalThis.fetch;
let openaiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let openaiStatus = 200;
let openaiQueue: number[] = [];

beforeEach(async () => {
  openaiCalls = [];
  openaiStatus = 200;
  openaiQueue = [];
  config.enforceEntitlements = false;
  // Only calls to api.openai.com are intercepted; everything else (there is none from the API under test) would use the real fetch.
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      openaiCalls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      const status = openaiQueue.length ? (openaiQueue.shift() as number) : openaiStatus;
      return new Response(JSON.stringify({ id: "x", usage: { prompt_tokens: 11, completion_tokens: 22 }, choices: [{ message: { content: "hi" } }] }), { status, headers: { "content-type": "application/json" } });
    }
    return realFetch(url as string, init as RequestInit);
  }) as typeof fetch;
  app = buildApp({ billing: null });
  await app.ready();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  config.enforceEntitlements = false;
});
afterAll(async () => {
  await app?.close();
  await closePool();
});

const email = () => `sec-${randomUUID()}@example.com`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function register(e = email(), password = "correct-horse-battery"): Promise<{ accessToken: string; refreshToken: string; userId: string; email: string }> {
  const r = (await app.inject({ method: "POST", url: "/auth/register", payload: { email: e, password } })).json();
  return { ...r, email: e };
}

describe("rate limiter", () => {
  it("counts per key and per window, and peek does not count", async () => {
    const k = `unit:${randomUUID()}`;
    expect((await hit(k, 3, 60)).allowed).toBe(true);
    expect((await hit(k, 3, 60)).allowed).toBe(true);
    expect((await hit(k, 3, 60)).allowed).toBe(true);
    const fourth = await hit(k, 3, 60);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);
    expect((await peek(k, 3)).blocked).toBe(true);
    expect((await peek(`unit:${randomUUID()}`, 3)).blocked).toBe(false);
    await reset(k);
    expect((await peek(k, 3)).blocked).toBe(false);
  });
});

describe("login and registration", () => {
  it("emails are case-insensitive: the same address in another case is the same account", async () => {
    const e = `Mixed.Case-${randomUUID()}@Example.com`;
    const a = await register(e);
    expect(a.userId).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/auth/register", payload: { email: e.toLowerCase(), password: "correct-horse-battery" } })).statusCode).toBe(409);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: e.toUpperCase(), password: "correct-horse-battery" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().userId).toBe(a.userId);
  });

  it("repeated wrong passwords are throttled per address, and the right password still works elsewhere", async () => {
    const { email: e } = await register();
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: e, password: "wrong-password-x" } })).statusCode;
    expect(last).toBe(401);
    const blocked = await app.inject({ method: "POST", url: "/auth/login", payload: { email: e, password: "correct-horse-battery" } });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    const other = await register();
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: other.email, password: "correct-horse-battery" } })).statusCode).toBe(200);
  });

  it("a huge password is refused before it can cost a password hash", async () => {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email: email(), password: "x".repeat(5000) } });
    expect(r.statusCode).toBe(400);
  });

  it("unknown and wrong-password logins look identical", async () => {
    const { email: e } = await register();
    const a = await app.inject({ method: "POST", url: "/auth/login", payload: { email: e, password: "wrong-password-1" } });
    const b = await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(), password: "wrong-password-1" } });
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json()).toEqual(b.json());
  });
});

describe("account management", () => {
  it("a password change needs the current password and signs every device out", async () => {
    const { accessToken, refreshToken, email: e } = await register();
    expect((await app.inject({ method: "POST", url: "/me/password", headers: auth(accessToken), payload: { currentPassword: "nope-nope-nope", newPassword: "another-strong-one" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/me/password", headers: auth(accessToken), payload: { currentPassword: "correct-horse-battery", newPassword: "another-strong-one" } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: e, password: "correct-horse-battery" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: e, password: "another-strong-one" } })).statusCode).toBe(200);
  });

  it("deleting an account needs the password and the word DELETE, and removes everything", async () => {
    const { accessToken, userId } = await register();
    await app.inject({ method: "POST", url: "/devices/register", headers: auth(accessToken), payload: { platform: "win32", clientVersion: "1.0.0" } });
    expect((await app.inject({ method: "DELETE", url: "/me", headers: auth(accessToken), payload: { password: "correct-horse-battery" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/me", headers: auth(accessToken), payload: { password: "wrong-password-1", confirm: "DELETE" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/me", headers: auth(accessToken), payload: { password: "correct-horse-battery", confirm: "DELETE" } })).statusCode).toBe(200);
    for (const t of ["users", "devices", "refresh_tokens"]) {
      expect((await pool.query(`SELECT 1 FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = $1`, [userId])).rows.length).toBe(0);
    }
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(accessToken) })).statusCode).toBe(404);
  });

  it("GET /me is the caller's own account only", async () => {
    const a = await register();
    const b = await register();
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(a.accessToken) })).json().email).toBe(a.email);
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(b.accessToken) })).json().email).toBe(b.email);
  });
});

describe("the AI proxy", () => {
  const chat = (token: string, body: Record<string, unknown>) => app.inject({ method: "POST", url: "/ai/chat/completions", headers: auth(token), payload: body });

  it("needs sign-in", async () => {
    expect((await app.inject({ method: "POST", url: "/ai/chat/completions", payload: { model: "gpt-5-mini" } })).statusCode).toBe(401);
  });

  it("forwards an allowed model, meters it, and never stores prompt text", async () => {
    const { accessToken, userId } = await register();
    const r = await chat(accessToken, { model: "gpt-5-mini", messages: [{ role: "user", content: "secret prompt text" }] });
    expect(r.statusCode).toBe(200);
    expect(openaiCalls).toHaveLength(1);
    const u = await pool.query("SELECT kind, model, status, prompt_tokens, completion_tokens FROM ai_usage WHERE user_id = $1", [userId]);
    expect(u.rows).toEqual([{ kind: "chat", model: "gpt-5-mini", status: 200, prompt_tokens: 11, completion_tokens: 22 }]);
    expect(JSON.stringify((await pool.query("SELECT * FROM ai_usage WHERE user_id = $1", [userId])).rows)).not.toContain("secret prompt text");
  });

  it("refuses a model that is not allow-listed, and a body that is not an object", async () => {
    const { accessToken } = await register();
    const r = await chat(accessToken, { model: "gpt-9-ultra-expensive", messages: [] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("model_not_allowed");
    expect((await app.inject({ method: "POST", url: "/ai/chat/completions", headers: { ...auth(accessToken), "content-type": "application/json" }, payload: "[1,2]" })).statusCode).toBe(400);
    expect(openaiCalls).toHaveLength(0);
  });

  it("caps output tokens and the number of choices before forwarding", async () => {
    const { accessToken } = await register();
    await chat(accessToken, { model: "gpt-5-mini", max_completion_tokens: 9_999_999, n: 8, messages: [] });
    expect(openaiCalls[0].body.max_completion_tokens).toBe(config.aiMaxOutputTokens);
    expect(openaiCalls[0].body.n).toBe(1);
    expect(clampChatBody({ max_tokens: 5 }, 100).max_tokens).toBe(5);
    expect(clampImageBody({ n: 10 }).n).toBe(2);
  });

  it("retries a rate-limit or server error from the provider with backoff, then answers", async () => {
    const { accessToken } = await register();
    openaiQueue = [429, 503];
    const r = await chat(accessToken, { model: "gpt-5-mini", messages: [] });
    expect(r.statusCode).toBe(200);
    expect(openaiCalls).toHaveLength(3);
  });

  it("answers 504 when the provider is unreachable", async () => {
    const { accessToken } = await register();
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).startsWith("https://api.openai.com/")) throw new Error("network down");
      return realFetch(url as string);
    }) as typeof fetch;
    const r = await chat(accessToken, { model: "gpt-5-mini", messages: [] });
    expect(r.statusCode).toBe(504);
  }, 15000);

  it("has a daily quota by plan, enforced only when entitlements are enforced; usage is always metered", async () => {
    const { accessToken, userId } = await register();
    await pool.query("INSERT INTO ai_usage (user_id, kind, model, status) SELECT $1, 'chat', 'gpt-5-mini', 200 FROM generate_series(1, 150)", [userId]);
    expect((await chat(accessToken, { model: "gpt-5-mini", messages: [] })).statusCode).toBe(200); // not enforcing: allowed
    config.enforceEntitlements = true;
    const limited = await chat(accessToken, { model: "gpt-5-mini", messages: [] });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "ai_daily_limit", plan: "free", limit: 150 });
    await pool.query("UPDATE users SET plan = 'pro' WHERE id = $1", [userId]);
    expect((await chat(accessToken, { model: "gpt-5-mini", messages: [] })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/ai/images/generations", headers: auth(accessToken), payload: { model: "gpt-image-1", prompt: "x" } })).statusCode).toBe(200);
  });
});

describe("plan limits (when enforced)", () => {
  it("devices: the free plan allows 2; a third is refused with a plan_limit answer; removing one frees a slot", async () => {
    config.enforceEntitlements = true;
    const { accessToken } = await register();
    const reg = () => app.inject({ method: "POST", url: "/devices/register", headers: auth(accessToken), payload: { platform: "win32", clientVersion: "1.0.0" } });
    const first = await reg();
    expect(first.statusCode).toBe(201);
    expect((await reg()).statusCode).toBe(201);
    const third = await reg();
    expect(third.statusCode).toBe(402);
    expect(third.json()).toMatchObject({ error: "plan_limit", limit: "maxDevices", plan: "free", max: 2 });
    expect((await app.inject({ method: "DELETE", url: `/devices/${first.json().id}`, headers: auth(accessToken) })).statusCode).toBe(200);
    expect((await reg()).statusCode).toBe(201);
  });

  it("devices: nothing is refused while entitlements are not enforced", async () => {
    const { accessToken } = await register();
    for (let i = 0; i < 4; i++) expect((await app.inject({ method: "POST", url: "/devices/register", headers: auth(accessToken), payload: { platform: "win32", clientVersion: "1.0.0" } })).statusCode).toBe(201);
  });

  it("a user cannot delete another user's device", async () => {
    const a = await register();
    const b = await register();
    const dev = (await app.inject({ method: "POST", url: "/devices/register", headers: auth(a.accessToken), payload: { platform: "win32", clientVersion: "1.0.0" } })).json().id;
    expect((await app.inject({ method: "DELETE", url: `/devices/${dev}`, headers: auth(b.accessToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/devices/${dev}`, headers: auth(a.accessToken) })).statusCode).toBe(200);
  });

  it("watches: a free plan syncs 5; the sixth is refused, an update to an existing one is not", async () => {
    config.enforceEntitlements = true;
    const { accessToken } = await register();
    const body = (over: Record<string, unknown> = {}) => ({
      name: "w", searchPhrase: "ps5", matchKeywords: ["ps5"], linkedProductId: null, minPriceUsd: null, maxPriceUsd: 300, minProfitUsd: 50, minDiscountPercent: null, maxListingAgeMinutes: 30,
      locationMode: "city", selectedState: null, selectedCityOrZip: "90210", searchRadiusMiles: 25, resolvedLocationUrl: null, resolvedLocationLabel: null, resolvedLocationCheckedAt: null, enabled: true,
      listingsSeenCount: 0, matchCount: 0, lastCheckedAt: null, lastActiveCheckAt: null, nextCheckAt: null, createdAt: Date.now(), updatedAt: Date.now(), ...over,
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      expect((await app.inject({ method: "PUT", url: `/watches/${id}`, headers: auth(accessToken), payload: body() })).statusCode).toBe(201);
    }
    const sixth = await app.inject({ method: "PUT", url: `/watches/${randomUUID()}`, headers: auth(accessToken), payload: body() });
    expect(sixth.statusCode).toBe(402);
    expect(sixth.json()).toMatchObject({ error: "plan_limit", limit: "maxWatches" });
    expect((await app.inject({ method: "PUT", url: `/watches/${ids[0]}`, headers: auth(accessToken), payload: body({ name: "renamed", updatedAt: Date.now() + 1000 }) })).statusCode).toBe(200);
  });
});

describe("health, headers and errors", () => {
  it("readiness reports the database and Redis", async () => {
    const r = await app.inject({ method: "GET", url: "/health/ready" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ready", checks: { database: "ok", redis: "ok" } });
  });

  it("metrics are not served without a token configured, and need it when configured", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    const saved = config.metricsToken;
    config.metricsToken = "m".repeat(20);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${"m".repeat(20)}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ requests: expect.any(Number), byClass: expect.any(Object) });
    config.metricsToken = saved;
  });

  it("every answer carries the hardening headers and is never cached", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("an unexpected failure is answered generically, without internals", async () => {
    const a = buildApp({ billing: null });
    a.get("/boom", async () => {
      throw new Error("SELECT * FROM secret_table failed at /srv/app/db.ts:42");
    });
    await a.ready();
    const r = await a.inject({ method: "GET", url: "/boom" });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "Internal error" });
    expect(r.body).not.toContain("secret_table");
    await a.close();
  });
});
