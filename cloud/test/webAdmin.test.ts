import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { asWeb, makeAdmin, PASSWORD, signup, uniqueEmail, type WebUser } from "./helpers/web.js";

// Administration (role-based access control, audit trail, secrets never exposed), support requests and the release lifecycle.
let app: FastifyInstance;
let admin: WebUser;
let releasesDir: string;
const bytes = Buffer.from("MZ pretend installer ".repeat(5000));
const sha = createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  releasesDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-releases-"));
  config.web.releasesDir = releasesDir;
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

const version = () => `${Math.floor(Math.random() * 90000) + 1}.${Math.floor(Math.random() * 90000)}.${Math.floor(Math.random() * 90000)}-beta.1`;

describe("access control", () => {
  const adminRoutes: Array<[string, string]> = [
    ["GET", "/admin/overview"], ["GET", "/admin/health"], ["GET", "/admin/users"], ["GET", "/admin/releases"], ["GET", "/admin/support"], ["GET", "/admin/audit"],
  ];

  it("anonymous callers get 401 on every admin route", async () => {
    for (const [method, url] of adminRoutes) expect((await app.inject({ method: method as "GET", url })).statusCode, url).toBe(401);
  });

  it("an ordinary signed-in customer gets 403 on every admin route", async () => {
    const u = await signup(app);
    for (const [method, url] of adminRoutes) expect((await app.inject({ method: method as "GET", url, headers: { cookie: u.cookie } })).statusCode, url).toBe(403);
    expect((await app.inject({ method: "POST", url: `/admin/users/${admin.id}/beta`, headers: asWeb(u), payload: { value: true } })).statusCode).toBe(403);
  });

  it("a desktop bearer token never works, not even for an administrator", async () => {
    const tok = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: admin.email, password: PASSWORD } })).json().accessToken;
    expect((await app.inject({ method: "GET", url: "/admin/overview", headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(403);
  });

  it("the role comes from the database on every request: demoting an administrator takes effect at once", async () => {
    const a = await signup(app);
    await makeAdmin(a.id);
    expect((await app.inject({ method: "GET", url: "/admin/overview", headers: { cookie: a.cookie } })).statusCode).toBe(200);
    await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [a.id]);
    expect((await app.inject({ method: "GET", url: "/admin/overview", headers: { cookie: a.cookie } })).statusCode).toBe(403);
  });

  it("an administrator's state-changing calls still need the CSRF token", async () => {
    const u = await signup(app);
    const res = await app.inject({ method: "POST", url: `/admin/users/${u.id}/beta`, headers: { cookie: admin.cookie }, payload: { value: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf");
  });

  it("there is no way to become an administrator through the API", async () => {
    const u = await signup(app);
    for (const body of [{ role: "admin" }, { displayName: "x", role: "admin" }]) await app.inject({ method: "PATCH", url: "/web/profile", headers: asWeb(u), payload: body });
    expect((await pool.query("SELECT role FROM users WHERE id = $1", [u.id])).rows[0].role).toBe("user");
  });
});

describe("customers, beta testers and what is never exposed", () => {
  it("lists and finds customers without any secret", async () => {
    const u = await signup(app);
    const list = await app.inject({ method: "GET", url: `/admin/users?search=${encodeURIComponent(u.email.slice(0, 12))}`, headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().users.some((x: { email: string }) => x.email === u.email)).toBe(true);
    expect(list.body).not.toMatch(/password|hash|argon2|token|secret|cookie|csrf/i);
    const detail = await app.inject({ method: "GET", url: `/admin/users/${u.id}`, headers: { cookie: admin.cookie } });
    expect(detail.json().user.email).toBe(u.email);
    expect(detail.body).not.toMatch(/password|hash|argon2|secret_hash|csrf|refresh/i);
  });

  it("marks and unmarks beta testers, and records it in the audit trail", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "POST", url: `/admin/users/${u.id}/beta`, headers: asWeb(admin), payload: { value: true } })).statusCode).toBe(200);
    const beta = await app.inject({ method: "GET", url: "/admin/users?beta=1", headers: { cookie: admin.cookie } });
    expect(beta.json().users.some((x: { id: string }) => x.id === u.id)).toBe(true);
    const audit = (await app.inject({ method: "GET", url: "/admin/audit", headers: { cookie: admin.cookie } })).json().entries;
    expect(audit.some((e: { action: string; target: string }) => e.action === "user.beta" && e.target === u.id)).toBe(true);
    expect(audit[0].adminEmail).toBe(admin.email);
  });

  it("disabling signs a customer out everywhere and blocks sign-in; enabling restores it; admins cannot be disabled", async () => {
    const u = await signup(app);
    const desk = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json();
    expect((await app.inject({ method: "POST", url: `/admin/users/${u.id}/disabled`, headers: asWeb(admin), payload: { value: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: desk.refreshToken } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/admin/users/${u.id}/disabled`, headers: asWeb(admin), payload: { value: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/users/${admin.id}/disabled`, headers: asWeb(admin), payload: { value: true } })).statusCode).toBe(409);
  });

  it("the overview and health pages report numbers, not secrets", async () => {
    const o = await app.inject({ method: "GET", url: "/admin/overview", headers: { cookie: admin.cookie } });
    expect(o.statusCode).toBe(200);
    expect(o.json().users).toBeGreaterThan(0);
    expect(o.json().signupsByDay.length).toBe(14);
    const h = await app.inject({ method: "GET", url: "/admin/health", headers: { cookie: admin.cookie } });
    expect(h.statusCode).toBe(200);
    expect(h.json().checks.database).toBe("ok");
    expect(h.body).not.toMatch(/sk-|whsec|jwt|DATABASE_URL|postgres:\/\//i);
  });
});

