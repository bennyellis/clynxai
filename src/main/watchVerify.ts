// "High-confidence items only": before a Facebook Watch reports a listing, a cheap
// yes/no AI check confirms it is really selling the product the Watch is looking
// for (not an accessory, a part, a game for it, a different model, a wanted ad...),
// and only a HIGH-confidence yes counts. Run only on listings that have already
// passed the free checks (price, title match, area), and remembered per listing and
// term so the same listing is never judged twice.
import { callAI } from "./scorer.js";

export interface VerifyResult {
  // True when the listing counts as the product.
  match: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  // The check itself couldn't run (no API key, a timeout...). The caller decides
  // what that means; the Watch lets a strong title match through and logs it.
  unavailable?: boolean;
}

export interface VerifyInput {
  id: string;
  title: string;
  description: string | null;
  price: number | null;
}

const cache = new Map<string, VerifyResult>();
const CACHE_LIMIT = 2000;

export function buildVerifyPrompt(term: string, listing: VerifyInput): string {
  const description = (listing.description ?? "").replace(/\s+/g, " ").trim().slice(0, 700);
  return `Someone is watching Facebook Marketplace for: "${term}".
Decide whether the listing below is SELLING that product itself.
It does NOT count if it is an accessory, case, cover, charger, part, replacement piece, a game or app for it, a different model/size/generation/variant than the one named, a bundle that is mainly something else, a "wanted"/looking-to-buy post, or a service.
Only say "high" confidence when the title and description clearly agree it is that exact product.

Title: ${listing.title}
Price: ${listing.price === null ? "unknown" : `$${listing.price}`}
Description: ${description || "(none)"}

Respond with ONLY a JSON object, no other text:
{ "match": boolean, "confidence": "high" | "medium" | "low", "reason": string }`;
}

export function parseVerifyResponse(text: string): VerifyResult | null {
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json[0]);
    if (typeof parsed.match !== "boolean") return null;
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low" ? parsed.confidence : "low";
    return { match: parsed.match, confidence, reason: String(parsed.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

/** True when the result is good enough for a Watch to report: a confident yes. */
export function isConfidentMatch(result: VerifyResult): boolean {
  return result.match && result.confidence === "high";
}

export async function verifyWatchProduct(term: string, listing: VerifyInput, ask: (prompt: string) => Promise<string> = callAI): Promise<VerifyResult> {
  const key = `${listing.id}|${term.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: VerifyResult;
  try {
    const parsed = parseVerifyResponse(await ask(buildVerifyPrompt(term, listing)));
    result = parsed ?? { match: false, confidence: "low", reason: "Clynx's answer couldn't be read", unavailable: true };
  } catch (err) {
    result = { match: false, confidence: "low", reason: (err as Error).message, unavailable: true };
  }
  // A check that couldn't run isn't remembered: it should be tried again next time.
  if (!result.unavailable) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, result);
  }
  return result;
}

export function clearVerifyCacheForTests(): void {
  cache.clear();
}
