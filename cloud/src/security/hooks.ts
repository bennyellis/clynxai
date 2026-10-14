import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { isSecureRequest } from "../web/session.js";

// Response headers for an API that never serves pages, a non-leaking error handler, and in-process request counters for /metrics.

export interface Counters {
  startedAt: number;
  requests: number;
  byClass: Record<string, number>;
  errors5xx: number;
}
export const counters: Counters = { startedAt: Date.now(), requests: 0, byClass: {}, errors5xx: 0 };

export function registerSecurity(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    // (the website's pages and the simulated payment pages set their own policy; everything else is an API that serves no page)
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (isSecureRequest(request)) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // a private beta must never be indexed or cached by a search engine
    if (config.web.accessPrivate) reply.header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    // an API answer (tokens, account data) must never be cached by a proxy or the client
    if (!reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (_request, reply) => {
    counters.requests++;
    const c = `${Math.floor(reply.statusCode / 100)}xx`;
    counters.byClass[c] = (counters.byClass[c] ?? 0) + 1;
    if (reply.statusCode >= 500) counters.errors5xx++;
  });
  // Validation errors keep their meaning; anything unexpected is logged in full on the server and answered generically (no stack, no SQL, no internals to the caller).
  app.setErrorHandler((err, request, reply) => {
    const status = typeof (err as { statusCode?: number }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: "Internal error" });
    }
    return reply.code(status).send({ error: (err as Error).message });
  });
}
