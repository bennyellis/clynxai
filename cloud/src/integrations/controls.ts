import { query } from "../db/client.js";
import { effectivePlanFor } from "../entitlements/enforce.js";
import { redisConnection } from "../queue/connection.js";
import { hit } from "../security/rateLimit.js";

// Cost and safety controls for every PAID provider operation (OpenAI, eBay). They apply to everybody - customers and the Owner alike; the Owner's missing PLAN limits do not remove them:
//   * the emergency switch (stops every paid operation at once),
//   * a global daily and monthly spending ceiling, so the shared budget cannot be exhausted by the crowd,
//   * a per-customer daily ceiling (by plan; the Owner has a high but finite one), so no one customer can exhaust it,
//   * a worst-case reservation made BEFORE the call and settled after it, so parallel requests cannot all pass the check and overshoot together,
//   * concurrency limits per customer and overall,
//   * abuse detection that flags and temporarily blocks a customer whose traffic looks runaway or hostile.
// Costs are ESTIMATES (token counts times a price table), attributed to the customer who made the request. They are not an invoice.

export interface Controls {
  paidApiEnabled: boolean;
  disabledReason: string | null;
  disabledAt: Date | null;
  globalDailyUsd: number;
  globalMonthlyUsd: number;
  userDailyUsdFree: number;
  userDailyUsdPro: number;
  ownerDailyUsd: number;
  maxConcurrentUser: number;
  maxConcurrentGlobal: number;
  ebayDailyCallsGlobal: number;
  ebayDailyCallsFree: number;
  ebayDailyCallsPro: number;
  ebayDailyCallsOwner: number;
  abuseRequestsPer10Min: number;
  abuseRefusalsPer10Min: number;
  abuseBlockMinutes: number;
}

interface ControlRow {
  paid_api_enabled: boolean; disabled_reason: string | null; disabled_at: Date | null;
  global_daily_usd: string; global_monthly_usd: string; user_daily_usd_free: string; user_daily_usd_pro: string; owner_daily_usd: string;
  max_concurrent_user: number; max_concurrent_global: number; ebay_daily_calls_global: number; ebay_daily_calls_free: number; ebay_daily_calls_pro: number; ebay_daily_calls_owner: number;
  abuse_requests_per_10min: number; abuse_refusals_per_10min: number; abuse_block_minutes: number;
}

const FIELD_COLUMNS: Record<keyof Omit<Controls, "paidApiEnabled" | "disabledReason" | "disabledAt">, string> = {
  globalDailyUsd: "global_daily_usd", globalMonthlyUsd: "global_monthly_usd", userDailyUsdFree: "user_daily_usd_free", userDailyUsdPro: "user_daily_usd_pro", ownerDailyUsd: "owner_daily_usd",
  maxConcurrentUser: "max_concurrent_user", maxConcurrentGlobal: "max_concurrent_global", ebayDailyCallsGlobal: "ebay_daily_calls_global", ebayDailyCallsFree: "ebay_daily_calls_free",
  ebayDailyCallsPro: "ebay_daily_calls_pro", ebayDailyCallsOwner: "ebay_daily_calls_owner", abuseRequestsPer10Min: "abuse_requests_per_10min", abuseRefusalsPer10Min: "abuse_refusals_per_10min", abuseBlockMinutes: "abuse_block_minutes",
};
export const CONTROL_FIELDS = Object.keys(FIELD_COLUMNS) as Array<keyof typeof FIELD_COLUMNS>;

let cached: { at: number; value: Controls } | null = null;
export const invalidateControls = () => {
  cached = null;
};

export async function getControls(): Promise<Controls> {
  if (cached && Date.now() - cached.at < 3000) return cached.value;
  const r = await query<ControlRow>("SELECT * FROM api_controls WHERE id = 1");
  const x = r.rows[0];
  const value: Controls = {
    paidApiEnabled: x.paid_api_enabled, disabledReason: x.disabled_reason, disabledAt: x.disabled_at,
    globalDailyUsd: Number(x.global_daily_usd), globalMonthlyUsd: Number(x.global_monthly_usd), userDailyUsdFree: Number(x.user_daily_usd_free), userDailyUsdPro: Number(x.user_daily_usd_pro), ownerDailyUsd: Number(x.owner_daily_usd),
    maxConcurrentUser: x.max_concurrent_user, maxConcurrentGlobal: x.max_concurrent_global, ebayDailyCallsGlobal: x.ebay_daily_calls_global, ebayDailyCallsFree: x.ebay_daily_calls_free,
    ebayDailyCallsPro: x.ebay_daily_calls_pro, ebayDailyCallsOwner: x.ebay_daily_calls_owner, abuseRequestsPer10Min: x.abuse_requests_per_10min, abuseRefusalsPer10Min: x.abuse_refusals_per_10min, abuseBlockMinutes: x.abuse_block_minutes,
  };
  cached = { at: Date.now(), value };
  return value;
}

