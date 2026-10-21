// The real eyes for the dearer ladder rungs (identityRungs.ts): one vision call that picks the candidate a listing's photos show, one that reads printed labels and model numbers, and eBay's image
// search. Each returns null on any failure (no AI access, timeout, bad reply) - the ladder reads that as "this rung found nothing", never as an answer.
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import { searchEbayByImage } from "./ebayClient.js";
import type { ImageSearchAsk, LabelAsk, PhotoAsk } from "./identityRungs.js";

const TIMEOUT_MS = 45_000;

async function visionJson(content: unknown[], label: string): Promise<any | null> {
  try {
    ensureOpenAIAccess();
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      { model: OPENAI_MODEL, messages: [{ role: "user", content }], max_completion_tokens: 500, reasoning_effort: "minimal", response_format: { type: "json_object" } },
      controller.signal,
      label
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const photoAsk: PhotoAsk = async ({ images, candidates }) => {
  const list = candidates.map((c, i) => `${i + 1}. ${c.name}${c.tells.length ? ` - how to tell: ${c.tells.join("; ")}` : ""}`).join("\n");
  const prompt = `These photos are from ONE used-item listing. Which of these products is it?\n${list}\n\nOnly choose when you can SEE what separates them (a disc slot, a colour, a port, a logo). If the photos do not show it, answer null. Respond with ONLY JSON: { "pick": number|null (the number above), "confident": boolean, "reason": "one short sentence of what you saw" }`;
  const content: unknown[] = [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } }))];
  const parsed = await visionJson(content, "identity photo rung");
  if (!parsed) return null;
  const n = typeof parsed.pick === "number" ? parsed.pick - 1 : null;
  return { pick: n !== null && n >= 0 && n < candidates.length ? n : null, confident: parsed.confident === true, reason: String(parsed.reason ?? "").slice(0, 160) };
};

export const labelAsk: LabelAsk = async ({ images }) => {
  const prompt = `Read any model numbers, part numbers, A-numbers, serial-style codes or printed labels visible in these photos of one product. Do not guess. Respond with ONLY JSON: { "codes": string[] } (empty when nothing is legible).`;
  const content: unknown[] = [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } }))];
  const parsed = await visionJson(content, "identity label rung");
  if (!parsed || !Array.isArray(parsed.codes)) return null;
  return parsed.codes.map((c: unknown) => String(c).slice(0, 40)).filter(Boolean).slice(0, 12);
};

export const imageSearchAsk: ImageSearchAsk = async ({ image }) => {
  const base64 = image.replace(/^data:image\/[a-z+]+;base64,/i, "");
  return base64 ? await searchEbayByImage(base64) : null;
};
