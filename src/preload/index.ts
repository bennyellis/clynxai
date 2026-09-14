import { contextBridge, ipcRenderer } from "electron";
import type { BlacklistedImage, BlacklistTerm, Config, FeedbackVerdict, ListingRecord, LogLine, ProductImage, ProductProfile, ScrapeStatus } from "../main/types.js";
import type { ChatMessage, ChatContext, ChatAttachment } from "../main/chat.js";

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
    patch: Partial<Pick<Config, "minPriceUsd" | "maxPriceUsd" | "maxListingAgeHours" | "rotateSearchItems" | "rotateSearchItemsCount">>
  ): Promise<void> => ipcRenderer.invoke("filters:update", patch),
  removeSearchItem: (item: string): Promise<void> => ipcRenderer.invoke("filters:removeSearchItem", { item }),

  hasOpenAIKey: (): Promise<boolean> => ipcRenderer.invoke("env:hasOpenAIKey"),
  saveOpenAIKey: (key: string): Promise<void> => ipcRenderer.invoke("env:saveOpenAIKey", key),

  getEngineStatus: (): Promise<ScrapeStatus> => ipcRenderer.invoke("engine:status"),
  startEngine: (): Promise<void> => ipcRenderer.invoke("engine:start"),
  stopEngine: (): Promise<void> => ipcRenderer.invoke("engine:stop"),
  runEngineOnce: (): Promise<void> => ipcRenderer.invoke("engine:runOnce"),
  login: (): Promise<boolean> => ipcRenderer.invoke("engine:login"),
  checkLogin: (): Promise<boolean> => ipcRenderer.invoke("engine:checkLogin"),
  openWatchCountLogin: (): Promise<void> => ipcRenderer.invoke("engine:openWatchCountLogin"),
  setLocationMode: (
    args: { mode: "country" } | { mode: "state"; state: string } | { mode: "city"; cityOrZip: string }
  ): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("location:setMode", args),

  listListings: (limit?: number, offset?: number): Promise<ListingRecord[]> =>
    ipcRenderer.invoke("listings:list", { limit, offset }),
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
  listGroupThumbnails: (): Promise<Record<string, string>> => ipcRenderer.invoke("products:listGroupThumbnails"),
  onGroupThumbnailUpdated: (cb: (path: string, imageData: string) => void) => {
    const listener = (_e: unknown, args: { path: string; imageData: string }) => cb(args.path, args.imageData);
    ipcRenderer.on("groupThumbnails:updated", listener);
    return () => ipcRenderer.removeListener("groupThumbnails:updated", listener);
  },
  refreshProduct: (id: string): Promise<ProductProfile | null> => ipcRenderer.invoke("products:refresh", { id }),
  deleteProduct: (id: string): Promise<void> => ipcRenderer.invoke("products:delete", { id }),
  clearAllProducts: (): Promise<void> => ipcRenderer.invoke("products:clearAll"),
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
  refreshEbayComps: (id: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("products:refreshEbayComps", { id }),
  // The Dashboard "Search for Products" box — a batch of product names
  // composed there, added to the Search For list, and searched immediately.
  searchForProducts: (items: string[]): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("search:addProducts", { items }),
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
  onProductUpdated: (cb: (product: ProductProfile) => void) => {
    const listener = (_e: unknown, product: ProductProfile) => cb(product);
    ipcRenderer.on("products:updated", listener);
    return () => ipcRenderer.removeListener("products:updated", listener);
  },

  listBlacklistTerms: (): Promise<BlacklistTerm[]> => ipcRenderer.invoke("blacklist:list"),
  addBlacklistTerm: (term: string, imageDataUri?: string | null, sourceTitle?: string | null): Promise<BlacklistTerm[] | null> =>
    ipcRenderer.invoke("blacklist:add", { term, imageDataUri, sourceTitle }),
  removeBlacklistTerm: (term: string): Promise<BlacklistTerm[]> => ipcRenderer.invoke("blacklist:remove", { term }),
  onBlacklistUpdated: (cb: (terms: BlacklistTerm[]) => void) => {
    const listener = (_e: unknown, terms: BlacklistTerm[]) => cb(terms);
    ipcRenderer.on("blacklist:updated", listener);
    return () => ipcRenderer.removeListener("blacklist:updated", listener);
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
