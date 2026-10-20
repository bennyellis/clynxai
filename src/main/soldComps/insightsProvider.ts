// MarketplaceInsightsProvider: eBay's official sold-history API (Buy API family, resource item_sales/search, up to 90 days back). It is LIMITED RELEASE: only an approved partner can call it,
// and only the owner can apply (eBay Partner Network / Buy API application). Until then this provider is OFF and never calls anything.
//
// Built against the documented shape and tested with a fake transport only. NOT VERIFIED (needs the approved account and the API License Agreement): the exact fields returned per sale, this
// API's rate limits, and the rules on storing / caching sold data and for how long. Every field read below is therefore optional, the raw record is kept, and `retentionDays` is a setting.
import { DAY_MS, type ProviderResult, type SoldComp, type SoldCompsProvider, type SoldCompsQuery } from "./types.js";

export interface InsightsResponse {
  status: number;
  body: unknown;
}
/** The one network call, injected: tests pass a fake, the real one (later) adds the OAuth token and the marketplace header. */
export type InsightsTransport = (path: string, params: Record<string, string>) => Promise<InsightsResponse>;

export const INSIGHTS_PATH = "/buy/marketplace_insights/v1_beta/item_sales/search";

interface RawSale {
  itemId?: string;
  title?: string;
  lastSoldPrice?: { value?: string | number; currency?: string };
  lastSoldDate?: string;
  totalSoldQuantity?: number;
  condition?: string;
  buyingOptions?: string[];
  image?: { imageUrl?: string };
  categoryId?: string;
  categories?: Array<{ categoryId?: string }>;
  epid?: string;
  gtin?: string | string[];
  seller?: { username?: string };
  shippingOptions?: Array<{ shippingCost?: { value?: string | number } }>;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export function mapInsightsSale(s: RawSale, now: number, retentionDays: number | null, keepSeller: boolean): SoldComp | null {
  const price = num(s.lastSoldPrice?.value);
  if (!s.title || price === null || price <= 0) return null;
  const soldAt = s.lastSoldDate ? Date.parse(s.lastSoldDate) : NaN;
  const gtin = Array.isArray(s.gtin) ? s.gtin[0] : s.gtin;
  return {
    id: s.itemId ? `marketplace_insights:${s.itemId}` : `marketplace_insights:${s.title}|${price}|${s.lastSoldDate ?? ""}`,
    source: "marketplace_insights",
    sourceListingId: s.itemId ?? null,
    title: s.title,
    soldPrice: price,
    currency: s.lastSoldPrice?.currency ?? "USD",
    soldAt: Number.isFinite(soldAt) ? soldAt : null,
    condition: s.condition ?? null,
    shippingCost: num(s.shippingOptions?.[0]?.shippingCost?.value),
    quantitySold: typeof s.totalSoldQuantity === "number" ? s.totalSoldQuantity : null,
    buyingOption: s.buyingOptions?.[0] ?? null,
    gtin: gtin ? String(gtin).replace(/\D/g, "") || null : null,
    epid: s.epid ?? null,
    categoryId: s.categoryId ?? s.categories?.[0]?.categoryId ?? null,
    imageUrl: s.image?.imageUrl ?? null,
    seller: keepSeller ? (s.seller?.username ?? null) : null,
    fetchedAt: now,
    expiresAt: retentionDays === null ? null : now + retentionDays * DAY_MS,
    raw: s,
  };
}

/** Exact identifiers first (a GTIN or ePID IS the product), else the keyword; a category and aspects only narrow. */
export function buildInsightsParams(q: SoldCompsQuery): Record<string, string> {
  const params: Record<string, string> = { limit: String(Math.min(Math.max(q.limit ?? 50, 1), 200)) };
  if (q.gtin) params.gtin = q.gtin;
  else if (q.epid) params.epid = q.epid;
  else params.q = q.title;
  if (q.categoryId) {
    params.category_ids = q.categoryId;
    const aspects = Object.entries(q.aspects ?? {}).map(([k, v]) => `${k}:{${v}}`);
    if (aspects.length > 0) params.aspect_filter = `categoryId:${q.categoryId},${aspects.join(",")}`;
  }
  return params;
}

export class MarketplaceInsightsProvider implements SoldCompsProvider {
  readonly id = "marketplace_insights" as const;
  readonly label = "eBay Marketplace Insights";
  readonly thirdParty = false;
  constructor(
    private readonly options: { enabled: () => boolean; transport: InsightsTransport; now?: () => number; retentionDays?: number | null; keepSeller?: boolean }
  ) {}

  async search(query: SoldCompsQuery): Promise<ProviderResult> {
    if (!this.options.enabled()) {
      return { comps: [], outcome: { kind: "disabled", detail: "eBay Marketplace Insights is off: it needs eBay's approval (only the account owner can apply)" } };
    }
    let res: InsightsResponse;
    try {
      res = await this.options.transport(INSIGHTS_PATH, buildInsightsParams(query));
    } catch (e) {
      return { comps: [], outcome: { kind: "error", detail: `Marketplace Insights could not be reached: ${(e as Error).message?.slice(0, 160) ?? "unknown error"}` } };
    }
    if (res.status === 401 || res.status === 403) return { comps: [], outcome: { kind: "not_configured", detail: `eBay refused the request (${res.status}): the account is not approved for Marketplace Insights, or the token is wrong` } };
    if (res.status === 429) return { comps: [], outcome: { kind: "blocked", detail: "eBay's rate limit was reached (429), so nothing was read (this says nothing about the market)" } };
    if (res.status >= 500) return { comps: [], outcome: { kind: "error", detail: `eBay had a server problem (${res.status})` } };
    if (res.status !== 200) return { comps: [], outcome: { kind: "error", detail: `Unexpected answer from eBay (${res.status})` } };
    const sales = (res.body as { itemSales?: RawSale[] } | null)?.itemSales;
    if (!Array.isArray(sales)) return { comps: [], outcome: { kind: "error", detail: "eBay answered 200 without an itemSales list (the response shape is not the one this was built for)" } };
    const now = (this.options.now ?? Date.now)();
    const comps = sales.map((s) => mapInsightsSale(s, now, this.options.retentionDays ?? null, this.options.keepSeller === true)).filter((c): c is SoldComp => c !== null);
    if (sales.length === 0) return { comps: [], outcome: { kind: "none", detail: "eBay answered and reports no sales in its window (up to 90 days) for this search" } };
    if (comps.length === 0) return { comps: [], outcome: { kind: "error", detail: `eBay returned ${sales.length} sales but none had a title and a price, so the mapping needs checking` } };
    return { comps, outcome: { kind: "ok", detail: comps.length < sales.length ? `${sales.length - comps.length} sales skipped (no title or price)` : undefined } };
  }
}
