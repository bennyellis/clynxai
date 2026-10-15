// The AI's two small jobs in product research: think up the searches a person would type, and summarise what the pages say. It can never add a fact the pages do not
// contain (productKnowledge.keepSupported checks every claim against the page text), and research works without it.
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import type { KnowledgeAi } from "./productKnowledge.js";

const TIMEOUT_MS = 30_000;

async function askJson(purpose: string, prompt: string, maxTokens: number): Promise<Record<string, unknown> | null> {
  try {
    ensureOpenAIAccess();
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await callOpenAI("chat", { model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }], max_completion_tokens: maxTokens, reasoning_effort: "minimal", response_format: { type: "json_object" } }, controller.signal, purpose);
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function openAiKnowledgeAi(): KnowledgeAi {
  return {
    async queries(name, ctx) {
      const why = (ctx.reasons ?? []).length ? `\nWhat is unclear: ${(ctx.reasons ?? []).join("; ")}.` : "";
      const out = await askJson(
        "product research queries",
        `You are a careful used-electronics buyer who is not sure exactly which version of a product a listing is. Product: "${name}".${why}
Write 3 web searches you would genuinely type into Google to find out how this product line differs between versions (storage sizes, look-alike or cheaper models, anything people confuse). Plain everyday wording like a person types, 4-10 words each, no quotes, no operators, no site: filters, no brand-new product names you are not sure exist.
Answer ONLY with JSON: { "queries": [string, string, string] }`,
        250
      );
      return Array.isArray(out?.queries) ? (out!.queries as unknown[]).map(String) : null;
    },
    async facts(name, pages) {
      const text = pages.map((p, i) => `[${i}] ${p.title} (${p.url})\n${p.excerpt}`).join("\n\n");
      const out = await askJson(
        "product research facts",
        `Product: "${name}". Below are excerpts from web pages. Using ONLY these excerpts, list (1) the storage capacities this exact product line is sold in, (2) other models in the same line that are a DIFFERENT product from it and could be confused with it (name them as the pages do), and (3) one or two plain sentences on how the versions differ. If the excerpts do not say, leave the list empty. Do not use outside knowledge.
${text}
Answer ONLY with JSON: { "capacities": [string], "distinctModels": [string], "summary": string }`,
        500
      );
      if (!out) return null;
      return { capacities: out.capacities, distinctModels: out.distinctModels, summary: typeof out.summary === "string" ? out.summary : undefined };
    },
  };
}
