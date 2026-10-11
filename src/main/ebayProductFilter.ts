// "Only the product I asked for" filter for eBay search results.
//
// eBay's keyword search is generous: searching "xbox series x" also returns
// games for it, controllers, SSD/storage expansion cards, replacement power
// supplies, skins... every one of which contains all the search words, so the
// title matching in scorer.ts (which asks "does the title contain the words")
// can't tell them from the console. The Facebook side catches these with a
// photo check; eBay results are plain API data with no photo pass, so this
// filter does the job from what eBay already tells us for free:
//
//   1. Which category the PRODUCT lives in. eBay's Taxonomy API names the
//      category a seller would file the query under ("xbox series x" -> Video
//      Game Consoles). A result filed in an accessory / parts / games category
//      instead is dropped outright; this is the generic version of "only look
//      at consoles" for ANY search.
//   2. Titles written as "<thing> for <product>" / "compatible with
//      <product>" are accessories by definition, whatever category they're in.
//   3. A title that doesn't match the exact product (a different model such as
//      "Series S" for "Series X", or "Pro Max" for "Pro") is dropped using the
//      same title rules the rest of the app uses to recognize a tracked item.
//   4. Whatever is left gets a cheap, cached yes/no from the AI: "is the thing
//      being sold the product itself?" (with the category and price as context). The category alone isn't enough:
//      some products' PARTS live in the product's own category (AirPods charging
//      cases, single earbuds), while some real bundles are filed elsewhere (a
//      console bundle under "Mixed Lots"). One call per listing, remembered.
//
// Listings dropped here are NOT saved, so they never reach the Feed.
import type { SearchItem } from "./types.js";
import { isLowAiMode } from "./aiMode.js";
import { getEbayCategorySuggestions, type EbayCategory, type EbayRawItem } from "./ebayClient.js";
import { callAI, getSearchTerms, matchSearchItem, titleContainsAllWords } from "./scorer.js";

// --- Rule 2: "<thing> for <product>" ------------------------------------------
const CONNECTOR_RE = /\b(?:for|fits?|compatible with|compatible for|works with|designed for|made for|replacement for|use with|supports?)\b/g;

function containsWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
}

/**
 * True when the title offers something FOR the product rather than the product
 * itself: after a connector like "for" / "compatible with" comes the whole
 * product phrase, while nothing before it is (part of) the product. So
 * "1TB SSD for Xbox Series X" and "Case compatible with Xbox Series X" are
 * caught, but "Xbox Series X Console - great for gaming" (product first) and
 * "Controller for Xbox Series X" when the search itself is for that controller
 * are not.
 */
export function isMadeForTarget(title: string, terms: string[]): boolean {
  const lower = title.toLowerCase();
  for (const term of terms) {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const re = new RegExp(CONNECTOR_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const before = lower.slice(0, m.index);
      const after = lower.slice(m.index + m[0].length);
      if (!titleContainsAllWords(after, term)) continue; // the product isn't what follows
      if (words.some((w) => containsWord(before, w))) continue; // what comes first IS (part of) the product
      return true;
    }
  }
  return false;
}

// --- Category-name shortcuts (save AI calls on obvious non-products) -----------
// Tested against ALL names in a result's category chain, EXCEPT when the
// searched product's own category is itself that kind of category (someone
// hunting for accessories or parts shouldn't have those filtered out).
const ACCESSORY_CATEGORY_RE = /accessor|replacement|\bparts\b|attachments|\bcases?\b|\bcovers?\b|\bskins?\b|\bdecals?\b|chargers?|\bcables?\b|adapters?|protectors?|\bmounts?\b|\bstands?\b|\bbags?\b/i;
// Tested against the LEAF category name only (the chain's root, e.g. "Video
// Games & Consoles", is shared by everything and would match everything).
const MEDIA_LEAF_RE = /^(video )?games?$|^software$|movies?|\bbooks?\b|\bmusic\b|merchandise|trading cards?|memorabilia/i;

