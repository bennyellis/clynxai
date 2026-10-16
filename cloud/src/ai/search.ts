// OpenAI web search through the shared AI service. The customer's app never sends a raw provider request: it sends a SEARCH PHRASE, and this file builds the whole provider request
// itself (one tool, a fixed instruction, a capped answer), so the route cannot be used to run arbitrary tools or prompts on the company's key. Pure; the route owns the network.
export const SEARCH_MAX_QUERY = 300;

export interface SearchAnswer {
  answer: string;
  /** `snippet` is the sentence of the answer the citation supports (so each page carries what it was cited for). */
  citations: Array<{ url: string; title: string; snippet: string }>;
}

/** The sentence around [start, end) in `text`, or "" when the indices do not fit. */
export function sentenceAround(text: string, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end > text.length || end < start) return "";
  const before = Math.max(text.lastIndexOf(". ", start), text.lastIndexOf("\n", start));
  const after = text.indexOf(". ", end);
  return text.slice(before < 0 ? 0 : before + 1, after < 0 ? text.length : after + 1).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The provider request for one search. `maxOutput` caps the answer. */
export function buildSearchRequest(query: string, model: string, maxOutput: number): Record<string, unknown> {
  return {
    model,
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    input: `Search the web for: ${query}\nReply with a short factual summary (at most 150 words) of what the best sources say, naming the specific models, editions and storage sizes they mention. Do not guess; if sources disagree, say so.`,
    max_output_tokens: maxOutput,
    store: false,
  };
}

/** The phrase to search, or null when it is empty, too long or not text. Control characters and URLs' tracking noise are left alone; only length and type are enforced. */
export function cleanSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return q.length >= 3 && q.length <= SEARCH_MAX_QUERY ? q : null;
}

/** The answer text and the pages it cites, from a Responses API result. Only http(s) citations are kept, duplicates removed. */
export function parseSearchResponse(json: unknown): SearchAnswer & { inputTokens: number | null; outputTokens: number | null } {
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
  return { answer: answer.trim().slice(0, 4000), citations: citations.slice(0, 10), inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null };
}
