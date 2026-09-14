import type { Page } from "playwright";
import { OPENAI_MODEL, OPENAI_URL, getOpenAIApiKey } from "./openai.js";

export interface EbayComp {
  title: string;
  priceUsd: number;
  shippingUsd: number | null;
  condition: string | null;
  listingType: string | null;
  runTimeDays: number | null;
  itemUrl: string;
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
  const encodedQuery = query
    .trim()
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
  await page.goto(buildSearchUrl(query), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const cardTexts = await page.evaluate(() => Array.from(document.querySelectorAll(".search-box")).map((el) => (el as HTMLElement).innerText));
  return cardTexts.map(parseCompCard).filter((c): c is EbayComp => c !== null);
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
export async function deriveWatchCountQuery(fallbackName: string, sourceTitle: string | null, imageDataUri: string | null): Promise<string> {
  if (!sourceTitle && !imageDataUri) return fallbackName;

  let apiKey: string;
  try {
    apiKey = getOpenAIApiKey();
  } catch {
    return fallbackName;
  }

  const prompt = `A resale-tracking app is about to search eBay's sold listings for comps on a specific product. Base your answer ONLY on the actual Facebook Marketplace listing below — ignore any other name this product might be filed under elsewhere in the app, which may be wrong.

Listing title: "${sourceTitle ?? "(not available)"}"
${imageDataUri ? "A photo from this exact listing is attached below." : "(no photo available for this listing)"}

Give your best educated guess at a SHORT, SIMPLE, canonical eBay search query for this SAME product — just brand, model, and the one or two specs that actually distinguish this product line from other variants (e.g. screen size and year for a laptop, generation for a game console, storage size for a phone). Do NOT include color, cosmetic condition, completeness/missing-parts wording (used, no charger, no case, no controller, missing parts, scratches, etc.), seller filler, or the same spec repeated in different phrasing — a real seller's listing title is often redundant or cluttered ("MacBook Pro 15-inch 2018 15\" 2018 Silver, no charger"); your job is to distill that down to the clean, generic name a retailer or eBay category page would use, e.g. "Apple MacBook Pro 15 Inch 2018" — nothing more.

Respond with ONLY a JSON object, no other text: { "query": string }`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  if (imageDataUri) content.push({ type: "image_url", image_url: { url: imageDataUri } });

  const timeoutMs = 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 500,
        reasoning_effort: "minimal",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
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

// Per explicit instruction — "since the ai is only researching the normal
// series x, have the ai understand to disregard the special listings...
// do the equivalent of this for all researched items": an AI judgment
// pass over the RAW comps' titles, not a hardcoded keyword blocklist,
// since "special/limited edition" phrasing varies endlessly by product
// and this app has no photos of these eBay listings to compare against
// (only watchcount's own text) — this works off the same title text a
// person would use to make the same call by eye. Averages are computed
// here in plain arithmetic over whichever comps the AI keeps, not asked
// of the model itself — far more reliable than trusting an LLM's own
// math over a list of numbers.
export async function analyzeEbayComps(
  productName: string,
  comps: EbayComp[]
): Promise<{ avgSoldPriceUsd: number | null; avgRunTimeDays: number | null; avgShippingUsd: number | null; sampleSize: number }> {
  if (comps.length === 0) return { avgSoldPriceUsd: null, avgRunTimeDays: null, avgShippingUsd: null, sampleSize: 0 };

  const prompt = `You're comparing eBay sold listings against a specific product a reseller is researching: "${productName}".
For EACH listing below, decide whether its title genuinely refers to the SAME base product — same model, NOT a special/limited/collector's edition, NOT a meaningfully different bundle/capacity/accessory set, and NOT a clearly unrelated item. Ordinary condition wording (new/used/refurbished) and minor color variants still count as a match.

Listings (index: title):
${comps.map((c, i) => `${i}: ${c.title}`).join("\n")}

Respond with ONLY a JSON object, no other text, in this exact shape:
{ "matchingIndices": number[] }`;

  const apiKey = getOpenAIApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 800,
        // gpt-5-mini is a reasoning model — silently burns the whole
        // completion-token budget on invisible reasoning tokens without
        // this, same lesson as everywhere else this app calls OpenAI.
        reasoning_effort: "minimal",
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    const indices: number[] = Array.isArray(parsed.matchingIndices) ? parsed.matchingIndices.filter((i: unknown) => typeof i === "number") : [];
    const matched = indices.map((i) => comps[i]).filter((c): c is EbayComp => !!c);
    if (matched.length === 0) return { avgSoldPriceUsd: null, avgRunTimeDays: null, avgShippingUsd: null, sampleSize: 0 };

    const avgSoldPriceUsd = matched.reduce((sum, c) => sum + c.priceUsd, 0) / matched.length;
    const withRunTime = matched.filter((c) => c.runTimeDays !== null);
    const avgRunTimeDays = withRunTime.length > 0 ? withRunTime.reduce((sum, c) => sum + (c.runTimeDays ?? 0), 0) / withRunTime.length : null;
    // Only averaged across comps where a shipping cost was actually parsed
    // (see parseShippingUsd) — a comp whose shipping line didn't match
    // either known shape is left out of this average entirely rather than
    // silently counted as $0, so one unparsed listing can't drag the
    // average down.
    const withShipping = matched.filter((c) => c.shippingUsd !== null);
    const avgShippingUsd = withShipping.length > 0 ? withShipping.reduce((sum, c) => sum + (c.shippingUsd ?? 0), 0) / withShipping.length : null;
    return { avgSoldPriceUsd, avgRunTimeDays, avgShippingUsd, sampleSize: matched.length };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