// --- Rule 4: the AI yes/no -----------------------------------------------------
const MAX_AI_JUDGMENTS_PER_SEARCH = 60;
const AI_CONCURRENCY = 6;
const VERDICT_CACHE_MAX = 5_000;
const CATEGORY_CACHE_MS = 24 * 60 * 60_000;
const CATEGORY_MISS_RETRY_MS = 30 * 60_000;

function buildPrompt(target: SearchItem, primary: EbayCategory | null, raw: EbayRawItem): string {
  const chain = raw.categories.map((c) => c.name).filter(Boolean).join(" > ") || "unknown";
  return `You are filtering eBay search results for a reseller who is hunting for ONE specific product.

Product being hunted: "${target.item}"${primary ? `\nWhere eBay normally files this product: "${primary.name}"` : ""}

Listing title: ${raw.title}
Listing category: ${chain}
Price: ${raw.priceValue ? `$${raw.priceValue}` : "unknown"}
Condition: ${raw.condition ?? "unknown"}

Is the item being SOLD in this listing the hunted product itself?
Answer true if it is the product (any condition, including broken or for-parts units), or a bundle in which the hunted product itself is the main item together with extras such as controllers or games.
Answer false if it is mainly: an accessory (controller, case, cable, charger, stand, dock, headset, skin, storage / SSD / memory card), a replacement part or repair component, only PART of the product (a single earbud, a charging case on its own, one Joy-Con, a disc drive, a screen, a battery), a game, software or other media, something that is merely compatible with or made for the hunted product, merchandise, or just a box / manual.
Do NOT answer false because of edition, color, storage size, age, condition or a low price: used units legitimately sell far below new prices, and the exact model has already been checked. Decide only whether the item is the product (or a bundle containing it) versus a part, accessory, game or other related item.

Respond with ONLY JSON, no other text: {"isProduct": boolean, "reason": "<8 words max>"}`;
}

function parseVerdict(text: string): boolean | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return typeof parsed.isProduct === "boolean" ? parsed.isProduct : null;
  } catch {
    return null;
  }
}

export type DropReason = "made-for-product" | "wrong-category" | "not-the-product" | "unverified";

export interface FilterResult {
  kept: EbayRawItem[];
  dropped: Array<{ raw: EbayRawItem; reason: DropReason }>;
}

export class EbayProductFilter {
  private categories = new Map<string, { category: EbayCategory | null; at: number }>();
  // itemId + search -> verdict. In memory only: a restart re-asks once per
  // current result, which costs next to nothing.
  private verdicts = new Map<string, boolean>();

  /** The category eBay files this search query under (top Taxonomy suggestion), or null if unknown. */
  async primaryCategory(query: string): Promise<EbayCategory | null> {
    const key = query.trim().toLowerCase();
    const hit = this.categories.get(key);
    if (hit) {
      const age = Date.now() - hit.at;
      if (age < (hit.category ? CATEGORY_CACHE_MS : CATEGORY_MISS_RETRY_MS)) return hit.category;
    }
    const suggestions = await getEbayCategorySuggestions(query);
    const category = suggestions[0] ?? null;
    this.categories.set(key, { category, at: Date.now() });
    return category;
  }

  private remember(key: string, verdict: boolean): void {
    if (this.verdicts.size >= VERDICT_CACHE_MAX) {
      const oldest = this.verdicts.keys().next().value;
      if (oldest !== undefined) this.verdicts.delete(oldest);
    }
    this.verdicts.set(key, verdict);
  }

