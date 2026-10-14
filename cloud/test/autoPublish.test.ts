import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { redisConnection } from "../src/queue/connection.js";
import { publishBetaFromTool } from "../src/releases/manifestOps.js";
import { asWeb, makeOwner, signup, type WebUser } from "./helpers/web.js";

// The Owner's standing permission to publish BETAS automatically: the server-side `publish` command, and everything it refuses.
let app: FastifyInstance;
let owner: WebUser;
let dir: string;
const bytes = Buffer.from("MZ pretend installer for auto publish ".repeat(2000));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signText = (t: string, key = privateKey) => sign(null, Buffer.from(t, "utf-8"), key).toString("base64");
const base = 70000 + Math.floor(Math.random() * 9000);
let n = 1;
const nextVersion = (channel: "beta" | "stable" = "beta") => `${base}.${n++}.0${channel === "beta" ? "-beta.1" : ""}`;

beforeAll(async () => {
  for (const k of await redisConnection.keys("rl:updates:*")) await redisConnection.del(k);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-ap-"));
  config.web.releasesDir = dir;
  config.web.updatePublicKey = publicKey.export({ type: "spki", format: "pem" }) as string;
  app = buildApp({ billing: null });
  await app.ready();
  const o = await signup(app);
  await makeOwner(o.id);
  owner = o;
  // earlier test releases on this shared test database must not be offered or block a version
  await pool.query("UPDATE releases SET status = 'withdrawn', required_at = NULL, required_deadline = NULL WHERE channel = 'beta' AND status IN ('published','approved')");
});
afterAll(async () => {
  await pool.query("UPDATE releases SET status = 'withdrawn', required_at = NULL, required_deadline = NULL WHERE channel = 'beta' AND status = 'published'");
  await app?.close();
  await closePool();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function draft(version: string, channel: "beta" | "stable" = "beta", opts: { manifest?: boolean } = {}) {
  const c = await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(owner), payload: { version, channel } });
  const id = c.json().id as string;
  await app.inject({ method: "PUT", url: `/admin/releases/${id}/file?name=Clynx-Setup.exe`, headers: { ...asWeb(owner), "content-type": "application/octet-stream" }, payload: bytes });
  if (opts.manifest !== false) {
    const t = await app.inject({ method: "GET", url: `/admin/releases/${id}/update-manifest-template`, headers: asWeb(owner) });
    const text = JSON.stringify(t.json().manifest);
    await app.inject({ method: "PUT", url: `/admin/releases/${id}/update-manifest`, headers: asWeb(owner), payload: { manifest: text, signature: signText(text) } });
  }
  return id;
}
const latest = async () => (await app.inject({ method: "GET", url: "/updates/beta/latest?platform=win32&arch=x64" })).json();

describe("publishing a beta from the server-side tool (the Owner's standing permission)", () => {
  it("publishes a prepared, signed, verified draft: it is offered to apps and downloadable, and the action is audited", async () => {
    const version = nextVersion();
    const id = await draft(version);
    expect(JSON.stringify(await latest())).not.toContain(version);
    const r = await publishBetaFromTool(version, "beta");
    expect(r).toMatchObject({ ok: true, version });
    const l = await latest();
    expect(JSON.parse(l.update.manifest).version).toBe(version);
    expect(l.required).toBeNull(); // never marks a release required
    const dl = await app.inject({ method: "GET", url: `/releases/${id}/download` });
    expect(dl.statusCode).toBe(200);
    expect(createHash("sha256").update(dl.rawPayload).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    const row = (await pool.query("SELECT status, approved_at, published_at, required_deadline FROM releases WHERE id = $1", [id])).rows[0];
    expect(row.status).toBe("published");
    expect(row.approved_at && row.published_at).toBeTruthy();
    expect(row.required_deadline).toBeNull();
    expect((await pool.query("SELECT action FROM admin_audit WHERE target = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0]).toMatchObject({ action: "release.cli_publish" });
  });

  it("refuses the stable channel", async () => {
    const version = nextVersion("stable");
    const id = await draft(version, "stable");
    expect(await publishBetaFromTool(version, "stable")).toMatchObject({ ok: false, error: "beta_only" });
    expect((await pool.query("SELECT status FROM releases WHERE id = $1", [id])).rows[0].status).toBe("draft");
  });

  it("refuses a draft with no signed update manifest", async () => {
    const version = nextVersion();
    const id = await draft(version, "beta", { manifest: false });
    expect(await publishBetaFromTool(version, "beta")).toMatchObject({ ok: false, error: "no_manifest" });
    expect((await pool.query("SELECT status FROM releases WHERE id = $1", [id])).rows[0].status).toBe("draft");
  });

  it("refuses a manifest that does not verify against the update public key", async () => {
    const version = nextVersion();
    const id = await draft(version);
    const bad = JSON.stringify({ manifest: JSON.stringify({ tampered: true }), signature: signText("something else") });
    await pool.query("UPDATE releases SET update_manifest = $1 WHERE id = $2", [bad, id]);
    expect(await publishBetaFromTool(version, "beta")).toMatchObject({ ok: false, error: "manifest_rejected" });
    expect((await pool.query("SELECT status FROM releases WHERE id = $1", [id])).rows[0].status).toBe("draft");
  });

  it("refuses when the stored installer no longer matches its recorded checksum", async () => {
    const version = nextVersion();
    const id = await draft(version);
    const key = (await pool.query("SELECT storage_key FROM releases WHERE id = $1", [id])).rows[0].storage_key as string;
    fs.appendFileSync(path.join(dir, key), "tampered");
    expect(await publishBetaFromTool(version, "beta")).toMatchObject({ ok: false, error: "checksum_mismatch" });
    expect((await pool.query("SELECT status FROM releases WHERE id = $1", [id])).rows[0].status).toBe("draft");
  });

  it("refuses a version that is not newer than one already published (no downgrade), refuses a release that is not a draft, and a missing one", async () => {
    const newer = nextVersion();
    await draft(newer);
    expect(await publishBetaFromTool(newer, "beta")).toMatchObject({ ok: true });
    const older = `${base}.0.0-beta.0`; // lower than everything this file published
    const idOld = await draft(older);
    expect(await publishBetaFromTool(older, "beta")).toMatchObject({ ok: false, error: "not_newer" });
    expect((await pool.query("SELECT status FROM releases WHERE id = $1", [idOld])).rows[0].status).toBe("draft");
    expect(await publishBetaFromTool(newer, "beta")).toMatchObject({ ok: false, error: "not_a_draft" });
    expect(await publishBetaFromTool(`${base}.99.0-beta.9`, "beta")).toMatchObject({ ok: false, error: "not_found" });
  });
});
