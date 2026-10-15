// Real web research for product profiles — actual search results and page
// text from the open web, instead of relying solely on the AI's static
// training knowledge (see chat.ts's old generateProductSummary). Uses
// DuckDuckGo's plain-HTML search endpoint rather than Google: it's
// server-rendered with no JavaScript required and tolerant of a simple
// automated request, where Google's results page challenges non-browser
// traffic with a CAPTCHA almost immediately — solving/bypassing one isn't
// something this app is able to (or should) do. Plain fetch() throughout,
// no browser — this never touches the shared Facebook Playwright page, so
// it can't collide with the scanner the way page-sharing bugs have before.

import { noteDecision } from "./aiDecisionLog.js";
import sharp from "sharp";
import { verifyThumbnailCandidate } from "./vision.js";
import { fileableWithoutPicture, judgeCandidateByText, titleFromLabel } from "./photoIdentity.js";
import { OPENAI_IMAGE_MODEL, callOpenAI } from "./openai.js";
import { hasEbayCredentials, searchEbayItems } from "./ebayClient.js";
import { titleLooksLikeProduct } from "./compFilter.js";
import { isLowAiMode } from "./aiMode.js";
import { assessEvidence, describeVerdictForAi, verifyVariant, type VariantVerdict, type VerifyDeps } from "./variantEvidence.js";
import { extractVariantAttributes } from "./variantIdentity.js";
import { isPublicHttpUrl } from "./variantResearch.js";
import { queryFromSearchUrl } from "./searchLinks.js";
import { DEFAULT_BACKENDS, createEvidenceDeps, extractEvidenceText, searchWasUnavailable, type EvidenceDeps } from "./webEvidence.js";
import { apiBackends } from "./searchApis.js";
import { checkBrowsers } from "./browserCheck.js";
import { getStealthChromium } from "./stealthBrowser.js";

const SEARCH_TIMEOUT_MS = 15_000;
const PAGE_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_CHARS_PER_PAGE = 3000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebResearchResult {
  query: string;
  sources: Array<{ title: string; url: string; excerpt: string }>;
  // First usable product photo found among the researched pages (their
  // og:image meta tag — the same image a link preview/social share would
  // show), if any. Best-effort and unverified against the real listing —
  // just a representative reference photo for the Database card, not
  // something scoring relies on.
  imageUrl: string | null;
  // What the evidence check concluded when the name claims a specific edition/configuration (see variantEvidence.ts); null for a plain product name.
  evidence: VariantVerdict | null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// DuckDuckGo's HTML results wrap outbound links in a redirect
// (/l/?uddg=<encoded-real-url>&...) rather than linking straight to them.
function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const real = url.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

// One shared evidence reader: its search backends and the memory of which one blocked us last. Every search in this file goes through it, so a bot check from one
// search engine moves on to the next one instead of reading as "no results".
let evidenceDeps: EvidenceDeps | null = null;
function getEvidenceDeps(): EvidenceDeps {
  // Official search APIs first when the owner configured a key (see searchApis.ts), then the keyless engines.
  evidenceDeps ??= createEvidenceDeps({ render: renderPageText, backends: [...apiBackends(), ...DEFAULT_BACKENDS()] });
  return evidenceDeps;
}

/**
 * A page that a plain request cannot read (refused, or an empty JavaScript shell) is opened in a separate, throw-away browser (never the Facebook window) and its
 * rendered text taken. No AI is involved, so it costs no credits; it is only tried when the plain read showed nothing useful, at most twice per check.
 */
async function renderPageText(url: string): Promise<string | null> {
  if (!isPublicHttpUrl(url)) return null;
  let browser: import("playwright").Browser | null = null;
  try {
    const chromium = await getStealthChromium();
    const found = checkBrowsers().found[0];
    browser = await chromium.launch({ headless: true, ...(found ? { channel: found.channel } : {}) });
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 900 }, locale: "en-US" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
    const html = await page.content();
    const visible = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return `${extractEvidenceText(html)}\n${visible}`.slice(0, 60_000);
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function searchWeb(query: string, maxResults: number): Promise<SearchResult[]> {
  const deps = getEvidenceDeps();
  const hits = await deps.search(query, maxResults);
  // Every search engine refused or failed: that is an error, not "no results" (callers fall back to what they know, and say so).
  if (hits.length === 0 && searchWasUnavailable(deps.trace())) throw new Error("the web search was blocked or unreachable");
  return hits;
}

// Prefers the semantic <main>/<article> container when a page has one —
// verified live that a plain full-page strip put a wall of nav-menu/footer
// boilerplate ahead of the actual content, eating into the per-page
// character budget for nothing useful. Falls back to the whole body when
// neither tag is present, which still beats nothing.
function extractMainContent(html: string): string {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1];
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return articleMatch[1];
  return html;
}

// The og:image meta tag — same image a link preview/social share card
// would use. Attribute order varies by site (property-then-content vs
// content-then-property), so both are checked. Best-effort: absent on
// plenty of pages, which is fine, the caller just tries the next result.
function extractOgImage(html: string): string | null {
  const m =
    html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
  if (!m) return null;
  return m[1].replace(/&amp;/g, "&");
}

// A candidate image whose URL flags it as a logo/wordmark asset rather
// than genuine product photography — a raw or Wikipedia-rendered-thumbnail
// .svg (vector files on the open web are essentially always a logo, icon,
// or diagram, never a camera photo — Wikipedia's own thumbnail service
// keeps the original ".svg" filename embedded in the rendered ".png" URL,
// e.g. ".../Xbox_Series_X_S_color.svg/330px-....svg.png", so this checks
// for the substring anywhere, not just as the final extension) or a URL
// that literally says "logo". Rejected by every product-photo path below
// (findImageViaWikipedia, findProductImage, researchProductOnWeb) — this
// is the mirror image of findBrandLogoImage's own /logo/i requirement,
// which WANTS exactly what this rejects. Verified live: Wikipedia's own
// combined "Xbox Series X and Series S" article (both product names
// resolve to this ONE article) uses the shared green "X|S" wordmark as its
// infobox image — that used to get attributed as BOTH consoles' own
// product thumbnail instead of an actual photo of either one; the same
// live check found "Nintendo Switch" resolving to its logo too, so this is
// a systemic gap, not an Xbox-only one.
function looksLikeLogoAsset(url: string): boolean {
  return /\.svg/i.test(url) || /logo/i.test(url);
}

interface FetchedPage {
  text: string | null;
  imageUrl: string | null;
}

async function fetchPage(url: string, maxChars = MAX_CHARS_PER_PAGE): Promise<FetchedPage> {
  try {
    const res = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) return { text: null, imageUrl: null };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return { text: null, imageUrl: null };
    const html = await res.text();
    // A product page buries its name below pages of navigation: the readable text is searched whole (the main content when the page has one),
    // not just its first few thousand characters, when the caller is looking for a specific name.
    return {
      text: stripHtml(extractMainContent(html)).slice(0, maxChars),
      imageUrl: extractOgImage(html),
    };
  } catch {
    return { text: null, imageUrl: null };
  }
}

