import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BillingProvider } from "../billing/provider.js";
import { getClient, query } from "../db/client.js";
import { effectivePlanFor } from "../entitlements/enforce.js";
import { hit } from "../security/rateLimit.js";
import { requireAuth } from "./middleware.js";
import { hashPassword, verifyPassword } from "./service.js";

const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) });
const deleteSchema = z.object({ password: z.string().min(1).max(200), confirm: z.literal("DELETE") });

// Account management for the signed-in user. Every query is scoped to request.userId (never to an id from the request).
export function accountRoutes(provider: BillingProvider | null) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    app.addHook("preHandler", requireAuth);

    app.get("/me", async (request, reply) => {
      const u = await query<{ id: string; email: string; created_at: Date }>("SELECT id, email, created_at FROM users WHERE id = $1", [request.userId]);
      if (!u.rows[0]) return reply.code(404).send({ error: "User not found" });
      const eff = await effectivePlanFor(request.userId as string);
      return reply.code(200).send({ userId: u.rows[0].id, email: u.rows[0].email, createdAt: u.rows[0].created_at, plan: eff?.plan ?? "free" });
    });

    app.post("/me/password", async (request, reply) => {
      const parsed = passwordChangeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
      const rl = await hit(`pwchange:${request.userId}`, 5, 900);
      if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      const u = await query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [request.userId]);
      if (!u.rows[0] || !(await verifyPassword(u.rows[0].password_hash, parsed.data.currentPassword))) return reply.code(401).send({ error: "Invalid credentials" });
      const hash = await hashPassword(parsed.data.newPassword);
      // a changed password signs every device out: all refresh tokens are revoked (the caller signs in again with the new password)
      await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, request.userId]);
      await query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [request.userId]);
      return reply.code(200).send({ ok: true, signedOutEverywhere: true });
    });

    // Deletes the account and everything stored for it (all tables reference users with ON DELETE CASCADE). A paid subscription is cancelled at the provider FIRST; if that cannot be
    // done the account is NOT deleted, so nobody is left being charged for an account that no longer exists.
    app.delete("/me", async (request, reply) => {
      const parsed = deleteSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Send your password and confirm: \"DELETE\"" });
      const rl = await hit(`delete:${request.userId}`, 5, 900);
      if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      const u = await query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [request.userId]);
      if (!u.rows[0] || !(await verifyPassword(u.rows[0].password_hash, parsed.data.password))) return reply.code(401).send({ error: "Invalid credentials" });
      const sub = await query<{ provider_subscription_id: string | null; status: string }>("SELECT provider_subscription_id, status FROM subscriptions WHERE user_id = $1", [request.userId]);
      const live = sub.rows[0]?.provider_subscription_id && !["canceled", "incomplete_expired"].includes(sub.rows[0].status);
      if (live) {
        if (!provider) return reply.code(409).send({ error: "subscription_active", message: "Cancel your subscription before deleting the account." });
        try {
          await provider.cancelSubscription(sub.rows[0].provider_subscription_id as string);
        } catch (err) {
          request.log.error({ err }, "could not cancel the subscription before deleting the account");
          return reply.code(502).send({ error: "subscription_cancel_failed", message: "The subscription could not be cancelled, so the account was not deleted." });
        }
      }
      const client = await getClient();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM users WHERE id = $1", [request.userId]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return reply.code(200).send({ ok: true, deleted: true });
    });
  };
}
