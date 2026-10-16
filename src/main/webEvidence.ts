// How Clynx reads the web as EVIDENCE (variantEvidence.ts is what judges it). Three real-world failures this exists for:
//  1. A search engine answers an automated request with a bot check, an empty page or a different markup, and the old code read that as "no results", so
//     every claim came back "unverified" without anyone being told the search itself had failed. Now several search backends are tried in turn, a blocked
//     answer is recognized and recorded as blocked (not as "nothing found"), and a backend that blocked is left alone for a while.
//  2. Manufacturer pages are mostly JavaScript. The product names are in structured data (JSON-LD, page state), meta tags and image/aria labels, which the old
//     tag-stripper threw away with the <script> blocks. The text kept for evidence now includes them, and when a page still shows nothing useful the page is
//     rendered in a browser (a separate, throw-away one: never the Facebook window).
//  3. A link the user pastes may be a search-results page (Google, Bing) rather than a product page. It is not a page that can be read; its query is used as a
//     search hint, and the answer says so, instead of implying the page was read.
// Every search and every page read is traced (what was asked, which backend, what came back, how much text), so a failure can be shown, not guessed.
// Network access is injectable so the whole path can be run against a local server in tests.

import type { EvidenceTrace, PageTrace, SearchTrace, VerifyDeps } from "./variantEvidence.js";
import { queryFromSearchUrl } from "./searchLinks.js";
import { isPublicHttpUrl } from "./variantResearch.js";

export type { EvidenceTrace, PageTrace, SearchTrace };

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBackend {
  name: string;
  /** The request for a query: a GET address, or a POST with a form body. Not used by a backend that has `run`. */
  request?(query: string): { url: string; method?: "GET" | "POST"; body?: string; headers?: Record<string, string> };
  parse?(body: string): SearchHit[];
  /** A backend that does its own call (OpenAI web search): returns the results, throws on failure. */
  run?(query: string, maxResults: number): Promise<SearchHit[]>;
  /** A reason this backend must not be used right now (a spent daily allowance), or null; checked before any request. */
  skip?(): string | null;
  /** True when the answer is a bot check / refusal rather than results. */
  isBlocked?(status: number, body: string): boolean;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// ------------------------------------------------------------------ text extraction

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&#39;": "'", "&#039;": "'", "&#x27;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&ndash;": "-", "&mdash;": "-", "&trade;": "", "&reg;": "" };

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:nbsp|amp|quot|lt|gt|ndash|mdash|trade|reg);|&#0?39;|&#x27;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d{2,5});/g, (_m, n) => {
      const code = Number(n);
      return code > 31 && code < 65536 ? String.fromCharCode(code) : " ";
    });
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** The human strings inside a JSON document (names, titles, descriptions), however deeply nested. */
export function jsonStrings(raw: string, out: string[] = [], limit = 4000): string[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  const walk = (v: unknown, depth: number) => {
    if (out.length >= limit || depth > 14) return;
    if (typeof v === "string") {
      if (v.length >= 4 && v.length <= 400 && /[A-Za-z]{3}/.test(v) && !/^(?:https?:|data:|[\w-]+\/[\w.+-]+$)/i.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/**
 * Everything on a page that can name a product, as plain lines: the visible text, the title and meta tags, the labels on images and links (a product tile's
 * name is often only an alt or aria-label), structured data (JSON-LD) and the JSON the page's own scripts carry. The old extraction kept only the first.
 */
export function extractEvidenceText(html: string, maxChars = 60_000): string {
  const parts: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) parts.push(stripTags(title));
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content && /(title|description|keywords)/.test(key)) parts.push(decodeEntities(content));
  }
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["'](?:application\/ld\+json|application\/json|text\/json)["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    parts.push(...jsonStrings(m[1].trim()));
  }
  // JSON assigned to a global by the page's own script ("__NEXT_DATA__", "__INITIAL_STATE__ = {...}"): take the object that starts at the first brace.
  for (const m of html.matchAll(/<script[^>]*>\s*(?:window\.)?[A-Za-z_$][\w$.]*\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/gi)) parts.push(...jsonStrings(m[1]));
  for (const m of html.matchAll(/\b(?:alt|aria-label|title|data-title|data-name|data-product-name)\s*=\s*["']([^"']{4,200})["']/gi)) parts.push(decodeEntities(m[1]));
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  parts.push(stripTags(main ?? html));
  // visible text last and whole: the order puts the names first, and the cap cuts the navigation, not the product
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of parts) {
    const line = p.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join("\n").slice(0, maxChars);
}

// ------------------------------------------------------------------ search backends

function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
    const real = url.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : url.toString();
  } catch {
    return href;
  }
}

function decodeBingUrl(href: string): string {
  try {
    const url = new URL(decodeEntities(href), "https://www.bing.com");
    if (!/bing\.com$/.test(url.hostname) || !url.pathname.startsWith("/ck/")) return url.toString();
    const u = url.searchParams.get("u");
    if (u && /^a1/.test(u)) return Buffer.from(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return url.toString();
  } catch {
    return href;
  }
}

export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const links = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
  links.forEach((m, i) => hits.push({ url: decodeDuckDuckGoUrl(decodeEntities(m[1])), title: stripTags(m[2]), snippet: snippets[i] ? stripTags(snippets[i][1]) : "" }));
  return hits;
}