const EVIDENCE_PAGE_CHARS = 40_000;

/** The real search and page reader, in the shape the evidence check wants (traces what it asks and what comes back). */
export function webVerifyDeps(): EvidenceDeps {
  return getEvidenceDeps();
}

/** Whether a product name claims something specific enough to be worth an evidence check on its own (an edition, a regional model, a capacity in a color). */
export function claimsSpecificVariant(name: string): boolean {
  const a = extractVariantAttributes(name);
  return a.editionTerms.length > 0 || a.regions.length > 0 || (a.capacities.length > 0 && a.colors.length > 0);
}

// Gathers real web content about a product: search result snippets, plus
// the actual visible text of each top result page (falling back to just
// the snippet if a given page can't be fetched — a paywall, a timeout, a
// non-HTML response), plus the first usable product photo found along the
// way (same page fetches, no extra requests). One page fetch failing
// doesn't fail the whole search; only a failure of the search itself
// (network down, DuckDuckGo unreachable) throws, letting the caller fall
// back to training-knowledge-only research instead.
export async function researchProductOnWeb(
  productName: string,
  maxResults = DEFAULT_MAX_RESULTS,
  opts: { verdict?: VariantVerdict | null; brandHints?: string[]; deps?: VerifyDeps } = {}
): Promise<WebResearchResult> {
  const deps = opts.deps ?? webVerifyDeps();
  // A name that claims a specific edition or configuration is checked against evidence first-hand: the exact title, the product line plus its
  // distinctive words, the manufacturer's site, alternate spellings (see variantEvidence.ts). A caller that already did the check passes its verdict in.
  let evidence: VariantVerdict | null = opts.verdict ?? null;
  if (!evidence && claimsSpecificVariant(productName)) {
    evidence = await verifyVariant(productName, deps, { brandHints: opts.brandHints, maxSteps: 5 }).catch(() => null);
  }

  const query = `${productName} specs variants common problems`;
  let results: SearchResult[] = [];
  try {
    results = await searchWeb(query, maxResults);
  } catch (err) {
    // The general search being down only matters when there is nothing else to write from.
    if (!evidence || evidence.sources.length === 0) throw err;
  }

  const pages = await Promise.all(
    results.map(async (r) => {
      const page = await fetchPage(r.url);
      const excerpt = page.text && page.text.length > r.snippet.length ? page.text : r.snippet;
      return { title: r.title, url: r.url, excerpt, imageUrl: page.imageUrl };
    })
  );

  const sources = pages.filter((s) => s.excerpt.trim().length > 0).map(({ title, url, excerpt }) => ({ title, url, excerpt }));
  // The pages that settled the evidence check come first (the manufacturer's before a retailer's before the rest) and are not read twice.
  if (evidence) {
    const rank = { manufacturer: 0, retailer: 1, reference: 2, other: 3, marketplace: 4 } as const;
    const proof = evidence.sources
      .filter((s) => s.fullMatch && s.excerpt && !sources.some((x) => x.url === s.url))
      .sort((a, b) => rank[a.sourceClass] - rank[b.sourceClass])
      .slice(0, 3)
      .map((s) => ({ title: s.title, url: s.url, excerpt: (s.excerpt ?? "").slice(0, MAX_CHARS_PER_PAGE) }));
    sources.unshift(...proof);
  }

  return {
    query,
    sources,
    imageUrl: pages.find((p) => p.imageUrl && !looksLikeLogoAsset(p.imageUrl))?.imageUrl ?? null,
    evidence,
  };
}

/**
 * Clynx looking something up the way a person would: a web search, a skim of the top few pages, and the readable text handed back
 * for Clynx to digest and explain in its own words in the chat. Nothing is saved anywhere (that is research_product's job).
 * Never throws: a failure comes back as text Clynx can say out loud.
 */
export async function lookUpOnWeb(query: string, url?: string | null): Promise<string> {
  return lookUpWithDeps(query, webVerifyDeps(), url ?? null);
}

/**
 * The look-up itself, with the search and page reader passed in. Beyond the plain results it:
 *  - reads an address the user gave (only public http(s) pages), and says plainly when it could not;
 *  - when the query is a specific edition or configuration and the plain search did not settle it, goes on to the wider evidence search before
 *    anyone concludes anything, and says whether the result is VERIFIED, SUPPORTED, UNVERIFIED or DISPROVEN. An empty search is never "fake".
 */
