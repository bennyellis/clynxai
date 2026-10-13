import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkLogin, emailSchema, passwordSchema, registerUser, sendVerificationEmail } from "../auth/accounts.js";
import { requireAuth } from "../auth/middleware.js";
import { sendAccountError } from "../auth/routes.js";
import { hashPassword, verifyPassword } from "../auth/service.js";
import { consumeAuthToken, createAuthToken, HOUR } from "../auth/tokens.js";
import { query } from "../db/client.js";
import { effectivePlanFor } from "../entitlements/enforce.js";
import { emails, queueEmail } from "../mail/mailer.js";
import { hit } from "../security/rateLimit.js";
import { clearSessionCookie, createWebSession, originAllowed, revokeAllWebSessions, revokeWebSession, setSessionCookie } from "./session.js";

// The website's account endpoints (cookie sessions). They sit on the SAME accounts and rules as the desktop app's /auth/* endpoints (see ../auth/accounts.ts); everything a signed-in
// customer does after this (billing, devices, password change, deleting the account) goes through the existing endpoints, which accept the cookie as well as the bearer token.

const signupSchema = z.object({ email: emailSchema, password: passwordSchema, displayName: z.string().trim().max(80).optional() });
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const tokenSchema = z.object({ token: z.string().min(10).max(200) });
const resetSchema = z.object({ token: z.string().min(10).max(200), newPassword: passwordSchema });
const profileSchema = z.object({ displayName: z.string().trim().max(80) });
const changeEmailSchema = z.object({ newEmail: emailSchema, password: z.string().min(1).max(200) });
const uuidParam = z.object({ id: z.string().uuid() });

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  email_verified_at: Date | null;
  role: string;
  is_beta_tester: boolean;
  created_at: Date;
}

async function profileOf(userId: string) {
  const r = await query<UserRow>("SELECT id, email, display_name, email_verified_at, role, is_beta_tester, created_at FROM users WHERE id = $1", [userId]);
  const u = r.rows[0];
  if (!u) return null;
  const eff = await effectivePlanFor(userId);
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    emailVerified: !!u.email_verified_at,
    role: u.role,
    isBetaTester: u.is_beta_tester,
    createdAt: u.created_at,
    plan: eff?.plan ?? "free",
    owner: eff?.owner ?? false,
  };
}

