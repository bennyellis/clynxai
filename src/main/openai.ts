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
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export function getOpenAIApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set. Add it in Config (platform.openai.com/api-keys).");
  }
  return key;
}
