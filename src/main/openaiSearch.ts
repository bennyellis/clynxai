// OpenAI's web search as one more search engine for Clynx's product research. It is NOT Google (it is OpenAI's own search) and it is OFF unless the owner switches it on
// (config.json beta13.openaiSearch). It is used only for hard research (unfamiliar items, unclear models, edition and claim checks), never for ordinary lookups, within an hourly
// limit, and never in Save-credits mode. Its answer is not trusted as a finished conclusion: it is turned into search RESULTS (the cited pages, each with the sentence it was cited
// for), and Clynx then reads those pages and applies its own rules (two independent sources, or an official one) exactly as for any other engine.
// The pure request/parse code mirrors cloud/src/ai/search.ts; the network call lives in openai.ts (own key: straight to OpenAI; otherwise Clynx Cloud's POST /ai/search).
import type { SearchBackend, SearchHit } from "./webEvidence.js";

export interface SearchAnswer {
  answer: string;
  citations: Array<{ url: string; title: string; snippet: string }>;
}

export function buildSearchRequest(query: string, model: string, maxOutput = 600): Record<string, unknown> {
  return {
    model,
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    input: `Search the web for: ${query}\nReply with a short factual summary (at most 150 words) of what the best sources say, naming the specific models, editions and storage sizes they mention. Do not guess; if sources disagree, say so.`,
    max_output_tokens: maxOutput,
    store: false,
  };
}

function sentenceAround(text: string, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end > text.length || end < start) return "";
  const before = Math.max(text.lastIndexOf(". ", start), text.lastIndexOf("\n", start));
  const after = text.indexOf(". ", end);
  return text.slice(before < 0 ? 0 : before + 1, after < 0 ? text.length : after + 1).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The answer and the pages it cites from a raw Responses API result (own-key route). */
export function parseResponses(json: unknown): { answer: SearchAnswer; inputTokens: number | null; outputTokens: number | null } {
  const out = (json as { output?: unknown[] } | null)?.output ?? [];
  let answer = "";
  const citations: SearchAnswer["citations"] = [];
  for (const item of Array.isArray(out) ? out : []) {
    const it = item as { type?: string; content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }> }> };
    if (it.type !== "message") continue;
    for (const c of it.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") answer += (answer ? "\n" : "") + c.text;
      for (const a of c.annotations ?? []) {
        if (a.type === "url_citation" && typeof a.url === "string" && /^https?:\/\//i.test(a.url) && !citations.some((x) => x.url === a.url)) citations.push({ url: a.url, title: String(a.title ?? "").slice(0, 160), snippet: sentenceAround(c.text ?? "", a.start_index, a.end_index) });
      }
    }
  }
  const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage;
  return { answer: { answer: answer.trim().slice(0, 4000), citations: citations.slice(0, 10) }, inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null };
}

/** What Clynx Cloud's /ai/search answered ({answer, citations}), validated; null when it is not that shape. */
export function parseCloudSearch(json: unknown): SearchAnswer | null {
  const j = json as { answer?: unknown; citations?: unknown } | null;
  if (!j || typeof j.answer !== "string" || !Array.isArray(j.citations)) return null;
  const citations = (j.citations as Array<Record<string, unknown>>)
    .filter((c) => typeof c?.url === "string" && /^https?:\/\//i.test(String(c.url)))
    .map((c) => ({ url: String(c.url), title: String(c.title ?? "").slice(0, 160), snippet: String(c.snippet ?? "").slice(0, 300) }))
    .slice(0, 10);
  return { answer: j.answer.slice(0, 4000), citations };
}

/** The cited pages as search results; each carries the sentence it was cited for (the summary when the sentence is unknown). */
export function answerToHits(a: SearchAnswer, max: number): SearchHit[] {
  return a.citations.slice(0, max).map((c) => ({ title: c.title || c.url, url: c.url, snippet: c.snippet || a.answer.slice(0, 300) }));
}

export interface OpenAiSearchPolicy {
  /** Switched on by the owner and the AI is reachable (own key or Clynx Cloud). */
  enabled(): boolean;
  /** Save-credits mode. */
  lowAi(): boolean;
  perHour: number;
  /** The call itself (openai.ts), injected so this file stays testable. */
  search(query: string, signal?: AbortSignal): Promise<SearchAnswer | null>;
  now?: () => number;
}

/** The backend for the shared search reader: it declines itself (so the next engine is used) when off, in Save-credits mode, over its hourly limit, or after a failure. */
export function openAiWebBackend(p: OpenAiSearchPolicy): SearchBackend {
  const now = p.now ?? (() => Date.now());
  let stamps: number[] = [];
  return {
    name: "openai-web",
    skip: () => {
      if (!p.enabled()) return "OpenAI web search is switched off";
      if (p.lowAi()) return "Save OpenAI credits mode is on";
      stamps = stamps.filter((t) => now() - t < 3600_000);
      if (stamps.length >= p.perHour) return `the hourly limit of ${p.perHour} OpenAI searches is used`;
      return null;
    },
    async run(query, max) {
      stamps.push(now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const answer = await p.search(query, controller.signal);
        return answer ? answerToHits(answer, max) : [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