export async function lookUpWithDeps(query: string, deps: VerifyDeps, url: string | null = null): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (!q && !url) return "Failed: no search query given.";
  const blocks: string[] = [];
  const evidenceInputs: Array<{ title: string; url: string; excerpt: string }> = [];
  const userUrls: string[] = [];

  // A pasted search-results link (Google / Bing / eBay...) is not a page that can be read; the words it searched for are searched instead.
  const linkQuery = url ? queryFromSearchUrl(url) : null;
  if (url && linkQuery) {
    blocks.push(`The link the user gave is a search-results page (searched for "${linkQuery}"), not a product page. I did not read it as a page; I used its search words as the search instead. Do NOT say you opened it.`);
  } else if (url) {
    if (!isPublicHttpUrl(url)) {
      blocks.push(`The address given (${url}) is not a public web page, so I did not open it.`);
    } else {
      const text = await deps.fetchText(url).catch(() => null);
      if (text) {
        userUrls.push(url);
        evidenceInputs.push({ title: url, url, excerpt: text });
        blocks.push(`The page the user linked (${hostOfUrl(url)}):\n${text.slice(0, 2500)}`);
      } else {
        blocks.push(`I could not read the page the user linked (${hostOfUrl(url)}); it may block automated readers. That is not evidence either way about the product. Do NOT claim you opened or checked it. Say you could not read it and ask for a screenshot or the exact title and box label.`);
      }
    }
  }

  let results: Array<{ title: string; url: string; snippet: string }> = [];
  let searchFailed: string | null = null;
  for (const searchQ of [...new Set([q, linkQuery ?? ""].filter(Boolean))]) {
    try {
      for (const r of await deps.search(searchQ, 5)) if (!results.some((x) => x.url === r.url)) results.push(r);
    } catch (err) {
      searchFailed = (err as Error).message;
    }
  }
  results = results.slice(0, 6);
  const searchTrace = deps.trace?.();
  if (q && results.length === 0 && searchTrace && searchTrace.searches.length > 0 && searchTrace.searches.every((x) => x.outcome === "blocked" || x.outcome === "error")) {
    blocks.push(`The web search itself was blocked or failed (${searchTrace.searches.slice(0, 3).map((x) => `${x.backend}: ${x.detail ?? x.outcome}`).join("; ")}). Say the lookup failed and offer to retry; do NOT say the search found nothing.`);
  }
  const pages = await Promise.all(
    results.slice(0, 4).map(async (r) => {
      const text = await deps.fetchText(r.url).catch(() => null);
      const body = text && text.length > r.snippet.length ? text : r.snippet;
      evidenceInputs.push({ title: r.title, url: r.url, excerpt: body });
      return { title: r.title, host: hostOfUrl(r.url), text: body.trim().slice(0, 1800) };
    })
  );
  const usable = pages.filter((p) => p.text.length > 0);
  if (usable.length > 0) {
    blocks.push(
      `Web results for "${q}". Read them and answer in your own words (don't paste them, and don't present anything here as certain if the sources disagree or look thin):\n\n` +
        usable.map((p, i) => `[${i + 1}] ${p.title} (${p.host})\n${p.text}`).join("\n\n")
    );
  } else if (q) {
    blocks.push(
      searchFailed
        ? `Failed: couldn't reach the web right now (${searchFailed}).`
        : `The exact search for "${q}" came back with nothing readable. That says nothing about whether the product exists.`
    );
  }

  // A specific edition or configuration: keep going past the exact title before anyone concludes anything.
  if (q && (claimsSpecificVariant(q) || userUrls.length > 0 || usable.length === 0)) {
    const first = assessEvidence(q, evidenceInputs);
    const verdict = first.status === "verified" || first.status === "disproven" ? first : await verifyVariant(q, deps, { userUrls, maxSteps: 5 }).catch(() => first);
    blocks.push(describeVerdictForAi(verdict));
    for (const s of verdict.sources.filter((x) => x.fullMatch && x.excerpt && !usable.some((u) => u.host === x.host)).slice(0, 2)) {
      blocks.push(`Evidence page (${s.host}, ${s.sourceClass}):\n${(s.excerpt ?? "").slice(0, 1200)}`);
    }
  }
  if (searchFailed && blocks.length === 0) return `Failed: couldn't reach the web right now (${searchFailed}).`;
  return blocks.join("\n\n");
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Wikipedia's public REST summary API — tried FIRST because it's a real,
// stable JSON endpoint meant for programmatic use (no bot-detection risk,
// unlike scraping a search engine's result page), and it usually has a
// clean infobox photo for exactly the kind of mainstream consumer product
// this app deals in (game consoles, phones, laptops...). Silently returns
// null for anything obscure enough not to have its own article — that's
// expected, not an error, and the DuckDuckGo-based fallback below picks up
// from there.
async function findWikipediaPage(productName: string): Promise<{ url: string; title: string } | null> {
  try {
    const res = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(productName.trim().replace(/\s+/g, "_"))}`,
      PAGE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string; type?: string; description?: string; thumbnail?: { source?: string }; originalimage?: { source?: string } };
    const url = data.thumbnail?.source ?? data.originalimage?.source ?? null;
    if (!url || looksLikeLogoAsset(url) || data.type === "disambiguation") return null;
    // The article's own title (and one-line description) is the evidence of what the picture shows: a redirect can land on a game, a film or a different product.
    return { url, title: [data.title, data.description].filter(Boolean).join(" - ") };
  } catch {
    return null;
  }
}

async function findImageViaWikipedia(productName: string): Promise<string | null> {
  return (await findWikipediaPage(productName))?.url ?? null;
}

// OpenAI's vision endpoint only accepts png/jpeg/gif/webp — verified live
// it flat-out 400s ("invalid_image_format") on an SVG, which is exactly
// what Wikidata's own logo files almost always are (findBrandLogoViaWikidata
// below). Without this, every brand-logo vision check would silently no-op
// via findAndVerifyImage's own error-tolerant fallback (an API error there
// is deliberately treated as "accept anyway," which is the right call for
// a genuine outage but would otherwise make the vision check pointless for
// logos specifically, every single time. Rasterizes ONLY for the vision
// call — the original SVG (crisper at any size than a rendered raster)
// still gets returned/stored when verification passes. Flattened onto
// white since that's the same backdrop Database.tsx's FamilyTile already
// renders a logo against.
async function rasterizeForVision(dataUri: string): Promise<string> {
  if (!/^data:image\/svg/i.test(dataUri)) return dataUri;
  try {
    const base64 = dataUri.split(",")[1];
    const png = await sharp(Buffer.from(base64, "base64"))
      .resize(512, 512, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // Falls through with the original SVG — verifyThumbnailCandidate will
    // just get the same 400 from OpenAI and findAndVerifyImage treats that
    // as "couldn't verify, accept anyway," same as any other API hiccup.
    return dataUri;
  }
}

// Per explicit instruction — thumbnail-finding should use both text-based
// candidate-finding (a search query, an og:image, a URL pattern) AND
// actual image analysis before accepting one, not just the text signal
// alone. Downloads and vision-verifies each candidate URL in order (see
// vision.ts's verifyThumbnailCandidate), returning the first that both
// downloads successfully and isn't confidently REJECTED by the vision
// check. A verification ERROR (an API hiccup, no key configured) is
// deliberately treated as "can't verify, accept anyway" rather than a
// rejection — the alternative would make thumbnail-finding silently fail
// forever the moment OpenAI is briefly unreachable, worse than the
// occasional unverified candidate this app already accepted before this
// check existed. Returns the ORIGINAL downloaded data: URI (not the
// possibly-rasterized one used only for the vision call, and not the
// remote URL) since verifying it already required downloading it — the
// caller never needs to re-fetch the same bytes a second time.
async function findAndVerifyImage(candidateUrls: string[], subjectName: string, kind: "product" | "brandLogo" | "group"): Promise<string | null> {
  for (const url of candidateUrls) {
    const dataUri = await downloadImageAsDataUri(url);
    if (!dataUri) continue;
    const visionInput = await rasterizeForVision(dataUri);
    const check = await verifyThumbnailCandidate(visionInput, subjectName, kind);
    // A picture of a PRODUCT is filed only on a yes: a verifier outage must not let a game box or a stranger's photo become a product's thumbnail (Beta 12). A logo or a folder image
    // may still be accepted when the check itself could not run.
    if (check.matches || (check.error && kind !== "product")) return dataUri;
  }
  return null;
}

// Dedicated fallback for finding a representative photo, used when
// researchProductOnWeb's own search — oriented around "specs variants
// common problems" to find good write-up text — didn't happen to turn up an
// og:image among its handful of results, AND Wikipedia doesn't have this
// product. A bare product-name query is far more likely to surface a
// retailer page with a clean product photo than the specs/problems-oriented
// query, and checking more results specifically for an image (not just the
// ones already fetched for text) meaningfully raises the odds of a real
// photo instead of the Database falling back to a placeholder — per
// explicit instruction, the product's photo is now the whole way into
// seeing its details, so this matters more than a nice-to-have. Best-effort
// throughout: never throws, just returns null so a failure here can't break
// the rest of the research. preferredCandidateUrl lets a caller that
// already found a plausible og:image elsewhere (researchProductOnWeb) feed
// it in as the FIRST candidate to verify, rather than duplicating its own
// separate vision-verified search — still verified here just like every
// other candidate, never blindly trusted.
export async function findProductImage(productName: string, preferredCandidateUrl?: string | null, maxResults = 8): Promise<string | null> {
  if (isLowAiMode()) {
    const free = await findFreeReferencePhotos(productName, { want: 1 });
    return free[0]?.imageData ?? null;
  }
  const candidates: string[] = [];
  if (preferredCandidateUrl) candidates.push(preferredCandidateUrl);
  const wiki = await findImageViaWikipedia(productName);
  if (wiki) candidates.push(wiki);
  try {
    const results = await searchWeb(productName, maxResults);
    for (const r of results) {
      const page = await fetchPage(r.url);
      if (page.imageUrl && !looksLikeLogoAsset(page.imageUrl) && !candidates.includes(page.imageUrl)) candidates.push(page.imageUrl);
      if (candidates.length >= 5) break; // bounded — each is a real download + a vision call
    }
  } catch {
    // A dead search still leaves whatever candidates were already found
    // (preferredCandidateUrl, Wikipedia) to try.
  }
  return findAndVerifyImage(candidates, productName, "product");
}

// Condition-awareness — parallels findProductImage above, but deliberately
// searches for a damaged/poor-condition example instead of a clean one, so
// the Database can show what a beat-up real one actually looks like. Skips
// the Wikipedia lookup (no dedicated article for a damaged variant of
// anything) and reuses the exact same "product" vision-verification check
// findProductImage does — that check only confirms "is this genuinely a
// photo of the product itself, not a logo/unrelated thing," which a
// damaged unit still satisfies, so no new vision prompt is needed here.
// Best-effort like every other research step in this app: returns null
// (never throws) on no hit, so a failure here can't take down the rest of
// product research.
export async function findPoorConditionProductImage(productName: string, maxResults = 8): Promise<string | null> {
  if (isLowAiMode()) return null;
  const candidates: string[] = [];
  try {
    const results = await searchWeb(`${productName} damaged broken cracked for parts`, maxResults);
    for (const r of results) {
      const page = await fetchPage(r.url);
      if (page.imageUrl && !looksLikeLogoAsset(page.imageUrl) && !candidates.includes(page.imageUrl)) candidates.push(page.imageUrl);
      if (candidates.length >= 5) break;
    }
  } catch {
    // Nothing to fall back to here (no preferredCandidateUrl/Wikipedia the
    // way findProductImage has) — a dead search just means no hit.
  }
  return findAndVerifyImage(candidates, productName, "product");
}

// Per explicit instruction — a representative "collection" photo for a
// FOLDER-level grouping (e.g. "Xbox games", "Xbox accessories") rather
// than one specific product — see index.ts's group-thumbnail caching
// (store.ts's group_thumbnails table) and Database.tsx's FamilyTile.
// Deliberately skips findImageViaWikipedia's per-article lookup that
// findProductImage does first: a generic bucket phrase like "Xbox games"
// has no Wikipedia article of its own to resolve to, so there's nothing
// useful to try there. Same anti-logo/anti-SVG filtering as
// findProductImage — a "Games" folder showing the brand's own logo would
// be exactly as wrong as a specific console showing it.
export async function findGroupImage(query: string, maxResults = 8): Promise<string | null> {
  if (isLowAiMode()) return findFreeGroupImage(query);
  const candidates: string[] = [];
  try {
    const results = await searchWeb(query, maxResults);
    for (const r of results) {
      const page = await fetchPage(r.url);
      if (page.imageUrl && !looksLikeLogoAsset(page.imageUrl) && !candidates.includes(page.imageUrl)) candidates.push(page.imageUrl);
      if (candidates.length >= 5) break;
    }
  } catch {
    // leaves candidates (possibly empty) as-is
  }
  return findAndVerifyImage(candidates, query, "group");
}

// A brand/company's official "logo image" (Wikidata property P154) —
// purpose-BUILT and curated for exactly this, unlike a generic company-
// article thumbnail (often a headquarters photo, a founder portrait, or
// similarly wrong — see findImageViaWikipedia's own history) or a "<brand>
// logo" web search (verified live: it tends to fail for the BIGGEST, most
// famous brands specifically — "Nintendo logo", "Apple logo", and "MSI
// logo" searches all came back empty via the DuckDuckGo fallback below,
// apparently because their SEO landscape is dominated by stock-logo
// marketplaces this simple fetch can't cleanly extract an image from,
// while smaller/lesser-known brands worked fine there).
//
// Entity selection is two-tier, both verified live against real failures:
// 1. Prefer an EXACT (case-insensitive) label match that actually HAS a
//    P154 — not just the first exact match. A bare "Apple" search returns
//    FOUR entities labeled exactly "Apple" (the fruit, a given name, a
//    trademark, an album) before ever reaching "Apple Inc." — checking
//    every exact match for one with a logo, not stopping at the first,
//    matters because none of those four literal-"Apple" entities has a
//    logo at all. This tier also fixes the opposite failure mode: a bare
//    "Xbox" search's TOP hit overall is "Xbox Series X and Series S"
//    (whose own logo is that generation's shared wordmark, not the plain
//    Xbox brand mark) — an exact-label match correctly prefers the plain
//    "Xbox" entity over that more specific variant, even though it ranks
//    lower in Wikidata's own relevance order.
// 2. If no exact-label match has a logo (the Apple case — "Apple Inc." is
//    Wikidata's real label, not bare "Apple"), fall back to the first
//    result in Wikidata's own ranked order that has one at all — Wikidata
//    ranked "Apple Inc." first overall for a bare "Apple" query, so this
//    still lands correctly without needing to guess corporate-suffix
//    variations ("Apple Inc.", "Apple Corporation", ...) by hand.
// Returns null (never throws) when NOTHING in the results has a P154 at
// all (a bare abbreviation like "MSI" collides only with unrelated
// entities on Wikidata, none of them logo-bearing) — the caller falls back
// to the DuckDuckGo-based search either way, and whatever this DOES return
// still has to clear findAndVerifyImage's own vision check before being
// accepted, so a wrong pick here isn't the only safeguard.
async function findBrandLogoViaWikidata(brand: string, exactOnly = false): Promise<string | null> {
  try {
    const searchRes = await fetchWithTimeout(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(brand)}&language=en&format=json&limit=8`,
      PAGE_FETCH_TIMEOUT_MS
    );
    if (!searchRes.ok) return null;
    const searchData = (await searchRes.json()) as { search?: Array<{ id: string; label?: string }> };
    const hits = searchData.search ?? [];
    if (!hits.length) return null;

    const normalizedBrand = brand.trim().toLowerCase();
    const exactMatches = hits.filter((hit) => hit.label?.trim().toLowerCase() === normalizedBrand);
    const candidateOrder = exactOnly ? exactMatches : [...exactMatches, ...hits.filter((hit) => !exactMatches.includes(hit))];

    for (const hit of candidateOrder) {
      const entityRes = await fetchWithTimeout(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`, PAGE_FETCH_TIMEOUT_MS);
      if (!entityRes.ok) continue;
      const entityData = (await entityRes.json()) as { entities?: Record<string, any> };
      const filename = entityData.entities?.[hit.id]?.claims?.P154?.[0]?.mainsnak?.datavalue?.value as string | undefined;
      if (!filename) continue;
      // Special:FilePath redirects straight to the raw file bytes (verified
      // live: a proper image/svg+xml or image/png response, not an HTML
      // wrapper page) — fetch()/downloadImageAsDataUri follow the redirect
      // transparently.
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}`;
    }
    return null;
  } catch {
    return null;
  }
}

