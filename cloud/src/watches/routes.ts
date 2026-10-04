import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { requireOwnedRow, isStaleUpdate } from "../shared/syncedResource.js";

// Clynx Cloud Phase 2 — Watch cloud persistence/synchronization. Mirrors
// devices/routes.ts's ownership-check pattern (403/404 on cross-user
// access) exactly. Local SQLite (src/main/store.ts) stays the sole source
// of truth for the live scan loop — these routes only ever read/write this
// background-synced Postgres mirror, driven by src/main/watchSync.ts.
//
// Fix 3 (batch 1 cloud fix pass) — GET /watches?since= now takes a
// server-side monotonic `revision` (BIGSERIAL) integer, not a
// client-supplied updated_at timestamp. A client-clock-based cursor could
// silently miss a late/offline push from a different device forever, since
// it sorts by a value the CLIENT controls. See migrations/008_sync_revision.sql.
//
// Fix 4 (same batch) — the cloud side no longer accepts, stores, or
// returns the 8 desktop-local-only operational/scheduler fields
// (nextCheckAt, lastCheckedAt, lastActiveCheckAt, listingsSeenCount,
// matchCount, resolvedLocationUrl, resolvedLocationLabel,
// resolvedLocationCheckedAt). Those are set by each device's own local scan
// loop and must never be treated as shared/synced content — only
// user-editable content fields sync across devices now. The underlying
// Postgres columns still exist (see migrations/008_sync_revision.sql for
// why they weren't dropped) but this route no longer reads or writes them.
// BATCH 2 (desktop-side) MUST stop sending these 8 fields in PUT
// /watches/:localId bodies and stop expecting them back in responses.

const watchIdParamSchema = z.object({ id: z.string().uuid() });
const localIdParamSchema = z.object({ localId: z.string().min(1) });
// Used only by GET /watches/:id/matches (watch_matches.created_at is a
// TIMESTAMPTZ, unrelated to the Fix 3 revision cursor below).
const sinceQuerySchema = z.object({ since: z.string().datetime().optional() });
// Fix 3 — the revision-based pull cursor for GET /watches. Defaults to 0
// (every row) when omitted.
const sinceRevisionQuerySchema = z.object({ since: z.coerce.number().int().min(0).optional() });

const watchUpsertSchema = z.object({
  deviceId: z.string().uuid().nullable().optional(),
  name: z.string().min(1),
  searchPhrase: z.string().min(1),
  matchKeywords: z.array(z.string()).default([]),
  linkedProductId: z.string().nullable().optional(),
  minPriceUsd: z.number().nullable().optional(),
  maxPriceUsd: z.number().nullable().optional(),
  minProfitUsd: z.number().nullable().optional(),
  minDiscountPercent: z.number().nullable().optional(),
  maxListingAgeMinutes: z.number().nullable().optional(),
  locationMode: z.enum(["country", "state", "city"]),
  selectedState: z.string().nullable().optional(),
  selectedCityOrZip: z.string().nullable().optional(),
  searchRadiusMiles: z.number().nullable().optional(),
  enabled: z.boolean().default(true),
  createdAt: z.number(),
  updatedAt: z.number(),
  // NOTE: deliberately no schema fields for the 8 operational/scheduler
  // properties (nextCheckAt, lastCheckedAt, lastActiveCheckAt,
  // listingsSeenCount, matchCount, resolvedLocationUrl,
  // resolvedLocationLabel, resolvedLocationCheckedAt) — see Fix 4 above.
  // Zod strips any unrecognized keys from the parsed body by default (this
  // schema isn't `.strict()`), so a batch-1-unaware caller that still
  // sends them is simply ignored, not rejected.
});

const matchesBulkSchema = z.object({
  matches: z.array(
    z.object({
      localId: z.string().min(1),
      listingId: z.string().min(1),
      matchedAt: z.number(),
      foundByAccountId: z.string().nullable().optional(),
      foundByAccountLabel: z.string().nullable().optional(),
      discoveryMode: z.enum(["passive", "active"]),
      priceAtMatch: z.number().nullable().optional(),
      discountPercentAtMatch: z.number().nullable().optional(),
      profitUsdAtMatch: z.number().nullable().optional(),
      notified: z.boolean().default(false),
      notifiedAt: z.number().nullable().optional(),
    })
  ),
});

