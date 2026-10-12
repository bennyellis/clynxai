// Shared fixtures for the engine-level tests: a fake store, a fake network (OpenAI + ntfy), and a ScrapeEngine whose detail
// page loader is replaced, so the real evaluation routes run end to end with no browser.
import type { Page } from "playwright";
import { ScrapeEngine } from "../scrapeEngine.js";
import type { ListingDetail, ListingSummary, LogLine, ScoredListing, Watch } from "../types.js";

// ---------- fake network: OpenAI answers whatever the test says; ntfy pushes are recorded
export const ntfy: Array<{ url: string; title: string; message: string; tags: string; priority: string }> = [];
let aiReply: Record<string, unknown> = {};

function decodeHeader(h: unknown): string {
  const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(h ?? ""));
  return m ? Buffer.from(m[1], "base64").toString("utf8") : String(h ?? "");
}

export function installFetchStub(): void {
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes("openai.com")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiReply) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Only a POST to ntfy is a push; anything else (a photo download) just gets an empty answer.
    if (!String(url).startsWith("https://ntfy.sh")) return new Response(new Uint8Array(0), { status: 404 });
    const h = init?.headers ?? {};
    ntfy.push({ url: String(url), title: decodeHeader(h.Title), message: decodeHeader(h.Message), tags: String(h.Tags ?? ""), priority: String(h.Priority ?? "") });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

/** What every AI call answers (a merged shape that satisfies the scorer, the Watch verifier and the bundle breakdown). */
export function setAiReply(reply: Record<string, unknown>): void {
  aiReply = reply;
}

export function resetNetwork(): void {
  ntfy.length = 0;
  aiReply = { match: true, confidence: "high", reason: "it is the product", isPotentialDeal: false, category: "", estimatedValueRangeUsd: "", conditionImpact: "none", reasoning: "", offTopicSuggestion: null };
}

// ---------- config
export function baseConfig(over: Record<string, unknown> = {}): any {
  return {
    id: "a1",
    label: "Account 1",
    accounts: [],
    browseUrls: [],
    searchItems: [],
    generalDeal: { enabled: false, minConfidence: "medium" },
    customInstructions: "",
    ignoreBlacklist: false,
    maxListingAgeHours: 24,
    dealThresholdPercent: 35,
    ebayNetPercent: 84,
    minProfitMarginPercent: 20,
    maxNegotiationPercent: 15,
    photoAnalysis: { enabled: false },
    sellerRisk: { enabled: false },
    lowAiMode: true,
    ntfy: { server: "https://ntfy.sh", topic: "t" },
    watch: { globallyPaused: false },
    autoResearchListings: false,
    researchCondition: false,
    watchCountEnabled: true,
    watchCountOncePerScan: true,
    locationMode: "country",
    ...over,
  };
}

export function searchItem(item: string, typicalResaleUsd: number, extra: Record<string, unknown> = {}): any {
  return { item, matchKeywords: [item.toLowerCase()], maxPriceUsd: null, minPriceUsd: null, typicalResaleUsd, ...extra };
}

export function makeWatch(over: Partial<Watch> = {}): Watch {
  return {
    id: "w1",
    name: "Xbox watch",
    platform: "facebook",
    enabled: true,
    searchPhrase: "xbox series s",
    matchKeywords: ["xbox series s"],
    terms: [{ phrase: "xbox series s", matchKeywords: ["xbox series s"], linkedProductId: null }],
    checkIntervalMinutes: 10,
    accountIds: [],
    searchLinks: [],
    linkedProductId: null,
    minPriceUsd: null,
    maxPriceUsd: null,
    minProfitUsd: null,
    minDiscountPercent: null,
    maxListingAgeMinutes: null,
    minSellerRatingPercent: null,
    locationMode: "country",
    selectedState: null,
    selectedCityOrZip: null,
    searchRadiusMiles: null,
    resolvedLocationUrl: null,
    ntfyTopic: null,
    matchCount: 0,
    listingsSeenCount: 0,
    createdAt: 1,
    updatedAt: 1,
    lastCheckedAt: null,
    nextCheckAt: null,
    ...over,
  } as Watch;
}

// ---------- fake store: arrays where code expects arrays, null elsewhere; a test overrides what it cares about
export interface FakeStore {
  proxy: any;
  saved: ScoredListing[];
  watchMatches: Array<Record<string, unknown>>;
  notifiedListings: Set<string>;
}