// Per explicit instruction — a dedicated logo finder for a brand/company
// name (see index.ts's runProductLookup, which uses this for a family's
// folder thumbnail when it's a real brand — see types.ts's
// ProductProfile.familyLogoUrl), deliberately NOT just findProductImage
// above with " logo" appended to the query. Tries Wikidata's curated logo
// property first (see findBrandLogoViaWikidata), then falls back to a
// "<brand> logo" web search requiring the candidate image's own URL to
// contain "logo" — true for essentially every real logo asset (Wikimedia
// Commons files like "Logo_NIKE.svg", dedicated logo sites like
// seeklogo.com's "xbox-one-logo-png_...") and false for an unrelated photo
// a company's own page might also have an og:image of. Best-effort, same
// as every other image lookup in this file: returns null (never throws) on
// no match or any failure, which the caller already treats as "no logo
// found yet" rather than an error.
export async function findBrandLogoImage(brand: string, maxResults = 8): Promise<string | null> {
  if (isLowAiMode()) return findFreeBrandLogo(brand);
  const candidates: string[] = [];
  const wikidataLogo = await findBrandLogoViaWikidata(brand);
  if (wikidataLogo) candidates.push(wikidataLogo);
  try {
    const results = await searchWeb(`${brand} logo`, maxResults);
    for (const r of results) {
      const page = await fetchPage(r.url);
      if (page.imageUrl && /logo/i.test(page.imageUrl) && !candidates.includes(page.imageUrl)) candidates.push(page.imageUrl);
      if (candidates.length >= 5) break;
    }
  } catch {
    // leaves candidates (possibly just the Wikidata one, or empty) as-is
  }
  return findAndVerifyImage(candidates, brand, "brandLogo");
}

