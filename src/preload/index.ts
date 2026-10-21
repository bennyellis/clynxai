import type { ApiSnapshot } from "../main/apiActivity.js";
import type { Addon, AddonRole, AddonStatus } from "../main/addons.js";
import type { StoredCandidate } from "../main/store.js";
import type { SelfTestResult } from "../main/apiSelfTest.js";
import { contextBridge, ipcRenderer } from "electron";
import type { DiscoveryEntry } from "../main/discovery.js";
import type { ApplyResult, AuditEvent, DecideResult, ReviewSnapshot } from "../main/identityReview.js";
import type { OnboardingState } from "../main/types.js";
import type { LibraryOp, OpResult } from "../main/libraryOps.js";
import type { ChatChoice, ChatStatusEvent } from "../main/chatSupport.js";
import type { Account, ActiveProductResearch, BackupSummary, BetaInfo, BillingActionResult, BillingPlanChoice, BillingStatus, BlacklistedImage, BlacklistTerm, CloudStatus, Config, FeedbackVerdict, ListingRecord, LogLine, ProductImage, ProductProfile, ScrapeStatus, Watch, WatchMatch, WatchPlatform } from "../main/types.js";
import type { ChatMessage, ChatContext, ChatAttachment } from "../main/chat.js";
import type { MetricsSnapshot } from "../main/metrics.js";
import type { ServerTestResult } from "../main/serverAddress.js";
import type { UpdateInfo } from "../main/updater.js";
import type { AppNotice } from "../main/appNotices.js";
import type { StartupProblem } from "../main/startupErrors.js";

