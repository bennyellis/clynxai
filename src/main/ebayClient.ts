import { apiActivity } from "./apiActivity.js";

// eBay Browse API — a thin, direct REST client, no SDK. Application-level
// OAuth (client credentials grant) only: this app never needs a specific
// eBay user's own login/consent, just public read access to search current
// listings, so there's no per-user auth flow to build at all (unlike
// Facebook, which needs a real per-account browser login). Credentials
// live in .env (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET), same precedent
// OPENAI_API_KEY originally had — see openai.ts.
const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1";
// Taxonomy API — used only to ask "which eBay category does this product
// query belong in" (see getEbayCategorySuggestions). Same application token
// and scope as Browse; no extra credentials.
const EBAY_TAXONOMY_URL = "https://api.ebay.com/commerce/taxonomy/v1";
// The plain public-data scope — covers item_summary/search and the Get Item
// call below. Not the wider buy.item.bulk scope, which this app never uses.
const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";
const EBAY_TIMEOUT_MS = 15_000;

function credentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// A signed-in customer using Clynx's shared service reads eBay through Clynx Cloud (which holds the company's eBay credentials); index.ts installs this when that mode is on.
export interface EbayTransport {
  enabled(): boolean;
  get<T>(path: string, params: Record<string, string>, baseUrl: string): Promise<T>;
}
let transport: EbayTransport | null = null;
export function setEbayTransport(t: EbayTransport | null): void {
  transport = t;
}

export function hasEbayCredentials(): boolean {
  return transport?.enabled() === true || credentials() !== null;
}

