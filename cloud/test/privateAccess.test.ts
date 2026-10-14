import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { redisConnection } from "../src/queue/connection.js";
import { asWeb, makeAdmin, makeOwner, PASSWORD, signup, uniqueEmail, type WebUser } from "./helpers/web.js";

// The private beta: ACCESS_MODE=private (nothing reachable without signing in) and REGISTRATION=invite (accounts only with an invitation from the Owner/an administrator).
let app: FastifyInstance;
let admin: WebUser;
let member: WebUser;
const HTML = { accept: "text/html" };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: config.web.publicUrl };

beforeAll(async () => {
  for (const k of await redisConnection.keys("rl:*")) await redisConnection.del(k);
  app = buildApp({ billing: null });
  await app.ready();
  admin = await signup(app); // while registration is still open
  await makeOwner(admin.id);
  member = await signup(app);
  config.web.accessPrivate = true;
  config.web.registration = "invite";
});
afterAll(async () => {
  config.web.accessPrivate = false;
  config.web.registration = "open";
  await app?.close();
  await closePool();
});

async function newInvite(opts: { email?: string; hours?: number } = {}): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/admin/invites", headers: asWeb(admin), payload: opts });
  expect(r.statusCode).toBe(201);
  return r.json().code as string;
}
const cookieOf = (res: { headers: Record<string, unknown> }) => String((Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0] : res.headers["set-cookie"]) ?? "").split(";")[0];

describe("a visitor who is not signed in", () => {
  it("gets only the small sign-in page, with no website code, and is told not to be indexed", async () => {
    const r = await app.inject({ method: "GET", url: "/", headers: HTML });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain("Sign in");
    expect(r.body).not.toMatch(/<script/i);
    expect(r.body).not.toMatch(/assets\//);
    expect(r.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["referrer-policy"]).toBe("same-origin"); // so a browser form post carries its real Origin (with no-referrer Chrome sends "Origin: null")
  });
  it("gets the same page for any website address (no hint which pages exist)", async () => {
    for (const p of ["/download", "/pricing", "/console/releases", "/anything/at/all"]) {
      const r = await app.inject({ method: "GET", url: p, headers: HTML });
      expect(r.statusCode, p).toBe(401);
      expect(r.body, p).toContain("Private beta");
    }
  });
  it("is refused (401, no detail) everywhere an application would call", async () => {
    for (const p of ["/assets/index.js", "/releases/latest", "/releases", "/updates/beta/latest", "/updates/stable/versions/1.0.0", "/plans/public", "/admin/overview", "/web/session", "/devices", "/me", "/ai/chat", "/ebay/search?q=x"]) {
      const r = await app.inject({ method: "GET", url: p });
      expect(r.statusCode, p).toBe(401);
      expect(r.json().error, p).toBe("private_beta");
    }
    expect((await app.inject({ method: "POST", url: "/web/signup", payload: { email: uniqueEmail(), password: PASSWORD } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/web/login", payload: { email: member.email, password: PASSWORD } })).statusCode).toBe(401);
  });
  it("cannot download an installer, even with a valid release id", async () => {
    const r = await app.inject({ method: "GET", url: "/releases/00000000-0000-4000-8000-000000000000/download" });
    expect(r.statusCode).toBe(401);
  });
  it("cannot slip past the gate with an odd spelling of a protected address", async () => {
    const odd = [
      "//admin/overview", "/admin/overview/", "/admin//overview", "/%61dmin/overview", "/admin%2Foverview", "/ADMIN/overview", "/Releases/latest",
      "/health/../admin/overview", "/health/ready/../../admin/overview", "/gate/../admin/overview", "/server/info/../../admin/overview", "/server/info%2f..%2fadmin/overview",
      "/auth/login/../../admin/overview", "/robots.txt/../admin/overview", "/.%2e/admin/overview", "/health;/admin/overview", "/health?/admin/overview=1",
    ];
    for (const p of odd) {
      const r = await app.inject({ method: "GET", url: p });
      expect([200, 400, 401, 404].includes(r.statusCode), `${p} -> ${r.statusCode}`).toBe(true);
      // whatever the answer, it must not be protected data
      expect(r.body, p).not.toMatch(/"users"|"downloads30"|"signups7"/);
    }
    for (const m of ["POST", "PUT", "DELETE", "PATCH"] as const) {
      const r = await app.inject({ method: m, url: "/admin/releases", payload: {} });
      expect(r.statusCode, m).toBe(401);
    }
    // a header that asks to be treated as another method changes nothing
    expect((await app.inject({ method: "GET", url: "/admin/overview", headers: { "x-http-method-override": "POST", "x-original-url": "/health", "x-rewrite-url": "/health" } })).statusCode).toBe(401);
    // a made-up bearer token or cookie opens nothing
    expect((await app.inject({ method: "GET", url: "/releases/latest", headers: { authorization: "Bearer abc.def.ghi" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/releases/latest", headers: { cookie: "clynx_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; __Host-clynx_sid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } })).statusCode).toBe(401);
  });
  it("is told, by robots.txt, to stay away", async () => {
    const r = await app.inject({ method: "GET", url: "/robots.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Disallow: /");
  });
  it("can reach only what a desktop app needs before signing in", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const info = await app.inject({ method: "GET", url: "/server/info" });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ access: "private", registration: "invite" });
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: member.email, password: PASSWORD } })).statusCode).toBe(200);
  });
});

