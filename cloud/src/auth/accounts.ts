import { z } from "zod";
import { query } from "../db/client.js";
import { emails, queueEmail } from "../mail/mailer.js";
import { hit, peek, reset } from "../security/rateLimit.js";
import { createAuthToken, HOUR } from "./tokens.js";
import { hashPassword, verifyPassword } from "./service.js";

// Account creation and credential checking, shared by the desktop endpoints (/auth/*) and the website endpoints (/web/*) so both use one account system and one set of rules.

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(200);

// Limits (per client IP unless noted). The login limit counts FAILED attempts per IP + email, so a person who mistypes is not locked out by someone else's traffic and an attacker
// cannot guess passwords at speed. Registration limits protect against account farming (each account gets the free AI quota).
const LOGIN_FAILS = Number(process.env.RATE_LIMIT_LOGIN_FAILS ?? 8);
const LOGIN_WINDOW_SEC = 15 * 60;
const REGISTER_PER_HOUR = Number(process.env.RATE_LIMIT_REGISTER_PER_HOUR ?? 20);

export class AccountError extends Error {
  constructor(public status: number, public body: Record<string, unknown>, public retryAfterSec?: number) {
    super(String(body.error));
  }
}

export async function registerUser(email: string, password: string, ip: string, displayName?: string): Promise<string> {
  const rl = await hit(`register:${ip}`, REGISTER_PER_HOUR, 3600);
  if (!rl.allowed) throw new AccountError(429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec }, rl.retryAfterSec);
  const existing = await query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
  if (existing.rows.length > 0) throw new AccountError(409, { error: "An account with this email already exists" });
  const passwordHash = await hashPassword(password);
  const inserted = await query<{ id: string }>("INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id", [email, passwordHash, displayName?.trim() || null]);
  const userId = inserted.rows[0].id;
  await sendVerificationEmail(userId, email);
  return userId;
}

/** A new verification link (the older one stops working). Never throws: a mail problem must not break signing up. */
export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  try {
    const token = await createAuthToken(userId, "verify_email", 24 * HOUR);
    await queueEmail(emails.verify(email, token));
  } catch {
    /* recorded as failed in the outbox when delivery was attempted; the user can ask for another email */
  }
}

export interface LoginOk {
  id: string;
  email: string;
}

export async function checkLogin(email: string, password: string, ip: string): Promise<LoginOk> {
  const limitKey = `login:${ip}:${email}`;
  const blocked = await peek(limitKey, LOGIN_FAILS);
  if (blocked.blocked) throw new AccountError(429, { error: "too_many_attempts", retryAfterSec: blocked.retryAfterSec }, blocked.retryAfterSec);

  // Never leak whether the email exists: the same generic error either way.
  const generic = new AccountError(401, { error: "Invalid credentials" });
  const result = await query<{ id: string; email: string; password_hash: string; disabled_at: Date | null }>("SELECT id, email, password_hash, disabled_at FROM users WHERE lower(email) = $1", [email]);
  const user = result.rows[0];
  if (!user) {
    await hit(limitKey, LOGIN_FAILS, LOGIN_WINDOW_SEC);
    throw generic;
  }
  if (!(await verifyPassword(user.password_hash, password))) {
    await hit(limitKey, LOGIN_FAILS, LOGIN_WINDOW_SEC);
    throw generic;
  }
  await reset(limitKey);
  if (user.disabled_at) throw new AccountError(403, { error: "account_disabled", message: "This account has been disabled. Contact support." });
  return { id: user.id, email: user.email };
}
