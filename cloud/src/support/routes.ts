import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { emailSchema } from "../auth/accounts.js";
import { requireAuth } from "../auth/middleware.js";
import { query } from "../db/client.js";
import { emails, queueEmail } from "../mail/mailer.js";
import { hit } from "../security/rateLimit.js";
import { lookupWebSession, originAllowed, readSessionCookie } from "../web/session.js";

// Support requests from the website (and, later, the app). Anyone may send one (signed in or not); it is rate limited, size limited and stored for administrators. A pasted support
// report from the app is scrubbed of anything that looks like a key or token before it is stored, even though the app already removes them.

const bodySchema = z.object({
  email: emailSchema,
  category: z.enum(["install", "scanner", "billing", "account", "bug", "other"]),
  subject: z.string().trim().min(3).max(150),
  message: z.string().trim().min(10).max(5000),
  diagnostics: z.string().max(40_000).optional(),
});

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{12,}/g, "[removed-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [removed]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g, "[removed-token]"],
  [/whsec_[A-Za-z0-9]{8,}/g, "[removed-key]"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "[removed-key]"],
];
export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);
}

export async function supportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/support/requests", async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: "csrf" });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    const rl = await hit(`support:${request.ip}`, 8, 3600);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
    }
    // Link the request to the account when the sender is signed in on the website (read only: this endpoint needs no CSRF token because it changes nothing of the account's).
    const session = await lookupWebSession(readSessionCookie(request.headers.cookie));
    const d = parsed.data;
    const r = await query<{ id: string }>(
      `INSERT INTO support_requests (user_id, email, category, subject, message, diagnostics) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [session?.userId ?? null, d.email, d.category, d.subject, scrubSecrets(d.message), d.diagnostics ? scrubSecrets(d.diagnostics) : null]
    );
    await queueEmail(emails.supportReceived(d.email, r.rows[0].id, d.subject)).catch(() => undefined);
    return reply.code(201).send({ ok: true, reference: r.rows[0].id });
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);
    authed.get("/support/requests/mine", async (request, reply) => {
      const r = await query(
        `SELECT id, category, subject, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM support_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [request.userId]
      );
      return reply.code(200).send({ requests: r.rows });
    });
  });
}
