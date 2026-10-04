import type { FastifyInstance } from "fastify";
import { query } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { getEntitlementsForPlan, type Plan } from "./plans.js";

interface UserPlanRow {
  plan: Plan;
}

// The ONE new route for Phase 9 — purely read-only. Nothing calls this yet
// besides a future client; it does not gate or enforce anything itself.
export async function entitlementsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/me/entitlements", async (request, reply) => {
    const result = await query<UserPlanRow>("SELECT plan FROM users WHERE id = $1", [request.userId]);
    const user = result.rows[0];
    if (!user) {
      // Shouldn't happen for a valid access token, but guard anyway rather
      // than crashing on `undefined.plan`.
      return reply.code(404).send({ error: "User not found" });
    }

    const entitlements = getEntitlementsForPlan(user.plan);
    return reply.code(200).send({ plan: user.plan, entitlements });
  });
}
