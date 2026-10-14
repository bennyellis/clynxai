import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { hit } from "../security/rateLimit.js";
import { compareVersions } from "./manifest.js";

// Public: what a desktop app asks to learn whether a newer signed build exists. The server returns the SIGNED manifest exactly as the publisher signed it; the app verifies the
// signature, version, channel and (after downloading) the installer's SHA-512 itself. Only PUBLISHED releases that have a verified manifest are ever offered; a withdrawn release
// disappears at once.

const channelParam = z.enum(["beta", "stable"]);
const platformQuery = z.object({ platform: z.string().max(20).default("win32"), arch: z.string().max(20).default("x64") });

interface Row {
  version: string;
  platform: string;
  update_manifest: string;
}

async function candidates(channel: string, platform: string, arch: string): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT version, platform, update_manifest FROM releases WHERE channel = $1 AND status = 'published' AND update_manifest IS NOT NULL AND platform = $2`,
    [channel, `${platform}-${arch}`]
  );
  return r.rows;
}

export async function updatesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/updates")) return;
    const rl = await hit(`updates:${request.ip}`, 240, 3600);
    if (!rl.allowed) return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
  });

  app.get("/updates/:channel/latest", async (request, reply) => {
    const p = z.object({ channel: channelParam }).safeParse(request.params);
    const q = platformQuery.safeParse(request.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: "Unknown channel or platform" });
    const rows = (await candidates(p.data.channel, q.data.platform, q.data.arch)).sort((a, b) => compareVersions(b.version, a.version));
    reply.header("Cache-Control", "no-store");
    return reply.code(200).send({ update: rows[0] ? JSON.parse(rows[0].update_manifest) : null, serverTime: new Date().toISOString() });
  });

  // One specific published version (used for a user-approved return to the previous version).
  app.get("/updates/:channel/versions/:version", async (request, reply) => {
    const p = z.object({ channel: channelParam, version: z.string().max(40) }).safeParse(request.params);
    const q = platformQuery.safeParse(request.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: "Bad request" });
    const row = (await candidates(p.data.channel, q.data.platform, q.data.arch)).find((r) => r.version === p.data.version);
    reply.header("Cache-Control", "no-store");
    if (!row) return reply.code(404).send({ error: "Not found" });
    return reply.code(200).send({ update: JSON.parse(row.update_manifest) });
  });

  app.get("/updates/status", async (_request, reply) => {
    return reply.code(200).send({ configured: !!config.web.updatePublicKey });
  });
}
