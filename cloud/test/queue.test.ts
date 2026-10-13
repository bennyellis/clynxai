import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { closePool } from "../src/db/client.js";
import { createListingProcessingWorker } from "../src/queue/worker.js";
import { redisConnection } from "../src/queue/connection.js";
import { listingProcessingQueue } from "../src/queue/listingProcessingQueue.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await listingProcessingQueue.close();
  await redisConnection.quit();
  await closePool();
});

function uniqueEmail(): string {
  return `queue-test-${randomUUID()}@example.com`;
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
    price: 300,
    url: "https://www.facebook.com/marketplace/item/123456789/",
    images: [],
    firstSeenAt: Date.now(),
    ...overrides,
  };
}

async function getJobs(accessToken: string, listingId: string): Promise<any[]> {
  const res = await app.inject({
    method: "GET",
    url: `/listings/${listingId}/jobs`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().jobs;
}

async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 3000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("pollUntil: timed out");
}

describe("listing processing job queue", () => {
  it("ingesting a new listing creates a queued listing_processing_jobs row", async () => {
    const { accessToken } = await registerUser();
    const res = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing(),
    });
    expect(res.statusCode).toBe(200);
    const { id: listingId } = res.json();

    const jobs = await getJobs(accessToken, listingId);
    expect(jobs).toHaveLength(1);
    expect(["queued", "processing", "completed"]).toContain(jobs[0].status); // a worker may already have started it
  });

  it("re-ingesting the same listing (isNew false) does not create a second job row", async () => {
    const { accessToken } = await registerUser();
    const sourceListingId = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing({ sourceListingId }),
    });
    const { id: listingId } = first.json();

    const second = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing({ sourceListingId }),
    });
    expect(second.json().isNew).toBe(false);

    const jobs = await getJobs(accessToken, listingId);
    expect(jobs).toHaveLength(1);
  });

  it("the worker processes a queued job to completion with the stub result", async () => {
    const { accessToken } = await registerUser();
    const res = await app.inject({
      method: "POST",
      url: "/listings/ingest",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: baseListing(),
    });
    const { id: listingId } = res.json();

    let worker: Worker | undefined;
    try {
      worker = createListingProcessingWorker();

      await pollUntil(async () => {
        const jobs = await getJobs(accessToken, listingId);
        return jobs[0]?.status === "completed";
      });

      const jobs = await getJobs(accessToken, listingId);
      expect(jobs[0].status).toBe("completed");
      expect(jobs[0].result).toMatchObject({ status: "stub-processed" });
      expect(jobs[0].result.processedAt).toBeTruthy();
    } finally {
      await worker?.close();
    }
  });
});
