import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { asWeb, emailCount, lastEmailToken, PASSWORD, signup, uniqueEmail, webLogin } from "./helpers/web.js";

// The website's account system: cookie sessions, CSRF protection, email verification, password reset, profile, data export, and parity with the desktop app's accounts.
let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp({ billing: null });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await closePool();
});

describe("signup and the session cookie", () => {
  it("creates an account, a session cookie with safe flags, and a verification email", async () => {
    const email = uniqueEmail();
    const res = await app.inject({ method: "POST", url: "/web/signup", payload: { email, password: PASSWORD, displayName: "Sam" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe(email);
    expect(body.user.displayName).toBe("Sam");
    expect(body.user.emailVerified).toBe(false);
    expect(typeof body.csrfToken).toBe("string");
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/);
    expect(await emailCount(email, "verify_email")).toBe(1);
    // the response body never carries the session secret or any password material
    expect(res.body).not.toMatch(/password|hash|argon2/i);
  });

  it("stores only a hash of the session secret", async () => {
    const u = await signup(app);
    const secret = u.cookie.split("=")[1];
    const rows = await pool.query("SELECT secret_hash FROM web_sessions WHERE user_id = $1", [u.id]);
    expect(rows.rows[0].secret_hash).not.toContain(secret);
    expect(rows.rows[0].secret_hash).toHaveLength(64);
  });

  it("refuses a duplicate address (any letter case), a short password and a bad address", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "POST", url: "/web/signup", payload: { email: u.email.toUpperCase(), password: PASSWORD } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/web/signup", payload: { email: uniqueEmail(), password: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/web/signup", payload: { email: "not-an-email", password: PASSWORD } })).statusCode).toBe(400);
  });

  it("refuses sign-up and login requests that come from another site", async () => {
    const res = await app.inject({ method: "POST", url: "/web/signup", headers: { origin: "https://evil.example" }, payload: { email: uniqueEmail(), password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/web/login", headers: { origin: "http://localhost:8787" }, payload: { email: "nobody@example.com", password: PASSWORD } });
    expect(ok.statusCode).toBe(401); // reached the credential check, so the same-site Origin was accepted
  });
});

describe("login", () => {
  it("logs in with the right password and gives a different session each time", async () => {
    const u = await signup(app);
    const a = await webLogin(app, u.email);
    const b = await webLogin(app, u.email);
    expect(a.cookie).not.toBe(b.cookie);
    expect(a.csrf).not.toBe(b.csrf);
  });

  it("answers the same for a wrong password and an unknown address, and throttles guessing", async () => {
    const u = await signup(app);
    const wrong = await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: "wrong-password-1" } });
    const unknown = await app.inject({ method: "POST", url: "/web/login", payload: { email: uniqueEmail(), password: "wrong-password-1" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: `wrong-password-${i}` } })).statusCode;
    expect(last).toBe(429);
  });

  it("a disabled account cannot sign in, and its existing sessions stop working", async () => {
    const u = await signup(app);
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [u.id]);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe("account_disabled");
  });
});