export function parseDuckDuckGoLite(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const links = [...html.matchAll(/<a[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  for (const m of links) {
    const href = /href=['"]([^'"]+)['"]/.exec(m[0])?.[1];
    if (!href) continue;
    const after = html.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1500);
    const snip = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(after)?.[1];
    hits.push({ url: decodeDuckDuckGoUrl(decodeEntities(href)), title: stripTags(m[1]), snippet: snip ? stripTags(snip) : "" });
  }
  return hits;
}

export function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of html.split(/<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>/).slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1];
    hits.push({ url: decodeBingUrl(a[1]), title: stripTags(a[2]), snippet: snip ? stripTags(snip) : "" });
  }
  return hits;
}

const BLOCK_MARKERS = /(anomaly|unusual traffic|are you a (?:robot|human)|bots use duckduckgo|captcha|verify you are (?:a )?human|access denied|temporarily blocked|too many requests|challenge-form|please complete the security check)/i;

export const DEFAULT_BACKENDS = (bases: { ddgHtml?: string; ddgLite?: string; bing?: string } = {}): SearchBackend[] => [
  {
    name: "duckduckgo-html",
    request: (q) => ({ url: `${bases.ddgHtml ?? "https://html.duckduckgo.com/html/"}?q=${encodeURIComponent(q)}` }),
    parse: parseDuckDuckGoHtml,
    isBlocked: (status, body) => status === 202 || status === 403 || status === 429 || (parseDuckDuckGoHtml(body).length === 0 && BLOCK_MARKERS.test(body)),
  },
  {
    name: "duckduckgo-lite",
    request: (q) => ({ url: bases.ddgLite ?? "https://lite.duckduckgo.com/lite/", method: "POST", body: `q=${encodeURIComponent(q)}` }),
    parse: parseDuckDuckGoLite,
    isBlocked: (status, body) => status === 202 || status === 403 || status === 429 || (parseDuckDuckGoLite(body).length === 0 && BLOCK_MARKERS.test(body)),
  },
  {
    name: "bing",
    request: (q) => ({ url: `${bases.bing ?? "https://www.bing.com/search"}?q=${encodeURIComponent(q)}&setlang=en-US&cc=US` }),
    parse: parseBing,
    isBlocked: (status, body) => status === 403 || status === 429 || (parseBing(body).length === 0 && BLOCK_MARKERS.test(body)),
  },
];

// ------------------------------------------------------------------ the dependencies the evidence check uses

