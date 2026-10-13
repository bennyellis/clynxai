import type { FastifyReply } from "fastify";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { resolveSubscription, type Resolution, type SubscriptionState } from "../billing/plan.js";
import { getEntitlementsForPlan, higherPlan, isPlan, type Entitlements, type Plan } from "./plans.js";

export interface EffectivePlan {
  plan: Plan;
  /** The plan stored on the user (set by an operator; every account starts on "free"). */
  basePlan: Plan;
  subscription: Resolution & { status: string | null; currentPeriodEnd: Date | null; trialEnd: Date | null; cancelAtPeriodEnd: boolean; hasCustomer: boolean };
  entitlements: Entitlements;
}

/** The plan a user gets right now: the better of their stored base plan and what their subscription entitles them to at this moment. */
export async function effectivePlanFor(userId: string, now: Date = new Date()): Promise<EffectivePlan | null> {
  const u = await query<{ plan: string }>("SELECT plan FROM users WHERE id = $1", [userId]);
  if (!u.rows[0]) return null;
  const basePlan: Plan = isPlan(u.rows[0].plan) ? u.rows[0].plan : "free";
  const s = await query<SubscriptionState & { provider_customer_id: string | null }>("SELECT * FROM subscriptions WHERE user_id = $1", [userId]);
  const row = s.rows[0] ?? null;
  const res = resolveSubscription(row, now, config.billing.pastDueGraceDays);
  const plan = higherPlan(basePlan, res.plan);
  return {
    plan,
    basePlan,
    subscription: { ...res, status: row?.status ?? null, currentPeriodEnd: row?.current_period_end ?? null, trialEnd: row?.trial_end ?? null, cancelAtPeriodEnd: row?.cancel_at_period_end ?? false, hasCustomer: !!row?.provider_customer_id },
    entitlements: getEntitlementsForPlan(plan),
  };
}

export type LimitKey = "maxWatches" | "maxDevices";

/** Sends the standard "your plan does not allow this" answer. */
export function planLimitReply(reply: FastifyReply, plan: Plan, limit: string, detail: Record<string, unknown> = {}) {
  return reply.code(402).send({ error: "plan_limit", limit, plan, message: "Your plan does not allow this. Upgrade to continue.", ...detail });
}

/** True when the user may add one more of this resource. Always true when entitlements are not being enforced (staged activation). */
export async function withinCountLimit(userId: string, key: LimitKey, currentCount: number): Promise<{ ok: true } | { ok: false; plan: Plan; limit: number }> {
  if (!config.enforceEntitlements) return { ok: true };
  const eff = await effectivePlanFor(userId);
  if (!eff) return { ok: true };
  const limit = eff.entitlements[key];
  if (limit === null || currentCount < limit) return { ok: true };
  return { ok: false, plan: eff.plan, limit };
}

export type AiKind = "chat" | "image";

export interface AiUsageToday {
  requests: number;
  images: number;
}

/** AI requests recorded for this UTC day. */
export async function aiUsageToday(userId: string, now: Date = new Date()): Promise<AiUsageToday> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const r = await query<{ kind: string; n: string }>("SELECT kind, count(*)::text AS n FROM ai_usage WHERE user_id = $1 AND created_at >= $2 GROUP BY kind", [userId, start]);
  const get = (k: string) => Number(r.rows.find((x) => x.kind === k)?.n ?? 0);
  return { requests: get("chat"), images: get("image") };
}

/** Whether this user may make another AI request of this kind today. Metering is always on; the limit applies only when entitlements are enforced. */
export async function aiAllowed(userId: string, kind: AiKind): Promise<{ ok: true; usage: AiUsageToday } | { ok: false; reason: "ai_disabled" | "daily_limit"; plan: Plan; limit: number | null; used: number }> {
  const usage = await aiUsageToday(userId);
  if (!config.enforceEntitlements) return { ok: true, usage };
  const eff = await effectivePlanFor(userId);
  if (!eff) return { ok: true, usage };
  if (!eff.entitlements.aiResearchEnabled) return { ok: false, reason: "ai_disabled", plan: eff.plan, limit: 0, used: 0 };
  const limit = kind === "image" ? eff.entitlements.aiImagesPerDay : eff.entitlements.aiRequestsPerDay;
  const used = kind === "image" ? usage.images : usage.requests;
  if (limit !== null && used >= limit) return { ok: false, reason: "daily_limit", plan: eff.plan, limit, used };
  return { ok: true, usage };
}

export async function recordAiUsage(userId: string, row: { kind: AiKind; model: string | null; status: number; promptTokens?: number | null; completionTokens?: number | null }): Promise<void> {
  await query("INSERT INTO ai_usage (user_id, kind, model, status, prompt_tokens, completion_tokens) VALUES ($1, $2, $3, $4, $5, $6)", [
    userId, row.kind, row.model, row.status, row.promptTokens ?? null, row.completionTokens ?? null,
  ]).catch(() => undefined);
}