const MAX_IMAGE_BYTES = 4_000_000;

// Actually downloads the image bytes and re-packages them as a data: URI
// instead of just storing the remote URL — a hotlinked URL can quietly stop
// rendering later for reasons entirely outside this app (hotlink
// protection keyed on referrer, the source page taking the image down, a
// CORS/CSP restriction in the renderer), which is indistinguishable from
// "no image was ever found" once it happens — the Database card just shows
// the placeholder again with no error anywhere to explain why. Downloading
// once, server-side, and keeping the bytes makes the photo permanent
// regardless of what happens to the original page. Caps the size so one
// oversized asset can't bloat the SQLite row unreasonably; rejects non-image
// responses. Best-effort: returns null (never throws) on any failure, same
// as everything else in this file.
export async function downloadImageAsDataUri(url: string): Promise<string | null> {
  const result = await downloadImageBuffer(url);
  return result ? `data:${result.contentType};base64,${result.buffer.toString("base64")}` : null;
}

// Per explicit instruction — ntfy notifications now attach the listing's
// own photo (notify.ts), which needs the raw bytes to upload directly
// rather than a base64 data: URI — pulled the actual download out of
// downloadImageAsDataUri above (which now just calls this and re-encodes)
// instead of duplicating the fetch/timeout/size-cap logic in notify.ts too.
export async function downloadImageBuffer(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    return { buffer, contentType };
  } catch {
    return null;
  }
}

// A photo kept only to be SHOWN in a Feed card (not to be analysed): scaled down so its
// longest side is at most maxSide px and re-encoded as a JPEG. A listing photo that was
// stored whole is ~150-200 KB of base64 per card, which the Feed then had to ship over IPC,
// hold in memory and decode again on every refresh. Returns the input unchanged if it is
// already small or can't be processed.
export async function shrinkImageDataUri(dataUri: string, maxSide = 640, quality = 78): Promise<string> {
  const parsed = parseDataUri(dataUri);
  if (!parsed || dataUri.length < 60_000) return dataUri;
  try {
    const out = await sharp(parsed.buffer).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    const shrunk = `data:image/jpeg;base64,${out.toString("base64")}`;
    return shrunk.length < dataUri.length ? shrunk : dataUri;
  } catch {
    return dataUri;
  }
}

function parseDataUri(dataUri: string): { buffer: Buffer } | null {
  const m = dataUri.match(/^data:[^;]+;base64,(.+)$/);
  return m ? { buffer: Buffer.from(m[1], "base64") } : null;
}

const COLLAGE_TILE_PX = 300;