interface WatchRow {
  id: string;
  local_id: string;
  user_id: string;
  device_id: string | null;
  name: string;
  search_phrase: string;
  match_keywords: string[];
  linked_product_id: string | null;
  min_price_usd: number | null;
  max_price_usd: number | null;
  min_profit_usd: number | null;
  min_discount_percent: number | null;
  max_listing_age_minutes: number | null;
  location_mode: "country" | "state" | "city";
  selected_state: string | null;
  selected_city_or_zip: string | null;
  search_radius_miles: number | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  // BIGSERIAL — the pg driver returns int8 columns as strings to avoid
  // precision loss; watchRowToJson below converts to a JS number.
  revision: string | number;
}

function watchRowToJson(row: WatchRow) {
  return {
    id: row.id,
    localId: row.local_id,
    deviceId: row.device_id,
    name: row.name,
    searchPhrase: row.search_phrase,
    matchKeywords: row.match_keywords,
    linkedProductId: row.linked_product_id,
    minPriceUsd: row.min_price_usd,
    maxPriceUsd: row.max_price_usd,
    minProfitUsd: row.min_profit_usd,
    minDiscountPercent: row.min_discount_percent,
    maxListingAgeMinutes: row.max_listing_age_minutes,
    locationMode: row.location_mode,
    selectedState: row.selected_state,
    selectedCityOrZip: row.selected_city_or_zip,
    searchRadiusMiles: row.search_radius_miles,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Fix 3 — the server-assigned sync cursor value for this row. Batch 2
    // should persist this locally per-row and send the max seen back as
    // the next pull's ?since=.
    revision: Number(row.revision),
  };
}

