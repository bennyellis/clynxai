import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Missing or malformed Authorization header" });
  }

  const token = header.slice("Bearer ".length).trim();
  const payload = await verifyAccessToken(token);
  if (!payload) {
    return reply.code(401).send({ error: "Invalid or expired access token" });
  }

  request.userId = payload.sub;
}
