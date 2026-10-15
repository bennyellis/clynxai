import { generateProductSummary, generateProductSummaryFromWeb } from "./chat.js";
import { researchProductOnWeb, findProductImage } from "./webResearch.js";
import { OPENAI_MODEL, callOpenAI } from "./openai.js";
import { VARIANT_QUALIFIER_WORDS } from "./scorer.js";
import type { VariantVerdict } from "./variantEvidence.js";

const KEYWORD_EXPANSION_TIMEOUT_MS = 15_000;

function variantWordsIn(text: string): Set<string> {
  const lower = text.toLowerCase();
  return new Set(VARIANT_QUALIFIER_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)));
}

function sameVariantMembership(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
}

// Per explicit instruction — "the ai needs to be able to recognize shorter
// versions or abbreviations of products along with different variants...
// apply that logic to any product if needed." Root-caused live: a listing
// titled with the full spelled-out name ("Sony PlayStation 5 Console")
// never matched a Search For item added as the common abbreviation ("ps5")
// — scorer.ts's titleContainsAllWords requires every WORD of a search
// phrase to appear in the title, and "ps5" literally never appears verbatim
// in a spelled-out title. That's not a gap in the matching logic itself —
// matchSearchItem/isRelevantToSearchItems/findGreenFlagCandidate already
// treat every entry in a SearchItem's matchKeywords as an independent OR
// alternative (see scorer.ts's getSearchTerms) — the gap was that Dashboard's
// quick-add box (see index.ts's search:addProducts) only ever put the one
// literal typed phrase in that array, with nothing feeding it alternates.
// This asks the AI for other real-world phrasings of the SAME product
// (abbreviation <-> spelled-out name, common nicknames), all of which land
// in the same item's matchKeywords.
//
// Deliberately conservative about variants: hasUnrequestedVariant
// (scorer.ts) depends on a base item's matchKeywords NEVER accidentally
// containing a tier/variant qualifier word (Pro/Slim/Max/etc.) that wasn't
// actually asked for — that's the entire mechanism keeping a plain "PS5"
// search from also matching a "PS5 Pro" listing (a real, previously-fixed
// bug this session). So every candidate the AI returns is checked against
// the ORIGINAL term's own variant-word membership (same qualifiers present,
// same ones absent) before being trusted — anything that adds or drops one,
// however plausible-sounding, is thrown out rather than risk silently
// disabling that protection. Best-effort like every other AI call in this
// app: any failure (no API key, timeout, bad JSON) just falls back to the
// literal typed term alone, exactly like before this feature existed.
export async function expandSearchKeywords(name: string): Promise<string[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const ownVariants = variantWordsIn(lower);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KEYWORD_EXPANSION_TIMEOUT_MS);
    // Verified live: an earlier version of this prompt asked for an
    // unbounded list ("other real phrasings..."), which the model happily
    // filled with storage-size/color/condition/carrier noise ("ps5 1tb",
    // "iphone 15 pro at&t") — harmless for matching (every extra entry is
    // just a redundant OR alternative, never a false positive), but bloats
    // matchKeywords for no benefit. Worse, verified live TWICE (with
    // reasoning_effort: "minimal" already set, the same fix everywhere
    // else this app calls OpenAI): 3 of 5 real test terms came back with
    // completely EMPTY content at max_completion_tokens: 300 — a reasoning
    // model can still burn an entire small budget on invisible reasoning
    // tokens before ever emitting the visible JSON, especially for a
    // multi-word input. Capping the ask to "up to 5 NAME-only phrasings"
    // and raising the budget to 700 fixed both: reliably non-empty across
    // every real test term tried, and a tight, genuinely useful list
    // instead of two dozen redundant variations.
    const prompt = `A reseller is searching Facebook Marketplace listing titles for "${trimmed}". List up to 5 other real NAME phrasings a seller might type for this EXACT same product and tier/variant — abbreviations, the full spelled-out name, well-known nicknames. ONLY alternate ways to write the NAME itself — never storage size, color, condition, carrier, or "for sale"/bundle wording. Do NOT add or remove any tier/variant qualifier word (like Pro, Slim, Max, Plus, Mini, Lite, SE, XL, OLED, Air) — every phrase must describe the exact same variant as "${trimmed}", never broader or narrower. Respond with ONLY a JSON object, no other text: { "keywords": string[] }, each entry lowercase, including "${trimmed}" itself as one entry.`;
    let res: Response;
    try {
      res = await callOpenAI(
        "chat",
        {
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 700,
          // gpt-5-mini is a reasoning model — silently burns the whole
          // completion-token budget on invisible reasoning tokens without
          // this, same lesson as everywhere else this app calls OpenAI. See
          // the prompt's own comment above — even WITH this set, 300 tokens
          // still weren't enough headroom for some real inputs.
          reasoning_effort: "minimal",
        },
        controller.signal
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    const candidates: string[] = Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k: unknown) => String(k).trim().toLowerCase()).filter(Boolean)
      : [];

    const safe = candidates.filter((kw) => sameVariantMembership(ownVariants, variantWordsIn(kw)));
    return Array.from(new Set([lower, ...safe]));
  } catch {
    return [lower];
  }
}