export async function updateControls(patch: Partial<Record<keyof typeof FIELD_COLUMNS, number>>, userId: string): Promise<Controls> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of CONTROL_FIELDS) {
    if (patch[k] === undefined) continue;
    vals.push(patch[k]);
    sets.push(`${FIELD_COLUMNS[k]} = $${vals.length}`);
  }
  if (sets.length) {
    vals.push(userId);
    await query(`UPDATE api_controls SET ${sets.join(", ")}, updated_at = now(), updated_by = $${vals.length} WHERE id = 1`, vals);
    invalidateControls();
  }
  return getControls();
}

export async function setEmergencyStop(stopped: boolean, reason: string | null, userId: string): Promise<Controls> {
  await query("UPDATE api_controls SET paid_api_enabled = $1, disabled_reason = $2, disabled_at = CASE WHEN $1 THEN NULL ELSE now() END, disabled_by = $3, updated_at = now() WHERE id = 1", [!stopped, stopped ? (reason ?? "emergency stop") : null, userId]);
  invalidateControls();
  return getControls();
}

export type Tier = "free" | "pro" | "owner";
export async function tierOf(userId: string): Promise<Tier> {
  const eff = await effectivePlanFor(userId);
  return eff?.owner ? "owner" : eff?.plan === "pro" ? "pro" : "free";
}
export const userDailyCapUsd = (c: Controls, t: Tier) => (t === "owner" ? c.ownerDailyUsd : t === "pro" ? c.userDailyUsdPro : c.userDailyUsdFree);
export const ebayDailyCap = (c: Controls, t: Tier) => (t === "owner" ? c.ebayDailyCallsOwner : t === "pro" ? c.ebayDailyCallsPro : c.ebayDailyCallsFree);

// ------------------------------------------------------------------ price estimates (USD per million tokens; images per image). ESTIMATES - override with AI_PRICES_JSON from the provider's own price list.
interface Price { in: number; out: number }
const DEFAULT_PRICES: Record<string, Price> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 }, "gpt-4o": { in: 2.5, out: 10 }, "gpt-4.1-mini": { in: 0.4, out: 1.6 }, "gpt-4.1": { in: 2, out: 8 }, "gpt-5-mini": { in: 0.25, out: 2 }, "gpt-5": { in: 1.25, out: 10 },
};
const UNKNOWN_MODEL: Price = { in: 5, out: 15 }; // conservative for anything not listed
const IMAGE_USD = 0.2; // conservative per generated image
let priceOverride: Record<string, Price> | null = null;
function prices(): Record<string, Price> {
  if (priceOverride) return priceOverride;
  try {
    priceOverride = process.env.AI_PRICES_JSON ? { ...DEFAULT_PRICES, ...(JSON.parse(process.env.AI_PRICES_JSON) as Record<string, Price>) } : DEFAULT_PRICES;
  } catch {
    priceOverride = DEFAULT_PRICES;
  }
  return priceOverride;
}
export const priceFor = (model: string): Price => prices()[model] ?? UNKNOWN_MODEL;
export const costUsd = (model: string, promptTokens: number, completionTokens: number) => (promptTokens * priceFor(model).in + completionTokens * priceFor(model).out) / 1_000_000;
export const imageCostUsd = (n: number) => IMAGE_USD * Math.max(1, n);

/** A rough, deliberately generous count of the tokens in a chat request (a picture counts as a flat 1500 rather than its base64 length). */
export function estimatePromptTokens(body: Record<string, unknown>): number {
  let chars = 0;
  let images = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image_url" || o.image_url) images++;
      else Object.values(o).forEach(walk);
    }
  };
  walk(body.messages ?? body.prompt ?? "");
  return Math.ceil(chars / 3) + images * 1500 + 50;
}

