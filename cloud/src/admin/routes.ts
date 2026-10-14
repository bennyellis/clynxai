import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, requireOwner } from "../auth/middleware.js";
import { config } from "../config.js";
import { pool, query } from "../db/client.js";
import { listingProcessingQueue } from "../queue/listingProcessingQueue.js";
import { redisFast, withTimeout } from "../queue/redisGuard.js";
import { hashStored, removeStored, saveStream, TooLargeError } from "../releases/storage.js";
import { attachSignedManifest, manifestTemplate } from "../releases/manifestOps.js";
import { counters } from "../security/hooks.js";
import { revokeAllWebSessions } from "../web/session.js";

// The administrators' API (used by the website's /console pages). Every route needs a website session of a user whose role is "admin" in the database, checked on each request; a
// desktop bearer token never works here. Nothing returned contains a password hash, a token, a cookie, or any Facebook data (Clynx Cloud never receives those). Every change is
// written to admin_audit.

const uuid = z.object({ id: z.string().uuid() });

async function audit(request: FastifyRequest, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  const a = await query<{ email: string }>("SELECT email FROM users WHERE id = $1", [request.userId]);
  await query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES ($1, $2, $3, $4, $5)", [request.userId, a.rows[0]?.email ?? "?", action, target, JSON.stringify(detail)]);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  // ------------------------------------------------------------------ overview and health
  app.get("/admin/overview", async (_request, reply) => {
    const one = async <T>(sql: string) => (await query<{ v: T }>(sql)).rows[0].v;
    const [users, verified, signups7, beta, activeSubs, trialing, pastDue, canceling, devices, openSupport, downloads30, daily, byStatus, versions] = await Promise.all([
      one<number>("SELECT count(*)::int AS v FROM users"),
      one<number>("SELECT count(*)::int AS v FROM users WHERE email_verified_at IS NOT NULL"),
      one<number>("SELECT count(*)::int AS v FROM users WHERE created_at > now() - interval '7 days'"),
      one<number>("SELECT count(*)::int AS v FROM users WHERE is_beta_tester"),
      one<number>("SELECT count(*)::int AS v FROM subscriptions WHERE status = 'active'"),
      one<number>("SELECT count(*)::int AS v FROM subscriptions WHERE status = 'trialing'"),
      one<number>("SELECT count(*)::int AS v FROM subscriptions WHERE status = 'past_due'"),
      one<number>("SELECT count(*)::int AS v FROM subscriptions WHERE cancel_at_period_end AND status IN ('active','trialing')"),
      one<number>("SELECT count(*)::int AS v FROM devices"),
      one<number>("SELECT count(*)::int AS v FROM support_requests WHERE status <> 'resolved'"),
      one<number>("SELECT coalesce(sum(count), 0)::int AS v FROM download_counts WHERE day > CURRENT_DATE - 30"),
      query("SELECT to_char(d::date, 'YYYY-MM-DD') AS day, (SELECT count(*)::int FROM users u WHERE u.created_at::date = d::date) AS signups FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') d ORDER BY d"),
      query("SELECT status, count(*)::int AS n FROM subscriptions GROUP BY status ORDER BY n DESC"),
      query("SELECT client_version AS version, count(*)::int AS devices, max(last_seen_at) AS \"lastSeenAt\" FROM devices WHERE last_seen_at > now() - interval '14 days' GROUP BY client_version ORDER BY max(last_seen_at) DESC"),
    ]);
    return reply.code(200).send({ users, verifiedUsers: verified, signupsLast7Days: signups7, betaTesters: beta, subscriptions: { active: activeSubs, trialing, pastDue, cancelingAtPeriodEnd: canceling, byStatus: byStatus.rows }, devices, openSupportRequests: openSupport, downloadsLast30Days: downloads30, signupsByDay: daily.rows, deviceVersions: versions.rows });
  });

  app.get("/admin/health", async (_request, reply) => {
    const checks: Record<string, unknown> = {};
    try {
      await pool.query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "down";
    }
    try {
      checks.redis = (await redisFast.ping()) === "PONG" ? "ok" : "down";
    } catch {
      checks.redis = "down";
    }
    try {
      checks.queue = await withTimeout(listingProcessingQueue.getJobCounts("waiting", "active", "delayed", "failed"), 2000, "queue counts");
    } catch {
      checks.queue = "unavailable";
    }
    const n = async (sql: string) => (await query<{ n: number }>(sql)).rows[0].n;
    return reply.code(200).send({
      checks,
      uptimeSec: Math.round((Date.now() - counters.startedAt) / 1000),
      requests: counters.requests,
      errors5xx: counters.errors5xx,
      email: { mode: config.web.smtpUrl ? "smtp" : "captured-only (nothing is sent)", queued: await n("SELECT count(*)::int AS n FROM email_outbox WHERE status = 'queued'"), failed: await n("SELECT count(*)::int AS n FROM email_outbox WHERE status = 'failed'") },
      billing: { configured: config.billing.configured || config.billingFake, provider: config.billingFake ? "simulated (development)" : config.billing.configured ? "stripe" : "none", failedWebhookEventsLast24h: await n("SELECT count(*)::int AS n FROM billing_events WHERE outcome = 'error' AND received_at > now() - interval '24 hours'"), eventsLast24h: await n("SELECT count(*)::int AS n FROM billing_events WHERE received_at > now() - interval '24 hours'") },
      entitlementsEnforced: config.enforceEntitlements,
      publicUrl: config.web.publicUrl,
    });
  });

  // ------------------------------------------------------------------ customers
  app.get("/admin/users", async (request, reply) => {
    const q = z.object({ search: z.string().max(100).optional(), beta: z.enum(["1"]).optional(), page: z.coerce.number().int().min(1).max(10000).default(1) }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });
    const like = q.data.search ? `%${q.data.search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const r = await query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.role, u.is_beta_tester AS "isBetaTester", (u.email_verified_at IS NOT NULL) AS "emailVerified", (u.disabled_at IS NOT NULL) AS disabled,
              u.created_at AS "createdAt", s.status AS "subscriptionStatus", s.billing_interval AS "interval", (SELECT count(*)::int FROM devices d WHERE d.user_id = u.id) AS devices
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.display_name ILIKE $1) AND ($2::boolean IS NOT TRUE OR u.is_beta_tester)
       ORDER BY u.created_at DESC LIMIT 50 OFFSET $3`,
      [like, q.data.beta === "1", (q.data.page - 1) * 50]
    );
    return reply.code(200).send({ users: r.rows, page: q.data.page });
  });

  app.get("/admin/users/:id", async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const u = await query(
      `SELECT id, email, display_name AS "displayName", role, is_beta_tester AS "isBetaTester", (email_verified_at IS NOT NULL) AS "emailVerified", (disabled_at IS NOT NULL) AS disabled, created_at AS "createdAt" FROM users WHERE id = $1`,
      [p.data.id]
    );
    if (!u.rows[0]) return reply.code(404).send({ error: "Not found" });
    const [sub, devices, support, usage] = await Promise.all([
      query(`SELECT status, billing_interval AS "interval", current_period_end AS "currentPeriodEnd", trial_end AS "trialEnd", cancel_at_period_end AS "cancelAtPeriodEnd", past_due_since AS "pastDueSince" FROM subscriptions WHERE user_id = $1`, [p.data.id]),
      query(`SELECT id, platform, client_version AS "clientVersion", last_seen_at AS "lastSeenAt", created_at AS "createdAt" FROM devices WHERE user_id = $1 ORDER BY created_at DESC`, [p.data.id]),
      query(`SELECT id, category, subject, status, created_at AS "createdAt" FROM support_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [p.data.id]),
      query(`SELECT count(*)::int AS "aiRequestsLast7Days" FROM ai_usage WHERE user_id = $1 AND created_at > now() - interval '7 days'`, [p.data.id]),
    ]);
    return reply.code(200).send({ user: u.rows[0], subscription: sub.rows[0] ?? null, devices: devices.rows, supportRequests: support.rows, usage: usage.rows[0] });
  });

  app.post("/admin/users/:id/beta", async (request, reply) => {
    const p = uuid.safeParse(request.params);
    const b = z.object({ value: z.boolean() }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const r = await query("UPDATE users SET is_beta_tester = $1 WHERE id = $2", [b.data.value, p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: "Not found" });
    await audit(request, "user.beta", p.data.id, { value: b.data.value });
    return reply.code(200).send({ ok: true });
  });

  // Disabling signs the customer out everywhere (desktop and browser) and blocks sign-in. An administrator cannot disable themselves or another administrator.
  app.post("/admin/users/:id/disabled", async (request, reply) => {
    const p = uuid.safeParse(request.params);
    const b = z.object({ value: z.boolean() }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const target = await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [p.data.id]);
    if (!target.rows[0]) return reply.code(404).send({ error: "Not found" });
    // the Owner can never be disabled from here; an administrator can be disabled only by the Owner; nobody disables themselves
    if (p.data.id === request.userId || target.rows[0].role === "owner" || (target.rows[0].role === "admin" && request.role !== "owner")) return reply.code(409).send({ error: "cannot_disable_admin" });
    await query("UPDATE users SET disabled_at = $1 WHERE id = $2", [b.data.value ? new Date() : null, p.data.id]);
    if (b.data.value) {
      await query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [p.data.id]);
      await revokeAllWebSessions(p.data.id);
    }
    await audit(request, b.data.value ? "user.disable" : "user.enable", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  // ------------------------------------------------------------------ releases
  const releaseSelect = `SELECT r.id, r.version, r.channel, r.status, r.platform, r.notes, r.known_issues AS "knownIssues", r.file_name AS "fileName", r.sha256, r.size_bytes::float8 AS "sizeBytes", (r.update_manifest IS NOT NULL) AS "hasUpdateManifest",
      r.created_at AS "createdAt", r.approved_at AS "approvedAt", r.published_at AS "publishedAt", r.required_at AS "requiredAt", r.required_deadline AS "requiredDeadline", cu.email AS "createdBy", au.email AS "approvedBy",
      (SELECT coalesce(sum(count), 0)::int FROM download_counts d WHERE d.release_id = r.id) AS downloads
    FROM releases r LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users au ON au.id = r.approved_by`;

  app.get("/admin/releases", async (_request, reply) => {
    const r = await query(`${releaseSelect} ORDER BY r.created_at DESC LIMIT 100`);
    return reply.code(200).send({ releases: r.rows });
  });

  const newRelease = z.object({
    version: z.string().trim().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}(-[0-9A-Za-z.]{1,20})?$/, "Use a version like 0.3.0-beta.1"),
    channel: z.enum(["beta", "stable"]),
    notes: z.string().max(10_000).default(""),
    knownIssues: z.string().max(10_000).default(""),
  });
  app.post("/admin/releases", { preHandler: requireOwner }, async (request, reply) => {
    const b = newRelease.safeParse(request.body);
    if (!b.success) return reply.code(400).send({ error: "Invalid request body", details: b.error.flatten() });
    try {
      const r = await query<{ id: string }>(
        "INSERT INTO releases (version, channel, notes, known_issues, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [b.data.version, b.data.channel, b.data.notes, b.data.knownIssues, request.userId]
      );
      await audit(request, "release.create", r.rows[0].id, { version: b.data.version, channel: b.data.channel });
      return reply.code(201).send({ id: r.rows[0].id });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "That version already exists on that channel" });
      throw err;
    }
  });

  app.patch("/admin/releases/:id", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    const b = z.object({ notes: z.string().max(10_000).optional(), knownIssues: z.string().max(10_000).optional() }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const r = await query("UPDATE releases SET notes = coalesce($1, notes), known_issues = coalesce($2, known_issues) WHERE id = $3 AND status IN ('draft','approved')", [b.data.notes ?? null, b.data.knownIssues ?? null, p.data.id]);
    if (!r.rowCount) return reply.code(409).send({ error: "Only a draft or approved release can be edited" });
    await audit(request, "release.edit", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  // The installer is uploaded as the raw request body. The server stores it and computes the SHA-256 itself; a checksum sent by the client would not be trusted.
  app.register(async (upload) => {
    upload.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
    upload.put("/admin/releases/:id/file", { bodyLimit: config.web.maxReleaseBytes, preHandler: requireOwner }, async (request, reply) => {
      const p = uuid.safeParse(request.params);
      const q = z.object({ name: z.string().min(1).max(200) }).safeParse(request.query);
      if (!p.success || !q.success) return reply.code(400).send({ error: "Invalid request" });
      const rel = await query<{ status: string; storage_key: string | null }>("SELECT status, storage_key FROM releases WHERE id = $1", [p.data.id]);
      if (!rel.rows[0]) return reply.code(404).send({ error: "Not found" });
      if (rel.rows[0].status !== "draft") return reply.code(409).send({ error: "Files can only be attached to a draft release" });
      try {
        const saved = await saveStream(p.data.id, q.data.name, request.body as NodeJS.ReadableStream & import("node:stream").Readable, config.web.maxReleaseBytes);
        if (rel.rows[0].storage_key && rel.rows[0].storage_key !== saved.key) removeStored(rel.rows[0].storage_key);
        await query("UPDATE releases SET storage_key = $1, file_name = $2, sha256 = $3, size_bytes = $4 WHERE id = $5", [saved.key, saved.key.split("/")[1], saved.sha256, saved.size, p.data.id]);
        await audit(request, "release.upload", p.data.id, { sha256: saved.sha256, size: saved.size });
        return reply.code(200).send({ ok: true, sha256: saved.sha256, sizeBytes: saved.size });
      } catch (err) {
        if (err instanceof TooLargeError) {
          reply.header("Connection", "close"); // the rest of the upload is not read
          return reply.code(413).send({ error: "File too large" });
        }
        throw err;
      }
    });
  });

  // Re-hashes the stored file and compares it with the recorded checksum (catches a damaged or swapped file before and after publishing).
  app.get("/admin/releases/:id/verify", async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await query<{ storage_key: string | null; sha256: string | null }>("SELECT storage_key, sha256 FROM releases WHERE id = $1", [p.data.id]);
    if (!r.rows[0]) return reply.code(404).send({ error: "Not found" });
    if (!r.rows[0].storage_key) return reply.code(200).send({ ok: false, reason: "no file" });
    const actual = await hashStored(r.rows[0].storage_key);
    return reply.code(200).send({ ok: actual !== null && actual === r.rows[0].sha256, recorded: r.rows[0].sha256, actual });
  });


  // ------------------------------------------------------------------ automatic desktop updates
  // The signed manifest is made OFFLINE by the holder of the update signing key; the server only checks it against the PUBLIC key and serves it.
  // 1. GET .../update-manifest-template returns the unsigned manifest for this release (the SHA-512 is computed by the server from the stored file).
  // 2. The publisher signs that exact text offline (node scripts/update-keys.cjs sign ...).
  // 3. PUT .../update-manifest uploads { manifest, signature }. The server verifies the signature and that it describes THIS release's stored file before keeping it.
  app.get("/admin/releases/:id/update-manifest-template", async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await manifestTemplate(p.data.id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    return reply.code(200).send({ manifest: r.manifest, configured: r.configured });
  });

  app.put("/admin/releases/:id/update-manifest", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await attachSignedManifest(p.data.id, request.body, request.userId as string);
    if (!r.ok) return reply.code(r.status).send({ error: r.error, message: r.message });
    await audit(request, "release.update_manifest", p.data.id, { version: r.version, channel: r.channel });
    return reply.code(200).send({ ok: true, willBeOffered: r.willBeOffered });
  });

  app.delete("/admin/releases/:id/update-manifest", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await query("UPDATE releases SET update_manifest = NULL, update_manifest_at = NULL WHERE id = $1 AND update_manifest IS NOT NULL", [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: "That release has no update manifest" });
    await audit(request, "release.update_manifest_remove", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  app.post("/admin/releases/:id/approve", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const rel = await query<{ storage_key: string | null; sha256: string | null; status: string }>("SELECT storage_key, sha256, status FROM releases WHERE id = $1", [p.data.id]);
    if (!rel.rows[0]) return reply.code(404).send({ error: "Not found" });
    if (rel.rows[0].status !== "draft") return reply.code(409).send({ error: "Only a draft can be approved" });
    if (!rel.rows[0].storage_key || !rel.rows[0].sha256) return reply.code(409).send({ error: "Upload the installer first" });
    if ((await hashStored(rel.rows[0].storage_key)) !== rel.rows[0].sha256) return reply.code(409).send({ error: "checksum_mismatch", message: "The stored file no longer matches its checksum." });
    await query("UPDATE releases SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2", [request.userId, p.data.id]);
    await audit(request, "release.approve", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  // Publishing is a separate, deliberate step: the administrator must type the version number. Nothing is ever published automatically.
  app.post("/admin/releases/:id/publish", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    const b = z.object({ confirmVersion: z.string() }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const rel = await query<{ version: string; status: string; storage_key: string | null; sha256: string | null }>("SELECT version, status, storage_key, sha256 FROM releases WHERE id = $1", [p.data.id]);
    if (!rel.rows[0]) return reply.code(404).send({ error: "Not found" });
    if (rel.rows[0].status !== "approved") return reply.code(409).send({ error: "Only an approved release can be published" });
    if (b.data.confirmVersion !== rel.rows[0].version) return reply.code(409).send({ error: "confirmation_mismatch", message: "Type the exact version number to publish." });
    if (!rel.rows[0].storage_key || (await hashStored(rel.rows[0].storage_key)) !== rel.rows[0].sha256) return reply.code(409).send({ error: "checksum_mismatch" });
    await query("UPDATE releases SET status = 'published', published_at = now() WHERE id = $1", [p.data.id]);
    await audit(request, "release.publish", p.data.id, { version: rel.rows[0].version });
    return reply.code(200).send({ ok: true });
  });

  app.post("/admin/releases/:id/withdraw", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await query("UPDATE releases SET status = 'withdrawn', required_at = NULL, required_deadline = NULL WHERE id = $1 AND status IN ('approved','published')", [p.data.id]);
    if (!r.rowCount) return reply.code(409).send({ error: "Only an approved or published release can be withdrawn" });
    await audit(request, "release.withdraw", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  // REQUIRED updates (Owner only). A published release can be marked required, with a deadline: desktop apps that are online install it by then, whatever their update setting. They still
  // wait for an idle moment until the deadline and no longer wait after it. The release must already be published and carry a verified signed manifest, so a required update is always one
  // the apps can verify. Everything older than the highest required version is affected (an app already at or past it is not).
  app.post("/admin/releases/:id/require", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    const b = z.object({ hours: z.number().int().min(1).max(24 * 60).default(72) }).safeParse(request.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const r = await query(
      `UPDATE releases SET required_at = now(), required_deadline = now() + make_interval(hours => $2)
       WHERE id = $1 AND status = 'published' AND update_manifest IS NOT NULL RETURNING version, required_deadline AS "requiredDeadline"`,
      [p.data.id, b.data.hours]
    );
    if (!r.rowCount) return reply.code(409).send({ error: "not_requirable", message: "Only a published release that has a verified signed update manifest can be required." });
    await audit(request, "release.require", p.data.id, { hours: b.data.hours, version: r.rows[0].version });
    return reply.code(200).send({ ok: true, requiredDeadline: r.rows[0].requiredDeadline });
  });

  app.delete("/admin/releases/:id/require", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const r = await query("UPDATE releases SET required_at = NULL, required_deadline = NULL WHERE id = $1 AND required_deadline IS NOT NULL", [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: "That release is not marked as required" });
    await audit(request, "release.unrequire", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  // Promotion: a published beta build becomes a DRAFT on the stable channel (same file and checksum). It still has to be approved and published like any other release.
  app.post("/admin/releases/:id/promote", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const rel = await query<{ version: string; channel: string; status: string; notes: string; known_issues: string; file_name: string | null; storage_key: string | null; sha256: string | null; size_bytes: string | null }>(
      "SELECT version, channel, status, notes, known_issues, file_name, storage_key, sha256, size_bytes FROM releases WHERE id = $1",
      [p.data.id]
    );
    const r = rel.rows[0];
    if (!r) return reply.code(404).send({ error: "Not found" });
    if (r.channel !== "beta" || r.status !== "published") return reply.code(409).send({ error: "Only a published beta release can be promoted" });
    try {
      const created = await query<{ id: string }>(
        `INSERT INTO releases (version, channel, notes, known_issues, file_name, storage_key, sha256, size_bytes, created_by) VALUES ($1, 'stable', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [r.version, r.notes, r.known_issues, r.file_name, r.storage_key, r.sha256, r.size_bytes, request.userId]
      );
      await audit(request, "release.promote", p.data.id, { to: created.rows[0].id });
      return reply.code(201).send({ id: created.rows[0].id, status: "draft" });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "That version already exists on the stable channel" });
      throw err;
    }
  });

  app.delete("/admin/releases/:id", { preHandler: requireOwner }, async (request, reply) => {
    const p = uuid.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid id" });
    const rel = await query<{ storage_key: string | null }>("DELETE FROM releases WHERE id = $1 AND status = 'draft' RETURNING storage_key", [p.data.id]);
    if (!rel.rows[0]) return reply.code(409).send({ error: "Only a draft can be deleted" });
    // the stored file is removed only when no other release (a promoted copy) still points at it
    const key = rel.rows[0].storage_key;
    if (key && !(await query("SELECT 1 FROM releases WHERE storage_key = $1", [key])).rows.length) removeStored(key);
    await audit(request, "release.delete", p.data.id);
    return reply.code(200).send({ ok: true });
  });

  // ------------------------------------------------------------------ support
  app.get("/admin/support", async (request, reply) => {
    const q = z.object({ status: z.enum(["open", "in_progress", "resolved"]).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });
    const r = await query(
      `SELECT id, user_id AS "userId", email, category, subject, message, diagnostics, status, admin_note AS "adminNote", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM support_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 100`,
      [q.data.status ?? null]
    );
    return reply.code(200).send({ requests: r.rows });
  });
  app.patch("/admin/support/:id", async (request, reply) => {
    const p = uuid.safeParse(request.params);
    const b = z.object({ status: z.enum(["open", "in_progress", "resolved"]).optional(), adminNote: z.string().max(5000).optional() }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const r = await query("UPDATE support_requests SET status = coalesce($1, status), admin_note = coalesce($2, admin_note), updated_at = now() WHERE id = $3", [b.data.status ?? null, b.data.adminNote ?? null, p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: "Not found" });
    await audit(request, "support.update", p.data.id, { status: b.data.status });
    return reply.code(200).send({ ok: true });
  });

  app.get("/admin/audit", async (_request, reply) => {
    const r = await query(`SELECT id, admin_email AS "adminEmail", action, target, detail, created_at AS "createdAt" FROM admin_audit ORDER BY id DESC LIMIT 100`);
    return reply.code(200).send({ entries: r.rows });
  });
}