export function makeStore(over: Record<string, (...a: any[]) => unknown> = {}): FakeStore {
  const saved: ScoredListing[] = [];
  const watchMatches: Array<Record<string, unknown>> = [];
  const notifiedListings = new Set<string>();
  const seenMatches = new Set<string>();
  const defaults: Record<string, (...a: any[]) => unknown> = {
    saveScored: (s: ScoredListing) => void saved.push(JSON.parse(JSON.stringify(s))),
    getLastSavedListing: () => ({ id: saved.length ? saved[saved.length - 1].listing.id : "x" }),
    hasSeenCached: () => false,
    listWatches: () => [],
    getDismissedCategories: () => [],
    getFeedbackExamples: () => [],
    listBlacklistedImages: () => [],
    listBlacklistTerms: () => [],
    listProductImages: () => [],
    isBlacklisted: () => null,
    findMatchingProduct: () => null,
    getProductById: () => null,
    getProductSignals: () => null,
    getFacebookPriceStats: () => null,
    getEbayValueForProductName: () => null,
    getEbayValueForTitle: () => null,
    getBrokenVariantValue: () => null,
    recordWatchMatch: (data: Record<string, unknown>) => {
      const key = `${data.watchId}|${data.listingId}`;
      if (seenMatches.has(key)) return null;
      seenMatches.add(key);
      watchMatches.push(data);
      return { id: `m${watchMatches.length}` };
    },
    markNotified: (id: string) => void notifiedListings.add(id),
    isListingNotified: (id: string) => notifiedListings.has(id),
    getGeocode: () => null,
  };
  const table = { ...defaults, ...over };
  const proxy = new Proxy({}, {
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      return table[name] ?? (() => null);
    },
  });
  return { proxy, saved, watchMatches, notifiedListings };
}

// ---------- engine
export class TestEngine extends ScrapeEngine {
  public detailToLoad: ListingDetail | null = null;
  protected override loadListingDetail(_page: Page, _listing: ListingSummary): Promise<ListingDetail> {
    if (!this.detailToLoad) throw new Error("test did not provide a detail");
    return Promise.resolve(this.detailToLoad);
  }
}

export interface EngineHarness {
  engine: TestEngine;
  logs: LogLine[];
  store: FakeStore;
  config: any;
}

export function makeEngine(opts: { store?: FakeStore; config?: any; checkMarket?: (l: any) => Promise<any>; extra?: Record<string, unknown> } = {}): EngineHarness {
  const store = opts.store ?? makeStore();
  const config = opts.config ?? baseConfig();
  const logs: LogLine[] = [];
  const engine = new TestEngine({
    store: store.proxy,
    profileDir: "x",
    getConfig: () => config,
    onLog: (l: LogLine) => void logs.push(l),
    onListing: () => {},
    onNarrate: async () => {},
    onBlacklistUpdated: () => {},
    onBlacklistImagesUpdated: () => {},
    onProductUpdated: () => {},
    onNewProductFound: () => {},
    onStatus: () => {},
    onWatchMatch: () => {},
    checkMarket: opts.checkMarket ?? (async () => null),
    ...(opts.extra ?? {}),
  } as any);
  (engine as any).sleep = async () => {};
  return { engine, logs, store, config };
}

// ---------- listing builders
export function summary(title: string, price: number, id = "l1"): ListingSummary {
  return { id, title, price, url: `https://example.com/${id}`, thumbnailUrl: null, locationText: "Dover, DE" } as ListingSummary;
}

export function detail(title: string, price: number | null, over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    ...summary(title, price ?? 0),
    price,
    description: "Works great.",
    shippingMentioned: false,
    imageUrls: [],
    hasVideo: false,
    hasOfficialShipping: false,
    mentionsEbay: false,
    seller: { joinedFacebookYear: null, rating: null, ratingCount: null, hasProfilePhoto: null, name: null },
    listingAge: "2 hours ago",
    source: "facebook",
    ebayShippingUsd: null,
    ...over,
  } as ListingDetail;
}

export function scoredListing(title: string, price: number, over: Partial<ScoredListing> = {}, listingOver: Partial<ListingDetail> = {}): ScoredListing {
  return {
    listing: detail(title, price, listingOver),
    extraction: { matchedItem: "Xbox Series S", extractedAttributes: "", conditionImpact: "none", confidence: "high", reasoning: "Matches." },
    referencePriceUsd: 300,
    discountPercent: ((300 - price) / 300) * 100,
    isDeal: true,
    dealTier: "search",
    estimatedValueRange: null,
    offTopicSuggestion: null,
    ...over,
  } as ScoredListing;
}

export const FAKE_PAGE = {} as Page;