export interface EvidenceDepsOptions {
  fetchImpl?: typeof fetch;
  backends?: SearchBackend[];
  /** Renders a page in a browser and returns its text, or null. Used only when a page read plainly shows nothing useful. */
  render?: (url: string) => Promise<string | null>;
  /** Let addresses on this computer through (tests only). */
  allowLocal?: boolean;
  /** Pause between searches, so a burst of queries does not look like a bot. */
  searchGapMs?: number;
  /** How long a backend that blocked is left alone. */
  blockedForMs?: number;
  /** At most this many browser renders per verification. */
  maxRenders?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface EvidenceDeps extends VerifyDeps {
  trace(): EvidenceTrace;
  reset(): void;
}

async function timedFetch(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await f(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/** A search API's key travels in its address; nothing that is traced, logged or shown may carry it. */
export function redactSecrets(text: string): string {
  return text.replace(/([?&](?:key|cx|api_key|token|subscription-token)=)[^&\s)"']+/gi, "$1***");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createEvidenceDeps(opts: EvidenceDepsOptions = {}): EvidenceDeps {
  const f = opts.fetchImpl ?? fetch;
  const backends = opts.backends ?? DEFAULT_BACKENDS();
  const gap = opts.searchGapMs ?? 600;
  const blockedFor = opts.blockedForMs ?? 10 * 60_000;
  const timeout = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  const blockedUntil = new Map<string, number>();
  let trace: EvidenceTrace = { searches: [], pages: [] };
  let rendersLeft = opts.maxRenders ?? 2;
  let lastSearchAt = 0;
  const ok = (url: string) => (opts.allowLocal ? /^https?:\/\//i.test(url) : isPublicHttpUrl(url));

  async function search(query: string, maxResults: number): Promise<SearchHit[]> {
    const wait = gap - (now() - lastSearchAt);
    if (wait > 0) await sleep(wait);
    lastSearchAt = now();
    for (const backend of backends) {
      if ((blockedUntil.get(backend.name) ?? 0) > now()) {
        trace.searches.push({ query, backend: backend.name, outcome: "blocked", results: 0, detail: "skipped: blocked a moment ago" });
        continue;
      }
      const skipReason = backend.skip?.();
      if (skipReason) {
        trace.searches.push({ query, backend: backend.name, outcome: "blocked", results: 0, detail: `skipped: ${skipReason}` });
        continue;
      }
      if (backend.run) {
        try {
          const hits = (await backend.run(query, maxResults)).slice(0, maxResults);
          trace.searches.push({ query, backend: backend.name, outcome: hits.length ? "ok" : "empty", results: hits.length, detail: hits.length ? undefined : "no cited pages came back" });
          if (hits.length) return hits;
        } catch (err) {
          // a failing paid backend is left alone for a while, not asked again for every query
          blockedUntil.set(backend.name, now() + Math.min(blockedFor, 5 * 60_000));
          trace.searches.push({ query, backend: backend.name, outcome: "error", results: 0, detail: redactSecrets((err as Error).message) });
        }
        continue;
      }
      if (!backend.request || !backend.parse || !backend.isBlocked) continue;
      const req = backend.request(query);
      try {
        const res = await timedFetch(
          f,
          req.url,
          { method: req.method ?? "GET", headers: { ...BROWSER_HEADERS, ...(req.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(req.headers ?? {}) }, body: req.body },
          timeout
        );
        const body = await res.text();
        if (backend.isBlocked(res.status, body)) {
          blockedUntil.set(backend.name, now() + blockedFor);
          trace.searches.push({ query, backend: backend.name, outcome: "blocked", results: 0, detail: `HTTP ${res.status}: the search engine answered with a bot check or refusal` });
          continue;
        }
        const hits = backend.parse(body).slice(0, maxResults);
        trace.searches.push({ query, backend: backend.name, outcome: hits.length ? "ok" : "empty", results: hits.length, detail: hits.length ? undefined : `HTTP ${res.status}: no results in the answer` });
        if (hits.length) return hits;
      } catch (err) {
        // A backend that cannot be reached at all is left alone for a minute, so a down network is one failure per backend, not dozens.
        blockedUntil.set(backend.name, now() + Math.min(blockedFor, 60_000));
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        trace.searches.push({ query, backend: backend.name, outcome: "error", results: 0, detail: redactSecrets(`${(err as Error).message}${cause?.code || cause?.message ? ` (${cause.code ?? cause.message})` : ""}`) });
      }
    }
    return [];
  }

  async function fetchText(url: string, hint?: { tokens: string[] }): Promise<string | null> {
    const searched = queryFromSearchUrl(url);
    if (searched) {
      trace.pages.push({ url, status: null, chars: 0, via: "fetch", note: `a search-results page, not a product page; its query was "${searched}"` });
      return null;
    }
    if (!ok(url)) {
      trace.pages.push({ url, status: null, chars: 0, via: "fetch", note: "not a public web address, not opened" });
      return null;
    }
    let text: string | null = null;
    let status: number | null = null;
    try {
      const res = await timedFetch(f, url, { headers: BROWSER_HEADERS }, timeout);
      status = res.status;
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && /html|xml|json|text/i.test(type || "text/html")) {
        const body = await res.text();
        text = /json/i.test(type) ? jsonStrings(body).join("\n") : extractEvidenceText(body);
      }
      trace.pages.push({ url, status, chars: text?.length ?? 0, via: "fetch", note: res.ok ? undefined : `HTTP ${status}` });
    } catch (err) {
      trace.pages.push({ url, status: null, chars: 0, via: "fetch", note: (err as Error).message });
    }
    // A page the plain read could not use (refused, or an empty JavaScript shell that never states the product) is rendered once in a browser.
    const needles = (hint?.tokens ?? []).filter((t) => t.length > 2);
    const looksUseful = !!text && text.length > 400 && (needles.length === 0 || needles.some((t) => text!.toLowerCase().includes(t)));
    if (!looksUseful && opts.render && rendersLeft > 0) {
      rendersLeft--;
      try {
        const rendered = await opts.render(url);
        trace.pages.push({ url, status: null, chars: rendered?.length ?? 0, via: "browser", note: rendered ? undefined : "the browser could not open it" });
        if (rendered && rendered.length > (text?.length ?? 0)) text = rendered;
      } catch (err) {
        trace.pages.push({ url, status: null, chars: 0, via: "browser", note: (err as Error).message });
      }
    }
    return text;
  }

  return {
    search,
    fetchText,
    trace: () => trace,
    reset: () => {
      trace = { searches: [], pages: [] };
      rendersLeft = opts.maxRenders ?? 2;
    },
  };
}

/** True when every search that was tried was blocked or failed (so "nothing found" would be a false statement). */
export function searchWasUnavailable(t: EvidenceTrace): boolean {
  return t.searches.length > 0 && t.searches.every((s) => s.outcome === "blocked" || s.outcome === "error");
}

export function describeTrace(t: EvidenceTrace): string {
  const searchLines = t.searches.map((s) => `search "${s.query}" via ${s.backend}: ${s.outcome}${s.results ? ` (${s.results} results)` : ""}${s.detail ? ` - ${s.detail}` : ""}`);
  const pageLines = t.pages.map((p) => `page ${p.url} via ${p.via}: ${p.status ?? "-"}, ${p.chars} chars${p.note ? ` - ${p.note}` : ""}`);
  return [...searchLines, ...pageLines].join("\n");
}
