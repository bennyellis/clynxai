import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { aiAllowed, planLimitReply, type AiKind } from "../entitlements/enforce.js";
import { getOpenAICredentials, recordVerification } from "../integrations/credentials.js";
import { type Authorization, authorizePaidSpend, costUsd, estimatePromptTokens, imageCostUsd, noteRefusal } from "../integrations/controls.js";
import { outboundFetch } from "../integrations/http.js";
import { VaultError } from "../integrations/vault.js";
import { query } from "../db/client.js";
import { hit } from "../security/rateLimit.js";
import { buildSearchRequest, cleanSearchQuery, parseSearchResponse } from "./search.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

// The shared, company-managed OpenAI integration. Customers never hold or see a key: the key is the Owner's, stored encrypted on this server (see ../integrations), and every request is
// attributed to the customer who made it. Before a request leaves the server it must pass:
//   * allow-listed models only, output-token and image-count ceilings (nobody can ask for an enormous request),
//   * a per-customer per-minute rate limit and, when plan limits are enforced, the plan's daily request quota,
//   * the cost controls (../integrations/controls.ts): emergency switch, global and per-customer spending ceilings with a worst-case RESERVATION, concurrency limits, abuse blocks.
// Every call is metered (customer, kind, model, status, tokens, estimated cost - never prompt or response text). Streaming chat is piped through once the provider answers.

const PER_MINUTE = 60;
const UPSTREAM_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_OUTPUT_ESTIMATE = 8000;

type Body = Record<string, unknown>;

export function clampChatBody(body: Body, maxOutput: number): Body {
  const out: Body = { ...body };
  for (const k of ["max_tokens", "max_completion_tokens"]) {
    const v = out[k];
    if (typeof v === "number" && v > maxOutput) out[k] = maxOutput;
  }
  if (typeof out.n === "number" && out.n > 1) out.n = 1;
  return out;
}
export function clampImageBody(body: Body): Body {
  const out: Body = { ...body };
  if (typeof out.n === "number" && out.n > 2) out.n = 2;
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callUpstream(url: string, body: Body, stream: boolean, apiKey: string): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await outboundFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (stream || attempt === MAX_ATTEMPTS || (res.status !== 429 && res.status < 500)) return res;
      last = res;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
    }
    await sleep(Number(process.env.AI_RETRY_BASE_MS ?? 500) * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
  }
  return last as Response;
}

function refuse(reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error, ...extra });
}

