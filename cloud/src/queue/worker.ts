import { Worker, type Job } from "bullmq";
import { redisConnection } from "./connection.js";
import { LISTING_PROCESSING_QUEUE_NAME, type ListingProcessingJobPayload } from "./listingProcessingQueue.js";
import { query } from "../db/client.js";

// Clynx Cloud Phase 4 — INFRA ONLY. This processor is a deliberate STUB: it
// does NOT call OpenAI or any AI service. It simulates a trivial delay and
// marks the job completed with a placeholder result, so the async
// processing pipeline (Redis + BullMQ + Postgres job tracking) can be
// proven end-to-end at zero API cost / zero risk. Wiring this up to real AI
// processing is future-phase work.

async function markJobStatus(
  listingId: string,
  status: "processing" | "completed" | "failed",
  extra: { result?: unknown; error?: string } = {}
): Promise<void> {
  // One row per enqueue (see enqueueListingProcessing) — update the most
  // recently created row for this listing.
  await query(
    `UPDATE listing_processing_jobs
     SET status = $1, result = $2, error = $3, updated_at = now()
     WHERE id = (
       SELECT id FROM listing_processing_jobs WHERE listing_id = $4 ORDER BY created_at DESC LIMIT 1
     )`,
    [status, extra.result ? JSON.stringify(extra.result) : null, extra.error ?? null, listingId]
  );
}

async function processListingJob(job: Job<ListingProcessingJobPayload>): Promise<{ status: string; processedAt: string }> {
  console.log(`[worker] received job ${job.id} for listing ${job.data.listingId} (${job.data.source}/${job.data.sourceListingId})`);
  await markJobStatus(job.data.listingId, "processing");

  // Simulated work — stands in for the future AI processing step.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const result = { status: "stub-processed", processedAt: new Date().toISOString() };
  await markJobStatus(job.data.listingId, "completed", { result });
  return result;
}

export function createListingProcessingWorker(): Worker<ListingProcessingJobPayload> {
  const worker = new Worker<ListingProcessingJobPayload>(LISTING_PROCESSING_QUEUE_NAME, processListingJob, {
    connection: redisConnection,
    concurrency: 5,
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err);
    // only the FINAL failure marks the listing's job failed; earlier attempts are retried by the queue with backoff
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      markJobStatus(job.data.listingId, "failed", { error: err instanceof Error ? err.message : String(err) }).catch(
        (updateErr) => console.error(`[worker] failed to record failure for job ${job.id}:`, updateErr)
      );
    }
  });

  worker.on("error", (err) => {
    // Errors on the Worker instance itself (e.g. Redis connection issues) —
    // must be handled or they crash the process silently.
    console.error("[worker] worker error:", err);
  });

  return worker;
}
