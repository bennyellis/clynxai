import type { Config, ExtractionResult, FeedbackExample, ListingDetail, SearchItem, ScoredListing } from "./types.js";
import { OPENAI_MODEL, OPENAI_URL, getOpenAIApiKey } from "./openai.js";

// If you didn't separately fill in match keywords, fall back to the item
// name itself — otherwise an item added with just a name and price (the
// natural thing to do) would silently match nothing and never get
// actively searched either, since both of those need at least one term
// to work with. This is the actual terms used everywhere below, not
// item.matchKeywords directly.
export function getSearchTerms(item: SearchItem): string[] {
  return item.matchKeywords.length ? item.matchKeywords : item.item.trim() ? [item.item.trim()] : [];
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
function titleContainsAllWords(lowerTitle: string, phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lowerTitle));
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
    for (const kw of getSearchTerms(ref)) {
      if (titleContainsAllWords(lower, kw) && kw.length > bestLen) {
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
  return searchItems.some((ref) => getSearchTerms(ref).some((kw) => titleContainsAllWords(lower, kw)));
}

// Generic connector/modifier words that show up across a lot of Search For
// keyword phrases — excluded from the green-flag word match below so it
// doesn't fire on every listing that merely shares a throwaway word like
// "pro" or "slim" with something you're tracking.
const GREEN_FLAG_STOPWORDS = new Set([
  "the", "and", "for", "with", "of", "a", "an", "new", "used",
  "series", "slim", "pro", "max", "plus", "edition", "digital", "bundle", "lot", "set", "console",
]);

// Deliberately looser than matchSearchItem above — this is the "green
// flag" signal for a listing whose title DOESN'T cleanly match a tracked
// item (matchSearchItem already returned null for it) but still shares a
// real, specific word with one of its keyword phrases. Verified live
// scenario: a seller listed an Xbox Series S under the (incorrect — there's
// no such product) title "Xbox X," which shares "xbox" with a tracked
// "Xbox Series S" but not "series" or "s," so the strict all-words match
// never fires. Per explicit instruction, a seller mistitling a high-value
// item shouldn't cost it a look — this flags it as worth a deeper,
// AI-vision-assisted check (see scrapeEngine.ts) instead of treating it as
// unrelated. No longer requires typicalResaleUsd either, for the same
// reason matchSearchItem above dropped it — a price-less tracked item
// still deserves the closer look; scoreListing's search pathway falls back
// to the AI's own judgment for the actual deal call when there's no
// reference price to run real discount math against.
export function findGreenFlagCandidate(title: string, searchItems: SearchItem[]): SearchItem | null {
  const lower = title.toLowerCase();
  let best: SearchItem | null = null;
  let bestWordLen = 0;
  for (const ref of searchItems) {
    for (const kw of getSearchTerms(ref)) {
      const words = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !GREEN_FLAG_STOPWORDS.has(w));
      for (const w of words) {
        if (w.length > bestWordLen && new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lower)) {
          best = ref;
          bestWordLen = w.length;
        }
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
const MAJOR_CONDITION_PATTERNS: RegExp[] = [
  /\bfor parts\b/i, /\bparts only\b/i, /\bnot working\b/i, /\bdoesn'?t work\b/i, /\bwon'?t (turn on|power on|charge)\b/i,
  /\bno power\b/i, /\bdead\b/i, /\bdefective\b/i, /\bicloud locked\b/i, /\bblacklisted\b/i,
  /\bneeds repair\b/i, /\brepair needed\b/i,
];
const MINOR_CONDITION_PATTERNS: RegExp[] = [
  /\bbroken\b/i, /\bcrack(ed)?\b/i, /\bshatter(ed)?\b/i, /\bdamage[ds]?\b/i, /\bwater damage\b/i,
  /\bas.?is\b/i, /\bmissing (charger|remote|controller|cable)\b/i,
];

export type ConditionImpact = "none" | "minor" | "major";

export function detectConditionImpact(text: string): ConditionImpact {
  if (MAJOR_CONDITION_PATTERNS.some((re) => re.test(text))) return "major";
  if (MINOR_CONDITION_PATTERNS.some((re) => re.test(text))) return "minor";
  return "none";
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
const CONDITION_VALUE_MULTIPLIER: Record<ConditionImpact, number> = {
  none: 1,
  minor: 0.6,
  major: 0.25,
};

export interface SearchItemPricing {
  referencePriceUsd: number;
  discountPercent: number | null;
  isDeal: boolean;
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
  dealThresholdPercent: number,
  // The Dashboard's global Max Price filter (config.maxPriceUsd) — the one
  // and only "max I'll pay" signal now (there used to also be a separate
  // per-item maxBudgetUsd here, removed for being a confusingly redundant
  // second "max price" knob). Anything priced above it is already skipped
  // before ever reaching this far (see scrapeEngine.ts's evaluateListing),
  // so passing it through here just means: if you've told the scanner what
  // you're willing to pay for this, clearing that bar alone is enough to
  // count as a deal, even short of the resale-discount threshold below —
  // scaled down by the condition multiplier just like the discount bar, so
  // "I'll pay up to $100 for a working one" doesn't also greenlight a
  // "parts only" one at the same $100.
  maxPriceUsd: number | null
): SearchItemPricing {
  const referencePriceUsd = candidate.typicalResaleUsd;
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
  // sufficient: at/under your global max price, OR clearing the
  // resale-value discount threshold when a real reference price exists.
  // Both scaled by the same condition multiplier — equivalent to comparing
  // against a condition-adjusted expected value, just expressed as a
  // tighter bar instead of a smaller number.
  const withinBudget = maxPriceUsd != null && maxPriceUsd > 0 && price <= maxPriceUsd * multiplier;
  const effectiveThresholdPercent = 100 - (100 - dealThresholdPercent) * multiplier;
  const withinDiscountThreshold = discountPercent !== null && discountPercent >= effectiveThresholdPercent;
  const isDeal = withinBudget || withinDiscountThreshold;

  return { referencePriceUsd, discountPercent, isDeal };
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
async function callAI(prompt: string): Promise<string> {
  const apiKey = getOpenAIApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 700,
        // gpt-5-mini is a reasoning model — verified live it silently burns
        // the whole completion-token budget on invisible reasoning tokens
        // (empty content, finish_reason "length") without this.
        reasoning_effort: "minimal",
      }),
      signal: controller.signal,
    });
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
  const prompt = `You are scanning a Facebook Marketplace listing that does NOT match anything in the reseller's Search For list. Your only job is to flag it if it looks like an unusually good deal in general — priced well below what this type of item typically sells for used, in typical condition. Be conservative: the large majority of listings should NOT be flagged, because most things AREN'T deals — but "conservative" means skeptical of a WEAK case, not skeptical of a steep discount itself. This whole business exists to find items priced well below their real value — a big gap between price and typical value is the SIGNAL you're looking for, never a reason on its own to doubt the listing or lower confidence. Verified live miss: a genuine Xbox Series S at $150 (a real, great price for it) got skipped with reasoning citing the price itself as suspicious — that's exactly the wrong instinct. Only treat a price as actually implausible (more likely a placeholder, scam, or joke listing than a real deal) when it's asking something like 5% or less of typical value — a near-total markdown, not just a steep one. A 50-80%-off price is a legitimately great, very plausible deal for a motivated seller — flag it normally, don't second-guess it for looking "too good to be true."
${buildCustomInstructionsBlock(customInstructions)}${buildFeedbackExamplesBlock(feedbackExamples)}
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
    const parsed = extractJson(await callAI(prompt));
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
      reasoning: "Failed to parse AI response",
      offTopicSuggestion: null,
    };
  }
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export async function scoreListing(
  listing: ListingDetail,
  config: Config,
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
  feedbackExamples: FeedbackExample[] = []
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
    const conditionImpact = detectConditionImpact(`${listing.title} ${listing.description}`);
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
    if (candidate.typicalResaleUsd <= 0) {
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
          reasoning: `Matches your "${candidate.item}" search — no reference price set yet, so judged on the AI's own read of the price: ${general.reasoning}`,
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal,
        dealTier: isDeal ? "search" : null,
        estimatedValueRange: general.estimatedValueRangeUsd || null,
        offTopicSuggestion: null, // never off-topic — it's something you explicitly asked to track
      };
    }

    const pricing = evaluateSearchItemPricing(candidate, listing.price, conditionImpact, config.dealThresholdPercent, config.maxPriceUsd);

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
        reasoning: `Skipped without an AI call — you've consistently marked "${dismissedMatch}"-type listings as not interesting.`,
      },
      referencePriceUsd: null,
      discountPercent: null,
      isDeal: false,
      dealTier: null,
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
    },
    referencePriceUsd: null,
    discountPercent: null,
    isDeal,
    dealTier: isDeal ? "general" : null,
    estimatedValueRange: general.estimatedValueRangeUsd || null,
    offTopicSuggestion: general.offTopicSuggestion,
  };
}
