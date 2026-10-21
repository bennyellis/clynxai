import { classifySoldPage, type SoldPageState } from "./soldComps/zeroWhy.js";
import { noteDecision } from "./aiDecisionLog.js";
import type { Page } from "playwright";
import type { PhotoCheck } from "./compPhotoCheck.js";
import { OPENAI_MODEL, callOpenAI, ensureOpenAIAccess } from "./openai.js";
import { compMatchesSpecs, sanitizeSearchQuery, specReference, titleLooksLikeProduct } from "./compFilter.js";
import { titleLooksLikeBrokenProduct } from "./brokenVariant.js";
import { isLowAiMode } from "./aiMode.js";
import { classifyComparable, emptySummary, tallyJudgement, usableForValuation, type ValidationSummary } from "./compIdentity.js";
import { trimmedMean } from "./marketValue.js";
import { splitByPriceSeparators } from "./identity/populations.js";

export interface EbayComp {
  title: string;
  priceUsd: number;
  shippingUsd: number | null;
  condition: string | null;
  listingType: string | null;
  runTimeDays: number | null;
  itemUrl: string;
  // The photo shown on WatchCount's result card, when it has one (used to cross-check the comp against reference photos).
  imageUrl?: string | null;
}

const OPENAI_TIMEOUT_MS = 30_000;

// Verified live: watchcount.com's CLASSIC site (watchcount.com) redirects
// every sold-listing search — form submission AND direct URL navigation
// alike — to a reCAPTCHA challenge, for anonymous traffic. Its newer BETA
// site (beta.watchcount.com) does not: navigating straight to this exact
// URL shape returned real sold-listing results with no login and no
// challenge. "Fixed-Price/BIN Only" + "Best Match" (per explicit
// instruction) are baked directly into the URL (fixedprice/bestmatch)
// rather than driving the on-page dropdowns — one navigation, nothing to
// click, fewer ways for this to break. Not a guarantee this stays
// CAPTCHA-free forever (the beta site's own network traffic shows a
// recaptcha_verify call happening silently in the background — an
// invisible, score-based check that happened to pass for an interactive
// session, not something a non-interactive Playwright script filling
// forms instantly is guaranteed to also pass) — searchSoldComps below
// degrades to an empty result rather than throwing if the page ever comes
// back looking like a challenge instead of real results.
function buildSearchUrl(query: string): string {
  const encodedQuery = sanitizeSearchQuery(query)
    .split(/\s+/)
    .map((word) => encodeURIComponent(word))
    .join("+");
  return `https://beta.watchcount.com/sold/${encodedQuery}/-/fixedprice?site=EBAY_US&sortBy=bestmatch`;
}

function parseRunTimeDays(cardText: string): number | null {
  const match = cardText.match(/Ran for\s+([\d.]+)\s*(minute|minutes|hour|hours|day|days|week|weeks)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit.startsWith("minute")) return value / 1440;
  if (unit.startsWith("hour")) return value / 24;
  if (unit.startsWith("week")) return value * 7;
  return value; // already days
}

