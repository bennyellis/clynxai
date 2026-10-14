import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pool } from "../../src/db/client.js";

export const uniqueEmail = (p = "web") => `${p}-${randomUUID()}@example.com`;
export const PASSWORD = "correct-horse-battery";

export interface WebUser {
  email: string;
  id: string;
  cookie: string;
  csrf: string;
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) throw new Error("no Set-Cookie header");
  return header.split(";")[0];
}

export async function signup(app: FastifyInstance, email = uniqueEmail(), password = PASSWORD): Promise<WebUser> {
  const res = await app.inject({ method: "POST", url: "/web/signup", payload: { email, password } });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { email, id: body.user.id, cookie: cookieFrom(res), csrf: body.csrfToken };
}

export async function webLogin(app: FastifyInstance, email: string, password = PASSWORD): Promise<WebUser> {
  const res = await app.inject({ method: "POST", url: "/web/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { email, id: body.user.id, cookie: cookieFrom(res), csrf: body.csrfToken };
}

/** Headers for a request made with the website session (the CSRF token goes along for anything that changes data). */
export const asWeb = (u: WebUser, extra: Record<string, string> = {}) => ({ cookie: u.cookie, "x-csrf-token": u.csrf, ...extra });

export async function makeAdmin(id: string): Promise<void> {
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [id]);
}

/** The most recent emailed link token of a kind for an address (the outbox is where development and tests read mail). */
export async function lastEmailToken(email: string, purpose: string): Promise<string> {
  const r = await pool.query<{ body: string }>("SELECT body FROM email_outbox WHERE lower(to_email) = lower($1) AND purpose = $2 ORDER BY id DESC LIMIT 1", [email, purpose]);
  const m = r.rows[0] && /token=([A-Za-z0-9_-]+)/.exec(r.rows[0].body);
  if (!m) throw new Error(`no ${purpose} email for ${email}`);
  return m[1];
}
export async function emailCount(email: string, purpose: string): Promise<number> {
  return (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM email_outbox WHERE lower(to_email) = lower($1) AND purpose = $2", [email, purpose])).rows[0].n;
}

/** Makes this account THE Owner (the Owner role can only be granted by the server-side tool, so the database guard is opened for this one statement). Any earlier Owner becomes a normal user. */
export async function makeOwner(id: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("SELECT set_config('clynx.owner_change', 'on', false)");
    await c.query("UPDATE users SET role = 'user' WHERE role = 'owner' AND id <> $1", [id]);
    await c.query("UPDATE users SET role = 'owner' WHERE id = $1", [id]);
    await c.query("SELECT set_config('clynx.owner_change', 'off', false)");
  } finally {
    c.release();
  }
}
