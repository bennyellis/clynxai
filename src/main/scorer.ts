import type { EngineConfig, ExtractionResult, FeedbackExample, ListingDetail, SearchItem, ScoredListing } from "./types.js";
import { CLYNX_VOICE } from "./voice.js";
import { looksBroken } from "./brokenVariant.js";
import { conditionTextOf } from "./listingText.js";
import { detectConditionImpactText, type ConditionImpact } from "./conditionParser.js";
import { withinNegotiationReach } from "./profitGate.js";
import { modelLettersConflict } from "./compFilter.js";
import { DEFAULT_RESALE_SETTINGS, isGoodResale, keepRangeUsd, resaleOutcome, resaleSettingsFrom, type ResaleSettings } from "./resaleMath.js";
import { OPENAI_MODEL, callOpenAI, hasOpenAIAccess } from "./openai.js";

// If you didn't separately fill in match keywords, fall back to the item
// name itself — otherwise an item added with just a name and price (the
// natural thing to do) would silently match nothing and never get
// actively searched either, since both of those need at least one term
// to work with. This is the actual terms used everywhere below, not
// item.matchKeywords directly.
export function getSearchTerms(item: SearchItem): string[] {
  return item.matchKeywords.length ? item.matchKeywords : item.item.trim() ? [item.item.trim()] : [];
}

// Bug fix (verified live: "it's not searching up what i input at all... it
// needs to be accurate") — this is a DIFFERENT job from getSearchTerms
// above, which deliberately stays a flexible, unordered SET of phrases for
// MATCHING an already-found listing's title (matchSearchItem/
// isRelevantToSearchItems/findGreenFlagCandidate all want that breadth).
// The literal query typed into Facebook's OWN search bar needs the single
// most accurate, specific phrase instead — that's `item` itself: the AI's
// "Display name" field (explicitly instructed to closely mirror the exact
// product asked for, e.g. "PS5 Slim Digital 1TB"), or, via the Dashboard's
// own Add Product box, the user's literal typed text verbatim. Using
// matchKeywords[0] for this (what every active-search call site used to
// do) types whatever phrase the AI happened to list FIRST in an array it
// was only ever asked to make broad, not ordered — which can easily be
// more generic than what was actually asked for. Falls back to the first
// match keyword only in the (should-be-impossible, since both fields are
// required) case item.item is somehow empty.
export function getSearchQuery(item: SearchItem): string {
  return item.item.trim() || getSearchTerms(item)[0] || "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A listing title matches a keyword phrase when every WORD in that phrase
// shows up somewhere in the title, in any order — not the literal phrase
// as a contiguous substring. "Series X Xbox Console 1TB" should match a
// search for "xbox series x" just as much as "Xbox Series X Console"
// does; sellers don't all write titles the same way, and requiring exact
// word order was throwing out real matches over nothing but word ordering.
// Word-boundary matched (not a plain substring test) so a short token like
// the "x" in "series x" only matches itself, not any word that happens to
// contain an x.
export function titleContainsAllWords(lowerTitle: string, phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lowerTitle));
}

// Per explicit instruction — "make sure when searching for a specific
// product the AI finds ONLY that specific product or products that have a
// >80% similarity." Phrases that, when present in a LISTING title, are a
// strong deterministic signal this is an ACCESSORY/PART for the tracked
// item rather than the item itself — a case, a single cable, a controller
// sold on its own — which titleContainsAllWords below can't tell apart
// from the real thing, since "Xbox Series X Controller (no console)" still
// contains every word of a plain "xbox series x" search. Deliberately
// requires an explicit exclusive/standalone qualifier ("case ONLY", "no
// console", etc.) rather than the bare accessory word alone (just "case"
// or "controller") — a genuine console bundle that happens to mention
// included accessories ("Xbox Series X with controller and cables") must
// still match. `concept` (when set) is checked against THIS item's own
// search terms first — if you're deliberately tracking "Xbox controller"
// as its own Search For item, a "Controller Only" listing is exactly what
// you asked for, not a mismatch; only reject when the accessory concept
// ISN'T something this specific item's own terms already cover. The real,
// high-confidence similarity check happens on photos (see vision.ts's
// matchesClaim, tightened to the same >80% bar and already running on
// nearly every real listing) — this is a zero-cost, always-on safety net
// for the rarer case where a listing has no photos to check at all, or
// photo analysis is turned off.
const ACCESSORY_ONLY_TITLE_SIGNALS: Array<{ phrase: string; concept: string | null }> = [
  { phrase: "case only", concept: "case" },
  { phrase: "cover only", concept: "cover" },
  { phrase: "skin only", concept: "skin" },
  { phrase: "cable only", concept: "cable" },
  { phrase: "cord only", concept: "cord" },
  { phrase: "charger only", concept: "charger" },
  { phrase: "adapter only", concept: "adapter" },
  { phrase: "controller only", concept: "controller" },
  { phrase: "remote only", concept: "remote" },
  { phrase: "box only", concept: "box" },
  { phrase: "manual only", concept: "manual" },
  { phrase: "sticker only", concept: "sticker" },
  { phrase: "decal only", concept: "decal" },
  { phrase: "strap only", concept: "strap" },
  { phrase: "stand only", concept: "stand" },
  { phrase: "dock only", concept: "dock" },
  { phrase: "mount only", concept: "mount" },
  { phrase: "accessories only", concept: "accessories" },
  { phrase: "accessory only", concept: "accessory" },
  // No sensible "concept" a Search For item could legitimately BE — always
  // a mismatch signal regardless of what's being searched for.
  { phrase: "no console", concept: null },
  { phrase: "console not included", concept: null },
  { phrase: "console excluded", concept: null },
  { phrase: "without console", concept: null },
  { phrase: "parts only", concept: null },
  { phrase: "for parts only", concept: null },
  { phrase: "empty box", concept: null },
  { phrase: "box empty", concept: null },
];

