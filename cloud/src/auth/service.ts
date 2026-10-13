import { randomBytes, createHash } from "node:crypto";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { getClient, query } from "../db/client.js";
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
export async function rotateRefreshToken(rawToken: string, claimedDeviceId?: string): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  const tokenHash = hashRawToken(rawToken);
  const lookup = await query<RefreshTokenRow & { disabled_at: Date | null }>(
    `SELECT t.id, t.user_id, t.device_id, t.expires_at, t.revoked_at, u.disabled_at FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
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
  if (row.disabled_at) throw new RefreshTokenError("Account unavailable", "invalid");

  // Revoke-and-reissue happens in ONE transaction that holds a per-user lock. Two requests presenting the same token are therefore strictly one after the other: the second one
  // always finds the token already used, and its revoke-all then also covers the token the first one just issued (it can never slip in between).
  const client = await getClient();
  let newRawToken = "";
  let reused = false;
  let deviceRemoved = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [row.user_id]);
    const revoked = await client.query<{ id: string }>(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [row.id]);
    if ((revoked.rowCount ?? 0) === 0) {
      // already consumed (an earlier rotation, a logout, or the request that just won): treat it as reuse and fail closed
      await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      reused = true;
    } else {
      // A sign-in is created before its device is registered, so its token starts without a device. The desktop says which device it is on every refresh: if that device still
      // exists the token is tied to it from now on (removing the device then ends the sign-in); if it was removed (revoked from the website) the sign-in ends here.
      let deviceId = row.device_id;
      if (!deviceId && claimedDeviceId) {
        const dev = await client.query(`SELECT 1 FROM devices WHERE id = $1 AND user_id = $2`, [claimedDeviceId, row.user_id]);
        if ((dev.rowCount ?? 0) === 0) deviceRemoved = true;
        else deviceId = claimedDeviceId;
      }
      if (!deviceRemoved) {
        newRawToken = generateRawToken();
        await client.query(`INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`, [
          row.user_id, deviceId, hashRawToken(newRawToken), new Date(Date.now() + config.refreshTokenTtlSeconds * 1000),
        ]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (reused) throw new RefreshTokenError("Refresh token reuse detected; all sessions revoked", "reused");
  if (deviceRemoved) throw new RefreshTokenError("This device was removed from the account", "invalid");

  const accessToken = await issueAccessToken(row.user_id);
  return { userId: row.user_id, accessToken, refreshToken: newRawToken };
}
