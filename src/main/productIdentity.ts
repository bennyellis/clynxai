// "Is this listing the SAME product as the Database entry its name matched, or a more specific model of it?"
//
// Names are matched loosely on purpose (a listing for "RTX 3060 Ti" belongs with the "NVIDIA GeForce RTX 3060 Ti"
// entry), but that also files an EVGA XC card and a Gigabyte Eagle card under one entry even though they are
// different products with different looks and prices. This adds the second look: when a listing is about to be
// filed under an existing entry and it carries details the entry's name doesn't, an AI check compares it to the
// entry (and to any specific models already filed under it) and says which one it really is. Confident matches
// proceed exactly as before; a listing that is a different specific model gets its own entry under the generic one.
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import type { ProductProfile } from "./types.js";
import { colorsIn, isColorWord } from "./colors.js";

export interface IdentityCandidate {
  id: string;
  name: string;
  summary: string;
  // Titles of listings already filed under this entry (a hint at what the entry actually holds).
  seenAs: string[];
}

export interface IdentityEvidence {
  title: string;
  description: string | null;
  imageDataUri: string | null;
}

export type IdentityConfidence = "high" | "medium" | "low";

export interface IdentityVerdict {
  decision: "match" | "new" | "generic";
  matchId: string | null;
  confidence: IdentityConfidence;
  specificName: string | null;
  reason: string;
}

export type IdentityAction =
  | { kind: "attach"; productId: string }
  // The listing is a specific model (or color) nothing in the Database describes: file it as its own entry. `parentId`
  // is the general entry it goes under (null: a top-level sibling, e.g. the white one next to the black one), and the
  // new entry joins the family of `familyFromId`.
  | { kind: "create"; name: string; parentId: string | null; familyFromId: string }
  // Not sure enough to file a photo under any entry or to invent a new one: keep the note, skip the photo.
  | { kind: "noteOnly" };

