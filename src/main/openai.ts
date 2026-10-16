import type { CloudClient } from "./cloudClient.js";
import { buildSearchRequest, parseCloudSearch, parseResponses, type SearchAnswer } from "./openaiSearch.js";
import { apiActivity, purposeFromStack, type Route } from "./apiActivity.js";

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
const REAL_RESPONSES_URL = "https://api.openai.com/v1/responses";
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

// Where AI requests go. "shared": always through Clynx Cloud's company-managed OpenAI integration (a signed-in customer needs no key of their own, and a key saved on this computer is
// kept but not used). "own": a key saved on this computer is used when there is one (local beta mode, and cloud accounts that have not chosen the shared service). Set by index.ts.
let apiSource: () => "shared" | "own" = () => "own";
export function setApiSource(fn: () => "shared" | "own"): void {
  apiSource = fn;
}
function localApiKey(): string | null {
  if (apiSource() === "shared") return null;
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

/** What Clynx Cloud's shared AI service said no for, in words a customer can act on, and how long to stop asking. A transient "too many at once" is not a pause. */
export function cloudRefusal(body: string): { code: string; message: string; pauseMs: number } | null {
  const m = /"error"\s*:\s*"([a-z_]+)"/.exec(body);
  const code = m?.[1];
  switch (code) {
    case "ai_daily_limit":
    case "plan_limit":
    case "user_budget_exhausted":
      return { code, message: PLAN_LIMIT_MESSAGE, pauseMs: PLAN_LIMIT_RETRY_MS };
    case "api_budget_exhausted":
    case "paid_api_disabled":
    case "provider_unavailable":
    case "ai_not_configured":
    case "ai_unavailable":
      return { code, message: "Clynx's AI service is temporarily unavailable. It comes back by itself; nothing is wrong with your account.", pauseMs: 5 * 60_000 };
    case "rate_limited": {
      // The server allows about 60 AI requests a minute and BLOCKS an account that keeps going after being told no (40 refusals in 10 minutes). So stop asking for as long as it says.
      const secs = Number(/"retryAfterSec"\s*:\s*(\d+)/.exec(body)?.[1]);
      return { code, message: "Clynx is asking the AI too fast and is waiting a moment. It continues by itself.", pauseMs: Math.min(5 * 60_000, Math.max(30_000, (Number.isFinite(secs) ? secs : 60) * 1000)) };
    }
    case "temporarily_blocked":
      return { code, message: "Your AI access is paused for a while because of unusually heavy use. It resumes automatically.", pauseMs: 10 * 60_000 };
    default:
      return null;
  }
}
let planLimitUntil = 0;
/** What the last refusal said, so a pause is explained with its own reason and not always as a used-up allowance. */
let planLimitMessage = "";
export const PLAN_LIMIT_MESSAGE = "Today's AI allowance for your Clynx plan is used up. It resets tomorrow, or upgrade in Config > Account.";

// Same early fail-fast shape getOpenAIApiKey() used to provide (call sites
// still do `try { ensureOpenAIAccess(); } catch (err) { return
// errorResult(err.message); }` before doing any expensive work like
// downloading photos) — but doesn't hand back a key/token, since callOpenAI
// below resolves whichever one is current itself, at the moment it's
// actually needed.
export function ensureOpenAIAccess(): void {
  // Beta 12: a refusal here is a request that never left, so the AI-activity record says why (a limit, or no key / sign-in) instead of showing nothing.
  const refuse = (outcome: "skipped_budget" | "skipped_disabled", message: string): never => {
    apiActivity.record({ provider: "openai", kind: "(request not made)", outcome, route: "none", error: message });
    throw new Error(message);
  };
  if (Date.now() < planLimitUntil) refuse("skipped_budget", planLimitMessage || PLAN_LIMIT_MESSAGE);
  if (openAICreditsExhausted()) {
    refuse("skipped_budget", "OpenAI credits are used up — add credits at platform.openai.com/settings/organization/billing (Clynx checks again every few minutes).");
  }
  if (!hasOpenAIAccess()) {
    refuse("skipped_disabled", "No OpenAI access configured — set an API key in Config, or log into Clynx Cloud.");
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
export async function callOpenAI(kind: "chat" | "images", body: unknown, signal?: AbortSignal, purposeLabel?: string): Promise<Response> {
  const started = Date.now();
  // What the request is for: named by each call site (the production build is one bundle, so a call stack cannot say).
  const purpose = purposeLabel ?? purposeFromStack(new Error().stack);
  const model = typeof (body as { model?: unknown } | null)?.model === "string" ? ((body as { model: string }).model) : null;
  const streaming = (body as { stream?: unknown } | null)?.stream === true;
  const route: Route = localApiKey() ? "own_key" : cloudClientRef ? "clynx_cloud" : "none";
  let res: Response;
  try {
    res = await callOpenAIRaw(kind, body, signal);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // A request that never left: no key / no sign-in (disabled), or an allowance / credit limit already known (budget). Anything else is a real failure.
    const outcome = /No OpenAI access|OPENAI_API_KEY is not set|no cloud session/i.test(message) ? "skipped_disabled" : /credits are used up|allowance|plan|limit|temporarily unavailable|paused/i.test(message) ? "skipped_budget" : "live_failed";
    apiActivity.record({ provider: "openai", kind: purpose, outcome, route, model, ms: Date.now() - started, error: (err as Error)?.name === "AbortError" ? "the request timed out or was cancelled" : message });
    throw err;
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = await res.clone().text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string } | string };
      detail = typeof j.error === "string" ? j.error : [j.error?.code, j.error?.message].filter(Boolean).join(": ") || text;
    } catch {
      /* not JSON */
    }
    apiActivity.record({ provider: "openai", kind: purpose, outcome: "live_failed", route, model, status: res.status, ms, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` });
    return res;
  }
  if (streaming || kind === "images") {
    // A streamed answer reports no token counts unless asked to (and Clynx Cloud may strip that), and an image answer is megabytes of base64: neither is read here.
    apiActivity.record({ provider: "openai", kind: purpose, outcome: "live_ok", route, model, status: res.status, ms, tokens: null, tokensNotReported: true });
    return res;
  }
  // The answer's own usage block, read from a copy so the caller's response is untouched; recorded when it arrives.
  void res
    .clone()
    .json()
    .then((j: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number } }) => {
      const u = j?.usage;
      const input = u?.prompt_tokens ?? u?.input_tokens ?? null;
      const output = u?.completion_tokens ?? u?.output_tokens ?? null;
      const total = u?.total_tokens ?? (input !== null && output !== null ? input + output : null);
      apiActivity.record({ provider: "openai", kind: purpose, outcome: "live_ok", route, model, status: res.status, ms, tokens: u ? { input, output, total } : null, tokensNotReported: !u });
    })
    .catch(() => apiActivity.record({ provider: "openai", kind: purpose, outcome: "live_ok", route, model, status: res.status, ms, tokens: null, tokensNotReported: true, error: "the answer could not be read for usage" }));
  return res;
}

async function callOpenAIRaw(kind: "chat" | "images", body: unknown, signal?: AbortSignal): Promise<Response> {
  if (!localApiKey() && Date.now() < planLimitUntil) throw new Error(planLimitMessage || PLAN_LIMIT_MESSAGE);
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
    const refusal = cloudRefusal(text);
    if (refusal) {
      planLimitUntil = Date.now() + refusal.pauseMs;
      planLimitMessage = refusal.message;
      console.error(`[openai] Clynx Cloud refused the AI request (${refusal.code}): AI features pause for a few minutes.`);
      throw new Error(refusal.message);
    }
  }
  if (result.response.status === 503) {
    const refusal = cloudRefusal(await result.response.clone().text().catch(() => ""));
    if (refusal) {
      planLimitUntil = Date.now() + refusal.pauseMs;
      planLimitMessage = refusal.message;
      throw new Error(refusal.message);
    }
  }
  return result.response;
}


// ---- web search (openaiSearch.ts decides when it is used; this is only the call) -------------------------------------------------------------------------------------
const SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL || "gpt-4.1-mini";
let searchUnavailableUntil = 0;
const SEARCH_RETRY_MS = 30 * 60_000;

/**
 * One OpenAI web search, on the route the rest of the app uses: your own key goes straight to OpenAI; otherwise Clynx Cloud's POST /ai/search (the owner must have switched it on there).
 * Returns the answer and the pages it cites, or throws with a plain reason. A "not available" answer (the model cannot search, the server has it off) stops further tries for 30 minutes.
 */
export async function callOpenAISearch(query: string, signal?: AbortSignal): Promise<SearchAnswer | null> {
  if (Date.now() < searchUnavailableUntil) throw new Error("OpenAI web search is not available right now");
  ensureOpenAIAccess();
  const started = Date.now();
  const route: Route = localApiKey() ? "own_key" : "clynx_cloud";
  const note = (outcome: "live_ok" | "live_failed", extra: Partial<Parameters<typeof apiActivity.record>[0]> = {}) =>
    apiActivity.record({ provider: "openai", kind: "web search", outcome, route, model: SEARCH_MODEL, ms: Date.now() - started, ...extra } as never);
  try {
    const localKey = localApiKey();
    if (localKey) {
      const res = await fetch(REAL_RESPONSES_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localKey}` }, body: JSON.stringify(buildSearchRequest(query, SEARCH_MODEL)), signal });
      const data = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const msg = (data as { error?: { message?: string; code?: string } } | null)?.error;
        if (res.status === 429 && /insufficient_quota/.test(msg?.code ?? "")) creditsExhaustedUntil = Date.now() + CREDITS_RETRY_MS;
        if (res.status === 400 || res.status === 404) searchUnavailableUntil = Date.now() + SEARCH_RETRY_MS; // the model or the tool is not available to this key
        throw new Error(`OpenAI answered ${res.status}${msg?.message ? `: ${String(msg.message).slice(0, 120)}` : ""}`);
      }
      const parsed = parseResponses(data);
      note("live_ok", { status: res.status, tokens: { input: parsed.inputTokens, output: parsed.outputTokens, total: (parsed.inputTokens ?? 0) + (parsed.outputTokens ?? 0) } });
      return parsed.answer;
    }
    if (!cloudClientRef) throw new Error("no OpenAI key and no Clynx Cloud session");
    const result = await cloudClientRef.openAIRequest("search", { query }, signal);
    if (!result.ok) throw new Error(result.error);
    const text = await result.response.text().catch(() => "");
    if (!result.response.ok) {
      if (/search_not_enabled/.test(text)) searchUnavailableUntil = Date.now() + SEARCH_RETRY_MS;
      else {
        const refusal = cloudRefusal(text);
        if (refusal) {
          planLimitUntil = Date.now() + refusal.pauseMs;
      planLimitMessage = refusal.message;
          throw new Error(refusal.message);
        }
      }
      throw new Error(`Clynx Cloud answered ${result.response.status} to the search`);
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const answer = parseCloudSearch(body);
    if (!answer) throw new Error("Clynx Cloud's search answer was not understood");
    note("live_ok", { status: result.response.status, tokensNotReported: true } as never);
    return answer;
  } catch (err) {
    note("live_failed", { error: (err as Error).name === "AbortError" ? "the search timed out" : (err as Error).message } as never);
    throw err;
  }
}
