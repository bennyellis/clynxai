import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { aiAllowed, planLimitReply, recordAiUsage, type AiKind } from "../entitlements/enforce.js";
import { hit } from "../security/rateLimit.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// A shared reverse proxy to ONE OpenAI key that lives only on this server (the real key never reaches a client machine). It forwards what the desktop app sends, with these guards:
//   * only allow-listed models (a stolen or abused account cannot run an expensive model on this key),
//   * output-token and image-count ceilings, so one request cannot be made enormous,
//   * a per-user per-minute rate limit and (when entitlements are enforced) a daily quota by plan,
//   * every request is metered (user, kind, model, status, token counts - never prompt or response text),
//   * an upstream timeout, and retries with backoff for rate-limit and server errors on non-streaming calls.
// Streaming (chat with stream: true) is piped through untouched once the upstream answers.

const PER_MINUTE = 60;
const UPSTREAM_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

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

async function callUpstream(url: string, body: Body, stream: boolean): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.openaiApiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (stream || attempt === MAX_ATTEMPTS || (res.status !== 429 && res.status < 500)) return res;
      last = res;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
    }
    await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
  }
  return last as Response;
}

function refuse(reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error, ...extra });
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  async function guard(request: { userId?: string; body: unknown }, reply: FastifyReply, kind: AiKind): Promise<Body | null> {
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
    const rl = await hit(`ai:${request.userId}`, PER_MINUTE, 60);
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSec));
      refuse(reply, 429, "rate_limited", { retryAfterSec: rl.retryAfterSec });
      return null;
    }
    const allowed = await aiAllowed(request.userId as string, kind);
    if (!allowed.ok) {
      if (allowed.reason === "ai_disabled") planLimitReply(reply, allowed.plan, "aiResearchEnabled");
      else refuse(reply, 429, "ai_daily_limit", { plan: allowed.plan, limit: allowed.limit, used: allowed.used, message: "You have reached today's AI limit for your plan." });
      return null;
    }
    return body as Body;
  }

  app.post("/ai/chat/completions", async (request, reply) => {
    const body = await guard(request, reply, "chat");
    if (!body) return reply;
    const clamped = clampChatBody(body, config.aiMaxOutputTokens);
    const streaming = clamped.stream === true;
    let upstream: Response;
    try {
      upstream = await callUpstream(OPENAI_CHAT_URL, clamped, streaming);
    } catch {
      await recordAiUsage(request.userId as string, { kind: "chat", model: String(clamped.model), status: 504 });
      return refuse(reply, 504, "upstream_unavailable");
    }
    if (streaming && upstream.body) {
      await recordAiUsage(request.userId as string, { kind: "chat", model: String(clamped.model), status: upstream.status });
      reply.code(upstream.status).header("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
      return reply.send(Readable.fromWeb(upstream.body as never));
    }
    const data = (await upstream.json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    await recordAiUsage(request.userId as string, { kind: "chat", model: String(clamped.model), status: upstream.status, promptTokens: data?.usage?.prompt_tokens, completionTokens: data?.usage?.completion_tokens });
    return reply.code(upstream.status).send(data ?? { error: "Upstream OpenAI request failed" });
  });

  app.post("/ai/images/generations", async (request, reply) => {
    const body = await guard(request, reply, "image");
    if (!body) return reply;
    const clamped = clampImageBody(body);
    let upstream: Response;
    try {
      upstream = await callUpstream(OPENAI_IMAGES_URL, clamped, false);
    } catch {
      await recordAiUsage(request.userId as string, { kind: "image", model: String(clamped.model), status: 504 });
      return refuse(reply, 504, "upstream_unavailable");
    }
    const data = await upstream.json().catch(() => null);
    await recordAiUsage(request.userId as string, { kind: "image", model: String(clamped.model), status: upstream.status });
    return reply.code(upstream.status).send(data ?? { error: "Upstream OpenAI request failed" });
  });
}
