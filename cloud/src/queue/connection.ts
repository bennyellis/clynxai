import pkg from "ioredis";
import { config } from "../config.js";

const { Redis } = pkg;

// Clynx Cloud Phase 4 — shared ioredis connection for BullMQ. BullMQ needs
// maxRetriesPerRequest: null on connections it owns (queue producer AND
// worker) — see BullMQ's docs. Reused by both the queue-producer side
// (listings/routes.ts, via listingProcessingQueue.ts) and the worker
// process (src/worker.ts).
export const redisConnection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});