// ------------------------------------------------------------------ in-flight reservations and concurrency (shared through Redis; per-process memory if Redis is down)
const mem = new Map<string, number>();
async function addNumber(key: string, delta: number, ttlSec: number): Promise<number> {
  try {
    const v = Number(await redisConnection.incrbyfloat(key, delta));
    await redisConnection.expire(key, ttlSec);
    return v;
  } catch {
    const v = (mem.get(key) ?? 0) + delta;
    mem.set(key, v);
    return v;
  }
}
async function readNumber(key: string): Promise<number> {
  try {
    return Number((await redisConnection.get(key)) ?? 0);
  } catch {
    return mem.get(key) ?? 0;
  }
}
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const startOfDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export async function spentUsd(since: Date, userId?: string): Promise<number> {
  const r = await query<{ s: string }>(`SELECT coalesce(sum(cost_usd_est), 0)::text AS s FROM ai_usage WHERE created_at >= $1 ${userId ? "AND user_id = $2" : ""}`, userId ? [since, userId] : [since]);
  return Number(r.rows[0].s);
}

export type Refusal = { ok: false; status: number; error: string; message: string; retryAfterSec?: number };
export interface Authorization {
  ok: true;
  /** Settles the reservation: pass the actual estimated cost (or null to keep the reserved worst case). */
  finish(actualUsd: number | null): Promise<void>;
}

const refusal = (status: number, error: string, message: string, retryAfterSec?: number): Refusal => ({ ok: false, status, error, message, retryAfterSec });

/** Every check a paid AI call must pass, then a reservation of its worst-case cost. Call finish() when the call ends, whatever happened. */
export async function authorizePaidSpend(userId: string, reserveUsd: number): Promise<Authorization | Refusal> {
  const c = await getControls();
  if (!c.paidApiEnabled) return refusal(503, "paid_api_disabled", "AI features are paused for maintenance. Please try again later.");
  const block = await query<{ blocked_until: Date }>("SELECT blocked_until FROM api_user_blocks WHERE user_id = $1 AND blocked_until > now()", [userId]);
  if (block.rows[0]) {
    await noteRefusal(userId, c);
    return refusal(429, "temporarily_blocked", "Your AI access is paused for a while because of unusually heavy use. It resumes automatically.", Math.ceil((block.rows[0].blocked_until.getTime() - Date.now()) / 1000));
  }
  // burst detection counts every attempt
  const burst = await hit(`abuse:req:${userId}`, c.abuseRequestsPer10Min, 600);
  if (!burst.allowed) {
    await flagAndBlock(userId, "request_burst", `${burst.count} paid requests in 10 minutes`, c);
    return refusal(429, "temporarily_blocked", "Your AI access is paused for a while because of unusually heavy use. It resumes automatically.", c.abuseBlockMinutes * 60);
  }

  const tier = await tierOf(userId);
  const [userSpent, globalDay, globalMonth] = await Promise.all([spentUsd(startOfDay(), userId), spentUsd(startOfDay()), spentUsd(startOfMonth())]);
  // RESERVE FIRST. The add is atomic and returns the new in-flight total INCLUDING this request, so requests that arrive at the same instant cannot all pass the same check.
  const userResKey = `resv:user:${userId}:${day()}`;
  const globalResKey = `resv:global:${day()}`;
  const userReserved = await addNumber(userResKey, reserveUsd, 90_000);
  const globalReserved = await addNumber(globalResKey, reserveUsd, 90_000);
  const undoReservation = async () => {
    await addNumber(userResKey, -reserveUsd, 90_000);
    await addNumber(globalResKey, -reserveUsd, 90_000);
  };
  if (globalDay + globalReserved > c.globalDailyUsd || globalMonth + globalReserved > c.globalMonthlyUsd) {
    await undoReservation();
    await noteRefusal(userId, c);
    return refusal(503, "api_budget_exhausted", "AI features have reached today's shared limit. They return automatically; please try again later.");
  }
  const cap = userDailyCapUsd(c, tier);
  if (userSpent + userReserved > cap) {
    await undoReservation();
    await noteRefusal(userId, c);
    return refusal(429, "user_budget_exhausted", "You have used today's AI allowance for your account. It resets tomorrow.");
  }

  // concurrency: per customer and overall (also an atomic add-then-check)
  const userKey = `conc:user:${userId}`;
  const globalKey = "conc:global";
  const u = await addNumber(userKey, 1, 600);
  const g = await addNumber(globalKey, 1, 600);
  const free = async () => {
    await addNumber(userKey, -1, 600);
    await addNumber(globalKey, -1, 600);
  };
  if (u > c.maxConcurrentUser) {
    await free();
    await undoReservation();
    await noteRefusal(userId, c);
    return refusal(429, "concurrency_limit", "Too many AI requests are running at once for your account. Wait for one to finish.", 5);
  }
  if (g > c.maxConcurrentGlobal) {
    await free();
    await undoReservation();
    return refusal(503, "busy", "AI features are busy right now. Please try again in a moment.", 5);
  }
  let done = false;
  return {
    ok: true,
    async finish() {
      if (done) return;
      done = true;
      await undoReservation();
      await free();
    },
  };
}

