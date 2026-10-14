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
import { asWeb, makeAdmin, makeOwner, signup, type WebUser } from "./helpers/web.js";

// Phase 11.7: only the Owner may approve, publish, withdraw, require or otherwise change releases; REQUIRED updates reach the apps with a deadline; an interrupted download can resume.
let app: FastifyInstance;
let owner: WebUser;
let admin: WebUser;
let releasesDir: string;
const bytes = Buffer.from("MZ pretend installer for enforcement ".repeat(3000));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const signText = (text: string) => sign(null, Buffer.from(text, "utf-8"), privateKey).toString("base64");
const bigV = () => `${90000 + Math.floor(Math.random() * 9000)}.${Math.floor(Math.random() * 9000)}.1-beta.1`;
const clearPublished = () => pool.query("UPDATE releases SET status = 'withdrawn', required_at = NULL, required_deadline = NULL WHERE channel = 'beta' AND status = 'published'");

beforeAll(async () => {
  for (const k of await redisConnection.keys("rl:updates:*")) await redisConnection.del(k);
  releasesDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-enf-"));
  config.web.releasesDir = releasesDir;
  config.web.updatePublicKey = publicPem;
  app = buildApp({ billing: null });
  await app.ready();
  owner = await signup(app);
  admin = await signup(app);
  await makeAdmin(admin.id);
  await makeOwner(owner.id);
});
afterAll(async () => {
  await clearPublished();
  await app?.close();
  await closePool();
  fs.rmSync(releasesDir, { recursive: true, force: true });
});

async function newRelease(version = bigV()) {
  const c = await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(owner), payload: { version, channel: "beta" } });
  const id = c.json().id as string;
  await app.inject({ method: "PUT", url: `/admin/releases/${id}/file?name=Clynx-Setup.exe`, headers: { ...asWeb(owner), "content-type": "application/octet-stream" }, payload: bytes });
  const t = await app.inject({ method: "GET", url: `/admin/releases/${id}/update-manifest-template`, headers: asWeb(owner) });
  const text = JSON.stringify(t.json().manifest);
  await app.inject({ method: "PUT", url: `/admin/releases/${id}/update-manifest`, headers: asWeb(owner), payload: { manifest: text, signature: signText(text) } });
  return { id, version };
}
async function publish(id: string, version: string) {
  expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(owner) })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(owner), payload: { confirmVersion: version } })).statusCode).toBe(200);
}
const latest = async () => (await app.inject({ method: "GET", url: "/updates/beta/latest?platform=win32&arch=x64" })).json();

