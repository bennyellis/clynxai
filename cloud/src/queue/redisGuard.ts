import pkg from "ioredis";
import { config } from "../config.js";

const { Redis } = pkg;

// A SECOND Redis connection for everything a request waits on (rate limits, spending reservations, health checks). The queue's own connection must retry forever (BullMQ requires it), which
// is exactly what made a Redis outage freeze sign-in: a command on that connection never fails. This one gives up quickly instead (a command fails after 1.5 s, a few reconnect attempts per
// command), and a small "circuit breaker" remembers that Redis is down for a few seconds so the next requests skip it at once and use the in-process fallback the callers already have.
export const redisFast = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 1500,
  connectTimeout: 2000,
  retryStrategy: (times) => Math.min(times * 250, 3000),
});
redisFast.on("error", () => {
  /* the callers see the failure as a rejected command; an event listener keeps the process from reporting every reconnect attempt */
});

const BREAKER_MS = 5000;
let downUntil = 0;
export const redisAvailable = (): boolean => Date.now() >= downUntil;
export const noteRedisFailure = (): void => {
  downUntil = Date.now() + BREAKER_MS;
};
export const noteRedisOk = (): void => {
  downUntil = 0;
};

/** Runs a Redis command through the fast connection. Throws at once while the breaker is open or the command fails (the caller falls back to memory); a success closes the breaker. */
export async function viaRedis<T>(run: (r: typeof redisFast) => Promise<T>): Promise<T> {
  if (!redisAvailable()) throw new Error("redis is down (breaker open)");
  try {
    const v = await run(redisFast);
    noteRedisOk();
    return v;
  } catch (err) {
    noteRedisFailure();
    throw err;
  }
}

/** Waits at most `ms` for a promise (a queue operation that can hang when Redis is down); the late result or error is swallowed so it cannot become an unhandled rejection. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
