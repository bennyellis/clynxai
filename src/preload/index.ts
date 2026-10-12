import { contextBridge, ipcRenderer } from "electron";
import type { DiscoveryEntry } from "../main/discovery.js";
import type { OnboardingState } from "../main/types.js";
import type { Account, ActiveProductResearch, BlacklistedImage, BlacklistTerm, CloudStatus, Config, FeedbackVerdict, ListingRecord, LogLine, ProductImage, ProductProfile, ScrapeStatus, Watch, WatchMatch, WatchPlatform } from "../main/types.js";
import type { ChatMessage, ChatContext, ChatAttachment } from "../main/chat.js";
import type { MetricsSnapshot } from "../main/metrics.js";
import type { AppNotice } from "../main/appNotices.js";
import type { StartupProblem } from "../main/startupErrors.js";

const api = {
  getConfig: (): Promise<Config> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: Config): Promise<void> => ipcRenderer.invoke("config:save", config),
  resetConfig: (): Promise<Config> => ipcRenderer.invoke("config:reset"),
  // Per explicit instruction — closing the app with unsaved Config changes
  // needs a real chance to save first (see index.ts's "close" listener).
  onCloseRequested: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("app:closeRequested", listener);
    return () => ipcRenderer.removeListener("app:closeRequested", listener);
  },
  confirmClose: (): void => ipcRenderer.send("app:confirmClose"),
  // Per explicit instruction — a chat-driven config change (theme, most
  // visibly) needs to actually show up live, not just save to disk while
  // the running app looks untouched (see index.ts's update_config handler).
  onConfigUpdated: (cb: (config: Config) => void) => {
    const listener = (_e: unknown, next: Config) => cb(next);
    ipcRenderer.on("config:updated", listener);
    return () => ipcRenderer.removeListener("config:updated", listener);
  },
  // The Dashboard's own Filters box — a quicker, more visible home for the
  // things a user adjusts often than the full Config screen. A single
  // patch-shaped call so more filter fields can be added later without new
  // plumbing each time.
  updateFilters: (
    patch: Partial<Pick<Config, "maxListingAgeHours" | "rotateSearchItems" | "rotateSearchItemsCount">>
  ): Promise<void> => ipcRenderer.invoke("filters:update", patch),
  removeSearchItem: (item: string): Promise<void> => ipcRenderer.invoke("filters:removeSearchItem", { item }),
  removeRecentSearch: (search: { item: string; minPriceUsd: number | null; maxPriceUsd: number | null; includeBroken?: boolean }): Promise<void> => ipcRenderer.invoke("searches:removeRecent", search),

  hasOpenAIKey: (): Promise<boolean> => ipcRenderer.invoke("env:hasOpenAIKey"),
  saveOpenAIKey: (key: string): Promise<void> => ipcRenderer.invoke("env:saveOpenAIKey", key),
  hasEbayCredentials: (): Promise<boolean> => ipcRenderer.invoke("env:hasEbayCredentials"),

  // Per explicit instruction — multiple Facebook accounts, each its own
  // ScrapeEngine (see index.ts) — every engine control now takes which
  // account it applies to.
  getEngineStatusMap: (): Promise<Record<string, ScrapeStatus>> => ipcRenderer.invoke("engine:statusMap"),
  onStatusMap: (cb: (statusMap: Record<string, ScrapeStatus>) => void) => {
    const listener = (_e: unknown, statusMap: Record<string, ScrapeStatus>) => cb(statusMap);
    ipcRenderer.on("engine:statusMap", listener);
    return () => ipcRenderer.removeListener("engine:statusMap", listener);
  },
  // Problems that need the user's attention (damaged files, Facebook logged out, a scan that keeps failing); see appNotices.ts.
  listNotices: (): Promise<AppNotice[]> => ipcRenderer.invoke("notices:list"),
  // First-run checklist state.
  updateOnboarding: (patch: Partial<OnboardingState>): Promise<void> => ipcRenderer.invoke("onboarding:update", patch),
  // Phone alerts (ntfy) setup.
  generateNtfyTopic: (): Promise<string> => ipcRenderer.invoke("ntfy:generateTopic"),
  sendTestNotification: (server: string, topic: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("ntfy:sendTest", { server, topic }),
  saveNtfySettings: (server: string, topic: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke("ntfy:save", { server, topic }),
  // Opens the folder holding the user's database and settings in Explorer (the startup-problem screen's "Show data folder").
  showDataFolder: (): Promise<void> => ipcRenderer.invoke("app:showDataFolder"),
  dismissNotice: (id: string): Promise<void> => ipcRenderer.invoke("notices:dismiss", { id }),
  onNotices: (cb: (notices: AppNotice[]) => void) => {
    const listener = (_e: unknown, notices: AppNotice[]) => cb(notices);
    ipcRenderer.on("notices:updated", listener);
    return () => ipcRenderer.removeListener("notices:updated", listener);
  },
  // Moves a damaged database aside and restarts Clynx with a fresh one (the damaged file is kept).
  recoverDatabase: (): Promise<void> => ipcRenderer.invoke("db:recover"),
  startEngine: (accountId: string): Promise<void> => ipcRenderer.invoke("engine:start", { accountId }),
  stopEngine: (accountId: string): Promise<void> => ipcRenderer.invoke("engine:stop", { accountId }),
  skipEngineWait: (accountId: string): Promise<void> => ipcRenderer.invoke("engine:skipWait", { accountId }),
  runEngineOnce: (accountId: string): Promise<void> => ipcRenderer.invoke("engine:runOnce", { accountId }),
  login: (accountId: string): Promise<boolean> => ipcRenderer.invoke("engine:login", { accountId }),
  checkLogin: (accountId: string): Promise<boolean> => ipcRenderer.invoke("engine:checkLogin", { accountId }),
  // Not per-account — see index.ts's getPrimaryEngine.
  openWatchCountLogin: (): Promise<void> => ipcRenderer.invoke("engine:openWatchCountLogin"),
  setLocationMode: (
    args: { accountId: string; mode: "country" } | { accountId: string; mode: "state"; state: string } | { accountId: string; mode: "city"; cityOrZip: string }
  ): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("location:setMode", args),

  // Per explicit instruction — Config's account roster (add/remove/rename).
  listAccounts: (): Promise<Account[]> => ipcRenderer.invoke("accounts:list"),
  addAccount: (label: string): Promise<Account> => ipcRenderer.invoke("accounts:add", { label }),
  updateAccount: (id: string, patch: Partial<Pick<Account, "label" | "enabled">>): Promise<Account[]> =>
    ipcRenderer.invoke("accounts:update", { id, patch }),
  removeAccount: (id: string): Promise<Account[]> => ipcRenderer.invoke("accounts:remove", { id }),

  listListings: (limit?: number, offset?: number): Promise<ListingRecord[]> =>
    ipcRenderer.invoke("listings:list", { limit, offset }),
  // Per explicit instruction — Dashboard's "Listings evaluated" stat wants
  // the true all-time count, not listings.length off the capped page above.
  countListings: (): Promise<number> => ipcRenderer.invoke("listings:count"),
  setFeedback: (id: string, verdict: FeedbackVerdict, note: string | null): Promise<void> =>
    ipcRenderer.invoke("listings:feedback", { id, verdict, note }),
  clearFeedback: (id: string): Promise<void> => ipcRenderer.invoke("listings:clearFeedback", { id }),
  notInterested: (category: string): Promise<void> => ipcRenderer.invoke("listings:notInterested", { category }),
  deleteListing: (id: string): Promise<void> => ipcRenderer.invoke("listings:delete", { id }),
  clearAllListings: (): Promise<void> => ipcRenderer.invoke("listings:clearAll"),
  researchListing: (id: string, reason?: string): Promise<{ ok: boolean; message: string; productId: string | null }> =>
    ipcRenderer.invoke("listings:research", { id, reason }),

  onLog: (cb: (line: LogLine) => void) => {
    const listener = (_e: unknown, line: LogLine) => cb(line);
    ipcRenderer.on("engine:log", listener);
    return () => ipcRenderer.removeListener("engine:log", listener);
  },
  onListing: (cb: (record: ListingRecord) => void) => {
    const listener = (_e: unknown, record: ListingRecord) => cb(record);
    ipcRenderer.on("engine:listing", listener);
    return () => ipcRenderer.removeListener("engine:listing", listener);
  },
  // Fired when the main process changes the listings out from under the
  // renderer without going through the usual per-listing engine:listing
  // push (e.g. the chat assistant's clear_feed tool) — tells App.tsx to
  // just refetch the whole list rather than trying to patch it in place.
  onListingsRefresh: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("listings:refresh", listener);
    return () => ipcRenderer.removeListener("listings:refresh", listener);
  },
  onStatus: (cb: (status: ScrapeStatus) => void) => {
    const listener = (_e: unknown, status: ScrapeStatus) => cb(status);
    ipcRenderer.on("engine:status", listener);
    return () => ipcRenderer.removeListener("engine:status", listener);
  },

  startChat: (
    requestId: string,
    message: string,
    history: ChatMessage[],
    context: ChatContext,
    productId?: string,
    attachments?: ChatAttachment[]
  ) => ipcRenderer.send("ai:chatStart", { requestId, message, history, context, productId, attachments }),
  onChatChunk: (cb: (requestId: string, delta: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string; delta: string }) => cb(args.requestId, args.delta);
    ipcRenderer.on("ai:chatChunk", listener);
    return () => ipcRenderer.removeListener("ai:chatChunk", listener);
  },
  onChatDone: (cb: (requestId: string, full: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string; full: string }) => cb(args.requestId, args.full);
    ipcRenderer.on("ai:chatDone", listener);
    return () => ipcRenderer.removeListener("ai:chatDone", listener);
  },
  onChatError: (cb: (requestId: string, message: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string; message: string }) => cb(args.requestId, args.message);
    ipcRenderer.on("ai:chatError", listener);
    return () => ipcRenderer.removeListener("ai:chatError", listener);
  },
  // Fired once a chat-triggered add_search_item search actually finishes —
  // separate from ai:chatDone, which already fired with "Searching..." well
  // before the real Facebook Marketplace search had a result to report.
  onSearchUpdate: (cb: (requestId: string, message: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string; message: string }) => cb(args.requestId, args.message);
    ipcRenderer.on("ai:searchUpdate", listener);
    return () => ipcRenderer.removeListener("ai:searchUpdate", listener);
  },

  onNarrationStart: (cb: (requestId: string, kind: "deal" | "batch") => void) => {
    const listener = (_e: unknown, args: { requestId: string; kind: "deal" | "batch" }) => cb(args.requestId, args.kind);
    ipcRenderer.on("ai:narrationStart", listener);
    return () => ipcRenderer.removeListener("ai:narrationStart", listener);
  },
  onNarrationChunk: (cb: (requestId: string, delta: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string; delta: string }) => cb(args.requestId, args.delta);
    ipcRenderer.on("ai:narrationChunk", listener);
    return () => ipcRenderer.removeListener("ai:narrationChunk", listener);
  },
  onNarrationDone: (cb: (requestId: string, full: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string; full: string }) => cb(args.requestId, args.full);
    ipcRenderer.on("ai:narrationDone", listener);
    return () => ipcRenderer.removeListener("ai:narrationDone", listener);
  },
  onNarrationError: (cb: (requestId: string) => void) => {
    const listener = (_e: unknown, args: { requestId: string }) => cb(args.requestId);
    ipcRenderer.on("ai:narrationError", listener);
    return () => ipcRenderer.removeListener("ai:narrationError", listener);
  },

  listProducts: (): Promise<ProductProfile[]> => ipcRenderer.invoke("products:list"),
  // Per explicit instruction — Dashboard's "is this what you're searching
  // for?" popup: looks up an existing Database entry by name using the
  // SAME fuzzy-match logic the scanner itself relies on, before actually
  // adding a new Search For item.
  findMatchingProduct: (name: string): Promise<ProductProfile | null> => ipcRenderer.invoke("products:findMatch", { name }),
  listGroupThumbnails: (): Promise<Record<string, string>> => ipcRenderer.invoke("products:listGroupThumbnails"),
  onGroupThumbnailUpdated: (cb: (path: string, imageData: string) => void) => {
    const listener = (_e: unknown, args: { path: string; imageData: string }) => cb(args.path, args.imageData);
    ipcRenderer.on("groupThumbnails:updated", listener);
    return () => ipcRenderer.removeListener("groupThumbnails:updated", listener);
  },
  refreshProduct: (id: string): Promise<ProductProfile | null> => ipcRenderer.invoke("products:refresh", { id }),
  deleteProduct: (id: string): Promise<void> => ipcRenderer.invoke("products:delete", { id }),
  clearAllProducts: (): Promise<void> => ipcRenderer.invoke("products:clearAll"),
  countProductsMissingPhotos: (): Promise<number> => ipcRenderer.invoke("products:countMissingPhotos"),
  backfillProductPhotos: (): Promise<number> => ipcRenderer.invoke("products:backfillPhotos"),
  getPhotoBackfillStatus: (): Promise<{ running: boolean; done: number; total: number }> => ipcRenderer.invoke("products:photoBackfillStatus"),
  onPhotoBackfillProgress: (cb: (p: { running: boolean; done: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { running: boolean; done: number; total: number }) => cb(p);
    ipcRenderer.on("products:photoBackfillProgress", listener);
    return () => ipcRenderer.removeListener("products:photoBackfillProgress", listener);
  },
  createManualProduct: (name: string, category: string): Promise<ProductProfile | null> =>
    ipcRenderer.invoke("products:createManual", { name, category }),
  editProduct: (
    id: string,
    patch: Partial<{
      name: string;
      aiSummary: string;
      resalePriceUsd: number | null;
      resaleTimeToSell: string | null;
      keepThumbnail: boolean;
      desiredPriceUsd: number | null;
      hardCapAtDesiredPrice: boolean;
      prioritized: boolean;
    }>
  ): Promise<ProductProfile | null> => ipcRenderer.invoke("products:edit", { id, patch }),
  pickProductThumbnail: (id: string): Promise<ProductProfile | null> => ipcRenderer.invoke("products:pickThumbnail", { id }),
  setThumbnailFromImage: (id: string, imageDataUri: string): Promise<ProductProfile | null> =>
    ipcRenderer.invoke("products:setThumbnailFromImage", { id, imageDataUri }),
  listProductImages: (productId: string): Promise<ProductImage[]> => ipcRenderer.invoke("products:listImages", { productId }),
  addProductImage: (productId: string): Promise<ProductImage | null> => ipcRenderer.invoke("products:addImage", { productId }),
  deleteProductImage: (imageId: string): Promise<void> => ipcRenderer.invoke("products:deleteImage", { imageId }),
  searchProductNow: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("products:searchNow", { id }),
  // Entries on screen with a blank box get a thumbnail researched right away (see index.ts's ensureThumbnailsFor).
  ensureThumbnails: (ids: string[]): Promise<number> => ipcRenderer.invoke("products:ensureThumbnails", { ids }),
  // A folder tile on screen with nothing to show gets its brand logo / group picture found (no AI needed).
  // A Watch's own ntfy topic (blank goes back to the Config topic); null if the name isn't a valid topic.
  setWatchNtfyTopic: (id: string, topic: string | null): Promise<Watch | null> => ipcRenderer.invoke("watch:setNtfyTopic", { id, topic }),
  linkEbayStore: (username: string): Promise<{ ok: boolean; username: string; error?: string }> => ipcRenderer.invoke("ebayStore:link", username),
  ensureFolderImage: (segments: string[]): Promise<boolean> => ipcRenderer.invoke("products:ensureFolderImage", { segments }),
  refreshEbayComps: (id: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("products:refreshEbayComps", { id }),
  // Per explicit instruction — "avg. Facebook Marketplace price... place
  // this right above eBay sold comps." Null until at least a few (see
  // store.ts's getFacebookPriceStats) real listings have been recognized
  // as this exact product.
  getFacebookPriceStats: (id: string): Promise<{ avgPriceUsd: number; sampleSize: number } | null> =>
    ipcRenderer.invoke("products:getFacebookPriceStats", { id }),
  // The Dashboard "Search for Products" box — a batch of product names
  // composed there, added to the Search For list (Start Scanning is what
  // actually searches for them — see search:addProducts's own doc
  // comment). linkedProductId, when given, comes from the "is this what
  // you're searching for?" popup confirmation. minPriceUsd/maxPriceUsd,
  // when given, come from the follow-up "Set a price range for ___?"
  // prompt — per explicit instruction, price range is per-product now, not
  // a global Dashboard filter.
  searchForProducts: (
    items: string[],
    linkedProductId?: string | null,
    minPriceUsd?: number | null,
    maxPriceUsd?: number | null,
    includeBroken?: boolean
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("search:addProducts", {
      items,
      linkedProductId: linkedProductId ?? null,
      minPriceUsd: minPriceUsd ?? null,
      maxPriceUsd: maxPriceUsd ?? null,
      includeBroken: includeBroken === true,
    }),
  // Per explicit instruction — "Watch: keep an eye out for this over time
  // and alert me when it appears," persistent across restarts (unlike
  // searchForProducts above) — see store.ts's Watch CRUD and types.ts's
  // Watch/WatchMatch for the full shape.
  createWatch: (args: {
    name: string;
    platform: WatchPlatform;
    searchPhrase: string;
    linkedProductId: string | null;
    // Facebook Watches: everything to look out for, how often (minutes), which accounts (empty = any).
    terms?: Array<{ phrase: string; linkedProductId?: string | null }>;
    checkIntervalMinutes?: number;
    accountIds?: string[];
    minPriceUsd: number | null;
    maxPriceUsd: number | null;
    minProfitUsd: number | null;
    minDiscountPercent: number | null;
    maxListingAgeMinutes: number | null;
    minSellerRatingPercent: number | null;
    locationMode: "country" | "state" | "city";
    selectedState: string | null;
    selectedCityOrZip: string | null;
    searchRadiusMiles: number | null;
  }): Promise<Watch> => ipcRenderer.invoke("watch:create", args),
  updateWatch: (
    id: string,
    patch: Partial<{
      name: string;
      searchPhrase: string;
      linkedProductId: string | null;
      minPriceUsd: number | null;
      maxPriceUsd: number | null;
      minProfitUsd: number | null;
      minDiscountPercent: number | null;
      maxListingAgeMinutes: number | null;
      minSellerRatingPercent: number | null;
      locationMode: "country" | "state" | "city";
      selectedState: string | null;
      selectedCityOrZip: string | null;
      searchRadiusMiles: number | null;
      terms: Array<{ phrase: string; linkedProductId?: string | null }>;
      checkIntervalMinutes: number;
      accountIds: string[];
    }>
  ): Promise<Watch | null> => ipcRenderer.invoke("watch:update", { id, patch }),
  setWatchEnabled: (id: string, enabled: boolean): Promise<Watch | null> => ipcRenderer.invoke("watch:setEnabled", { id, enabled }),
  deleteWatch: (id: string): Promise<void> => ipcRenderer.invoke("watch:delete", { id }),
  listWatches: (): Promise<Watch[]> => ipcRenderer.invoke("watch:list"),
  getWatchById: (id: string): Promise<Watch | null> => ipcRenderer.invoke("watch:getById", { id }),
  listWatchMatches: (watchId: string): Promise<Array<{ match: WatchMatch; listing: ListingRecord }>> =>
    ipcRenderer.invoke("watch:listMatches", { watchId }),
  pauseAllWatches: (): Promise<void> => ipcRenderer.invoke("watch:pauseAll"),
  resumeAllWatches: (): Promise<void> => ipcRenderer.invoke("watch:resumeAll"),
  markWatchMatchesViewed: (): Promise<void> => ipcRenderer.invoke("watch:markMatchesViewed"),
  hasUnseenWatchMatches: (): Promise<boolean> => ipcRenderer.invoke("watch:hasUnseenMatches"),
  // Per explicit instruction — every Watch mutation broadcasts the full
  // current list (see index.ts's broadcastWatches) rather than one event
  // per field, same posture as onBlacklistUpdated below.
  onWatchesUpdated: (cb: (watches: Watch[]) => void) => {
    const listener = (_e: unknown, watches: Watch[]) => cb(watches);
    ipcRenderer.on("watches:updated", listener);
    return () => ipcRenderer.removeListener("watches:updated", listener);
  },
  // Whether a Watch is searching right now (true while its check runs, false while it waits for its next interval).
  isWatchSearching: (): Promise<boolean> => ipcRenderer.invoke("watch:isSearching"),
  onWatchSearching: (cb: (searching: boolean) => void) => {
    const listener = (_e: unknown, searching: boolean) => cb(searching);
    ipcRenderer.on("watch:searching", listener);
    return () => ipcRenderer.removeListener("watch:searching", listener);
  },
  // The main process asking the window to show a screen (a clicked desktop notification).
  onNavigate: (cb: (screen: string) => void) => {
    const listener = (_e: unknown, screen: string) => cb(screen);
    ipcRenderer.on("app:navigate", listener);
    return () => ipcRenderer.removeListener("app:navigate", listener);
  },
  askAboutImage: (imageDataUri: string, question: string, subjectName: string): Promise<{ answer: string | null; error: string | null }> =>
    ipcRenderer.invoke("images:ask", { imageDataUri, question, subjectName }),
  submitImageFeedback: (args: {
    imageDataUri: string;
    currentLabel: string;
    feedback: string;
    kind: "reference" | "thumbnail" | "blacklisted";
    imageId?: string;
    productId?: string;
    sourceTitle?: string | null;
  }): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("images:feedback", args),
  submitFlawFeedback: (args: {
    listingId: string;
    photoNumber: number;
    description: string;
    confidence: string;
    confirmed: boolean;
    listingTitle: string;
  }): Promise<{ ok: boolean }> => ipcRenderer.invoke("listings:flawFeedback", args),
  onProductUpdated: (cb: (product: ProductProfile) => void) => {
    const listener = (_e: unknown, product: ProductProfile) => cb(product);
    ipcRenderer.on("products:updated", listener);
    return () => ipcRenderer.removeListener("products:updated", listener);
  },
  // Per explicit instruction — the Database Research tab's live "what's
  // being researched right now" status (see index.ts's activeResearch).
  getResearchStatus: (): Promise<ActiveProductResearch[]> => ipcRenderer.invoke("research:status"),
  onResearchStatus: (cb: (active: ActiveProductResearch[]) => void) => {
    const listener = (_e: unknown, active: ActiveProductResearch[]) => cb(active);
    ipcRenderer.on("research:status", listener);
    return () => ipcRenderer.removeListener("research:status", listener);
  },
  // The Database's Discovery tab: the live feed of products Clynx is looking into, with its thoughts on each.
  getDiscoveryFeed: (): Promise<DiscoveryEntry[]> => ipcRenderer.invoke("discovery:list"),
  onDiscoveryEntry: (cb: (entry: DiscoveryEntry) => void) => {
    const listener = (_e: unknown, entry: DiscoveryEntry) => cb(entry);
    ipcRenderer.on("discovery:entry", listener);
    return () => ipcRenderer.removeListener("discovery:entry", listener);
  },

  // Per explicit instruction — pipeline instrumentation for Activity's
  // metrics panel. Pull-based (see index.ts's own doc comment on the
  // handlers) — the renderer polls getMetricsSnapshot on an interval rather
  // than this pushing updates.
  getMetricsSnapshot: (): Promise<MetricsSnapshot> => ipcRenderer.invoke("metrics:snapshot"),
  resetMetrics: (): Promise<MetricsSnapshot> => ipcRenderer.invoke("metrics:reset"),
  listBlacklistTerms: (): Promise<BlacklistTerm[]> => ipcRenderer.invoke("blacklist:list"),
  addBlacklistTerm: (term: string, imageDataUri?: string | null, sourceTitle?: string | null): Promise<BlacklistTerm[] | null> =>
    ipcRenderer.invoke("blacklist:add", { term, imageDataUri, sourceTitle }),
  removeBlacklistTerm: (term: string): Promise<BlacklistTerm[]> => ipcRenderer.invoke("blacklist:remove", { term }),
  onBlacklistUpdated: (cb: (terms: BlacklistTerm[]) => void) => {
    const listener = (_e: unknown, terms: BlacklistTerm[]) => cb(terms);
    ipcRenderer.on("blacklist:updated", listener);
    return () => ipcRenderer.removeListener("blacklist:updated", listener);
  },

  // First UI status readout — Config.tsx's read-only Cloud Sync section
  // (see index.ts's cloud:getStatus and types.ts's CloudStatus).
  cloud: {
    getStatus: (): Promise<CloudStatus> => ipcRenderer.invoke("cloud:getStatus"),
  },

  // Multi-user login migration — the interactive login IS the cloud auth now
  // (see index.ts's auth:* handlers/cloudClient.ts's login/register/
  // restoreSession/logout). App.tsx calls getSession once on mount to decide
  // between the normal app view and LoginScreen; LoginScreen calls login/
  // register directly. The password only ever travels through this one
  // login/register call — never logged, never persisted (only the resulting
  // refresh token is, exactly like the existing cloud-session.json already
  // did for the old env-based auth).
  auth: {
    getSession: (): Promise<{ authenticated: boolean; userId: string | null; email: string | null; apiUrl: string | null; startupProblem?: StartupProblem }> =>
      ipcRenderer.invoke("auth:getSession"),
    login: (apiUrl: string, email: string, password: string): Promise<{ ok: boolean; userId?: string; email?: string; error?: string; startupProblem?: StartupProblem }> =>
      ipcRenderer.invoke("auth:login", { apiUrl, email, password }),
    register: (apiUrl: string, email: string, password: string): Promise<{ ok: boolean; userId?: string; email?: string; error?: string; startupProblem?: StartupProblem }> =>
      ipcRenderer.invoke("auth:register", { apiUrl, email, password }),
    logout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("auth:logout"),
  },

  listBlacklistedImages: (): Promise<BlacklistedImage[]> => ipcRenderer.invoke("blacklistImages:list"),
  confirmBlacklistedImage: (id: string): Promise<BlacklistedImage[]> => ipcRenderer.invoke("blacklistImages:confirm", { id }),
  removeBlacklistedImage: (id: string): Promise<BlacklistedImage[]> => ipcRenderer.invoke("blacklistImages:remove", { id }),
  onBlacklistImagesUpdated: (cb: (images: BlacklistedImage[]) => void) => {
    const listener = (_e: unknown, images: BlacklistedImage[]) => cb(images);
    ipcRenderer.on("blacklistImages:updated", listener);
    return () => ipcRenderer.removeListener("blacklistImages:updated", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

export type ScoutApi = typeof api;