describe("only the Owner changes releases", () => {
  it("a plain administrator can look at releases but every change is refused (403), including requiring one", async () => {
    await clearPublished();
    const { id, version } = await newRelease();
    await publish(id, version);
    expect((await app.inject({ method: "GET", url: "/admin/releases", headers: asWeb(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/admin/releases/${id}/verify`, headers: asWeb(admin) })).statusCode).toBe(200);
    const attempts: Array<[string, string, unknown]> = [
      ["POST", "/admin/releases", { version: bigV(), channel: "beta" }],
      ["PATCH", `/admin/releases/${id}`, { notes: "x" }],
      ["POST", `/admin/releases/${id}/approve`, {}],
      ["POST", `/admin/releases/${id}/publish`, { confirmVersion: version }],
      ["POST", `/admin/releases/${id}/withdraw`, {}],
      ["POST", `/admin/releases/${id}/promote`, {}],
      ["POST", `/admin/releases/${id}/require`, { hours: 24 }],
      ["DELETE", `/admin/releases/${id}/require`, undefined],
      ["PUT", `/admin/releases/${id}/update-manifest`, { manifest: "{}", signature: "AAAA" }],
      ["DELETE", `/admin/releases/${id}/update-manifest`, undefined],
      ["DELETE", `/admin/releases/${id}`, undefined],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await app.inject({ method: method as never, url, headers: asWeb(admin), payload: payload as never });
      expect([method, url, res.statusCode]).toEqual([method, url, 403]);
    }
    const up = await app.inject({ method: "PUT", url: `/admin/releases/${id}/file?name=x.exe`, headers: { ...asWeb(admin), "content-type": "application/octet-stream" }, payload: bytes });
    expect(up.statusCode).toBe(403);
    // nothing changed
    expect((await pool.query("SELECT status, required_deadline FROM releases WHERE id = $1", [id])).rows[0]).toMatchObject({ status: "published", required_deadline: null });
  });

  it("an ordinary customer is refused as well", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "POST", url: "/admin/releases/00000000-0000-0000-0000-000000000000/require", headers: asWeb(u), payload: {} })).statusCode).toBe(403);
  });
});

describe("required updates", () => {
  it("the Owner can require a published release with a deadline; apps are told the version and deadline", async () => {
    await clearPublished();
    const { id, version } = await newRelease();
    await publish(id, version);
    expect((await latest()).required).toBeNull();
    const before = Date.now();
    const r = await app.inject({ method: "POST", url: `/admin/releases/${id}/require`, headers: asWeb(owner), payload: { hours: 48 } });
    expect(r.statusCode).toBe(200);
    const l = await latest();
    expect(l.required.version).toBe(version);
    const deadline = Date.parse(l.required.deadline);
    expect(deadline - before).toBeGreaterThan(47.9 * 3600_000);
    expect(deadline - before).toBeLessThan(48.1 * 3600_000);
    expect(l.serverTime).toBeTruthy();
    expect((await pool.query("SELECT action FROM admin_audit WHERE target = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0].action).toBe("release.require");
    // the Owner can lift it again
    expect((await app.inject({ method: "DELETE", url: `/admin/releases/${id}/require`, headers: asWeb(owner) })).statusCode).toBe(200);
    expect((await latest()).required).toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/admin/releases/${id}/require`, headers: asWeb(owner) })).statusCode).toBe(404);
  });

  it("only a published release with a verified signed manifest can be required; the deadline is bounded", async () => {
    await clearPublished();
    const draft = await newRelease();
    expect((await app.inject({ method: "POST", url: `/admin/releases/${draft.id}/require`, headers: asWeb(owner), payload: {} })).statusCode).toBe(409);
    await publish(draft.id, draft.version);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${draft.id}/require`, headers: asWeb(owner), payload: { hours: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${draft.id}/require`, headers: asWeb(owner), payload: { hours: 100000 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${draft.id}/require`, headers: asWeb(owner), payload: {} })).statusCode).toBe(200); // default 72 h
    expect((await pool.query("SELECT extract(epoch from (required_deadline - required_at)) / 3600 AS h FROM releases WHERE id = $1", [draft.id])).rows[0].h).toBeCloseTo(72, 1);
  });

  it("withdrawing a required release clears the requirement; the floor is the highest required version", async () => {
    await clearPublished();
    const n = 91000 + Math.floor(Math.random() * 8000);
    const a = await newRelease(`${n}.0.1-beta.1`);
    const b = await newRelease(`${n}.0.2-beta.1`);
    await publish(a.id, a.version);
    await publish(b.id, b.version);
    await app.inject({ method: "POST", url: `/admin/releases/${a.id}/require`, headers: asWeb(owner), payload: { hours: 10 } });
    await app.inject({ method: "POST", url: `/admin/releases/${b.id}/require`, headers: asWeb(owner), payload: { hours: 20 } });
    expect((await latest()).required.version).toBe(b.version);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${b.id}/withdraw`, headers: asWeb(owner) })).statusCode).toBe(200);
    const l = await latest();
    expect(l.update).not.toBeNull();
    expect(JSON.parse(l.update.manifest).version).toBe(a.version);
    expect(l.required.version).toBe(a.version);
    expect((await pool.query("SELECT required_deadline FROM releases WHERE id = $1", [b.id])).rows[0].required_deadline).toBeNull();
  });
});

