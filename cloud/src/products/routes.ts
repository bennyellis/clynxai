import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { requireOwnedRow, isStaleUpdate } from "../shared/syncedResource.js";

// Clynx Cloud Phase 6 — personal Database/Library (ProductProfile) cloud
// persistence/synchronization. Mirrors watches/routes.ts's ownership +
// last-write-wins upsert pattern exactly. Local SQLite (src/main/store.ts's
// `products` table) stays the sole source of truth for the Database/Library
// UI — these routes only ever read/write this background-synced Postgres
// mirror, driven by src/main/productSync.ts. Backed by `user_products`
// (see 006_products.sql for why it isn't named `products`).

const productIdParamSchema = z.object({ id: z.string().uuid() });
const localIdParamSchema = z.object({ localId: z.string().min(1) });
// Fix 3 (batch 1 cloud fix pass) — GET /products?since= now takes a
// server-side monotonic `revision` (BIGSERIAL) integer, not a
// client-supplied updated_at timestamp; see migrations/008_sync_revision.sql
// and watches/routes.ts's own Fix 3 comment for the full rationale.
// Defaults to 0 (every row) when omitted.
const sinceQuerySchema = z.object({ since: z.coerce.number().int().min(0).optional() });

const productUpsertSchema = z.object({
  name: z.string().min(1),
  aiSummary: z.string().nullable().optional(),
  aiSummaryGeneratedAt: z.number().nullable().optional(),
  observedNotes: z.string().nullable().optional(),
  category: z.string().default("Other"),
  family: z.string().nullable().optional(),
  resalePriceUsd: z.number().nullable().optional(),
  resaleTimeToSell: z.string().nullable().optional(),
  lookoutNotes: z.string().nullable().optional(),
  keepThumbnail: z.boolean().default(false),
  desiredPriceUsd: z.number().nullable().optional(),
  hardCapAtDesiredPrice: z.boolean().default(false),
  prioritized: z.boolean().default(false),
  ebayAvgSoldPriceUsd: z.number().nullable().optional(),
  ebayAvgRunTimeDays: z.number().nullable().optional(),
  ebayAvgShippingUsd: z.number().nullable().optional(),
  ebayCompsSampleSize: z.number().nullable().optional(),
  ebayCompsCheckedAt: z.number().nullable().optional(),
  loading: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});

interface ProductRow {
  id: string;
  local_id: string;
  user_id: string;
  name: string;
  ai_summary: string | null;
  ai_summary_generated_at: number | null;
  observed_notes: string | null;
  category: string;
  family: string | null;
  resale_price_usd: number | null;
  resale_time_to_sell: string | null;
  lookout_notes: string | null;
  keep_thumbnail: boolean;
  desired_price_usd: number | null;
  hard_cap_at_desired_price: boolean;
  prioritized: boolean;
  ebay_avg_sold_price_usd: number | null;
  ebay_avg_run_time_days: number | null;
  ebay_avg_shipping_usd: number | null;
  ebay_comps_sample_size: number | null;
  ebay_comps_checked_at: number | null;
  loading: boolean;
  created_at: number;
  updated_at: number;
  // BIGSERIAL — the pg driver returns int8 columns as strings to avoid
  // precision loss; productRowToJson below converts to a JS number.
  revision: string | number;
}

