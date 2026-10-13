import { createHash, randomBytes } from "node:crypto";
import { query } from "../db/client.js";

// One-time tokens for email links (verify, reset, change address). Only a SHA-256 of the token is stored; a token works once and only before it expires.

export type TokenPurpose = "verify_email" | "reset_password" | "change_email";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function createAuthToken(userId: string, purpose: TokenPurpose, ttlMs: number, payload: string | null = null): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  // a newer token of the same kind replaces older unused ones, so only the latest email works
  await query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [userId, purpose]);
  await query("INSERT INTO auth_tokens (user_id, purpose, token_hash, payload, expires_at) VALUES ($1, $2, $3, $4, $5)", [userId, purpose, hash(raw), payload, new Date(Date.now() + ttlMs)]);
  return raw;
}

/** Atomically uses a token: returns who it belongs to, or null when it is unknown, expired, already used, or for another purpose. */
export async function consumeAuthToken(raw: string, purpose: TokenPurpose): Promise<{ userId: string; payload: string | null } | null> {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;
  const r = await query<{ user_id: string; payload: string | null }>(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id, payload`,
    [hash(raw), purpose]
  );
  return r.rows[0] ? { userId: r.rows[0].user_id, payload: r.rows[0].payload } : null;
}

export const HOUR = 3_600_000;