describe("resumable installer downloads", () => {
  it("a plain request is the whole file; 'Range: bytes=N-' answers 206 with the rest; a start past the end is 416", async () => {
    await clearPublished();
    const { id, version } = await newRelease();
    await publish(id, version);
    const full = await app.inject({ method: "GET", url: `/releases/${id}/download` });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.compare(full.rawPayload, bytes)).toBe(0);
    const part = await app.inject({ method: "GET", url: `/releases/${id}/download`, headers: { range: "bytes=1000-" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 1000-${bytes.length - 1}/${bytes.length}`);
    expect(part.headers["content-length"]).toBe(String(bytes.length - 1000));
    expect(Buffer.compare(part.rawPayload, bytes.subarray(1000))).toBe(0);
    expect((await app.inject({ method: "GET", url: `/releases/${id}/download`, headers: { range: `bytes=${bytes.length}-` } })).statusCode).toBe(416);
    // nonsense ranges are ignored (a normal full answer), never an error
    expect((await app.inject({ method: "GET", url: `/releases/${id}/download`, headers: { range: "bytes=0-5,10-20" } })).statusCode).toBe(200);
    expect(createHash("sha256").update(part.rawPayload).digest("hex")).toBe(createHash("sha256").update(bytes.subarray(1000)).digest("hex"));
  });

  it("only a whole download is counted, not each resumed piece", async () => {
    await clearPublished();
    const { id, version } = await newRelease();
    await publish(id, version);
    const count = async () => Number((await pool.query("SELECT coalesce(sum(count),0)::int AS n FROM download_counts WHERE release_id = $1", [id])).rows[0].n);
    await app.inject({ method: "GET", url: `/releases/${id}/download` });
    await app.inject({ method: "GET", url: `/releases/${id}/download`, headers: { range: "bytes=500-" } });
    await app.inject({ method: "GET", url: `/releases/${id}/download`, headers: { range: "bytes=900-" } });
    expect(await count()).toBe(1);
  });
});

describe("watching an update roll out", () => {
  it("a heartbeat carries the app's version into the device list; the Owner's overview counts computers per version; junk is ignored", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: `hb-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`, password: "correct-horse-battery" } });
    const token = reg.json().accessToken as string;
    const dev = await app.inject({ method: "POST", url: "/devices/register", headers: { authorization: `Bearer ${token}` }, payload: { platform: "windows", clientVersion: "unknown" } });
    const id = dev.json().id as string;
    const hb = (payload?: unknown) => app.inject({ method: "POST", url: `/devices/${id}/heartbeat`, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
    expect((await hb()).statusCode).toBe(200); // an older app sends no body at all
    expect((await pool.query("SELECT client_version FROM devices WHERE id = $1", [id])).rows[0].client_version).toBe("unknown");
    expect((await hb({ clientVersion: "0.3.0-beta.4" })).statusCode).toBe(200);
    expect((await pool.query("SELECT client_version FROM devices WHERE id = $1", [id])).rows[0].client_version).toBe("0.3.0-beta.4");
    expect((await hb({ clientVersion: "<script>alert(1)</script>" })).statusCode).toBe(200);
    expect((await hb({ clientVersion: "x".repeat(500) })).statusCode).toBe(200);
    expect((await pool.query("SELECT client_version FROM devices WHERE id = $1", [id])).rows[0].client_version).toBe("0.3.0-beta.4"); // unchanged by junk
    const ov = await app.inject({ method: "GET", url: "/admin/overview", headers: asWeb(admin) });
    expect(ov.statusCode).toBe(200);
    expect(ov.json().deviceVersions.some((v: { version: string; devices: number }) => v.version === "0.3.0-beta.4" && v.devices >= 1)).toBe(true);
  });
});
