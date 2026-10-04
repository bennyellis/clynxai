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
  return `feedback-test-${randomUUID()}@example.com`;
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

async function ingestListing(accessToken: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; sourceListingId: string }> {
  const payload = baseListing(overrides);
  const res = await app.inject({
    method: "POST",
    url: "/listings/ingest",
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });
  expect(res.statusCode).toBe(200);
  return { id: res.json().id, sourceListingId: payload.sourceListingId as string };
}

describe("feedback", () => {
  it("creates feedback via upsert on an ingested listing and lists it back", async () => {
    const { accessToken } = await registerUser();
    const { id: listingId, sourceListingId } = await ingestListing(accessToken);

    const putRes = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "good", note: "Great price", updatedAt: Date.now() },
    });
    expect(putRes.statusCode).toBe(201);
    const created = putRes.json();
    expect(created.applied).toBe(true);
    expect(created.feedback.listingId).toBe(listingId);
    expect(created.feedback.verdict).toBe("good");

    const listRes = await app.inject({
      method: "GET",
      url: "/feedback",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const { feedback } = listRes.json();
    expect(feedback).toHaveLength(1);
    expect(feedback[0].listingId).toBe(listingId);
    // The join back to the local Facebook item id, so a puller can apply
    // this without a separate lookup round trip.
    expect(feedback[0].sourceListingId).toBe(sourceListingId);
  });

  it("PUT on a listing that hasn't been ingested returns 404", async () => {
    const { accessToken } = await registerUser();
    const res = await app.inject({
      method: "PUT",
      url: `/feedback/${randomUUID()}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "bad", note: null, updatedAt: Date.now() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("last-write-wins: an older updated_at is rejected, a newer one wins", async () => {
    const { accessToken } = await registerUser();
    const { id: listingId } = await ingestListing(accessToken);
    const t0 = Date.now();

    const first = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "good", note: "Original", updatedAt: t0 },
    });
    expect(first.statusCode).toBe(201);

    // Stale write — an OLDER updated_at than what's stored. Must be
    // rejected (applied: false) and the server's current version returned.
    const stale = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "bad", note: "Stale edit", updatedAt: t0 - 5000 },
    });
    expect(stale.statusCode).toBe(200);
    const staleBody = stale.json();
    expect(staleBody.applied).toBe(false);
    expect(staleBody.feedback.note).toBe("Original");

    // Newer write — must win and overwrite the stored row.
    const t1 = t0 + 10_000;
    const newer = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "bad", note: "Newer edit", updatedAt: t1 },
    });
    expect(newer.statusCode).toBe(200);
    const newerBody = newer.json();
    expect(newerBody.applied).toBe(true);
    expect(newerBody.feedback.verdict).toBe("bad");
    expect(newerBody.feedback.note).toBe("Newer edit");

    const listRes = await app.inject({
      method: "GET",
      url: "/feedback",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { feedback } = listRes.json();
    expect(feedback).toHaveLength(1);
    expect(feedback[0].note).toBe("Newer edit");
  });

  it("isolates feedback across users — user A's list never includes user B's rows, and A cannot delete B's feedback", async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    // Listings are a shared cache — any authenticated user can ingest, but
    // feedback on it is still personal per user.
    const { id: listingId } = await ingestListing(userB.accessToken);

    const createdAsB = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: { verdict: "good", note: "User B's take", updatedAt: Date.now() },
    });
    expect(createdAsB.statusCode).toBe(201);

    // A's list must not include B's feedback at all.
    const listAsA = await app.inject({
      method: "GET",
      url: "/feedback",
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(listAsA.json().feedback).toHaveLength(0);

    // A upserting feedback on the SAME listing creates its own separate
    // row (scoped per-user), never touching B's.
    const createdAsA = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: { verdict: "bad", note: "User A's take", updatedAt: Date.now() },
    });
    expect(createdAsA.statusCode).toBe(201);

    const listAsB = await app.inject({
      method: "GET",
      url: "/feedback",
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(listAsB.json().feedback).toHaveLength(1);
    expect(listAsB.json().feedback[0].note).toBe("User B's take");

    // User A must not be able to delete User B's feedback.
    const deleteAsA = await app.inject({
      method: "DELETE",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    // A has its OWN feedback row on this same listingId, so this deletes
    // A's own row (200), not B's — proving the delete is scoped strictly
    // to the caller's own (user, listing) row, never reaching B's.
    expect(deleteAsA.statusCode).toBe(200);

    const listAsBAfter = await app.inject({
      method: "GET",
      url: "/feedback",
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(listAsBAfter.json().feedback).toHaveLength(1);
    expect(listAsBAfter.json().feedback[0].note).toBe("User B's take");
  });

  it("deleting feedback that doesn't exist for this user returns 404", async () => {
    const { accessToken } = await registerUser();
    const { id: listingId } = await ingestListing(accessToken);
    const res = await app.inject({
      method: "DELETE",
      url: `/feedback/${listingId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("supports since= filtering on GET /feedback using the server-assigned revision cursor (Fix 3)", async () => {
    const { accessToken } = await registerUser();
    const { id: listingId1 } = await ingestListing(accessToken);
    const { id: listingId2 } = await ingestListing(accessToken);

    const first = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId1}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "good", note: null, updatedAt: 1_000 },
    });
    const r1 = first.json().feedback.revision;
    expect(typeof r1).toBe("number");

    const second = await app.inject({
      method: "PUT",
      url: `/feedback/${listingId2}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { verdict: "bad", note: null, updatedAt: 2_000 },
    });
    const r2 = second.json().feedback.revision;
    expect(r2).toBeGreaterThan(r1);

    // ?since=r1 must return only the row created after it.
    const sinceR1 = await app.inject({
      method: "GET",
      url: `/feedback?since=${r1}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(sinceR1.statusCode).toBe(200);
    const sinceR1Body = sinceR1.json().feedback;
    expect(sinceR1Body).toHaveLength(1);
    expect(sinceR1Body[0].listingId).toBe(listingId2);

    // ?since=0 (or omitted) must return both, in revision order.
    const sinceZero = await app.inject({
      method: "GET",
      url: `/feedback?since=0`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const sinceZeroBody = sinceZero.json().feedback;
    expect(sinceZeroBody).toHaveLength(2);
    expect(sinceZeroBody[0].listingId).toBe(listingId1);
    expect(sinceZeroBody[1].listingId).toBe(listingId2);
  });
});