// A signal phrase counts only when its words appear TOGETHER and in order, as
// the phrase itself ("case only", "no console"). The plain all-the-words test
// used for search terms would also fire on "Console ONLY - NO CONTROLLERS"
// (it contains "no" and "console" somewhere), throwing out a genuine
// console-only listing.
function titleContainsPhrase(lowerTitle: string, phrase: string): boolean {
  const pattern = phrase.split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s+");
  return new RegExp(`\\b${pattern}\\b`).test(lowerTitle);
}

function isAccessoryOnlyMismatch(lowerTitle: string, itemTerms: string[], allowBroken = false): boolean {
  return ACCESSORY_ONLY_TITLE_SIGNALS.some(({ phrase, concept }) => {
    // "for parts only" is how sellers say the item itself is broken: wanted when the search includes broken listings.
    if (allowBroken && (phrase === "parts only" || phrase === "for parts only")) return false;
    if (!titleContainsPhrase(lowerTitle, phrase)) return false;
    if (concept === null) return true;
    const conceptRe = new RegExp(`\\b${concept}\\b`, "i");
    return !itemTerms.some((kw) => conceptRe.test(kw));
  });
}

// Per explicit instruction — "will it be able to tell slight but big
// differences in products... a playstation 5 and a playstation 5 pro are
// similar in words... vastly different in price": titleContainsAllWords
// only checks that the TITLE contains every word of the search phrase — it
// says nothing about the reverse, so a title with EXTRA distinguishing
// words (a real, named tier/variant) satisfies a match against the plainer
// base item just as readily as the base model itself. A search for "PS5"
// or "PlayStation 5" would otherwise strict-match "PS5 Pro" — a
// substantially different, pricier console — exactly as confidently as an
// actual base PS5 listing. Same failure shape as the accessory-only check
// above, just for "this is actually a different, named variant" instead of
// "this is only a part of the item" — and deterministic rather than sent
// to vision, since a variant name in the title is already a confident,
// unambiguous textual signal, not something that needs a photo to
// resolve. Only trips when the search item's OWN terms don't already ask
// for that specific variant — tracking "PS5 Pro" itself should obviously
// still match "PS5 Pro" listings.
//
// "slim" is deliberately NOT on this list, per direct follow-up
// correction: unlike Pro, a Slim redesign runs "similarly priced... some
// people just have a preference," not a different price tier — treating
// it the same as Pro was over-broad, and for PS5 specifically the Slim
// redesign IS the current standard retail model, so excluding it was
// rejecting the majority of genuine, correctly-priced listings outright
// (verified live: "searched ps5... decided to look at nothing"). A
// plain "PS5"/"PlayStation 5" search now matches Slim listings normally;
// only a genuinely different-price-tier variant name should ever land on
// this list.
// Exported so products.ts's expandSearchKeywords can enforce the same
// "never add/drop a variant word" safety rule when generating alternate
// phrasings for a Search For item — see that function's own doc comment.
export const VARIANT_QUALIFIER_WORDS = ["pro", "max", "plus", "mini", "lite", "se", "xl", "oled", "air"];

function hasUnrequestedVariant(lowerTitle: string, itemTerms: string[]): boolean {
  const itemWords = new Set(itemTerms.flatMap((t) => t.toLowerCase().split(/\s+/)));
  return VARIANT_QUALIFIER_WORDS.some((q) => !itemWords.has(q) && new RegExp(`\\b${q}\\b`).test(lowerTitle));
}

// Deterministic keyword match against your Search For list. Deliberately
// NOT delegated to the AI: matching "does this title contain 'iphone 15'"
// needs no model, and keeping it in code means the dollar figures you
// configure are the only source of pricing truth — the model never gets a
// chance to substitute its own (unverifiable, possibly stale) idea of what
// these items are worth.
//
// Per explicit instruction — verified live as the actual root cause of "it
// searches once, then stops recognizing it": this USED TO also require
// typicalResaleUsd > 0, skipping any item added without a price (the
// default for anything added via chat or the Dashboard's own "Search for
// Products" box without stating one — see index.ts's search:addProducts).
// Since matchSearchItem returning null is what scoreListing uses to decide
// whether a listing is even ABOUT a tracked item at all, a price-less
// search item could never be recognized as a match on ANY subsequent
// listing — every one silently fell through to the unrelated general-deal
// pathway instead, which is why only the very first (chat-triggered,
// one-off searchForItemNow) listing ever seemed to "count." Matching no
// longer depends on having a price — see scoreListing's search pathway
// below for how a still-price-less match now gets judged.
export function matchSearchItem(title: string, searchItems: SearchItem[]): SearchItem | null {
  const lower = title.toLowerCase();
  let best: SearchItem | null = null;
  let bestLen = 0;
  for (const ref of searchItems) {
    const terms = getSearchTerms(ref);
    if (isAccessoryOnlyMismatch(lower, terms, !!ref.includeBroken)) continue;
    if (hasUnrequestedVariant(lower, terms)) continue;
    for (const kw of terms) {
      if (titleContainsAllWords(lower, kw) && !modelLettersConflict(kw, lower) && kw.length > bestLen) {
        best = ref;
        bestLen = kw.length;
      }
    }
  }
  return best;
}