// Each result card's own innerText follows a consistent, if unlabeled,
// pattern (verified live against real search results):
//   Watchers: <N>
//   Sold: <N>
//   <TITLE>
//   $<PRICE>
//   <shipping line>
//   See full listing
//   <Condition: Used|New>
//   <seller> (<count>) <percent>%
//   <N> available
//   <Listing Type: Fixed Price|Auction|Best Offer>
//   Sold
//   eBay-<site>
//   <item number>
//   Start: DD-Mon-YY
//   End: DD-Mon-YY
//   Ran for <N> <unit>
//   Log in or sign up now...
// Parsed by regex/position rather than CSS classes (which weren't
// inspected beyond the repeating card container itself, .search-box) —
// the title is simply "whatever line sits right before the price line",
// which holds regardless of how many Watchers/Sold lines precede it.
// The shipping line sits right after the price line (see the card-layout
// comment above) and reads as either "Free shipping"/"Free Postage" or a
// dollar figure like "+$4.99 shipping" — parsed the same "whatever's in
// this position" way as title above rather than a keyword search, since
// "See full listing" (the line after it) would otherwise need excluding
// explicitly. Falls back to null (shown as "unknown" rather than $0) for
// any line that matches neither shape, instead of guessing.
function parseShippingUsd(shippingLine: string | null): number | null {
  if (!shippingLine) return null;
  if (/free/i.test(shippingLine)) return 0;
  const match = shippingLine.match(/\$([\d,]+\.\d{2})/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseCompCard(cardText: string): EbayComp | null {
  const priceMatch = cardText.match(/\$([\d,]+\.\d{2})/);
  if (!priceMatch) return null;
  const priceUsd = parseFloat(priceMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(priceUsd)) return null;

  const lines = cardText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const priceLineIdx = lines.findIndex((l) => l.includes(priceMatch[0]));
  const title = priceLineIdx > 0 ? lines[priceLineIdx - 1] : null;
  if (!title) return null;
  const shippingLine = priceLineIdx >= 0 && priceLineIdx + 1 < lines.length ? lines[priceLineIdx + 1] : null;

  const conditionMatch = cardText.match(/^(Used|New)$/m);
  const listingTypeMatch = cardText.match(/^(Fixed Price|Auction|Best Offer)$/m);
  const itemNumberMatch = cardText.match(/eBay-\w+\s*\n\s*(\d{6,})/);

  return {
    title,
    priceUsd,
    shippingUsd: parseShippingUsd(shippingLine),
    condition: conditionMatch ? conditionMatch[1] : null,
    listingType: listingTypeMatch ? listingTypeMatch[1] : null,
    runTimeDays: parseRunTimeDays(cardText),
    itemUrl: itemNumberMatch ? `https://www.ebay.com/itm/${itemNumberMatch[1]}` : "https://www.ebay.com",
  };
}

export async function searchSoldComps(page: Page, query: string): Promise<EbayComp[]> {
  return (await searchSoldCompsWithState(page, query)).comps;
}

/** The same search, and what the page turned out to be (results, a security check, the daily limit, an empty answer): a zero is never a silent zero. */
export async function searchSoldCompsWithState(page: Page, query: string): Promise<{ comps: EbayComp[]; state: SoldPageState }> {
  await page.goto(buildSearchUrl(query), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".search-box")).map((el) => ({
      text: (el as HTMLElement).innerText,
      image: (el.querySelector("img") as HTMLImageElement | null)?.src ?? null,
    }))
  );
  const comps: EbayComp[] = [];
  for (const card of cards) {
    const comp = parseCompCard(card.text);
    if (comp) comps.push({ ...comp, imageUrl: card.image && /^https?:/i.test(card.image) ? card.image : null });
  }
  let state: SoldPageState = comps.length > 0 ? "results" : "unknown";
  if (comps.length === 0) {
    try {
      const body = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 4000));
      state = classifySoldPage(page.url(), body, cards.length);
    } catch {
      state = "unknown";
    }
  }
  return { comps, state };
}

