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
import { compareVersions } from "../src/updates/manifest.js";
import { asWeb, makeAdmin, signup, type WebUser } from "./helpers/web.js";

// Automatic desktop updates, server side: the server checks signed manifests with the PUBLIC key only, serves them only for published releases, and the pieces around it
// (server info for "Test connection", the multi-address same-origin check).
let app: FastifyInstance;
let admin: WebUser;
let releasesDir: string;
const bytes = Buffer.from("MZ pretend installer for updates ".repeat(4000));
const sha512 = createHash("sha512").update(bytes).digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const signText = (text: string, key = privateKey) => sign(null, Buffer.from(text, "utf-8"), key).toString("base64");
const rnd = () => Math.floor(Math.random() * 80000) + 1;
const bigV = () => 90000 + Math.floor(Math.random() * 9000);
// the test database is shared by every file and persists between runs: start a test from a channel with nothing published
const clearPublished = (channel: string) => pool.query("UPDATE releases SET status = 'withdrawn' WHERE channel = $1 AND status = 'published'", [channel]);

beforeAll(async () => {
  for (const k of await redisConnection.keys("rl:updates:*")) await redisConnection.del(k);
  releasesDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-upd-"));
  config.web.releasesDir = releasesDir;
  config.web.updatePublicKey = publicPem;
  app = buildApp({ billing: null });
  await app.ready();
  admin = await signup(app);
  await makeAdmin(admin.id);
});
afterAll(async () => {
  await app?.close();
  await closePool();
  fs.rmSync(releasesDir, { recursive: true, force: true });
});

async function newRelease(channel: "beta" | "stable" = "beta", version = `${rnd()}.${rnd()}.${rnd()}-beta.1`) {
  const c = await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(admin), payload: { version, channel } });
  const id = c.json().id as string;
  await app.inject({ method: "PUT", url: `/admin/releases/${id}/file?name=Clynx-Setup.exe`, headers: { ...asWeb(admin), "content-type": "application/octet-stream" }, payload: bytes });
  return { id, version };
}
async function template(id: string) {
  const t = await app.inject({ method: "GET", url: `/admin/releases/${id}/update-manifest-template`, headers: asWeb(admin) });
  expect(t.statusCode).toBe(200);
  return t.json().manifest as Record<string, any>;
}
const attach = (id: string, manifestText: string, signature: string) => app.inject({ method: "PUT", url: `/admin/releases/${id}/update-manifest`, headers: asWeb(admin), payload: { manifest: manifestText, signature } });
async function publish(id: string, version: string) {
  expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(admin) })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: version } })).statusCode).toBe(200);
}
async function signed(id: string, mutate?: (m: Record<string, any>) => void) {
  const m = await template(id);
  mutate?.(m);
  const text = JSON.stringify(m);
  return { text, signature: signText(text) };
}

