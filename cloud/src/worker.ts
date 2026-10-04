import { createListingProcessingWorker } from "./queue/worker.js";
import { closePool } from "./db/client.js";
import { redisConnection } from "./queue/connection.js";

// Clynx Cloud Phase 4 — standalone worker process entrypoint. Deliberately
// separate from the Fastify API (src/index.ts), matching the roadmap's
// api/ vs workers/ process separation. Run with `npm run worker`.

const worker = createListingProcessingWorker();
console.log("[worker] listing-processing worker started");

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] received ${signal}, shutting down...`);
  try {
    await worker.close();
    await redisConnection.quit();
    await closePool();
  } catch (err) {
    console.error("[worker] error during shutdown:", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