// Words that don't tell one product from another, ignored when deciding whether a listing has any detail worth checking.
const FILLER = new Set(
  (
    "a an the and or with for of in on to at by from used new like works working work great good excellent condition obo firm price sale sell selling must go " +
    "pickup pick up only local cash bundle box boxed open original owner clean tested perfect brand lot free shipping delivery no issues any comes asking " +
    "today tomorrow available cheap fast console system unit item mint barely very nice lightly gently"
  ).split(" ")
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Cheap pre-check, no AI: does the listing's title say anything the matched entry's name doesn't? "RTX 3060 Ti" for the
 * "NVIDIA GeForce RTX 3060 Ti" entry says nothing new, so no check is needed; "EVGA RTX 3060 Ti XC Gaming" does.
 */
export function listingHasExtraDetail(title: string, entryName: string, credibleCodes?: string[]): boolean {
  const entryColors = colorsIn(entryName);
  // An entry that names a color ("Xbox Series S (Black)") is a claim about color: any listing headed for it gets
  // checked (the photo shows what the title may not say).
  if (entryColors.size > 0) return true;
  // A model number / generation the title states, that evidence shows is real (identity/credibility.ts), and the entry's name lacks is always worth
  // the check, however few other words differ.
  if ((credibleCodes ?? []).length > 0) return true;
  const known = new Set(words(entryName));
  // For an entry with no color in its name, a color in the title is no detail worth a check.
  const extra = words(title).filter((w) => !known.has(w) && !FILLER.has(w) && !isColorWord(w) && !/^\d{1,2}$/.test(w));
  return extra.length >= 2;
}

/** Turns the AI's verdict into what to do with the listing. Pure, so the policy can be tested without the AI. */
export function decideIdentityAction(
  verdict: IdentityVerdict | null,
  candidates: IdentityCandidate[],
  fallbackProductId: string,
  parentId: string | null,
  familyFromId: string
): IdentityAction {
  // No verdict (no API key, AI hiccup) or nothing to tell it apart by: normal protocol, as before this check existed.
  if (!verdict || verdict.decision === "generic") return { kind: "attach", productId: fallbackProductId };

  const named = verdict.specificName?.trim() || null;
  if (verdict.decision === "match") {
    const target = candidates.find((c) => c.id === verdict.matchId);
    if (!target) return { kind: "attach", productId: fallbackProductId };
    if (verdict.confidence === "high") return { kind: "attach", productId: target.id };
    // Not sure it's that entry: a more suitable one (a new, more specific entry) if it can be named, else leave the gallery alone.
    return named ? { kind: "create", name: named, parentId, familyFromId } : { kind: "noteOnly" };
  }

  // "new": a specific product no entry describes.
  if (!named) return { kind: "noteOnly" };
  // An existing entry already carries that name: use it rather than making a twin.
  const twin = candidates.find((c) => c.name.toLowerCase() === named.toLowerCase());
  if (twin) return { kind: "attach", productId: twin.id };
  if (verdict.confidence === "low") return { kind: "noteOnly" };
  return { kind: "create", name: named, parentId, familyFromId };
}

const IDENTITY_TIMEOUT_MS = 30_000;

export async function judgeProductIdentity(evidence: IdentityEvidence, candidates: IdentityCandidate[]): Promise<IdentityVerdict | null> {
  try {
    ensureOpenAIAccess();
  } catch {
    return null;
  }

  const colorEntries = candidates.filter((c) => colorsIn(c.name).size > 0);
  const colorRule = colorEntries.length
    ? `\nCOLOR MATTERS HERE: ${colorEntries.map((c) => `"${c.name}"`).join(", ")} name${colorEntries.length === 1 ? "s" : ""} a color, so entries are kept apart by color (a white console and a black console are different entries; they sell and look different). A listing in a different color than an entry names is NOT that entry. Judge the color from the PHOTO first (titles often omit it), then the text. If the listing is the same product in a color no entry has, answer "new" and set specificName to that entry's name with ONLY the color swapped, keeping every other word exactly as written (e.g. "Xbox Series S (White)" for "Xbox Series S (Black)") so the same product in one color always gets the same name. If you cannot tell the color from the photo or the text, answer "match" with confidence "low" so it isn't filed in the wrong place.\n`
    : "";
  const entries = candidates
    .map((c, i) => {
      const seen = c.seenAs.length ? `\n    listings already filed here: ${c.seenAs.map((t) => `"${t.slice(0, 90)}"`).join("; ")}` : "";
      return `[${i}] id=${c.id} name="${c.name}"${c.summary ? `\n    about: ${c.summary.slice(0, 220)}` : ""}${seen}`;
    })
    .join("\n");

  const prompt = `A reseller keeps a product Database. A Facebook Marketplace listing was matched BY NAME to the first entry below ([0], the general one); any further entries are more specific models already filed under it.

Database entries:
${entries}

The listing:
Title: "${evidence.title}"
Description: "${(evidence.description ?? "").slice(0, 600) || "(none)"}"
${evidence.imageDataUri ? "A photo from the listing is attached." : "(no photo)"}

Decide what this listing IS. What makes something a DIFFERENT product (different price, different look): the manufacturer/brand (partner cards like EVGA vs Gigabyte are different products even with the same chip), the exact model or product line, capacity/size, generation, and special editions or different bundles. NOT different: condition, seller wording, minor accessories. Color is not a difference EXCEPT where the entries below name a color.${colorRule}

Answer with ONLY a JSON object:
{ "decision": "match" | "new" | "generic", "matchId": string | null, "confidence": "high" | "medium" | "low", "specificName": string | null, "reason": string }
- "match": the listing is exactly the product of one entry; matchId is that entry's id. Use confidence "high" only when the title/description/photo clearly shows it is that specific product.
- "new": the listing is a specific product (named brand/model/capacity/edition) that NO entry describes. specificName is the full name a retailer would list it under (brand + model line + the spec that matters, e.g. "EVGA GeForce RTX 3060 Ti XC Gaming 8GB"), with no condition or seller words.
- "generic": the listing only identifies the general product and gives no brand/model detail to tell it apart, so filing it under entry [0] is fine.
Never guess a brand or model you can't support from the title, description or photo; when you can't tell, answer "generic".`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  if (evidence.imageDataUri) content.push({ type: "image_url", image_url: { url: evidence.imageDataUri } });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 600,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      },
      controller.signal
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text);
    const decision = parsed.decision === "match" || parsed.decision === "new" || parsed.decision === "generic" ? parsed.decision : null;
    if (!decision) return null;
    const confidence: IdentityConfidence = parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low";
    return {
      decision,
      matchId: typeof parsed.matchId === "string" ? parsed.matchId : null,
      confidence,
      specificName: typeof parsed.specificName === "string" && parsed.specificName.trim() ? parsed.specificName.trim().slice(0, 120) : null,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface IdentityStore {
  getProductById(id: string): ProductProfile | null;
  listProductChildren(parentId: string): ProductProfile[];
  listProductsSharingBase(name: string, excludeId?: string): ProductProfile[];
  listProductPhotoTitles(productId: string, limit: number): string[];
  // The codes the title states beyond the entry's name that evidence shows are real markers (optional: without it only the word count decides).
  credibleCodes?(entryId: string, entryName: string, title: string): string[];
}

/**
 * The whole second look, for a listing that was matched by name to `existing`: skips straight to "attach" (no AI call)
 * when the listing says nothing the entry's name doesn't, otherwise asks the AI and applies decideIdentityAction.
 * `verdict` is returned so the caller can log why.
 */
export async function resolveIdentityTarget(
  store: IdentityStore,
  existing: ProductProfile,
  evidence: IdentityEvidence
): Promise<{ action: IdentityAction; verdict: IdentityVerdict | null }> {
  const attach: IdentityAction = { kind: "attach", productId: existing.id };
  if (!listingHasExtraDetail(evidence.title, existing.name, store.credibleCodes?.(existing.id, existing.name, evidence.title))) return { action: attach, verdict: null };

  // The general entry and the specific models already filed under it (an entry that is itself a specific model
  // is judged against its own siblings too).
  const root = (existing.parentProductId ? store.getProductById(existing.parentProductId) : null) ?? existing;
  // ...plus the entries that are the same product in another color (the black and the white Xbox Series S).
  const known = new Set<string>();
  const entries: ProductProfile[] = [];
  for (const p of [root, ...store.listProductChildren(root.id), ...store.listProductsSharingBase(root.name, root.id)]) {
    if (!known.has(p.id)) {
      known.add(p.id);
      entries.push(p);
    }
  }
  const candidates: IdentityCandidate[] = entries.map((p) => ({
    id: p.id,
    name: p.name,
    summary: p.aiSummary,
    seenAs: store.listProductPhotoTitles(p.id, 4),
  }));
  const verdict = await judgeProductIdentity(evidence, candidates);
  // A new specific model goes under the general entry; a new COLOR of an entry that is itself a specific color
  // (the white one next to the black one) goes next to it instead, not under it.
  const createUnder = colorsIn(root.name).size > 0 ? root.parentProductId : root.id;
  return { action: decideIdentityAction(verdict, candidates, existing.id, createUnder, root.id), verdict };
}
