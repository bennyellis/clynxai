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
  return (!!localApiKey() || !!cloudClientRef?.isAuthenticated()) && !openAICreditsExhausted();
}

// OpenAI answers 429 "insufficient_quota" once the account's credits run out. Every AI feature would then fail one
// slow request at a time, so after the first such answer AI calls fail immediately for a few minutes (and features
// that have a free fallback, like finding photos for a Database entry, use it); then one request is allowed through to
// find out whether credits were added.
const CREDITS_RETRY_MS = 10 * 60_000;
let creditsExhaustedUntil = 0;
export function openAICreditsExhausted(): boolean {
  return Date.now() < creditsExhaustedUntil || Date.now() < planLimitUntil;
}

// Clynx Cloud answers 429 "ai_daily_limit" (or 402 "plan_limit") when the account's plan has used up today's AI allowance. Same fail-fast shape as above, with its own
// message: the fix is upgrading or waiting for tomorrow, not adding OpenAI credits.
const PLAN_LIMIT_RETRY_MS = 15 * 60_000;
let planLimitUntil = 0;
export const PLAN_LIMIT_MESSAGE = "Today's AI allowance for your Clynx plan is used up. It resets tomorrow, or upgrade in Config > Account.";

// Same early fail-fast shape getOpenAIApiKey() used to provide (call sites
// still do `try { ensureOpenAIAccess(); } catch (err) { return
// errorResult(err.message); }` before doing any expensive work like
// downloading photos) — but doesn't hand back a key/token, since callOpenAI
// below resolves whichever one is current itself, at the moment it's
// actually needed.
export function ensureOpenAIAccess(): void {
  if (Date.now() < planLimitUntil) throw new Error(PLAN_LIMIT_MESSAGE);
  if (openAICreditsExhausted()) {
    throw new Error("OpenAI credits are used up — add credits at platform.openai.com/settings/organization/billing (Clynx checks again every few minutes).");
  }
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
  if (!localApiKey() && Date.now() < planLimitUntil) throw new Error(PLAN_LIMIT_MESSAGE);
  if (Date.now() < creditsExhaustedUntil) {
    throw new Error("OpenAI credits are used up — add credits at platform.openai.com/settings/organization/billing.");
  }
  const localKey = localApiKey();
  if (localKey) {
    const url = kind === "chat" ? REAL_CHAT_URL : REAL_IMAGES_URL;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${localKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 429) {
      const text = await res
        .clone()
        .text()
        .catch(() => "");
      if (/insufficient_quota|credit_balance_exhausted/i.test(text)) {
        creditsExhaustedUntil = Date.now() + CREDITS_RETRY_MS;
        console.error("[openai] credits are used up: AI features pause for a few minutes (photo search keeps working without AI).");
      }
    }
    return res;
  }
  if (!cloudClientRef) {
    throw new Error("OPENAI_API_KEY is not set, and no cloud session is available yet.");
  }
  const result = await cloudClientRef.openAIRequest(kind, body, signal);
  if (!result.ok) throw new Error(result.error);
  if (result.response.status === 429 || result.response.status === 402) {
    const text = await result.response
      .clone()
      .text()
      .catch(() => "");
    if (/ai_daily_limit|plan_limit/i.test(text)) {
      planLimitUntil = Date.now() + PLAN_LIMIT_RETRY_MS;
      console.error("[openai] the Clynx plan's AI allowance is used up: AI features pause for a few minutes.");
      throw new Error(PLAN_LIMIT_MESSAGE);
    }
  }
  return result.response;
}