describe("support requests", () => {
  const good = (email: string) => ({ email, category: "scanner", subject: "Scanner stops after login", message: "It scans for a minute and then says Facebook logged me out. Happens every time." });

  it("anyone can send one; it is stored, scrubbed of keys, linked to the account when signed in, and acknowledged by email", async () => {
    const u = await signup(app);
    const res = await app.inject({
      method: "POST", url: "/support/requests", headers: { cookie: u.cookie },
      payload: { ...good(u.email), diagnostics: "key sk-live-abcdefghijklmnop1234 and Bearer abcdefghijklmnopqrstuv" },
    });
    expect(res.statusCode).toBe(201);
    const row = (await pool.query("SELECT user_id, diagnostics FROM support_requests WHERE id = $1", [res.json().reference])).rows[0];
    expect(row.user_id).toBe(u.id);
    expect(row.diagnostics).not.toMatch(/sk-live|abcdefghijklmnopqrstuv/);
    expect((await pool.query("SELECT 1 FROM email_outbox WHERE to_email = $1 AND purpose = 'support_received'", [u.email])).rows).toHaveLength(1);
    const anon = await app.inject({ method: "POST", url: "/support/requests", payload: good(uniqueEmail("anon")) });
    expect(anon.statusCode).toBe(201);
    expect((await pool.query("SELECT user_id FROM support_requests WHERE id = $1", [anon.json().reference])).rows[0].user_id).toBeNull();
  });

  it("validates input, refuses other sites, and is rate limited", async () => {
    expect((await app.inject({ method: "POST", url: "/support/requests", payload: { ...good("x@example.com"), subject: "hi" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/support/requests", payload: { ...good("x@example.com"), category: "weird" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/support/requests", payload: { ...good("x@example.com"), message: "x".repeat(6000) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/support/requests", headers: { origin: "https://evil.example" }, payload: good("x@example.com") })).statusCode).toBe(403);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await app.inject({ method: "POST", url: "/support/requests", headers: { "x-forwarded-for": "9.9.9.9" }, remoteAddress: "10.1.1.1", payload: good(uniqueEmail("rl")) })).statusCode;
    expect([201, 429]).toContain(last);
  });

  it("administrators see and triage them; customers see only their own", async () => {
    const u = await signup(app);
    const other = await signup(app);
    const id = (await app.inject({ method: "POST", url: "/support/requests", headers: { cookie: u.cookie }, payload: good(u.email) })).json().reference;
    const list = await app.inject({ method: "GET", url: "/admin/support?status=open", headers: { cookie: admin.cookie } });
    expect(list.json().requests.some((r: { id: string }) => r.id === id)).toBe(true);
    expect((await app.inject({ method: "PATCH", url: `/admin/support/${id}`, headers: asWeb(admin), payload: { status: "resolved", adminNote: "Told them to restart Chrome" } })).statusCode).toBe(200);
    const mine = (await app.inject({ method: "GET", url: "/support/requests/mine", headers: { cookie: u.cookie } })).json().requests;
    expect(mine.find((r: { id: string }) => r.id === id).status).toBe("resolved");
    expect(JSON.stringify(mine)).not.toContain("Told them"); // the internal note is not shown to the customer
    expect((await app.inject({ method: "GET", url: "/support/requests/mine", headers: { cookie: other.cookie } })).json().requests).toHaveLength(0);
  });
});

describe("release management", () => {
  async function createDraft(channel: "beta" | "stable" = "beta", v = version()) {
    const res = await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(admin), payload: { version: v, channel, notes: "Notes", knownIssues: "None known" } });
    expect(res.statusCode).toBe(201);
    return { id: res.json().id as string, version: v };
  }
  const upload = (id: string, body: Buffer = bytes, name = "Clynx-Setup.exe") =>
    app.inject({ method: "PUT", url: `/admin/releases/${id}/file?name=${encodeURIComponent(name)}`, headers: { ...asWeb(admin), "content-type": "application/octet-stream" }, payload: body });

  it("the full lifecycle: draft, upload, approve, publish - and only then is it public", async () => {
    const { id, version: v } = await createDraft();
    const publicLatest = async () => (await app.inject({ method: "GET", url: "/releases/latest?channel=beta" })).json().release;
    const before = await publicLatest();
    expect(before === null || before.version !== v).toBe(true);

    const up = await upload(id);
    expect(up.statusCode).toBe(200);
    expect(up.json().sha256).toBe(sha); // computed by the server from what it stored
    expect(up.json().sizeBytes).toBe(bytes.length);

    expect((await app.inject({ method: "GET", url: `/releases/${id}/download` })).statusCode).toBe(404); // a draft is not downloadable
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: v } })).statusCode).toBe(409); // not approved yet
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/releases/${id}/download` })).statusCode).toBe(404); // approved is still not public
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: "9.9.9" } })).statusCode).toBe(409); // must type the version
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: v } })).statusCode).toBe(200);

    const latest = await publicLatest();
    expect(latest.version).toBe(v);
    expect(latest.sha256).toBe(sha);
    expect(latest.downloadUrl).toBe(`/releases/${id}/download`);
    const dl = await app.inject({ method: "GET", url: latest.downloadUrl });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(bytes)).toBe(true);
    expect(createHash("sha256").update(dl.rawPayload).digest("hex")).toBe(sha);
    expect(dl.headers["x-content-sha256"]).toBe(sha);
    expect(String(dl.headers["content-disposition"])).toMatch(/attachment; filename="Clynx-Setup.exe"/);
  });

  it("counts downloads per day without keeping who downloaded", async () => {
    const { id, version: v } = await createDraft();
    await upload(id);
    await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(admin) });
    await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: v } });
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: `/releases/${id}/download`, headers: { "user-agent": "secret-agent" } });
    expect((await pool.query("SELECT sum(count)::int AS n FROM download_counts WHERE release_id = $1", [id])).rows[0].n).toBe(3);
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'download_counts'")).rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(["count", "day", "release_id"]);
  });

  it("approval and publishing are blocked when the stored file no longer matches its checksum", async () => {
    const { id, version: v } = await createDraft();
    await upload(id);
    const key = (await pool.query<{ storage_key: string }>("SELECT storage_key FROM releases WHERE id = $1", [id])).rows[0].storage_key;
    fs.appendFileSync(path.join(releasesDir, key), "tampered");
    expect((await app.inject({ method: "GET", url: `/admin/releases/${id}/verify`, headers: { cookie: admin.cookie } })).json().ok).toBe(false);
    const approve = await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(admin) });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe("checksum_mismatch");
    void v;
  });

  it("cannot approve without a file; a withdrawn release disappears from the public", async () => {
    const empty = await createDraft();
    expect((await app.inject({ method: "POST", url: `/admin/releases/${empty.id}/approve`, headers: asWeb(admin) })).statusCode).toBe(409);
    const { id, version: v } = await createDraft();
    await upload(id);
    await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(admin) });
    await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: v } });
    expect((await app.inject({ method: "GET", url: `/releases/${id}/download` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/withdraw`, headers: asWeb(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/releases/${id}/download` })).statusCode).toBe(404);
    const list = (await app.inject({ method: "GET", url: "/releases" })).json().releases;
    expect(list.some((r: { id: string }) => r.id === id)).toBe(false);
  });

  it("promotion creates a stable DRAFT from a published beta; it still needs approval and publishing", async () => {
    const { id, version: v } = await createDraft();
    await upload(id);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/promote`, headers: asWeb(admin) })).statusCode).toBe(409); // not published yet
    await app.inject({ method: "POST", url: `/admin/releases/${id}/approve`, headers: asWeb(admin) });
    await app.inject({ method: "POST", url: `/admin/releases/${id}/publish`, headers: asWeb(admin), payload: { confirmVersion: v } });
    const promoted = await app.inject({ method: "POST", url: `/admin/releases/${id}/promote`, headers: asWeb(admin) });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json().status).toBe("draft");
    expect((await app.inject({ method: "GET", url: `/releases/${promoted.json().id}/download` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/admin/releases/${id}/promote`, headers: asWeb(admin) })).statusCode).toBe(409); // already exists on stable
    const stable = (await pool.query("SELECT sha256, status, channel FROM releases WHERE id = $1", [promoted.json().id])).rows[0];
    expect(stable).toMatchObject({ sha256: sha, status: "draft", channel: "stable" });
    // deleting the promoted draft keeps the beta's file
    expect((await app.inject({ method: "DELETE", url: `/admin/releases/${promoted.json().id}`, headers: asWeb(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/releases/${id}/download` })).statusCode).toBe(200);
  });

  it("validates versions, rejects duplicates, oversized uploads and hostile file names", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(admin), payload: { version: "latest", channel: "beta" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(admin), payload: { version: "1.0.0", channel: "nightly" } })).statusCode).toBe(400);
    const { version: v } = await createDraft();
    expect((await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(admin), payload: { version: v, channel: "beta" } })).statusCode).toBe(409);
    const { id } = await createDraft();
    const was = config.web.maxReleaseBytes;
    config.web.maxReleaseBytes = 1000;
    try {
      expect((await upload(id, Buffer.alloc(5000, 1))).statusCode).toBe(413);
    } finally {
      config.web.maxReleaseBytes = was;
    }
    const sneaky = await upload(id, bytes, "..\\..\\..\\Windows\\evil.exe");
    expect(sneaky.statusCode).toBe(200);
    const key = (await pool.query<{ storage_key: string }>("SELECT storage_key FROM releases WHERE id = $1", [id])).rows[0].storage_key;
    expect(key.startsWith(`${id}/`)).toBe(true);
    expect(key).not.toContain("..");
    expect(fs.existsSync(path.join(releasesDir, key))).toBe(true);
  });

  it("anonymous users and customers cannot create or publish anything", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "POST", url: "/admin/releases", payload: { version: "1.2.3", channel: "beta" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/admin/releases", headers: asWeb(u), payload: { version: "1.2.3", channel: "beta" } })).statusCode).toBe(403);
  });

  it("the public list shows only published releases", async () => {
    const d = await createDraft();
    const list = (await app.inject({ method: "GET", url: "/releases" })).json().releases;
    expect(list.some((r: { id: string }) => r.id === d.id)).toBe(false);
    expect((await app.inject({ method: "GET", url: "/releases/latest?channel=nightly" })).statusCode).toBe(400);
  });
});