// eBay's own best practice (rate-limits token MINTING far more tightly than
// the actual API calls — ~1000/day — so re-minting per request would burn
// that budget for no reason): cache in memory, keyed on the token's own
// expires_in (~2 hours), with a 60s safety margin so a token doesn't expire
// mid-flight on a call that started just before the boundary.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    apiActivity.record({ provider: "ebay", kind: "oauth_token", outcome: "cached", route: "ebay_direct" }, { quiet: true });
    return cachedToken.value;
  }
  const creds = credentials();
  if (!creds) {
    apiActivity.record({ provider: "ebay", kind: "oauth_token", outcome: "skipped_disabled", route: "none", error: "no eBay keys (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET) on this computer" });
    throw new Error("eBay scanning needs EBAY_CLIENT_ID/EBAY_CLIENT_SECRET set in .env — see .env.example.");
  }
  const tokenStarted = Date.now();
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EBAY_TIMEOUT_MS);
  try {
    const res = await fetch(EBAY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_SCOPE)}`,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      apiActivity.record({ provider: "ebay", kind: "oauth_token", outcome: "live_failed", route: "ebay_direct", status: res.status, ms: Date.now() - tokenStarted, error: `eBay OAuth token request failed: HTTP ${res.status} ${body}` });
      throw new Error(`eBay OAuth token request failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { value: data.access_token, expiresAt: now + data.expires_in * 1000 };
    apiActivity.record({ provider: "ebay", kind: "oauth_token", outcome: "live_ok", route: "ebay_direct", status: res.status, ms: Date.now() - tokenStarted });
    return cachedToken.value;
  } catch (err) {
    if ((err as Error).name === "AbortError") apiActivity.record({ provider: "ebay", kind: "oauth_token", outcome: "live_failed", route: "ebay_direct", ms: Date.now() - tokenStarted, error: "the eBay token request timed out" });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function ebayKind(path: string, baseUrl: string): string {
  if (baseUrl === EBAY_TAXONOMY_URL) return "taxonomy_category";
  if (path.startsWith("/item_summary/search")) return "browse_search";
  if (path.startsWith("/item/")) return "browse_item";
  return "browse_other";
}

async function ebayGet<T>(path: string, params: Record<string, string>, baseUrl: string = EBAY_BROWSE_URL, count?: (data: T) => number): Promise<T> {
  const kind = ebayKind(path, baseUrl);
  const started = Date.now();
  if (transport?.enabled()) {
    try {
      const data = await transport.get<T>(path, params, baseUrl);
      apiActivity.record({ provider: "ebay", kind, outcome: "live_ok", route: "clynx_cloud", ms: Date.now() - started, results: count ? count(data) : null });
      return data;
    } catch (err) {
      apiActivity.record({ provider: "ebay", kind, outcome: "live_failed", route: "clynx_cloud", ms: Date.now() - started, error: (err as Error).message });
      throw err;
    }
  }
  const token = await getAccessToken();
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EBAY_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        // Fixed to the US marketplace — matches this app's existing
        // US-only assumption everywhere else (Facebook state list, ntfy
        // formatting, USD pricing throughout).
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      // 401 / 403: a token eBay no longer accepts is dropped so the next call mints a new one; 429 is eBay's rate limit (surfaced, never hidden).
      if (res.status === 401) cachedToken = null;
      apiActivity.record({ provider: "ebay", kind, outcome: "live_failed", route: "ebay_direct", status: res.status, ms: Date.now() - started, error: `eBay API error ${res.status}: ${body}` });
      throw new Error(`eBay API error ${res.status}: ${body}`);
    }
    const data = (await res.json()) as T;
    apiActivity.record({ provider: "ebay", kind, outcome: "live_ok", route: "ebay_direct", status: res.status, ms: Date.now() - started, results: count ? count(data) : null });
    return data;
  } catch (err) {
    if ((err as Error).name === "AbortError") apiActivity.record({ provider: "ebay", kind, outcome: "live_failed", route: "ebay_direct", ms: Date.now() - started, error: "the eBay request timed out" });
    else if (!/^eBay API error/.test((err as Error).message)) apiActivity.record({ provider: "ebay", kind, outcome: "live_failed", route: "ebay_direct", ms: Date.now() - started, error: (err as Error).message });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Raw, minimally-typed shape shared by both a search result item and a Get
// Item response (a superset) — deliberately not "normalized" here (no
// ebay- id prefix, no whole-dollar rounding, no ListingDetail shape); that
// conversion is ebayNormalize.ts's job, kept separate so this file stays a
// plain, honest wrapper around what eBay's API actually returns.
export interface EbayRawItem {
  itemId: string;
  title: string;
  priceValue: string | null;
  priceCurrency: string | null;
  itemWebUrl: string;
  imageUrl: string | null;
  condition: string | null;
  itemCreationDate: string | null;
  itemLocationCity: string | null;
  sellerUsername: string | null;
  sellerFeedbackScore: number | null;
  sellerFeedbackPercentage: number | null;
  // The seller's own shipping charge for the cheapest option, in USD (0 = free shipping). null when eBay doesn't say
  // (local pickup only, or calculated shipping that depends on the buyer's address).
  shippingCostUsd: number | null;
  buyingOptions: string[];
  // The eBay categories this listing is filed under, leaf first then its
  // parents (e.g. Video Game Consoles > Video Games & Consoles). Present on
  // search results; empty on a Get Item response.
  categories: EbayCategory[];
}

export interface EbayCategory {
  id: string;
  name: string;
}

function cheapestShippingUsd(options: unknown): number | null {
  if (!Array.isArray(options)) return null;
  const costs = options
    .filter((o: any) => o?.shippingCost?.currency === "USD" && o.shippingCost.value != null)
    .map((o: any) => Number(o.shippingCost.value))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return costs.length ? Math.min(...costs) : null;
}

function mapRawItem(raw: any): EbayRawItem {
  return {
    itemId: raw.itemId,
    title: raw.title,
    priceValue: raw.price?.value ?? null,
    priceCurrency: raw.price?.currency ?? null,
    itemWebUrl: raw.itemWebUrl,
    imageUrl: raw.image?.imageUrl ?? null,
    condition: raw.condition ?? null,
    itemCreationDate: raw.itemCreationDate ?? null,
    itemLocationCity: raw.itemLocation?.city ?? null,
    sellerUsername: raw.seller?.username ?? null,
    sellerFeedbackScore: typeof raw.seller?.feedbackScore === "number" ? raw.seller.feedbackScore : null,
    // eBay returns this as a numeric-looking string ("99.2"), not a number.
    sellerFeedbackPercentage: raw.seller?.feedbackPercentage != null ? Number(raw.seller.feedbackPercentage) : null,
    shippingCostUsd: cheapestShippingUsd(raw.shippingOptions),
    buyingOptions: Array.isArray(raw.buyingOptions) ? raw.buyingOptions : [],
    categories: Array.isArray(raw.categories)
      ? raw.categories
          .filter((c: any) => c && c.categoryId != null)
          .map((c: any) => ({ id: String(c.categoryId), name: String(c.categoryName ?? "") }))
      : [],
  };
}

// Mirrors the summary half of scraper.ts's searchMarketplace/
// fetchListingDetail two-stage split, just an HTTP GET instead of a
// Playwright page. buyingOptions:{FIXED_PRICE} excludes auctions — an
// auction's current bid isn't a price you can act on the way a Buy It Now
// price is, and this app's whole deal-scoring model assumes one real,
// current asking price per listing.
export async function searchEbayItems(
  query: string,
  opts: { minPriceUsd?: number | null; maxPriceUsd?: number | null; limit?: number; conditionIds?: string[] } = {}
): Promise<EbayRawItem[]> {
  const filters: string[] = ["buyingOptions:{FIXED_PRICE}"];
  // eBay's own condition ids (7000 = "For parts or not working").
  if (opts.conditionIds?.length) filters.push(`conditionIds:{${opts.conditionIds.join("|")}}`);
  if (opts.minPriceUsd != null || opts.maxPriceUsd != null) {
    const min = opts.minPriceUsd != null ? Math.max(0, Math.floor(opts.minPriceUsd)) : "";
    const max = opts.maxPriceUsd != null ? Math.ceil(opts.maxPriceUsd) : "";
    filters.push(`price:[${min}..${max}]`, "priceCurrency:USD");
  }
  const data = await ebayGet<{ itemSummaries?: any[] }>(
    "/item_summary/search",
    {
      q: query,
      filter: filters.join(","),
      limit: String(Math.min(Math.max(opts.limit ?? 25, 1), 200)),
      fieldgroups: "EXTENDED",
    },
    EBAY_BROWSE_URL,
    (d) => d.itemSummaries?.length ?? 0
  );
  return (data.itemSummaries ?? []).map(mapRawItem);
}

// One seller's own active Buy-It-Now listings that match a keyword search. eBay silently ignores the seller filter when the
// username doesn't exist (and returns everyone's listings), so callers must check each item's sellerUsername.
export async function searchEbaySellerItems(seller: string, query: string, limit = 50): Promise<EbayRawItem[]> {
  const data = await ebayGet<{ itemSummaries?: any[] }>(
    "/item_summary/search",
    {
      q: query,
      filter: `sellers:{${seller}},buyingOptions:{FIXED_PRICE}`,
      limit: String(Math.min(Math.max(limit, 1), 200)),
    },
    EBAY_BROWSE_URL,
    (d) => d.itemSummaries?.length ?? 0
  );
  return (data.itemSummaries ?? []).map(mapRawItem);
}

export interface EbayItemDetailRaw extends EbayRawItem {
  description: string | null;
  imageUrls: string[];
}

// Mirrors the detail half of the same split — a second call, same as
// Facebook's own detail-page visit, just an HTTP GET to /item/{item_id}
// instead of a page navigation. itemId here is the SAME compound RESTful
// id item_summary/search already returns (e.g. "v1|110587697403|0"), used
// as-is — no separate id-lookup/conversion step needed. Returns null on
// any failure (deleted/ended listing between search and detail fetch,
// transient error) rather than throwing, since the caller already has a
// perfectly usable summary to fall back to skipping this one candidate.
export async function getEbayItemDetail(itemId: string): Promise<EbayItemDetailRaw | null> {
  try {
    const raw = await ebayGet<any>(`/item/${encodeURIComponent(itemId)}`, {});
    const additionalImages: string[] = Array.isArray(raw.additionalImages)
      ? raw.additionalImages.map((img: any) => img?.imageUrl).filter((u: unknown): u is string => typeof u === "string")
      : [];
    const primaryImage = raw.image?.imageUrl;
    return {
      ...mapRawItem(raw),
      description: raw.description ?? raw.shortDescription ?? null,
      imageUrls: primaryImage ? [primaryImage, ...additionalImages] : additionalImages,
    };
  } catch {
    return null;
  }
}

// Which category would eBay itself file this product query under? Best match
// first (e.g. "xbox series x" -> Video Game Consoles, then Video Games,
// Controllers & Attachments...). The product-only filter (ebayProductFilter.ts)
// uses the top suggestion as "where the real product lives" so games, parts and
// accessories that merely mention the product can be told apart from it. Returns
// [] on any failure — callers treat that as "category unknown".
export async function getEbayCategorySuggestions(query: string): Promise<EbayCategory[]> {
  try {
    const data = await ebayGet<{ categorySuggestions?: any[] }>(
      "/category_tree/0/get_category_suggestions",
      { q: query },
      EBAY_TAXONOMY_URL
    );
    return (data.categorySuggestions ?? [])
      .map((s) => ({ id: String(s?.category?.categoryId ?? ""), name: String(s?.category?.categoryName ?? "") }))
      .filter((c) => c.id);
  } catch {
    return [];
  }
}

// The item specifics real eBay listings use for a product (storage capacity, colour, edition / model, bundle), with how many listings use each value: the FIRST source of a product's
// versions (variantDiscovery.ts). One search with fieldgroups=ASPECT_REFINEMENTS inside the product's own eBay category (a refinement needs a category). Returns null on any failure
// (no category, eBay refused, the response had no refinements): the caller treats that as "this source said nothing", never as "the product has no versions".
export async function searchEbayAspects(query: string): Promise<{ aspects: import("./variantDiscovery.js").AspectDistribution[]; total: number } | null> {
  try {
    const categories = await getEbayCategorySuggestions(query);
    const category = categories[0];
    if (!category) return null;
    const data = await ebayGet<{ total?: number; refinement?: unknown }>(
      "/item_summary/search",
      { q: query, category_ids: category.id, filter: "buyingOptions:{FIXED_PRICE}", limit: "1", fieldgroups: "ASPECT_REFINEMENTS" },
      EBAY_BROWSE_URL
    );
    const { parseAspectRefinements } = await import("./variantDiscovery.js");
    const aspects = parseAspectRefinements(data);
    return aspects.length > 0 ? { aspects, total: typeof data.total === "number" ? data.total : 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Titles of the listings eBay's Browse "search by image" returns for a photo (base64, no data-URI prefix). Used as one vote among several by the identity ladder. Direct eBay keys only (Clynx Cloud's
 * transport carries GET requests only), and the endpoint's availability on a given eBay account was NOT verified: any failure returns null, which the ladder reads as "this source said nothing".
 */
export async function searchEbayByImage(imageBase64: string, limit = 10): Promise<string[] | null> {
  if (transport?.enabled() || !credentials()) return null;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EBAY_TIMEOUT_MS);
  try {
    const token = await getAccessToken();
    const res = await fetch(`${EBAY_BROWSE_URL}/item_summary/search_by_image?limit=${limit}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
      body: JSON.stringify({ image: imageBase64 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      apiActivity.record({ provider: "ebay", kind: "browse_other", outcome: "live_failed", route: "ebay_direct", status: res.status, ms: Date.now() - started, error: `eBay image search answered ${res.status}` });
      return null;
    }
    const data = (await res.json()) as { itemSummaries?: Array<{ title?: string }> };
    const titles = (data.itemSummaries ?? []).map((i) => String(i.title ?? "")).filter(Boolean);
    apiActivity.record({ provider: "ebay", kind: "browse_other", outcome: "live_ok", route: "ebay_direct", ms: Date.now() - started, results: titles.length });
    return titles.length > 0 ? titles : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
