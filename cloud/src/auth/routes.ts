import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import {
  hashPassword,
  verifyPassword,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  RefreshTokenError,
} from "./service.js";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  deviceId: z.string().uuid().optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password, deviceId } = parsed.data;

    const existing = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
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

    // Never leak whether the email exists — same generic error either way.
    const genericError = { error: "Invalid credentials" };

    const result = await query<UserRow>("SELECT id, email, password_hash FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user) {
      return reply.code(401).send(genericError);
    }

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      return reply.code(401).send(genericError);
    }

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
