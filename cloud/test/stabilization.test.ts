import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { redisFast, redisAvailable, noteRedisOk, withTimeout } from "../src/queue/redisGuard.js";
import { hit, peek } from "../src/security/rateLimit.js";
import { asWeb, makeAdmin, makeOwner, signup, webLogin, type WebUser } from "./helpers/web.js";

// Beta 6 stabilization: deletes with a JSON content type and no body, the Owner-only search planner, Redis and Postgres outages that must not hang or crash the API.
let app: FastifyInstance;
let owner: WebUser;
const PW = "correct-horse-battery";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function user() {
  const email = `stab-${randomUUID()}@example.com`;
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PW } });
  const b = r.json();
  return { token: b.accessToken as string, id: b.userId as string, email };
}

beforeAll(async () => {
  app = buildApp({ billing: null });
  await app.ready();
  const o = await signup(app);
  await makeOwner(o.id);
  owner = await webLogin(app, o.email);
});
afterAll(async () => {
  await app?.close();
  await closePool();
});

describe("DELETE (and any request) with a JSON content type and no body", () => {
  const J = { "content-type": "application/json" };

  it("deleting your own Watch, Product, Feedback and Device works when the app sends a JSON content type with no body (what Beta 2 to 5 do)", async () => {
    const u = await user();
    const w = await app.inject({ method: "PUT", url: `/watches/${randomUUID()}`, headers: bearer(u.token), payload: { name: "w", searchPhrase: "p", matchKeywords: [], locationMode: "country", enabled: true, createdAt: 1, updatedAt: 1 } });
    const p = await app.inject({ method: "PUT", url: `/products/${randomUUID()}`, headers: bearer(u.token), payload: { name: "p", createdAt: 1, updatedAt: 1 } });
    const d = await app.inject({ method: "POST", url: "/devices/register", headers: bearer(u.token), payload: { platform: "windows", clientVersion: "0.3.0-beta.5" } });
    const listing = await app.inject({ method: "POST", url: "/listings/ingest", headers: bearer(u.token), payload: { source: "facebook", sourceListingId: `L-${randomUUID()}`, title: "t", url: "https://x.test/1", firstSeenAt: 1 } });
    await app.inject({ method: "PUT", url: `/feedback/${listing.json().id}`, headers: bearer(u.token), payload: { verdict: "good", updatedAt: 5 } });
    for (const [url, label] of [[`/watches/${w.json().watch.id}`, "watch"], [`/products/${p.json().product.id}`, "product"], [`/feedback/${listing.json().id}`, "feedback"], [`/devices/${d.json().id}`, "device"]] as const) {
      const r = await app.inject({ method: "DELETE", url, headers: { ...bearer(u.token), ...J } });
      expect([label, r.statusCode]).toEqual([label, 200]);
    }
    expect((await app.inject({ method: "GET", url: "/watches", headers: bearer(u.token) })).json().watches).toHaveLength(0);
    // and without the content type it is the same
    expect((await app.inject({ method: "DELETE", url: `/watches/${randomUUID()}`, headers: bearer(u.token) })).statusCode).toBe(404);
  });

  it("someone else's id still gets 403/404, never 400 and never a delete", async () => {
    const a = await user();
    const b = await user();
    const w = await app.inject({ method: "PUT", url: `/watches/${randomUUID()}`, headers: bearer(a.token), payload: { name: "w", searchPhrase: "p", matchKeywords: [], locationMode: "country", enabled: true, createdAt: 1, updatedAt: 1 } });
    const r = await app.inject({ method: "DELETE", url: `/watches/${w.json().watch.id}`, headers: { ...bearer(b.token), ...J } });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/watches", headers: bearer(a.token) })).json().watches).toHaveLength(1);
  });

  it("everything else about JSON bodies is unchanged: a good body works, broken JSON is a clear 400, prototype poisoning is refused, an empty body where one is needed is a 400 from validation", async () => {
    const u = await user();
    const ok = await app.inject({ method: "POST", url: "/auth/login", headers: J, payload: JSON.stringify({ email: u.email, password: PW }) });
    expect(ok.statusCode).toBe(200);
    const broken = await app.inject({ method: "POST", url: "/auth/login", headers: J, payload: "{ not json" });
    expect(broken.statusCode).toBe(400);
    const poisoned = await app.inject({ method: "POST", url: "/auth/login", headers: J, payload: '{"email":"a@b.co","password":"x","__proto__":{"admin":true}}' });
    expect(poisoned.statusCode).toBe(400);
    const empty = await app.inject({ method: "POST", url: "/auth/login", headers: J });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("Invalid request body");
  });

  it("the billing webhook still receives the raw body for its signature check", async () => {
    const r = await app.inject({ method: "POST", url: "/billing/webhook", headers: { ...J, "stripe-signature": "t=1,v1=00" }, payload: '{"type":"x"}' });
    expect([400, 503]).toContain(r.statusCode); // refused for the signature (or billing not configured), not for the body parser
    expect(JSON.stringify(r.json())).not.toMatch(/Body cannot be empty|not valid JSON/);
  });
});

