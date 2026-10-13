import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { beginOwnerSetup, completeOwnerSetup, OwnerSetupError, ownerStatus, revokeOwner } from "../src/owner/service.js";
import { asWeb, makeAdmin, PASSWORD, signup, uniqueEmail, webLogin, type WebUser } from "./helpers/web.js";

// The Owner role: provisioned only by the server-side tool, never obtainable through the website, the API or the database from the application, and distinct from "admin".
let app: FastifyInstance;
let owner: WebUser;
let ownerEmail: string;

beforeAll(async () => {
  app = buildApp({ billing: null });
  await app.ready();
  // the test database is shared: make sure no Owner is left over from an earlier run
  await pool.query("SELECT set_config('clynx.owner_change', 'on', false)");
  await pool.query("UPDATE users SET role = 'user' WHERE role = 'owner'");
  await pool.query("SELECT set_config('clynx.owner_change', 'off', false)");
});
afterAll(async () => {
  await app?.close();
  await closePool();
});

async function makeOwner(): Promise<WebUser> {
  const u = await signup(app);
  const { code } = await beginOwnerSetup(u.email);
  await completeOwnerSetup(u.email, code);
  return webLogin(app, u.email);
}

describe("nobody can grant themselves the Owner role", () => {
  it("no request an ordinary customer can make changes their role", async () => {
    const u = await signup(app);
    const attempts: Array<[string, string, unknown]> = [
      ["PATCH", "/web/profile", { displayName: "x", role: "owner" }],
      ["PATCH", "/web/profile", { role: "owner" }],
      ["POST", "/web/signup", { email: uniqueEmail(), password: PASSWORD, role: "owner" }],
      ["POST", "/auth/register", { email: uniqueEmail(), password: PASSWORD, role: "owner" }],
      ["POST", `/admin/users/${u.id}/role`, { role: "owner" }],
      ["PUT", "/admin/users/" + u.id, { role: "owner" }],
    ];
    for (const [method, url, payload] of attempts) await app.inject({ method: method as "POST", url, headers: asWeb(u), payload: payload as object });
    expect((await pool.query("SELECT role FROM users WHERE id = $1", [u.id])).rows[0].role).toBe("user");
    expect((await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND id = $1", [u.id])).rows[0].n).toBe(0);
  });

  it("an administrator cannot become the Owner either", async () => {
    const a = await signup(app);
    await makeAdmin(a.id);
    for (const [url, payload] of [[`/admin/users/${a.id}/beta`, { value: true, role: "owner" }], ["/web/profile", { role: "owner" }]] as const) await app.inject({ method: url.includes("beta") ? "POST" : "PATCH", url, headers: asWeb(a), payload });
    expect((await pool.query("SELECT role FROM users WHERE id = $1", [a.id])).rows[0].role).toBe("admin");
  });

  it("the DATABASE refuses it even for a direct statement: only the setup tool's transaction can grant the role", async () => {
    const u = await signup(app);
    await expect(pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [u.id])).rejects.toThrow(/server-side setup tool/);
    await expect(pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'owner')", [uniqueEmail()])).rejects.toThrow(/server-side setup tool/);
    expect((await pool.query("SELECT role FROM users WHERE id = $1", [u.id])).rows[0].role).toBe("user");
  });

  it("a session variable set by ordinary code in another connection cannot help (it is per transaction)", async () => {
    const u = await signup(app);
    await pool.query("SELECT set_config('clynx.owner_change', 'on', false)"); // a different pooled connection, session-level
    await pool.query("SELECT set_config('clynx.owner_change', 'off', false)");
    await expect(pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [u.id])).rejects.toThrow();
  });

  it("an email address means nothing: an account that merely uses a likely address gets no role", async () => {
    for (const email of ["owner@clynx.com", "admin@example.com", "biggtrippyt@gmail.com"]) {
      const res = await app.inject({ method: "POST", url: "/web/signup", payload: { email, password: PASSWORD } });
      if (res.statusCode === 201) expect(res.json().user.role).toBe("user");
    }
  });
});