// Looser than matchSearchItem above on purpose: that function also
// requires a real typicalResaleUsd, since its job is finding a reference
// PRICE for discount math — a search item you just added via chat with no
// price set yet would always fail it, even though it's exactly what you
// asked to look for. This only answers "is this title even about
// something on the Search For list," with no price requirement, for use
// as a pre-filter before a listing's detail page is opened at all (see
// scrapeEngine.ts) — using the stricter price-gated version here would
// silently skip every listing, including genuine matches, whenever a
// tracked item's price hadn't been filled in yet.
export function isRelevantToSearchItems(title: string, searchItems: SearchItem[]): boolean {
  const lower = title.toLowerCase();
  return searchItems.some((ref) => {
    const terms = getSearchTerms(ref);
    if (hasUnrequestedVariant(lower, terms)) return false;
    return terms.some((kw) => titleContainsAllWords(lower, kw) && !modelLettersConflict(kw, lower));
  });
}

// Generic connector words only — NOT product-variant words like "series",
// "slim", "pro", "max", "plus", "edition", or "digital", which used to be
// stopworded here too. Verified live as the actual root cause of "it
// mostly finds things that contain 'xbox,' not xbox series x consoles":
// with "series" stopworded AND single-character words like "x" filtered
// out by the old length>1 check below, a search for "xbox series x" had
// exactly ONE checkable word left — "xbox" — so literally every Xbox One,
// Xbox 360, and Xbox accessory listing counted as a "green flag" worth a
// full detail-page-and-vision evaluation, purely for sharing the brand
// name. "Series"/"Slim"/"Pro"/etc. are exactly the words that actually
// DISTINGUISH one product from a sibling (Series X vs Series S, PS5 vs PS5
// Slim, iPhone 15 vs iPhone 15 Pro) and now count as real, specific words
// for the match below, same as "console"/"bundle"/"lot"/"set" (genuinely
// generic marketplace-listing filler, not product identity) staying
// excluded.
const GREEN_FLAG_STOPWORDS = new Set(["the", "and", "for", "with", "of", "a", "an", "new", "used", "bundle", "lot", "set", "console"]);

// Deliberately looser than matchSearchItem above — this is the "green
// flag" signal for a listing whose title DOESN'T cleanly match a tracked
// item (matchSearchItem already returned null for it) but is still CLOSE:
// every significant word of a keyword phrase is present in the title
// except exactly one. Verified live scenario: a seller listed an Xbox
// Series S under the (incorrect — there's no such product) title "Xbox X,"
// which shares "xbox" and "x" with a tracked "Xbox Series X" but is
// missing only "series" — one word short of a full match, worth a closer,
// AI-vision-assisted look (see scrapeEngine.ts) rather than treating it as
// unrelated. Requiring "missing exactly one," not "shares any one," is
// what excludes "Xbox One"/"Xbox 360" (sharing only "xbox," missing BOTH
// "series" and "x") while still catching the real near-miss. A phrase with
// fewer than 2 significant words (searching bare "Xbox" with no
// specifier) has no meaningful "almost matches" state — matchSearchItem's
// own strict all-words check already covers the only real match for that,
// so this never fires on it at all. No typicalResaleUsd requirement, for
// the same reason matchSearchItem above dropped it — a price-less tracked
// item still deserves the closer look; scoreListing's search pathway
// falls back to the AI's own judgment for the actual deal call when
// there's no reference price to run real discount math against.
export function findGreenFlagCandidate(title: string, searchItems: SearchItem[]): SearchItem | null {
  const lower = title.toLowerCase();
  let best: SearchItem | null = null;
  let bestMatchedCount = -1;
  for (const ref of searchItems) {
    const terms = getSearchTerms(ref);
    // A variant word the search didn't ask for (see hasUnrequestedVariant's
    // own doc comment) is a confident, deterministic "this is a different
    // product" signal on its own — never worth a closer AI-vision look,
    // unlike a genuinely ambiguous mistitling.
    if (hasUnrequestedVariant(lower, terms)) continue;
    for (const kw of terms) {
      const words = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 0 && !GREEN_FLAG_STOPWORDS.has(w));
      if (words.length < 2) continue;
      const matchedCount = words.filter((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lower)).length;
      const missing = words.length - matchedCount;
      if (missing === 1 && matchedCount > bestMatchedCount) {
        best = ref;
        bestMatchedCount = matchedCount;
      }
    }
  }
  return best;
}

// Deliberately blunt, deterministic red-flag scan — no AI call needed to
// tell whether a listing's own text is describing damage. Only trips on
// text that explicitly says something is wrong; silence about condition
// is NOT itself a red flag (most casual listings never mention condition
// either way, and treating that as suspicious would reject the majority
// of genuine listings). Split into two severities rather than one flat
// yes/no — per explicit instruction, "damaged electronics still hold
// value sometimes," and a screen crack isn't the same as "for parts only."
// A keyword scan can't grade real severity, so this is necessarily a rough
// split: "major" is for wording that suggests the item may not function at
// all; "minor" is everything else that flags a real but survivable issue.
export type { ConditionImpact } from "./conditionParser.js";

// Context-sensitive since Beta 12 (conditionParser.ts): "no damage" / "not cracked" are not damage, an accessory's crack is not the item's.
export function detectConditionImpact(text: string): ConditionImpact {
  return detectConditionImpactText(text);
}

