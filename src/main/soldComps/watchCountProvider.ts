// WatchCountProvider: today's source of sold prices, wrapped behind the provider interface and labelled as THIRD PARTY (it collects eBay's sold pages itself; Clynx is only its customer).
// The actual page fetch is injected, so this file imports nothing heavy and the existing watchcount.ts path is untouched. The wrapper is where "why zero" gets decided (backlog B3): the
// fetcher reports what the page looked like, and a security-check or limit page is "blocked", never a quiet zero.
import type { EbayComp } from "../watchcount.js";
import { DAY_MS, type ProviderResult, type SoldComp, type SoldCompsProvider, type SoldCompsQuery } from "./types.js";

export interface WatchCountFetch {
  comps: EbayComp[];
  /** What the page was: real results, a challenge / limit page, or loaded fine with no sold cards. Unknown when the fetcher cannot tell. */
  pageState?: "results" | "security_check" | "limit" | "empty" | "unknown";
}

const itemNumber = (url: string) => /\/itm\/(\d{6,})/.exec(url)?.[1] ?? null;

export function mapWatchCountComp(c: EbayComp, now: number, retentionDays: number | null): SoldComp {
  const listingId = itemNumber(c.itemUrl);
  return {
    id: listingId ? `watchcount:${listingId}` : `watchcount:${c.title}|${c.priceUsd}`,
    source: "watchcount",
    sourceListingId: listingId,
    title: c.title,
    soldPrice: c.priceUsd,
    currency: "USD",
    soldAt: null, // WatchCount's cards carry no sale date
    condition: c.condition,
    shippingCost: c.shippingUsd,
    quantitySold: null,
    buyingOption: c.listingType,
    gtin: null,
    epid: null,
    categoryId: null,
    imageUrl: c.imageUrl ?? null,
    seller: null,
    fetchedAt: now,
    expiresAt: retentionDays === null ? null : now + retentionDays * DAY_MS,
    raw: c,
  };
}

export class WatchCountProvider implements SoldCompsProvider {
  readonly id = "watchcount" as const;
  readonly label = "WatchCount (third party)";
  readonly thirdParty = true;
  constructor(
    private readonly fetchSold: (query: string) => Promise<WatchCountFetch>,
    private readonly options: { now?: () => number; retentionDays?: number | null } = {}
  ) {}

  async search(query: SoldCompsQuery): Promise<ProviderResult> {
    const now = (this.options.now ?? Date.now)();
    let page: WatchCountFetch;
    try {
      page = await this.fetchSold(query.title);
    } catch (e) {
      return { comps: [], outcome: { kind: "error", detail: `WatchCount could not be read: ${(e as Error).message?.slice(0, 160) ?? "unknown error"}` } };
    }
    if (page.pageState === "security_check") return { comps: [], outcome: { kind: "blocked", detail: "WatchCount showed a security-check page, so no sold prices were read (this says nothing about the market)" } };
    if (page.pageState === "limit") return { comps: [], outcome: { kind: "blocked", detail: "WatchCount showed a limit page, so no sold prices were read (this says nothing about the market)" } };
    if (page.comps.length === 0) {
      if (page.pageState === "empty") return { comps: [], outcome: { kind: "none", detail: "WatchCount loaded and listed no sold items for this search" } };
      return { comps: [], outcome: { kind: "unclear", detail: "WatchCount returned no sold items and the page type is unknown (could be genuinely none, could be a hidden block), so this is not treated as an answer" } };
    }
    const comps = page.comps.map((c) => mapWatchCountComp(c, now, this.options.retentionDays ?? null));
    return { comps: query.limit ? comps.slice(0, query.limit) : comps, outcome: { kind: "ok" } };
  }
}