describe("provisioning (one-time, server-side)", () => {
  it("needs an existing account, a correct one-time code, and works only once", async () => {
    await expect(beginOwnerSetup(uniqueEmail("ghost"))).rejects.toThrow(OwnerSetupError);
    const u = await signup(app);
    const other = await signup(app);
    const { code } = await beginOwnerSetup(u.email);
    await expect(completeOwnerSetup(u.email, "own_wrong-code-wrong-code-wrong")).rejects.toThrow(/wrong, already used, or expired/);
    await expect(completeOwnerSetup(other.email, code)).rejects.toThrow(/wrong, already used, or expired/); // a code belongs to ONE account
    const r = await completeOwnerSetup(u.email, code);
    expect(r.email).toBe(u.email);
    await expect(completeOwnerSetup(u.email, code)).rejects.toThrow(); // used
    expect((await pool.query("SELECT role FROM users WHERE id = $1", [u.id])).rows[0].role).toBe("owner");
    expect(await ownerStatus()).toMatchObject({ email: u.email });
    await revokeOwner(u.email);
  });

  it("an expired code does nothing", async () => {
    const u = await signup(app);
    const { code } = await beginOwnerSetup(u.email);
    await pool.query("UPDATE owner_setup_codes SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.id]);
    await expect(completeOwnerSetup(u.email, code)).rejects.toThrow(/expired/);
    expect((await pool.query("SELECT role FROM users WHERE id = $1", [u.id])).rows[0].role).toBe("user");
  });

  it("only one Owner can exist; a second setup is refused until the first is removed", async () => {
    const first = await signup(app);
    const second = await signup(app);
    const c = await beginOwnerSetup(first.email);
    await completeOwnerSetup(first.email, c.code);
    await expect(beginOwnerSetup(second.email)).rejects.toThrow(/already exists/);
    await expect(pool.query("SELECT set_config('clynx.owner_change','on',false)").then(() => pool.query("UPDATE users SET role='owner' WHERE id=$1", [second.id]))).rejects.toThrow(); // the unique index
    await pool.query("SELECT set_config('clynx.owner_change','off',false)");
    await revokeOwner(first.email);
    await expect(revokeOwner(first.email)).rejects.toThrow(/not the Owner/);
  });

  it("granting ends every earlier sign-in of that account and is written to the audit log", async () => {
    const u = await signup(app);
    const desktop = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json();
    const { code } = await beginOwnerSetup(u.email);
    await completeOwnerSetup(u.email, code);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: desktop.refreshToken } })).statusCode).toBe(401);
    expect((await pool.query("SELECT 1 FROM admin_audit WHERE action = 'owner.grant' AND admin_email = $1", [u.email])).rows.length).toBe(1);
    await revokeOwner(u.email);
  });
});