// Per explicit instruction — a flagged condition used to disqualify a
// listing outright (isDeal forced false), full stop. That was wrong:
// damaged electronics still hold real value, sometimes a lot of it,
// especially at the kind of price a reseller is looking for in the first
// place. Now a flagged condition instead raises the bar for what counts as
// a deal, scaled by assumed severity — "major" (not working, for parts,
// dead, needs repair) assumes only about a quarter of working value
// remains; "minor" (cracked, damaged, as-is, missing an accessory) about
// 60%. A steep enough price can still clear the bar; a merely-decent price
// on flagged goods correctly won't anymore either, which is the actual
// improvement over just ignoring condition entirely.
export const CONDITION_VALUE_MULTIPLIER: Record<ConditionImpact, number> = {
  none: 1,
  minor: 0.6,
  major: 0.25,
};

export interface SearchItemPricing {
  referencePriceUsd: number;
  discountPercent: number | null;
  isDeal: boolean;
  // What the user would keep from reselling it (after eBay's cut) and the profit that leaves after paying for it.
  // null when there is no reference value to work from.
  keepUsd: number | null;
  profitUsd: number | null;
}

// What goes into the profit math besides the listing's own price.
export interface ResalePricingInput {
  // A real eBay value from the Database (sold comps + asking prices); wins over the Search For item's own typicalResaleUsd.
  valueUsd?: number | null;
  // eBay listings: what the seller charges to ship it; part of what the purchase costs.
  shippingUsd?: number | null;
  settings?: ResaleSettings;
}

// The actual "is this a deal" math for a confirmed Search For match —
// pulled out of scoreListing's search pathway below so scrapeEngine.ts can
// reuse the EXACT same calculation once a "green flag" candidate (see
// findGreenFlagCandidate) gets confirmed by photo analysis after the fact,
// rather than a mistitled listing getting priced differently than one that
// matched cleanly by title.
export function evaluateSearchItemPricing(
  candidate: SearchItem,
  price: number,
  conditionImpact: ConditionImpact,
  // This SAME candidate SearchItem's own maxPriceUsd (per-product now, not
  // a single global "max I'll pay" — see types.ts's SearchItem doc
  // comment). Anything priced above it is already skipped before ever
  // reaching this far (see scrapeEngine.ts's evaluateListing), so passing
  // it through here just means: if you've told the scanner what you're
  // willing to pay for THIS product, clearing that bar alone is enough to
  // count as a deal, even short of the resale-discount threshold below —
  // scaled down by the condition multiplier just like the discount bar, so
  // "I'll pay up to $100 for a working one" doesn't also greenlight a
  // "parts only" one at the same $100.
  maxPriceUsd: number | null,
  resale: ResalePricingInput = {}
): SearchItemPricing {
  const settings = resale.settings ?? DEFAULT_RESALE_SETTINGS;
  const referencePriceUsd = resale.valueUsd != null && resale.valueUsd > 0 ? resale.valueUsd : candidate.typicalResaleUsd;
  // Only meaningful when a real reference price is actually set —
  // referencePriceUsd of 0 (very common: the chat tool defaults to 0
  // whenever the AI isn't confident of an actual resale value) makes this
  // math divide by zero, giving -Infinity every single time. Deliberately
  // computed against the FULL (undamaged) reference price, not a
  // condition-adjusted one — so the displayed "X% under $Y" always adds up
  // against the actual reference price shown alongside it; the condition
  // adjustment below only moves the BAR this has to clear, never the
  // number itself.
  const discountPercent = referencePriceUsd > 0 ? ((referencePriceUsd - price) / referencePriceUsd) * 100 : null;

  const multiplier = CONDITION_VALUE_MULTIPLIER[conditionImpact];
  // "Within price range" has two independent ways to qualify, either is
  // sufficient: at/under the max price set for this product, OR a profitable
  // resale when a real reference value exists. The profit math is the user's
  // own: eBay takes ~13.75%, so they keep roughly 84% of what an item sells
  // for; a purchase is a deal when what it costs (price + shipping) leaves a
  // healthy margin under that. A flagged condition scales the value down
  // first (the same multiplier as the budget), so "parts only" has to be far
  // cheaper than a working one.
  const withinBudget = maxPriceUsd != null && maxPriceUsd > 0 && price <= maxPriceUsd * multiplier;
  let keepUsd: number | null = null;
  let profitUsd: number | null = null;
  let profitable = false;
  if (referencePriceUsd > 0) {
    const outcome = resaleOutcome(referencePriceUsd * multiplier, price + (resale.shippingUsd ?? 0), settings.netPercent);
    keepUsd = outcome.keepUsd;
    profitUsd = outcome.profitUsd;
    profitable = isGoodResale(outcome, settings.minMarginPercent);
  }
  // Being under the max price set for the product used to be enough by itself, even when the resale loses money after fees.
  // Now it only counts when a good deal is within reach (negotiating at most 25% below the asking price; see profitGate.ts).
  const reachable = referencePriceUsd > 0 ? withinNegotiationReach(referencePriceUsd * multiplier, price, resale.shippingUsd ?? 0, settings) : true;
  const isDeal = (withinBudget && reachable) || profitable;

  return { referencePriceUsd, discountPercent, isDeal, keepUsd, profitUsd };
}

function buildCustomInstructionsBlock(instructions: string): string {
  const trimmed = instructions.trim();
  if (!trimmed) return "";
  return `\nAdditional deal-finding criteria from the user — apply these when judging condition/desirability, but they don't change the JSON output format below:\n"""\n${trimmed}\n"""\n`;
}

