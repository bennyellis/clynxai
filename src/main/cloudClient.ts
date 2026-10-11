// Clynx Cloud Phase 1 — a thin, feature-flagged client for the new cloud/
// backend (see cloud/README.md). Deliberately minimal: health check, device
// registration, and a heartbeat, nothing else yet. Every exported function
// here NEVER throws — callers (index.ts's optional heartbeat interval) can
// call these without their own try/catch. Not imported by any renderer
// code; only index.ts talks to this.
//
// Clynx Cloud Phase 2 — extended with the Watch sync endpoints
// (watchSync.ts's caller). Same shape, same never-throw safeFetch plumbing;
// no new fetch logic duplicated.
//
// Batch 2 Fix A — env-based headless login (bootstrapAuth), session
// persistence (cloud-session.json, see readSession/writeSession below), and
// a proactive access-token refresh timer.
//
// Multi-user login migration — bootstrapAuth (env-var-based, headless) is
// gone. Cloud auth IS the app's login now (see index.ts's LoginScreen-driven
// auth:login/auth:register/auth:getSession/auth:logout handlers): login()/
// register() authenticate against a user-supplied Server URL + email/
// password, and restoreSession() silently re-authenticates on a later
// launch using the persisted refresh token — same rotation/persistence
// plumbing as before, just reached interactively instead of from .env. The
// persisted session file now also remembers WHICH user (id + email) and
// which server (apiUrl) it belongs to, since index.ts needs that to decide
// which per-user data folder to load *before* any per-user Config exists to
// read an apiUrl from.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config, FeedbackVerdict, ListingRecord, ProductProfile, SyncStatus, Watch, WatchMatch } from "./types.js";

// The wire shape a PUT /watches/:localId body/response uses — Watch's own
// fields plus the extra localId/deviceId/id bookkeeping the cloud schema
// needs (see cloud/src/watches/routes.ts's watchUpsertSchema/watchRowToJson).
//
// Batch 2 Fix D — the cloud side (batch 1) no longer accepts or returns 8
// desktop-local-only operational/scheduler fields (nextCheckAt,
// lastCheckedAt, lastActiveCheckAt, listingsSeenCount, matchCount,
// resolvedLocationUrl, resolvedLocationLabel, resolvedLocationCheckedAt) —
// those are purely per-device concerns now, never synced. `revision` is new:
// a server-assigned monotonic cursor (see cloud/src/watches/routes.ts's Fix
// 3) that watchSync.ts's pull() tracks instead of updatedAt.
export interface CloudWatch {
  id?: string;
  localId: string;
  deviceId?: string | null;
  name: string;
  searchPhrase: string;
  matchKeywords: string[];
  linkedProductId: string | null;
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
  minProfitUsd: number | null;
  minDiscountPercent: number | null;
  maxListingAgeMinutes: number | null;
  locationMode: "country" | "state" | "city";
  selectedState: string | null;
  selectedCityOrZip: string | null;
  searchRadiusMiles: number | null;
  // Watch-platform fields. Optional because the cloud server's own schema
  // predates them: it ignores them on a PUT (zod strips unknown keys) and
  // doesn't send them back, in which case the local values are kept as they
  // are (see Store.upsertWatchFromCloud). They start syncing as soon as the
  // server's watches route is taught the two fields.
  platform?: "facebook" | "ebay";
  minSellerRatingPercent?: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // Server-assigned sync cursor — present on every response row, never sent
  // by the client (see watchToCloud below, which never sets it).
  revision?: number;
}

export interface CloudWatchMatch {
  localId: string;
  listingId: string;
  matchedAt: number;
  foundByAccountId: string | null;
  foundByAccountLabel: string | null;
  discoveryMode: "passive" | "active";
  priceAtMatch: number | null;
  discountPercentAtMatch: number | null;
  profitUsdAtMatch: number | null;
  notified: boolean;
  notifiedAt: number | null;
}

