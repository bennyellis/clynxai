import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, requireOwner } from "../auth/middleware.js";
import { query } from "../db/client.js";
import { resetEbayTokens, verifyEbay } from "../ebay/service.js";
import { clearAbuse, CONTROL_FIELDS, getControls, setEmergencyStop, spentUsd, updateControls, userDailyCapUsd, tierOf } from "../integrations/controls.js";
import { ebaySchema, integrationStatus, openaiSchema, revokeCredentials, saveCredentials, verifyOpenAI, type EbayCredentials, type OpenAICredentials } from "../integrations/credentials.js";
import { VaultError } from "../integrations/vault.js";
import { hit } from "../security/rateLimit.js";

// API Integrations: the company-managed OpenAI and eBay credentials and the spending controls around them.
//   OWNER ONLY ...... configure, replace (rotate), verify or revoke a credential; change spending limits; resume after an emergency stop.
//   ADMIN or OWNER .. look at spending and abuse flags, clear a customer's abuse block, and ENGAGE the emergency stop (a safe direction: it can only reduce spending).
// Secrets are write-only: once saved they are never returned, shown or logged; the console shows a masked identifier, a status and when the credential was last verified.

async function audit(request: FastifyRequest, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  const a = await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [request.userId]);
  await query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES ($1, $2, $3, $4, $5)", [request.userId, a.rows[0]?.email ?? "?", action, target, JSON.stringify(detail)]);
}

