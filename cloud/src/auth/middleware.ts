import type { FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db/client.js";
import { COOKIE_NAME, csrfMatches, lookupWebSession, originAllowed, parseCookies } from "../web/session.js";
import { verifyAccessToken } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    /** How the caller proved who they are: the desktop app's bearer token, or the website's session cookie. */
    authVia?: "bearer" | "cookie";
    sessionId?: string;
    csrfToken?: string;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Accepts EITHER a bearer access token (the desktop app) OR a website session cookie. A bearer header, when present, is the only thing considered. A request authenticated by the cookie
// that changes anything must also pass the CSRF checks: a same-site Origin (when the browser sends one) and the session's CSRF token in X-CSRF-Token.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (header) {
    if (!header.startsWith("Bearer ")) return reply.code(401).send({ error: "Missing or malformed Authorization header" });
    const token = header.slice("Bearer ".length).trim();
    const payload = await verifyAccessToken(token);
    if (!payload) return reply.code(401).send({ error: "Invalid or expired access token" });
    request.userId = payload.sub;
    request.authVia = "bearer";
    return;
  }

  const session = await lookupWebSession(parseCookies(request.headers.cookie)[COOKIE_NAME]);
  if (!session) return reply.code(401).send({ error: "Missing or malformed Authorization header" });
  if (!SAFE_METHODS.has(request.method)) {
    if (!originAllowed(request)) return reply.code(403).send({ error: "csrf", message: "Cross-site request refused." });
    if (!csrfMatches(request.headers["x-csrf-token"], session.csrfToken)) return reply.code(403).send({ error: "csrf", message: "Missing or wrong CSRF token." });
  }
  request.userId = session.userId;
  request.authVia = "cookie";
  request.sessionId = session.id;
  request.csrfToken = session.csrfToken;
}

/** Administrators only, and only through the website (a cookie session), never through a desktop bearer token. The role is read from the database on every request. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (request.authVia !== "cookie") return reply.code(403).send({ error: "forbidden" });
  const r = await query<{ role: string; disabled_at: Date | null }>("SELECT role, disabled_at FROM users WHERE id = $1", [request.userId]);
  if (!r.rows[0] || r.rows[0].role !== "admin" || r.rows[0].disabled_at) return reply.code(403).send({ error: "forbidden" });
}
