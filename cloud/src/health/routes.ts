import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return reply.code(200).send({ status: "ok" });
    } catch (err) {
      app.log.error({ err }, "health check failed: database unreachable");
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