async function recordUsage(userId: string, row: { kind: AiKind; model: string | null; status: number; promptTokens?: number | null; completionTokens?: number | null; costUsd: number }): Promise<void> {
  await query("INSERT INTO ai_usage (user_id, kind, model, status, prompt_tokens, completion_tokens, cost_usd_est) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    userId, row.kind, row.model, row.status, row.promptTokens ?? null, row.completionTokens ?? null, row.costUsd,
  ]).catch(() => undefined);
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  /** Everything a request must pass BEFORE it may leave this server. On success the caller owns the reservation and must finish() it. */
  async function guard(request: { userId?: string; body: unknown }, reply: FastifyReply, kind: AiKind): Promise<{ body: Body; auth: Authorization; reserveUsd: number } | null> {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      refuse(reply, 400, "Invalid request body");
      return null;
    }
    const model = (body as Body).model;
    if (typeof model !== "string" || !config.aiAllowedModels.includes(model)) {
      refuse(reply, 400, "model_not_allowed", { message: "That model is not available through Clynx." });
      return null;
    }
    const userId = request.userId as string;
    const rl = await hit(`ai:${userId}`, PER_MINUTE, 60);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      await noteRefusal(userId);
      refuse(reply, 429, "rate_limited", { retryAfterSec: rl.retryAfterSec });
      return null;
    }
    const allowed = await aiAllowed(userId, kind);
    if (!allowed.ok) {
      if (allowed.reason === "ai_disabled") planLimitReply(reply, allowed.plan, "aiResearchEnabled");
      else refuse(reply, 429, "ai_daily_limit", { plan: allowed.plan, limit: allowed.limit, used: allowed.used, message: "You have reached today's AI limit for your plan." });
      return null;
    }
    // worst case for this request: the whole prompt plus the largest answer it may ask for
    let reserveUsd: number;
    if (kind === "image") reserveUsd = imageCostUsd(typeof (body as Body).n === "number" ? Math.min(2, (body as Body).n as number) : 1);
    else {
      const clamped = clampChatBody(body as Body, config.aiMaxOutputTokens);
      const maxOut = Math.min(config.aiMaxOutputTokens, (typeof clamped.max_completion_tokens === "number" ? clamped.max_completion_tokens : typeof clamped.max_tokens === "number" ? clamped.max_tokens : DEFAULT_OUTPUT_ESTIMATE) as number);
      reserveUsd = costUsd(model, estimatePromptTokens(clamped), maxOut);
      // a web search also carries the provider's per-search fee: it is reserved up front
      if (kind === "search") reserveUsd += config.aiSearchFeeUsd;
    }
    const auth = await authorizePaidSpend(userId, reserveUsd);
    if (!auth.ok) {
      if (auth.retryAfterSec) reply.header("Retry-After", String(auth.retryAfterSec));
      refuse(reply, auth.status, auth.error, { message: auth.message, retryAfterSec: auth.retryAfterSec });
      return null;
    }
    return { body: body as Body, auth, reserveUsd };
  }

  /** The key to use, or an answer to send instead (and the reservation released). */
  async function keyFor(reply: FastifyReply, auth: Authorization): Promise<string | null> {
    try {
      const c = await getOpenAICredentials();
      if (c) return c.creds.apiKey;
      await auth.finish(0);
      refuse(reply, 503, "ai_not_configured", { message: "AI features are not set up on this server yet." });
      return null;
    } catch (err) {
      await auth.finish(0);
      app.log.error({ err: err instanceof VaultError ? err.code : "unreadable" }, "the stored OpenAI credential could not be read");
      refuse(reply, 503, "ai_unavailable", { message: "AI features are temporarily unavailable." });
      return null;
    }
  }

  /** What to tell a customer about an upstream failure. A provider's own account problems (a rejected key, no credit) are the company's to fix, not the customer's, and are not forwarded. */
  async function translateUpstream(status: number, data: unknown): Promise<{ status: number; body: unknown } | null> {
    const err = (data as { error?: { code?: string; type?: string } } | null)?.error;
    if (status === 401 || status === 403) {
      await recordVerification("openai", false, "OpenAI rejected the key while serving a customer request.", null).catch(() => undefined);
      return { status: 503, body: { error: "provider_unavailable", message: "AI features are temporarily unavailable." } };
    }
    if (status === 429 && (err?.code === "insufficient_quota" || err?.type === "insufficient_quota")) {
      await recordVerification("openai", false, "The OpenAI account has no remaining credit.", null).catch(() => undefined);
      return { status: 503, body: { error: "provider_unavailable", message: "AI features are temporarily unavailable." } };
    }
    return null;
  }

  app.post("/ai/chat/completions", async (request, reply) => {
    const g = await guard(request, reply, "chat");
    if (!g) return reply;
    const userId = request.userId as string;
    const apiKey = await keyFor(reply, g.auth);
    if (!apiKey) return reply;
    const clamped = clampChatBody(g.body, config.aiMaxOutputTokens);
    const streaming = clamped.stream === true;
    const model = String(clamped.model);
    let upstream: Response;
    try {
      upstream = await callUpstream(OPENAI_CHAT_URL, clamped, streaming, apiKey);
    } catch {
      await recordUsage(userId, { kind: "chat", model, status: 504, costUsd: 0 });
      await g.auth.finish(0);
      return refuse(reply, 504, "upstream_unavailable");
    }
    if (streaming && upstream.body && upstream.ok) {
      // the cost of a stream is not known until it ends, so the reserved worst case is what is recorded (conservative)
      await recordUsage(userId, { kind: "chat", model, status: upstream.status, costUsd: g.reserveUsd });
      const node = Readable.fromWeb(upstream.body as never);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        void g.auth.finish(null);
      };
      node.on("end", settle).on("close", settle).on("error", settle);
      reply.code(upstream.status).header("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
      return reply.send(node);
    }
    const data = (await upstream.json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    const pt = data?.usage?.prompt_tokens ?? null;
    const ct = data?.usage?.completion_tokens ?? null;
    const cost = upstream.ok ? (pt !== null && ct !== null ? costUsd(model, pt, ct) : g.reserveUsd) : 0;
    await recordUsage(userId, { kind: "chat", model, status: upstream.status, promptTokens: pt, completionTokens: ct, costUsd: cost });
    await g.auth.finish(cost);
    const translated = upstream.ok ? null : await translateUpstream(upstream.status, data);
    if (translated) return reply.code(translated.status).send(translated.body);
    return reply.code(upstream.status).send(data ?? { error: "Upstream OpenAI request failed" });
  });

  // Web search for product research. The app sends only a phrase; the provider request is built here (search.ts), so nothing else can be run on the company's key. Off until the
  // Owner sets AI_SEARCH_ENABLED=true. Counted as one AI request against the plan's daily allowance, reserved and recorded with the per-search fee, metered like everything else.
  app.post("/ai/search", async (request, reply) => {
    if (!config.aiSearchEnabled) return refuse(reply, 503, "search_not_enabled", { message: "Web search through Clynx is not switched on for this server." });
    const raw = request.body as { query?: unknown } | null;
    const phrase = cleanSearchQuery(raw && typeof raw === "object" ? raw.query : null);
    if (!phrase) return refuse(reply, 400, "invalid_query", { message: "A search phrase of 3 to 300 characters is required." });
    const model = config.aiSearchModel;
    // the same gate every AI request passes: allowed model, rate limit, plan quota, spending reservation, concurrency
    const g = await guard({ userId: request.userId, body: { model, messages: [{ role: "user", content: phrase }], max_completion_tokens: config.aiSearchMaxOutputTokens } }, reply, "search");
    if (!g) return reply;
    const userId = request.userId as string;
    const apiKey = await keyFor(reply, g.auth);
    if (!apiKey) return reply;
    let upstream: Response;
    try {
      upstream = await callUpstream(OPENAI_RESPONSES_URL, buildSearchRequest(phrase, model, config.aiSearchMaxOutputTokens), false, apiKey);
    } catch {
      await recordUsage(userId, { kind: "search", model, status: 504, costUsd: 0 });
      await g.auth.finish(0);
      return refuse(reply, 504, "upstream_unavailable");
    }
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      await recordUsage(userId, { kind: "search", model, status: upstream.status, costUsd: 0 });
      await g.auth.finish(0);
      const translated = await translateUpstream(upstream.status, data);
      if (translated) return reply.code(translated.status).send(translated.body);
      return refuse(reply, upstream.status === 429 ? 429 : 502, upstream.status === 429 ? "rate_limited" : "upstream_failed");
    }
    const parsed = parseSearchResponse(data);
    const cost = (parsed.inputTokens !== null && parsed.outputTokens !== null ? costUsd(model, parsed.inputTokens, parsed.outputTokens) : 0) + config.aiSearchFeeUsd;
    await recordUsage(userId, { kind: "search", model, status: 200, promptTokens: parsed.inputTokens, completionTokens: parsed.outputTokens, costUsd: cost });
    await g.auth.finish(cost);
    return reply.code(200).send({ answer: parsed.answer, citations: parsed.citations });
  });

  app.post("/ai/images/generations", async (request, reply) => {
    const g = await guard(request, reply, "image");
    if (!g) return reply;
    const userId = request.userId as string;
    const apiKey = await keyFor(reply, g.auth);
    if (!apiKey) return reply;
    const clamped = clampImageBody(g.body);
    const model = String(clamped.model);
    let upstream: Response;
    try {
      upstream = await callUpstream(OPENAI_IMAGES_URL, clamped, false, apiKey);
    } catch {
      await recordUsage(userId, { kind: "image", model, status: 504, costUsd: 0 });
      await g.auth.finish(0);
      return refuse(reply, 504, "upstream_unavailable");
    }
    const data = await upstream.json().catch(() => null);
    const cost = upstream.ok ? g.reserveUsd : 0;
    await recordUsage(userId, { kind: "image", model, status: upstream.status, costUsd: cost });
    await g.auth.finish(cost);
    const translated = upstream.ok ? null : await translateUpstream(upstream.status, data);
    if (translated) return reply.code(translated.status).send(translated.body);
    return reply.code(upstream.status).send(data ?? { error: "Upstream OpenAI request failed" });
  });
}
