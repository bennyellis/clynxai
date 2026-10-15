// Official search APIs, used BEFORE the keyless page-scraping backends when the owner has configured a key. Google's results page answers an automated request with a
// bot check (solving one is not something this app does), so Google is reached only through its own supported route: the Programmable Search JSON API. Brave's Search API
// is the second option. Both are optional and read from the environment (.env), exactly like the OpenAI and eBay keys; nothing here stores, logs or shows a key.
//
//   GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID     Google Programmable Search (free tier: 100 queries a day; configure the engine to "search the entire web")
//   BRAVE_SEARCH_API_KEY                   Brave Search API (free plan with a monthly allowance)
//   GOOGLE_CSE_DAILY_LIMIT                 optional: stop using Google after this many queries a day (default 90, a little under the free 100)
//
// With none set, behaviour is unchanged: DuckDuckGo (two forms) then Bing, which need no key.
import type { SearchBackend, SearchHit } from "./webEvidence.js";

export interface SearchApiEnv {
  GOOGLE_CSE_API_KEY?: string;
  GOOGLE_CSE_ID?: string;
  BRAVE_SEARCH_API_KEY?: string;
  GOOGLE_CSE_DAILY_LIMIT?: string;
}

interface GoogleResponse {
  items?: Array<{ title?: string; link?: string; snippet?: string }>;
  error?: { code?: number; message?: string };
}
interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

const clean = (v: unknown): string => String(v ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();

export function parseGoogleApi(body: string): SearchHit[] {
  try {
    const j = JSON.parse(body) as GoogleResponse;
    return (j.items ?? []).filter((i) => i.link).map((i) => ({ title: clean(i.title), url: String(i.link), snippet: clean(i.snippet) }));
  } catch {
    return [];
  }
}

export function parseBraveApi(body: string): SearchHit[] {
  try {
    const j = JSON.parse(body) as BraveResponse;
    return (j.web?.results ?? []).filter((i) => i.url).map((i) => ({ title: clean(i.title), url: String(i.url), snippet: clean(i.description) }));
  } catch {
    return [];
  }
}

/** Which official routes are configured (names only: never a key). */
export function configuredSearchApis(env: SearchApiEnv = process.env as SearchApiEnv): string[] {
  const out: string[] = [];
  if (env.GOOGLE_CSE_API_KEY?.trim() && env.GOOGLE_CSE_ID?.trim()) out.push("google-api");
  if (env.BRAVE_SEARCH_API_KEY?.trim()) out.push("brave-api");
  return out;
}

/** A per-day counter, so the free allowance is spent deliberately and the API is skipped (not hammered into errors) once it is used up. */
export function createDailyBudget(limit: number, now: () => number = () => Date.now()) {
  let day = "";
  let used = 0;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  return {
    take(): boolean {
      if (today() !== day) {
        day = today();
        used = 0;
      }
      if (used >= limit) return false;
      used++;
      return true;
    },
    /** Whether a query could be taken now, without taking it. */
    peek(): boolean {
      return today() !== day || used < limit;
    },
    used: () => (today() === day ? used : 0),
  };
}

/** The official-API backends that are configured, in the order they are tried. `exhausted` is a quota that is spent (the backend is then treated as blocked for a while). */
export function apiBackends(env: SearchApiEnv = process.env as SearchApiEnv, now: () => number = () => Date.now()): SearchBackend[] {
  const out: SearchBackend[] = [];
  const key = env.GOOGLE_CSE_API_KEY?.trim();
  const cx = env.GOOGLE_CSE_ID?.trim();
  if (key && cx) {
    const limit = Math.max(1, Math.min(100, Number(env.GOOGLE_CSE_DAILY_LIMIT) || 90));
    const budget = createDailyBudget(limit, now);
    out.push({
      name: "google-api",
      skip: () => (budget.peek() ? null : `today's Google allowance (${limit} searches) is used up`),
      request: (q) => {
        budget.take();
        return { url: `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=8&hl=en&gl=us` };
      },
      parse: parseGoogleApi,
      // 403 / 429 from this API is a quota, a disabled API or a bad key: all mean "stop using it for now", never "no results".
      isBlocked: (status, body) => status === 403 || status === 429 || status === 400 || status === 401 || (status !== 200 && /quota|rateLimit|dailyLimit|keyInvalid|accessNotConfigured/i.test(body)),
    });
  }
  const brave = env.BRAVE_SEARCH_API_KEY?.trim();
  if (brave) {
    out.push({
      name: "brave-api",
      request: (q) => ({ url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8&country=us&search_lang=en`, headers: { "X-Subscription-Token": brave, Accept: "application/json" } }),
      parse: parseBraveApi,
      isBlocked: (status) => status === 401 || status === 403 || status === 422 || status === 429,
    });
  }
  return out;
}