// Per explicit instruction — the fallback thumbnail for when a dedicated
// web image search (findProductImage) comes up completely empty AND
// there's no existing thumbnail to fall back to: rather than leaving the
// Database card with no photo at all, build a simple grid collage out of
// whatever real reference photos this product already has (see
// store.addProductImage — a brand-new auto-created product already has at
// least the one real listing photo that triggered it, saved there BEFORE
// this ever runs — see index.ts's onNewProductFound). Each source photo is
// resized to fill its own square tile (cropped, not letterboxed) so the
// result reads as one deliberate image instead of a grid of mismatched
// aspect ratios. Best-effort throughout: a single corrupt source photo is
// skipped rather than failing the whole collage; returns null (never
// throws) with fewer than 2 usable photos, since a "collage" of one photo
// is just that photo.
export async function buildImageCollage(imageDataUris: string[], maxTiles = 9): Promise<string | null> {
  const tiles: Buffer[] = [];
  for (const uri of imageDataUris.slice(0, maxTiles)) {
    const parsed = parseDataUri(uri);
    if (!parsed) continue;
    try {
      const tile = await sharp(parsed.buffer).resize(COLLAGE_TILE_PX, COLLAGE_TILE_PX, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
      tiles.push(tile);
    } catch {
      // A single corrupt/unreadable source photo shouldn't sink the whole
      // collage — just leaves one fewer tile.
    }
  }
  if (tiles.length < 2) return null;

  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const composites = tiles.map((tile, i) => ({
    input: tile,
    left: (i % cols) * COLLAGE_TILE_PX,
    top: Math.floor(i / cols) * COLLAGE_TILE_PX,
  }));

  try {
    const canvas = await sharp({
      create: { width: cols * COLLAGE_TILE_PX, height: rows * COLLAGE_TILE_PX, channels: 3, background: { r: 20, g: 18, b: 28 } },
    })
      .composite(composites)
      .jpeg({ quality: 85 })
      .toBuffer();
    return `data:image/jpeg;base64,${canvas.toString("base64")}`;
  } catch {
    return null;
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CATEGORY_IMAGE_PX = 1024;
const CATEGORY_IMAGE_TIMEOUT_MS = 60_000;

// Per explicit instruction — "instead of there being 4 different photos
// smashed into one, generate an image of '<category>' and include text on
// the image of what that category is... make sure it's the same format for
// the image creation process and it uses the same font in the same size in
// the same spot in every thumbnail." Two deliberately separate steps, not
// one single image-gen call asked to include the label itself: image
// generation models are unreliable at rendering clean, correctly-spelled,
// consistently-positioned text (a well-known weak spot even in current
// models) — asking gpt-image-1 for the artwork ONLY (explicitly told not to
// include any text/logos/watermarks) and then compositing the label on
// ourselves with sharp/SVG is what actually GUARANTEES "same font, same
// size, same spot every time," since that overlay is fixed code, not a
// fresh generation each time. Category names are a small, fixed list (see
// Database.tsx's CATEGORY_ORDER), so this only ever runs a bounded number
// of times total, then caches forever (see index.ts's ensureCategoryThumbnail
// — same store.ts group_thumbnails table/cache-forever pattern as folder
// thumbnails, just keyed by the plain category name instead of a family
// path).
export async function generateCategoryImage(category: string): Promise<string | null> {
  // An AI image-generation call per category folder: not worth credits. The folder shows its products' own photos.
  if (isLowAiMode()) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CATEGORY_IMAGE_TIMEOUT_MS);
    let artworkBuffer: Buffer;
    try {
      const res = await callOpenAI(
        "images",
        {
          model: OPENAI_IMAGE_MODEL,
          prompt: `A clean, professional stock-photo-style image representing the product category "${category}" for a reseller's catalog folder icon. Simple, uncluttered composition, realistic or tastefully illustrated, centered subject. Absolutely NO text, NO letters, NO words, NO logos, NO watermarks anywhere in the image.`,
          size: "1024x1024",
          n: 1,
        },
        controller.signal, "web research");
      if (!res.ok) throw new Error(`OpenAI image API error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error("No image returned");
      artworkBuffer = Buffer.from(b64, "base64");
    } finally {
      clearTimeout(timeout);
    }

    // Fixed dark bar across the bottom third + centered bold white label —
    // literally the same SVG shape/position/font/size every single call,
    // only the text content itself changes. Generic bold sans-serif (not
    // one of this app's own bundled fonts) since sharp's SVG renderer needs
    // a font actually installed/embeddable where the main process runs —
    // this guarantees identical rendering everywhere rather than silently
    // falling back to something else if a specific custom font isn't found.
    const barTop = Math.round(CATEGORY_IMAGE_PX * 0.72);
    const barHeight = CATEGORY_IMAGE_PX - barTop;
    const fontSize = 46;
    const svg = `
      <svg width="${CATEGORY_IMAGE_PX}" height="${CATEGORY_IMAGE_PX}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="${barTop}" width="${CATEGORY_IMAGE_PX}" height="${barHeight}" fill="rgba(10,10,16,0.72)" />
        <text
          x="50%"
          y="${barTop + barHeight / 2}"
          font-family="Arial, Helvetica, sans-serif"
          font-weight="700"
          font-size="${fontSize}"
          fill="#ffffff"
          text-anchor="middle"
          dominant-baseline="middle"
        >${escapeXml(category)}</text>
      </svg>`;

    // Verified live: chaining resize -> composite -> resize in ONE sharp
    // pipeline reliably threw "Image to composite must have same
    // dimensions or smaller," even though the pre-composite buffer and the
    // SVG overlay were both confirmed exactly CATEGORY_IMAGE_PX square —
    // isolated testing traced it specifically to a second .resize() chained
    // right after .composite() in the same pipeline (removing just that
    // trailing resize made the identical composite call succeed every
    // time). Splitting into three separately-materialized steps — resize to
    // square, THEN composite the text overlay, THEN resize down to the
    // final thumbnail size — sidesteps whatever fusion/reordering sharp was
    // doing across those chained calls.
    const squared = await sharp(artworkBuffer).resize(CATEGORY_IMAGE_PX, CATEGORY_IMAGE_PX, { fit: "cover" }).toBuffer();
    const labeled = await sharp(squared)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();
    const composed = await sharp(labeled).resize(640, 640).jpeg({ quality: 88 }).toBuffer();
    return `data:image/jpeg;base64,${composed.toString("base64")}`;
  } catch (err) {
    console.error(`[category-image] failed for "${category}": ${(err as Error).message}`);
    return null;
  }
}


// --- Stock / reference photo gathering --------------------------------------
// Per explicit instruction: a newly-found product should get a real product
// photo as its Database thumbnail (not an empty box) AND a whole set of
// reference photos, so the scanner already recognizes it on its next
// Facebook/eBay encounter.
//
// Why this exists: findProductImage above depends on DuckDuckGo's HTML
// search, which now answers every automated request with a bot challenge
// (HTTP 202, zero results) — verified live — so anything without its own
// Wikipedia article came back with no photo at all. This pulls candidates
// from sources that currently work with a plain request instead:
//   1. Wikipedia's page image (clean, usually a retail product shot/cover).
//   2. Bing Images — dozens of full-size retailer/stock photos per query.
//   3. eBay's Browse API listing photos, if credentials are configured —
//      used to top up when the first two don't yield enough.
// Every candidate is downloaded, normalized, de-duplicated (perceptual
// hash, so the same photo syndicated across ten retailer sites only counts
// once) and then vision-verified against the exact product before it's
// kept.

const REFERENCE_PHOTO_MAX_DIM = 800;
const REFERENCE_PHOTO_MIN_DIM = 200;
const REFERENCE_CANDIDATE_LIMIT = 44;
const REFERENCE_CONCURRENCY = 4;
const REFERENCE_TIME_BUDGET_MS = 120_000;
// Two photos this close (out of 64 bits) are the same picture, re-encoded or
// resized — not two different angles.
const NEAR_DUPLICATE_HAMMING = 6;

async function searchBingImages(query: string, max: number): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`, SEARCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const html = await res.text();
    const urls: string[] = [];
    // Each result tile carries its full-size source as "murl" inside an
    // HTML-escaped JSON attribute (quotes as &quot;, ampersands as &amp;).
    const re = /murl&quot;:&quot;(https?:.*?)&quot;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && urls.length < max * 2) {
      const url = m[1].replace(/&amp;/g, "&");
      if (looksLikeLogoAsset(url) || /\.gif(\?|$)/i.test(url)) continue;
      if (!urls.includes(url)) urls.push(url);
    }
    return urls.slice(0, max);
  } catch {
    return [];
  }
}

// 64-bit average hash: shrink to 8x8 grayscale, bit = pixel brighter than
// the mean. Cheap, and robust to resizing/re-compression.
async function averageHash(jpeg: Buffer): Promise<string> {
  const { data } = await sharp(jpeg).greyscale().resize(8, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / data.length;
  let bits = "";
  for (const v of data) bits += v > mean ? "1" : "0";
  return bits;
}

function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Resizes to a sane storage size (a stock photo straight off a retailer CDN
// can be several MB), flattens transparency onto white (cut-out product PNGs
// are common and would otherwise store as black), and rejects images too
// small to identify anything in or with a banner-like aspect ratio.
async function normalizeReferencePhoto(buffer: Buffer): Promise<{ dataUri: string; hash: string } | null> {
  try {
    const img = sharp(buffer, { failOn: "none" }).rotate();
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w < REFERENCE_PHOTO_MIN_DIM || h < REFERENCE_PHOTO_MIN_DIM) return null;
    const ratio = w / h;
    if (ratio > 2.2 || ratio < 0.45) return null;
    const jpeg = await img
      .resize(REFERENCE_PHOTO_MAX_DIM, REFERENCE_PHOTO_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { dataUri: `data:image/jpeg;base64,${jpeg.toString("base64")}`, hash: await averageHash(jpeg) };
  } catch {
    return null;
  }
}

export interface ReferencePhoto {
  imageData: string;
  // Short human label for where it came from — stored as the reference
  // photo's sourceTitle so the Database shows it wasn't a real listing.
  label: string;
  // Beta 13: the words that came with the picture, whether a picture check confirmed it, and where it came from - what fileImage.ts decides on.
  text?: string | null;
  verified?: boolean;
  url?: string | null;
}

export interface ReferenceCandidate {
  url: string;
  label: string;
  // Words that came with the image and say what it shows (an eBay listing's title, a Wikipedia article's title): the evidence photoIdentity.ts judges. Absent for an
  // image search result, which carries none.
  text?: string | null;
}

async function gatherReferenceCandidates(productName: string, extra: { queries?: string[]; realWorld?: boolean } = {}): Promise<ReferenceCandidate[]> {
  const candidates: ReferenceCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string, text?: string | null) => {
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, label, text: text ?? null });
  };

  const wiki = await findWikipediaPage(productName);
  if (wiki) add(wiki.url, "Stock photo — Wikipedia", wiki.title);

  // Two phrasings: the bare name, then "product photo" appended, which
  // steers Bing toward clean retail shots (and away from wallpapers and
  // gameplay screenshots) for products whose bare name is mostly media.
  // The user's own search words (a pasted Google Images link's query) are searched first; "real-world" adds listing-style photos of actual units (how people
  // photograph them for sale), next to the official-looking shots.
  const [plain, productShots, userShots, realShots] = await Promise.all([
    searchBingImages(productName, 24),
    searchBingImages(`${productName} product photo`, 24),
    Promise.all((extra.queries ?? []).slice(0, 2).map((q) => searchBingImages(q, 16))).then((r) => r.flat()),
    extra.realWorld ? searchBingImages(`${productName} used for sale`, 16) : Promise.resolve([] as string[]),
  ]);
  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "web";
    }
  };
  for (const u of userShots) add(u, `Image search — ${hostOf(u)}`);
  for (const u of realShots) add(u, `Real-world photo — ${hostOf(u)}`);
  // Interleave so a poor first query can't crowd out a good second one.
  for (let i = 0; i < Math.max(plain.length, productShots.length); i++) {
    if (plain[i]) add(plain[i], `Stock photo — ${hostOf(plain[i])}`);
    if (productShots[i]) add(productShots[i], `Stock photo — ${hostOf(productShots[i])}`);
  }

  if (hasEbayCredentials()) {
    try {
      const items = await searchEbayItems(productName, { limit: 15 });
      for (const item of items) {
        if (!item.imageUrl) continue;
        // Search results carry a 225px thumbnail; the same path at s-l1600
        // is the full-size original.
        // Beta 12: an eBay result is only as good as its title - a game or accessory that matched the search is rejected here, before any picture is downloaded or checked.
        add(item.imageUrl.replace(/s-l\d+(\.\w+)$/i, "s-l1600$1"), `eBay listing photo — ${item.title.slice(0, 80)}`, item.title);
      }
    } catch {
      // eBay being unavailable just means fewer candidates.
    }
  }
  return candidates.slice(0, REFERENCE_CANDIDATE_LIMIT);
}