describe("signing in through the gate", () => {
  it("a wrong password shows the page again with a generic message and gives no cookie", async () => {
    const r = await app.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email: member.email, password: "wrong-password-1" }) });
    expect(r.statusCode).toBe(401);
    expect(r.body).toContain("not right");
    expect(r.headers["set-cookie"]).toBeUndefined();
    const nobody = await app.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email: "nobody@example.com", password: "whatever-123" }) });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.body).toContain("not right"); // the same message: no account enumeration
  });
  it("the right password signs in, sets a session cookie and sends the person to the website", async () => {
    const r = await app.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email: member.email, password: PASSWORD }) });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/");
    const c = cookieOf(r);
    expect(c).toMatch(/clynx_sid=/);
    expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly/);
    const site = await app.inject({ method: "GET", url: "/releases/latest", headers: { cookie: c } });
    expect(site.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: c } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/", headers: { ...HTML, cookie: c } })).body).not.toContain("Private beta");
  });
  it("a sign-in from another website is refused", async () => {
    const r = await app.inject({ method: "POST", url: "/gate/login", headers: { ...FORM, origin: "https://evil.example" }, payload: form({ email: member.email, password: PASSWORD }) });
    expect(r.statusCode).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
  it("a disabled account can no longer pass the gate with its old cookie", async () => {
    const u = await signupWhileOpen();
    const login = await app.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email: u.email, password: PASSWORD }) });
    const c = cookieOf(login);
    expect((await app.inject({ method: "GET", url: "/releases/latest", headers: { cookie: c } })).statusCode).toBe(200);
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [u.id]);
    expect((await app.inject({ method: "GET", url: "/releases/latest", headers: { cookie: c } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email: u.email, password: PASSWORD }) })).body).toContain("disabled");
  });
  it("guessing passwords at speed is stopped", async () => {
    const email = uniqueEmail("guess");
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email, password: `guess-number-${i}` }) })).statusCode;
    expect(last).toBe(429);
  });
});

async function signupWhileOpen(): Promise<WebUser> {
  config.web.registration = "open";
  config.web.accessPrivate = false;
  try {
    return await signup(app);
  } finally {
    config.web.registration = "invite";
    config.web.accessPrivate = true;
  }
}

