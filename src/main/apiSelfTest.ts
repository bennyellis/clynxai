// A small, bounded, real check of the services Clynx depends on, through the SAME code the app uses (callOpenAI, searchEbayItems): used by the in-app "Run API check" button and by
// scripts\api-diagnose.cjs. It makes at most: one tiny AI request (a few dozen tokens), one eBay search of 20 results, and one reachability request to WatchCount. Every failure is returned
// with its reason; nothing is retried, hidden or turned into a pass.
import { classifyComparable } from "./compIdentity.js";
import { apiActivity, scrub } from "./apiActivity.js";
import { median } from "./marketValue.js";

export interface SelfTestDeps {
  callOpenAI(kind: "chat", body: unknown, signal?: AbortSignal): Promise<Response>;
  model: string;
  hasOpenAIAccess(): boolean;
  openAIRoute(): "own_key" | "clynx_cloud" | "none";
  hasEbayCredentials(): boolean;
  searchEbayItems(query: string, opts: { limit: number }): Promise<Array<{ title: string; priceValue: string | null; priceCurrency: string | null; shippingCostUsd: number | null }>>;
  fetch: typeof fetch;
}

export interface OpenAITest {
  ok: boolean;
  skipped?: string;
  route: string;
  model: string;
  status: number | null;
  ms: number | null;
  reply: string | null;
  tokens: { input: number | null; output: number | null; total: number | null } | null;
  error: string | null;
}
export interface EbayTest {
  ok: boolean;
  skipped?: string;
  query: string;
  retrieved: number;
  accepted: number;
  rejected: number;
  uncertain: number;
  /** Median of the ACCEPTED listings' asking prices (item + shipping). These are what sellers ASK today, not what anything sold for. */
  medianAskUsd: number | null;
  ms: number | null;
  error: string | null;
}
export interface WatchCountTest {
  ok: boolean;
  status: number | null;
  ms: number | null;
  note: string;
  error: string | null;
}
export interface SelfTestResult {
  at: number;
  openai: OpenAITest;
  ebay: EbayTest;
  watchcount: WatchCountTest;
}

const OPENAI_TIMEOUT_MS = 30_000;
const EBAY_QUERY = "Xbox Series X";

export async function testOpenAI(d: SelfTestDeps): Promise<OpenAITest> {
  const base = { route: d.openAIRoute(), model: d.model, status: null as number | null, ms: null as number | null, reply: null as string | null, tokens: null as OpenAITest["tokens"], error: null as string | null };
  if (!d.hasOpenAIAccess()) return { ...base, ok: false, skipped: "no OpenAI key on this computer and no Clynx Cloud sign-in", error: "No OpenAI access configured." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await d.callOpenAI("chat", { model: d.model, messages: [{ role: "user", content: "Reply with exactly the word: ok" }], max_completion_tokens: 64, reasoning_effort: "minimal" }, controller.signal);
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) return { ...base, ok: false, status: res.status, ms, error: scrub(`HTTP ${res.status}: ${text}`) };
    let data: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string };
    try {
      data = JSON.parse(text);
    } catch {
      return { ...base, ok: false, status: res.status, ms, error: "The answer was not valid JSON." };
    }
    const reply = data.choices?.[0]?.message?.content ?? null;
    const u = data.usage;
    return {
      ...base,
      ok: reply !== null && /ok/i.test(reply),
      status: res.status,
      ms,
      model: data.model ?? d.model,
      reply: reply === null ? null : scrub(reply, 40),
      tokens: u ? { input: u.prompt_tokens ?? null, output: u.completion_tokens ?? null, total: u.total_tokens ?? null } : null,
      error: reply === null ? "The answer had no message." : /ok/i.test(reply) ? null : "The answer was not the expected word.",
    };
  } catch (err) {
    return { ...base, ok: false, ms: Date.now() - t0, error: (err as Error).name === "AbortError" ? "The request timed out." : scrub((err as Error).message) };
  } finally {
    clearTimeout(timer);
  }
}

export async function testEbay(d: SelfTestDeps): Promise<EbayTest> {
  const base = { query: EBAY_QUERY, retrieved: 0, accepted: 0, rejected: 0, uncertain: 0, medianAskUsd: null as number | null, ms: null as number | null, error: null as string | null };
  if (!d.hasEbayCredentials()) return { ...base, ok: false, skipped: "no eBay keys on this computer and not using Clynx Cloud's eBay", error: "No eBay credentials configured." };
  const t0 = Date.now();
  try {
    const items = await d.searchEbayItems(EBAY_QUERY, { limit: 20 });
    const prices: number[] = [];
    let accepted = 0, rejected = 0, uncertain = 0;
    for (const it of items) {
      const j = classifyComparable({ name: EBAY_QUERY }, it.title);
      if (j.verdict === "exact" || j.verdict === "compatible") {
        accepted++;
        if (it.priceCurrency === "USD" && it.priceValue !== null && Number.isFinite(Number(it.priceValue))) prices.push(Number(it.priceValue) + (it.shippingCostUsd ?? 0));
      } else if (j.verdict === "rejected") rejected++;
      else uncertain++;
    }
    apiActivity.identity("ebay", { retrieved: items.length, accepted, rejected, uncertain });
    return { ...base, ok: true, retrieved: items.length, accepted, rejected, uncertain, medianAskUsd: median(prices), ms: Date.now() - t0 };
  } catch (err) {
    return { ...base, ok: false, ms: Date.now() - t0, error: scrub((err as Error).message) };
  }
}

export async function testWatchCount(d: SelfTestDeps): Promise<WatchCountTest> {
  const note = "Reachability only. Sold prices are read from WatchCount in a browser tab by the scanner; this check does not log in or search.";
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await d.fetch("https://www.watchcount.com", { method: "GET", signal: controller.signal, redirect: "follow" });
    // 403 / 429 from a plain request is normal for WatchCount (it expects a browser): the site is reachable, but this request was refused. It is a pass only in the sense of "the host answered".
    const refused = res.status === 403 || res.status === 429;
    return { ok: res.status < 500, status: res.status, ms: Date.now() - t0, note: refused ? `${note} The site answered ${res.status} to a plain request, which is normal: the scanner reads it in a browser tab, so this does not show whether sold-price lookups work.` : note, error: res.status < 500 ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - t0, note, error: (err as Error).name === "AbortError" ? "The request timed out." : scrub((err as Error).message) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runApiSelfTest(d: SelfTestDeps): Promise<SelfTestResult> {
  const [openai, ebay, watchcount] = [await testOpenAI(d), await testEbay(d), await testWatchCount(d)];
  return { at: Date.now(), openai, ebay, watchcount };
}
