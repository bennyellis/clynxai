import { createHash, randomBytes } from "node:crypto";
import { getClient, query } from "../db/client.js";

// The Owner role is provisioned ONLY here, from the server's command line (see ../scripts/owner.ts). There is no web endpoint, no registration option, no email-address rule and no
// flag in any client that can create it. Two steps, so it cannot happen by a stray command:
//   begin    - names an existing account and prints a one-time code (valid 15 minutes, stored only as a hash)
//   complete - presents that code; the role is granted inside one transaction that also records the grant and ends every existing sign-in of that account
// At most one Owner can exist (a unique index enforces it), and the database refuses any other route to the role (migration 012).

const CODE_TTL_MS = 15 * 60_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export class OwnerSetupError extends Error {}

async function userByEmail(email: string) {
  const r = await query<{ id: string; email: string; role: string; disabled_at: Date | null }>("SELECT id, email, role, disabled_at FROM users WHERE lower(email) = lower($1)", [email.trim()]);
  return r.rows[0] ?? null;
}

export async function ownerStatus(): Promise<{ email: string; since: Date | null } | null> {
  const r = await query<{ email: string }>("SELECT email FROM users WHERE role = 'owner'");
  return r.rows[0] ? { email: r.rows[0].email, since: null } : null;
}

export async function beginOwnerSetup(email: string): Promise<{ code: string; expiresAt: Date }> {
  const u = await userByEmail(email);
  if (!u) throw new OwnerSetupError(`There is no account with the address ${email}. Create it first (on the website or in the app), then run this again.`);
  if (u.disabled_at) throw new OwnerSetupError("That account is disabled.");
  const existing = await ownerStatus();
  if (existing) throw new OwnerSetupError(`An Owner already exists (${existing.email}). There can be only one; remove that role first with the server tool if you really mean to move it.`);
  const code = `own_${randomBytes(18).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await query("UPDATE owner_setup_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [u.id]);
  await query("INSERT INTO owner_setup_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)", [u.id, hash(code), expiresAt]);
  return { code, expiresAt };
}

export async function completeOwnerSetup(email: string, code: string): Promise<{ email: string }> {
  const u = await userByEmail(email);
  if (!u) throw new OwnerSetupError("Unknown account.");
  const client = await getClient();
  try {
    await client.query("BEGIN");
    // the code must belong to THIS account, be unused and unexpired; using it is atomic
    const used = await client.query<{ id: string }>(
      "UPDATE owner_setup_codes SET used_at = now() WHERE code_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING id",
      [hash(String(code ?? "").trim()), u.id]
    );
    if (!used.rows[0]) throw new OwnerSetupError("That code is wrong, already used, or expired. Start again with the begin step.");
    if ((await client.query("SELECT 1 FROM users WHERE role = 'owner'")).rows.length) throw new OwnerSetupError("An Owner already exists.");
    await client.query("SELECT set_config('clynx.owner_change', 'on', true)"); // this transaction only
    await client.query("UPDATE users SET role = 'owner', email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [u.id]);
    // every sign-in that existed before the role changed is ended, so the owner signs in fresh and no older session is promoted
    await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
    await client.query("UPDATE web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
    await client.query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES ($1, $2, 'owner.grant', $4, $3)", [u.id, u.email, JSON.stringify({ via: "server setup tool" }), u.id]);
    await client.query("COMMIT");
    return { email: u.email };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Removes the Owner role (the account becomes an ordinary user). Server tool only; needs the exact address. */
export async function revokeOwner(email: string): Promise<void> {
  const u = await userByEmail(email);
  if (!u || u.role !== "owner") throw new OwnerSetupError("That account is not the Owner.");
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('clynx.owner_change', 'on', true)");
    await client.query("UPDATE users SET role = 'user' WHERE id = $1", [u.id]);
    await client.query("INSERT INTO admin_audit (admin_user_id, admin_email, action, target, detail) VALUES ($1, $2, 'owner.revoke', $4, $3)", [u.id, u.email, JSON.stringify({ via: "server setup tool" }), u.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
