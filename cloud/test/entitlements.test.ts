import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
  return `entitlements-test-${randomUUID()}@example.com`;
}

async function registerUser(): Promise<{ accessToken: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: uniqueEmail(), password: "correct-horse-battery" },
  });
  return res.json();
}

describe("entitlements", () => {
  it("defaults a new user to the free plan and returns free-tier limits", async () => {
    const { accessToken } = await registerUser();

    const res = await app.inject({
      method: "GET",
      url: "/me/entitlements",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.plan).toBe("free");
    expect(body.entitlements).toEqual({
      maxWatches: 5,
      maxDevices: 2,
      maxSearchItems: 10,
      aiResearchEnabled: false,
    });
  });

  it("rejects unauthenticated access", async () => {
    const res = await app.inject({ method: "GET", url: "/me/entitlements" });
    expect(res.statusCode).toBe(401);
  });

  it("reflects a user's plan after it changes (no route exists to change it yet — no billing exists — so this updates the column directly)", async () => {
    const { accessToken, userId } = await registerUser();

    await pool.query("UPDATE users SET plan = $1 WHERE id = $2", ["pro", userId]);

    const res = await app.inject({
      method: "GET",
      url: "/me/entitlements",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.plan).toBe("pro");
    expect(body.entitlements).toEqual({
      maxWatches: null,
      maxDevices: null,
      maxSearchItems: null,
      aiResearchEnabled: true,
    });
  });
});