describe("the session and CSRF protection", () => {
  it("GET /web/session works with the cookie and returns the CSRF token", async () => {
    const u = await signup(app);
    const res = await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().csrfToken).toBe(u.csrf);
    expect(res.json().user.email).toBe(u.email);
  });

  it("no cookie, a garbage cookie and a tampered cookie are all 401", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "GET", url: "/web/session" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: "clynx_sid=garbage" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie.slice(0, -2) + "xx" } })).statusCode).toBe(401);
  });

  it("a state-changing request with the cookie needs the CSRF token", async () => {
    const u = await signup(app);
    const none = await app.inject({ method: "PATCH", url: "/web/profile", headers: { cookie: u.cookie }, payload: { displayName: "X" } });
    const wrong = await app.inject({ method: "PATCH", url: "/web/profile", headers: { cookie: u.cookie, "x-csrf-token": "nope" }, payload: { displayName: "X" } });
    const right = await app.inject({ method: "PATCH", url: "/web/profile", headers: asWeb(u), payload: { displayName: "Alex" } });
    expect(none.statusCode).toBe(403);
    expect(none.json().error).toBe("csrf");
    expect(wrong.statusCode).toBe(403);
    expect(right.statusCode).toBe(200);
    expect(right.json().user.displayName).toBe("Alex");
  });

  it("one account's CSRF token does not work for another account's session", async () => {
    const a = await signup(app);
    const b = await signup(app);
    const res = await app.inject({ method: "PATCH", url: "/web/profile", headers: { cookie: a.cookie, "x-csrf-token": b.csrf }, payload: { displayName: "Hijack" } });
    expect(res.statusCode).toBe(403);
  });

  it("a request from another site's Origin is refused even with a valid token", async () => {
    const u = await signup(app);
    const res = await app.inject({ method: "PATCH", url: "/web/profile", headers: asWeb(u, { origin: "https://evil.example" }), payload: { displayName: "Hijack" } });
    expect(res.statusCode).toBe(403);
    const same = await app.inject({ method: "PATCH", url: "/web/profile", headers: asWeb(u, { origin: "http://localhost:8787" }), payload: { displayName: "Fine" } });
    expect(same.statusCode).toBe(200);
  });

  it("logging out ends the session and clears the cookie", async () => {
    const u = await signup(app);
    const out = await app.inject({ method: "POST", url: "/web/logout", headers: asWeb(u) });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(401);
  });

  it("the existing account endpoints accept the cookie too (and keep their CSRF rule)", async () => {
    const u = await signup(app);
    expect((await app.inject({ method: "GET", url: "/billing/status", headers: { cookie: u.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/devices", headers: { cookie: u.cookie } })).statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: "/me", headers: { cookie: u.cookie }, payload: { password: PASSWORD, confirm: "DELETE" } });
    expect(del.statusCode).toBe(403); // no CSRF token: refused before anything is deleted
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [u.id])).rows).toHaveLength(1);
  });

  it("a bearer token still works as before, and takes no CSRF token", async () => {
    const email = uniqueEmail();
    const reg = (await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PASSWORD } })).json();
    const res = await app.inject({ method: "POST", url: "/web/email/resend", headers: { authorization: `Bearer ${reg.accessToken}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe("email verification", () => {
  it("a token verifies the address once", async () => {
    const u = await signup(app);
    const token = await lastEmailToken(u.email, "verify_email");
    expect((await app.inject({ method: "POST", url: "/web/email/verify", payload: { token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).json().user.emailVerified).toBe(true);
    expect((await app.inject({ method: "POST", url: "/web/email/verify", payload: { token } })).statusCode).toBe(400); // used
  });

  it("refuses unknown, expired and wrong-purpose tokens", async () => {
    const u = await signup(app);
    const token = await lastEmailToken(u.email, "verify_email");
    expect((await app.inject({ method: "POST", url: "/web/email/verify", payload: { token: "x".repeat(43) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/web/password/reset", payload: { token, newPassword: "another-password-1" } })).statusCode).toBe(400); // a verify token cannot reset a password
    await pool.query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u.id]);
    expect((await app.inject({ method: "POST", url: "/web/email/verify", payload: { token } })).statusCode).toBe(400);
  });

  it("resending sends a new link, the older one stops working, and it is rate limited", async () => {
    const u = await signup(app);
    const first = await lastEmailToken(u.email, "verify_email");
    expect((await app.inject({ method: "POST", url: "/web/email/resend", headers: asWeb(u) })).statusCode).toBe(200);
    const second = await lastEmailToken(u.email, "verify_email");
    expect(second).not.toBe(first);
    expect((await app.inject({ method: "POST", url: "/web/email/verify", payload: { token: first } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/web/email/resend", headers: asWeb(u) });
    await app.inject({ method: "POST", url: "/web/email/resend", headers: asWeb(u) });
    expect((await app.inject({ method: "POST", url: "/web/email/resend", headers: asWeb(u) })).statusCode).toBe(429);
  });
});

describe("password reset", () => {
  it("answers the same for an unknown address and sends nothing", async () => {
    const known = await signup(app);
    const unknownEmail = uniqueEmail("ghost");
    const a = await app.inject({ method: "POST", url: "/web/password/forgot", payload: { email: known.email } });
    const b = await app.inject({ method: "POST", url: "/web/password/forgot", payload: { email: unknownEmail } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    expect(await emailCount(known.email, "reset_password")).toBe(1);
    expect(await emailCount(unknownEmail, "reset_password")).toBe(0);
  });

  it("sets a new password, ends every session and desktop sign-in, and the token works once", async () => {
    const u = await signup(app);
    const desktop = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json();
    await app.inject({ method: "POST", url: "/web/password/forgot", payload: { email: u.email } });
    const token = await lastEmailToken(u.email, "reset_password");
    const NEW = "a-brand-new-password-9";
    expect((await app.inject({ method: "POST", url: "/web/password/reset", payload: { token, newPassword: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/web/password/reset", payload: { token, newPassword: NEW } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/web/password/reset", payload: { token, newPassword: NEW } })).statusCode).toBe(400); // single use
    expect((await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: NEW } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(401); // the old browser session ended
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: desktop.refreshToken } })).statusCode).toBe(401); // and so did the desktop sign-in
    expect(await emailCount(u.email, "password_changed_notice")).toBe(1);
  });

  it("an expired reset link does nothing", async () => {
    const u = await signup(app);
    await app.inject({ method: "POST", url: "/web/password/forgot", payload: { email: u.email } });
    const token = await lastEmailToken(u.email, "reset_password");
    await pool.query("UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND purpose = 'reset_password'", [u.id]);
    expect((await app.inject({ method: "POST", url: "/web/password/reset", payload: { token, newPassword: "a-brand-new-password-9" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/web/login", payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(200);
  });

  it("limits reset emails per address", async () => {
    const u = await signup(app);
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/web/password/forgot", payload: { email: u.email } });
    expect(await emailCount(u.email, "reset_password")).toBe(3);
  });
});

describe("profile and changing the email address", () => {
  it("changes the address only after the new inbox confirms it", async () => {
    const u = await signup(app);
    const newEmail = uniqueEmail("new");
    expect((await app.inject({ method: "POST", url: "/web/email/change", headers: asWeb(u), payload: { newEmail, password: "wrong-password-1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/web/email/change", headers: asWeb(u), payload: { newEmail, password: PASSWORD } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).json().user.email).toBe(u.email); // not yet
    const token = await lastEmailToken(newEmail, "change_email");
    expect((await app.inject({ method: "POST", url: "/web/email/confirm-change", payload: { token } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).json().user.email).toBe(newEmail);
    expect(await emailCount(u.email, "email_changed_notice")).toBe(1); // the old address is told
    expect((await webLogin(app, newEmail)).email).toBe(newEmail);
  });

  it("refuses an address that belongs to someone else", async () => {
    const a = await signup(app);
    const b = await signup(app);
    expect((await app.inject({ method: "POST", url: "/web/email/change", headers: asWeb(a), payload: { newEmail: b.email, password: PASSWORD } })).statusCode).toBe(409);
  });
});

describe("browser sessions", () => {
  it("lists them, revokes one, and can sign out all the others", async () => {
    const u = await signup(app);
    const other = await webLogin(app, u.email);
    const list = (await app.inject({ method: "GET", url: "/web/sessions", headers: { cookie: u.cookie } })).json().sessions;
    expect(list.length).toBe(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const third = await webLogin(app, u.email);
    expect((await app.inject({ method: "POST", url: "/web/sessions/revoke-others", headers: asWeb(u) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: other.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: third.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(200);
  });

  it("cannot revoke another account's session", async () => {
    const a = await signup(app);
    const b = await signup(app);
    const bId = (await app.inject({ method: "GET", url: "/web/sessions", headers: { cookie: b.cookie } })).json().sessions[0].id;
    expect((await app.inject({ method: "DELETE", url: `/web/sessions/${bId}`, headers: asWeb(a) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: b.cookie } })).statusCode).toBe(200);
  });
});

describe("one account system for the website and the desktop app", () => {
  it("an account made on the website signs in from the desktop app, and the other way round", async () => {
    const w = await signup(app);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: w.email, password: PASSWORD } })).statusCode).toBe(200);
    const email = uniqueEmail("desk");
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PASSWORD } });
    expect((await webLogin(app, email)).email).toBe(email);
    expect(await emailCount(email, "verify_email")).toBe(1); // desktop sign-ups are asked to verify too
  });

  it("devices registered by the app show on the website, and removing one signs that device out", async () => {
    const u = await signup(app);
    const desk = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json();
    const dev = (await app.inject({ method: "POST", url: "/devices/register", headers: { authorization: `Bearer ${desk.accessToken}` }, payload: { platform: "win32", clientVersion: "0.3.0" } })).json();
    const bound = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD, deviceId: dev.id } })).json();
    const listed = (await app.inject({ method: "GET", url: "/devices", headers: { cookie: u.cookie } })).json().devices;
    expect(listed.map((d: { id: string }) => d.id)).toContain(dev.id);
    expect((await app.inject({ method: "DELETE", url: `/devices/${dev.id}`, headers: asWeb(u) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: bound.refreshToken } })).statusCode).toBe(401); // the app can no longer refresh
    // another customer cannot remove it (it is already gone, and they would get 404 in any case)
    const other = await signup(app);
    expect((await app.inject({ method: "DELETE", url: `/devices/${dev.id}`, headers: asWeb(other) })).statusCode).toBe(404);
  });

  it("a disabled account's desktop sign-in cannot refresh", async () => {
    const u = await signup(app);
    const desk = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json();
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [u.id]);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: desk.refreshToken } })).statusCode).toBe(401);
  });
});

describe("data export and account deletion", () => {
  it("exports the customer's own data and nothing secret or foreign", async () => {
    const a = await signup(app);
    const b = await signup(app);
    const aTok = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: a.email, password: PASSWORD } })).json().accessToken;
    await app.inject({ method: "POST", url: "/devices/register", headers: { authorization: `Bearer ${aTok}` }, payload: { platform: "win32", clientVersion: "0.3.0" } });
    const res = await app.inject({ method: "GET", url: "/web/export", headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-disposition"])).toMatch(/attachment/);
    const data = res.json();
    expect(data.account.email).toBe(a.email);
    expect(data.devices).toHaveLength(1);
    expect(res.body).not.toContain(b.email);
    expect(res.body).not.toMatch(/password_hash|argon2|secret_hash|csrf/i);
  });

  it("deleting the account from the website removes it and ends the session", async () => {
    const u = await signup(app);
    const del = await app.inject({ method: "DELETE", url: "/me", headers: asWeb(u), payload: { password: PASSWORD, confirm: "DELETE" } });
    expect(del.statusCode).toBe(200);
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [u.id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM web_sessions WHERE user_id = $1", [u.id])).rows).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/web/session", headers: { cookie: u.cookie } })).statusCode).toBe(401);
  });
});