// Per explicit instruction — reported live: the scanner once misidentified
// an iPhone 15 Plus listing as "Metroid" and that name went straight into
// the watchcount search with nothing to catch it, since the search used to
// just reuse whatever the earlier product-identification step landed on.
// This re-derives the actual search query from the ORIGINAL Facebook
// listing that first surfaced the product — its title and one of its own
// real photos (see index.ts's fetchAndStoreEbayComps, which pulls these
// from the product's own reference-photo library rather than trusting its
// stored name) — a fresh, independent "educated guess" that a bad name
// upstream has no way to poison. Falls back to that name outright when
// there's nothing to ground a guess in (no reference photo carrying a real
// listing title yet — e.g. a product added by hand through chat, never
// actually found on a real listing) or if the AI call itself fails; never
// throws, since a fallback to the existing name is always a valid result.
export async function deriveWatchCountQuery(fallbackName: string, sourceTitle: string | null, imageDataUri: string | null, credibleCodes: string[] = []): Promise<string> {
  // The Database entry's own name is a fine search query; asking the AI to re-derive it costs credits every research.
  if (isLowAiMode()) {
    // No AI: the entry's own name, plus the model numbers / generations the listing it came from states and the name lacks, so a generic name
    // does not turn into a search for every version of the product (the comp filter then requires those codes too).
    const base = sanitizeSearchQuery(fallbackName) || fallbackName;
    // Only codes that evidence shows are real model / version markers (identity/credibility.ts): a seller's inventory code in the query would
    // find no comps at all and waste one of the day's few lookups.
    const extra = sourceTitle ? credibleCodes : [];
    return extra.length ? `${base} ${extra.join(" ")}` : base;
  }
  if (!sourceTitle && !imageDataUri) return fallbackName;

  try {
    ensureOpenAIAccess();
  } catch {
    return fallbackName;
  }

  // Per explicit instruction — this used to explicitly strip condition/
  // completeness wording into a clean, generic retailer-style name. That
  // worked against condition-awareness: a query genuinely closer to the
  // seller's own words is more likely to surface sold comps in a
  // comparable condition, which analyzeEbayComps below now actually uses.
  const prompt = `A resale-tracking app is about to search eBay's sold listings for comps on a specific product. Base your answer ONLY on the actual Facebook Marketplace listing below — ignore any other name this product might be filed under elsewhere in the app, which may be wrong.

Listing title: "${sourceTitle ?? "(not available)"}"
${imageDataUri ? "A photo from this exact listing is attached below." : "(no photo available for this listing)"}

Give your best educated guess at a real eBay search query for this SAME product, staying as close as reasonable to the seller's own wording — brand, model, the spec(s) that actually distinguish this product line from other variants (e.g. screen size and year for a laptop, generation for a game console, storage size for a phone), AND any condition/completeness/bundle wording actually present in the listing title (used, for parts, no charger, no controller, bundle, etc.) — keep that instead of stripping it, since matching the seller's own phrasing helps find sold comps in a genuinely comparable condition, not just the same base product. Only clean up genuine noise: the same spec repeated in different phrasing, seller filler ("must sell today," "priced to move"), or anything that isn't actually part of describing the item itself.

Respond with ONLY a JSON object, no other text: { "query": string }`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  if (imageDataUri) content.push({ type: "image_url", image_url: { url: imageDataUri } });

  const timeoutMs = 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 500,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      },
      controller.signal, "market search query");
    if (!res.ok) return fallbackName;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return fallbackName;
    const parsed = JSON.parse(text);
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    return query || fallbackName;
  } catch {
    return fallbackName;
  } finally {
    clearTimeout(timeout);
  }
}

export interface CompAnalysis {
  // How many otherwise-matching comps were dropped because their photo showed a different product.
  photoRejected: number;
  avgSoldPriceUsd: number | null;
  avgRunTimeDays: number | null;
  avgShippingUsd: number | null;
  sampleSize: number;
  // "New" / "Used" — the condition most of the confirmed comps were sold in (null when none was labelled),
  // so asking prices can be compared against the same kind of item.
  dominantCondition: string | null;
  // How many of the results WatchCount returned were thrown out as not being this product.
  rejectedCount: number;
  // Whether the comps are the market of exactly the product asked about. "approximate": the name was generic and the comps mix several
  // products, so the cheapest group stood in as a floor. "unresolved": mixed, and nothing could stand in. Absent = exact.
  identity?: "exact" | "approximate" | "unresolved";
  identityNote?: string | null;
  // How the results were judged against the product's identity before any price was used (see compIdentity.ts): retrieved, exact, compatible, uncertain,
  // rejected, with the reasons. Only exact and compatible results are in the figures above.
  validation?: ValidationSummary;
  // The sales that went into the figures above (after every identity check), so they can be kept and counted later.
  acceptedComps?: EbayComp[];
}

const EMPTY_ANALYSIS: CompAnalysis = { identity: "exact", identityNote: null, photoRejected: 0, avgSoldPriceUsd: null, avgRunTimeDays: null, avgShippingUsd: null, sampleSize: 0, dominantCondition: null, rejectedCount: 0 };

