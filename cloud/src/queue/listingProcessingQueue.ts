import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";
import { query } from "../db/client.js";

// Clynx Cloud Phase 4 — job queue for (future) AI processing of newly
// ingested listings. INFRA ONLY in this phase: enqueueing here also
// creates a 'queued' row in listing_processing_jobs (see
// migrations/004_listing_jobs.sql) so job status is queryable from
// Postgres without touching Redis. The actual processor (src/queue/worker.ts)
// is a stub — no AI calls happen yet.

export const LISTING_PROCESSING_QUEUE_NAME = "listing-processing";

export interface ListingProcessingJobPayload {
  listingId: string;
  source: string;
  sourceListingId: string;
}

export const listingProcessingQueue = new Queue<ListingProcessingJobPayload>(LISTING_PROCESSING_QUEUE_NAME, {
  connection: redisConnection,
});

// Enqueues a processing job for a newly-inserted listing and records a
// matching 'queued' row in listing_processing_jobs. Callers (the ingest
// route) should wrap this in try/catch — a queue/Redis failure must not
// fail the ingestion response itself.
export async function enqueueListingProcessing(payload: ListingProcessingJobPayload): Promise<void> {
  await query("INSERT INTO listing_processing_jobs (listing_id, status) VALUES ($1, 'queued')", [payload.listingId]);
  await listingProcessingQueue.add("process-listing", payload);
}
