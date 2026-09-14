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

import sharp from "sharp";
import { verifyThumbnailCandidate } from "./vision.js";

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

async function searchWeb(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
  const html = await res.text();

  const links: Array<{ url: string; title: string }> = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < maxResults) {
    links.push({ url: decodeDuckDuckGoUrl(m[1]), title: stripHtml(m[2]) });
  }

  const snippets: string[] = [];
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snippetRe.exec(html)) && snippets.length < maxResults) {
    snippets.push(stripHtml(m[1]));
  }

  return links.map((link, i) => ({ title: link.title, url: link.url, snippet: snippets[i] ?? "" }));
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

async function fetchPage(url: string): Promise<FetchedPage> {
  try {
    const res = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) return { text: null, imageUrl: null };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return { text: null, imageUrl: null };
    const html = await res.text();
    return {
      text: stripHtml(extractMainContent(html)).slice(0, MAX_CHARS_PER_PAGE),
      imageUrl: extractOgImage(html),
    };
  } catch {
    return { text: null, imageUrl: null };
  }
}

// Gathers real web content about a product: search result snippets, plus
// the actual visible text of each top result page (falling back to just
// the snippet if a given page can't be fetched — a paywall, a timeout, a
// non-HTML response), plus the first usable product photo found along the
// way (same page fetches, no extra requests). One page fetch failing
// doesn't fail the whole search; only a failure of the search itself
// (network down, DuckDuckGo unreachable) throws, letting the caller fall
// back to training-knowledge-only research instead.
export async function researchProductOnWeb(productName: string, maxResults = DEFAULT_MAX_RESULTS): Promise<WebResearchResult> {
  const query = `${productName} specs variants common problems`;
  const results = await searchWeb(query, maxResults);

  const pages = await Promise.all(
    results.map(async (r) => {
      const page = await fetchPage(r.url);
      const excerpt = page.text && page.text.length > r.snippet.length ? page.text : r.snippet;
      return { title: r.title, url: r.url, excerpt, imageUrl: page.imageUrl };
    })
  );

  return {
    query,
    sources: pages.filter((s) => s.excerpt.trim().length > 0).map(({ title, url, excerpt }) => ({ title, url, excerpt })),
    imageUrl: pages.find((p) => p.imageUrl && !looksLikeLogoAsset(p.imageUrl))?.imageUrl ?? null,
  };
}

// Wikipedia's public REST summary API — tried FIRST because it's a real,
// stable JSON endpoint meant for programmatic use (no bot-detection risk,
// unlike scraping a search engine's result page), and it usually has a
// clean infobox photo for exactly the kind of mainstream consumer product
// this app deals in (game consoles, phones, laptops...). Silently returns
// null for anything obscure enough not to have its own article — that's
// expected, not an error, and the DuckDuckGo-based fallback below picks up
// from there.
async function findImageViaWikipedia(productName: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(productName.trim().replace(/\s+/g, "_"))}`,
      PAGE_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { thumbnail?: { source?: string }; originalimage?: { source?: string } };
    const url = data.thumbnail?.source ?? data.originalimage?.source ?? null;
    return url && !looksLikeLogoAsset(url) ? url : null;
  } catch {
    return null;
  }
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
    if (check.error || check.matches) return dataUri;
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
async function findBrandLogoViaWikidata(brand: string): Promise<string | null> {
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
    const candidateOrder = [...exactMatches, ...hits.filter((hit) => !exactMatches.includes(hit))];

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
  try {
    const res = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
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
