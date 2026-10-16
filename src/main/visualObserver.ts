// The real "eyes" and "theme sorter" for identityResearch.ts: they call the AI with the listing photos. They are thin on purpose (prompt in, parsed and validated JSON out); every
// decision about what the answers MEAN is in identityResearch.ts / visualProfile.ts, which are tested without a model. These two functions are the part that needs a real model and
// real photographs to validate, and scripts/visual-eval.cjs is how the owner checks them (see BETA/PHASE report).
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import type { Observer, ThemeClassifier } from "./identityResearch.js";
import { OBSERVE_PROMPT, parseAnswers, parseObservation, targetedPrompt } from "./visualProfile.js";

const TIMEOUT_MS = 60_000;
const MAX_PHOTOS = 4;

async function askVision(purpose: string, prompt: string, images: string[], maxTokens: number, detail: "auto" | "high"): Promise<unknown | null> {
  try {
    ensureOpenAIAccess();
  } catch {
    return null;
  }
  const photos = images.filter((i) => typeof i === "string" && i.startsWith("data:image/")).slice(0, MAX_PHOTOS);
  if (!photos.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...photos.map((url) => ({ type: "image_url", image_url: { url, detail } }))] }],
        max_completion_tokens: maxTokens,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
      },
      controller.signal,
      purpose
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return JSON.parse(data.choices?.[0]?.message?.content ?? "");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function openAiObserver(): Observer {
  return {
    async observe(images) {
      const raw = await askVision("visual observation", OBSERVE_PROMPT, images, 900, "high");
      return parseObservation(raw, Math.min(images.length, MAX_PHOTOS));
    },
    async answer(images, questions) {
      if (!questions.length) return {};
      const raw = await askVision("visual targeted questions", targetedPrompt(questions), images, 700, "high");
      return raw ? parseAnswers(raw, questions) : null;
    },
  };
}

export function openAiThemeClassifier(): ThemeClassifier {
  return {
    async classify(editionName, terms, quotes) {
      try {
        ensureOpenAIAccess();
      } catch {
        return null;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await callOpenAI(
          "chat",
          {
            model: OPENAI_MODEL,
            messages: [{ role: "user", content: `A special edition of a product is called "${editionName}". These capitalised terms appear in sources about it: ${terms.join(", ")}.\nSource sentences:\n${quotes.slice(0, 3).map((q) => `- ${q}`).join("\n")}\nUsing ONLY these sentences, say which terms are a franchise (a series or brand of media/toys/games) and which are a character, and for a character the franchise it belongs to if a term names it. Ignore terms that are neither. Do not add terms that are not in the list.\nAnswer ONLY with JSON: { "themes": [{ "term": string, "kind": "franchise"|"character", "franchise": string|null }] }` }],
            max_completion_tokens: 400,
            reasoning_effort: "minimal",
            response_format: { type: "json_object" },
          },
          controller.signal,
          "edition theme sorting"
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "") as { themes?: Array<{ term?: unknown; kind?: unknown; franchise?: unknown }> };
        return (parsed.themes ?? [])
          .filter((t) => typeof t.term === "string" && (t.kind === "franchise" || t.kind === "character"))
          .map((t) => ({ term: String(t.term), kind: t.kind as "franchise" | "character", franchise: typeof t.franchise === "string" ? t.franchise : undefined }));
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