describe("accounts need an invitation", () => {
  it("the website sign-up and the desktop register are refused without a code", async () => {
    const e1 = uniqueEmail("nocode");
    const a = await app.inject({ method: "POST", url: "/gate/join", headers: FORM, payload: form({ email: e1, password: PASSWORD }) });
    expect(a.statusCode).toBe(400);
    expect(a.body).toContain("invitation");
    expect((await pool.query("SELECT 1 FROM users WHERE email = $1", [e1])).rowCount).toBe(0);
    const b = await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("nocode2"), password: PASSWORD } });
    expect(b.statusCode).toBe(403);
    expect(b.json().error).toBe("invitation_required");
    const c = await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("badcode"), password: PASSWORD, inviteCode: "AAAA-BBBB-CCCC-DDDD" } });
    expect(c.statusCode).toBe(403);
  });
  it("a valid code creates the account, signs the person in, and works exactly once", async () => {
    const code = await newInvite();
    const email = uniqueEmail("invited");
    const r = await app.inject({ method: "POST", url: "/gate/join", headers: FORM, payload: form({ email, password: PASSWORD, inviteCode: code }) });
    expect(r.statusCode).toBe(303);
    expect((await app.inject({ method: "GET", url: "/releases/latest", headers: { cookie: cookieOf(r) } })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/gate/join", headers: FORM, payload: form({ email: uniqueEmail("second"), password: PASSWORD, inviteCode: code }) });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("did not work");
    const row = await pool.query("SELECT used_by FROM invites WHERE code_hash IS NOT NULL AND used_by = (SELECT id FROM users WHERE email = $1)", [email]);
    expect(row.rowCount).toBe(1);
  });
  it("the desktop app can register with a code and then use its bearer token everywhere", async () => {
    const code = await newInvite();
    const email = uniqueEmail("desktop");
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PASSWORD, inviteCode: code.toLowerCase() } });
    expect(r.statusCode).toBe(201);
    const auth = { authorization: `Bearer ${r.json().accessToken}` };
    for (const p of ["/releases/latest", "/updates/beta/latest", "/plans/public", "/entitlements"]) expect([200, 404].includes((await app.inject({ method: "GET", url: p, headers: auth })).statusCode), p).toBe(true);
  });
  it("a code tied to an email address works only for that address", async () => {
    const code = await newInvite({ email: "only-me@example.com" });
    const wrong = await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("other"), password: PASSWORD, inviteCode: code } });
    expect(wrong.statusCode).toBe(403);
    const right = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "only-me@example.com", password: PASSWORD, inviteCode: code } });
    expect([201, 409]).toContain(right.statusCode); // (409 only if an earlier run already created that address)
  });
  it("an expired, revoked or unknown code is refused, and a failed sign-up gives the code back", async () => {
    const expired = await newInvite();
    await pool.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE created_by = $1 AND used_at IS NULL AND email IS NULL AND expires_at > now() - interval '1 second' AND id = (SELECT id FROM invites ORDER BY created_at DESC LIMIT 1)", [admin.id]);
    expect((await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("exp"), password: PASSWORD, inviteCode: expired } })).statusCode).toBe(403);

    const toRevoke = await newInvite();
    const list = (await app.inject({ method: "GET", url: "/admin/invites", headers: asWeb(admin) })).json();
    const id = list.invites.find((i: { status: string }) => i.status === "open").id;
    expect((await app.inject({ method: "DELETE", url: `/admin/invites/${id}`, headers: asWeb(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("rev"), password: PASSWORD, inviteCode: toRevoke } })).statusCode).toBe(403);

    // an email that already has an account: the sign-up fails (409) and the code is NOT consumed
    const code = await newInvite();
    const dup = await app.inject({ method: "POST", url: "/auth/register", payload: { email: member.email, password: PASSWORD, inviteCode: code } });
    expect(dup.statusCode).toBe(409);
    const ok = await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("after-dup"), password: PASSWORD, inviteCode: code } });
    expect(ok.statusCode).toBe(201);
  });
  it("guessing invitation codes is limited", async () => {
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("g"), password: PASSWORD, inviteCode: `ZZZZ-ZZZZ-ZZZZ-ZZ${String(i).padStart(2, "0")}` } })).statusCode;
    expect(last).toBe(429);
  });
  it("with registration closed nobody can create an account, even with a code", async () => {
    const code = await newInvite();
    config.web.registration = "closed";
    try {
      const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email: uniqueEmail("closed"), password: PASSWORD, inviteCode: code } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("registration_closed");
    } finally {
      config.web.registration = "invite";
    }
  });
});

describe("the invitation administration", () => {
  it("is for administrators only, and never shows a code after creation", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/invites", headers: { cookie: member.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/invites", headers: asWeb(member), payload: {} })).statusCode).toBe(403);
    await newInvite();
    const list = await app.inject({ method: "GET", url: "/admin/invites", headers: asWeb(admin) });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(list.json().invites[0]).not.toHaveProperty("code");
    expect(list.json().invites[0]).not.toHaveProperty("code_hash");
  });
});

describe("secure cookies behind a TLS tunnel", () => {
  it("a request that arrived over https (X-Forwarded-Proto, proxy trusted) gets a Secure __Host- cookie and HSTS; plain http gets a plain cookie", async () => {
    const keep = config.trustProxy;
    (config as { trustProxy: boolean }).trustProxy = true;
    const proxied = buildApp({ billing: null });
    await proxied.ready();
    try {
      const https = await proxied.inject({ method: "POST", url: "/gate/login", headers: { ...FORM, "x-forwarded-proto": "https" }, payload: form({ email: member.email, password: PASSWORD }) });
      expect(https.statusCode).toBe(303);
      const sc = String(https.headers["set-cookie"]);
      expect(sc).toMatch(/^__Host-clynx_sid=/);
      expect(sc).toMatch(/; Secure/);
      expect(https.headers["strict-transport-security"]).toMatch(/max-age/);
      // that cookie works
      expect((await proxied.inject({ method: "GET", url: "/web/session", headers: { cookie: sc.split(";")[0], "x-forwarded-proto": "https" } })).statusCode).toBe(200);
      const http = await proxied.inject({ method: "POST", url: "/gate/login", headers: FORM, payload: form({ email: member.email, password: PASSWORD }) });
      expect(String(http.headers["set-cookie"])).toMatch(/^clynx_sid=/);
      expect(String(http.headers["set-cookie"])).not.toMatch(/Secure/);
      expect(http.headers["strict-transport-security"]).toBeUndefined();
    } finally {
      (config as { trustProxy: boolean }).trustProxy = keep;
      await proxied.close();
    }
  });
});

describe("switching the private mode off", () => {
  it("restores the normal open behaviour", async () => {
    config.web.accessPrivate = false;
    try {
      expect((await app.inject({ method: "GET", url: "/releases/latest" })).statusCode).toBe(200);
    } finally {
      config.web.accessPrivate = true;
    }
  });
});
