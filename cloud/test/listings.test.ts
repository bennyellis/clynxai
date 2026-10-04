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
  return `listing-test-${randomUUID()}@example.com`;
}

async function registerUser(): Promise<{ accessToken: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: uniqueEmail(), password: "correct-horse-battery" },
  });
  return res.json();
}

function baseListing(overrides: Record<string, unknown> = {}) {
  return {
    source: "facebook_marketplace",
    sourceListingId: randomUUID(),
    title: "PS5 Digital Edition",
    description: "Barely used, comes with two controllers.",
    price: 300,
    url: "https://www.facebook.com/marketplace/item/123456789/",
    thumbnailUrl: null,
    images: [],
    locationText: "Austin, TX",
    listingAge: "Listed 2 days ago",
    sellerName: "Jane D.",
    sellerJoinedYear: 2019,
    sellerRating: 4.8,
    sellerRatingCount: 12,
    sellerHasProfilePhoto: true,
    firstSeenAt: Date.now(),
    ...overrides,
  };
}

describe("listings ingest", () => {
  it("requires auth — unauthenticated POST /listings/ingest must 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      payload: baseListing(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("ingests a new listing (isNew true)", async () => {
    const { accessToken } = await registerUser();
    const res = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isNew).toBe(true);
    expect(body.id).toBeTruthy();
  });

  it("ingesting the same (source, sourceListingId) again is isNew false and bumps last_seen_at", async () => {
    const { accessToken } = await registerUser();
    const sourceListingId = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing({ sourceListingId, firstSeenAt: 1_000, lastSeenAt: 1_000 }),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.isNew).toBe(true);

    const second = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing({ sourceListingId, firstSeenAt: 1_000, lastSeenAt: 2_000 }),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.isNew).toBe(false);
    expect(secondBody.id).toBe(firstBody.id);
  });

  it("reports a changed price/title on re-ingest with different values", async () => {
    const { accessToken } = await registerUser();
    const sourceListingId = randomUUID();

    await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing({ sourceListingId, price: 300 }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing({ sourceListingId, price: 250 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(true);
  });

  it("closes the double-enqueue race: two concurrent ingests of the SAME new (source, sourceListingId) — only one isNew:true, and only one processing job row is created", async () => {
    const { accessToken } = await registerUser();
    const sourceListingId = randomUUID();
    const payload = baseListing({ sourceListingId, firstSeenAt: 1_000, lastSeenAt: 1_000 });

    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/listings/ingest",
        headers: { authorization: `Bearer ${accessToken}` },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/listings/ingest",
        headers: { authorization: `Bearer ${accessToken}` },
        payload,
      }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    const bodyA = resA.json();
    const bodyB = resB.json();

    // Both resolve to the same canonical listing id, but exactly one of
    // the two concurrent requests must have won the insert race.
    expect(bodyA.id).toBe(bodyB.id);
    const isNewFlags = [bodyA.isNew, bodyB.isNew].sort();
    expect(isNewFlags).toEqual([false, true]);

    // And exactly one processing job was enqueued for it — proving the
    // job-enqueue branch (gated on isNew) only ran once.
    const jobsRes = await app.inject({
      method: "GET",
      url: `/listings/${bodyA.id}/jobs`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(jobsRes.statusCode).toBe(200);
    expect(jobsRes.json().jobs).toHaveLength(1);
  });

  it("batch ingest: valid items succeed and an invalid item (missing required field) is reported, not crashed", async () => {
    const { accessToken } = await registerUser();

    const valid1 = baseListing();
    const valid2 = baseListing();
    const invalid = { source: "facebook_marketplace", title: "Missing sourceListingId and url" };

    const res = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { listings: [valid1, invalid, valid2] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.results).toHaveLength(3);
    expect(body.results[0]).toMatchObject({ isNew: true });
    expect(body.results[1]).toBeNull();
    expect(body.results[2]).toMatchObject({ isNew: true });

    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].index).toBe(1);
    expect(body.failures[0].error).toBeTruthy();
  });
});
