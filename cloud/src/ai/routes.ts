import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// Per explicit instruction — a single shared OpenAI key that lives ONLY on
// this server, so every authenticated desktop user's AI calls (chat,
// scoring, vision, product research, category thumbnails) use it without
// the real key ever reaching a client machine. A pure reverse proxy on
// purpose: forwards whatever body the client sends verbatim to the real
// OpenAI endpoint and returns OpenAI's response untouched (including raw
// SSE streaming for chat completions, since the Dashboard assistant
// streams live — see src/main/chat.ts's streamOnce). No per-model or
// per-request special-casing here, so a NEW desktop call site added later
// works through this automatically, with zero server change.
//
// Known, accepted gap for now (flagged, not enforced) — no per-user usage
// cap/rate limiting: every authenticated user's usage bills to this one
// OpenAI account with no ceiling. Entitlements exist (see
// ../entitlements/plans.ts) but aren't wired in here yet.
export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/ai/chat/completions", async (request, reply) => {
    const upstream = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify(request.body),
    });

    // A streaming request (src/main/chat.ts's streamOnce sets stream: true)
    // needs its raw SSE bytes piped through as they arrive, not buffered
    // into one JSON blob — the client's own decoder reads this incrementally.
    // A non-streaming request (every other desktop AI call site) just wants
    // the parsed JSON body back, same as calling OpenAI directly would give.
    const isStreamingRequest = (request.body as { stream?: boolean } | null)?.stream === true;

    if (isStreamingRequest && upstream.body) {
      reply.raw.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      });
      return reply.send(Readable.fromWeb(upstream.body));
    }

    const data = await upstream.json().catch(() => null);
    return reply.code(upstream.status).send(data ?? { error: "Upstream OpenAI request failed" });
  });

  app.post("/ai/images/generations", async (request, reply) => {
    const upstream = await fetch(OPENAI_IMAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify(request.body),
    });

    const data = await upstream.json().catch(() => null);
    return reply.code(upstream.status).send(data ?? { error: "Upstream OpenAI request failed" });
  });
}