// A hung network request here (no response, connection stays open) used to
// block the entire scrape loop forever — Node's fetch has no default
// timeout, and this call sits directly in the sequential per-listing
// pipeline (evaluateListing awaits scoreListing awaits this). 30s is
// generous for a single completion; past that, better to fail this one
// listing and move on than freeze indefinitely.
const OPENAI_TIMEOUT_MS = 30_000;

// Single paid provider (see openai.ts) — no more Groq/Gemini dual-provider
// fallback chain, since that existed specifically to route around scarce
// free-tier quotas a paid OpenAI account doesn't have.
export async function callAI(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 700,
        // gpt-5-mini is a reasoning model — verified live it silently burns
        // the whole completion-token budget on invisible reasoning tokens
        // (empty content, finish_reason "length") without this.
        reasoning_effort: "minimal",
      },
      controller.signal
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function extractJson(text: string): any {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}


interface GeneralDealResult {
  isPotentialDeal: boolean;
  category: string;
  estimatedValueRangeUsd: string;
  confidence: "low" | "medium" | "high";
  conditionImpact: ExtractionResult["conditionImpact"];
  reasoning: string;
  offTopicSuggestion: string | null;
  // True when no readable answer could be had at all: "no evidence", which is not the same as "looked, and it is not a deal".
  unavailable?: boolean;
}

// Per explicit instruction — the user's own thumbs-up/thumbs-down feedback
// on past listings (Feed's feedback buttons; also the whole point of
// Database's product notes) should actually steer future judgments, not
// just sit there recorded and unused. Formats store.ts's
// getFeedbackExamples as few-shot context: real precedent for what THIS
// user considers a good deal beats a generic, unconditional bar every
// listing gets held to the same way. Empty when nothing's been given yet
// (a fresh install) — omitted from the prompt entirely rather than shown
// as an empty section.
function buildFeedbackExamplesBlock(examples: FeedbackExample[]): string {
  if (!examples.length) return "";
  const lines = examples.map(
    (e) =>
      `- "${e.title}" — you previously reasoned: "${e.reasoning}" — the user marked this ${
        e.verdict === "good" ? "GOOD (a real deal worth surfacing)" : "BAD (not actually worth surfacing)"
      }${e.note ? `, noting: "${e.note}"` : ""}.`
  );
  return `\nRecent feedback this exact user has given on past listings — learn from it what THEY consider a good deal, and weigh it more heavily than a generic assumption when a new listing resembles one of these:\n${lines.join("\n")}\n`;
}