const providerParam = z.object({ provider: z.enum(["openai", "ebay"]) });
const num = z.number().finite().min(0).max(1_000_000);
const controlsSchema = z.object(Object.fromEntries(CONTROL_FIELDS.map((k) => [k, num.optional()]))).strict();

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------ OWNER ONLY
  app.register(async (owner) => {
    owner.addHook("preHandler", requireOwner);

    owner.get("/admin/integrations", async (_request, reply) => {
      const status = await integrationStatus();
      const events = await query(`SELECT e.provider, e.action, e.ok, e.detail, e.created_at AS "createdAt", u.email AS "by" FROM integration_events e LEFT JOIN users u ON u.id = e.by_user ORDER BY e.id DESC LIMIT 20`);
      return reply.code(200).send({ ...status, events: events.rows });
    });

    async function limited(request: FastifyRequest, reply: import("fastify").FastifyReply): Promise<boolean> {
      const rl = await hit(`integrations-write:${request.userId}`, 20, 3600);
      if (rl.allowed) return false;
      await reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      return true;
    }

    owner.put("/admin/integrations/openai", async (request, reply) => {
      if (await limited(request, reply)) return reply;
      const b = openaiSchema.safeParse(request.body);
      if (!b.success) return reply.code(400).send({ error: "invalid_credentials", message: b.error.issues[0]?.message ?? "Invalid request" });
      try {
        const r = await saveCredentials("openai", b.data as OpenAICredentials, request.userId as string);
        await audit(request, r.rotated ? "integration.rotate" : "integration.set", "openai", { version: r.version });
        return reply.code(200).send({ ok: true, rotated: r.rotated, version: r.version, masked: r.masked });
      } catch (err) {
        if (err instanceof VaultError) return reply.code(503).send({ error: err.code === "not_configured" ? "vault_not_configured" : "vault_error", message: err.message });
        throw err;
      }
    });

    owner.put("/admin/integrations/ebay", async (request, reply) => {
      if (await limited(request, reply)) return reply;
      const b = ebaySchema.safeParse(request.body);
      if (!b.success) return reply.code(400).send({ error: "invalid_credentials", message: b.error.issues[0]?.message ?? "Invalid request" });
      try {
        const r = await saveCredentials("ebay", b.data as EbayCredentials, request.userId as string);
        resetEbayTokens();
        await audit(request, r.rotated ? "integration.rotate" : "integration.set", "ebay", { version: r.version });
        return reply.code(200).send({ ok: true, rotated: r.rotated, version: r.version, masked: r.masked });
      } catch (err) {
        if (err instanceof VaultError) return reply.code(503).send({ error: err.code === "not_configured" ? "vault_not_configured" : "vault_error", message: err.message });
        throw err;
      }
    });

    // Makes ONE free call to the provider (the model list / a token request) to check the saved credential still works.
    owner.post("/admin/integrations/:provider/verify", async (request, reply) => {
      const p = providerParam.safeParse(request.params);
      if (!p.success) return reply.code(404).send({ error: "Not found" });
      if (await limited(request, reply)) return reply;
      const r = p.data.provider === "openai" ? await verifyOpenAI(request.userId as string) : await verifyEbay(request.userId as string);
      await audit(request, "integration.verify", p.data.provider, { ok: r.ok });
      return reply.code(200).send(r);
    });

    owner.delete("/admin/integrations/:provider", async (request, reply) => {
      const p = providerParam.safeParse(request.params);
      const b = z.object({ confirm: z.literal("REVOKE") }).safeParse(request.body);
      if (!p.success || !b.success) return reply.code(400).send({ error: "Send { \"confirm\": \"REVOKE\" }" });
      await revokeCredentials(p.data.provider, request.userId as string);
      if (p.data.provider === "ebay") resetEbayTokens();
      await audit(request, "integration.revoke", p.data.provider);
      return reply.code(200).send({ ok: true });
    });

    owner.put("/admin/controls", async (request, reply) => {
      const b = controlsSchema.safeParse(request.body);
      if (!b.success) return reply.code(400).send({ error: "Invalid limits", details: b.error.flatten() });
      const c = await updateControls(b.data as Record<string, number>, request.userId as string);
      await audit(request, "controls.update", null, b.data);
      return reply.code(200).send({ controls: c });
    });

    owner.post("/admin/controls/resume", async (request, reply) => {
      const c = await setEmergencyStop(false, null, request.userId as string);
      await audit(request, "controls.resume", null);
      return reply.code(200).send({ controls: c });
    });
  });

  // ------------------------------------------------------------------ ADMIN or OWNER (read, and the safe direction of the emergency switch)
  app.register(async (staff) => {
    staff.addHook("preHandler", requireAdmin);

    staff.get("/admin/controls", async (_request, reply) => reply.code(200).send({ controls: await getControls() }));

    staff.post("/admin/controls/emergency-stop", async (request, reply) => {
      const b = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(request.body);
      if (!b.success) return reply.code(400).send({ error: "Invalid request" });
      const c = await setEmergencyStop(true, b.data.reason ?? "emergency stop", request.userId as string);
      await audit(request, "controls.emergency_stop", null, { reason: b.data.reason ?? null });
      return reply.code(200).send({ controls: c });
    });

    staff.get("/admin/spending", async (_request, reply) => {
      const c = await getControls();
      const now = new Date();
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [today, thisMonth, top, byModel, ebayToday] = await Promise.all([
        spentUsd(day),
        spentUsd(month),
        query(
          `SELECT u.id, u.email, u.role, count(*)::int AS requests, coalesce(sum(a.cost_usd_est), 0)::float8 AS "estimatedUsd"
           FROM ai_usage a JOIN users u ON u.id = a.user_id WHERE a.created_at >= $1 GROUP BY u.id, u.email, u.role ORDER BY 5 DESC LIMIT 10`,
          [day]
        ),
        query(`SELECT coalesce(model, 'unknown') AS model, count(*)::int AS requests, coalesce(sum(cost_usd_est), 0)::float8 AS "estimatedUsd" FROM ai_usage WHERE created_at >= $1 GROUP BY 1 ORDER BY 3 DESC`, [day]),
        query<{ n: number }>("SELECT count(*)::int AS n FROM ebay_usage WHERE created_at >= $1", [day]),
      ]);
      const flags = await query(`SELECT f.id, f.user_id AS "userId", u.email, f.reason, f.detail, f.created_at AS "createdAt" FROM api_abuse_flags f JOIN users u ON u.id = f.user_id WHERE f.cleared_at IS NULL ORDER BY f.id DESC LIMIT 50`);
      return reply.code(200).send({
        note: "Estimated from token counts and a price table; an estimate, not an invoice.",
        controls: c,
        today: { estimatedUsd: today, limitUsd: c.globalDailyUsd },
        month: { estimatedUsd: thisMonth, limitUsd: c.globalMonthlyUsd },
        ebayCallsToday: { calls: ebayToday.rows[0].n, limit: c.ebayDailyCallsGlobal },
        topCustomersToday: top.rows,
        byModelToday: byModel.rows,
        openAbuseFlags: flags.rows,
      });
    });

    staff.get("/admin/spending/users/:id", async (request, reply) => {
      const p = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "Invalid id" });
      const c = await getControls();
      const tier = await tierOf(p.data.id);
      const now = new Date();
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return reply.code(200).send({ tier, dailyLimitUsd: userDailyCapUsd(c, tier), spentTodayUsd: await spentUsd(day, p.data.id) });
    });

    staff.post("/admin/abuse/:id/clear", async (request, reply) => {
      const p = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "Invalid id" });
      await clearAbuse(p.data.id, request.userId as string);
      await audit(request, "abuse.clear", p.data.id);
      return reply.code(200).send({ ok: true });
    });
  });
}
