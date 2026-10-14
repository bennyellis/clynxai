import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createInvite } from "../access/invites.js";
import { requireAdmin } from "../auth/middleware.js";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { emailSchema } from "../auth/accounts.js";

// Invitations for the private beta (administrators and the Owner, website session only). The code is returned ONCE, when it is created; afterwards only a status is visible, because
// only a hash is stored.

async function audit(request: FastifyRequest, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  const a = await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [request.userId]);
  await query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES ($1, $2, $3, $4, $5)", [request.userId, a.rows[0]?.email ?? "?", action, target, JSON.stringify(detail)]);
}

export async function invitesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/admin/invites")) await requireAdmin(request, reply);
  });

  app.get("/admin/invites", async (_request, reply) => {
    const r = await query(
      `SELECT i.id, i.email, i.note, i.created_at AS "createdAt", i.expires_at AS "expiresAt", i.used_at AS "usedAt", i.revoked_at AS "revokedAt", u.email AS "usedBy",
              CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.used_at IS NOT NULL THEN 'used' WHEN i.expires_at < now() THEN 'expired' ELSE 'open' END AS status
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 200`
    );
    return reply.code(200).send({ invites: r.rows, registration: config.web.registration, access: config.web.accessPrivate ? "private" : "open" });
  });

  app.post("/admin/invites", async (request, reply) => {
    const b = z.object({ email: emailSchema.optional().or(z.literal("").transform(() => undefined)), note: z.string().max(200).optional(), hours: z.number().int().min(1).max(24 * 30).default(72) }).safeParse(request.body);
    if (!b.success) return reply.code(400).send({ error: "Invalid request body", details: b.error.flatten() });
    const inv = await createInvite({ email: b.data.email ?? null, note: b.data.note, hours: b.data.hours, createdBy: request.userId as string });
    await audit(request, "invite.create", inv.id, { email: b.data.email ?? null, hours: b.data.hours });
    // the ONLY time the code is ever shown
    return reply.code(201).send({ id: inv.id, code: inv.code, expiresAt: inv.expiresAt });
  });

  app.delete("/admin/invites/:id", async (request, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await query("UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL", [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: "That invitation is already used, revoked, or does not exist" });
    await audit(request, "invite.revoke", p.data.id);
    return reply.code(200).send({ ok: true });
  });
}
