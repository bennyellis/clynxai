import { randomBytes, createHash } from "node:crypto";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { query } from "../db/client.js";
import { config } from "../config.js";

const accessSecretKey = new TextEncoder().encode(config.jwtAccessSecret);

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface AccessTokenPayload {
  sub: string; // userId
}

export async function issueAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(accessSecretKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, accessSecretKey);
    if (!payload.sub) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

function hashRawToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

export interface IssuedRefreshToken {
  rawToken: string;
  id: string;
  expiresAt: Date;
}

// Stores only the SHA-256 hash of the token; the raw token is returned to
// the caller exactly once and never persisted or logged.
export async function issueRefreshToken(userId: string, deviceId: string | null): Promise<IssuedRefreshToken> {
  const rawToken = generateRawToken();
  const tokenHash = hashRawToken(rawToken);
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);

  const result = await query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, deviceId, tokenHash, expiresAt]
  );

  return { rawToken, id: result.rows[0].id, expiresAt };
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

export class RefreshTokenError extends Error {
  constructor(
    message: string,
    public code: "invalid" | "expired" | "reused"
  ) {
    super(message);
  }
}

// Revokes ALL of a user's refresh tokens — used when a previously-revoked
// (already-rotated-away) token is presented again, which signals the token
// may have been stolen and reused by an attacker.
async function revokeAllTokensForUser(userId: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashRawToken(rawToken);
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
}

// Rotates a refresh token: looks it up by hash, verifies not expired,
// atomically revokes the old one, and issues a fresh one. If the presented
// token was ALREADY revoked — whether by a genuine prior rotation/logout,
// or by a request that raced this one and won — this is treated as a
// compromise signal (any presentation of an already-consumed token is
// suspicious) and every refresh token for that user is revoked.
//
// The revoke step below is the fix for a rotation race: previously this
// checked `revoked_at` via a separate SELECT and then ran an unconditional
// UPDATE keyed only by id, so two concurrent rotations of the same token
// could both pass the check and both successfully revoke+reissue,
// silently bypassing reuse detection. Now the check-and-revoke is a single
// atomic UPDATE ... WHERE revoked_at IS NULL ... RETURNING: Postgres's
// row-level locking guarantees at most one concurrent UPDATE can affect
// the row (the loser blocks until the winner commits, then evaluates its
// WHERE clause against the now-revoked row and affects zero rows) — so
// exactly one caller ever proceeds to mint new tokens for a given token
// presentation, and the other deterministically lands in the reuse path.
export async function rotateRefreshToken(rawToken: string): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  const tokenHash = hashRawToken(rawToken);
  const lookup = await query<RefreshTokenRow>(
    `SELECT id, user_id, device_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash]
  );

  const row = lookup.rows[0];
  if (!row) {
    throw new RefreshTokenError("Refresh token not recognized", "invalid");
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new RefreshTokenError("Refresh token expired", "expired");
  }

  // a disabled account (or one whose device was removed: its tokens are gone) cannot keep a session alive
  const disabled = await query<{ disabled_at: Date | null }>("SELECT disabled_at FROM users WHERE id = $1", [row.user_id]);
  if (!disabled.rows[0] || disabled.rows[0].disabled_at) throw new RefreshTokenError("Account unavailable", "invalid");

  const revoked = await query<{ id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [row.id]
  );

  if ((revoked.rowCount ?? 0) === 0) {
    // Lost the race, or this token was already revoked at some earlier
    // point — either way, treat it as reuse and fail closed.
    await revokeAllTokensForUser(row.user_id);
    throw new RefreshTokenError("Refresh token reuse detected; all sessions revoked", "reused");
  }

  const issued = await issueRefreshToken(row.user_id, row.device_id);
  const accessToken = await issueAccessToken(row.user_id);

  return { userId: row.user_id, accessToken, refreshToken: issued.rawToken };
}