// ------------------------------------------------------------------ abuse
export async function flagAndBlock(userId: string, reason: string, detail: string, c?: Controls): Promise<void> {
  const ctl = c ?? (await getControls());
  const open = await query("SELECT 1 FROM api_abuse_flags WHERE user_id = $1 AND reason = $2 AND cleared_at IS NULL AND created_at > now() - make_interval(mins => $3)", [userId, reason, ctl.abuseBlockMinutes]);
  if (!open.rows.length) await query("INSERT INTO api_abuse_flags (user_id, reason, detail) VALUES ($1, $2, $3)", [userId, reason, detail.slice(0, 300)]);
  await query(
    `INSERT INTO api_user_blocks (user_id, blocked_until, reason) VALUES ($1, now() + make_interval(mins => $2), $3)
     ON CONFLICT (user_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason`,
    [userId, ctl.abuseBlockMinutes, reason]
  );
}

/** Counts a refused paid request; a customer who keeps hammering a limit is blocked for a while. */
export async function noteRefusal(userId: string, c?: Controls): Promise<void> {
  const ctl = c ?? (await getControls());
  const r = await hit(`abuse:ref:${userId}`, ctl.abuseRefusalsPer10Min, 600);
  if (!r.allowed) await flagAndBlock(userId, "repeated_refusals", `${r.count} refused paid requests in 10 minutes`, ctl);
}

export async function clearAbuse(userId: string, byUser: string): Promise<void> {
  await query("DELETE FROM api_user_blocks WHERE user_id = $1", [userId]);
  await query("UPDATE api_abuse_flags SET cleared_at = now(), cleared_by = $2 WHERE user_id = $1 AND cleared_at IS NULL", [userId, byUser]);
  for (const k of [`rl:abuse:req:${userId}`, `rl:abuse:ref:${userId}`]) await redisConnection.del(k).catch(() => undefined);
}

// ------------------------------------------------------------------ eBay call accounting
export async function authorizeEbayCall(userId: string): Promise<{ ok: true } | Refusal> {
  const c = await getControls();
  if (!c.paidApiEnabled) return refusal(503, "paid_api_disabled", "eBay features are paused for maintenance. Please try again later.");
  const block = await query("SELECT 1 FROM api_user_blocks WHERE user_id = $1 AND blocked_until > now()", [userId]);
  if (block.rows.length) return refusal(429, "temporarily_blocked", "Your eBay access is paused for a while because of unusually heavy use.");
  const tier = await tierOf(userId);
  const since = startOfDay();
  const [g, u] = await Promise.all([
    query<{ n: number }>("SELECT count(*)::int AS n FROM ebay_usage WHERE created_at >= $1", [since]),
    query<{ n: number }>("SELECT count(*)::int AS n FROM ebay_usage WHERE created_at >= $1 AND user_id = $2", [since, userId]),
  ]);
  if (g.rows[0].n >= c.ebayDailyCallsGlobal) return refusal(503, "api_budget_exhausted", "eBay features have reached today's shared limit. Please try again tomorrow.");
  if (u.rows[0].n >= ebayDailyCap(c, tier)) {
    await noteRefusal(userId, c);
    return refusal(429, "user_budget_exhausted", "You have used today's eBay allowance for your account. It resets tomorrow.");
  }
  return { ok: true };
}
export async function recordEbayCall(userId: string, operation: string, status: number): Promise<void> {
  await query("INSERT INTO ebay_usage (user_id, operation, status) VALUES ($1, $2, $3)", [userId, operation, status]).catch(() => undefined);
}

