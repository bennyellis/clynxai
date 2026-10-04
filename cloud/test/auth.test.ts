import { describe, it, expect, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { pool, closePool } from "../src/db/client.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closePool();
});

function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

describe("auth", () => {
  it("registers a new user and returns tokens", async () => {
    const email = uniqueEmail();
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.userId).toBeTruthy();
  });

  it("rejects registering the same email twice", async () => {
    const email = uniqueEmail();
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse-battery" } });
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "another-password" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("logs in with correct credentials", async () => {
    const email = uniqueEmail();
    const password = "correct-horse-battery";
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password } });

    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it("rejects login with wrong password, generically", async () => {
    const email = uniqueEmail();
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse-battery" } });

    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "wrong-password" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid credentials");
  });

  it("rejects login for a nonexistent email with the same generic error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: uniqueEmail(), password: "whatever12345" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid credentials");
  });

  it("rotates a refresh token and revokes the old one", async () => {
    const email = uniqueEmail();
    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery" },
    });
    const { refreshToken } = registerRes.json();

    const refreshRes = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(refreshRes.statusCode).toBe(200);
    const rotated = refreshRes.json();
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(refreshToken);
    // The desktop app's per-user data isolation (Clynx multi-user login)
    // needs to know WHICH user a silent-relaunch refresh belongs to without
    // decoding the JWT itself — register/login already return a plain
    // userId field; refresh must too.
    expect(rotated.userId).toBeTruthy();

    // The old token is now revoked — reusing it must fail AND (per
    // reuse-detection) invalidate the new one it was rotated into too.
    const reuseRes = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(reuseRes.statusCode).toBe(401);

    const rotatedAgainRes = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(rotatedAgainRes.statusCode).toBe(401);
  });

  it("closes the rotation race: two concurrent refreshes of the SAME token — exactly one wins, and the winner's new token is revoked too (revoke-all fired)", async () => {
    const email = uniqueEmail();
    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery" },
    });
    const { refreshToken } = registerRes.json();

    // Fire both requests concurrently against the SAME refresh token.
    const [resA, resB] = await Promise.all([
      app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } }),
      app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([200, 401]);

    const winner = resA.statusCode === 200 ? resA : resB;
    const winnerBody = winner.json();
    expect(winnerBody.accessToken).toBeTruthy();
    expect(winnerBody.refreshToken).toBeTruthy();

    // Proving revoke-all fired: the token minted by the winning request
    // must ALSO now be revoked, since the loser's presentation of the
    // already-consumed original token was treated as reuse.
    const followUp = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: winnerBody.refreshToken },
    });
    expect(followUp.statusCode).toBe(401);
  });

  it("logs out and revokes the refresh token", async () => {
    const email = uniqueEmail();
    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery" },
    });
    const { refreshToken } = registerRes.json();

    const logoutRes = await app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
    expect(logoutRes.statusCode).toBe(200);

    const refreshRes = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    expect(refreshRes.statusCode).toBe(401);
  });
});

describe("health", () => {
  it("reports ok when the database is reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

// Keep the pool import alive for potential direct-query assertions later.
void pool;
