import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AccountError, checkLogin, emailSchema, passwordSchema, registerUser } from "./accounts.js";
import { issueAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, RefreshTokenError } from "./service.js";

// The desktop app's account endpoints (bearer tokens). The website uses /web/* (cookie sessions) over the same accounts; the shared rules live in ./accounts.ts.
const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  deviceId: z.string().uuid().optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
  deviceId: z.string().uuid().optional(),
});

export function sendAccountError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AccountError) {
    if (err.retryAfterSec) reply.header("Retry-After", String(err.retryAfterSec));
    return reply.code(err.status).send(err.body);
  }
  throw err;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password, deviceId } = parsed.data;
    try {
      const userId = await registerUser(email, password, request.ip);
      const accessToken = await issueAccessToken(userId);
      const refresh = await issueRefreshToken(userId, deviceId ?? null);
      return reply.code(201).send({ accessToken, refreshToken: refresh.rawToken, userId });
    } catch (err) {
      return sendAccountError(reply, err);
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }
    const { email, password, deviceId } = parsed.data;
    try {
      const user = await checkLogin(email, password, request.ip);
      const accessToken = await issueAccessToken(user.id);
      const refresh = await issueRefreshToken(user.id, deviceId ?? null);
      return reply.code(200).send({ accessToken, refreshToken: refresh.rawToken, userId: user.id });
    } catch (err) {
      return sendAccountError(reply, err);
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    try {
      const rotated = await rotateRefreshToken(parsed.data.refreshToken, parsed.data.deviceId);
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
