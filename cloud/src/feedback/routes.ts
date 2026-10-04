import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { isStaleUpdate } from "../shared/syncedResource.js";

// Clynx Cloud Phase 5 — Feed feedback cloud persistence/synchronization.
// Mirrors watches/routes.ts's ownership + last-write-wins upsert pattern
// exactly, but keyed by (user_id, listing_id) instead of a client-issued
// local_id — the local SQLite `feedback` table (src/main/store.ts) is
// already one row per listing, so there's no separate local id to carry.
// Local SQLite remains the sole source of truth for the Feed UI; this is
// only ever read/written by src/main/feedbackSync.ts.

const listingIdParamSchema = z.object({ listingId: z.string().uuid() });
// Fix 3 (batch 1 cloud fix pass) — GET /feedback?since= now takes a
// server-side monotonic `revision` (BIGSERIAL) integer, not a
// client-supplied updated_at timestamp; see migrations/008_sync_revision.sql
// and watches/routes.ts's own Fix 3 comment for the full rationale.
// Defaults to 0 (every row) when omitted.
const sinceQuerySchema = z.object({ since: z.coerce.number().int().min(0).optional() });

const feedbackUpsertSchema = z.object({
  verdict: z.enum(["good", "bad"]),
  note: z.string().nullable().optional(),
  updatedAt: z.number(),
  createdAt: z.number().optional(),
});

interface FeedbackRow {
  id: string;
  user_id: string;
  listing_id: string;
  verdict: "good" | "bad";
  note: string | null;
  created_at: number;
  updated_at: number;
  // BIGSERIAL — the pg driver returns int8 columns as strings to avoid
  // precision loss; feedbackRowToJson below converts to a JS number.
  revision: string | number;
  // Only present when joined against listings (the list/pull route) —
  // the local Facebook item id the desktop client needs to apply this
  // feedback back onto its own local `feedback` table, without any
  // separate reverse-lookup round trip.
  source_listing_id?: string;
}

function feedbackRowToJson(row: FeedbackRow) {
  return {
    listingId: row.listing_id,
    sourceListingId: row.source_listing_id ?? null,
    verdict: row.verdict,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Fix 3 — the server-assigned sync cursor value for this row.
    revision: Number(row.revision),
  };
}

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Incremental sync pull — all of the caller's own feedback rows,
  // optionally narrowed to those changed since a given ISO timestamp
  // (feedbackSync.ts's sync cursor). Joins listings to hand back the
  // local Facebook item id directly, so the desktop client can apply a
  // pulled row without a separate lookup.
  app.get("/feedback", async (request, reply) => {
    const parsed = sinceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const since = parsed.data.since ?? 0;

    const result = await query<FeedbackRow>(
      `SELECT f.*, l.source_listing_id FROM listing_feedback f
       JOIN listings l ON l.id = f.listing_id
       WHERE f.user_id = $1 AND f.revision > $2 ORDER BY f.revision ASC`,
      [request.userId, since]
    );

    return reply.code(200).send({ feedback: result.rows.map(feedbackRowToJson) });
  });

  // Upsert by (user_id, listing_id) — listingId here is the CLOUD
  // canonical listings.id (uuid), resolved by the caller beforehand via
  // GET /listings/lookup. Last-write-wins, identical semantics to
  // watches/routes.ts's PUT /watches/:localId.
  app.put("/feedback/:listingId", async (request, reply) => {
    const paramsParsed = listingIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid listing id" });
    }
    const bodyParsed = feedbackUpsertSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }
    const { listingId } = paramsParsed.data;
    const f = bodyParsed.data;

    const listingExists = await query<{ id: string }>("SELECT id FROM listings WHERE id = $1", [listingId]);
    if (!listingExists.rows[0]) {
      return reply.code(404).send({ error: "Listing not found" });
    }

    const existing = await query<FeedbackRow>(
      "SELECT * FROM listing_feedback WHERE user_id = $1 AND listing_id = $2",
      [request.userId, listingId]
    );
    const current = existing.rows[0];

    if (current && isStaleUpdate(current.updated_at, f.updatedAt)) {
      // Incoming write is stale (or a no-op tie) — reject, hand back what's
      // actually stored so the caller can reconcile.
      return reply.code(200).send({ applied: false, feedback: feedbackRowToJson(current) });
    }

    if (current) {
      const updated = await query<FeedbackRow>(
        `UPDATE listing_feedback SET
          verdict = $1, note = $2, updated_at = $3,
          revision = nextval(pg_get_serial_sequence('listing_feedback', 'revision'))
         WHERE id = $4 RETURNING *`,
        [f.verdict, f.note ?? null, f.updatedAt, current.id]
      );
      return reply.code(200).send({ applied: true, feedback: feedbackRowToJson(updated.rows[0]) });
    }

    const inserted = await query<FeedbackRow>(
      `INSERT INTO listing_feedback (user_id, listing_id, verdict, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [request.userId, listingId, f.verdict, f.note ?? null, f.createdAt ?? f.updatedAt, f.updatedAt]
    );
    return reply.code(201).send({ applied: true, feedback: feedbackRowToJson(inserted.rows[0]) });
  });

  app.delete("/feedback/:listingId", async (request, reply) => {
    const paramsParsed = listingIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid listing id" });
    }
    const { listingId } = paramsParsed.data;

    const existing = await query<{ user_id: string }>(
      "SELECT user_id FROM listing_feedback WHERE listing_id = $1 AND user_id = $2",
      [listingId, request.userId]
    );
    // Ownership is folded into the lookup itself (unlike watches' delete,
    // which fetches by server id alone and then compares) since there is no
    // separate feedback id in this API's surface — a caller only ever
    // knows a listingId, which by itself doesn't reveal whether some OTHER
    // user has feedback on it. A row that exists but belongs to someone
    // else must look identical to "no such row" from this user's
    // perspective, so this always returns 404 for cross-user access.
    if (!existing.rows[0]) {
      return reply.code(404).send({ error: "Feedback not found" });
    }

    await query("DELETE FROM listing_feedback WHERE listing_id = $1 AND user_id = $2", [listingId, request.userId]);
    return reply.code(200).send({ ok: true });
  });
}
