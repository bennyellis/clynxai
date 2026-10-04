import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { runSearchDemandAggregation, getLatestSearchDemandSnapshot } from "./service.js";

// Clynx Cloud Phase 7 — Search Planner foundation. Behind requireAuth: any
// authenticated user can view/trigger for this foundation phase — there is
// no admin-role concept anywhere in the codebase yet, so this is a known
// gap to revisit once one exists (e.g. before this is exposed beyond
// internal tooling). Aggregation runs synchronously on request, not on a
// timer/queue — see service.ts.

const demandQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

function snapshotRowToJson(row: {
  id: string;
  computed_at: string;
  phrase_normalized: string;
  watch_count: number;
  sample_watch_ids: string[];
}) {
  return {
    id: row.id,
    computedAt: row.computed_at,
    phraseNormalized: row.phrase_normalized,
    watchCount: row.watch_count,
    sampleWatchIds: row.sample_watch_ids,
  };
}

export async function searchPlannerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Manual trigger — runs the aggregation synchronously and returns the
  // resulting groups. Not enqueued/scheduled yet (future wiring decision).
  app.post("/search-planner/aggregate", async (_request, reply) => {
    const { computedAt, groups } = await runSearchDemandAggregation();
    return reply.code(200).send({ computedAt, groups });
  });

  // Returns the most recent snapshot batch (rows sharing the max
  // computed_at), sorted by watch_count descending.
  app.get("/search-planner/demand", async (request, reply) => {
    const parsed = demandQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const { limit } = parsed.data;

    const rows = await getLatestSearchDemandSnapshot(limit);
    return reply.code(200).send({ demand: rows.map(snapshotRowToJson) });
  });
}
