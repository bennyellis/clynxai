// eBay Browse API — a thin, direct REST client, no SDK. Application-level
// OAuth (client credentials grant) only: this app never needs a specific
// eBay user's own login/consent, just public read access to search current
// listings, so there's no per-user auth flow to build at all (unlike
// Facebook, which needs a real per-account browser login). Credentials
// live in .env (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET), same precedent
// OPENAI_API_KEY originally had — see openai.ts.
const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1";
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

export function hasEbayCredentials(): boolean {
  return credentials() !== null;
}

// eBay's own best practice (rate-limits token MINTING far more tightly than
// the actual API calls — ~1000/day — so re-minting per request would burn
// that budget for no reason): cache in memory, keyed on the token's own
// expires_in (~2 hours), with a 60s safety margin so a token doesn't expire
// mid-flight on a call that started just before the boundary.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;
  const creds = credentials();
  if (!creds) throw new Error("eBay scanning needs EBAY_CLIENT_ID/EBAY_CLIENT_SECRET set in .env — see .env.example.");
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
    if (!res.ok) throw new Error(`eBay OAuth token request failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { value: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return cachedToken.value;
  } finally {
    clearTimeout(timeout);
  }
}

async function ebayGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${EBAY_BROWSE_URL}${path}`);
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
    if (!res.ok) throw new Error(`eBay API error ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
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
  buyingOptions: string[];
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
    buyingOptions: Array.isArray(raw.buyingOptions) ? raw.buyingOptions : [],
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
  opts: { minPriceUsd?: number | null; maxPriceUsd?: number | null; limit?: number } = {}
): Promise<EbayRawItem[]> {
  const filters: string[] = ["buyingOptions:{FIXED_PRICE}"];
  if (opts.minPriceUsd != null || opts.maxPriceUsd != null) {
    const min = opts.minPriceUsd != null ? Math.max(0, Math.floor(opts.minPriceUsd)) : "";
    const max = opts.maxPriceUsd != null ? Math.ceil(opts.maxPriceUsd) : "";
    filters.push(`price:[${min}..${max}]`, "priceCurrency:USD");
  }
  const data = await ebayGet<{ itemSummaries?: any[] }>("/item_summary/search", {
    q: query,
    filter: filters.join(","),
    limit: String(Math.min(Math.max(opts.limit ?? 25, 1), 200)),
    fieldgroups: "EXTENDED",
  });
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