// Reference photos with NO AI involved (no OpenAI credits): a Wikipedia article image and the photos of eBay listings
// whose titles pass plain text checks (every word of the product's name, same model number/capacity/tier/color, and no
// "parts"/"case only"/"bundle" wording). Less thorough than the vision-verified search above (web image search is left
// out entirely, since without vision nothing could vouch for it), but free, and reliable enough to give a blank-box
// entry a real photo. Best-effort: never throws; returns whatever it found.
export async function findFreeReferencePhotos(
  productName: string,
  // `candidates`: photos already in hand (eBay listings already confirmed to be this product); used instead of searching.
  opts: { want: number; existingImages?: string[]; candidates?: ReferenceCandidate[] }
): Promise<ReferencePhoto[]> {
  const photos: ReferencePhoto[] = [];
  try {
    const candidates: ReferenceCandidate[] = opts.candidates ? [...opts.candidates] : [];
    const seen = new Set<string>();
    const add = (url: string, label: string, text?: string | null) => {
      if (!seen.has(url)) {
        seen.add(url);
        candidates.push({ url, label, text: text ?? null });
      }
    };
    if (!opts.candidates) {
      const wiki = await findWikipediaPage(productName);
      if (wiki) add(wiki.url, "Stock photo — Wikipedia", wiki.title);
    }
    if (!opts.candidates && hasEbayCredentials()) {
      try {
        const items = await searchEbayItems(productName, { limit: 30 });
        for (const item of items) {
          if (!item.imageUrl || !titleLooksLikeProduct(productName, item.title)) continue;
          add(item.imageUrl.replace(/s-l\d+(\.\w+)$/i, "s-l800$1"), `eBay listing: ${item.title.slice(0, 90)}`, item.title);
        }
      } catch {
        // eBay being unavailable just means fewer candidates.
      }
    }
    const hashes: string[] = [];
    for (const uri of opts.existingImages ?? []) {
      const parsed = parseDataUri(uri);
      if (!parsed) continue;
      try {
        hashes.push(await averageHash(parsed.buffer));
      } catch {
        // an unreadable existing photo just can't be used for dedup
      }
    }
    for (const candidate of candidates.slice(0, 14)) {
      if (photos.length >= opts.want) break;
      // Beta 12: with no picture check available, only a title that confirms the product may file an image (photoIdentity.fileableWithoutPicture); an image search result has no title.
      const identity = judgeCandidateByText(productName, candidate.text ?? titleFromLabel(candidate.label));
      if (!fileableWithoutPicture(identity)) continue;
      const download = await downloadImageBuffer(candidate.url);
      if (!download) continue;
      const normalized = await normalizeReferencePhoto(download.buffer);
      if (!normalized || hashes.some((h) => hammingDistance(h, normalized.hash) <= NEAR_DUPLICATE_HAMMING)) continue;
      hashes.push(normalized.hash);
      photos.push({ imageData: normalized.dataUri, label: candidate.label, text: candidate.text ?? titleFromLabel(candidate.label), verified: false, url: candidate.url });
    }
  } catch (err) {
    console.error(`[freePhotos] "${productName}" failed: ${(err as Error).message}`);
  }
  console.log(`[freePhotos] "${productName}": kept ${photos.length}/${opts.want}`);
  return photos;
}

