import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { closePool } from "../src/db/client.js";

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
  return `device-test-${randomUUID()}@example.com`;
}

async function registerUser(): Promise<{ accessToken: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: uniqueEmail(), password: "correct-horse-battery" },
  });
  return res.json();
}

describe("devices", () => {
  it("registers a device for the authenticated user and heartbeats it", async () => {
    const { accessToken } = await registerUser();

    const registerRes = await app.inject({
      method: "POST",
      url: "/devices/register",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { platform: "windows", clientVersion: "0.2.0" },
    });
    expect(registerRes.statusCode).toBe(201);
    const { id } = registerRes.json();
    expect(id).toBeTruthy();

    const heartbeatRes = await app.inject({
      method: "POST",
      url: `/devices/${id}/heartbeat`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(heartbeatRes.statusCode).toBe(200);
  });

  it("lists only the authenticated user's own devices", async () => {
    const userA = await registerUser();
    const userB = await registerUser();

    const deviceA = await app.inject({
      method: "POST",
      url: "/devices/register",
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { platform: "windows", clientVersion: "0.2.0" },
    });
    const deviceAId = deviceA.json().id;

    await app.inject({
      method: "POST",
      url: "/devices/register",
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { platform: "mac", clientVersion: "0.2.0" },
    });

    const listRes = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const { devices } = listRes.json();
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe(deviceAId);
  });

  it("rejects heartbeating another user's device (403)", async () => {
    const userA = await registerUser();
    const userB = await registerUser();

    const deviceA = await app.inject({
      method: "POST",
      url: "/devices/register",
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { platform: "windows", clientVersion: "0.2.0" },
    });
    const deviceAId = deviceA.json().id;

    const heartbeatAsB = await app.inject({
      method: "POST",
      url: `/devices/${deviceAId}/heartbeat`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(heartbeatAsB.statusCode).toBe(403);
  });

  it("returns 404 heartbeating a nonexistent device", async () => {
    const { accessToken } = await registerUser();
    const res = await app.inject({
      method: "POST",
      url: `/devices/${randomUUID()}/heartbeat`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unauthenticated access", async () => {
    const res = await app.inject({ method: "GET", url: "/devices" });
    expect(res.statusCode).toBe(401);
  });
});
