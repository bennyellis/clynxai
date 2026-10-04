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
  return `product-test-${randomUUID()}@example.com`;
}

async function registerUser(): Promise<{ accessToken: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: uniqueEmail(), password: "correct-horse-battery" },
  });
  return res.json();
}

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    name: "PS5 Digital Edition",
    aiSummary: "A game console.",
    aiSummaryGeneratedAt: Date.now(),
    observedNotes: "",
    category: "Electronics",
    family: "PlayStation",
    resalePriceUsd: 350,
    resaleTimeToSell: "3 days",
    lookoutNotes: "Check for controllers",
    keepThumbnail: false,
    desiredPriceUsd: 250,
    hardCapAtDesiredPrice: false,
    prioritized: true,
    ebayAvgSoldPriceUsd: 340,
    ebayAvgRunTimeDays: 5,
    ebayAvgShippingUsd: 15,
    ebayCompsSampleSize: 10,
    ebayCompsCheckedAt: Date.now(),
    loading: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("products", () => {
  it("creates a product via upsert and lists it back", async () => {
    const { accessToken } = await registerUser();
    const localId = randomUUID();

    const putRes = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct(),
    });
    expect(putRes.statusCode).toBe(201);
    const created = putRes.json();
    expect(created.applied).toBe(true);
    expect(created.product.localId).toBe(localId);
    expect(created.product.name).toBe("PS5 Digital Edition");

    const listRes = await app.inject({
      method: "GET",
      url: "/products",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const { products } = listRes.json();
    expect(products).toHaveLength(1);
    expect(products[0].localId).toBe(localId);
  });

  it("upserting the same local id again updates it in place", async () => {
    const { accessToken } = await registerUser();
    const localId = randomUUID();
    const t0 = Date.now();

    await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "Original", createdAt: t0, updatedAt: t0 }),
    });

    const updateRes = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "Updated", createdAt: t0, updatedAt: t0 + 1000 }),
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().applied).toBe(true);

    const listRes = await app.inject({
      method: "GET",
      url: "/products",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { products } = listRes.json();
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Updated");
  });

  it("last-write-wins: an older updated_at is rejected, a newer one wins", async () => {
    const { accessToken } = await registerUser();
    const localId = randomUUID();
    const t0 = Date.now();

    const first = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "Original", createdAt: t0, updatedAt: t0 }),
    });
    expect(first.statusCode).toBe(201);

    // Stale write — an OLDER updated_at than what's stored. Must be
    // rejected (applied: false) and the server's current version returned.
    const stale = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "Stale edit", createdAt: t0, updatedAt: t0 - 5000 }),
    });
    expect(stale.statusCode).toBe(200);
    const staleBody = stale.json();
    expect(staleBody.applied).toBe(false);
    expect(staleBody.product.name).toBe("Original");

    // Newer write — must win and overwrite the stored row.
    const t1 = t0 + 10_000;
    const newer = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "Newer edit", createdAt: t0, updatedAt: t1 }),
    });
    expect(newer.statusCode).toBe(200);
    const newerBody = newer.json();
    expect(newerBody.applied).toBe(true);
    expect(newerBody.product.name).toBe("Newer edit");

    const listRes = await app.inject({
      method: "GET",
      url: "/products",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const { products } = listRes.json();
    expect(products).toHaveLength(1);
    expect(products[0].name).toBe("Newer edit");
  });

  it("isolates products across users — user A cannot read/update/delete user B's product", async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    const localId = randomUUID();

    const created = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${userB.accessToken}` },
      payload: baseProduct({ name: "User B's product" }),
    });
    expect(created.statusCode).toBe(201);
    const productId = created.json().product.id;
    expect(productId).toBeTruthy();

    // A's list must not include B's product at all.
    const listAsA = await app.inject({
      method: "GET",
      url: "/products",
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(listAsA.json().products).toHaveLength(0);

    // A upserting the SAME local id creates its own separate row (scoped
    // per-user), never touching B's.
    const upsertAsA = await app.inject({
      method: "PUT",
      url: `/products/${localId}`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
      payload: baseProduct({ name: "User A's product" }),
    });
    expect(upsertAsA.statusCode).toBe(201);

    const listAsB = await app.inject({
      method: "GET",
      url: "/products",
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(listAsB.json().products).toHaveLength(1);
    expect(listAsB.json().products[0].name).toBe("User B's product");

    // User A must not be able to delete User B's product by its server id.
    const deleteAsA = await app.inject({
      method: "DELETE",
      url: `/products/${productId}`,
      headers: { authorization: `Bearer ${userA.accessToken}` },
    });
    expect(deleteAsA.statusCode).toBe(403);

    // B's product must still be intact.
    const listAsBAfter = await app.inject({
      method: "GET",
      url: "/products",
      headers: { authorization: `Bearer ${userB.accessToken}` },
    });
    expect(listAsBAfter.json().products).toHaveLength(1);
  });

  it("supports since= filtering on GET /products using the server-assigned revision cursor (Fix 3)", async () => {
    const { accessToken } = await registerUser();

    const first = await app.inject({
      method: "PUT",
      url: `/products/${randomUUID()}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "First" }),
    });
    const r1 = first.json().product.revision;
    expect(typeof r1).toBe("number");

    const second = await app.inject({
      method: "PUT",
      url: `/products/${randomUUID()}`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseProduct({ name: "Second" }),
    });
    const r2 = second.json().product.revision;
    expect(r2).toBeGreaterThan(r1);

    const sinceR1 = await app.inject({
      method: "GET",
      url: `/products?since=${r1}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(sinceR1.statusCode).toBe(200);
    const sinceR1Body = sinceR1.json().products;
    expect(sinceR1Body).toHaveLength(1);
    expect(sinceR1Body[0].name).toBe("Second");

    const sinceZero = await app.inject({
      method: "GET",
      url: `/products?since=0`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const sinceZeroBody = sinceZero.json().products;
    expect(sinceZeroBody).toHaveLength(2);
    expect(sinceZeroBody[0].name).toBe("First");
    expect(sinceZeroBody[1].name).toBe("Second");
  });

  it("DELETE on a nonexistent product id returns 404", async () => {
    const { accessToken } = await registerUser();
    const res = await app.inject({
      method: "DELETE",
      url: `/products/${randomUUID()}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