async function extractGeneralDeal(listing: ListingDetail, customInstructions: string, feedbackExamples: FeedbackExample[] = []): Promise<GeneralDealResult> {
  // eBay Browse API integration — this prompt used to hardcode "Facebook
  // Marketplace" unconditionally, which would misdescribe the listing's
  // actual source to the model for an eBay-sourced one. Fires on the
  // DEFAULT state of any Search For item with no typicalResaleUsd set yet
  // (see the caller below), not just the deferred general-browse pathway,
  // so this needed fixing from the first phase eBay listings could reach
  // scoreListing at all, not later.
  const platformLabel = listing.source === "ebay" ? "eBay" : "Facebook Marketplace";
  const prompt = `${CLYNX_VOICE}

You are scanning a ${platformLabel} listing that does NOT match anything in the reseller's Search For list. Your only job is to flag it if it looks like an unusually good deal in general — priced well below what this type of item typically sells for used, in typical condition. Be conservative: the large majority of listings should NOT be flagged, because most things AREN'T deals — but "conservative" means skeptical of a WEAK case, not skeptical of a steep discount itself. This whole business exists to find items priced well below their real value — a big gap between price and typical value is the SIGNAL you're looking for, never a reason on its own to doubt the listing or lower confidence. Verified live miss: a genuine Xbox Series S at $150 (a real, great price for it) got skipped with reasoning citing the price itself as suspicious — that's exactly the wrong instinct. Only treat a price as actually implausible (more likely a placeholder, scam, or joke listing than a real deal) when it's asking something like 5% or less of typical value — a near-total markdown, not just a steep one. A 50-80%-off price is a legitimately great, very plausible deal for a motivated seller — flag it normally, don't second-guess it for looking "too good to be true."
${buildCustomInstructionsBlock(customInstructions)}${buildFeedbackExamplesBlock(feedbackExamples)}
Resale math, since the reseller flips on eBay: eBay's fees take about 16% of a sale, so they keep roughly 84% of what an item sells for. A deal means the asking price (plus shipping, if any) is comfortably below that 84% of the item's typical eBay selling price, leaving a real profit. An item merely priced a little under its eBay value is NOT a deal once fees are taken out.

Judge this listing using only whatever the seller actually provided in the text below — do NOT lower your confidence or hold it against the listing that a model/serial number, battery/functional condition details, specific hardware variant, or photos aren't spelled out in the text; most real sellers never type that level of detail (and photos are a separate step you don't get here anyway), so its absence means nothing about whether this is a real deal — confidence should track how sure you are about the PRICE-VS-VALUE call itself, not how many extra specs happened to be typed out. Verified live miss: a used Nintendo 3DS XL in "like new" condition bundled with a game at a price well under typical resale got its OWN reasoning correctly concluding it should be flagged as a deal, then got skipped anyway purely because confidence landed at "medium" over exactly this kind of missing cosmetic detail — the deal call was right, the confidence label just shouldn't have cost it the flag. Likewise, cash-only or local-pickup-only listings (or any listing that just doesn't mention shipping either way) get judged exactly the same as any other — never let that push isPotentialDeal toward false or lower your confidence; arranging shipping directly with the seller is the buyer's job, not something to screen for here.

Per explicit instruction — real damage (cracked screen, water damage, "for parts," doesn't power on, etc.) should NEVER by itself make you say isPotentialDeal is false. Damaged electronics and other goods still hold real resale value, sometimes a lot of it. Instead, weigh the damage into your own read of what the item is actually worth in ITS current condition, then judge the asking price against THAT reduced value, same as you would for anything else — a "for parts" phone at $20 can be every bit as good a deal as a working one at $200, and a merely-scuffed item at a so-so price is not. Set conditionImpact to reflect what you found either way; it's informational context for the reasoning, not a separate veto on top of your own isPotentialDeal call.

Also check: is this listing something a mail-order reseller could never buy/resell in the first place — real estate (house/apartment for sale or rent), a job posting, a service offering (lawn care, tutoring, etc.), event tickets, a personals/community post — as opposed to a legitimate resalable physical item that's just not interesting or a deal right now? If so, suggest a short, general blacklist term/phrase that would catch this and similar listings in the future (e.g. "for rent", "apartment", "job opening", "lawn care service") — general enough to match a whole category of off-topic listings, not just this one exact title. Leave this null for anything that's a real, physical, resalable item, even if it's not a deal.

Listing title: ${listing.title}
Listing price: ${listing.price ?? "unknown"}
Listing description/page text (may be noisy, includes unrelated UI text):
"""
${listing.description.slice(0, 2000)}
"""

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "isPotentialDeal": boolean,
  "category": string,                 // brief category, e.g. "cordless power tool", "mountain bike"
  "estimatedValueRangeUsd": string,    // rough range, e.g. "150-200" — your best general estimate, not a fact
  "confidence": "low" | "medium" | "high",
  "conditionImpact": "none" | "minor" | "major" | "unknown",
  "reasoning": string,                // why this is (or isn't) a deal, based on price/condition/what the seller actually said — do NOT frame missing model/serial numbers, missing accessory detail, or cash/local-pickup-only as a shortcoming of the listing
  "offTopicSuggestion": string | null // see above — null for any real resalable item
}`;

  try {
    // An answer that arrives but cannot be read is usually a one-off (the model wrapped it in prose, or cut it short): one more
    // try is cheap and used to be the difference between "never looked at again" and a normal verdict. An error from the service
    // itself (no key, a limit, a timeout) is not retried: asking again would only fail again, or spend more.
    let parsed: any;
    for (let attempt = 0; ; attempt++) {
      try {
        parsed = extractJson(await callAI(prompt));
        break;
      } catch (err) {
        if (!(err instanceof SyntaxError) || attempt >= 1) throw err;
      }
    }
    return {
      isPotentialDeal: !!parsed.isPotentialDeal,
      category: parsed.category ?? "",
      estimatedValueRangeUsd: parsed.estimatedValueRangeUsd ?? "",
      confidence: parsed.confidence ?? "low",
      conditionImpact: parsed.conditionImpact ?? "unknown",
      reasoning: parsed.reasoning ?? "",
      offTopicSuggestion: typeof parsed.offTopicSuggestion === "string" && parsed.offTopicSuggestion.trim() ? parsed.offTopicSuggestion.trim() : null,
    };
  } catch {
    return {
      isPotentialDeal: false,
      category: "",
      estimatedValueRangeUsd: "",
      confidence: "low",
      conditionImpact: "unknown",
      // With no OpenAI key (a new tester's normal state) every listing lands here; say why instead of blaming the listing.
      reasoning: hasOpenAIAccess() ? "Clynx couldn't read its own analysis of this listing" : "Not judged: Clynx has no OpenAI key to judge listings with. Add yours in Config > Account > Your API keys.",
      offTopicSuggestion: null,
      unavailable: true,
    };
  }
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export async function scoreListing(
  listing: ListingDetail,
  config: EngineConfig,
  // Categories you've repeatedly marked "Not interested" on in Feed (see
  // store.getDismissedCategories) — checked against the title as a cheap
  // substring pre-filter, before spending a general-deal AI call, so the
  // AI actually "learns to just skip it" rather than re-flagging the same
  // kind of thing forever. Only applies to the general (unverified)
  // pathway below — a Search For item is explicit interest by definition,
  // so it's never subject to this.
  dismissedCategories: string[] = [],
  // The user's own recent thumbs-up/thumbs-down feedback on past listings
  // (see store.getFeedbackExamples) — passed through to extractGeneralDeal
  // as few-shot context so it actually shapes future general-deal
  // judgments instead of just sitting recorded and unused. Same posture as
  // dismissedCategories above: only meaningful for the general (unverified)
  // pathway, since a Search For match is deterministic and never asks the
  // AI for a judgment call in the first place.
  feedbackExamples: FeedbackExample[] = [],
  // What eBay says a product is worth (Database comps), by the Search For item's name: the real value to run the
  // profit math against, in place of the item's own typicalResaleUsd, when the Database has one.
  valueFor?: (item: string, title?: string) => number | null,
  // Same idea for a listing that matched NO Search For item: if its title names a Database product that has an eBay
  // value, the deal check is plain resale math (no AI call, no credits).
  valueForTitle?: (title: string) => { name: string; value: number } | null,
  // What BROKEN / for-parts copies of a Search For item sell for (its Database "(For Parts / Broken)" variant), used for items searched
  // with "include broken" when the listing text says the item is broken.
  brokenValueFor?: (item: string) => { name: string; value: number } | null
): Promise<ScoredListing> {
  const candidate = matchSearchItem(listing.title, config.searchItems);

  // --- Search pathway: matched an item from your Search For list ---------
  if (candidate) {
    if (listing.price === null) {
      return {
        listing,
        extraction: {
          matchedItem: null,
          extractedAttributes: "",
          conditionImpact: "unknown",
          confidence: "low",
          reasoning: "Listing has no readable price",
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      };
    }

    // Deterministic, no AI call: matchSearchItem above already confirmed
    // every word of your search keywords shows up in the title, which is
    // the bar you asked for — "if a listing matches those exact keywords
    // in any order, consider it of interest." The only thing left to check
    // in the listing's own text is an explicit red flag (broken, for
    // parts, water damage, etc.); anything else is a match.
    const conditionImpact = detectConditionImpact(conditionTextOf(listing));
    const extraction: ExtractionResult = {
      matchedItem: candidate.item,
      extractedAttributes: "",
      conditionImpact,
      confidence: "high",
      reasoning:
        conditionImpact !== "none"
          ? `Matches your "${candidate.item}" search by keyword, but the listing text mentions something that could hurt condition/value (treated as ${conditionImpact} — priced accordingly, not skipped outright).`
          : `Matches your "${candidate.item}" search — title contains all the words you're looking for.`,
    };
    // Per explicit instruction — whether the listing text mentions shipping
    // one way or the other is no longer part of this decision at all: a
    // cash/local-pickup-only listing is judged exactly like any other, since
    // convincing the seller to ship it anyway is the user's job, not a
    // reason to skip. (This used to be gated behind a requireShippingMention
    // config toggle, defaulted off for the same reason — most casual
    // sellers never proactively mention shipping either way — but removed
    // entirely now rather than leaving a toggle around that could
    // reintroduce the exact behavior just asked against.)
    //
    // Per explicit instruction — a tracked item with no typicalResaleUsd
    // set yet (the default for anything added without stating a price)
    // can't run the deterministic discount math below at all — there's no
    // reference price to compare against. Rather than silently returning
    // isDeal:false forever (which is what made this look like "it only
    // ever finds one," since nothing after the first lucky general-tier
    // flag ever counted), fall back to the SAME AI judgment the general
    // pathway uses, just tagged as a genuine "search" match — matchedItem
    // stays set (so Database attribution/observed-notes/the off-topic
    // blacklist exemption below all still work correctly), and this keeps
    // getting a real, fresh judgment call on EVERY listing found for it,
    // same as a priced item would. Once a real typicalResaleUsd is set
    // (Database, chat, or asking the AI to look up a price), it goes back
    // to the fast, free, deterministic path below with no further AI calls
    // needed at all.
    // With "include broken" on, a broken / for-parts listing is worth what broken ones of it sell for (the Database variant),
    // not a quarter of the working price.
    const broken = candidate.includeBroken && looksBroken(conditionTextOf(listing)) ? (brokenValueFor?.(candidate.item) ?? null) : null;
    const databaseValueUsd = broken ? broken.value : (valueFor?.(candidate.item, listing.title) ?? null);
    if (broken) {
      extraction.brokenVariant = broken.name;
      extraction.reasoning = `Matches your "${candidate.item}" search as a broken / for-parts copy, so it is priced from the Database's "${broken.name}" variant (what broken ones sell for) instead of the working product.`;
    }
    if (candidate.typicalResaleUsd <= 0 && !(databaseValueUsd !== null && databaseValueUsd > 0)) {
      const general = await extractGeneralDeal(listing, config.customInstructions, feedbackExamples);
      const confidenceOk = CONFIDENCE_RANK[general.confidence] >= CONFIDENCE_RANK[config.generalDeal.minConfidence];
      // Per explicit instruction — a flagged condition no longer vetoes this
      // after the fact; extractGeneralDeal's own prompt already weighs
      // condition into isPotentialDeal directly (see its "damaged
      // electronics still hold value" guidance), which is a better judgment
      // than a blunt keyword-based override could ever be with no reference
      // price to run real discount math against anyway.
      const isDeal = general.isPotentialDeal && confidenceOk;
      const effectiveConditionImpact = conditionImpact === "major" ? "major" : general.conditionImpact;
      return {
        listing,
        extraction: {
          matchedItem: candidate.item,
          extractedAttributes: general.category,
          conditionImpact: effectiveConditionImpact,
          confidence: general.confidence,
          reasoning: `Matches your "${candidate.item}" search — no reference price set yet, so judged on Clynx's own read of the price: ${general.reasoning}`,
          ...(general.unavailable ? { judgeUnavailable: true } : {}),
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal,
        dealTier: isDeal ? "search" : null,
        estimatedValueRange: general.estimatedValueRangeUsd || null,
        offTopicSuggestion: null, // never off-topic — it's something you explicitly asked to track
      };
    }

    const settings = resaleSettingsFrom(config);
    const shippingUsd = listing.ebayShippingUsd ?? 0;
    const pricing = evaluateSearchItemPricing(candidate, listing.price, broken ? "none" : conditionImpact, candidate.maxPriceUsd, {
      valueUsd: databaseValueUsd,
      shippingUsd,
      settings,
    });
    if (pricing.keepUsd !== null && pricing.profitUsd !== null) {
      const keepRange = keepRangeUsd(pricing.referencePriceUsd);
      extraction.reasoning += ` Sells for about $${pricing.referencePriceUsd.toFixed(0)} on eBay, so you'd keep roughly $${keepRange.lowUsd.toFixed(0)}-$${keepRange.highUsd.toFixed(0)} after fees; buying it for $${(listing.price + shippingUsd).toFixed(0)}${shippingUsd > 0 ? " with shipping" : ""} leaves ${pricing.profitUsd >= 0 ? "about $" + pricing.profitUsd.toFixed(0) + " profit" : "a loss of about $" + Math.abs(pricing.profitUsd).toFixed(0)}.`;
    }

    return {
      listing,
      extraction,
      referencePriceUsd: pricing.referencePriceUsd,
      discountPercent: pricing.discountPercent,
      isDeal: pricing.isDeal,
      dealTier: pricing.isDeal ? "search" : null,
      estimatedValueRange: null,
      offTopicSuggestion: null,
    };
  }

  // --- General pathway: no Search For match, AI's own (unverified) judgment
  if (!config.generalDeal.enabled || listing.price === null) {
    return {
      listing,
      extraction: {
        matchedItem: null,
        extractedAttributes: "",
        conditionImpact: "unknown",
        confidence: "low",
        reasoning: config.generalDeal.enabled
          ? "No Search For match; listing has no readable price"
          : "No Search For match; general (unverified) deal checks are off",
      },
      referencePriceUsd: null,
      discountPercent: null,
      isDeal: false,
      dealTier: null,
      estimatedValueRange: null,
      offTopicSuggestion: null,
    };
  }

  const dismissedMatch = dismissedCategories.find((c) => listing.title.toLowerCase().includes(c.toLowerCase()));
  if (dismissedMatch) {
    return {
      listing,
      extraction: {
        matchedItem: null,
        extractedAttributes: dismissedMatch,
        conditionImpact: "unknown",
        confidence: "low",
        reasoning: `Skipped without a closer look — you've consistently marked "${dismissedMatch}"-type listings as not interesting.`,
      },
      referencePriceUsd: null,
      discountPercent: null,
      isDeal: false,
      dealTier: null,
      estimatedValueRange: null,
      offTopicSuggestion: null,
    };
  }

  const known = valueForTitle?.(listing.title) ?? null;
  if (known) {
    const knownCondition = detectConditionImpact(conditionTextOf(listing));
    const knownSettings = resaleSettingsFrom(config);
    const knownShipping = listing.ebayShippingUsd ?? 0;
    // A broken / for-parts copy of a Database product is priced from its "(For Parts / Broken)" variant when there is one (the
    // variant only exists once the user has included broken listings for that product).
    const knownBroken = looksBroken(conditionTextOf(listing)) ? (brokenValueFor?.(known.name) ?? null) : null;
    const knownValue = knownBroken ? knownBroken.value : known.value;
    const pricing = evaluateSearchItemPricing(
      { item: known.name, matchKeywords: [], typicalResaleUsd: knownValue, minPriceUsd: null, maxPriceUsd: null, linkedProductId: null },
      listing.price,
      knownBroken ? "none" : knownCondition,
      null,
      { shippingUsd: knownShipping, settings: knownSettings }
    );
    const keepRange = keepRangeUsd(knownValue);
    return {
      listing,
      extraction: {
        matchedItem: known.name,
        extractedAttributes: "",
        conditionImpact: knownCondition,
        confidence: "high",
        ...(knownBroken ? { brokenVariant: knownBroken.name } : {}),
        reasoning: `Recognised from the Database as "${known.name}"${knownBroken ? ` (a broken / for-parts copy, priced from its "${knownBroken.name}" variant)` : ""} (sells for about $${knownValue.toFixed(0)} on eBay, so you'd keep roughly $${keepRange.lowUsd.toFixed(0)}-$${keepRange.highUsd.toFixed(0)} after fees); buying it for $${(listing.price + knownShipping).toFixed(0)} leaves ${pricing.profitUsd !== null && pricing.profitUsd >= 0 ? "about $" + pricing.profitUsd.toFixed(0) + " profit" : "a loss"}.`,
      },
      referencePriceUsd: pricing.referencePriceUsd,
      discountPercent: pricing.discountPercent,
      isDeal: pricing.isDeal,
      dealTier: pricing.isDeal ? "search" : null,
      estimatedValueRange: null,
      offTopicSuggestion: null,
    };
  }

  const general = await extractGeneralDeal(listing, config.customInstructions, feedbackExamples);
  const confidenceOk = CONFIDENCE_RANK[general.confidence] >= CONFIDENCE_RANK[config.generalDeal.minConfidence];
  // Per explicit instruction — a "major" conditionImpact no longer vetoes
  // this outright; extractGeneralDeal's own prompt already weighs condition
  // into isPotentialDeal directly (damaged goods can still be a genuine
  // deal at a low enough price), so a second blunt override here was just
  // undoing that judgment rather than improving on it.
  const isDeal = general.isPotentialDeal && confidenceOk;

  return {
    listing,
    extraction: {
      matchedItem: null,
      extractedAttributes: general.category,
      conditionImpact: general.conditionImpact,
      confidence: general.confidence,
      reasoning: general.reasoning,
      ...(general.unavailable ? { judgeUnavailable: true } : {}),
    },
    referencePriceUsd: null,
    discountPercent: null,
    isDeal,
    dealTier: isDeal ? "general" : null,
    estimatedValueRange: general.estimatedValueRangeUsd || null,
    offTopicSuggestion: general.offTopicSuggestion,
  };
}