export async function webAuthRoutes(app: FastifyInstance): Promise<void> {
  // Anything that creates a session is refused from another site (browsers always send Origin on these POSTs).
  const sameSiteOnly = async (request: Parameters<typeof originAllowed>[0], reply: import("fastify").FastifyReply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: "csrf", message: "Cross-site request refused." });
  };

  async function startSession(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, userId: string, status = 200) {
    const s = await createWebSession(userId, request.headers["user-agent"]);
    setSessionCookie(reply, s.cookieValue);
    return reply.code(status).send({ user: await profileOf(userId), csrfToken: s.csrfToken });
  }

  // ------------------------------------------------------------------ public
  app.post("/web/signup", { preHandler: sameSiteOnly }, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    try {
      const userId = await registerUser(parsed.data.email, parsed.data.password, request.ip, parsed.data.displayName);
      return await startSession(request, reply, userId, 201);
    } catch (err) {
      return sendAccountError(reply, err);
    }
  });

  app.post("/web/login", { preHandler: sameSiteOnly }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body" });
    try {
      const user = await checkLogin(parsed.data.email, parsed.data.password, request.ip);
      return await startSession(request, reply, user.id);
    } catch (err) {
      return sendAccountError(reply, err);
    }
  });

  // Always answers the same, whether or not the address has an account (no account enumeration). Limited per address and per client.
  app.post("/web/password/forgot", { preHandler: sameSiteOnly }, async (request, reply) => {
    const parsed = z.object({ email: emailSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body" });
    const ipLimit = await hit(`forgot-ip:${request.ip}`, 20, 3600);
    const mailLimit = await hit(`forgot-mail:${parsed.data.email}`, 3, 3600);
    if (!ipLimit.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: ipLimit.retryAfterSec });
    if (mailLimit.allowed) {
      const u = await query<{ id: string; email: string }>("SELECT id, email FROM users WHERE lower(email) = $1 AND disabled_at IS NULL", [parsed.data.email]);
      if (u.rows[0]) {
        const token = await createAuthToken(u.rows[0].id, "reset_password", HOUR);
        await queueEmail(emails.reset(u.rows[0].email, token)).catch(() => undefined);
      }
    }
    return reply.code(200).send({ ok: true });
  });

  app.post("/web/password/reset", { preHandler: sameSiteOnly }, async (request, reply) => {
    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    const rl = await hit(`reset:${request.ip}`, 20, 3600);
    if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
    const t = await consumeAuthToken(parsed.data.token, "reset_password");
    if (!t) return reply.code(400).send({ error: "invalid_or_expired_token", message: "This reset link is invalid or has expired. Ask for a new one." });
    const hash = await hashPassword(parsed.data.newPassword);
    // opening the emailed link also proves the address is theirs
    await query("UPDATE users SET password_hash = $1, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $2", [hash, t.userId]);
    // every desktop sign-in and every browser session is ended; they sign in again with the new password
    await query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [t.userId]);
    await revokeAllWebSessions(t.userId);
    const u = await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [t.userId]);
    if (u.rows[0]) await queueEmail(emails.passwordChanged(u.rows[0].email)).catch(() => undefined);
    return reply.code(200).send({ ok: true });
  });

  app.post("/web/email/verify", { preHandler: sameSiteOnly }, async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body" });
    const t = await consumeAuthToken(parsed.data.token, "verify_email");
    if (!t) return reply.code(400).send({ error: "invalid_or_expired_token", message: "This confirmation link is invalid or has expired. Sign in and ask for a new one." });
    await query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [t.userId]);
    return reply.code(200).send({ ok: true });
  });

  app.post("/web/email/confirm-change", { preHandler: sameSiteOnly }, async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request body" });
    const t = await consumeAuthToken(parsed.data.token, "change_email");
    if (!t || !t.payload) return reply.code(400).send({ error: "invalid_or_expired_token", message: "This link is invalid or has expired." });
    const taken = await query("SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2", [t.payload, t.userId]);
    if (taken.rows.length) return reply.code(409).send({ error: "email_taken", message: "That address now belongs to another account." });
    const old = await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [t.userId]);
    await query("UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2", [t.payload, t.userId]);
    if (old.rows[0]) await queueEmail(emails.emailChanged(old.rows[0].email, t.payload)).catch(() => undefined);
    return reply.code(200).send({ ok: true });
  });

  // ------------------------------------------------------------------ signed in (cookie or bearer)
  app.register(async (authed) => {
    authed.addHook("preHandler", requireAuth);

    authed.get("/web/session", async (request, reply) => {
      const user = await profileOf(request.userId as string);
      if (!user) return reply.code(401).send({ error: "Unknown user" });
      return reply.code(200).send({ user, csrfToken: request.csrfToken ?? null });
    });

    authed.post("/web/logout", async (request, reply) => {
      if (request.sessionId) await revokeWebSession(request.sessionId, request.userId as string);
      clearSessionCookie(reply);
      return reply.code(200).send({ ok: true });
    });

    authed.post("/web/email/resend", async (request, reply) => {
      const rl = await hit(`resend:${request.userId}`, 3, 3600);
      if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      const u = await query<{ email: string; email_verified_at: Date | null }>("SELECT email, email_verified_at FROM users WHERE id = $1", [request.userId]);
      if (!u.rows[0]) return reply.code(404).send({ error: "User not found" });
      if (u.rows[0].email_verified_at) return reply.code(200).send({ ok: true, alreadyVerified: true });
      await sendVerificationEmail(request.userId as string, u.rows[0].email);
      return reply.code(200).send({ ok: true });
    });

    authed.patch("/web/profile", async (request, reply) => {
      const parsed = profileSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request body" });
      await query("UPDATE users SET display_name = $1 WHERE id = $2", [parsed.data.displayName || null, request.userId]);
      return reply.code(200).send({ user: await profileOf(request.userId as string) });
    });

    // The address changes only after the new address is confirmed from its own inbox.
    authed.post("/web/email/change", async (request, reply) => {
      const parsed = changeEmailSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid request body" });
      const rl = await hit(`emailchange:${request.userId}`, 5, 3600);
      if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      const u = await query<{ password_hash: string; email: string }>("SELECT password_hash, email FROM users WHERE id = $1", [request.userId]);
      if (!u.rows[0] || !(await verifyPassword(u.rows[0].password_hash, parsed.data.password))) return reply.code(401).send({ error: "Invalid credentials" });
      if (parsed.data.newEmail === u.rows[0].email.toLowerCase()) return reply.code(400).send({ error: "same_email" });
      const taken = await query("SELECT 1 FROM users WHERE lower(email) = $1", [parsed.data.newEmail]);
      if (taken.rows.length) return reply.code(409).send({ error: "email_taken", message: "An account with that address already exists." });
      const token = await createAuthToken(request.userId as string, "change_email", 24 * HOUR, parsed.data.newEmail);
      await queueEmail(emails.changeEmail(parsed.data.newEmail, token)).catch(() => undefined);
      return reply.code(200).send({ ok: true, pending: parsed.data.newEmail });
    });

    // Browser sessions (the sites signed in with a cookie). Desktop installs are "devices" (/devices).
    authed.get("/web/sessions", async (request, reply) => {
      const r = await query<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date }>(
        "SELECT id, user_agent, created_at, last_seen_at FROM web_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC",
        [request.userId]
      );
      return reply.code(200).send({ sessions: r.rows.map((s) => ({ id: s.id, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === request.sessionId })) });
    });
    authed.delete("/web/sessions/:id", async (request, reply) => {
      const p = uuidParam.safeParse(request.params);
      if (!p.success) return reply.code(400).send({ error: "Invalid session id" });
      const ok = await revokeWebSession(p.data.id, request.userId as string);
      if (!ok) return reply.code(404).send({ error: "Session not found" });
      if (p.data.id === request.sessionId) clearSessionCookie(reply);
      return reply.code(200).send({ ok: true });
    });
    authed.post("/web/sessions/revoke-others", async (request, reply) => {
      await revokeAllWebSessions(request.userId as string, request.sessionId);
      return reply.code(200).send({ ok: true });
    });

    // Everything stored about the signed-in customer, as JSON (secrets and password hashes are never included).
    authed.get("/web/export", async (request, reply) => {
      const uid = request.userId as string;
      const rows = async (sql: string) => (await query(sql, [uid])).rows;
      const [profile, devices, sub, sessions, support, watches, feedback, products, usage, counts] = await Promise.all([
        profileOf(uid),
        rows("SELECT id, platform, client_version AS \"clientVersion\", last_seen_at AS \"lastSeenAt\", created_at AS \"createdAt\" FROM devices WHERE user_id = $1"),
        rows("SELECT status, plan, billing_interval AS \"interval\", current_period_end AS \"currentPeriodEnd\", trial_end AS \"trialEnd\", cancel_at_period_end AS \"cancelAtPeriodEnd\", created_at AS \"createdAt\" FROM subscriptions WHERE user_id = $1"),
        rows("SELECT id, user_agent AS \"userAgent\", created_at AS \"createdAt\", last_seen_at AS \"lastSeenAt\" FROM web_sessions WHERE user_id = $1 AND revoked_at IS NULL"),
        rows("SELECT id, category, subject, message, status, created_at AS \"createdAt\" FROM support_requests WHERE user_id = $1"),
        rows("SELECT to_jsonb(w) AS w FROM watches w WHERE user_id = $1 LIMIT 5000").then((r) => r.map((x) => (x as { w: unknown }).w)),
        rows("SELECT to_jsonb(f) AS f FROM listing_feedback f WHERE user_id = $1 LIMIT 5000").then((r) => r.map((x) => (x as { f: unknown }).f)),
        rows("SELECT to_jsonb(p) AS p FROM user_products p WHERE user_id = $1 LIMIT 5000").then((r) => r.map((x) => (x as { p: unknown }).p)),
        rows("SELECT date_trunc('day', created_at) AS day, count(*)::int AS requests FROM ai_usage WHERE user_id = $1 GROUP BY 1 ORDER BY 1 DESC LIMIT 90"),
        rows("SELECT (SELECT count(*)::int FROM watch_matches WHERE user_id = $1) AS watch_matches_count"),
      ]);
      reply.header("Content-Disposition", 'attachment; filename="clynx-account-export.json"');
      return reply.code(200).send({ exportedAt: new Date().toISOString(), account: profile, devices, subscription: sub[0] ?? null, browserSessions: sessions, supportRequests: support, watches, feedback, products, aiUsageByDay: usage, counts: { watchMatches: (counts[0] as { watch_matches_count: number }).watch_matches_count }, note: "Scanned listings are shared across accounts and are not part of a personal export; Watch matches are counted." });
    });
  });
}
