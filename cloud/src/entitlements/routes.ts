import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.js";
import { effectivePlanFor } from "./enforce.js";

// Read-only. The plan reported is the EFFECTIVE one: the better of the stored base plan and what the user's subscription entitles them to right now.
export async function entitlementsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/me/entitlements", async (request, reply) => {
    const eff = await effectivePlanFor(request.userId as string);
    if (!eff) {
      // Shouldn't happen for a valid access token, but guard anyway rather than crashing.
      return reply.code(404).send({ error: "User not found" });
    }
    return reply.code(200).send({ plan: eff.plan, entitlements: eff.entitlements });
  });
}