// A folder's picture without AI: a brand's logo from Wikidata (only when the entity's name is exactly the brand), or the
// Wikipedia article image for a grouping like "Xbox Games". Null when there is nothing trustworthy.
export async function findFreeBrandLogo(brand: string): Promise<string | null> {
  try {
    const url = await findBrandLogoViaWikidata(brand, true);
    return url ? await downloadImageAsDataUri(url) : null;
  } catch {
    return null;
  }
}

export async function findFreeGroupImage(query: string): Promise<string | null> {
  try {
    const url = await findImageViaWikipedia(query);
    if (!url) return null;
    const download = await downloadImageBuffer(url);
    if (!download) return null;
    const normalized = await normalizeReferencePhoto(download.buffer);
    return normalized?.dataUri ?? null;
  } catch {
    return null;
  }
}

// Finds up to `want` verified reference photos of one exact product.
// `existingImages` (data URIs the product already has) are used only to skip
// near-duplicates. Best-effort throughout: never throws, returns whatever it
// managed to verify (possibly nothing). Photos come back best-first —
// candidate order is Wikipedia, then Bing results, then eBay — so the first
// one is the natural thumbnail.
export async function findReferencePhotos(
  productName: string,
  // `candidates`: photos already in hand (e.g. from eBay listings that were confirmed to be this product) to check
  // instead of searching the web for some. They go through the same download, duplicate and vision checks.
  opts: { want: number; existingImages?: string[]; candidates?: ReferenceCandidate[]; extraQueries?: string[]; realWorld?: boolean }
): Promise<{ photos: ReferencePhoto[]; examined: number; rejectedByIdentity?: number }> {
  // Save-credits mode: no vision check of any candidate. See findFreeReferencePhotos.
  if (isLowAiMode()) {
    return { photos: await findFreeReferencePhotos(productName, opts), examined: 0 };
  }
  const photos: Array<ReferencePhoto & { rank: number }> = [];
  let examined = 0;
  let rejectedByIdentity = 0;
  try {
    const candidates = opts.candidates ?? (await gatherReferenceCandidates(productName, { queries: opts.extraQueries, realWorld: opts.realWorld }));
    const hashes: string[] = [];
    for (const uri of opts.existingImages ?? []) {
      const parsed = parseDataUri(uri);
      if (!parsed) continue;
      try {
        hashes.push(await averageHash(parsed.buffer));
      } catch {
        // an unreadable existing photo just can't be used for dedup
      }
    }

    const deadline = Date.now() + REFERENCE_TIME_BUDGET_MS;
    let next = 0;
    let consecutiveVerifyErrors = 0;
    const worker = async () => {
      while (photos.length < opts.want && Date.now() < deadline && consecutiveVerifyErrors < 3) {
        const rank = next++;
        if (rank >= candidates.length) return;
        const candidate = candidates[rank];
        // Beta 12: a candidate whose own title says it is a game, an accessory or another model is rejected here, with no download and no AI call.
        const identity = judgeCandidateByText(productName, candidate.text ?? titleFromLabel(candidate.label));
        if (identity.status === "mismatch") {
          rejectedByIdentity++;
          noteDecision({ kind: "reference_photo_check", subject: candidate.text ?? candidate.label, verdict: "rejected from its title (no AI used)", thought: `For "${productName}": ${identity.reasons.join("; ")}` });
          continue;
        }
        const download = await downloadImageBuffer(candidate.url);
        if (!download) continue;
        const normalized = await normalizeReferencePhoto(download.buffer);
        if (!normalized) continue;
        // Claimed BEFORE the (slow) vision call so two workers holding the
        // same picture from different sites can't both pass the check.
        if (hashes.some((h) => hammingDistance(h, normalized.hash) <= NEAR_DUPLICATE_HAMMING)) continue;
        hashes.push(normalized.hash);
        examined++;
        const check = await verifyThumbnailCandidate(normalized.dataUri, productName, "reference");
        if (check.error) {
          // Unlike a thumbnail, a gallery of unverified photos would quietly
          // poison later matching — so an error means "skip", not "accept".
          consecutiveVerifyErrors++;
          hashes.pop();
          continue;
        }
        consecutiveVerifyErrors = 0;
        if (!check.matches) continue;
        if (photos.length < opts.want) photos.push({ imageData: normalized.dataUri, label: candidate.label, text: candidate.text ?? titleFromLabel(candidate.label), verified: true, url: candidate.url, rank });
      }
    };
    await Promise.all(Array.from({ length: REFERENCE_CONCURRENCY }, worker));
  } catch (err) {
    console.error(`[referencePhotos] "${productName}" failed: ${(err as Error).message}`);
  }
  photos.sort((a, b) => a.rank - b.rank);
  console.log(`[referencePhotos] "${productName}": kept ${photos.length}/${opts.want} (checked ${examined}, ${rejectedByIdentity} rejected by identity)`);
  return { photos: photos.map(({ imageData, label, text, verified, url }) => ({ imageData, label, text, verified, url })), examined, rejectedByIdentity };
}