export interface ProductLookupResult {
  aiSummary: string;
  category: string;
  family: string | null;
  // See chat.ts's ProductSummaryResult.isBrandFamily — whether family's
  // top-level segment is a real, logo-able brand rather than an invented
  // grouping. index.ts's runProductLookup (which has the DB access
  // lookupProduct itself doesn't) uses this to decide whether to fetch a
  // "<brand> logo" image for the family folder's own thumbnail.
  isBrandFamily: boolean;
  imageUrl: string | null;
  // Per explicit instruction — see chat.ts's ProductSummaryResult.reaction.
  reaction: string;
  // What the evidence check found when the name claims a specific edition/configuration (null for a plain product name): see variantEvidence.ts.
  evidence: VariantVerdict | null;
}

// findProductImage now handles everything itself: downloading candidate
// URLs, vision-verifying each one (see webResearch.ts's
// findAndVerifyImage/verifyThumbnailCandidate), and returning the final
// data: URI directly — a hotlinked remote URL can silently stop rendering
// later for reasons entirely outside this app, so nothing here ever stores
// one directly. candidateUrl (researchProductOnWeb's own og:image find, if
// any) is passed in as the FIRST candidate to verify rather than trusted
// blindly — it still has to pass the same vision check as every other
// candidate. If nothing pans out, that's treated the same as never having
// found an image (null), not surfaced as a research failure — a missing
// photo shouldn't block everything else lookupProduct found.
async function resolveImage(candidateUrl: string | null, name: string): Promise<string | null> {
  return findProductImage(name, candidateUrl);
}

// A real, in-depth web search (specs/variants/common problems, plus a
// representative product photo — see webResearch.ts), not just the AI's
// own possibly-stale training knowledge. If the web search itself comes up
// empty, generateProductSummaryFromWeb quietly falls back to training-
// knowledge-only (generateProductSummary) rather than failing the whole
// lookup. Either way, resolveImage above gets its own separate shot at
// finding (and downloading) a photo — per explicit instruction, the
// product's photo is the click target for its whole Database entry now,
// not just a nice-to-have, so this makes a real effort to never leave one
// empty rather than accepting whatever the text-oriented search happened
// to find along the way.
export async function lookupProduct(name: string, opts: { verdict?: VariantVerdict | null; brandHints?: string[] } = {}): Promise<ProductLookupResult> {
  try {
    const research = await researchProductOnWeb(name, undefined, { verdict: opts.verdict ?? null, brandHints: opts.brandHints });
    const { summary, category, family, isBrandFamily, reaction } = await generateProductSummaryFromWeb(name, research.sources, research.evidence);
    const imageUrl = await resolveImage(research.imageUrl, name);
    return { aiSummary: summary, category, family, isBrandFamily, imageUrl, reaction, evidence: research.evidence };
  } catch (err) {
    try {
      const { summary, category, family, isBrandFamily, reaction } = await generateProductSummary(name, opts.verdict ?? null);
      const imageUrl = await resolveImage(null, name);
      return { aiSummary: summary, category, family, isBrandFamily, imageUrl, reaction, evidence: opts.verdict ?? null };
    } catch {
      return {
        aiSummary: `(Research failed: ${(err as Error).message})`,
        category: "Other",
        family: null,
        isBrandFamily: false,
        imageUrl: null,
        reaction: "Hit a snag researching this one — couldn't pull anything useful.",
        evidence: opts.verdict ?? null,
      };
    }
  }
}