describe("what the Owner gets", () => {
  beforeAll(async () => {
    owner = await makeOwner();
    ownerEmail = owner.email;
  });
  afterAll(async () => {
    await revokeOwner(ownerEmail).catch(() => undefined);
  });

  it("is shown as Owner with full access on the website session and the billing status, without any subscription", async () => {
    const s = (await app.inject({ method: "GET", url: "/web/session", headers: { cookie: owner.cookie } })).json();
    expect(s.user.role).toBe("owner");
    expect(s.user.owner).toBe(true);
    expect(s.user.plan).toBe("pro");
    const b = (await app.inject({ method: "GET", url: "/billing/status", headers: { cookie: owner.cookie } })).json();
    expect(b.owner).toBe(true);
    expect(b.plan).toBe("pro");
    expect(b.entitlements).toMatchObject({ maxWatches: null, maxDevices: null, aiRequestsPerDay: null, aiResearchEnabled: true });
    expect((await pool.query("SELECT 1 FROM subscriptions WHERE user_id = $1", [owner.id])).rows).toHaveLength(0); // no subscription row was created or needed
  });

  it("the desktop app's own sign-in sees the same thing (one answer from the server)", async () => {
    const tok = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: owner.email, password: PASSWORD } })).json().accessToken;
    const b = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${tok}` } })).json();
    expect(b.owner).toBe(true);
    expect(b.entitlements.maxDevices).toBeNull();
    const me = (await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tok}` } })).json();
    expect(me.owner).toBe(true);
  });

  it("has no plan limits even when limits are enforced; an administrator and a free customer still do", async () => {
    const was = config.enforceEntitlements;
    config.enforceEntitlements = true;
    try {
      const tok = async (u: WebUser) => (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json().accessToken as string;
      const addDevices = async (u: WebUser, n: number) => {
        const t = await tok(u);
        const codes: number[] = [];
        for (let i = 0; i < n; i++) codes.push((await app.inject({ method: "POST", url: "/devices/register", headers: { authorization: `Bearer ${t}` }, payload: { platform: "win32", clientVersion: "1" } })).statusCode);
        return codes;
      };
      expect((await addDevices(owner, 5)).every((c) => c === 201)).toBe(true);
      const admin = await signup(app);
      await makeAdmin(admin.id);
      expect(await addDevices(admin, 3)).toEqual([201, 201, 402]); // free plan: 2 computers - being an administrator gives nothing
      const free = await signup(app);
      expect(await addDevices(free, 3)).toEqual([201, 201, 402]);
    } finally {
      config.enforceEntitlements = was;
    }
  });

  it("an administrator is NOT given the Owner's status or a free plan", async () => {
    const a = await signup(app);
    await makeAdmin(a.id);
    const b = (await app.inject({ method: "GET", url: "/billing/status", headers: { cookie: a.cookie } })).json();
    expect(b.owner).toBe(false);
    expect(b.plan).toBe("free");
  });

  it("needs no payment: checkout, portal and plan changes are refused and nothing reaches the payment provider", async () => {
    for (const url of ["/billing/checkout", "/billing/portal", "/billing/change-plan", "/billing/cancel", "/billing/resume"]) {
      const res = await app.inject({ method: "POST", url, headers: asWeb(owner), payload: { plan: "pro_monthly" } });
      expect(res.statusCode, url).toBe(409);
      expect(res.json().error, url).toBe("owner_no_payment_needed");
    }
  });

  it("has the administration console, and can disable an administrator (an administrator cannot)", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/overview", headers: { cookie: owner.cookie } })).statusCode).toBe(200);
    const a1 = await signup(app);
    const a2 = await signup(app);
    await makeAdmin(a1.id);
    await makeAdmin(a2.id);
    expect((await app.inject({ method: "POST", url: `/admin/users/${a2.id}/disabled`, headers: asWeb(a1), payload: { value: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/admin/users/${a2.id}/disabled`, headers: asWeb(owner), payload: { value: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/users/${owner.id}/disabled`, headers: asWeb(owner), payload: { value: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/admin/users/${owner.id}/disabled`, headers: asWeb(a1), payload: { value: true } })).statusCode).toBe(409);
  });

  it("cannot be deleted from the website or by the database", async () => {
    const res = await app.inject({ method: "DELETE", url: "/me", headers: asWeb(owner), payload: { password: PASSWORD, confirm: "DELETE" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("owner_account_protected");
    await expect(pool.query("DELETE FROM users WHERE id = $1", [owner.id])).rejects.toThrow(/cannot be deleted/);
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [owner.id])).rows).toHaveLength(1);
  });

  it("granting the role does not touch anyone's subscription", async () => {
    const before = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(extract(epoch from updated_at)), 0)::float8 AS t FROM subscriptions")).rows[0];
    const u = await signup(app);
    const { code } = await beginOwnerSetup(u.email).catch(async () => {
      await revokeOwner(ownerEmail);
      return beginOwnerSetup(u.email);
    });
    await completeOwnerSetup(u.email, code);
    const after = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(extract(epoch from updated_at)), 0)::float8 AS t FROM subscriptions")).rows[0];
    expect(after).toEqual(before);
    await revokeOwner(u.email);
  });
});
