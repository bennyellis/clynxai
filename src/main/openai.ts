import type { CloudClient } from "./cloudClient.js";

// Single paid provider for everything this app's AI touches — chat/tool-
// calling, scoring, narration, product research, and vision/photo
// analysis. Replaces the earlier free-tier Groq (chat/scoring) + Gemini
// (vision + overflow fallback) setup entirely, per explicit instruction
// once real OpenAI credits were purchased: no more dual-provider fallback
// chain or multi-Groq-key rotation, since those existed specifically to
// route around scarce free-tier quotas that a paid account doesn't have.
//
// gpt-5-mini is a reasoning model — verified live it silently burns its
// entire completion-token budget on invisible reasoning tokens (empty
// content, finish_reason "length") unless reasoning_effort is turned down;
// "minimal" fixed it in every case tested (plain text, JSON extraction,
// vision), same lesson learned twice already this project with Gemini's
// thinkingConfig. Every OpenAI call in this app sets it for that reason —
// don't drop it without re-verifying.
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
// Per explicit instruction ("for the ai image generation just use the
// chatgpt api") — OpenAI's own image generation endpoint (gpt-image-1),
// used for Library's home-screen category thumbnails (see webResearch.ts's
// generateCategoryImage). Separate constant/model from the chat endpoint
// above since it's a genuinely different API shape (prompt in, base64 image
// out — no messages array, no reasoning_effort).
export const OPENAI_IMAGE_MODEL = "gpt-image-1";

const REAL_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const REAL_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// Clynx Cloud — shared-key migration. Set once from index.ts at startup
// (see initOpenAIProxy), right after the real CloudClient instance is
// constructed there. Passed in rather than imported directly: index.ts is
// where that instance lives, and importing it here would create a cycle
// back through index.ts (which itself pulls in chat.ts/vision.ts/etc.,
// which import THIS file) — same reasoning watchSync.ts's own constructor
// param already follows, just done via a setter instead of a class
// constructor since every function below is a plain module-level export,
// not a class instance every call site would otherwise need to thread
// through.
let cloudClientRef: CloudClient | null = null;
export function initOpenAIProxy(client: CloudClient): void {
  cloudClientRef = client;
}

function localApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

// True when SOME path to OpenAI exists right now — a locally-configured key
// (existing Config-driven flow, still fully supported and always preferred
// when present) or an authenticated Clynx Cloud session to proxy through.
// Config.tsx's env:hasOpenAIKey / a couple of feature gates use this
// instead of hasLocalKeyOnly, so a freshly-registered cloud user with no
// local key sees AI features as available too, not gated behind a key they
// were never meant to need.
export function hasOpenAIAccess(): boolean {
  return !!localApiKey() || !!cloudClientRef?.isAuthenticated();
}

// Same early fail-fast shape getOpenAIApiKey() used to provide (call sites
// still do `try { ensureOpenAIAccess(); } catch (err) { return
// errorResult(err.message); }` before doing any expensive work like
// downloading photos) — but doesn't hand back a key/token, since callOpenAI
// below resolves whichever one is current itself, at the moment it's
// actually needed.
export function ensureOpenAIAccess(): void {
  if (!hasOpenAIAccess()) {
    throw new Error("No OpenAI access configured — set an API key in Config, or log into Clynx Cloud.");
  }
}

// Per explicit instruction — every OpenAI call in this app goes through
// this instead of a raw fetch(OPENAI_URL, ...): a locally-configured
// OPENAI_API_KEY (existing Config-driven flow) is used exactly as before,
// straight against the real OpenAI endpoint — unchanged for anyone who's
// already set one up. With no local key, this instead proxies through
// Clynx Cloud's own /ai/* routes (cloud/src/ai/routes.ts) using the
// current cloud session, so the real key never has to live on this
// machine. Every call site's own request-building (model, messages, stream
// flag, ...) is unchanged — only where the bytes actually go changes,
// transparently. Returns a Response exactly like a direct fetch() would
// (so !res.ok / res.json() / a streamed res.body all keep working
// unmodified at every call site), or throws with a clear message when
// neither path is available.
export async function callOpenAI(kind: "chat" | "images", body: unknown, signal?: AbortSignal): Promise<Response> {
  const localKey = localApiKey();
  if (localKey) {
    const url = kind === "chat" ? REAL_CHAT_URL : REAL_IMAGES_URL;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${localKey}` },
      body: JSON.stringify(body),
      signal,
    });
  }
  if (!cloudClientRef) {
    throw new Error("OPENAI_API_KEY is not set, and no cloud session is available yet.");
  }
  const result = await cloudClientRef.openAIRequest(kind, body, signal);
  if (!result.ok) throw new Error(result.error);
  return result.response;
}
