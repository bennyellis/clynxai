import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";

const registerSchema = z.object({
  platform: z.string().min(1),
  clientVersion: z.string().min(1),
});

const deviceIdParamSchema = z.object({
  id: z.string().uuid(),
});

interface DeviceRow {
  id: string;
  user_id: string;
  platform: string;
  client_version: string;
  last_seen_at: Date | null;
  created_at: Date;
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/devices/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { platform, clientVersion } = parsed.data;

    const result = await query<{ id: string }>(
      `INSERT INTO devices (user_id, platform, client_version, last_seen_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [request.userId, platform, clientVersion]
    );

    return reply.code(201).send({ id: result.rows[0].id });
  });

  app.post("/devices/:id/heartbeat", async (request, reply) => {
    const paramsParsed = deviceIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid device id" });
    }
    const { id } = paramsParsed.data;

    const existing = await query<{ user_id: string }>("SELECT user_id FROM devices WHERE id = $1", [id]);
    const device = existing.rows[0];
    if (!device) {
      return reply.code(404).send({ error: "Device not found" });
    }
    // Critical isolation check — never let user A heartbeat user B's device.
    if (device.user_id !== request.userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [id]);
    return reply.code(200).send({ ok: true });
  });

  app.get("/devices", async (request, reply) => {
    const result = await query<DeviceRow>(
      `SELECT id, user_id, platform, client_version, last_seen_at, created_at
       FROM devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [request.userId]
    );

    return reply.code(200).send({
      devices: result.rows.map((d) => ({
        id: d.id,
        platform: d.platform,
        clientVersion: d.client_version,
        lastSeenAt: d.last_seen_at,
        createdAt: d.created_at,
      })),
    });
  });
}
