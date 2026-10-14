import { createHash, randomInt } from "node:crypto";
import { query } from "../db/client.js";

// Invitation codes for the private beta. A code looks like ABCD-EFGH-JKLM-NPQR (16 characters from an alphabet without look-alikes: about 80 bits). Only its SHA-256 is stored.
// A code is claimed atomically (one UPDATE ... WHERE unused), so two people can never use the same one, and it is released again if the account could not be created after all.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashCode = (code: string) => createHash("sha256").update(normalise(code)).digest("hex");

export function generateInviteCode(): string {
  let raw = "";
  for (let i = 0; i < 16; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join("-");
}

export async function createInvite(opts: { email?: string | null; note?: string; hours: number; createdBy: string | null }): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + opts.hours * 3600_000);
  const r = await query<{ id: string }>(
    "INSERT INTO invites (code_hash, email, note, created_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [hashCode(code), opts.email ? opts.email.trim().toLowerCase() : null, (opts.note ?? "").slice(0, 200), opts.createdBy, expiresAt]
  );
  return { id: r.rows[0].id, code, expiresAt };
}

export type ClaimResult = { ok: true; inviteId: string } | { ok: false };

/** Uses up a code for this email, or says no (unknown, expired, already used, revoked, or tied to another address). The reason is never told to the caller. */
export async function claimInvite(code: unknown, email: string): Promise<ClaimResult> {
  if (typeof code !== "string" || normalise(code).length !== 16) return { ok: false };
  const r = await query<{ id: string }>(
    `UPDATE invites SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND (email IS NULL OR email = $2)
     RETURNING id`,
    [hashCode(code), email.trim().toLowerCase()]
  );
  return r.rows[0] ? { ok: true, inviteId: r.rows[0].id } : { ok: false };
}

export async function releaseInvite(inviteId: string): Promise<void> {
  await query("UPDATE invites SET used_at = NULL, used_by = NULL WHERE id = $1 AND used_by IS NULL", [inviteId]);
}
export async function markInviteUsedBy(inviteId: string, userId: string): Promise<void> {
  await query("UPDATE invites SET used_by = $1 WHERE id = $2", [userId, inviteId]);
}