const api = {
  getConfig: (): Promise<Config> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: Config): Promise<void> => ipcRenderer.invoke("config:save", config),
  resetConfig: (): Promise<Config> => ipcRenderer.invoke("config:reset"),
  // Config > Reset Clynx: back to a freshly installed state (the sign-in stays). Needs the word RESET.
  resetClynx: (opts: { confirm: string; alsoFacebook: boolean; alsoCloud: boolean }): Promise<{ ok: boolean; error?: string; backupFolder?: string }> => ipcRenderer.invoke("app:resetClynx", opts),
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
  setSearchItemVariants: (args: { item: string; acceptVariants: boolean }): Promise<void> => ipcRenderer.invoke("filters:setSearchItemVariants", args),
  removeRecentSearch: (search: { item: string; minPriceUsd: number | null; maxPriceUsd: number | null; includeBroken?: boolean; acceptVariants?: boolean }): Promise<void> => ipcRenderer.invoke("searches:removeRecent", search),

  hasOpenAIKey: (): Promise<boolean> => ipcRenderer.invoke("env:hasOpenAIKey"),
  saveOpenAIKey: (key: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("env:saveOpenAIKey", key),
  setApiSource: (source: "shared" | "own"): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("account:setApiSource", { source }),
  setKeyProtection: (enabled: boolean): Promise<{ ok: boolean; error?: string; changed?: number; copy?: string }> => ipcRenderer.invoke("env:setKeyProtection", { enabled }),
  deleteKeyCopies: (): Promise<{ ok: boolean; removed: number }> => ipcRenderer.invoke("env:deleteKeyCopies"),
  deleteSavedKeys: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("env:deleteSavedKeys"),
  saveEbayCredentials: (clientId: string, clientSecret: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("env:saveEbayCredentials", { clientId, clientSecret }),
  beta: {
    info: (): Promise<BetaInfo> => ipcRenderer.invoke("beta:info"),
  },
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
  apiActivity: (): Promise<ApiSnapshot> => ipcRenderer.invoke("api:activity"),
  apiSelfTest: (): Promise<SelfTestResult> => ipcRenderer.invoke("api:selfTest"),
  countListings: (): Promise<number> => ipcRenderer.invoke("listings:count"),
  listingLifecycle: (): Promise<{ total: number; opened: number; fullyEvaluated: number; stages: Record<"prefiltered" | "postfiltered" | "pending" | "profitable" | "unprofitable" | "uncertain" | "failed" | "deferred", number> }> => ipcRenderer.invoke("listings:lifecycle"),
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
    attachments?: ChatAttachment[],
    choice?: { choiceId: string; optionId: string }
  ) => ipcRenderer.send("ai:chatStart", { requestId, message, history, context, productId, attachments, choice }),
  // Beta 13: stop a running chat turn; real progress steps (tool / model, with when they really started); and questions with buttons.
  cancelChat: (requestId: string) => ipcRenderer.send("ai:chatCancel", { requestId }),
  onChatStatus: (cb: (e: ChatStatusEvent) => void) => {
    const listener = (_e: unknown, e: ChatStatusEvent) => cb(e);
    ipcRenderer.on("ai:chatStatus", listener);
    return () => ipcRenderer.removeListener("ai:chatStatus", listener);
  },
  onChatChoices: (cb: (requestId: string, choice: ChatChoice) => void) => {
    const listener = (_e: unknown, args: { requestId: string; choice: ChatChoice }) => cb(args.requestId, args.choice);
    ipcRenderer.on("ai:chatChoices", listener);
    return () => ipcRenderer.removeListener("ai:chatChoices", listener);
  },
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
  // Ids and names only, no photos (the light lookup).
  listProductIndex: (): Promise<Array<{ id: string; name: string; family: string | null }>> => ipcRenderer.invoke("products:listIndex"),
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
  // Beta 13 Library operations (libraryOps.ts): one backend for the screen and the chat.
  libraryOp: (op: LibraryOp, confirm?: string): Promise<OpResult> => ipcRenderer.invoke("library:op", { op, confirm }),
  libraryFolders: (): Promise<Array<{ id: string; parentId: string | null; name: string; position: number; kind: string }>> => ipcRenderer.invoke("library:folders"),
  // Automatic folders: renamed labels and pictures with provenance (folderKeys.ts). Uploads are checked and resized in the main process.
  libraryFolderMeta: (): Promise<Array<{ id: string; displayName: string | null; thumbData: string | null; thumbSource: "ai_generated" | "auto" | "user_upload" | "user_selected" | "placeholder" | null; thumbLocked: boolean }>> => ipcRenderer.invoke("library:folderMeta"),
  uploadFolderThumbnail: (key: string, dataUri: string, fileName?: string): Promise<OpResult> => ipcRenderer.invoke("library:uploadFolderThumbnail", { key, dataUri, fileName }),
  generateFolderThumbnail: (key: string): Promise<OpResult> => ipcRenderer.invoke("library:generateFolderThumbnail", { key }),
  libraryCleanupPlan: (): Promise<{ plan: { groups: Array<{ canonical: string; keep: { id: string; name: string }; fold: Array<{ id: string; name: string }>; why: string }>; before: number; after: number; skipped: Array<{ canonical: string; names: string[]; why: string }>; fingerprint: string }; text: string; batches: Array<{ batchId: string; at: number; folded: number; keptNames: string[]; undone: boolean }> }> => ipcRenderer.invoke("library:cleanupPlan"),
  libraryCleanupRun: (fingerprint: string): Promise<{ ok: boolean; merged: number; batchId?: string | null; error?: string }> => ipcRenderer.invoke("library:cleanupRun", { fingerprint }),
  libraryCleanupUndo: (batchId: string): Promise<{ ok: boolean; restored: number }> => ipcRenderer.invoke("library:cleanupUndo", { batchId }),
  priceAnswer: (a: { productId: string; lowUsd: number; highUsd?: number; condition?: string; includes?: string; recency?: string }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("price:answer", a),
  priceDismiss: (productId: string, how: "later" | "never" | "notSure"): Promise<{ ok: boolean }> => ipcRenderer.invoke("price:dismiss", { productId, how }),
  priceOpenSold: (productId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("price:openSold", { productId }),
  soldImport: (text: string): Promise<{ added: number; skipped: Array<{ line: number; text: string; reason: string }>; total: number }> => ipcRenderer.invoke("sold:import", { text }),
  soldImportStatus: (): Promise<{ total: number }> => ipcRenderer.invoke("sold:importStatus"),
  soldImportClear: (): Promise<{ removed: number; ok: boolean }> => ipcRenderer.invoke("sold:importClear"),
  priceHowTo: (): Promise<string[]> => ipcRenderer.invoke("price:howTo"),
  onToast: (cb: (t: { id: string; message: string; productId: string | null; tone: "good" | "info" }) => void): (() => void) => {
    const listener = (_e: unknown, t: { id: string; message: string; productId: string | null; tone: "good" | "info" }) => cb(t);
    ipcRenderer.on("toast:show", listener);
    return () => ipcRenderer.removeListener("toast:show", listener);
  },
  productAliases: (): Promise<Record<string, string[]>> => ipcRenderer.invoke("products:aliases"),
  learnedFacts: (productId: string): Promise<Array<{ attribute: string; value: string; count: number; source: string; ignored: boolean; lastSeenAt: number }>> => ipcRenderer.invoke("facts:learned", productId),
  ignoreLearnedFact: (productId: string, attribute: string, value: string, ignored: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("facts:ignore", { productId, attribute, value, ignored }),
  productFoldedNotice: (productId: string): Promise<{ colours: string[]; names: string[]; text: string } | null> => ipcRenderer.invoke("products:foldedNotice", productId),
  productOrigin: (productId: string): Promise<{ reason: string; detail: string | null; at: number } | null> => ipcRenderer.invoke("products:origin", productId),
  splitGallery: (itemId: string): Promise<{ ok: boolean; error?: string; summary?: string; opId?: string | null }> => ipcRenderer.invoke("library:splitGallery", { itemId }),
  splitGalleryKeep: (itemId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("library:splitGalleryKeep", { itemId }),
  attentionGet: (): Promise<{ count: number; items: Array<{ id: string; kind: string; productIds: string[] }> }> => ipcRenderer.invoke("attention:get"),
  attentionAck: (itemId: string): Promise<{ count: number; items: Array<{ id: string; kind: string; productIds: string[] }> }> => ipcRenderer.invoke("attention:ack", { itemId }),
  attentionAckAll: (): Promise<{ count: number; items: Array<{ id: string; kind: string; productIds: string[] }> }> => ipcRenderer.invoke("attention:ackAll"),
  libraryHistory: (): Promise<Array<{ id: string; at: number; actor: string; op: string; undone: boolean }>> => ipcRenderer.invoke("library:history"),
  libraryTrash: (): Promise<{ products: Array<{ id: string; name: string; deletedAt: number }>; images: Array<{ id: string; productId: string; productName: string; sourceTitle: string | null; deletedAt: number }>; folders: Array<{ id: string; name: string; deletedAt: number }> }> => ipcRenderer.invoke("library:trash"),
  libraryReview: (): Promise<Array<{ id: string; kind: string; subjectId: string; reasons: string[]; evidence: Record<string, unknown>; createdAt: number; image: string | null; productName: string | null; suggestedName: string | null; details: Array<{ id: string; name: string; added: number; photos: number; valueUsd: number | null; folder: string | null }> | null }>> => ipcRenderer.invoke("library:review"),
  onLibraryChanged: (cb: (what: { folders: boolean; review: boolean }) => void) => {
    const listener = (_e: unknown, what: { folders: boolean; review: boolean }) => cb(what);
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  },
  clearAllProducts: (): Promise<void> => ipcRenderer.invoke("products:clearAll"),
  // Add-ons on a product's Library page (addons.ts). Every call answers with that product's add-ons as they are now.
  listAddons: (productId: string): Promise<Addon[]> => ipcRenderer.invoke("addons:list", productId),
  listFoundCandidates: (productId: string): Promise<StoredCandidate[]> => ipcRenderer.invoke("variants:found", productId),
  addonPickerOptions: (productId: string, niche: "game" | "accessory"): Promise<Array<{ entryId: string; name: string; valueUsd: number | null }>> => ipcRenderer.invoke("addons:pickerOptions", productId, niche),
  addAddonFromEntry: (productId: string, entryId: string): Promise<Addon[]> => ipcRenderer.invoke("addons:addFromEntry", productId, entryId),
  addAddon: (productId: string, input: { name: string; role?: AddonRole; standaloneValueUsd?: number | null; enabled?: boolean }): Promise<Addon[]> => ipcRenderer.invoke("addons:add", productId, input),
  setAddonEnabled: (id: string, enabled: boolean): Promise<Addon[]> => ipcRenderer.invoke("addons:setEnabled", id, enabled),
  setAddonStatus: (id: string, status: AddonStatus): Promise<Addon[]> => ipcRenderer.invoke("addons:setStatus", id, status),
  updateAddon: (id: string, patch: { name?: string; role?: AddonRole; standaloneValueUsd?: number | null }): Promise<Addon[]> => ipcRenderer.invoke("addons:update", id, patch),
  removeAddon: (id: string): Promise<Addon[]> => ipcRenderer.invoke("addons:remove", id),
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
    includeBroken?: boolean,
    acceptVariants?: boolean
  ): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("search:addProducts", {
      items,
      linkedProductId: linkedProductId ?? null,
      minPriceUsd: minPriceUsd ?? null,
      maxPriceUsd: maxPriceUsd ?? null,
      includeBroken: includeBroken === true,
      acceptVariants: acceptVariants === true,
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
  // The Database > Review screen (review-only: these read; deciding is refused unless switched on in config.json, and never changes the Database).
  getIdentityReview: (): Promise<ReviewSnapshot | null> => ipcRenderer.invoke("review:get"),
  runIdentityReview: (): Promise<ReviewSnapshot> => ipcRenderer.invoke("review:run"),
  getIdentityReviewHistory: (): Promise<AuditEvent[]> => ipcRenderer.invoke("review:history"),
  applyIdentityCorrection: (proposalId: string): Promise<ApplyResult> => ipcRenderer.invoke("review:apply", { proposalId }),
  undoIdentityCorrection: (proposalId: string): Promise<DecideResult> => ipcRenderer.invoke("review:undo", { proposalId }),
  decideIdentityReview: (proposalId: string, decision: "approved" | "rejected" | "clear", note?: string | null): Promise<DecideResult> => ipcRenderer.invoke("review:decide", { proposalId, decision, note: note ?? null }),
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
  support: {
    saveReport: (): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke("support:saveReport"),
  },
  backups: {
    list: (): Promise<BackupSummary> => ipcRenderer.invoke("backups:list"),
    backupNow: (): Promise<BackupSummary> => ipcRenderer.invoke("backups:now"),
    restore: (name: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("backups:restore", { name }),
  },
  account: {
    getBilling: (): Promise<BillingStatus | null> => ipcRenderer.invoke("billing:status"),
    startCheckout: (plan: BillingPlanChoice): Promise<BillingActionResult> => ipcRenderer.invoke("billing:checkout", { plan }),
    openBillingPortal: (): Promise<BillingActionResult> => ipcRenderer.invoke("billing:portal"),
    changePassword: (currentPassword: string, newPassword: string): Promise<BillingActionResult> => ipcRenderer.invoke("account:changePassword", { currentPassword, newPassword }),
    deleteAccount: (password: string): Promise<BillingActionResult> => ipcRenderer.invoke("account:delete", { password }),
  },
  cloud: {
    getStatus: (): Promise<CloudStatus> => ipcRenderer.invoke("cloud:getStatus"),
    testServer: (url: string): Promise<ServerTestResult> => ipcRenderer.invoke("cloud:testServer", { url }),
    retryNow: (): Promise<{ online: boolean }> => ipcRenderer.invoke("cloud:retryNow"),
  },
  updates: {
    getStatus: (): Promise<UpdateInfo> => ipcRenderer.invoke("updates:getStatus"),
    check: (): Promise<UpdateInfo> => ipcRenderer.invoke("updates:check"),
    download: (): Promise<UpdateInfo> => ipcRenderer.invoke("updates:download"),
    install: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("updates:install"),
    rollback: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("updates:rollback"),
    setMode: (mode: "off" | "notify" | "download" | "automatic"): Promise<{ ok: boolean }> => ipcRenderer.invoke("updates:setMode", { mode }),
    setChannel: (channel: "beta" | "stable"): Promise<{ ok: boolean }> => ipcRenderer.invoke("updates:setChannel", { channel }),
    onStatus: (cb: (info: UpdateInfo) => void): (() => void) => {
      const h = (_e: unknown, info: UpdateInfo) => cb(info);
      ipcRenderer.on("updates:status", h);
      return () => {
        ipcRenderer.removeListener("updates:status", h);
      };
    },
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
    login: (apiUrl: string, email: string, password: string, importLocal?: boolean): Promise<{ ok: boolean; userId?: string; email?: string; error?: string; startupProblem?: StartupProblem; imported?: string }> =>
      ipcRenderer.invoke("auth:login", { apiUrl, email, password, importLocal }),
    register: (apiUrl: string, email: string, password: string, importLocal?: boolean, inviteCode?: string): Promise<{ ok: boolean; userId?: string; email?: string; error?: string; startupProblem?: StartupProblem; imported?: string }> =>
      ipcRenderer.invoke("auth:register", { apiUrl, email, password, importLocal, inviteCode }),
    onSignedOut: (cb: (info: { reason: string }) => void) => {
      const listener = (_e: unknown, info: { reason: string }) => cb(info);
      ipcRenderer.on("auth:signedOut", listener);
      return () => {
        ipcRenderer.removeListener("auth:signedOut", listener);
      };
    },
    openWebsite: (page: "account" | "billing" | "devices" | "download" | "support"): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("account:openWebsite", { page }),
    logout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("auth:logout"),
    startLocal: (): Promise<{ ok: boolean; error?: string; startupProblem?: StartupProblem }> => ipcRenderer.invoke("auth:startLocal"),
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