  /**
   * Splits one search's raw results into the ones that are the product itself
   * (kept) and everything else (dropped). `isKnown` lets listings the engine
   * has already processed pass straight through (its own dedup skips them) so
   * nothing is re-judged.
   */
  async filter(target: SearchItem, raws: EbayRawItem[], isKnown: (itemId: string) => boolean): Promise<FilterResult> {
    const terms = getSearchTerms(target);
    const primary = await this.primaryCategory(target.item);
    const primaryIsAccessoryLike = !!primary && ACCESSORY_CATEGORY_RE.test(primary.name);
    const primaryIsMediaLike = !!primary && MEDIA_LEAF_RE.test(primary.name);

    const kept: EbayRawItem[] = [];
    const dropped: FilterResult["dropped"] = [];
    const undecided: EbayRawItem[] = [];

    for (const raw of raws) {
      if (isKnown(raw.itemId)) {
        kept.push(raw);
        continue;
      }
      if (isMadeForTarget(raw.title, terms)) {
        dropped.push({ raw, reason: "made-for-product" });
        continue;
      }
      // The exact-product title test the rest of the app uses to recognize a
      // tracked item (all the words, no unrequested variant like "Pro Max" /
      // "Series S", no "case only"-style phrase). A result that fails it is a
      // different model or something else entirely — no need to ask the AI.
      if (matchSearchItem(raw.title, [target]) === null) {
        dropped.push({ raw, reason: "not-the-product" });
        continue;
      }
      const inPrimary = !!primary && raw.categories.some((c) => c.id === primary.id);
      // Filed in an accessory / parts / games category (and the search itself
      // isn't for that kind of thing) — no need to ask.
      if (!inPrimary && raw.categories.length) {
        const leaf = raw.categories[0].name;
        const accessoryCategory = !primaryIsAccessoryLike && raw.categories.some((c) => ACCESSORY_CATEGORY_RE.test(c.name));
        const mediaCategory = !primaryIsMediaLike && MEDIA_LEAF_RE.test(leaf);
        if (accessoryCategory || mediaCategory) {
          dropped.push({ raw, reason: "wrong-category" });
          continue;
        }
      }
      undecided.push(raw);
    }

    // The AI yes/no for the rest — cached per listing, bounded per search, a few at a time.
    // If the AI can't answer (outage, no access, over this search's budget), the
    // listing isn't remembered either way: one filed in the product's OWN
    // category is let through on the category's say-so (so eBay keeps working
    // through an outage), anything else is held back until it can be checked.
    const unanswered = (raw: EbayRawItem): void => {
      if (primary && raw.categories.some((c) => c.id === primary.id)) kept.push(raw);
      else dropped.push({ raw, reason: "unverified" });
    };
    const queue = undecided.slice();
    let judged = 0;
    const worker = async (): Promise<void> => {
      while (queue.length) {
        const raw = queue.shift()!;
        const key = `${target.item.toLowerCase()}|${raw.itemId}`;
        let verdict = this.verdicts.get(key);
        if (verdict === undefined) {
          if (judged >= (isLowAiMode() ? 0 : MAX_AI_JUDGMENTS_PER_SEARCH)) {
            unanswered(raw);
            continue;
          }
          judged++;
          try {
            const parsed = parseVerdict(await callAI(buildPrompt(target, primary, raw)));
            if (parsed === null) {
              unanswered(raw);
              continue;
            }
            verdict = parsed;
            this.remember(key, parsed);
          } catch {
            unanswered(raw);
            continue;
          }
        }
        if (verdict) kept.push(raw);
        else dropped.push({ raw, reason: "not-the-product" });
      }
    };
    await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, queue.length) }, worker));

    // Keep eBay's own relevance order.
    const order = new Map(raws.map((r, i) => [r.itemId, i]));
    kept.sort((a, b) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0));
    return { kept, dropped };
  }
}

const REASON_LABELS: Record<DropReason, string> = {
  "made-for-product": "made for it (accessories)",
  "wrong-category": "games / parts / accessories",
  "not-the-product": "not the product itself",
  unverified: "couldn't be verified yet",
};

/** One-line summary of what was filtered out, for the Activity log. */
export function summarizeDropped(dropped: FilterResult["dropped"]): string {
  const counts = new Map<DropReason, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  const parts = [...counts.entries()].map(([reason, n]) => `${n} ${REASON_LABELS[reason]}`);
  const examples = dropped
    .slice(0, 2)
    .map((d) => `"${d.raw.title.length > 60 ? d.raw.title.slice(0, 57) + "..." : d.raw.title}"`);
  return `${parts.join(", ")}${examples.length ? ` — e.g. ${examples.join(", ")}` : ""}`;
}