// Batch 2 Fix D — deliberately omits the 8 local-only operational fields
// (see CloudWatch's own doc comment above) from the outgoing PUT body; the
// cloud's watchUpsertSchema has no fields for them either way (zod strips
// unrecognized keys), but not sending them at all keeps this function
// honest about what's actually a synced field. `revision` is left unset —
// it's a server-assigned response-only field, never something a client
// sends.
export function watchToCloud(w: Watch): CloudWatch {
  return {
    localId: w.id,
    name: w.name,
    searchPhrase: w.searchPhrase,
    matchKeywords: w.matchKeywords,
    linkedProductId: w.linkedProductId,
    minPriceUsd: w.minPriceUsd,
    maxPriceUsd: w.maxPriceUsd,
    minProfitUsd: w.minProfitUsd,
    minDiscountPercent: w.minDiscountPercent,
    maxListingAgeMinutes: w.maxListingAgeMinutes,
    locationMode: w.locationMode,
    selectedState: w.selectedState,
    selectedCityOrZip: w.selectedCityOrZip,
    searchRadiusMiles: w.searchRadiusMiles,
    platform: w.platform,
    minSellerRatingPercent: w.minSellerRatingPercent,
    enabled: w.enabled,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function watchMatchToCloud(m: WatchMatch): CloudWatchMatch {
  return {
    localId: m.id,
    listingId: m.listingId,
    matchedAt: m.matchedAt,
    foundByAccountId: m.foundByAccountId,
    foundByAccountLabel: m.foundByAccountLabel,
    discoveryMode: m.discoveryMode,
    priceAtMatch: m.priceAtMatch,
    discountPercentAtMatch: m.discountPercentAtMatch,
    profitUsdAtMatch: m.profitUsdAtMatch,
    notified: m.notified,
    notifiedAt: m.notifiedAt,
  };
}

// --- Clynx Cloud Phase 3 — Listing ingestion + global dedup ---------------
// The wire shape a POST /listings/ingest item uses — mirrors
// cloud/src/listings/routes.ts's listingSchema exactly. Dedup key is
// (source, sourceListingId); sourceListingId is the SAME stable id
// scraper.ts already derives from a listing's own /marketplace/item/<id>/
// URL (that's what store.ts uses as its local `listings.id` primary key
// too — see ListingRecord.id), so no separate id derivation logic is
// needed here.
export interface CloudListing {
  source: string;
  sourceListingId: string;
  title: string;
  description: string | null;
  price: number | null;
  url: string;
  thumbnailUrl: string | null;
  images: string[];
  locationText: string | null;
  listingAge: string | null;
  sellerName: string | null;
  sellerJoinedYear: number | null;
  sellerRating: number | null;
  sellerRatingCount: number | null;
  sellerHasProfilePhoto: boolean | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface CloudListingResult {
  id: string;
  isNew: boolean;
  changed: boolean;
}

// Only Facebook Marketplace exists as a source today — a fixed constant
// rather than a Config field, same posture as scraper.ts's own hardcoded
// assumption that every listing it finds is one.
const LISTING_SOURCE = "facebook_marketplace";

export function listingToCloud(l: ListingRecord): CloudListing {
  return {
    source: LISTING_SOURCE,
    sourceListingId: l.id,
    title: l.title,
    description: l.description || null,
    price: l.price,
    url: l.url,
    thumbnailUrl: l.thumbnailUrl,
    images: l.imageUrls,
    locationText: l.locationText,
    listingAge: l.listingAge,
    sellerName: l.sellerName,
    sellerJoinedYear: l.sellerJoinedYear,
    sellerRating: l.sellerRating,
    sellerRatingCount: l.sellerRatingCount,
    sellerHasProfilePhoto: l.sellerHasProfilePhoto,
    firstSeenAt: l.firstSeenAt,
    lastSeenAt: Date.now(),
  };
}

// --- Clynx Cloud Phase 5 — Feed feedback sync -----------------------------
// The wire shape a PUT /feedback/:listingId body/response uses — mirrors
// cloud/src/feedback/routes.ts's feedbackUpsertSchema/feedbackRowToJson.
// `listingId` here is always the CLOUD canonical listings.id (uuid) —
// feedbackSync.ts is responsible for resolving a local Facebook item id to
// this via lookupListing below before ever constructing one of these.
export interface CloudFeedback {
  listingId: string;
  sourceListingId: string | null;
  verdict: FeedbackVerdict;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  // Batch 2 Fix D — server-assigned sync cursor (see CloudWatch's own
  // comment above); never sent by the client.
  revision?: number;
}

export function feedbackToCloud(local: {
  verdict: FeedbackVerdict;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}): Omit<CloudFeedback, "listingId" | "sourceListingId"> {
  return { verdict: local.verdict, note: local.note, createdAt: local.createdAt, updatedAt: local.updatedAt };
}

// --- Clynx Cloud Phase 6 — personal Database/Library (ProductProfile) sync -
// The wire shape a PUT /products/:localId body/response uses — mirrors
// cloud/src/products/routes.ts's productUpsertSchema/productRowToJson.
// Deliberately excludes imageUrl/familyLogoUrl (always locally-downloaded
// `data:` URIs, not plain remote URLs — see store.ts's ProductProfile
// comments) and the product_images/group_thumbnails tables entirely — those
// need S3-compatible object storage that isn't set up yet, per Phase 6
// scope. loading is included so a synced row round-trips faithfully, but
// productSync.ts never pushes a product while it's still loading (see that
// file's push()).
export interface CloudProduct {
  id?: string;
  localId: string;
  name: string;
  aiSummary: string | null;
  aiSummaryGeneratedAt: number | null;
  observedNotes: string | null;
  category: string;
  family: string | null;
  resalePriceUsd: number | null;
  resaleTimeToSell: string | null;
  lookoutNotes: string | null;
  keepThumbnail: boolean;
  desiredPriceUsd: number | null;
  hardCapAtDesiredPrice: boolean;
  prioritized: boolean;
  ebayAvgSoldPriceUsd: number | null;
  ebayAvgRunTimeDays: number | null;
  ebayAvgShippingUsd: number | null;
  ebayCompsSampleSize: number | null;
  ebayCompsCheckedAt: number | null;
  loading: boolean;
  createdAt: number;
  updatedAt: number;
  // Batch 2 Fix D — server-assigned sync cursor (see CloudWatch's own
  // comment above); never sent by the client.
  revision?: number;
}

export function productToCloud(p: ProductProfile): CloudProduct {
  return {
    localId: p.id,
    name: p.name,
    aiSummary: p.aiSummary || null,
    aiSummaryGeneratedAt: p.aiSummaryGeneratedAt,
    observedNotes: p.observedNotes || null,
    category: p.category,
    family: p.family,
    resalePriceUsd: p.resalePriceUsd,
    resaleTimeToSell: p.resaleTimeToSell,
    lookoutNotes: p.lookoutNotes || null,
    keepThumbnail: p.keepThumbnail,
    desiredPriceUsd: p.desiredPriceUsd,
    hardCapAtDesiredPrice: p.hardCapAtDesiredPrice,
    prioritized: p.prioritized,
    ebayAvgSoldPriceUsd: p.ebayAvgSoldPriceUsd,
    ebayAvgRunTimeDays: p.ebayAvgRunTimeDays,
    ebayAvgShippingUsd: p.ebayAvgShippingUsd,
    ebayCompsSampleSize: p.ebayCompsSampleSize,
    ebayCompsCheckedAt: p.ebayCompsCheckedAt,
    loading: p.loading,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export interface CloudResult<T = void> {
  ok: boolean;
  status?: number;
  error?: string;
  data?: T;
}

const REQUEST_TIMEOUT_MS = 5000;

// "localhost" is tried over IPv6 (::1) first on this machine, and the Docker/WSL port relay can
// leave that address hanging (accepting nothing) while 127.0.0.1 answers instantly, which made
// every request time out after 5s ("This operation was aborted") with the server healthy. A
// local server is therefore always addressed as 127.0.0.1. Remote servers are left alone.
export function useIpv4Loopback(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "localhost") return url;
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
  } catch {
    return url;
  }
}

function getApiUrl(config: Config): string | null {
  const apiUrl = config.cloud?.apiUrl;
  if (!apiUrl) return null;
  return apiUrl.replace(/\/+$/, "");
}

// Trims a URL exactly like getApiUrl does, for sessionApiUrl (already
// validated non-empty by authenticate()/restoreSession(), so no null check
// is needed the way getApiUrl's config-derived value requires one).
function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

// --- Batch 2 Fix A — session persistence ----------------------------------
// A small on-disk record of what needs to survive an app restart to avoid
// re-logging-in every launch: the device id (so this install doesn't spawn a
// new `devices` row every time), the current refresh token (rotated on
// every use — see refreshAccessToken below), and — as of the multi-user
// login migration — which user (id + email) and which server (apiUrl) that
// session belongs to, so a silent relaunch re-auth (see restoreSession
// below) knows both WHO to log back in as and WHERE to reach, before any
// per-user Config has even been loaded yet. Deliberately never stores the
// access token (short-lived, cheaply re-derived at every startup) or the
// password (never held anywhere beyond the single login()/register() call
// that receives it). Read/write are both best-effort and never throw — a
// missing or corrupt session file just means restoreSession reports "not
// authenticated" and the LoginScreen shows, same as a first-ever run.
interface CloudSession {
  deviceId: string | null;
  refreshToken: string | null;
  userId: string | null;
  email: string | null;
  apiUrl: string | null;
}

function readSession(sessionPath: string): CloudSession {
  try {
    if (!existsSync(sessionPath)) return { deviceId: null, refreshToken: null, userId: null, email: null, apiUrl: null };
    const raw = JSON.parse(readFileSync(sessionPath, "utf-8"));
    return {
      deviceId: typeof raw?.deviceId === "string" ? raw.deviceId : null,
      refreshToken: typeof raw?.refreshToken === "string" ? raw.refreshToken : null,
      userId: typeof raw?.userId === "string" ? raw.userId : null,
      email: typeof raw?.email === "string" ? raw.email : null,
      apiUrl: typeof raw?.apiUrl === "string" ? raw.apiUrl : null,
    };
  } catch (err) {
    console.error("[cloudClient] failed to read cloud-session.json:", err);
    return { deviceId: null, refreshToken: null, userId: null, email: null, apiUrl: null };
  }
}

function writeSession(sessionPath: string, session: CloudSession): void {
  try {
    writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf-8");
  } catch (err) {
    console.error("[cloudClient] failed to write cloud-session.json:", err);
  }
}

async function safeFetch(url: string, init?: RequestInit): Promise<CloudResult<any>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(useIpv4Loopback(url), { ...init, signal: controller.signal });
    let data: any = undefined;
    try {
      data = await res.json();
    } catch {
      // No/invalid JSON body — fine for e.g. a 204 or a non-JSON error page.
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error ?? `Request failed with status ${res.status}`, data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export class CloudClient {
  private accessToken: string | null = null;
  private deviceId: string | null = null;
  // Batch 2 Fix A — kept in memory alongside accessToken so the proactive
  // refresh timer (see startAuthRefreshTimer) and ensureDeviceRegistered
  // don't need to re-read the session file on every use; persistSession
  // below is what keeps the on-disk copy in sync with these two.
  private refreshToken: string | null = null;
  // Multi-user login migration — WHO is logged in (userId/email) and WHICH
  // server (sessionApiUrl) that login was against. Set by login()/
  // register()/restoreSession() below; index.ts reads userId via
  // getSessionInfo() to know which per-user data folder to load. Kept
  // separate from getConfig()'s per-user Config.cloud.apiUrl on purpose —
  // this is what's used to reach the server BEFORE any per-user config has
  // been loaded (restoreSession, the login screen's own default), where
  // per-user config.cloud.apiUrl is just index.ts mirroring this value into
  // that user's own config once bootstrapped, for the sync services to use.
  private userId: string | null = null;
  private email: string | null = null;
  private sessionApiUrl: string | null = null;
  private authRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // Guards against an overlapping refresh (the periodic timer firing again
  // before a slow prior refresh call has resolved) — see refreshAccessToken.
  private refreshingAuth = false;
  private static readonly AUTH_REFRESH_INTERVAL_MS = 10 * 60_000;
  // First UI status readout (see index.ts's cloud:getStatus) — tracked
  // right inside sendHeartbeat below (the only place a heartbeat is ever
  // actually sent) so this stays accurate regardless of who calls it or how
  // often. lastHeartbeatError is cleared on the next successful heartbeat,
  // not on every tick, so a real failure stays visible until sync actually
  // recovers rather than disappearing the instant a differently-failing
  // tick runs.
  private lastHeartbeatAt: number | null = null;
  private lastHeartbeatError: string | null = null;

  constructor(
    private getConfig: () => Config,
    private sessionPath: string
  ) {}

  // Every outbound call below resolves its target server through this,
  // not getApiUrl(this.getConfig()) directly. sessionApiUrl (set the moment
  // login()/register()/restoreSession() succeeds) is authoritative — it's
  // known before bootstrapUserSession has loaded any per-user config at
  // all, which matters because authenticate() calls ensureDeviceRegistered()
  // (and the auth refresh timer starts) immediately after login succeeds,
  // well before index.ts's auth:login/auth:register handlers get around to
  // calling bootstrapUserSession. Falling back to config.cloud?.apiUrl
  // covers any call that happens to run after a restart with no active
  // CloudClient session yet (there isn't one today, but this keeps the
  // fallback correct if that changes).
  private resolveApiUrl(): string | null {
    if (this.sessionApiUrl) return trimTrailingSlashes(this.sessionApiUrl);
    return getApiUrl(this.getConfig());
  }

  // Batch 2 Fix A reactive fallback — every authenticated call below routes
  // through this instead of calling safeFetch directly. A 401 means the
  // access token this call was sent with is no longer valid (expired,
  // revoked) — cheaply detected here and reacted to by clearing it, so
  // isAuthenticated() correctly reports false again and no code path keeps
  // hammering a dead token. Deliberately does NOT retry the request inline
  // (see this file's own module doc / the batch 2 task notes) — the
  // periodic refresh timer plus each sync service's own isAuthenticated()
  // gate re-establishes auth and naturally retries on the next tick, which
  // is simple and sufficient for this phase.
  private async authedFetch(url: string, init?: RequestInit): Promise<CloudResult<any>> {
    const result = await safeFetch(url, init);
    if (result.status === 401) {
      this.accessToken = null;
    }
    return result;
  }

  async checkHealth(): Promise<CloudResult> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) {
      return { ok: false, error: "Cloud apiUrl not configured" };
    }
    try {
      return await safeFetch(`${apiUrl}/health`);
    } catch (err) {
      console.error("[cloudClient] checkHealth failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async registerDevice(): Promise<CloudResult<{ id: string }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) {
      return { ok: false, error: "Cloud apiUrl not configured" };
    }
    if (!this.accessToken) {
      return { ok: false, error: "Not authenticated — no access token available yet" };
    }
    try {
      const result = await this.authedFetch(`${apiUrl}/devices/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({ platform: process.platform, clientVersion: process.env["npm_package_version"] ?? "unknown" }),
      });
      if (result.ok && result.data?.id) {
        this.deviceId = result.data.id;
      }
      return result;
    } catch (err) {
      console.error("[cloudClient] registerDevice failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendHeartbeat(): Promise<CloudResult> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) {
      const result: CloudResult = { ok: false, error: "Cloud apiUrl not configured" };
      this.lastHeartbeatError = result.error ?? null;
      return result;
    }
    if (!this.accessToken || !this.deviceId) {
      const result: CloudResult = { ok: false, error: "Not registered — no access token/device id available yet" };
      this.lastHeartbeatError = result.error ?? null;
      return result;
    }
    try {
      const result = await this.authedFetch(`${apiUrl}/devices/${this.deviceId}/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (result.ok) {
        this.lastHeartbeatAt = Date.now();
        this.lastHeartbeatError = null;
      } else {
        this.lastHeartbeatError = result.error ?? "Heartbeat failed";
      }
      return result;
    } catch (err) {
      console.error("[cloudClient] sendHeartbeat failed:", err);
      const result: CloudResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      this.lastHeartbeatError = result.error ?? null;
      return result;
    }
  }

  // Whether a request can plausibly be authenticated right now — watchSync.ts
  // uses this to skip a sync tick cheaply instead of firing requests that
  // are guaranteed to come back "Not authenticated".
  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  // Per explicit instruction — proxies an OpenAI-shaped request through this
  // server's own /ai/* routes (see cloud/src/ai/routes.ts) instead of
  // calling OpenAI directly, so a shared key can live ONLY on the server,
  // never this machine (see openai.ts's callOpenAI, the only caller). A raw
  // fetch, not safeFetch/authedFetch — those always try to JSON-parse the
  // body, which would consume a streaming chat-completions response before
  // the caller ever gets to read it. Still mirrors authedFetch's own 401
  // reaction (clear the dead token) so isAuthenticated() reports false again
  // and the existing periodic refresh timer re-establishes auth on its own,
  // same posture as every other authenticated call in this file.
  async openAIRequest(
    kind: "chat" | "images",
    body: unknown,
    signal?: AbortSignal
  ): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no cloud session available yet" };
    const path = kind === "chat" ? "/ai/chat/completions" : "/ai/images/generations";
    try {
      const response = await fetch(useIpv4Loopback(`${apiUrl}${path}`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify(body),
        signal,
      });
      if (response.status === 401) this.accessToken = null;
      return { ok: true, response };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  // Multi-user login migration — index.ts's auth:getSession IPC handler
  // reads this (after restoreSession(), or right after a fresh login()/
  // register()) to learn which user is logged in and which server that
  // session is against, without index.ts needing its own copy of this
  // bookkeeping.
  getSessionInfo(): { authenticated: boolean; userId: string | null; email: string | null; apiUrl: string | null } {
    return { authenticated: this.isAuthenticated(), userId: this.userId, email: this.email, apiUrl: this.sessionApiUrl };
  }

  // First UI status readout (see index.ts's cloud:getStatus /
  // Config.tsx's Cloud Sync section) — a single read-only snapshot of
  // everything this class already tracks about itself. apiUrl comes
  // straight from config rather than being cached, since it can change if
  // the user edits config.json without restarting.
  getStatus(): { enabled: boolean; apiUrl: string | null; authenticated: boolean; deviceId: string | null; heartbeat: SyncStatus } {
    const config = this.getConfig();
    return {
      enabled: !!config.cloud?.enabled,
      apiUrl: getApiUrl(config),
      authenticated: this.isAuthenticated(),
      deviceId: this.deviceId,
      heartbeat: { lastAt: this.lastHeartbeatAt, lastError: this.lastHeartbeatError },
    };
  }

  private authHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` };
  }

  // --- Clynx Cloud Phase 2 — Watch sync ------------------------------------
  // Mirrors cloud/src/watches/routes.ts exactly. watchSync.ts is the only
  // caller; local SQLite (store.ts) remains the source of truth throughout.

  // Batch 2 Fix D — `since` is now a server-assigned integer revision
  // cursor (cloud/src/watches/routes.ts's Fix 3), not a client-clock
  // timestamp — sent as a plain integer, not an ISO string.
  async listWatches(since?: number): Promise<CloudResult<{ watches: CloudWatch[] }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      const qs = since ? `?since=${encodeURIComponent(String(since))}` : "";
      return await this.authedFetch(`${apiUrl}/watches${qs}`, { headers: this.authHeaders() });
    } catch (err) {
      console.error("[cloudClient] listWatches failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async upsertWatch(watch: CloudWatch): Promise<CloudResult<{ applied: boolean; watch: CloudWatch }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/watches/${encodeURIComponent(watch.localId)}`, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify({ ...watch, deviceId: watch.deviceId ?? this.deviceId }),
      });
    } catch (err) {
      console.error("[cloudClient] upsertWatch failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteWatch(cloudWatchId: string): Promise<CloudResult> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/watches/${encodeURIComponent(cloudWatchId)}`, {
        method: "DELETE",
        headers: this.authHeaders(),
      });
    } catch (err) {
      console.error("[cloudClient] deleteWatch failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async pushWatchMatches(cloudWatchId: string, matches: CloudWatchMatch[]): Promise<CloudResult<{ inserted: number }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/watches/${encodeURIComponent(cloudWatchId)}/matches`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ matches }),
      });
    } catch (err) {
      console.error("[cloudClient] pushWatchMatches failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Clynx Cloud Phase 3 — Listing ingestion -----------------------------
  // listingIngestSync.ts is the only caller. Mirrors
  // cloud/src/listings/routes.ts exactly. Splits into batches of
  // INGEST_BATCH_SIZE internally so a caller can hand this an arbitrarily
  // large array without building one huge request body — each batch is its
  // own request/response, never throws, and a failed batch just means those
  // listings stay unsynced (store.ts's cloud_synced_at stays null) for the
  // next tick to retry.
  async ingestListings(listings: CloudListing[]): Promise<CloudResult<{ results: Array<CloudListingResult | null>; failures: Array<{ index: number; error: string }> }>[]> {
    const apiUrl = this.resolveApiUrl();
    const batches: CloudListing[][] = [];
    for (let i = 0; i < listings.length; i += INGEST_BATCH_SIZE) {
      batches.push(listings.slice(i, i + INGEST_BATCH_SIZE));
    }

    const results: CloudResult<{ results: Array<CloudListingResult | null>; failures: Array<{ index: number; error: string }> }>[] = [];
    for (const batch of batches) {
      if (!apiUrl) {
        results.push({ ok: false, error: "Cloud apiUrl not configured" });
        continue;
      }
      if (!this.accessToken) {
        results.push({ ok: false, error: "Not authenticated — no access token available yet" });
        continue;
      }
      try {
        results.push(
          await this.authedFetch(`${apiUrl}/listings/ingest`, {
            method: "POST",
            headers: this.authHeaders(),
            body: JSON.stringify({ listings: batch }),
          })
        );
      } catch (err) {
        console.error("[cloudClient] ingestListings failed:", err);
        results.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  // Phase 5's local-id -> cloud-canonical-id resolver. feedbackSync.ts is
  // the only caller — it needs a listing's cloud uuid before it can PUT
  // feedback for it, and this is the cheap read-only path to get one
  // without re-sending the whole listing payload through ingestListings.
  // A 404 (not yet ingested) surfaces as an ordinary !ok result — the
  // caller's cue to skip this listing's feedback for this cycle.
  async lookupListing(sourceListingId: string): Promise<CloudResult<{ id: string }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(
        `${apiUrl}/listings/lookup?source=${encodeURIComponent(LISTING_SOURCE)}&sourceListingId=${encodeURIComponent(sourceListingId)}`,
        { headers: this.authHeaders() }
      );
    } catch (err) {
      console.error("[cloudClient] lookupListing failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Clynx Cloud Phase 5 — Feed feedback sync ----------------------------
  // Mirrors cloud/src/feedback/routes.ts exactly. feedbackSync.ts is the
  // only caller; local SQLite (store.ts's `feedback` table) remains the
  // source of truth for the Feed UI throughout.

  // Batch 2 Fix D — `since` is a server-assigned integer revision cursor,
  // same as listWatches above.
  async listFeedback(since?: number): Promise<CloudResult<{ feedback: CloudFeedback[] }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      const qs = since ? `?since=${encodeURIComponent(String(since))}` : "";
      return await this.authedFetch(`${apiUrl}/feedback${qs}`, { headers: this.authHeaders() });
    } catch (err) {
      console.error("[cloudClient] listFeedback failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async upsertFeedback(
    cloudListingId: string,
    body: { verdict: FeedbackVerdict; note: string | null; createdAt: number; updatedAt: number }
  ): Promise<CloudResult<{ applied: boolean; feedback: CloudFeedback }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/feedback/${encodeURIComponent(cloudListingId)}`, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("[cloudClient] upsertFeedback failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteFeedback(cloudListingId: string): Promise<CloudResult> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/feedback/${encodeURIComponent(cloudListingId)}`, {
        method: "DELETE",
        headers: this.authHeaders(),
      });
    } catch (err) {
      console.error("[cloudClient] deleteFeedback failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Clynx Cloud Phase 6 — personal Database/Library sync ---------------
  // Mirrors cloud/src/products/routes.ts exactly. productSync.ts is the
  // only caller; local SQLite (store.ts's `products` table) remains the
  // source of truth for the Database/Library UI throughout.

  // Batch 2 Fix D — `since` is a server-assigned integer revision cursor,
  // same as listWatches above.
  async listProducts(since?: number): Promise<CloudResult<{ products: CloudProduct[] }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      const qs = since ? `?since=${encodeURIComponent(String(since))}` : "";
      return await this.authedFetch(`${apiUrl}/products${qs}`, { headers: this.authHeaders() });
    } catch (err) {
      console.error("[cloudClient] listProducts failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async upsertProduct(product: CloudProduct): Promise<CloudResult<{ applied: boolean; product: CloudProduct }>> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/products/${encodeURIComponent(product.localId)}`, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify(product),
      });
    } catch (err) {
      console.error("[cloudClient] upsertProduct failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteProduct(cloudProductId: string): Promise<CloudResult> {
    const apiUrl = this.resolveApiUrl();
    if (!apiUrl) return { ok: false, error: "Cloud apiUrl not configured" };
    if (!this.accessToken) return { ok: false, error: "Not authenticated — no access token available yet" };
    try {
      return await this.authedFetch(`${apiUrl}/products/${encodeURIComponent(cloudProductId)}`, {
        method: "DELETE",
        headers: this.authHeaders(),
      });
    } catch (err) {
      console.error("[cloudClient] deleteProduct failed:", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Multi-user login migration — interactive auth -----------------------
  // Replaces the old env-based bootstrapAuth entirely. login()/register()
  // are what index.ts's auth:login/auth:register IPC handlers call directly
  // with whatever the LoginScreen's Server URL/Email/Password fields hold;
  // restoreSession() is what a later app launch uses to silently re-log-in
  // from the persisted refresh token (see index.ts's auth:getSession),
  // without ever showing the LoginScreen again. All three are never-throw,
  // matching every other method on this class.

  async login(apiUrl: string, email: string, password: string): Promise<CloudResult<{ userId: string; email: string }>> {
    return this.authenticate(apiUrl, email, password, "/auth/login");
  }

  async register(apiUrl: string, email: string, password: string): Promise<CloudResult<{ userId: string; email: string }>> {
    return this.authenticate(apiUrl, email, password, "/auth/register");
  }

  private async authenticate(
    rawApiUrl: string,
    email: string,
    password: string,
    path: "/auth/login" | "/auth/register"
  ): Promise<CloudResult<{ userId: string; email: string }>> {
    try {
      const apiUrl = rawApiUrl.replace(/\/+$/, "");
      if (!apiUrl) return { ok: false, error: "Server URL is required" };

      const result = await safeFetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!result.ok || !result.data?.accessToken || !result.data?.refreshToken || !result.data?.userId) {
        return { ok: false, status: result.status, error: result.error ?? "Login failed" };
      }

      const userId: string = result.data.userId;
      this.accessToken = result.data.accessToken;
      this.refreshToken = result.data.refreshToken;
      this.userId = userId;
      this.email = email;
      this.sessionApiUrl = apiUrl;
      // A fresh login/register always mints a brand-new device registration
      // under THIS user's access token — reusing a deviceId left over from a
      // previously logged-in (possibly different) user on this same install
      // would try to register a device row under the wrong account.
      this.deviceId = null;
      this.persistSession();
      await this.ensureDeviceRegistered();
      this.startAuthRefreshTimer();
      return { ok: true, data: { userId, email } };
    } catch (err) {
      console.error(`[cloudClient] ${path} failed:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Silent relaunch re-auth — reads the persisted refresh token/userId/
  // email/apiUrl (all written by authenticate() above) and, if present,
  // rotates the refresh token to get a fresh access token without ever
  // prompting for a password again. index.ts calls this from auth:getSession
  // before deciding whether to show the LoginScreen.
  private restoreInFlight: Promise<{ ok: boolean; userId: string | null; email: string | null; apiUrl: string | null }> | null = null;
  restoreSession(): Promise<{ ok: boolean; userId: string | null; email: string | null; apiUrl: string | null }> {
    // Single-flight: the refresh token is single-use, so two overlapping
    // restores would make the second look like token reuse to the server.
    if (!this.restoreInFlight) {
      this.restoreInFlight = this.restoreSessionOnce().finally(() => {
        this.restoreInFlight = null;
      });
    }
    return this.restoreInFlight;
  }

  private async restoreSessionOnce(): Promise<{ ok: boolean; userId: string | null; email: string | null; apiUrl: string | null }> {
    try {
      const session = readSession(this.sessionPath);
      if (!session.refreshToken || !session.apiUrl || !session.userId) {
        return { ok: false, userId: null, email: null, apiUrl: session.apiUrl };
      }
      this.deviceId = session.deviceId;
      this.userId = session.userId;
      this.email = session.email;
      this.sessionApiUrl = session.apiUrl;

      // Per explicit instruction ("logging in each time is tedious") — a
      // network-level failure here (most commonly: the local cloud stack
      // hasn't finished starting yet, e.g. Docker Desktop was just launched
      // and the containers are still coming up) is a transient timing
      // problem, not evidence the session is bad. A few short retries gives
      // that normal startup race a real chance to resolve on its own before
      // falling back to the LoginScreen — verified live: Docker's containers
      // were consistently reachable again within a few seconds of the
      // daemon itself becoming ready.
      const RETRY_DELAYS_MS = [2000, 4000, 8000];
      let refreshed = await this.doRefresh(session.apiUrl, session.refreshToken);
      for (let attempt = 0; !refreshed.ok && refreshed.networkFailure && attempt < RETRY_DELAYS_MS.length; attempt++) {
        console.warn(`[cloudClient] restoreSession: cloud unreachable (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}), retrying:`, refreshed.error);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        refreshed = await this.doRefresh(session.apiUrl, session.refreshToken);
      }

      if (!refreshed.ok) {
        if (refreshed.networkFailure) {
          // Still unreachable after retrying — leave the persisted session
          // and this.userId/email untouched (don't log the user out over a
          // connectivity problem that isn't their session's fault); the next
          // restoreSession() call (a manual retry, or simply relaunching the
          // app once the cloud is actually up) can still succeed with this
          // exact same refresh token.
          console.warn("[cloudClient] restoreSession: cloud still unreachable, keeping session for a later retry:", refreshed.error);
          return { ok: false, userId: null, email: null, apiUrl: session.apiUrl };
        }
        // A real response came back and genuinely rejected this token
        // (expired, revoked, reused) — this session really is done.
        console.warn("[cloudClient] persisted refresh token rejected:", refreshed.error);
        this.userId = null;
        this.email = null;
        return { ok: false, userId: null, email: null, apiUrl: session.apiUrl };
      }
      await this.ensureDeviceRegistered();
      this.startAuthRefreshTimer();
      return { ok: true, userId: this.userId, email: this.email, apiUrl: this.sessionApiUrl };
    } catch (err) {
      console.error("[cloudClient] restoreSession failed:", err);
      return { ok: false, userId: null, email: null, apiUrl: null };
    }
  }

  // index.ts's auth:logout — clears everything this class holds, in memory
  // and on disk, so a later restoreSession() correctly reports "not
  // authenticated" and the LoginScreen shows again. Does NOT call
  // POST /auth/logout on the server (which would revoke the refresh token
  // server-side too) — deliberately: a locally-cleared session that turns
  // out to still be valid server-side is harmless (the next login just gets
  // a fresh one), where a network hiccup on logout silently failing to clear
  // the LOCAL session would leave the user stuck unable to log out at all.
  logout(): void {
    this.stopAuthRefresh();
    this.accessToken = null;
    this.refreshToken = null;
    this.deviceId = null;
    this.userId = null;
    this.email = null;
    this.sessionApiUrl = null;
    writeSession(this.sessionPath, { deviceId: null, refreshToken: null, userId: null, email: null, apiUrl: null });
  }

  private async doRefresh(apiUrl: string, refreshToken: string): Promise<{ ok: boolean; error?: string; networkFailure?: boolean }> {
    const result = await safeFetch(`${apiUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!result.ok || !result.data?.accessToken || !result.data?.refreshToken) {
      // Bug found live: "logging in each time is tedious" — root cause was
      // restoreSession below treating "couldn't reach the server at all"
      // (Docker/the cloud stack not started yet) identically to "the server
      // reached and genuinely rejected this refresh token" (actually
      // expired/revoked). safeFetch's own result only carries a `status`
      // field when a real HTTP response came back (see its !res.ok branch)
      // — it's undefined when safeFetch's catch fired, a real network-level
      // failure. That's the exact, reliable signal for "this session might
      // still be perfectly valid, we just couldn't check."
      return { ok: false, error: result.error ?? "Refresh failed", networkFailure: result.status === undefined };
    }
    this.accessToken = result.data.accessToken;
    // Rotation — the cloud issues a brand-new refresh token on every use
    // (see cloud/src/auth/service.ts's rotateRefreshToken) and the old one
    // is no longer valid, so the persisted copy must be replaced every time,
    // not just the access token.
    this.refreshToken = result.data.refreshToken;
    this.persistSession();
    return { ok: true };
  }

  private async ensureDeviceRegistered(): Promise<void> {
    if (this.deviceId) return;
    const result = await this.registerDevice(); // sets this.deviceId on success
    if (result.ok) {
      this.persistSession();
    } else if (result.error) {
      console.warn("[cloudClient] device registration failed:", result.error);
    }
  }

  private persistSession(): void {
    writeSession(this.sessionPath, {
      deviceId: this.deviceId,
      refreshToken: this.refreshToken,
      userId: this.userId,
      email: this.email,
      apiUrl: this.sessionApiUrl,
    });
  }

  // Proactive refresh — access tokens expire in ~15 minutes (see
  // cloud/src/auth/service.ts's issueAccessToken), so this re-issues one
  // well before that on a fixed timer rather than waiting for a request to
  // fail first. refreshingAuth guards against two overlapping calls (a slow
  // network response still in flight when the next tick fires).
  private startAuthRefreshTimer(): void {
    if (this.authRefreshTimer) return;
    this.authRefreshTimer = setInterval(() => {
      this.refreshAccessToken().catch((err) => {
        console.error("[cloudClient] periodic token refresh threw unexpectedly:", err);
      });
    }, CloudClient.AUTH_REFRESH_INTERVAL_MS);
  }

  // Stops the proactive refresh timer — called on app shutdown (see
  // index.ts's window-all-closed/before-quit handlers) alongside the other
  // cloud services' own stop(); harmless to call when never started.
  stopAuthRefresh(): void {
    if (this.authRefreshTimer) {
      clearInterval(this.authRefreshTimer);
      this.authRefreshTimer = null;
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.refreshingAuth) return;
    if (!this.refreshToken || !this.sessionApiUrl) return;
    this.refreshingAuth = true;
    try {
      const result = await this.doRefresh(this.sessionApiUrl, this.refreshToken);
      if (!result.ok) {
        // Leave the existing (soon-to-expire) accessToken in place rather
        // than clearing it — a still-valid token keeps working until it
        // actually expires, at which point a real request will 401 and
        // authedFetch's reactive fallback clears it, or this timer simply
        // succeeds on a later tick (e.g. the cloud was briefly down).
        console.warn("[cloudClient] periodic token refresh failed:", result.error);
      }
    } finally {
      this.refreshingAuth = false;
    }
  }
}

// Keeps a single POST /listings/ingest request body reasonably sized at
// real scan volume — see ingestListings above.
const INGEST_BATCH_SIZE = 50;