describe("F-01: the search planner is the Owner's alone", () => {
  it("an ordinary customer (bearer or website session) and a plain administrator are refused; the Owner sees the groups", async () => {
    const u = await user();
    const phrase = `zz-secret-${randomUUID()}`;
    await app.inject({ method: "PUT", url: `/watches/${randomUUID()}`, headers: bearer(u.token), payload: { name: "w", searchPhrase: phrase, matchKeywords: [], locationMode: "country", enabled: true, createdAt: 1, updatedAt: 1 } });
    const web = await signup(app);
    const adm = await signup(app);
    await makeAdmin(adm.id);
    for (const [method, url] of [["POST", "/search-planner/aggregate"], ["GET", "/search-planner/demand"]] as const) {
      expect((await app.inject({ method, url, headers: bearer(u.token) })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: asWeb(web) })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: asWeb(adm) })).statusCode).toBe(403);
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/search-planner/aggregate", headers: asWeb(owner) })).json().groups.some((g: { phraseNormalized: string }) => g.phraseNormalized === phrase)).toBe(true);
    const demand = await app.inject({ method: "GET", url: "/search-planner/demand", headers: asWeb(owner) });
    expect(demand.statusCode).toBe(200);
    expect(demand.body).toContain(phrase);
    // what the ordinary customer got instead contains nothing of anyone's
    expect((await app.inject({ method: "GET", url: "/search-planner/demand", headers: bearer(u.token) })).body).not.toContain(phrase);
  });
});

describe("F-07: a Redis outage does not hang requests", () => {
  it("when Redis commands fail, the rate limiter answers at once from memory and stops asking Redis for a few seconds (circuit breaker)", async () => {
    const spy = vi.spyOn(redisFast, "incr").mockRejectedValue(new Error("Command timed out"));
    try {
      const key = `outage-${randomUUID()}`;
      const t0 = Date.now();
      const first = await hit(key, 3, 60);
      expect(first.allowed).toBe(true);
      expect(Date.now() - t0).toBeLessThan(200);
      expect(redisAvailable()).toBe(false);
      const calls = spy.mock.calls.length;
      for (let i = 0; i < 5; i++) await hit(key, 3, 60);
      expect(spy.mock.calls.length).toBe(calls); // the breaker is open: Redis is not asked again
      const sixth = await hit(key, 3, 60);
      expect(sixth.allowed).toBe(false); // the in-process fallback still limits (3 per window)
      expect((await peek(key, 3)).blocked).toBe(true);
    } finally {
      spy.mockRestore();
      noteRedisOk();
    }
  });

  it("sign-in keeps working while Redis commands are failing, and answers quickly", async () => {
    const u = await user();
    const spy = vi.spyOn(redisFast, "get").mockRejectedValue(new Error("Command timed out"));
    const spy2 = vi.spyOn(redisFast, "incr").mockRejectedValue(new Error("Command timed out"));
    try {
      const t0 = Date.now();
      const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PW } });
      expect(r.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
      const bad = await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: "wrong-password-1" } });
      expect(bad.statusCode).toBe(401);
    } finally {
      spy.mockRestore();
      spy2.mockRestore();
      noteRedisOk();
    }
  });

  it("an upload of listings is not held up by a queue that cannot be reached (the wait is capped)", async () => {
    const never = new Promise<never>(() => undefined);
    const t0 = Date.now();
    await expect(withTimeout(never, 80, "queueing the listing")).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(500);
    await expect(withTimeout(Promise.resolve(7), 80, "x")).resolves.toBe(7);
  });

  it("/health/ready reports Redis down instead of waiting, when Redis commands fail", async () => {
    const spy = vi.spyOn(redisFast, "ping").mockRejectedValue(new Error("Command timed out"));
    try {
      const t0 = Date.now();
      const r = await app.inject({ method: "GET", url: "/health/ready" });
      expect(r.statusCode).toBe(503);
      expect(r.json().checks).toEqual({ database: "ok", redis: "down" });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("F-06: a lost database connection does not crash the process", () => {
  it("the pool has an error handler, and an idle-connection error is absorbed", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(log.mock.calls.some((c) => String(c[0]).includes("[db]"))).toBe(true);
    log.mockRestore();
  });

  it("the pool gives up connecting after a bounded time instead of waiting forever", () => {
    const options = (pool as unknown as { options: { connectionTimeoutMillis?: number } }).options;
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(options.connectionTimeoutMillis).toBeLessThanOrEqual(10_000);
  });

  it("the database still works after the error", async () => {
    expect((await pool.query("SELECT 1 AS one")).rows[0].one).toBe(1);
  });
});