export async function watchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Incremental sync pull — all of the caller's own watches, optionally
  // narrowed to those with a revision greater than the given cursor
  // (watchSync.ts's sync cursor). See Fix 3 above for why this is a
  // server-assigned revision, not a client-supplied timestamp.
  app.get("/watches", async (request, reply) => {
    const parsed = sinceRevisionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const since = parsed.data.since ?? 0;

    const result = await query<WatchRow>(
      `SELECT * FROM watches WHERE user_id = $1 AND revision > $2 ORDER BY revision ASC`,
      [request.userId, since]
    );

    return reply.code(200).send({ watches: result.rows.map(watchRowToJson) });
  });

  // Upsert by the client's own local watch id. Last-write-wins: only
  // applied when the incoming updated_at is strictly newer than what's
  // already stored; otherwise the server's current version is returned
  // unchanged so the client can reconcile (pull it back down locally).
  app.put("/watches/:localId", async (request, reply) => {
    const paramsParsed = localIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid local watch id" });
    }
    const bodyParsed = watchUpsertSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }
    const { localId } = paramsParsed.data;
    const w = bodyParsed.data;

    const existing = await query<WatchRow>("SELECT * FROM watches WHERE user_id = $1 AND local_id = $2", [
      request.userId,
      localId,
    ]);
    const current = existing.rows[0];

    if (current && isStaleUpdate(current.updated_at, w.updatedAt)) {
      // Incoming write is stale (or a no-op tie) — reject the write, hand
      // back what the server actually has so the caller can reconcile.
      return reply.code(200).send({ applied: false, watch: watchRowToJson(current) });
    }

    if (current) {
      const updated = await query<WatchRow>(
        `UPDATE watches SET
          device_id = $1, name = $2, search_phrase = $3, match_keywords = $4, linked_product_id = $5,
          min_price_usd = $6, max_price_usd = $7, min_profit_usd = $8, min_discount_percent = $9, max_listing_age_minutes = $10,
          location_mode = $11, selected_state = $12, selected_city_or_zip = $13, search_radius_miles = $14,
          enabled = $15, updated_at = $16,
          revision = nextval(pg_get_serial_sequence('watches', 'revision'))
         WHERE id = $17
         RETURNING *`,
        [
          w.deviceId ?? null,
          w.name,
          w.searchPhrase,
          JSON.stringify(w.matchKeywords),
          w.linkedProductId ?? null,
          w.minPriceUsd ?? null,
          w.maxPriceUsd ?? null,
          w.minProfitUsd ?? null,
          w.minDiscountPercent ?? null,
          w.maxListingAgeMinutes ?? null,
          w.locationMode,
          w.selectedState ?? null,
          w.selectedCityOrZip ?? null,
          w.searchRadiusMiles ?? null,
          w.enabled,
          w.updatedAt,
          current.id,
        ]
      );
      return reply.code(200).send({ applied: true, watch: watchRowToJson(updated.rows[0]) });
    }

    const inserted = await query<WatchRow>(
      `INSERT INTO watches (
        local_id, user_id, device_id, name, search_phrase, match_keywords, linked_product_id,
        min_price_usd, max_price_usd, min_profit_usd, min_discount_percent, max_listing_age_minutes,
        location_mode, selected_state, selected_city_or_zip, search_radius_miles,
        enabled, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING *`,
      [
        localId,
        request.userId,
        w.deviceId ?? null,
        w.name,
        w.searchPhrase,
        JSON.stringify(w.matchKeywords),
        w.linkedProductId ?? null,
        w.minPriceUsd ?? null,
        w.maxPriceUsd ?? null,
        w.minProfitUsd ?? null,
        w.minDiscountPercent ?? null,
        w.maxListingAgeMinutes ?? null,
        w.locationMode,
        w.selectedState ?? null,
        w.selectedCityOrZip ?? null,
        w.searchRadiusMiles ?? null,
        w.enabled,
        w.createdAt,
        w.updatedAt,
      ]
    );
    return reply.code(201).send({ applied: true, watch: watchRowToJson(inserted.rows[0]) });
  });

  app.delete("/watches/:id", async (request, reply) => {
    const paramsParsed = watchIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid watch id" });
    }
    const { id } = paramsParsed.data;

    const ownership = await requireOwnedRow("watches", id, request.userId!);
    if (ownership.status === "not_found") {
      return reply.code(404).send({ error: "Watch not found" });
    }
    if (ownership.status === "forbidden") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await query("DELETE FROM watches WHERE id = $1", [id]);
    return reply.code(200).send({ ok: true });
  });

  // Bulk-append match records for one watch. Append-only — matches are
  // immutable once created, so this is dedup-on-conflict, not upsert.
  app.post("/watches/:id/matches", async (request, reply) => {
    const paramsParsed = watchIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid watch id" });
    }
    const bodyParsed = matchesBulkSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }
    const { id } = paramsParsed.data;

    const ownership = await requireOwnedRow("watches", id, request.userId!);
    if (ownership.status === "not_found") {
      return reply.code(404).send({ error: "Watch not found" });
    }
    if (ownership.status === "forbidden") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    let inserted = 0;
    for (const m of bodyParsed.data.matches) {
      const result = await query(
        `INSERT INTO watch_matches (
          local_id, watch_id, user_id, listing_id, matched_at, found_by_account_id, found_by_account_label,
          discovery_mode, price_at_match, discount_percent_at_match, profit_usd_at_match, notified, notified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (watch_id, local_id) DO NOTHING`,
        [
          m.localId,
          id,
          request.userId,
          m.listingId,
          m.matchedAt,
          m.foundByAccountId ?? null,
          m.foundByAccountLabel ?? null,
          m.discoveryMode,
          m.priceAtMatch ?? null,
          m.discountPercentAtMatch ?? null,
          m.profitUsdAtMatch ?? null,
          m.notified,
          m.notifiedAt ?? null,
        ]
      );
      inserted += result.rowCount ?? 0;
    }

    return reply.code(200).send({ ok: true, inserted });
  });

  app.get("/watches/:id/matches", async (request, reply) => {
    const paramsParsed = watchIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid watch id" });
    }
    const queryParsed = sinceQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.code(400).send({ error: "Invalid query", details: queryParsed.error.flatten() });
    }
    const { id } = paramsParsed.data;
    const { since } = queryParsed.data;

    const ownership = await requireOwnedRow("watches", id, request.userId!);
    if (ownership.status === "not_found") {
      return reply.code(404).send({ error: "Watch not found" });
    }
    if (ownership.status === "forbidden") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const result = since
      ? await query(`SELECT * FROM watch_matches WHERE watch_id = $1 AND created_at > $2 ORDER BY created_at ASC`, [
          id,
          since,
        ])
      : await query(`SELECT * FROM watch_matches WHERE watch_id = $1 ORDER BY created_at ASC`, [id]);

    return reply.code(200).send({
      matches: result.rows.map((row: any) => ({
        localId: row.local_id,
        listingId: row.listing_id,
        matchedAt: row.matched_at,
        foundByAccountId: row.found_by_account_id,
        foundByAccountLabel: row.found_by_account_label,
        discoveryMode: row.discovery_mode,
        priceAtMatch: row.price_at_match,
        discountPercentAtMatch: row.discount_percent_at_match,
        profitUsdAtMatch: row.profit_usd_at_match,
        notified: row.notified,
        notifiedAt: row.notified_at,
      })),
    });
  });
}
