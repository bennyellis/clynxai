import { redisConnection } from "../queue/connection.js";

// Fixed-window rate limiter backed by Redis (shared by every API instance), with an in-process fallback if Redis is unreachable so a Redis outage degrades to per-process limits
// instead of removing protection (or taking login down).

export interface HitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSec: number;
}

const memory = new Map<string, { count: number; resetAt: number }>();

function memoryHit(key: string, limit: number, windowSec: number, now: number): HitResult {
  if (memory.size > 50_000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
  const cur = memory.get(key);
  if (!cur || cur.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { allowed: true, count: 1, limit, retryAfterSec: windowSec };
  }
  cur.count++;
  return { allowed: cur.count <= limit, count: cur.count, limit, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
}

/** Counts one event against `key`; `allowed` is false once the count in the current window exceeds `limit`. */
export async function hit(key: string, limit: number, windowSec: number, now: number = Date.now()): Promise<HitResult> {
  const k = `rl:${key}`;
  try {
    const count = await redisConnection.incr(k);
    if (count === 1) await redisConnection.expire(k, windowSec);
    const ttl = count === 1 ? windowSec : await redisConnection.ttl(k);
    return { allowed: count <= limit, count, limit, retryAfterSec: ttl > 0 ? ttl : windowSec };
  } catch {
    return memoryHit(k, limit, windowSec, now);
  }
}

/** Reads the count without counting (used to refuse a login attempt BEFORE spending the password hash on it). */
export async function peek(key: string, limit: number): Promise<{ blocked: boolean; retryAfterSec: number }> {
  const k = `rl:${key}`;
  try {
    const raw = await redisConnection.get(k);
    const count = raw ? Number(raw) : 0;
    if (count < limit) return { blocked: false, retryAfterSec: 0 };
    const ttl = await redisConnection.ttl(k);
    return { blocked: true, retryAfterSec: ttl > 0 ? ttl : 60 };
  } catch {
    const cur = memory.get(k);
    const now = Date.now();
    return cur && cur.resetAt > now && cur.count >= limit ? { blocked: true, retryAfterSec: Math.ceil((cur.resetAt - now) / 1000) } : { blocked: false, retryAfterSec: 0 };
  }
}

export async function reset(key: string): Promise<void> {
  memory.delete(`rl:${key}`);
  try {
    await redisConnection.del(`rl:${key}`);
  } catch {
    /* nothing to clear */
  }
}
