import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { pool } from "../db/client.js";
import { listingProcessingQueue } from "../queue/listingProcessingQueue.js";
import { redisConnection } from "../queue/connection.js";
import { counters } from "../security/hooks.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness + database: what a load balancer polls. Cheap and unauthenticated; says nothing about internals.
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return reply.code(200).send({ status: "ok" });
    } catch (err) {
      app.log.error({ err }, "health check failed: database unreachable");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  // Readiness: the database AND the queue's Redis are reachable. A degraded answer names which dependency is down (still no internals) so monitoring can alert on it.
  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, "ok" | "down"> = { database: "down", redis: "down" };
    try {
      await pool.query("SELECT 1");
      checks.database = "ok";
    } catch {
      /* stays down */
    }
    try {
      checks.redis = (await redisConnection.ping()) === "PONG" ? "ok" : "down";
    } catch {
      /* stays down */
    }
    const ready = checks.database === "ok" && checks.redis === "ok";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "degraded", checks });
  });

  // Operational numbers (request counts, queue depth, uptime). Served ONLY when METRICS_TOKEN is set and presented as a bearer token.
  app.get("/metrics", async (request, reply) => {
    if (!config.metricsToken) return reply.code(404).send({ error: "Not found" });
    if (request.headers.authorization !== `Bearer ${config.metricsToken}`) return reply.code(401).send({ error: "Unauthorized" });
    let queue: Record<string, number> | { error: string };
    try {
      queue = await listingProcessingQueue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    } catch {
      queue = { error: "unavailable" };
    }
    return reply.code(200).send({ uptimeSec: Math.round((Date.now() - counters.startedAt) / 1000), requests: counters.requests, byClass: counters.byClass, errors5xx: counters.errors5xx, queue });
  });
}
