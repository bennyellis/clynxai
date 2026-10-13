import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { authorizeEbayCall, recordEbayCall } from "../integrations/controls.js";
import { getEbayCredentials, recordVerification } from "../integrations/credentials.js";
import { hit } from "../security/rateLimit.js";
import { appGet, buildConsentUrl, completeConsent, connectionStatus, disconnect, EbayError, userGet } from "./service.js";

// What customers can do with eBay through Clynx Cloud. Everything is authenticated, rate limited, counted per customer against daily allowances, and subject to the emergency switch.
//   /ebay/search, /ebay/item/:id      public listing data, read with the company's APPLICATION credentials
//   /ebay/connect, /ebay/callback ... the customer's own consent to let Clynx read THEIR eBay account (a separate authorisation; the application credentials cannot do this)
//   /ebay/me/inventory ............... one read of the customer's own account, with their own token

const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
  filter: z.string().max(300).regex(/^[\w\s,.:|{}[\]()=-]*$/).optional(),
  sort: z.enum(["newlyListed", "price", "-price", "distance"]).optional(),
  category_ids: z.string().regex(/^\d+(,\d+)*$/).max(100).optional(),
  marketplace: z.enum(["EBAY_US", "EBAY_GB", "EBAY_CA", "EBAY_AU", "EBAY_DE"]).default("EBAY_US"),
});

function sendEbayError(reply: FastifyReply, err: unknown) {
  if (err instanceof EbayError) return reply.code(err.status).send({ error: err.code, message: err.message });
  throw err;
}

export async function ebayRoutes(app: FastifyInstance): Promise<void> {
  // The return address eBay sends the customer's browser to after they agree (or refuse). It carries no session: the signed, single-use state says who it is for.
  app.get("/ebay/callback", async (request, reply) => {
    const q = z.object({ code: z.string().min(5).max(2000), state: z.string().min(20).max(600) }).safeParse(request.query);
    const back = (result: string) => reply.redirect(`${config.web.publicUrl}/account/profile?ebay=${result}`, 303);
    if (!q.success) return back("declined");
    try {
      await completeConsent(q.data.code, q.data.state);
      return back("connected");
    } catch (err) {
      request.log.warn({ err: err instanceof EbayError ? err.code : "error" }, "eBay connection failed");
      return back("failed");
    }
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    authed.get("/ebay/status", async (request, reply) => {
      const c = await getEbayCredentials().catch(() => null);
      return reply.code(200).send({ available: !!c, canConnectAccount: !!c?.creds.ruName, ...(await connectionStatus(request.userId as string)) });
    });

    // a paid call: limits first, then the call, then the accounting
    async function paid<T>(request: { userId?: string }, reply: FastifyReply, operation: string, run: () => Promise<{ status: number; data: unknown }>): Promise<T | FastifyReply> {
      const userId = request.userId as string;
      const rl = await hit(`ebay:${userId}`, 30, 60);
      if (!rl.allowed) {
        reply.header("Retry-After", String(rl.retryAfterSec));
        return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }
      const ok = await authorizeEbayCall(userId);
      if (!ok.ok) return reply.code(ok.status).send({ error: ok.error, message: ok.message });
      try {
        const r = await run();
        await recordEbayCall(userId, operation, r.status);
        if (r.status === 401 || r.status === 403) {
          await recordVerification("ebay", false, "eBay rejected the application credentials while serving a customer request.", null).catch(() => undefined);
          return reply.code(503).send({ error: "provider_unavailable", message: "eBay features are temporarily unavailable." });
        }
        if (r.status === 429) return reply.code(503).send({ error: "provider_busy", message: "eBay is busy. Please try again shortly." });
        return reply.code(r.status).send(r.data ?? {});
      } catch (err) {
        await recordEbayCall(userId, operation, err instanceof EbayError ? err.status : 500);
        return sendEbayError(reply, err);
      }
    }

    authed.get("/ebay/search", async (request, reply) => {
      const q = searchSchema.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: "Invalid search", details: q.error.flatten() });
      const p = new URLSearchParams({ q: q.data.q, limit: String(q.data.limit), offset: String(q.data.offset) });
      for (const k of ["filter", "sort", "category_ids"] as const) if (q.data[k]) p.set(k, q.data[k] as string);
      return paid(request, reply, "search", () => appGet("/buy/browse/v1/item_summary/search", p, q.data.marketplace));
    });

    authed.get("/ebay/item/:id", async (request, reply) => {
      const p = z.object({ id: z.string().min(3).max(120).regex(/^[A-Za-z0-9|_.-]+$/) }).safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "Invalid item id" });
      return paid(request, reply, "item", () => appGet(`/buy/browse/v1/item/${encodeURIComponent(p.data.id)}`, new URLSearchParams()));
    });

    authed.post("/ebay/connect", async (request, reply) => {
      const rl = await hit(`ebayconnect:${request.userId}`, 10, 3600);
      if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      try {
        return reply.code(200).send({ url: await buildConsentUrl(request.userId as string) });
      } catch (err) {
        return sendEbayError(reply, err);
      }
    });

    authed.delete("/ebay/connection", async (request, reply) => {
      await disconnect(request.userId as string);
      return reply.code(200).send({ ok: true });
    });

    authed.get("/ebay/me/inventory", async (request, reply) => {
      return paid(request, reply, "user_call", () => userGet(request.userId as string, "/sell/inventory/v1/inventory_item", new URLSearchParams({ limit: "25" })));
    });
  });
}