function productRowToJson(row: ProductRow) {
  return {
    id: row.id,
    localId: row.local_id,
    name: row.name,
    aiSummary: row.ai_summary,
    aiSummaryGeneratedAt: row.ai_summary_generated_at,
    observedNotes: row.observed_notes,
    category: row.category,
    family: row.family,
    resalePriceUsd: row.resale_price_usd,
    resaleTimeToSell: row.resale_time_to_sell,
    lookoutNotes: row.lookout_notes,
    keepThumbnail: row.keep_thumbnail,
    desiredPriceUsd: row.desired_price_usd,
    hardCapAtDesiredPrice: row.hard_cap_at_desired_price,
    prioritized: row.prioritized,
    ebayAvgSoldPriceUsd: row.ebay_avg_sold_price_usd,
    ebayAvgRunTimeDays: row.ebay_avg_run_time_days,
    ebayAvgShippingUsd: row.ebay_avg_shipping_usd,
    ebayCompsSampleSize: row.ebay_comps_sample_size,
    ebayCompsCheckedAt: row.ebay_comps_checked_at,
    loading: row.loading,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Fix 3 — the server-assigned sync cursor value for this row.
    revision: Number(row.revision),
  };
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Incremental sync pull — all of the caller's own products, optionally
  // narrowed to those changed since a given ISO timestamp (productSync.ts's
  // sync cursor).
  app.get("/products", async (request, reply) => {
    const parsed = sinceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const since = parsed.data.since ?? 0;

    const result = await query<ProductRow>(
      `SELECT * FROM user_products WHERE user_id = $1 AND revision > $2 ORDER BY revision ASC`,
      [request.userId, since]
    );

    return reply.code(200).send({ products: result.rows.map(productRowToJson) });
  });

  // Upsert by the client's own local product id. Last-write-wins: only
  // applied when the incoming updated_at is strictly newer than what's
  // already stored; otherwise the server's current version is returned
  // unchanged so the client can reconcile (pull it back down locally).
  app.put("/products/:localId", async (request, reply) => {
    const paramsParsed = localIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid local product id" });
    }
    const bodyParsed = productUpsertSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }
    const { localId } = paramsParsed.data;
    const p = bodyParsed.data;

    const existing = await query<ProductRow>("SELECT * FROM user_products WHERE user_id = $1 AND local_id = $2", [
      request.userId,
      localId,
    ]);
    const current = existing.rows[0];

    if (current && isStaleUpdate(current.updated_at, p.updatedAt)) {
      // Incoming write is stale (or a no-op tie) — reject the write, hand
      // back what the server actually has so the caller can reconcile.
      return reply.code(200).send({ applied: false, product: productRowToJson(current) });
    }

    if (current) {
      const updated = await query<ProductRow>(
        `UPDATE user_products SET
          name = $1, ai_summary = $2, ai_summary_generated_at = $3, observed_notes = $4, category = $5, family = $6,
          resale_price_usd = $7, resale_time_to_sell = $8, lookout_notes = $9, keep_thumbnail = $10,
          desired_price_usd = $11, hard_cap_at_desired_price = $12, prioritized = $13,
          ebay_avg_sold_price_usd = $14, ebay_avg_run_time_days = $15, ebay_avg_shipping_usd = $16,
          ebay_comps_sample_size = $17, ebay_comps_checked_at = $18, loading = $19, updated_at = $20,
          revision = nextval(pg_get_serial_sequence('user_products', 'revision'))
         WHERE id = $21
         RETURNING *`,
        [
          p.name,
          p.aiSummary ?? null,
          p.aiSummaryGeneratedAt ?? null,
          p.observedNotes ?? null,
          p.category,
          p.family ?? null,
          p.resalePriceUsd ?? null,
          p.resaleTimeToSell ?? null,
          p.lookoutNotes ?? null,
          p.keepThumbnail,
          p.desiredPriceUsd ?? null,
          p.hardCapAtDesiredPrice,
          p.prioritized,
          p.ebayAvgSoldPriceUsd ?? null,
          p.ebayAvgRunTimeDays ?? null,
          p.ebayAvgShippingUsd ?? null,
          p.ebayCompsSampleSize ?? null,
          p.ebayCompsCheckedAt ?? null,
          p.loading,
          p.updatedAt,
          current.id,
        ]
      );
      return reply.code(200).send({ applied: true, product: productRowToJson(updated.rows[0]) });
    }

    const inserted = await query<ProductRow>(
      `INSERT INTO user_products (
        local_id, user_id, name, ai_summary, ai_summary_generated_at, observed_notes, category, family,
        resale_price_usd, resale_time_to_sell, lookout_notes, keep_thumbnail,
        desired_price_usd, hard_cap_at_desired_price, prioritized,
        ebay_avg_sold_price_usd, ebay_avg_run_time_days, ebay_avg_shipping_usd,
        ebay_comps_sample_size, ebay_comps_checked_at, loading, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *`,
      [
        localId,
        request.userId,
        p.name,
        p.aiSummary ?? null,
        p.aiSummaryGeneratedAt ?? null,
        p.observedNotes ?? null,
        p.category,
        p.family ?? null,
        p.resalePriceUsd ?? null,
        p.resaleTimeToSell ?? null,
        p.lookoutNotes ?? null,
        p.keepThumbnail,
        p.desiredPriceUsd ?? null,
        p.hardCapAtDesiredPrice,
        p.prioritized,
        p.ebayAvgSoldPriceUsd ?? null,
        p.ebayAvgRunTimeDays ?? null,
        p.ebayAvgShippingUsd ?? null,
        p.ebayCompsSampleSize ?? null,
        p.ebayCompsCheckedAt ?? null,
        p.loading,
        p.createdAt,
        p.updatedAt,
      ]
    );
    return reply.code(201).send({ applied: true, product: productRowToJson(inserted.rows[0]) });
  });

  app.delete("/products/:id", async (request, reply) => {
    const paramsParsed = productIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: "Invalid product id" });
    }
    const { id } = paramsParsed.data;

    const ownership = await requireOwnedRow("user_products", id, request.userId!);
    if (ownership.status === "not_found") {
      return reply.code(404).send({ error: "Product not found" });
    }
    if (ownership.status === "forbidden") {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await query("DELETE FROM user_products WHERE id = $1", [id]);
    return reply.code(200).send({ ok: true });
  });
}
