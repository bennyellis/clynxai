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
  return `watch-test-${randomUUID()}@example.com`;
}

async function registerUser(): Promise<{ accessToken: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: uniqueEmail(), password: "correct-horse-battery" },
  });
  return res.json();
}

function baseWatch(overrides: Record<string, unknown> = {}) {
  return {
    name: "PS5 watch",
    searchPhrase: "ps5",
    matchKeywords: ["ps5", "playstation 5"],
    linkedProductId: null,
    minPriceUsd: null,
    maxPriceUsd: 300,
    minProfitUsd: 50,
    minDiscountPercent: null,
    maxListingAgeMinutes: 30,
    locationMode: "city",
    selectedState: null,
    selectedCityOrZip: "90210",
    searchRadiusMiles: 25,
    resolvedLocationUrl: null,
    resolvedLocationLabel: null,
    resolvedLocationCheckedAt: null,
    enabled: true,
    listingsSeenCount: 0,
    matchCount: 0,
    lastCheckedAt: null,
    lastActiveCheckAt: null,
    nextCheckAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("watches", () => {
  it("creates a watch via upsert and lists it back", async () => {
    const { accessToken } = await registerUser();
    const localId = randomUUID();

    const putRes = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch(),
    });
    expect(putRes.statusCode).toBe(201);
    const created = putRes.json();
    expect(created.applied).toBe(true);
    expect(created.watch.localId).toBe(localId);
    expect(created.watch.name).toBe("PS5 watch");

    const listRes = await app.inject({
      method: "GET",
      url: "/watches",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const { watches } = listRes.json();
    expect(watches).toHaveLength(1);
    expect(watches[0].localId).toBe(localId);
  });

  it("last-write-wins: an older updated_at is rejected, a newer one wins", async () => {
    const { accessToken } = await registerUser();
    const localId = randomUUID();
    const t0 = Date.now();

    const first = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ name: "Original", createdAt: t0, updatedAt: t0 }),
    });
    expect(first.statusCode).toBe(201);

    // Stale write — an OLDER updated_at than what's stored. Must be
    // rejected (applied: false) and the server's current version returned.
    const stale = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ name: "Stale edit", createdAt: t0, updatedAt: t0 - 5000 }),
    });
    expect(stale.statusCode).toBe(200);
    const staleBody = stale.json();
    expect(staleBody.applied).toBe(false);
    expect(staleBody.watch.name).toBe("Original");

    // Newer write — must win and overwrite the stored row.
    const t1 = t0 + 10_000;
    const newer = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ name: "Newer edit", createdAt: t0, updatedAt: t1 }),
    });
    expect(newer.statusCode).toBe(200);
    const newerBody = newer.json();
    expect(newerBody.applied).toBe(true);
    expect(newerBody.watch.name).toBe("Newer edit");

    const listRes = await app.inject({
      method: "GET",
      url: "/watches",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { watches } = listRes.json();
    expect(watches).toHaveLength(1);
    expect(watches[0].name).toBe("Newer edit");
  });

  it("isolates watches across users — user A cannot read/update/delete user B's watch", async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    const localId = randomUUID();

    const created = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: baseWatch({ name: "User B's watch" }),
    });
    expect(created.statusCode).toBe(201);
    const watchId = created.json().watch.id;
    expect(watchId).toBeTruthy();

    // A's list must not include B's watch at all.
    const listAsA = await app.inject({
      method: "GET",
      url: "/watches",
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(listAsA.json().watches).toHaveLength(0);

    // A upserting the SAME local id creates its own separate row (scoped
    // per-user), never touching B's.
    const upsertAsA = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: baseWatch({ name: "User A's watch" }),
    });
    expect(upsertAsA.statusCode).toBe(201);

    const listAsB = await app.inject({
      method: "GET",
      url: "/watches",
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(listAsB.json().watches).toHaveLength(1);
    expect(listAsB.json().watches[0].name).toBe("User B's watch");

    // User A must not be able to delete User B's watch by its server id.
    const deleteAsA = await app.inject({
      method: "DELETE",
      url: `/watches/${watchId}`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(deleteAsA.statusCode).toBe(403);

    // Nor append matches to it.
    const matchesAsA = await app.inject({
      method: "POST",
      url: `/watches/${watchId}/matches`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { matches: [] },
    });
    expect(matchesAsA.statusCode).toBe(403);

    // Nor read its match history.
    const readMatchesAsA = await app.inject({
      method: "GET",
      url: `/watches/${watchId}/matches`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(readMatchesAsA.statusCode).toBe(403);

    // B's watch must still be intact.
    const listAsBAfter = await app.inject({
      method: "GET",
      url: "/watches",
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(listAsBAfter.json().watches).toHaveLength(1);
  });

  it("supports since= filtering on GET /watches using the server-assigned revision cursor (Fix 3)", async () => {
    const { accessToken } = await registerUser();

    const first = await app.inject({
      method: "PUT",
      url: `/watches/${randomUUID()}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ name: "First" }),
    });
    const r1 = first.json().watch.revision;
    expect(typeof r1).toBe("number");

    const second = await app.inject({
      method: "PUT",
      url: `/watches/${randomUUID()}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ name: "Second" }),
    });
    const r2 = second.json().watch.revision;
    expect(r2).toBeGreaterThan(r1);

    // ?since=r1 must return only the row created after it.
    const sinceR1 = await app.inject({
      method: "GET",
      url: `/watches?since=${r1}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(sinceR1.statusCode).toBe(200);
    const sinceR1Body = sinceR1.json().watches;
    expect(sinceR1Body).toHaveLength(1);
    expect(sinceR1Body[0].name).toBe("Second");

    // ?since=0 must return both, in revision order.
    const sinceZero = await app.inject({
      method: "GET",
      url: `/watches?since=0`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const sinceZeroBody = sinceZero.json().watches;
    expect(sinceZeroBody).toHaveLength(2);
    expect(sinceZeroBody[0].name).toBe("First");
    expect(sinceZeroBody[1].name).toBe("Second");

    // An UPDATE must also bump the revision (BIGSERIAL doesn't auto-bump
    // on UPDATE — routes.ts explicitly sets it in the SET clause).
    const updateRes = await app.inject({
      method: "PUT",
      url: `/watches/${sinceZeroBody[0].localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({ name: "First, edited", updatedAt: Date.now() + 60_000 }),
    });
    expect(updateRes.json().watch.revision).toBeGreaterThan(r2);
  });

  it("Fix 4 — cloud no longer accepts/stores/returns the 8 desktop-local operational fields", async () => {
    const { accessToken } = await registerUser();
    const localId = randomUUID();

    const putRes = await app.inject({
      method: "PUT",
      url: `/watches/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseWatch({
        resolvedLocationUrl: "https://facebook.com/marketplace/some-city",
        resolvedLocationLabel: "Some City, ST",
        resolvedLocationCheckedAt: 12345,
        listingsSeenCount: 42,
        matchCount: 7,
        lastCheckedAt: 99999,
        lastActiveCheckAt: 88888,
        nextCheckAt: 111111,
      }),
    });
    expect(putRes.statusCode).toBe(201);
    const watch = putRes.json().watch;

    // None of the 8 operational fields should be echoed back at all.
    for (const field of [
      "resolvedLocationUrl",
      "resolvedLocationLabel",
      "resolvedLocationCheckedAt",
      "listingsSeenCount",
      "matchCount",
      "lastCheckedAt",
      "lastActiveCheckAt",
      "nextCheckAt",
    ]) {
      expect(watch).not.toHaveProperty(field);
    }

    // And a GET pull confirms the same — the response shape never
    // surfaces them, regardless of what was sent.
    const listRes = await app.inject({
      method: "GET",
      url: "/watches",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const pulled = listRes.json().watches.find((w: any) => w.localId === localId);
    expect(pulled).not.toHaveProperty("nextCheckAt");
    expect(pulled).not.toHaveProperty("matchCount");
  });
});