// The AI half of "is this listing the SAME product": brand/partner, edition, bundle, and anything else that
// isn't a plain model number or capacity (those are checked in code first, see compFilter.ts). Returns the
// indices of `titles` it considers the same product.
export async function judgeSameProduct(query: string, titles: string[], productName?: string): Promise<number[]> {
  if (titles.length === 0) return [];
  // Plain text checks instead of an AI call (see compFilter.ts's titleLooksLikeProduct).
  if (isLowAiMode()) return titles.flatMap((t, i) => (titleLooksLikeProduct(query, t) ? [i] : []));
  const prompt = `You're comparing eBay listings against ONE specific product a reseller is pricing: "${query}".${productName && productName.toLowerCase() !== query.toLowerCase() ? ` The Database names this product "${productName}": a listing that contradicts either name (another model number or generation, another tier, another capacity) is a different product.` : ""}
For EACH listing below, decide whether it is for exactly that product, so its price is a fair comparison.

Be strict about what makes products different in price: the manufacturer/brand (e.g. EVGA vs Gigabyte graphics cards of the same chip are different products), the exact model or product line, capacity/size/storage, generation, and special/limited/collector's editions or different bundles. Be relaxed about things that don't change the product: color, "new/used/open box" wording, seller filler. If the product name above does NOT name a manufacturer or model line (it is a generic name like a chip or console name), then any manufacturer's version counts. If the product name names a COLOR, a listing in a different color is a different product and must be rejected (a listing that names no color is fine); if it names no color, any color counts. Reject accessories, parts, cases, boxes-only, games, and unrelated items, and reject listings that bundle the product with other items (a console, controller, games, other accessories) or sell several units as a lot, since their price isn't the product's price.

Listings (index: title):
${titles.map((t, i) => `${i}: ${t}`).join("\n")}

Respond with ONLY a JSON object, no other text, in this exact shape:
{ "matchingIndices": number[] }`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await callOpenAI(
      "chat",
      {
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 1200,
        // gpt-5-mini is a reasoning model — silently burns the whole completion-token budget on invisible
        // reasoning tokens without this, same lesson as everywhere else this app calls OpenAI.
        reasoning_effort: "minimal",
      },
      controller.signal, "comparable check");
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    if (Array.isArray(parsed.matchingIndices)) {
      const kept = parsed.matchingIndices.filter((i: unknown): i is number => typeof i === "number" && i >= 0 && i < titles.length);
      const dropped = titles.filter((_, i) => !kept.includes(i)).slice(0, 3);
      noteDecision({
        kind: "comparable_check",
        subject: productName ?? query,
        verdict: `kept ${kept.length} of ${titles.length}`,
        thought: dropped.length ? `Left out, for example: ${dropped.map((t) => `"${t.slice(0, 70)}"`).join("; ")}.` : "Every listing was the same product.",
        model: OPENAI_MODEL,
      });
    }
    return Array.isArray(parsed.matchingIndices)
      ? parsed.matchingIndices.filter((i: unknown): i is number => typeof i === "number" && i >= 0 && i < titles.length)
      : [];
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Per explicit instruction — "make sure when Clynx looks at watchcount data that it is entirely accurate with
// what it is searching and the results it relays": every result passes two gates before it counts. First the
// hard facts, in code (same model number, same capacity, same tier word — a 4TB card's average used to include
// 1TB and 2TB cards because only a fast AI judged this). Then the AI judges brand/edition/bundle. Averages are
// plain arithmetic over what survives (an outlier-trimmed mean, so one mislabelled listing can't drag it).
// `productName` is the Database entry's own name, only used to recover a capacity the search query dropped.
export async function analyzeEbayComps(
  query: string,
  comps: EbayComp[],
  productName: string = query,
  photoCheck?: PhotoCheck | null,
  broken = false,
  // The words that separate this product from the general one it is a version of ("galaxy" for a special edition console): a sale whose
  // title doesn't carry them is the standard model's sale, not this product's (see variantIdentity.ts's editionConflict).
  requiredTerms: string[] = [],
  // The Marketplace listing the product was found from: it states the capacity / color the product's own name may leave open.
  sourceTitle: string | null = null
): Promise<CompAnalysis> {
  const validation = emptySummary();
  const withValidation = (a: CompAnalysis): CompAnalysis => ({ ...a, validation });
  if (comps.length === 0) return withValidation(EMPTY_ANALYSIS);

  // Every result is compared with the product's identity before its price is used: a search returning it proves nothing (see compIdentity.ts).
  // Exact and compatible results are used; uncertain and rejected ones are counted and left out.
  const compIdentity = { name: productName, query, sourceTitle, requiredTerms, broken };
  // Copies sold "for parts or not working" are not what a working one sells for (the broken research handles those on its own).
  const specMatched = comps.filter((c) => {
    const j = classifyComparable(compIdentity, c.title);
    tallyJudgement(validation, c.title, j);
    return usableForValuation(j.verdict) && (broken || !/parts|not working/i.test(c.condition ?? ""));
  });
  if (specMatched.length === 0) return withValidation({ ...EMPTY_ANALYSIS, rejectedCount: comps.length });

  // Broken / for-parts research (a "(For Parts / Broken)" Database variant) keeps ONLY comps that are broken copies of the product,
  // by plain text checks: the normal judge throws exactly those away.
  const keptIndices = broken
    ? specMatched.flatMap((c, i) => (titleLooksLikeBrokenProduct(query, c.title, /parts|not working/i.test(c.condition ?? "")) ? [i] : []))
    : await judgeSameProduct(
        query,
        specMatched.map((c) => c.title),
        productName
      );
  let matched = keptIndices.map((i) => specMatched[i]).filter((c): c is EbayComp => !!c);
  // Last gate: each comp's photo against the product's reference photos. A title can say "Series S" over a Series X.
  let photoRejected = 0;
  if (photoCheck && matched.length > 0) {
    const keep = await photoCheck(matched.map((c) => ({ title: c.title, imageUrl: c.imageUrl ?? null })));
    const survivors = matched.filter((_, i) => keep[i] !== false);
    photoRejected = matched.length - survivors.length;
    matched = survivors;
  }
  // A generic name pulls in every version of the product; averaging them fits none. Split the set along the words that actually separate the
  // prices and keep the part that matches what the name says (see identity/populations.ts).
  let identity: CompAnalysis["identity"] = "exact";
  let identityNote: string | null = null;
  if (!broken && matched.length > 0) {
    const split = splitByPriceSeparators(matched, `${query} ${productName}`);
    if (split.separators.length > 0) {
      identity = split.state;
      identityNote = split.note;
      matched = split.chosen;
    }
  }
  const rejectedCount = comps.length - matched.length - photoRejected;
  if (matched.length === 0) return withValidation({ ...EMPTY_ANALYSIS, rejectedCount, photoRejected, identity, identityNote });

  // Condition-awareness — segment the confirmed matches by each comp's own condition and average the LARGEST
  // segment (the condition a resale item is overwhelmingly likely to be in), falling back to everything when no
  // segment reaches a real sample (3), so a lone outlier can't skew the number off a sliver of data.
  const MIN_SEGMENT_SAMPLES = 3;
  const byCondition = new Map<string, EbayComp[]>();
  for (const c of matched) {
    const key = c.condition ?? "unknown";
    const list = byCondition.get(key);
    if (list) list.push(c);
    else byCondition.set(key, [c]);
  }
  let dominantSegment = matched;
  let dominantKey = "unknown";
  let dominantSize = 0;
  for (const [key, list] of byCondition) {
    if (list.length > dominantSize) {
      dominantSize = list.length;
      dominantSegment = list;
      dominantKey = key;
    }
  }
  const useSegment = dominantSize >= MIN_SEGMENT_SAMPLES;
  const source = useSegment ? dominantSegment : matched;

  const price = trimmedMean(source.map((c) => c.priceUsd));
  const withRunTime = source.filter((c) => c.runTimeDays !== null);
  const avgRunTimeDays = withRunTime.length > 0 ? withRunTime.reduce((sum, c) => sum + (c.runTimeDays ?? 0), 0) / withRunTime.length : null;
  // Only averaged across comps where a shipping cost was actually parsed — an unparsed one is left out rather
  // than counted as $0, so it can't drag the average down.
  const withShipping = source.filter((c) => c.shippingUsd !== null);
  const avgShippingUsd = withShipping.length > 0 ? withShipping.reduce((sum, c) => sum + (c.shippingUsd ?? 0), 0) / withShipping.length : null;
  return withValidation({
    avgSoldPriceUsd: price.value,
    avgRunTimeDays,
    avgShippingUsd,
    sampleSize: price.used,
    acceptedComps: source,
    dominantCondition: !broken && useSegment && dominantKey !== "unknown" ? dominantKey : null,
    rejectedCount,
    photoRejected,
    identity,
    identityNote,
  });
}