describe("the manifest template", () => {
  it("states the installer's SHA-512, size and a relative download address, computed by the server", async () => {
    const { id, version } = await newRelease();
    const m = await template(id);
    expect(m.version).toBe(version);
    expect(m.files[0]).toMatchObject({ sha512, size: bytes.length, url: `/releases/${id}/download`, platform: "win32", arch: "x64" });
  });
  it("is available to administrators only", async () => {
    const { id } = await newRelease();
    const u = await signup(app);
    expect((await app.inject({ method: "GET", url: `/admin/releases/${id}/update-manifest-template`, headers: { cookie: u.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/admin/releases/${id}/update-manifest`, headers: asWeb(u), payload: {} })).statusCode).toBe(403);
  });
});

describe("attaching a signed manifest", () => {
  it("accepts a genuine manifest that describes this release", async () => {
    const { id } = await newRelease();
    const s = await signed(id);
    const r = await attach(id, s.text, s.signature);
    expect(r.statusCode).toBe(200);
    expect(r.json().willBeOffered).toBe(false); // not published yet
  });
  it("refuses a manifest signed with a different key", async () => {
    const { id } = await newRelease();
    const m = JSON.stringify(await template(id));
    const r = await attach(id, m, signText(m, otherKey.privateKey));
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/signature/i);
  });
  it("refuses a manifest whose text was changed after signing", async () => {
    const { id } = await newRelease();
    const s = await signed(id);
    const r = await attach(id, s.text.replace('"channel":"beta"', '"channel":"beta" '), s.signature);
    expect(r.statusCode).toBe(422);
  });
  it("refuses a genuine signature over a manifest that does not match the stored installer, naming what is wrong", async () => {
    const { id } = await newRelease();
    const wrongHash = await signed(id, (m) => { m.files[0].sha512 = "0".repeat(128); });
    const r1 = await attach(id, wrongHash.text, wrongHash.signature);
    expect(r1.statusCode).toBe(422);
    expect(r1.json().message).toMatch(/checksum/);
    const wrongVersion = await signed(id, (m) => { m.version = "9.9.9"; });
    expect((await attach(id, wrongVersion.text, wrongVersion.signature)).json().message).toMatch(/version/);
    const wrongChannel = await signed(id, (m) => { m.channel = "stable"; });
    expect((await attach(id, wrongChannel.text, wrongChannel.signature)).json().message).toMatch(/channel/);
    const offHost = await signed(id, (m) => { m.files[0].url = "https://evil.example/Clynx.exe"; });
    expect((await attach(id, offHost.text, offHost.signature)).json().message).toMatch(/download address/);
  });
  it("is refused when the server has no update public key", async () => {
    const { id } = await newRelease();
    const s = await signed(id);
    const keep = config.web.updatePublicKey;
    config.web.updatePublicKey = null;
    try {
      const r = await attach(id, s.text, s.signature);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe("updates_not_configured");
    } finally {
      config.web.updatePublicKey = keep;
    }
  });
});

describe("serving updates", () => {
  it("offers nothing until a release is published AND carries a verified manifest", async () => {
    await clearPublished("beta");
    const { id, version } = await newRelease("beta", `${bigV()}.0.0-beta.1`);
    const before = (await app.inject({ method: "GET", url: "/updates/beta/latest?platform=win32&arch=x64" })).json().update;
    const s = await signed(id);
    await attach(id, s.text, s.signature);
    await publish(id, version);
    const after = (await app.inject({ method: "GET", url: "/updates/beta/latest?platform=win32&arch=x64" })).json().update;
    expect(JSON.parse(after.manifest).version).toBe(version);
    expect(after.signature).toBe(s.signature);
    expect(before === null || JSON.parse(before.manifest).version !== version).toBe(true);
  });
  it("a published release without a manifest is not offered as an update", async () => {
    await clearPublished("beta");
    const a = await newRelease("beta", `${bigV()}.0.0-beta.1`);
    await publish(a.id, a.version);
    const latest = (await app.inject({ method: "GET", url: "/updates/beta/latest" })).json().update;
    expect(latest === null || JSON.parse(latest.manifest).version !== a.version).toBe(true);
  });
  it("serves the highest version, per channel, and a withdrawn release disappears at once", async () => {
    await clearPublished("stable");
    const X = bigV();
    const lo = await newRelease("stable", `${X}.1.0`);
    const hi = await newRelease("stable", `${X}.2.0`);
    for (const r of [lo, hi]) {
      const s = await signed(r.id);
      await attach(r.id, s.text, s.signature);
      await publish(r.id, r.version);
    }
    const latest = async () => JSON.parse((await app.inject({ method: "GET", url: "/updates/stable/latest" })).json().update.manifest).version;
    expect(await latest()).toBe(hi.version);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${hi.id}/withdraw`, headers: asWeb(admin) })).statusCode).toBe(200);
    expect(await latest()).toBe(lo.version);
    const specific = await app.inject({ method: "GET", url: `/updates/stable/versions/${lo.version}` });
    expect(specific.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/updates/stable/versions/${hi.version}` })).statusCode).toBe(404);
  });
  it("never serves a different platform's build or an unknown channel", async () => {
    expect((await app.inject({ method: "GET", url: "/updates/beta/latest?platform=darwin&arch=arm64" })).json().update).toBeNull();
    expect((await app.inject({ method: "GET", url: "/updates/nightly/latest" })).statusCode).toBe(400);
  });
  it("is public (no login) and never cached", async () => {
    const r = await app.inject({ method: "GET", url: "/updates/beta/latest" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

describe("version ordering", () => {
  it("orders pre-releases below releases and numbers numerically", () => {
    expect(compareVersions("0.3.0-beta.2", "0.3.0-beta.1")).toBe(1);
    expect(compareVersions("0.3.0-beta.10", "0.3.0-beta.9")).toBe(1);
    expect(compareVersions("0.3.0", "0.3.0-beta.9")).toBe(1);
    expect(compareVersions("0.3.1-beta.1", "0.3.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("server info (the desktop's Test connection)", () => {
  it("answers without a login and reveals no secrets", async () => {
    const r = await app.inject({ method: "GET", url: "/server/info" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ product: "clynx-cloud", apiVersion: 1 });
    expect(typeof b.serverVersion).toBe("string");
    expect(b.services).toHaveProperty("sharedAi");
    expect(JSON.stringify(b)).not.toMatch(/sk-|secret|password|BEGIN/i);
  });
});

describe("opening the website from a LAN address", () => {
  it("accepts the configured extra origins for cookie requests and refuses others", async () => {
    const u = await signup(app);
    const keep = config.web.allowedOrigins;
    config.web.allowedOrigins = [...keep, "http://10.0.0.81:8788"];
    try {
      const ok = await app.inject({ method: "POST", url: "/web/logout", headers: { ...asWeb(u), origin: "http://10.0.0.81:8788" } });
      expect(ok.statusCode).toBe(200);
      const u2 = await signup(app);
      const bad = await app.inject({ method: "POST", url: "/web/logout", headers: { ...asWeb(u2), origin: "http://10.0.0.99:8788" } });
      expect(bad.statusCode).toBe(403);
    } finally {
      config.web.allowedOrigins = keep;
    }
  });
});
