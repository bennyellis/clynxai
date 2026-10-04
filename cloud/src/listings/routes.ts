import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { enqueueListingProcessing } from "../queue/listingProcessingQueue.js";

// Clynx Cloud Phase 3 — Listing ingestion + global dedup. Behind
// requireAuth (any authenticated user/device may ingest — this table is a
// SHARED canonical cache, not per-user-owned, unlike watches/devices; see
// migrations/003_listings.sql), but otherwise deliberately dumb/fast:
// validate, normalize identity, dedupe by (source, source_listing_id),
// upsert, return the canonical id. No AI, no job queue — that's Phase 4.
//
// src/main/listingIngestSync.ts is the only caller. It pushes ALL scanned
// listings (not just scored deals) to preserve future General Discovery
// value, batched to avoid one-request-per-listing at scan volume.

const listingSchema = z.object({
  source: z.string().min(1),
  sourceListingId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  price: z.number().nullable().optional(),
  currency: z.string().min(1).optional(),
  url: z.string().min(1),
  thumbnailUrl: z.string().nullable().optional(),
  images: z.array(z.string()).default([]),
  locationText: z.string().nullable().optional(),
  listingAge: z.string().nullable().optional(),
  sellerName: z.string().nullable().optional(),
  sellerJoinedYear: z.number().nullable().optional(),
  sellerRating: z.number().nullable().optional(),
  sellerRatingCount: z.number().nullable().optional(),
  sellerHasProfilePhoto: z.boolean().nullable().optional(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number().optional(),
});

const ingestBodySchema = z.union([
  z.object({ listings: z.array(z.unknown()).min(1) }),
  z.record(z.string(), z.unknown()), // a single listing object
]);

interface IngestSuccess {
  id: string;
  isNew: boolean;
  changed: boolean;
}
interface IngestFailure {
  index: number;
  error: string;
}

async function ingestOne(userIdIgnored: unknown, item: z.infer<typeof listingSchema>): Promise<IngestSuccess> {
  const lastSeenAt = item.lastSeenAt ?? item.firstSeenAt;

  // Read-only, NON-GATING lookup — used only to compute the "changed"
  // field below for an already-existing row. It must never decide isNew
  // or branch the write itself: a separate pre-check SELECT disconnected
  // from the write is exactly the race this function used to have (two
  // concurrent ingests of the same brand-new listing could both see "no
  // existing row" here and both proceed to treat themselves as the
  // inserter). The actual isNew decision below comes solely from the
  // INSERT statement's own atomic (xmax = 0) result.
  const priorLookup = await query<{ title: string; price: number | null }>(
    "SELECT title, price FROM listings WHERE source = $1 AND source_listing_id = $2",
    [item.source, item.sourceListingId]
  );
  const prior = priorLookup.rows[0] ?? null;

  // Single atomic upsert. `xmax = 0` is a Postgres system-column trick:
  // xmax is 0 for a row produced by a fresh INSERT and non-zero for a row
  // touched by the ON CONFLICT DO UPDATE branch — so `inserted` tells us,
  // as part of the SAME statement that performs the write, whether this
  // call was the one that actually created the row. No race window exists
  // between "decide isNew" and "write the row" because they're the same
  // statement; concurrent callers upserting the same (source,
  // source_listing_id) serialize on Postgres's own unique-index conflict
  // handling, and exactly one of them gets inserted = true.
  const result = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO listings (
      source, source_listing_id, title, description, price, currency, url, thumbnail_url, images,
      location_text, listing_age, seller_name, seller_joined_year, seller_rating, seller_rating_count,
      seller_has_profile_photo, first_seen_at, last_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (source, source_listing_id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      price = EXCLUDED.price,
      currency = EXCLUDED.currency,
      url = EXCLUDED.url,
      thumbnail_url = EXCLUDED.thumbnail_url,
      images = EXCLUDED.images,
      location_text = EXCLUDED.location_text,
      listing_age = EXCLUDED.listing_age,
      seller_name = EXCLUDED.seller_name,
      seller_joined_year = EXCLUDED.seller_joined_year,
      seller_rating = EXCLUDED.seller_rating,
      seller_rating_count = EXCLUDED.seller_rating_count,
      seller_has_profile_photo = EXCLUDED.seller_has_profile_photo,
      last_seen_at = EXCLUDED.last_seen_at,
      updated_at = now()
    RETURNING id, (xmax = 0) AS inserted`,
    [
      item.source,
      item.sourceListingId,
      item.title,
      item.description ?? null,
      item.price ?? null,
      item.currency ?? "USD",
      item.url,
      item.thumbnailUrl ?? null,
      JSON.stringify(item.images ?? []),
      item.locationText ?? null,
      item.listingAge ?? null,
      item.sellerName ?? null,
      item.sellerJoinedYear ?? null,
      item.sellerRating ?? null,
      item.sellerRatingCount ?? null,
      item.sellerHasProfilePhoto ?? null,
      item.firstSeenAt,
      lastSeenAt,
    ]
  );
  const listingId = result.rows[0].id;
  const isNew = result.rows[0].inserted;

  if (!isNew) {
    const changed = prior ? prior.title !== item.title || (prior.price ?? null) !== (item.price ?? null) : false;
    return { id: listingId, isNew: false, changed };
  }

  // Phase 4: enqueue a (currently stub) processing job for newly-inserted
  // listings only — repeat ingests of an already-known listing (isNew
  // false) must NOT re-enqueue, to avoid duplicate job spam every scan
  // cycle re-seeing the same listing. Because isNew now comes from the
  // atomic INSERT itself, this branch is only ever reached by the single
  // caller that genuinely won the insert race, so concurrent ingests of a
  // brand-new listing enqueue exactly one job. A queue/Redis failure must
  // never fail the ingestion response itself, since ingestion succeeding
  // matters more than the job being enqueued.
  try {
    await enqueueListingProcessing({ listingId, source: item.source, sourceListingId: item.sourceListingId });
  } catch (err) {
    console.error(`[listings] failed to enqueue processing job for listing ${listingId}:`, err);
  }

  return { id: listingId, isNew: true, changed: false };
}

export async function listingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Accepts either a single normalized listing object, or { listings: [...] }
  // for batch ingestion. One bad item in a batch never fails the whole
  // batch — each item is validated independently; invalid ones are
  // reported (with their original index and why) instead of thrown.
  app.post("/listings/ingest", async (request, reply) => {
    const bodyParsed = ingestBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }

    const rawItems: unknown[] =
      typeof bodyParsed.data === "object" && bodyParsed.data !== null && "listings" in bodyParsed.data
        ? (bodyParsed.data as { listings: unknown[] }).listings
        : [bodyParsed.data];

    const results: Array<IngestSuccess | null> = new Array(rawItems.length).fill(null);
    const failures: IngestFailure[] = [];

    for (let i = 0; i < rawItems.length; i++) {
      const itemParsed = listingSchema.safeParse(rawItems[i]);
      if (!itemParsed.success) {
        failures.push({ index: i, error: itemParsed.error.message });
        continue;
      }
      try {
        results[i] = await ingestOne(request.userId, itemParsed.data);
      } catch (err) {
        failures.push({ index: i, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Single-item request (not the { listings: [...] } batch shape) — keep
    // the response shape flat, matching the single-object request shape.
    const isBatch = typeof bodyParsed.data === "object" && bodyParsed.data !== null && "listings" in bodyParsed.data;
    if (!isBatch) {
      if (failures.length > 0) {
        return reply.code(400).send({ error: "Invalid listing", details: failures[0].error });
      }
      return reply.code(200).send(results[0]);
    }

    return reply.code(200).send({ results, failures });
  });

  // Phase 5 — feedbackSync.ts's local-id -> cloud-canonical-id resolver.
  // Cheap, read-only lookup by the same (source, sourceListingId) identity
  // ingest dedupes on — lets the sync layer resolve a listing's cloud uuid
  // without re-sending the whole listing payload through /ingest just to
  // read back an id. 404 when the listing hasn't been ingested yet (the
  // caller's cue to skip and retry next cycle, once listingIngestSync.ts
  // has pushed it).
  app.get("/listings/lookup", async (request, reply) => {
    const parsed = z
      .object({ source: z.string().min(1), sourceListingId: z.string().min(1) })
      .safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const { source, sourceListingId } = parsed.data;
    const result = await query<{ id: string }>(
      "SELECT id FROM listings WHERE source = $1 AND source_listing_id = $2",
      [source, sourceListingId]
    );
    if (!result.rows[0]) {
      return reply.code(404).send({ error: "Listing not found" });
    }
    return reply.code(200).send({ id: result.rows[0].id });
  });

  // Phase 4 — verification/debugging endpoint for the job queue: returns
  // this listing's processing job rows, newest first. No per-user
  // ownership check needed, same shared-cache reasoning as listings
  // themselves — just auth-required.
  app.get<{ Params: { id: string } }>("/listings/:id/jobs", async (request, reply) => {
    const { id } = request.params;
    const result = await query(
      "SELECT id, listing_id, status, result, error, created_at, updated_at FROM listing_processing_jobs WHERE listing_id = $1 ORDER BY created_at DESC",
      [id]
    );
    return reply.code(200).send({ jobs: result.rows });
  });
}
