import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { hit, peek, reset } from "../security/rateLimit.js";
import {
  hashPassword,
  verifyPassword,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  RefreshTokenError,
} from "./service.js";

// Argon2 is deliberately expensive; an unbounded password length would let one request cost a lot of CPU, so it is capped.
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  deviceId: z.string().uuid().optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

// Limits (per client IP unless noted). The login limit counts FAILED attempts per IP + email, so a person who mistypes is not locked out by someone else's traffic and an attacker
// cannot guess passwords at speed. Registration limits protect against account farming (each account gets the free AI quota).
const LOGIN_FAILS = Number(process.env.RATE_LIMIT_LOGIN_FAILS ?? 8);
const LOGIN_WINDOW_SEC = 15 * 60;
const REGISTER_PER_HOUR = Number(process.env.RATE_LIMIT_REGISTER_PER_HOUR ?? 20);

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password, deviceId } = parsed.data;

    const rl = await hit(`register:${request.ip}`, REGISTER_PER_HOUR, 3600);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
    }

    const existing = await query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: "An account with this email already exists" });
    }

    const passwordHash = await hashPassword(password);
    const inserted = await query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, passwordHash]
    );
    const userId = inserted.rows[0].id;

    const accessToken = await issueAccessToken(userId);
    const refresh = await issueRefreshToken(userId, deviceId ?? null);

    return reply.code(201).send({ accessToken, refreshToken: refresh.rawToken, userId });
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password, deviceId } = parsed.data;

    const limitKey = `login:${request.ip}:${email}`;
    const blocked = await peek(limitKey, LOGIN_FAILS);
    if (blocked.blocked) {
      reply.header("Retry-After", String(blocked.retryAfterSec));
      return reply.code(429).send({ error: "too_many_attempts", retryAfterSec: blocked.retryAfterSec });
    }

    // Never leak whether the email exists — same generic error either way.
    const genericError = { error: "Invalid credentials" };

    const result = await query<UserRow>("SELECT id, email, password_hash FROM users WHERE lower(email) = $1", [email]);
    const user = result.rows[0];
    if (!user) {
      await hit(limitKey, LOGIN_FAILS, LOGIN_WINDOW_SEC);
      return reply.code(401).send(genericError);
    }

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      await hit(limitKey, LOGIN_FAILS, LOGIN_WINDOW_SEC);
      return reply.code(401).send(genericError);
    }
    await reset(limitKey);

    const accessToken = await issueAccessToken(user.id);
    const refresh = await issueRefreshToken(user.id, deviceId ?? null);

    return reply.code(200).send({ accessToken, refreshToken: refresh.rawToken, userId: user.id });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    try {
      const rotated = await rotateRefreshToken(parsed.data.refreshToken);
      return reply.code(200).send({ accessToken: rotated.accessToken, refreshToken: rotated.refreshToken, userId: rotated.userId });
    } catch (err) {
      if (err instanceof RefreshTokenError) {
        return reply.code(401).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    await revokeRefreshToken(parsed.data.refreshToken);
    return reply.code(200).send({ ok: true });
  });
}
