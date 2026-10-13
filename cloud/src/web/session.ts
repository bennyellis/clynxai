import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { query } from "../db/client.js";

// Browser sessions for the website. The cookie carries a random secret (only its SHA-256 is stored); it is HttpOnly (scripts cannot read it), SameSite=Lax, and Secure whenever the
// site is served over https. State-changing requests made with the cookie must also carry the session's CSRF token (see requireAuth in ../auth/middleware.ts).
// In https mode the cookie uses the __Host- prefix, which stops a sibling sub-domain from planting or overwriting it.

export const COOKIE_NAME = config.web.secureCookies ? "__Host-clynx_sid" : "clynx_sid";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

function cookieAttrs(maxAgeSec: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${config.web.secureCookies ? "; Secure" : ""}`;
}
export const setSessionCookie = (reply: FastifyReply, value: string) => reply.header("Set-Cookie", `${COOKIE_NAME}=${value}; ${cookieAttrs(config.web.sessionTtlDays * 86400)}`);
export const clearSessionCookie = (reply: FastifyReply) => reply.header("Set-Cookie", `${COOKIE_NAME}=; ${cookieAttrs(0)}`);

export interface WebSession {
  id: string;
  userId: string;
  csrfToken: string;
}

export async function createWebSession(userId: string, userAgent: string | undefined): Promise<{ cookieValue: string; csrfToken: string; id: string }> {
  const secret = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const r = await query<{ id: string }>(
    `INSERT INTO web_sessions (user_id, secret_hash, csrf_token, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, sha(secret), csrf, (userAgent ?? "").slice(0, 200), new Date(Date.now() + config.web.sessionTtlDays * 86400_000)]
  );
  return { cookieValue: secret, csrfToken: csrf, id: r.rows[0].id };
}

/** The session behind a cookie value, or null (unknown, expired, revoked, or the account is disabled). */
export async function lookupWebSession(cookieValue: string | undefined): Promise<WebSession | null> {
  if (!cookieValue || cookieValue.length < 20 || cookieValue.length > 100) return null;
  const r = await query<{ id: string; user_id: string; csrf_token: string }>(
    `SELECT s.id, s.user_id, s.csrf_token FROM web_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.secret_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha(cookieValue)]
  );
  const row = r.rows[0];
  if (!row) return null;
  void query("UPDATE web_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'", [row.id]).catch(() => undefined);
  return { id: row.id, userId: row.user_id, csrfToken: row.csrf_token };
}

export async function revokeWebSession(id: string, userId: string): Promise<boolean> {
  const r = await query("UPDATE web_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}
export async function revokeAllWebSessions(userId: string, exceptId?: string): Promise<void> {
  await query("UPDATE web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)", [userId, exceptId ?? null]);
}

export function csrfMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Browsers always send Origin on cross-site and on same-site POSTs. When it is present it must be this site; when it is absent (non-browser clients) the CSRF token still decides. */
export function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(config.web.publicUrl).origin;
  } catch {
    return false;
  }
}
