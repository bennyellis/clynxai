import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/client.js";
import { openRead } from "./storage.js";

// Public release information and downloads. ONLY published releases are visible here; drafts, approved-but-unpublished and withdrawn releases do not exist as far as the public
// can tell. Download counting stores one number per release per day: no address, no browser string, no account.

const channelSchema = z.enum(["beta", "stable"]);

interface ReleaseRow {
  id: string;
  version: string;
  channel: string;
  platform: string;
  notes: string;
  known_issues: string;
  file_name: string | null;
  sha256: string | null;
  size_bytes: string | null;
  published_at: Date | null;
}

export const publicRelease = (r: ReleaseRow) => ({
  id: r.id,
  version: r.version,
  channel: r.channel,
  platform: r.platform,
  notes: r.notes,
  knownIssues: r.known_issues,
  fileName: r.file_name,
  sha256: r.sha256,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  publishedAt: r.published_at,
  downloadUrl: r.file_name ? `/releases/${r.id}/download` : null,
});

const COLUMNS = "id, version, channel, platform, notes, known_issues, file_name, sha256, size_bytes, published_at";

export async function releaseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/releases/latest", async (request, reply) => {
    const q = z.object({ channel: channelSchema.default("beta") }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Unknown channel" });
    const r = await query<ReleaseRow>(`SELECT ${COLUMNS} FROM releases WHERE status = 'published' AND channel = $1 AND file_name IS NOT NULL ORDER BY published_at DESC LIMIT 1`, [q.data.channel]);
    reply.header("Cache-Control", "no-cache"); // always re-check: a release published a moment ago must show at once
    return reply.code(200).send({ release: r.rows[0] ? publicRelease(r.rows[0]) : null });
  });

  app.get("/releases", async (request, reply) => {
    const q = z.object({ channel: channelSchema.optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Unknown channel" });
    const r = await query<ReleaseRow>(
      `SELECT ${COLUMNS} FROM releases WHERE status = 'published' AND file_name IS NOT NULL AND ($1::text IS NULL OR channel = $1) ORDER BY published_at DESC LIMIT 50`,
      [q.data.channel ?? null]
    );
    reply.header("Cache-Control", "no-cache"); // always re-check: a release published a moment ago must show at once
    return reply.code(200).send({ releases: r.rows.map(publicRelease) });
  });

  app.get("/releases/:id/download", async (request, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: "Not found" });
    const r = await query<{ id: string; storage_key: string | null; file_name: string | null; sha256: string | null }>(
      "SELECT id, storage_key, file_name, sha256 FROM releases WHERE id = $1 AND status = 'published'",
      [p.data.id]
    );
    const rel = r.rows[0];
    const file = rel?.storage_key ? openRead(rel.storage_key) : null;
    if (!rel || !file) return reply.code(404).send({ error: "Not found" });
    await query(
      "INSERT INTO download_counts (release_id, day, count) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (release_id, day) DO UPDATE SET count = download_counts.count + 1",
      [rel.id]
    ).catch(() => undefined);
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Length", String(file.size));
    reply.header("Content-Disposition", `attachment; filename="${rel.file_name}"`);
    if (rel.sha256) reply.header("X-Content-SHA256", rel.sha256);
    reply.header("Cache-Control", "no-store");
    return reply.send(file.stream);
  });
}
