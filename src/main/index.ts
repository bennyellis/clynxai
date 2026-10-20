import "dotenv/config";
import { parse as parseDotenv } from "dotenv";
import { makePhotoCheck } from "./compPhotoCheck.js";
import { app, BrowserWindow, ipcMain, safeStorage, session, shell, Menu, dialog, Notification, powerMonitor } from "electron";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { Store } from "./store.js";
import { colorsConflict, colorsIn } from "./colors.js";
import { ScrapeEngine } from "./scrapeEngine.js";
import { WatchScheduler } from "./watchScheduler.js";
import { EbayEngine } from "./ebayEngine.js";
import { hasEbayCredentials, searchEbayAspects, searchEbayItems, setEbayTransport } from "./ebayClient.js";
import { gatherCandidates, runQueueTick } from "./variantQueue.js";
import { fetchAddonPages } from "./addonPages.js";
import { THUMB_MAX_CHARS, THUMB_MAX_SIDE } from "./thinking.js";
import { addonEntryKey, addonFamilyPath, addonFromListing, sameAddonLoosely } from "./variantDiscovery.js";
import { OPENAI_MODEL, callOpenAI, hasOpenAIAccess, initOpenAIProxy, setApiSource } from "./openai.js";
import { isLowAiMode, registerLowAiModeSource } from "./aiMode.js";
import { writeFileAtomic, writeFileAtomicWithBackup } from "./safeFs.js";
import { normalizeServerUrl, resolveSavedServerUrl, testServer } from "./serverAddress.js";
import { Updater, type UpdateChannel, type UpdateMode } from "./updater.js";
import { isSafeForCommandLine, planInstallerLaunch } from "./installerLauncher.js";
import { SECRET_ENV_VARS, envKeyState, isProtectedValue, protectEnvText, readEnvSecrets, unprotectEnvText } from "./envKeys.js";
import { describeStartupFailure, type StartupProblem } from "./startupErrors.js";
import { NoticeBoard } from "./appNotices.js";
import { describeSessionProblem } from "./facebookSession.js";
import { sendSystemAlert, sendTestNotification } from "./notify.js";
import { describeTopicStrength, generateNtfyTopic } from "./ntfySetup.js";
import { openWithRecovery, quarantineDatabase, requestRecovery, runIntegrityCheckInBackground } from "./dbIntegrity.js";
import { applyPendingRestore, backupDirFor, createBackup, listBackups, requestRestore } from "./dbBackups.js";
import { loadConfig, saveConfig, takeConfigLoadNotice, DEFAULT_CONFIG, DEFAULT_BROWSE_URLS, DEFAULT_COUNTRY_CITIES } from "./config.js";
import {
  streamChat,
  type ChatTrace,
  ChatStopped,
  streamNarration,
  allowedToolNames,
  discoverSiblingProducts,
  discoverProductVariants,
  type ChatMessage,
  type ChatContext,
  type ChatAttachment,
  type NarrationContext,
  type ToolCall,
} from "./chat.js";
import { randomUUID } from "node:crypto";
import { lookupProduct, expandSearchKeywords } from "./products.js";
import { OPENAI_SEARCH_UNLIMITED } from "./openaiSearch.js";
import { downloadImageAsDataUri, makeThumbnail, shrinkImageDataUri, findBrandLogoImage, findGroupImage, findPoorConditionProductImage, findReferencePhotos, findFreeReferencePhotos, buildImageCollage, generateCategoryImage, lookUpOnWeb, webVerifyDeps, webHardDeps, configureOpenAiSearch, configureFreeEngines } from "./webResearch.js";
import { verifyVariant, reconcileVerdict, type VariantVerdict } from "./variantEvidence.js";
import { createVerdictMemory, makeClaimVerifier, publicHttpUrls } from "./variantResearch.js";
import { runResearchProductTool } from "./researchTool.js";
import { settleLateMarketCheck } from "./marketCheckSettle.js";
import { apiActivity } from "./apiActivity.js";
import { runApiSelfTest, type SelfTestDeps } from "./apiSelfTest.js";
import { describeSummary, emptySummary, listingContradictsEntry } from "./compIdentity.js";
import { distinguishingTokens, isMoreSpecific } from "./variantIdentity.js";
import {
  answerImageQuestion,
  reconsiderImageFeedback,
  analyzeReferencePhotoDifferences,
  auditReferencePhotoGallery,
} from "./vision.js";
import { lookupTopCitiesInState } from "./locationDiscovery.js";
import { analyzeEbayComps, deriveWatchCountQuery, type CompAnalysis } from "./watchcount.js";
import { specificResearchName } from "./identity/credibility.js";
import { createSafeguardLogger } from "./identity/safeguardLog.js";
import { IdentityReview } from "./identityReview.js";
import { fetchActiveAsks } from "./ebayActive.js";
import { resolveIdentityTarget } from "./productIdentity.js";
import { beta13Flags } from "./beta13.js";
import { runVariantFanout } from "./variantFanout.js";
import { friendlyPriceCheckFailure, friendlyResearchFailure, friendlySoldFailure, softSoldLookup, SOLD_LOOKUP_DEADLINE_MS } from "./researchFailure.js";
import { adoptOfficialName, planParentLinks } from "./variantLinking.js";
import { idsToQueueOnReset } from "./cloudDeletes.js";
import { addonKey, estimateAddonUplift, isNoiseAddon, type AddonRole, type AddonStatus } from "./addons.js";
import { makeThumb, noteDecision } from "./aiDecisionLog.js";
import { fileImage, setFilingRecorder, type FileImageEvidence } from "./fileImage.js";
import { createKnowledgeService, type KnowledgeService } from "./knowledgeService.js";
import { openAiKnowledgeAi } from "./knowledgeAi.js";
import { createVisualService, describeChallenge, describeIdentification, rememberLineup } from "./visualService.js";
import { identifyFromObservation } from "./identityResearch.js";
import { seedNintendoHandhelds } from "./knowledgeSeeds.js";
import { RESET_CONFIRM_WORD, freshConfig } from "./resetClynx.js";
import { challengeModelClaim } from "./claimChallenge.js";
import { openAiObserver, openAiThemeClassifier } from "./visualObserver.js";
import { createFolderArtService, listAutoFolders } from "./folderArtService.js";
import { autoFolderId, autoPath } from "./folderKeys.js";
import { DEFAULT_LIMITS, IMAGE_COST_ESTIMATE_USD, normalizeFolderImage, type ImageGenerator } from "./folderArt.js";
import { OPENAI_IMAGE_MODEL } from "./openai.js";
import { describeKnowledge } from "./productKnowledge.js";
import { describeEditionResearch } from "./editionResearch.js";
import { familyKey } from "./knowledgeRegistry.js";
import { selectReferenceImages } from "./referenceSelection.js";
import { confirmChoice, sanitizeAttachments, validateChoice, type ChatChoice } from "./chatSupport.js";
import { LibraryOps, TRASH_RETENTION_MS, folderPathList as folderPathsOf, toLibraryOp, type LibraryOp } from "./libraryOps.js";
import { buyerTotalUsd, estimateMarketValue } from "./marketValue.js";
import { compMatchesSpecs, modelLettersConflict, titleLooksLikeProduct } from "./compFilter.js";
import { focalProductName } from "./dealSummary.js";
import type { MarketCheck } from "./preAlert.js";
import { fetchMyStoreReference, parseSellerName } from "./myStore.js";
import { pushRecentSearch, removeRecentSearch } from "./recentSearches.js";
import { baseNameOfBrokenVariant, brokenVariantName, isBrokenVariantName } from "./brokenVariant.js";
import { clampMarginPercent, clampNetPercent } from "./resaleMath.js";
import { snapToFacebookRadius, snapToWatchInterval } from "./watchOptions.js";
import { timed, getMetricsSnapshot, resetMetrics, recordStage } from "./metrics.js";
import { runAddReferencePhotos, topUpReferencePhotos } from "./referencePhotos.js";
import { searchProducts } from "./chatIntent.js";
import { DiscoveryFeed, type DiscoverySource } from "./discovery.js";
import { breakDownListing, valueBundle, type BundleValuation, type PricedBundleItem } from "./bundleBreakdown.js";
import { setClientVersion, CloudClient, isBillingStatus } from "./cloudClient.js";
import { readBuildInfo } from "./buildInfo.js";
import { importLocalData, localDataExists } from "./localMigration.js";
import { checkBrowsers, CHROME_DOWNLOAD_URL } from "./browserCheck.js";
import { safeExternalUrl } from "./safeExternalUrl.js";
import { protectSecret, revealSecret, setSecretCodec } from "./secretStore.js";
import { externalLinkTarget, isAppUrl, isTrustedIpcSender } from "./windowSecurity.js";
import { WatchSyncService } from "./watchSync.js";
import { ListingIngestSyncService } from "./listingIngestSync.js";
import { FeedbackSyncService } from "./feedbackSync.js";
import { ProductSyncService } from "./productSync.js";
import type { Account, ActiveProductResearch, BillingActionResult, BillingStatus, CloudStatus, Config, EngineConfig, FeedbackVerdict, LogLine, OnboardingState, ProductProfile, ScrapeStatus, SearchItem, Watch, WatchPlatform, WatchTerm } from "./types.js";
import { rmSync } from "node:fs";
import os from "node:os";
import { buildSupportReport } from "./supportReport.js";
import { applicationMenuTemplate } from "./appMenu.js";
import { createDiagnosticsLog, createRecoveryLimiter } from "./diagnostics.js";

{
  const template = applicationMenuTemplate(process.platform, "Clynx");
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}

// Only one Clynx may run at a time. A second copy (double-clicking the exe
// again, or the dev build alongside the packaged one) would share this
// install's SQLite database, the same Facebook/eBay browser profiles, and —
// worst — the same single-use cloud refresh token: the second copy's login
// check made the server see the token being reused, which it treats as theft
// and answers by revoking every session ("Refresh token reuse detected; all
// sessions revoked"), logging the user out. The second launch now just
// brings the first window to the front and exits.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
// Writes down crashes of any Clynx process (and a previous run that ended unexpectedly) in <data folder>/logs/diagnostics.log.
const diagnostics = createDiagnosticsLog(path.join(app.getPath("userData"), "logs"));
const windowRecovery = createRecoveryLimiter(3, 10 * 60_000);
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

const baseDir = app.isPackaged ? app.getPath("userData") : app.getAppPath();
// Multi-user login migration — every one of these three used to be a fixed
// module-scope constant computed straight off baseDir. They're now `let`,
// pointed at a PER-USER subfolder (see configurePathsForUser below) the
// moment someone actually logs in — nothing reads them before that. The
// legacy flat-layout constants right below are what a real pre-multi-user
// install already has sitting at these old top-level locations; migrateLegacyDataIfNeeded
// copies (never moves/deletes) them into the first user who ever logs in on
// this install's own new per-user folder, so a real existing install's
// Facebook login/search history/etc. is never lost.
let CONFIG_PATH = path.join(baseDir, "config.json");
let PROFILES_ROOT = path.join(baseDir, "browser-profiles");
let DB_PATH = path.join(baseDir, "data", "scout.db");
const LEGACY_CONFIG_PATH = path.join(baseDir, "config.json");
const LEGACY_PROFILES_ROOT = path.join(baseDir, "browser-profiles");
const LEGACY_DB_PATH = path.join(baseDir, "data", "scout.db");
const DATA_ROOT = path.join(baseDir, "data");
const USERS_ROOT = path.join(DATA_ROOT, "users");
const ENV_PATH = path.join(baseDir, ".env");
// An installed copy keeps the user's own API keys in .env in its data folder (the line above); `dotenv/config` only looks in the working directory, which for an installed app
// is the install folder, so without this a key saved in Config would be forgotten at the next start. Variables that are already set are not overridden.
try {
  // (a variable that is set but empty counts as not set)
  // (a protected value is decrypted later, once the operating system key store is ready; see loadProtectedEnv)
  for (const [k, v] of Object.entries(parseDotenv(readFileSync(ENV_PATH, "utf-8")))) if (!process.env[k] && v && !isProtectedValue(v)) process.env[k] = v;
} catch {
  /* no .env yet: the tester has not saved a key */
}
// Batch 2 Fix A — see cloudClient.ts's readSession/writeSession. Same
// directory as .env/config.json, same "userData in a packaged build, app
// dir in dev" posture as everything else on baseDir. Deliberately install-
// level, not per-user — this is what lets a relaunch figure out WHICH user
// was logged in (see cloudClient.ts's restoreSession) before any per-user
// folder has even been picked.
const CLOUD_SESSION_PATH = path.join(baseDir, "cloud-session.json");
// Multi-user login migration — the cloud server URL has to be known BEFORE
// any user is logged in (it's the Server URL field the LoginScreen shows,
// pre-filled from here), so it lives in its own tiny install-level file
// rather than in any per-user config.json. Read synchronously at module
// load — same "cheap, local, never blocks startup" posture as config.json
// always had.
const APP_SETTINGS_PATH = path.join(baseDir, "app-settings.json");
// A distributed (installed) build has no localhost assumption: it starts at the server the build was made for, or empty so the person enters one. Only a development run starts at localhost.
const defaultCloudApiUrl = (): string => buildInfo.defaultServerUrl ?? (app.isPackaged ? "" : "http://localhost:8787");
interface AppSettings {
  cloudApiUrl: string;
  // Beta builds only: the tester chose "use Clynx on this computer only" (no Clynx Cloud account, nothing leaves the computer except the tester's own scans and API calls).
  localMode?: boolean;
  // Cloud accounts: where AI and eBay come from. "shared" = Clynx's company-managed service (no keys needed); "own" = keys saved on this computer. Unset: "own" when keys are
  // already saved here (nothing changes until the person chooses), otherwise "shared".
  aiSource?: "shared" | "own";
  // The person chose "Protect my saved keys": new keys are saved encrypted with the operating system's key store (see envKeys.ts). Off unless chosen.
  protectKeys?: boolean;
  // Automatic updates (cloud mode): "download" = fetch a verified update in the background and ask before installing; "notify" = only tell me; "off" = never check by itself.
  updateMode?: UpdateMode;
  updateChannel?: UpdateChannel;
}
function loadAppSettings(): AppSettings {
  try {
    if (!existsSync(APP_SETTINGS_PATH)) return { cloudApiUrl: defaultCloudApiUrl() };
    const raw = JSON.parse(readFileSync(APP_SETTINGS_PATH, "utf-8"));
    return { cloudApiUrl: resolveSavedServerUrl(raw?.cloudApiUrl, { packaged: app.isPackaged, buildDefault: buildInfo.defaultServerUrl, devDefault: "http://localhost:8787" }), localMode: raw?.localMode === true, aiSource: raw?.aiSource === "shared" || raw?.aiSource === "own" ? raw.aiSource : undefined, protectKeys: raw?.protectKeys === true, updateMode: raw?.updateMode === "off" || raw?.updateMode === "notify" || raw?.updateMode === "download" || raw?.updateMode === "automatic" ? raw.updateMode : undefined, updateChannel: raw?.updateChannel === "beta" || raw?.updateChannel === "stable" ? raw.updateChannel : undefined };
  } catch {
    return { cloudApiUrl: defaultCloudApiUrl() };
  }
}
// Which build this is, and whether it may offer the local beta mode (only builds made with `npm run dist:beta` can; see buildInfo.ts).
const buildInfo = readBuildInfo(app.getAppPath(), app.getVersion());
setClientVersion(buildInfo.version);
const LOCAL_USER_ID = "local-beta";
const isLocalMode = (): boolean => appSettings.localMode === true && buildInfo.localModeAllowed;
const hasSavedKeys = (): boolean => !!process.env.OPENAI_API_KEY?.trim() || !!(process.env.EBAY_CLIENT_ID?.trim() && process.env.EBAY_CLIENT_SECRET?.trim());
/** Which AI/eBay service this session uses: the tester's own keys (local mode), Clynx's shared service, or keys saved on this computer that the person has not yet moved off. */
function effectiveApiSource(): "local" | "shared" | "own" {
  if (isLocalMode()) return "local";
  if (appSettings.aiSource === "shared") return "shared";
  if (appSettings.aiSource === "own") return "own";
  // A signed-in account uses Clynx's shared AI and eBay by default: nobody should have to bring a key of their own, and keys that happen to be saved on this computer no longer switch it away
  // from the service (they are used only when the person deliberately chooses "my own keys").
  return "shared";
}
const offlineNotice = () => ({
  id: "cloud-offline",
  severity: "info" as const,
  title: "You're working offline",
  message: "Clynx can't reach your Clynx server right now, so it is using the data on this computer. Syncing and your plan are picked up again by themselves, within about 15 seconds of the server coming back.",
  action: "dismiss" as const,
  actionLabel: "Got it",
});
function saveAppSettings(settings: AppSettings): void {
  writeFileAtomicWithBackup(APP_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}
let appSettings: AppSettings = loadAppSettings();

// Without an OpenAI key (and no Clynx Cloud account to proxy through) listings are still collected but nothing can judge them. Say so once, in plain words, until a key is added.
function syncAiKeyNotice(): void {
  if (hasOpenAIAccess()) {
    notices.clear("no-ai-key");
    return;
  }
  notices.set({
    id: "no-ai-key",
    severity: "warning",
    title: "Add your OpenAI key so Clynx can judge listings",
    message: "Clynx finds listings without any key, but deciding which ones are deals uses OpenAI, and the beta does not include a key. Add your own in Config > Account > Your API keys (OpenAI bills you directly; a small amount lasts a long time because Clynx saves credits by default). Until then listings are collected but not judged.",
    action: "dismiss",
    actionLabel: "Got it",
  });
}

/** Keys saved in protected form are decrypted into the process environment here, after the key store is installed. An unreadable one (another computer or Windows account) is simply absent. */
function loadProtectedEnv(): void {
  try {
    const { values, unreadable } = readEnvSecrets(readFileSync(ENV_PATH, "utf-8"), revealSecret);
    for (const [k, v] of Object.entries(values)) if (!process.env[k]) process.env[k] = v;
    if (unreadable.length) console.error(`[keys] could not read ${unreadable.join(", ")} here (saved on another computer or account?): enter ${unreadable.length === 1 ? "it" : "them"} again in Config.`);
  } catch {
    /* no .env */
  }
}
const envCopies = (): string[] => {
  try {
    return readdirSync(baseDir).filter((f) => f === ".env.bak" || f.startsWith(".env.backup-"));
  } catch {
    return [];
  }
};

function saveEnvKey(varName: string, key: string): void {
  const trimmed = key.trim();
  let lines: string[] = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, "utf-8").split("\n").filter((l) => !l.startsWith(`${varName}=`));
  }
  const isSecretVar = (SECRET_ENV_VARS as readonly string[]).includes(varName);
  lines.push(`${varName}=${trimmed && isSecretVar && appSettings.protectKeys === true ? protectSecret(trimmed) : trimmed}`);
  writeFileAtomicWithBackup(ENV_PATH, lines.filter(Boolean).join("\n") + "\n", () => true);
  process.env[varName] = trimmed;
}

// Multi-user login migration — no implicit local user anymore: `config`
// starts out as a safe, inert default (never written to disk on its own)
// and only becomes a real, loaded-from-disk Config once bootstrapUserSession
// (see below) runs after a successful login. Every one of the ~120 IPC
// handlers further down this file still just reads/writes this same module
// `config` variable exactly as before — the only thing that changed is WHEN
// it first gets a real value.
let config: Config = { ...DEFAULT_CONFIG };
registerLowAiModeSource(() => config.lowAiMode !== false);

// Clynx Cloud Phase 1 — see cloudClient.ts. getConfig always reads the
// live `config` variable (reassigned throughout this file on save), not a
// stale snapshot from whenever the client was constructed. Constructed once,
// unconditionally, at true module scope — unlike everything else below,
// this ISN'T per-user: it's what index.ts uses to authenticate a user in
// the first place (see the auth:login/auth:register/auth:getSession/
// auth:logout handlers), so it has to exist before any user is known.
const cloudClient = new CloudClient(() => config, CLOUD_SESSION_PATH);
// Clynx Cloud — shared-key migration. See openai.ts's own doc comment: this
// is what lets every OpenAI call site in the app (chat.ts, vision.ts,
// scorer.ts, ...) fall back to proxying through Clynx Cloud's /ai routes
// when no local OPENAI_API_KEY is configured, instead of each needing its
// own key on this machine.
initOpenAIProxy(cloudClient);
setApiSource(() => (effectiveApiSource() === "shared" ? "shared" : "own"));
setEbayTransport({ enabled: () => effectiveApiSource() === "shared" && cloudClient.isAuthenticated(), get: (path, params) => cloudClient.ebayRead(path, params) });

// Multi-user login migration — store and all 4 background sync services
// used to be constructed once, unconditionally, at module scope. They're
// now per-user: `store` opens a DIFFERENT user's own scout.db depending on
// who's logged in, and the sync services hold a direct reference to
// whichever `store` was current when THEY were constructed (see
// WatchSyncService et al.'s own constructors) — so all 5 have to be
// (re)created together, inside bootstrapUserSession, every time a user logs
// in. Declared here with definite-assignment (`!`) rather than
// `| undefined` so none of the ~120 existing handlers further down this
// file that already read `store.xxx(...)` directly need to change — they're
// only ever invoked once the renderer is past the LoginScreen, by which
// point bootstrapUserSession has always already run.
let store!: Store;
let watchSyncService!: WatchSyncService;
let listingIngestSyncService!: ListingIngestSyncService;
let feedbackSyncService!: FeedbackSyncService;
let productSyncService!: ProductSyncService;
// Guards the shutdown paths (stopUserSession, window-all-closed/before-quit,
// auth:logout) against running before any user has ever actually logged in
// (e.g. the app is closed straight from the LoginScreen) — store/the sync
// services/watchScheduler above are only ever actually constructed once this
// is true.
let hasActiveUserSession = false;
// Set at the end of a successful bootstrapUserSession; read by auth:getSession
// once already-bootstrapped, and used to scope this install's per-user data
// folders (see configurePathsForUser).
let currentUserId: string | null = null;
let cloudHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

let mainWindow: BrowserWindow | null = null;

// Bug fix (verified live crash: "TypeError: Object has been destroyed" at
// a mainWindow?.webContents.send call, which killed the ENTIRE main
// process — Node has no more handlers left once an exception is thrown
// from INSIDE the process-level uncaughtException/unhandledRejection
// handlers below, which is exactly what happened: one ordinary send threw
// this, got caught by uncaughtException, whose own error-reporting line
// was the SAME unsafe pattern and threw the SAME error again, this time
// with nothing left to catch it). `mainWindow?.` only guards against
// null/undefined — a BrowserWindow that's been closed is neither; it's a
// non-null reference to a destroyed native object, and touching
// .webContents on one throws synchronously. Every renderer-bound push in
// this file goes through this instead of calling send directly, so a
// closed/closing window (a real possibility any time a fire-and-forget
// background task — product research, a scan cycle — finishes after the
// user has already closed the app) degrades to "that update just doesn't
// go anywhere" instead of taking the whole process down with it.
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// Per explicit instruction — closing the window with unsaved Config edits
// needs a real chance to save first, not just quietly discard them. The
// renderer (Config.tsx) is the only place that actually knows whether
// there's anything unsaved, so the window's own close is intercepted and
// handed off to it (see the "close" listener in createWindow below) rather
// than decided here; this flag is what lets a close the renderer already
// confirmed (see app:confirmClose) actually go through on the second try
// instead of intercepting itself forever.
let allowClose = false;

// Small ring buffer so the chat assistant has recent activity as context
// without re-querying the DB or replaying the full session log.
const recentLogs: LogLine[] = [];
function recordLog(line: LogLine) {
  recentLogs.push(line);
  if (recentLogs.length > 200) recentLogs.shift();
}

// Problems the user has to know about and can act on (damaged settings or database, expired Facebook login, a scan that keeps
// failing). They stay on the Dashboard until fixed or dismissed; see appNotices.ts.
const notices = new NoticeBoard((list) => sendToRenderer("notices:updated", list));

// Per explicit instruction — multiple Facebook accounts scanning
// concurrently, one ScrapeEngine per account (see createEngineForAccount
// below), keyed by Account.id. Populated once at startup and kept in sync
// with config.accounts by syncEnginesWithAccounts (accounts:add/remove).
const engines = new Map<string, ScrapeEngine>();
// Per-account restart bookkeeping — was two module-level booleans when
// there was only ever one engine; now keyed by account id so restarting
// one account's engine (a location change) never touches another's.
const restartGuards = new Map<string, { inFlight: boolean; queued: boolean }>();

function ensureEngineFor(accountId: string): ScrapeEngine {
  const existing = engines.get(accountId);
  if (existing) return existing;
  const created = createEngineForAccount(accountId);
  engines.set(accountId, created);
  return created;
}

// Shared/cross-account concerns (WatchCount/eBay comps research — see
// runProductLookup and fetchAndStoreEbayComps) need SOME one browser
// context to open a tab in, but aren't really "about" any particular
// account. Confirmed with the user: accounts differ only by location/
// login, so there's no principled way to pick one over another — this
// just always uses the first configured account, matching exactly how a
// single-account setup already behaves (there's only ever one to pick).
function getPrimaryEngine(): ScrapeEngine {
  return ensureEngineFor(config.accounts[0].id);
}

// Per explicit instruction — an immediate one-off search (Database's "Search
// now" button, Dashboard's "Search for Products" box) fans out across every
// account that's currently actually usable (a real browser session already
// open — logged in or at least started), rather than picking just one.
// Accounts that aren't running/logged in yet are silently skipped — nothing
// to search from there.
function searchForItemOnActiveAccounts(item: SearchItem): void {
  for (const account of config.accounts) {
    const eng = engines.get(account.id);
    if (eng?.hasOpenBrowser()) eng.searchForItemNow(item).catch(() => {});
  }
}

// Per explicit instruction — "when the user changes something in the
// filters or adds a new product to search for, stop the scan and restart
// it. this can prevent bugs." scrapeEngine.ts already re-fetches config
// fresh at several points mid-cycle (see runCycle's own getConfig() calls)
// so a change usually takes effect within moments anyway — but a full
// stop-then-start guarantees a completely clean cycle (fresh browser
// navigation, no lingering in-flight assumptions from before the change),
// which is a stronger guarantee against staleness than the surgical
// approach alone. Deliberately does NOTHING if that account's scanner
// isn't currently running — a filter/search-item change shouldn't start it
// on its own, that's still a separate, deliberate action (see
// add_search_item below, which already does its own explicit
// start-if-idle and calls this only for the "was already running" case).
function restartEngineIfRunning(accountId: string, reason: string): void {
  const eng = engines.get(accountId);
  if (!eng || !eng.getStatus().running) return;
  let guard = restartGuards.get(accountId);
  if (!guard) {
    guard = { inFlight: false, queued: false };
    restartGuards.set(accountId, guard);
  }
  if (guard.inFlight) {
    // Another restart for this SAME account (e.g. for an earlier item in
    // the same "Search for Products" batch) is already tearing down/
    // relaunching its browser — queue one more pass after it finishes
    // instead of racing a second stop() against the same in-flight
    // context close. The queued pass still picks up whatever the LATEST
    // config is by the time it runs (start()/getConfig() always reads
    // current state), so nothing from this request is lost, it just
    // doesn't get its own separate restart cycle.
    guard.queued = true;
    return;
  }
  guard.inFlight = true;
  (async () => {
    do {
      guard!.queued = false;
      const line: LogLine = { ts: Date.now(), level: "info", message: `Restarting the scanner to apply ${reason}...` };
      recordLog(line);
      sendToRenderer("engine:log", line);
      await eng.stop();
      // A saved location that has not been looked up on Facebook yet (a location change is exactly that) is resolved BEFORE the restart, the same
      // as a manual Start (engine:start). Restarting without it scanned the previous, stale list of places while saying it applied the new setting.
      const needsLookup = !!config.accounts.find((a) => a.id === accountId && !a.locationResolved);
      if (needsLookup) eng.beginStarting("Looking up your location on Facebook...");
      const resolved = await resolveAccountLocationIfNeeded(accountId);
      if (needsLookup && eng.stopWasRequested) continue;
      if (resolved.message) {
        const resolvedLine: LogLine = { ts: Date.now(), level: resolved.ok ? "info" : "error", message: resolved.message };
        recordLog(resolvedLine);
        sendToRenderer("engine:log", resolvedLine);
      }
      if (!resolved.ok) {
        eng.cancelStarting();
        continue;
      }
      eng.start();
    } while (guard!.queued);
  })()
    .catch((err) => console.error(`[engine-restart] failed to restart account ${accountId} after ${reason}: ${(err as Error).message}`))
    .finally(() => {
      guard!.inFlight = false;
    });
}

// A SHARED-field change (Search For list, price filters, deal threshold,
// etc. — anything NOT specific to one account's own location) restarts
// EVERY currently-running account's engine, same semantics as the old
// single-engine restart just fanned out across however many accounts are
// configured.
function restartAllEnginesIfRunning(reason: string): void {
  for (const account of config.accounts) restartEngineIfRunning(account.id, reason);
}

// Per explicit instruction ("the scanner doesn't stop randomly") — without
// this, an unhandled promise rejection ANYWHERE in the app (a stray missing
// .catch on some fire-and-forget call, a Playwright hiccup, anything) is
// fatal by default in Node: it silently kills the ENTIRE Electron main
// process, taking the scan loop, the window, everything down with it, with
// no error ever logged anywhere the user could see. That's a much more
// likely explanation for "it just stops" than any single bug in the scan
// loop itself (which already wraps every cycle in its own try/catch — see
// scrapeEngine.ts's loop()) — this is the app-wide safety net that was
// simply missing. Logs and keeps running instead of crashing; an
// uncaughtException is a narrower, more serious case (a genuinely corrupted
// state), but still better surfaced than a silent, total process death.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  diagnostics.record("unhandled-rejection", { error: reason instanceof Error ? reason : message });
  const line: LogLine = { ts: Date.now(), level: "error", message: `Unhandled error (recovered, scanner should keep running): ${message}` };
  recordLog(line);
  sendToRenderer("engine:log", line);
});
process.on("uncaughtException", (err) => {
  diagnostics.record("uncaught-exception", { error: err });
  const line: LogLine = { ts: Date.now(), level: "error", message: `Unexpected error (recovered, scanner should keep running): ${err.message}` };
  recordLog(line);
  sendToRenderer("engine:log", line);
});

// Full admin access from the Dashboard chat — change any setting, manage
// the Search For list, start/stop the scanner, and clear the feed. The
// Database chat is a genuinely separate assistant with its own, much
// smaller tool set (see chat.ts's allowedToolNames) — this check is the
// server-side half of that wall: even if a model somehow emitted a tool
// call outside what it was offered, it still couldn't execute here. The
// only thing neither chat can touch is the OpenAI API key, which lives in
// a plaintext .env file outside config entirely.
// Turns searchForItemNow's result into the follow-up line that replaces the
// "Searching..." bubble once the real search actually finishes.
function describeSearchOutcome(item: string, result: { evaluated: number; error?: string }): string {
  if (result.error === "Not logged into Facebook.") {
    return `Couldn't search for "${item}" — you're not logged into Facebook yet. Log in from the Dashboard and I'll pick it back up next cycle.`;
  }
  if (result.error === "No browse location configured.") {
    return `Couldn't search for "${item}" — no browse location is set up yet. Add one in Config and I'll pick it back up next cycle.`;
  }
  if (result.error) {
    return `Search for "${item}" ran into an error partway through (${result.error}), but it'll keep coming up in the regular rotation.`;
  }
  if (result.evaluated === 0) {
    return `Checked Marketplace for "${item}" — nothing matched yet, but it'll keep coming up in the regular rotation too.`;
  }
  return `Found and checked ${result.evaluated} listing${result.evaluated === 1 ? "" : "s"} for "${item}" — see the feed below.`;
}

// Per explicit instruction — multiple Facebook accounts: this sets ONE
// account's location (accountId), not the whole app's — every caller
// writes into that one entry in config.accounts instead of the old flat
// Config fields, and only restarts/discovers via THAT account's own
// engine. Top-level (not nested in app.whenReady) so both the IPC handler
// below and executeChatTool's start_scanner branch (a plain module-level
// function, defined below) can reach it.
function updateAccountLocation(accountId: string, patch: Partial<Account>): void {
  config = { ...config, accounts: config.accounts.map((a) => (a.id === accountId ? { ...a, ...patch } : a)) };
  saveConfig(CONFIG_PATH, config);
  sendToRenderer("config:updated", config);
  restartEngineIfRunning(accountId, "your location settings");
}

// Per explicit instruction — the actual browser work that used to run
// synchronously inside location:setMode (look up the state's primary city,
// drive Facebook's "Change location" dialog, resolve a real browseUrl) is
// now deferred to whenever this account's engine is about to start (see the
// engine:start handler and executeChatTool's start_scanner branch below,
// the only two ways an engine actually starts). A no-op the moment
// locationResolved is already true — the common case on every start after
// the first one following a location change — so this doesn't add delay to
// a normal Start once the location is settled. Top-level for the same
// reason as updateAccountLocation above.
async function resolveAccountLocationIfNeeded(accountId: string): Promise<{ ok: boolean; message: string | null }> {
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account || account.locationResolved) return { ok: true, message: null };

  const eng = ensureEngineFor(accountId);

  if (account.locationMode === "city") {
    const cityOrZip = (account.selectedCityOrZip ?? "").trim();
    if (!cityOrZip) return { ok: false, message: "No city/ZIP saved for this account." };
    // Per explicit instruction — a specific city/ZIP search should only
    // ever cover 20 miles around that exact spot, set live in the SAME
    // "Change location" dialog visit (and the same Apply click) that
    // resolves the location itself, not left to drift until the next scan
    // cycle's own verifyOrSetRadius check corrects it.
    const CITY_MODE_RADIUS_MILES = 20;
    const [result] = await eng.discoverLocations([cityOrZip], CITY_MODE_RADIUS_MILES);
    if (!result.url) {
      return {
        ok: false,
        message: `Couldn't find "${cityOrZip}" on Facebook Marketplace (${result.error ?? "no matching suggestion"}) — try typing it exactly as you would into Facebook's own location search, e.g. "Sacramento, California" (full state name, not an abbreviation). Check Config to fix it.`,
      };
    }
    // Per explicit instruction — a specific city/ZIP search should also
    // skip any listing that resolves to a different state entirely (a
    // wide-enough radius near a state line can still pull in out-of-state
    // listings). A ZIP code alone doesn't say what state it's in, so this
    // trusts Facebook's OWN confirmation of the location it actually
    // applied (see scraper.ts's changeLocation), not the raw text the user
    // typed in.
    updateAccountLocation(accountId, {
      selectedState: result.resolvedState,
      searchRadiusMiles: CITY_MODE_RADIUS_MILES,
      browseUrls: [result.url],
      locationResolved: true,
    });
    return { ok: true, message: `Resolved location: now searching only ${cityOrZip}, within ${CITY_MODE_RADIUS_MILES} miles.` };
  }

  if (account.locationMode === "state") {
    const state = (account.selectedState ?? "").trim();
    if (!state) return { ok: false, message: "No state saved for this account." };
    // Per explicit instruction — "make sure when in a state... the search
    // algorithm follows the same path [as country mode]... it rotates the
    // top 10 cities": resolves the state's top cities (not just one), so
    // runCycle's existing random-pick-and-rotate logic (see scrapeEngine.ts
    // — it already works for ANY browseUrls.length, nationwide or not) has
    // real redundancy within the state instead of a single point of
    // failure. Individual cities that fail to resolve are just left out —
    // ScrapeEngine.discoverLocations already logs each one's success/
    // failure to Activity as it goes — only a TOTAL failure (zero resolved)
    // is treated as an error here.
    const STATE_MODE_RADIUS_MILES = 40;
    const STATE_MODE_CITY_COUNT = 10;
    let cities: string[];
    try {
      cities = await lookupTopCitiesInState(state, STATE_MODE_CITY_COUNT);
    } catch (err) {
      return { ok: false, message: `Couldn't look up cities for ${state}: ${(err as Error).message}. Check Config to retry.` };
    }
    const results = await eng.discoverLocations(cities, STATE_MODE_RADIUS_MILES);
    const browseUrls = results.flatMap((r) => (r.url ? [r.url] : []));
    if (!browseUrls.length) {
      return {
        ok: false,
        message: `Looked up ${cities.length} ${state} cit${cities.length === 1 ? "y" : "ies"} but couldn't resolve any of them on Facebook Marketplace — check Activity for details, or Config to retry.`,
      };
    }
    updateAccountLocation(accountId, {
      searchRadiusMiles: STATE_MODE_RADIUS_MILES,
      browseUrls,
      locationResolved: true,
    });
    return {
      ok: true,
      message: `Resolved location: now rotating ${browseUrls.length}/${cities.length} ${state} cities, within ${STATE_MODE_RADIUS_MILES} miles — anything found outside ${state} is skipped.`,
    };
  }

  // Root-caused live with 4 concurrent accounts: "country" mode used to be
  // locationResolved: true unconditionally (see DEFAULT_CONFIG/loadConfig's
  // OLD comments) and just navigated straight to a static list of GUESSED
  // city-slug URLs (config.ts's DEFAULT_BROWSE_URLS), never actually
  // confirmed against Facebook's own "Change location" dialog the way
  // state/city mode above already were. Every evaluated listing across all
  // 4 accounts was clustering near Richmond, VA regardless of which of the
  // 48 "rotated" URLs was current — Facebook was silently falling back to
  // each account's own default location for slugs it didn't actually honor,
  // exactly the failure mode DEFAULT_BROWSE_URLS's own comment predicted.
  // This now resolves the SAME nationwide spread through the SAME
  // dialog-driven, Facebook-CONFIRMED mechanism state mode already used
  // above — real URLs captured from page.url() after Facebook itself
  // applied the change, not guesses.
  // Per explicit instruction — "for whole country, change the search
  // radius from 100 miles to 500 miles." Facebook's own radius dropdown
  // may or may not actually offer a 500-mile preset (never verified live)
  // — setRadiusInDialog already degrades gracefully if it can't find/select
  // an exact match (logs a warning via onFallback and leaves whatever
  // radius was already set, rather than failing the whole search), so
  // nothing breaks either way; check Activity after restarting to confirm
  // it actually took.
  const COUNTRY_MODE_RADIUS_MILES = 500;
  // Root-caused live: "why does it need to keep searching for [locations],
  // it's already there" — a 48-city pass, paced to stay under Facebook's
  // own throttling, is a genuine 12-15 minute one-time cost, and closing
  // the app (or losing the account mid-run for any other reason) used to
  // throw ALL of that away — browseUrls/locationResolved only ever got
  // written once, after the full 48 cities had been attempted. See
  // Account.countryCityProgress's own doc comment: every city's outcome
  // now persists the moment it happens (via the onEachResult callback
  // below), and only cities missing here or previously null (failed, worth
  // another try) get attempted at all — a genuinely already-resolved city
  // is never re-driven through the dialog again.
  const priorProgress = account.countryCityProgress ?? {};
  const citiesToTry = DEFAULT_COUNTRY_CITIES.filter((city) => !priorProgress[city]);
  const progress: Record<string, string | null> = { ...priorProgress };
  if (citiesToTry.length) {
    await eng.discoverLocations(citiesToTry, COUNTRY_MODE_RADIUS_MILES, (result) => {
      progress[result.city] = result.url;
      // Persisted directly (not via updateAccountLocation) so this doesn't
      // also broadcast config:updated / attempt a restart on every single
      // one of up to 48 results — those only matter once, at the very end,
      // once there's an actual browseUrls list worth announcing.
      config = { ...config, accounts: config.accounts.map((a) => (a.id === accountId ? { ...a, countryCityProgress: { ...progress } } : a)) };
      saveConfig(CONFIG_PATH, config);
    });
  }
  const countryBrowseUrls = DEFAULT_COUNTRY_CITIES.flatMap((city) => (progress[city] ? [progress[city] as string] : []));
  if (!countryBrowseUrls.length) {
    return {
      ok: false,
      message: `Tried to resolve ${DEFAULT_COUNTRY_CITIES.length} nationwide cities but couldn't confirm any of them on Facebook Marketplace — check Activity for details, or Config to retry.`,
    };
  }
  updateAccountLocation(accountId, {
    searchRadiusMiles: COUNTRY_MODE_RADIUS_MILES,
    browseUrls: countryBrowseUrls,
    locationResolved: true,
    countryCityProgress: progress,
  });
  return {
    ok: true,
    message: `Resolved location: now rotating ${countryBrowseUrls.length}/${DEFAULT_COUNTRY_CITIES.length} nationwide cities, within ${COUNTRY_MODE_RADIUS_MILES} miles.`,
  };
}

// A Watch's minimum eBay seller rating, as typed by the user or produced by
// the chat model: a percentage from 0 to 100, or null for "no requirement".
// Anything else (empty, NaN, out of range) is treated as no requirement
// rather than guessed at.
// Tells the user a Watch found something: a Windows notification (the phone push, if a
// topic is set, is sent separately by the engine). Clicking it brings the app to the front
// on Feed, where the listing now is.
function notifyWatchMatch(watch: Watch, info: { listingId: string }): void {
  // A Watch with its own ntfy topic is run for somebody else: its finds go to that topic only, no desktop ping here.
  if (watch.ntfyTopic?.trim()) return;
  if (config.desktopNotifications === false || !Notification.isSupported()) return;
  const record = store.getById(info.listingId);
  if (!record) return;
  const where = record.locationText ? ` · ${record.locationText}` : "";
  const price = record.price !== null ? ` — $${record.price}` : "";
  const notification = new Notification({
    title: `${record.justListed ? "Just listed" : "New"}: Watch "${watch.name}" found something`,
    body: `${record.title}${price}${where}`,
  });
  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    sendToRenderer("app:navigate", "feed");
  });
  notification.show();
}

// Older listings stored a whole-size photo (150-200 KB as base64) as their first image. Feed
// fetches every listing on each refresh, so those were megabytes of avoidable IPC, memory and
// decoding. A few at a time, shortly after login (so it never delays start-up), each is
// replaced by a card-sized copy; listings that are already small are never touched, so this is
// a no-op once it has run.
function scheduleListingPhotoShrink(forStore: Store): void {
  const BATCH = 6;
  let changed = 0;
  const step = async (): Promise<void> => {
    if (store !== forStore) return; // a different user signed in meanwhile
    const batch = forStore.listHeavyListingPhotos(BATCH);
    if (!batch.length) {
      if (changed) sendToRenderer("listings:refresh");
      return;
    }
    let progressed = false;
    for (const row of batch) {
      const next = await Promise.all(row.imageUrls.map((u) => (u.startsWith("data:image") ? shrinkImageDataUri(u) : u)));
      if (next.some((u, i) => u !== row.imageUrls[i])) {
        forStore.setListingImageUrls(row.id, next);
        changed++;
        progressed = true;
      }
    }
    // Rows that can't be made smaller would be returned forever; stop rather than loop.
    if (!progressed) return;
    setTimeout(() => void step().catch(() => {}), 400);
  };
  setTimeout(() => void step().catch(() => {}), 20_000);
}

// A Watch that was just created should start watching. "Pause All" would otherwise
// hold it back silently, so creating one turns that off.
function startWatching(): void {
  if (!config.watch.globallyPaused) return;
  config = { ...config, watch: { ...config.watch, globallyPaused: false } };
  saveConfig(CONFIG_PATH, config);
  sendToRenderer("config:updated", config);
}

function sanitizeSellerRating(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function locationModeOrCity(src: { locationMode?: "country" | "state" | "city" }): "country" | "state" | "city" {
  return src.locationMode ?? "city";
}

const MAX_WATCH_TERMS = 20;

// What a Watch is told to look for, as typed in the form (no keywords yet): the
// trimmed, non-empty, de-duplicated phrases, the first MAX_WATCH_TERMS of them.
function cleanTermInputs(inputs: Array<{ phrase: string; linkedProductId?: string | null }>): Array<{ phrase: string; linkedProductId: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ phrase: string; linkedProductId: string | null }> = [];
  for (const input of inputs) {
    const phrase = String(input.phrase ?? "").trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    out.push({ phrase, linkedProductId: input.linkedProductId ?? null });
    if (out.length >= MAX_WATCH_TERMS) break;
  }
  return out;
}

// Turns the form's terms into stored ones by working out each one's match keywords.
// A phrase the Watch already had keeps the keywords it has (no new AI call).
async function buildWatchTerms(inputs: Array<{ phrase: string; linkedProductId?: string | null }>, existing: WatchTerm[] = []): Promise<WatchTerm[]> {
  const known = new Map(existing.map((t) => [t.phrase.toLowerCase(), t]));
  return Promise.all(
    cleanTermInputs(inputs).map(async (t) => {
      const prior = known.get(t.phrase.toLowerCase());
      return { phrase: t.phrase, linkedProductId: t.linkedProductId, matchKeywords: prior ? prior.matchKeywords : await expandSearchKeywords(t.phrase) };
    })
  );
}

// Only ids of accounts that exist; an empty list means "any account".
function cleanAccountIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const real = new Set(config.accounts.map((a) => a.id));
  return [...new Set(ids.map(String))].filter((id) => real.has(id));
}

// Location fields a new/edited Watch is stored with. Only Facebook Watches
// search a place; an eBay Watch searches the whole marketplace, so it's
// stored as "country" with no place or radius (the columns are NOT NULL on
// location_mode, and "country" is the inert value everything else already
// treats as "nowhere in particular").
function watchLocationFor(
  platform: WatchPlatform,
  src: { locationMode?: "country" | "state" | "city"; selectedState?: string | null; selectedCityOrZip?: string | null; searchRadiusMiles?: number | null }
): { locationMode: "country" | "state" | "city"; selectedState: string | null; selectedCityOrZip: string | null; searchRadiusMiles: number | null } {
  if (platform === "ebay") return { locationMode: "country", selectedState: null, selectedCityOrZip: null, searchRadiusMiles: null };
  return {
    locationMode: src.locationMode ?? "city",
    selectedState: src.selectedState ?? null,
    selectedCityOrZip: src.selectedCityOrZip ?? null,
    // Only the radii Facebook's location dialog offers; anything else snaps to the nearest.
    searchRadiusMiles: locationModeOrCity(src) === "city" ? snapToFacebookRadius(src.searchRadiusMiles) : null,
  };
}

// Same case-insensitive-exact-then-substring leniency remove_search_item's
// plain string match doesn't bother with (Search For items are usually
// referred to verbatim) — a Watch's name is user-chosen free text, so "the
// xbox one" should still find a Watch actually named "Xbox Series X".
function findWatchByName(name: string): Watch | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  const all = store.listWatches();
  // Bidirectional substring check — found during review: a plain
  // w.name.includes(target) alone misses the (plausible) case where the
  // model refers to a short-named watch ("Xbox") by a longer, more
  // elaborate phrase ("the Xbox Series X watch") than what's actually
  // stored, since target is then LONGER than the name it should match.
  return (
    all.find((w) => w.name.toLowerCase() === target) ??
    all.find((w) => w.name.toLowerCase().includes(target) || target.includes(w.name.toLowerCase())) ??
    null
  );
}

// onSearchUpdate lets add_search_item report back a second time, after its
// fire-and-forget searchForItemNow actually finishes — the tool's own
// return value only covers the instant confirmation ("Searching..."), which
// used to be the last the user ever heard about it. currentProductId is
// only set (and only meaningful) for a "product"-context call — it's what
// add_product_watch_note attaches its note to, since that tool only makes
// sense scoped to whichever product page the conversation is happening on.
// Beta 13: questions with buttons. A pending choice remembers what to do if the person confirms (the token that authorises a Library operation lives HERE, never in text the
// model can read), and forgets after ten minutes.
const pendingChoices = new Map<string, { run?: () => { ok: boolean; summary: string; error?: string }; expires: number }>();
function rememberChoice(id: string, run?: () => { ok: boolean; summary: string; error?: string }) {
  for (const [k, v] of pendingChoices) if (v.expires < Date.now()) pendingChoices.delete(k);
  pendingChoices.set(id, { run, expires: Date.now() + 10 * 60_000 });
}

async function executeChatTool(
  call: ToolCall,
  context: ChatContext,
  onSearchUpdate?: (message: string) => void,
  currentProductId?: string,
  emit?: { choice: (c: ChatChoice) => void }
): Promise<string> {
  if (!allowedToolNames(context).has(call.name)) {
    return `Failed: "${call.name}" isn't available from this chat.`;
  }
  if (call.name === "ask_choice") {
    const v = validateChoice(call.args, () => randomUUID());
    if (!v.ok) return `Failed: ${v.error}`;
    if (!emit) return "Failed: this chat cannot show buttons; ask in plain words instead.";
    rememberChoice(v.choice.id);
    emit.choice(v.choice);
    return "Presented the choices to the user as buttons. Stop here: write nothing more and call no other tools; their pick arrives as their next message.";
  }
  if (call.name === "library_list") {
    if (String(call.args.what ?? "folders") === "trash") {
      const t = store.listTrash();
      return JSON.stringify({ products: t.products.slice(0, 30), folders: t.folders.slice(0, 30), photos: t.images.length });
    }
    if (String(call.args.what ?? "folders") === "history") return JSON.stringify(libraryOps().recent(10).filter((o) => !o.undone));
    if (String(call.args.what ?? "folders") === "autoFolders") {
      // Clynx's own automatic folders, with the label a person may have given them: the key is the path to pass to the folder operations
      const meta = new Map(store.listFolderMeta().map((m) => [m.id, m]));
      return JSON.stringify(
        listAutoFolders(store.listAutoFolderPlacements()).map((f) => {
          const id = autoFolderId(f.category, f.segments);
          return { key: autoPath(f.category, f.segments), label: meta.get(id)?.displayName ?? f.segments[f.segments.length - 1], picture: meta.get(id)?.thumbSource ?? "none" };
        })
      );
    }
    return JSON.stringify(folderPathsOf(store.listFolders()));
  }
  if (call.name === "library_op" && String(call.args.op ?? "") === "generateFolderThumbnail") {
    // a person asked in chat for a new picture: same service and limits as the button; the result is reported as it really was
    const key = String(call.args.key ?? "").trim();
    if (!key) return "Failed: generateFolderThumbnail needs the folder path (key).";
    const r = await folderArt().generate(key, true);
    return r.ok ? `Done: ${r.message} It is decorative artwork and is kept until the user changes it.` : `Failed: ${r.message}`;
  }
  if (call.name === "library_op") {
    const op = toLibraryOp(call.args);
    if ("error" in op) return `Failed: ${op.error}`;
    const result = libraryOps().run(op, { actor: "chat" });
    if (result.needsConfirmation) {
      if (!emit) return `Failed: this needs the user's confirmation and this chat cannot show buttons. Tell them: ${result.needsConfirmation.prompt}`;
      const choiceId = randomUUID();
      const token = result.needsConfirmation.token;
      rememberChoice(choiceId, () => libraryOps().run(op, { actor: "chat", confirm: token }));
      emit.choice(confirmChoice(choiceId, result.needsConfirmation.prompt, "Yes, do it"));
      return `Waiting for the user to confirm with buttons (asked: "${result.needsConfirmation.prompt}"). Stop here; do not repeat the request and do not say it was done.`;
    }
    if (!result.ok) return `Failed: ${result.error ?? "that did not work"}`;
    return `Done: ${result.summary}`;
  }
  if (call.name === "add_search_item") {
    const item = String(call.args.item ?? "").trim();
    const matchKeywords = Array.isArray(call.args.matchKeywords)
      ? (call.args.matchKeywords as unknown[]).map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : [];
    const typicalResaleUsd = Number(call.args.typicalResaleUsd) || 0;
    if (!item || !matchKeywords.length) {
      return "Failed: need both an item name and at least one match keyword.";
    }
    // Per explicit instruction — "if the ai already has prior knowledge on
    // the thing you are searching for, have it bring up an image from
    // Database... prompting the user with a popup": set only by
    // search:addProducts below, when the user confirmed Dashboard's popup
    // that a specific Database product IS what they're searching for — the
    // AI itself never sets this via chat, there's no popup in that flow.
    const linkedProductId = typeof call.args.linkedProductId === "string" ? call.args.linkedProductId : null;
    // Per explicit instruction — price range is per-product now, set once
    // at add time (Dashboard's own "Set a price range for ___?" prompt, or
    // the chat assistant's own minPriceUsd/maxPriceUsd args here) rather
    // than a single global Min/Max Price knob shared by everything on the
    // Search For list — see types.ts's SearchItem doc comment.
    const minPriceUsd = typeof call.args.minPriceUsd === "number" ? call.args.minPriceUsd : null;
    const maxPriceUsd = typeof call.args.maxPriceUsd === "number" ? call.args.maxPriceUsd : null;
    const includeBroken = call.args.includeBroken === true;
    const acceptVariants = call.args.acceptVariants === true;
    const newItem = { item, matchKeywords, typicalResaleUsd, linkedProductId, minPriceUsd, maxPriceUsd, ...(includeBroken ? { includeBroken: true } : {}), ...(acceptVariants ? { acceptVariants: true } : {}) };
    config = {
      ...config,
      searchItems: [...config.searchItems, newItem],
      recentSearches: pushRecentSearch(config.recentSearches, { item, minPriceUsd, maxPriceUsd, linkedProductId, includeBroken, acceptVariants }),
    };
    // Adding a product to Search For never turns general (unverified) deal detection off. The two coexist: the dedicated search runs first
    // at each location and the general browse still runs after it. General detection is only turned off when the user explicitly says so
    // (the set_general_deal_detection chat tool, or the Config toggle). It used to be switched off here on every add, which silently
    // stopped all general discovery and made the scanner skip everything that was not on the Search For list.
    saveConfig(CONFIG_PATH, config);
    // Verified live miss — this was the actual root cause of "it doesn't
    // display the product that was searched for": every OTHER
    // config-mutating handler broadcasts config:updated so the renderer's
    // live copy (Dashboard's FiltersCard "Currently searching for" pills)
    // picks up the change immediately, but this one never did — the new
    // item was genuinely saved and used by the scanner, it just never told
    // the UI, so it looked like adding a product silently did nothing.
    sendToRenderer("config:updated", config);
    const priceRangeSuffix =
      minPriceUsd != null && maxPriceUsd != null
        ? ` [$${minPriceUsd}-$${maxPriceUsd}]`
        : minPriceUsd != null
          ? ` [$${minPriceUsd}+]`
          : maxPriceUsd != null
            ? ` [up to $${maxPriceUsd}]`
            : "";
    const line: LogLine = {
      ts: Date.now(),
      level: "info",
      message: `Chat added to Search For: "${item}"${priceRangeSuffix}${typicalResaleUsd > 0 ? ` (~$${typicalResaleUsd})` : " (no price set yet)"}`,
    };
    recordLog(line);
    sendToRenderer("engine:log", line);
    // Per explicit instruction — reversing an earlier explicit instruction
    // ("asking the assistant to search for something shouldn't require a
    // separate trip to click Start Scanner too"): adding a product should
    // ONLY save it to the Search For list, never start, restart, or run an
    // immediate one-off search on any account — "that's what the Start
    // scanning button is for." This used to auto-start an idle account
    // (with an immediate searchForItemNow look) and restart an already-
    // running one so it'd pick the new item up sooner; both are gone now.
    // An account that's already scanning picks this up naturally on its
    // own next cycle (getConfig() reads config.searchItems fresh every
    // time) — no restart needed for that to happen, just not as
    // immediately.
    return typicalResaleUsd > 0
      ? `Added "${item}" to your Search For list with a reference price of $${typicalResaleUsd}. Start the scanner (or wait for its next cycle, if it's already running) to actually search for it.`
      : `Added "${item}" to your Search For list, but with no reference resale price set yet, so I can't tell you're getting a genuine deal on it. Start the scanner (or wait for its next cycle) to search for it.`;
  }

  if (call.name === "add_custom_instruction") {
    const instruction = String(call.args.instruction ?? "").trim();
    if (!instruction) return "Failed: no instruction text given.";
    config = { ...config, customInstructions: [config.customInstructions, instruction].filter(Boolean).join("\n") };
    saveConfig(CONFIG_PATH, config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat added custom instruction: "${instruction}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Added to custom instructions: "${instruction}"`;
  }

  // Clynx looking something up the way a person would (a web search it reads and explains in chat): nothing is saved or changed.
  if (call.name === "web_research") {
    const query = String(call.args.query ?? "").trim();
    const url = publicHttpUrls(String(call.args.url ?? "") || query, 1)[0] ?? null;
    if (!query && !url) return "Failed: no search query given.";
    return await lookUpOnWeb(query, url);
  }

  // The photos the user attached to this message: what is visible, what the web says editions look like, and how sure that makes Clynx. Nothing is saved.
  if (call.name === "identify_from_photo") {
    const images = call.images ?? [];
    if (!images.length) return "Failed: no photo is attached to this message. Ask the user to attach one with the paperclip.";
    if (!hasOpenAIAccess()) return "Failed: looking at photos needs the AI connection, which is not available.";
    const title = String(call.args.title ?? "").trim() || undefined;
    const graph = store.knowledgeGraph();
    seedNintendoHandhelds(graph);
    const decision = await identifyFromObservation({ images, title }, { graph, web: webHardDeps(), observer: openAiObserver(), themes: openAiThemeClassifier(), usage: (key, count) => store.addUsage(key, count ?? 1) });
    return describeIdentification(decision);
  }

  // Is a seller's model name real? Reads the maker's lineup; only a lineup it read can say a name is not in it.
  if (call.name === "check_model_name") {
    const name = String(call.args.name ?? "").trim();
    if (!name) return "Failed: no model name given.";
    const result = await challengeModelClaim(name, webHardDeps());
    store.addUsage("claim_check");
    rememberLineup(store.knowledgeGraph(), result);
    return `${describeChallenge(result)} ${result.sources.length ? `Sources read: ${result.sources.slice(0, 3).map((s) => s.url).join(", ")}.` : ""}`.trim();
  }
  // Clynx learning how the versions of a product line differ (storage sizes, look-alike models), remembered for later comparisons.
  if (call.name === "research_variants") {
    const name = String(call.args.product ?? "").trim();
    if (!name) return "Failed: no product named.";
    if (beta13Flags(config).webKnowledge === "off") return "Failed: product research on the web is switched off (config.json beta13.webKnowledge).";
    const edition = String(call.args.edition ?? "").trim() || null;
    // sizes and look-alike models, AND the special editions: both are what "variants" means to the person asking
    const svc = getKnowledgeService();
    const [outcome, editions] = await Promise.all([svc.research(name, call.args.refresh === true), svc.researchEditions(name, edition)]);
    const parts: string[] = [];
    if (outcome.ok) {
      const k = outcome.knowledge;
      parts.push(`${describeKnowledge(k)}${k.summary ? ` ${k.summary}` : ""}`);
    } else parts.push(`Sizes and look-alike models: ${outcome.reason}.`);
    parts.push(describeEditionResearch(editions));
    return parts.join(" ");
  }

  if (call.name === "add_reference_photos") return await runAddReferencePhotosTool(call.args, call.userMessage, currentProductId);

  if (call.name === "find_products") {
    const hits = searchProducts(store.listProductIndex().map((p) => ({ id: p.id, name: p.name })), String(call.args.query ?? ""));
    if (!hits.length) return `No product in the Database matches "${String(call.args.query ?? "")}".`;
    return hits
      .map((h) => {
        const p = store.getProductById(h.id);
        if (!p) return `- ${h.name}`;
        const value = p.ebayEstimatedValueUsd ?? p.ebayAvgSoldPriceUsd;
        return `- ${p.name}${p.parentProductId ? " (a version of another entry)" : ""}${p.variantEvidence ? `, variant ${p.variantEvidence.status}` : ""}, ${value != null ? `value ~$${Math.round(value)}` : "no value yet"}`;
      })
      .join("\n");
  }

  if (call.name === "research_product") {
    return await runResearchProductTool(call.args, call.userMessage, {
      store,
      verifyClaim,
      startLookup: (id, name, opts) => void runProductLookup(id, name, opts),
      notify: (id) => sendToRenderer("products:updated", store.getProductById(id)),
      newId: () => randomUUID(),
      progress: onSearchUpdate,
    });
  }

  if (call.name === "add_product_watch_note") {
    if (!currentProductId) return "Failed: no product context for this note.";
    const note = String(call.args.note ?? "").trim();
    if (!note) return "Failed: no note text given.";
    const updated = store.appendProductWatchNote(currentProductId, note);
    if (!updated) return "Failed: that product no longer exists.";
    sendToRenderer("products:updated", updated);
    // Makes the connection to live scanning visible on the Dashboard too,
    // not just a silent DB write — per explicit instruction, this should
    // "transfer live to the Dashboard, especially if it's already
    // scanning." The actual scoring/vision effect is already live the
    // instant this returns (scrapeEngine.ts reads lookoutNotes straight
    // from the DB on every relevant listing, no caching to invalidate) —
    // this line is just so the user can SEE that on the Activity feed.
    const line: LogLine = {
      ts: Date.now(),
      level: "info",
      message: `Watch-for note added for "${updated.name}": ${note}`,
      productName: updated.name,
    };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Noted — I'll watch for that in "${updated.name}" listings going forward.`;
  }

  if (call.name === "add_blacklist_term") {
    const term = String(call.args.term ?? "").trim();
    if (!term) return "Failed: no term given.";
    // Per explicit instruction — "blacklist both the title and the image
    // if possible": a plain "blacklist X" typed in chat has no listing
    // behind it at all most of the time, but asking FROM a specific
    // product's own page (currentProductId set) does — that product's own
    // thumbnail, if it has one.
    const contextProduct = currentProductId ? store.getProductById(currentProductId) : null;
    const added = store.addBlacklistTerm(
      term,
      "user",
      contextProduct?.imageUrl ? { imageData: contextProduct.imageUrl, sourceTitle: contextProduct.name } : null
    );
    if (!added) return "Failed: couldn't add that term.";
    sendToRenderer("blacklist:updated", store.listBlacklistTerms());
    if (contextProduct?.imageUrl) sendToRenderer("blacklistImages:updated", store.listBlacklistedImages());
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat blacklisted "${added.term}" — matching listings will be skipped automatically.` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Blacklisted "${added.term}" — matching listings will be skipped automatically from now on.`;
  }

  if (call.name === "remove_blacklist_term") {
    const term = String(call.args.term ?? "").trim();
    if (!term) return "Failed: no term given.";
    store.removeBlacklistTerm(term);
    sendToRenderer("blacklist:updated", store.listBlacklistTerms());
    return `Removed "${term}" from the blacklist.`;
  }

  if (call.name === "set_general_deal_detection") {
    const enabled = !!call.args.enabled;
    config = { ...config, generalDeal: { ...config.generalDeal, enabled } };
    saveConfig(CONFIG_PATH, config);
    const line: LogLine = {
      ts: Date.now(),
      level: "info",
      message: enabled
        ? "Chat turned general (unverified) deal detection back on."
        : "Chat turned general (unverified) deal detection off — focusing only on the Search For list.",
    };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return enabled
      ? "General deal detection is back on — I'll flag other things that look like good deals too, not just your Search For list."
      : "General deal detection is off — I'll only flag things on your Search For list now, nothing else.";
  }

  if (call.name === "remove_search_item") {
    const item = String(call.args.item ?? "").trim().toLowerCase();
    if (!item) return "Failed: no item name given.";
    const before = config.searchItems.length;
    config = { ...config, searchItems: config.searchItems.filter((s) => s.item.trim().toLowerCase() !== item) };
    if (config.searchItems.length === before) return `Couldn't find "${item}" on your Search For list — nothing removed.`;
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat removed from Search For: "${item}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    restartAllEnginesIfRunning("your updated Search For list");
    return `Removed "${item}" from your Search For list.`;
  }

  if (call.name === "update_config") {
    const a = call.args as Record<string, unknown>;
    const patch: Partial<Config> = {};
    const changed: string[] = [];

    if (typeof a.dealThresholdPercent === "number") { patch.dealThresholdPercent = a.dealThresholdPercent; changed.push("deal threshold"); }
    if (typeof a.ebayNetPercent === "number") { patch.ebayNetPercent = clampNetPercent(a.ebayNetPercent); changed.push("eBay take-home %"); }
    if (typeof a.minProfitMarginPercent === "number") { patch.minProfitMarginPercent = clampMarginPercent(a.minProfitMarginPercent); changed.push("minimum profit margin"); }
    if (typeof a.listingsPerLocation === "number") { patch.listingsPerLocation = Math.max(1, Math.round(a.listingsPerLocation)); changed.push("listings per location"); }
    if (typeof a.pollIntervalMinutesMin === "number") { patch.pollIntervalMinutesMin = Math.max(0, a.pollIntervalMinutesMin); changed.push("min wait between passes"); }
    if (typeof a.pollIntervalMinutesMax === "number") { patch.pollIntervalMinutesMax = Math.max(0, a.pollIntervalMinutesMax); changed.push("max wait between passes"); }
    if (typeof a.headless === "boolean") { patch.headless = a.headless; changed.push("headless mode"); }
    if (typeof a.customInstructions === "string") { patch.customInstructions = a.customInstructions; changed.push("custom instructions (replaced)"); }
    if (typeof a.photoAnalysisEnabled === "boolean") { patch.photoAnalysis = { enabled: a.photoAnalysisEnabled }; changed.push("photo analysis auto-check"); }
    if (a.generalDealMinConfidence === "medium" || a.generalDealMinConfidence === "high") {
      patch.generalDeal = { ...config.generalDeal, minConfidence: a.generalDealMinConfidence };
      changed.push("general-deal settings");
    }
    // Nullable fields: distinguish "key not present at all" (undefined —
    // leave unchanged) from an explicit null (clear it) from a real number
    // (set it) — `typeof a.X === "number"` alone can't express "clear this
    // back to no cap," which is exactly the gap that made update_config
    // unable to actually do several things a user might ask for.
    const isNullableNumber = (key: string): boolean => key in a && (a[key] === null || typeof a[key] === "number");

    if (
      typeof a.sellerRiskEnabled === "boolean" ||
      typeof a.sellerRiskMinAccountAgeYears === "number" ||
      isNullableNumber("sellerRiskMinRating") ||
      isNullableNumber("sellerRiskMinRatingCount") ||
      isNullableNumber("sellerRiskMaxRatingCount") ||
      typeof a.sellerRiskRequireProfilePhoto === "boolean"
    ) {
      patch.sellerRisk = {
        ...config.sellerRisk,
        ...(typeof a.sellerRiskEnabled === "boolean" ? { enabled: a.sellerRiskEnabled } : {}),
        ...(typeof a.sellerRiskMinAccountAgeYears === "number" ? { minAccountAgeYears: a.sellerRiskMinAccountAgeYears } : {}),
        ...(isNullableNumber("sellerRiskMinRating") ? { minRating: a.sellerRiskMinRating as number | null } : {}),
        ...(isNullableNumber("sellerRiskMinRatingCount") ? { minRatingCount: a.sellerRiskMinRatingCount as number | null } : {}),
        ...(isNullableNumber("sellerRiskMaxRatingCount") ? { maxRatingCount: a.sellerRiskMaxRatingCount as number | null } : {}),
        ...(typeof a.sellerRiskRequireProfilePhoto === "boolean" ? { requireProfilePhoto: a.sellerRiskRequireProfilePhoto } : {}),
      };
      changed.push("seller-risk filters");
    }
    if ((typeof a.ntfyTopic === "string" && a.ntfyTopic.trim()) || (typeof a.ntfyServer === "string" && a.ntfyServer.trim())) {
      patch.ntfy = {
        ...config.ntfy,
        ...(typeof a.ntfyTopic === "string" && a.ntfyTopic.trim() ? { topic: a.ntfyTopic.trim() } : {}),
        ...(typeof a.ntfyServer === "string" && a.ntfyServer.trim() ? { server: a.ntfyServer.trim() } : {}),
      };
      changed.push("ntfy settings");
    }
    if (a.theme === "dark" || a.theme === "light") {
      patch.theme = a.theme;
      changed.push("theme");
    }
    if (isNullableNumber("maxListingAgeHours")) {
      patch.maxListingAgeHours = a.maxListingAgeHours as number | null;
      changed.push("freshness window");
    }
    if (typeof a.ignoreBlacklist === "boolean") {
      patch.ignoreBlacklist = a.ignoreBlacklist;
      changed.push("ignore-blacklist");
    }
    if (typeof a.autoResearchListings === "boolean") {
      patch.autoResearchListings = a.autoResearchListings;
      changed.push("auto-research");
    }
    if (typeof a.rotateSearchItems === "boolean") {
      patch.rotateSearchItems = a.rotateSearchItems;
      changed.push("rotate search terms");
    }
    if (typeof a.rotateSearchItemsCount === "number") {
      patch.rotateSearchItemsCount = a.rotateSearchItemsCount;
      changed.push("rotate search terms count");
    }

    if (!changed.length) return "Failed: no recognized settings were included in that request.";
    config = { ...config, ...patch };
    saveConfig(CONFIG_PATH, config);
    // Per explicit instruction — a chat-driven change (theme especially)
    // needs to actually show up live, not just get saved to disk while the
    // running app looks untouched until the next restart/reload. Reported
    // live as "asked it to switch to dark mode... it couldn't do it" — half
    // of that bug was theme not even being a field this tool could set at
    // all (fixed above), the other half was that even a successful config
    // change here never told the renderer anything changed.
    sendToRenderer("config:updated", config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat updated settings: ${changed.join(", ")}` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Updated: ${changed.join(", ")}.`;
  }

  if (call.name === "start_scanner") {
    if (config.facebookEnabled === false) return "Facebook Marketplace is turned off in Config — turn \"Search Facebook Marketplace\" back on there first.";
    // Multi-account: starts every ENABLED account that isn't already
    // running (an account added but not yet logged in still gets an
    // engine — see ensureEngineFor — but "start all" only touches ones the
    // user has actually enabled).
    const toStart = config.accounts.filter((a) => a.enabled && !ensureEngineFor(a.id).getStatus().running);
    if (!toStart.length) {
      return config.accounts.some((a) => a.enabled)
        ? "The scanner is already running."
        : "No Facebook account is switched on, so there is nothing to start. Turn one on in Config > Sources (the Enabled button on its card), or press Start Scanner on the Dashboard, which then starts all of them.";
    }
    // Per explicit instruction — resolve any pending location change (see
    // resolveAccountLocationIfNeeded) before actually starting each one; a
    // no-op for an account whose location is already resolved.
    const failures: string[] = [];
    for (const account of toStart) {
      const resolved = await resolveAccountLocationIfNeeded(account.id);
      if (resolved.message) {
        const line: LogLine = { ts: Date.now(), level: resolved.ok ? "info" : "error", message: resolved.message };
        recordLog(line);
        sendToRenderer("engine:log", line);
      }
      if (!resolved.ok) {
        failures.push(account.label);
        continue;
      }
      ensureEngineFor(account.id).start();
    }
    const started = toStart.filter((a) => !failures.includes(a.label));
    if (!started.length) return `Failed: couldn't resolve the location for ${failures.join(", ")} — check Config.`;
    const suffix = failures.length ? ` (couldn't start ${failures.join(", ")} — check Config)` : "";
    return started.length === config.accounts.filter((a) => a.enabled).length
      ? `Scanner started.${suffix}`
      : `Started ${started.length} account(s): ${started.map((a) => a.label).join(", ")}.${suffix}`;
  }

  if (call.name === "stop_scanner") {
    // Gating this on `running` alone used to leave a lingering window open
    // — running is only ever true during the continuous scan loop, but a
    // browser can also be open from login() or a chat-triggered search,
    // neither of which sets it. "Stop" should always close whatever's
    // actually open, not just decline when nothing's actively looping.
    // Multi-account: stops EVERY account's engine, not just one.
    const toStop = config.accounts.filter((a) => {
      const eng = engines.get(a.id);
      return eng && (eng.getStatus().running || eng.hasOpenBrowser());
    });
    if (!toStop.length) return "Nothing to stop — the scanner isn't running and no browser window is open.";
    await Promise.all(toStop.map((a) => engines.get(a.id)!.stop()));
    return `Stopped ${toStop.length} account(s), browser${toStop.length === 1 ? "" : "s"} closed.`;
  }

  if (call.name === "clear_feed") {
    const countBefore = store.listRecent(1, 0).length > 0;
    store.clearAllListings();
    const line: LogLine = { ts: Date.now(), level: "info", message: "Chat cleared the Feed." };
    recordLog(line);
    sendToRenderer("engine:log", line);
    sendToRenderer("listings:refresh");
    return countBefore ? "Feed cleared — every listing has been permanently deleted." : "Feed was already empty.";
  }

  if (call.name === "create_watch") {
    const searchPhrase = String(call.args.searchPhrase ?? "").trim();
    if (!searchPhrase) return "Failed: no search phrase given.";
    // Found during review: the very first version of this handler called
    // expandSearchKeywords(searchPhrase) here — a real, separate OpenAI
    // round-trip, mirroring the watch:create IPC handler above (the UI
    // form's path, which has no LLM of its own and genuinely needs it).
    // But the chat model IS already an LLM in this exact same turn — this
    // tool asks it for matchKeywords directly instead, same as
    // add_search_item's own schema right above, so a chat-created Watch
    // costs zero extra AI calls, not a second one for something the model
    // could already generate for free.
    const matchKeywords = Array.isArray(call.args.matchKeywords)
      ? (call.args.matchKeywords as unknown[]).map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : [];
    if (!matchKeywords.length) return "Failed: need at least one match keyword.";
    const name = String(call.args.name ?? "").trim() || searchPhrase;
    const platform: WatchPlatform = call.args.platform === "ebay" ? "ebay" : "facebook";
    const locationMode = call.args.locationMode === "state" || call.args.locationMode === "country" ? call.args.locationMode : "city";
    const selectedCityOrZip = typeof call.args.selectedCityOrZip === "string" ? call.args.selectedCityOrZip.trim() || null : null;
    const selectedState = typeof call.args.selectedState === "string" ? call.args.selectedState.trim() || null : null;
    // city/state modes need a real place to resolve — country mode needs
    // nothing extra (same as an Account's own country mode). Caught here
    // rather than left to fail silently later when the scheduler/resolution
    // finds nothing to search. (An eBay Watch has no location at all.)
    if (platform === "facebook" && locationMode === "city" && !selectedCityOrZip) {
      return "Failed: a city/ZIP Watch needs a specific location — ask the user which city or ZIP to watch, then try again.";
    }
    if (platform === "facebook" && locationMode === "state" && !selectedState) {
      return "Failed: a state Watch needs a state — ask the user which state to watch, then try again.";
    }
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    // Extra products for a Facebook Watch. The model is already an LLM, so (as above) their
    // match keywords come from the phrase itself rather than another AI call.
    const extraPhrases = platform === "facebook" && Array.isArray(call.args.alsoWatchFor) ? (call.args.alsoWatchFor as unknown[]).map((p) => String(p).trim()).filter(Boolean) : [];
    const terms: WatchTerm[] = [{ phrase: searchPhrase, matchKeywords, linkedProductId: null }];
    for (const phrase of extraPhrases) {
      if (terms.length >= MAX_WATCH_TERMS) break;
      if (terms.some((t) => t.phrase.toLowerCase() === phrase.toLowerCase())) continue;
      terms.push({ phrase, matchKeywords: [phrase.toLowerCase()], linkedProductId: null });
    }
    const watch = store.createWatch({
      name,
      platform,
      terms,
      checkIntervalMinutes: snapToWatchInterval(num(call.args.checkIntervalMinutes) ?? undefined),
      searchPhrase,
      matchKeywords,
      linkedProductId: null,
      minPriceUsd: num(call.args.minPriceUsd),
      maxPriceUsd: num(call.args.maxPriceUsd),
      minProfitUsd: num(call.args.minProfitUsd),
      minDiscountPercent: num(call.args.minDiscountPercent),
      maxListingAgeMinutes: num(call.args.maxListingAgeMinutes),
      minSellerRatingPercent: platform === "ebay" ? sanitizeSellerRating(call.args.minSellerRatingPercent) : null,
      ...watchLocationFor(platform, { locationMode, selectedState, selectedCityOrZip, searchRadiusMiles: num(call.args.searchRadiusMiles) }),
    });
    startWatching();
    sendToRenderer("watches:updated", store.listWatches());
    const line: LogLine = { ts: Date.now(), level: "info", message: `${platform === "ebay" ? "eBay" : "Facebook"} Watch created via chat: "${watch.name}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    // Same warning WatchFormFlow.tsx already shows inline when creating one
    // through the UI (see its own profit/discount + !linkedProductId check)
    // — chat bypasses that form entirely, so without this the chat path is
    // the one way to create an always-unsatisfiable profit/discount
    // condition with no indication anything's wrong.
    const pricingCaveat =
      (watch.minProfitUsd !== null || watch.minDiscountPercent !== null) && !watch.linkedProductId
        ? " Heads up: the profit/discount condition needs a linked Database product with known pricing to ever be judged — without one, it won't trigger. Link one from the Watch screen if you want that condition to actually work."
        : "";
    // An eBay Watch is only ever searched by the eBay engine, which does
    // nothing while "Search eBay" is off in Config or the API credentials are
    // missing — say so instead of letting a Watch silently never run.
    const ebayCaveat =
      platform === "ebay" && (!config.ebay?.enabled || !hasEbayCredentials())
        ? ` Heads up: eBay searching is currently ${config.ebay?.enabled ? "missing its API credentials (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET in .env)" : "turned off — it needs \"Search eBay\" switched on in Config"}, so this Watch won't run until that's fixed.`
        : "";
    return `Created ${platform === "ebay" ? "an eBay" : "a Facebook"} Watch "${watch.name}" for "${searchPhrase}" — it'll keep looking even with the scanner stopped, and you can review or edit it anytime on the Watch screen (eye icon in the sidebar).${pricingCaveat}${ebayCaveat}`;
  }

  if (call.name === "pause_watch") {
    const watch = findWatchByName(String(call.args.name ?? ""));
    if (!watch) return `Failed: couldn't find a Watch named "${call.args.name}".`;
    store.setWatchEnabled(watch.id, false);
    sendToRenderer("watches:updated", store.listWatches());
    // Same "chat did this, the user should see it in Activity" posture as
    // every other chat tool here (add_search_item, set_general_deal_detection,
    // ...) — not mirrored by the UI's own pause toggle (watch:setEnabled),
    // which doesn't log, since a click is already visible to whoever made it.
    const line: LogLine = { ts: Date.now(), level: "info", message: `Watch paused via chat: "${watch.name}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Paused Watch "${watch.name}" — it won't check or alert until you resume it.`;
  }

  if (call.name === "resume_watch") {
    const watch = findWatchByName(String(call.args.name ?? ""));
    if (!watch) return `Failed: couldn't find a Watch named "${call.args.name}".`;
    store.setWatchEnabled(watch.id, true);
    sendToRenderer("watches:updated", store.listWatches());
    const line: LogLine = { ts: Date.now(), level: "info", message: `Watch resumed via chat: "${watch.name}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Resumed Watch "${watch.name}".`;
  }

  if (call.name === "delete_watch") {
    const watch = findWatchByName(String(call.args.name ?? ""));
    if (!watch) return `Failed: couldn't find a Watch named "${call.args.name}".`;
    store.deleteWatch(watch.id);
    sendToRenderer("watches:updated", store.listWatches());
    const line: LogLine = { ts: Date.now(), level: "info", message: `Watch deleted via chat: "${watch.name}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
    return `Deleted Watch "${watch.name}" and its match history.`;
  }

  if (call.name === "list_watch_matches") {
    const watch = findWatchByName(String(call.args.name ?? ""));
    if (!watch) return `Failed: couldn't find a Watch named "${call.args.name}".`;
    const matches = store.listWatchMatches(watch.id);
    if (!matches.length) return `"${watch.name}" hasn't found any matches yet — ${watch.listingsSeenCount} listing(s) checked against it so far.`;
    const lines = matches
      .slice(0, 5)
      .map(({ match, listing }) => `- "${listing.title}" $${listing.price ?? "?"} — ${new Date(match.matchedAt).toLocaleString()} (${match.discoveryMode})`);
    return `"${watch.name}" has ${matches.length} match${matches.length === 1 ? "" : "es"} total. Most recent:\n${lines.join("\n")}`;
  }

  return "Unknown tool.";
}

// Live one-liners the AI generates on its own — a reaction to a deal, or a
// recap after finishing a batch — streamed to the renderer on their own
// channel so the UI can tell "the AI chose to comment" apart from "the AI
// replied to your message." Best-effort: swallow failures so an OpenAI
// hiccup never interrupts scraping.
async function narrate(ctx: NarrationContext): Promise<void> {
  if (!hasOpenAIAccess() || !mainWindow) return; // (a signed-in account using Clynx's shared AI has no key of its own)
  const requestId = randomUUID();
  try {
    sendToRenderer("ai:narrationStart", { requestId, kind: ctx.kind });
    const full = await streamNarration(ctx, (delta) => {
      sendToRenderer("ai:narrationChunk", { requestId, delta });
    });
    sendToRenderer("ai:narrationDone", { requestId, full });
  } catch {
    sendToRenderer("ai:narrationError", { requestId });
  }
}

// Per explicit instruction — a FOLDER-level thumbnail (store.ts's
// group_thumbnails table) for a sub-grouping within a family ("Xbox >
// Games", "Xbox > Accessories", or one level deeper for a
// generation-specific bucket like "Xbox > Games > Xbox 360") — fetched
// once per distinct path and cached forever, reused by every product that
// lands in that same bucket afterward (same "fetch once, reuse forever"
// shape as the family-logo lookup in runProductLookup below). Deduped
// against concurrent lookups for the SAME path via groupThumbnailsInFlight
// — two games landing in "Xbox > Games" back to back would otherwise both
// kick off their own redundant web search. Fire-and-forget: never awaited
// by its caller, since a folder thumbnail finishing a few seconds late is
// harmless — the folder just shows its placeholder until the live
// groupThumbnails:updated push lands.
// The old fetch of a web photo for a sub-folder is retired: it searched the folder's words ("Nintendo Consoles") and could keep a game's artwork as the picture of a console
// folder. Folder pictures now come from folderArtService.ts (a generated decorative picture, or a photo of a fitting member product, or the person's own choice).
function ensureGroupThumbnail(segments: string[]): void {
  if (segments.length < 2) return;
  scheduleFolderArt();
}

// Per explicit instruction — Library's home-screen CATEGORY tiles (see
// generateCategoryImage's own doc comment for the full reasoning). Reuses
// the exact same store.ts group_thumbnails table/IPC broadcast as
// ensureGroupThumbnail above — a plain category name never collides with a
// real family path there, since a path always has a " > " in it (checked
// via segments.length below) while a category name never does. Same
// in-flight dedup / fetch-once-cache-forever / fire-and-forget shape too.
const categoryThumbnailsInFlight = new Set<string>();
function ensureCategoryThumbnail(category: string): void {
  if (isLowAiMode()) return; // a generated image per category: not worth credits; the tile shows its products' photos
  const key = category.toLowerCase();
  if (categoryThumbnailsInFlight.has(key) || store.getGroupThumbnail(category)) return;
  categoryThumbnailsInFlight.add(key);
  (async () => {
    try {
      const imageData = await generateCategoryImage(category);
      if (imageData) {
        store.setGroupThumbnail(category, imageData);
        sendToRenderer("groupThumbnails:updated", { path: category, imageData });
      }
    } catch (err) {
      console.error(`[category-thumbnail] failed for "${category}": ${(err as Error).message}`);
    } finally {
      categoryThumbnailsInFlight.delete(key);
    }
  })();
}

// Per explicit instruction, live: "I've posted multiple reference photos
// for 'Wireless Xbox Controller'... different colors... the D pad...
// finding these sorts of tiny little differences can make all the
// difference." Runs a fresh comparison across a product's WHOLE reference
// gallery (see vision.ts's analyzeReferencePhotoDifferences) every time a
// new confirmed photo gets added — a newly-added photo could be exactly
// the one that reveals a difference the earlier set didn't show. Capped to
// the most recent 8 images (bounded cost/prompt size regardless of how
// many total exist) and deduped against concurrent calls for the SAME
// product, same fire-and-forget shape as ensureGroupThumbnail/
// ensureCategoryThumbnail above. Writes into lookoutNotes (store.ts's
// appendProductWatchNote) — the SAME "Watching for, in real listings"
// section a manual correction note already lands in, since this is
// exactly that kind of actionable, checkable detail, just AI-noticed from
// comparing photos instead of user-typed.
const photoDifferenceAnalysisInFlight = new Set<string>();
function ensurePhotoDifferenceAnalysis(productId: string): void {
  if (isLowAiMode() || photoDifferenceAnalysisInFlight.has(productId)) return;
  photoDifferenceAnalysisInFlight.add(productId);
  (async () => {
    try {
      const product = store.getProductById(productId);
      if (!product) return;
      const images = store.listProductImages(productId).map((img) => img.imageData);
      if (images.length < 2) return;
      const result = await analyzeReferencePhotoDifferences(product.name, images.slice(-8));
      if (result.summary) {
        const updated = store.appendProductWatchNote(productId, result.summary);
        if (updated) sendToRenderer("products:updated", updated);
      } else if (result.error) {
        console.error(`[photo-differences] failed for "${product.name}": ${result.error}`);
      }
      // Every time a photo lands and this difference pass runs anyway is
      // also the natural moment to re-check whether the gallery has crossed
      // the 10-photo threshold for the self-correcting audit below.
      ensurePhotoGalleryAudit(productId);
    } catch (err) {
      console.error(`[photo-differences] failed for product ${productId}: ${(err as Error).message}`);
    } finally {
      photoDifferenceAnalysisInFlight.delete(productId);
    }
  })();
}

// Per explicit instruction, live: "once there reaches 10 reference photos
// for a specific product, the ai should have a good understanding of what
// that product looks like and what it doesn't look like... the ai should be
// able to automatically sort through reference photos across all Library
// listings and be able to make corrections on its own. Of course, the user
// can still manually correct if needed." Reuses the exact same corrective
// moves as the user-triggered images:feedback handler below (move a
// misfiled photo to whatever product it actually shows, or drop it if
// there's no existing match) — the only difference is WHO decided the photo
// was wrong: the user typing feedback there, the whole gallery's own
// consensus here (see vision.ts's auditReferencePhotoGallery). Only acts on
// findings the model itself marks "confident" — an unattended background
// pass has no one to double-check it, so an unsure flag is left alone
// rather than risking a wrongful move/delete of a legitimately-filed photo;
// the user's own manual correction path (the lightbox's "?" feedback box)
// is still there to catch anything this leaves behind.
const photoGalleryAuditInFlight = new Set<string>();
function ensurePhotoGalleryAudit(productId: string): void {
  if (isLowAiMode() || photoGalleryAuditInFlight.has(productId)) return;
  photoGalleryAuditInFlight.add(productId);
  (async () => {
    try {
      const product = store.getProductById(productId);
      if (!product) return;
      // store.MAX_IMAGES_PER_PRODUCT already caps a gallery at 20, so the
      // whole thing is always affordable to send in one vision call — no
      // slicing needed here the way the 8-photo difference-analysis above
      // has to bound itself.
      const images = store.listProductImages(productId);
      // An entry that names a color gets checked from 3 photos on (a white console among black ones is obvious early); the
      // rest wait for 10, when the gallery's consensus is reliable.
      if (images.length < (colorsIn(product.name).size > 0 ? 3 : 10)) return;
      const knownProducts = store
        .listProductIndex()
        .map((p) => p.name)
        .filter((n) => n.toLowerCase() !== product.name.toLowerCase());
      const result = await auditReferencePhotoGallery(
        product.name,
        images.map((img) => img.imageData),
        knownProducts
      );
      if (result.error) {
        console.error(`[photo-audit] failed for "${product.name}": ${result.error}`);
        return;
      }
      // Beta 13 (audit LB-03, ID-02): this check judges pictures by APPEARANCE, so it can only SUGGEST. It used to delete the photo and re-file it under whatever it
      // looked like (an owner database shows it confusing Series S, Series X and Xbox One). Now a doubted photo is set aside (not used as a reference, still visible,
      // restorable) with a review item; nobody loses a photo and nothing is filed under a guess. A photo a person added is never questioned.
      let changed = false;
      for (const finding of result.findings) {
        if (!finding.confident) continue;
        if (finding.actualSubject.toLowerCase() === product.name.toLowerCase()) continue;
        const image = images[finding.photoIndex - 1];
        if (!image || image.status === "user" || image.status === "quarantined" || image.status === "needs_review") continue;
        const suggestion = store.resolveTarget(finding.actualSubject);
        store.setImageStatus(image.id, "needs_review");
        store.addReviewItem({
          kind: "image",
          subjectId: image.id,
          reasons: [`a picture-based check thinks this shows "${finding.actualSubject}"${finding.reason ? ` (${finding.reason})` : ""}; appearance alone is not enough to move it`],
          evidence: { productId, productName: product.name, sourceTitle: image.sourceTitle, suggestedSubject: finding.actualSubject, suggestedProductId: suggestion.product?.id ?? null, proposer: "gallery-audit" },
        });
        noteDecision({ kind: "identity_gate", subject: `${image.sourceTitle ?? "(no title)"} in ${product.name}`, verdict: "set aside for review", thought: `Gallery check says it looks like "${finding.actualSubject}". ${finding.reason ?? ""}`, imageDataUri: image.imageData });
        changed = true;
      }
      if (changed) {
        const updated = store.getProductById(productId);
        if (updated) sendToRenderer("products:updated", updated);
      }
    } catch (err) {
      console.error(`[photo-audit] failed for product ${productId}: ${(err as Error).message}`);
    } finally {
      photoGalleryAuditInFlight.delete(productId);
    }
  })();
}

// Per explicit instruction — reported live: the scanner once misidentified
// an iPhone 15 Plus listing as "Metroid," and that name went straight into
// the watchcount search since it used to just reuse whatever the product
// was CURRENTLY named. Shared by both places that run this research (the
// automatic step in runProductLookup below, and the manual "Research
// again" button's own IPC handler) so the fix — and the once-per-scan
// bookkeeping — only lives in one place. Grounds the search in the
// product's OLDEST reference photo that actually carries a real listing
// title (see store.addProductImage's sourceTitle — set from the genuine
// Facebook listing.title at the moment a product is first found, for every
// scanner-driven path; only ever null for a product added by hand through
// chat, which was never found on a real listing to begin with) rather than
// the product's current (possibly already-wrong) name — deriveWatchCountQuery
// itself falls back to that name when there's no such photo to go on.
async function fetchAndStoreEbayComps(id: string, fallbackName: string, currentListing?: { title: string; imageDataUri?: string | null }): Promise<CompsResearchResult> {
  // Shows up on the Discovery tab (joins the product's entry when a bigger research pass is already running).
  discovery.begin(id, fallbackName, "refresh", `Checking what "${fallbackName}" really sells for on eBay.`);
  discovery.note(id, "step", "Looking at sold prices on WatchCount and what sellers are asking on eBay right now.");
  try {
    const result = await researchEbayComps(id, fallbackName, currentListing);
    describeCompsFindings(id, result);
    discovery.finish(id);
    return result;
  } catch (err) {
    // The raw reason (a browser launch timeout can be thousands of characters of Chromium flags) goes to the log, never the page or the chat.
    console.error(`[ebay-comps] check for "${fallbackName}" failed: ${(err as Error).message.slice(0, 500)}`);
    discovery.note(id, "warn", friendlyPriceCheckFailure((err as Error).message));
    discovery.finish(id, "failed");
    throw err;
  }
}

async function researchEbayComps(
  id: string,
  fallbackName: string,
  // Condition-awareness — "the exact keywords to the original listing it
  // came from" is only meaningful when there's a genuinely LIVE listing on
  // hand, not just whichever reference photo happened to be saved first
  // (which could be from a much earlier scan, possibly a different real
  // listing entirely). Only the two call sites that actually have a live
  // listing in scope (a fresh auto-created product, and the "mark
  // interested" new-product path) pass this; every other call site keeps
  // today's exact oldest-reference-photo fallback behavior unchanged.
  currentListing?: { title: string; imageDataUri?: string | null }
): Promise<CompsResearchResult> {
  let sourceTitle: string | null;
  let imageDataUri: string | null;
  if (currentListing) {
    sourceTitle = currentListing.title;
    imageDataUri = currentListing.imageDataUri ?? null;
  } else {
    const images = [...store.listProductImages(id)].sort((a, b) => a.createdAt - b.createdAt);
    const original = images.find((img) => img.sourceTitle);
    sourceTitle = original?.sourceTitle ?? null;
    imageDataUri = original?.imageData ?? null;
  }
  // A "(For Parts / Broken)" variant is researched on its own terms: sold comps and asking prices of BROKEN copies of the base product.
  if (isBrokenVariantName(fallbackName)) return researchBrokenVariantComps(id, fallbackName);
  const query = await deriveWatchCountQuery(fallbackName, sourceTitle, imageDataUri, sourceTitle ? store.credibleCodes(id, fallbackName, sourceTitle) : []);
  // The sold-price lookup can fail (a browser that will not start) or hang: it must not take the asking-price estimate down with it. Without sold prices the estimate comes from asking prices.
  const soldAttempt = await softSoldLookup(() => timed("ebay_lookup", () => getPrimaryEngine().fetchEbayComps(query)), SOLD_LOOKUP_DEADLINE_MS);
  const comps = soldAttempt.comps;
  if (soldAttempt.failure) {
    console.error(`[ebay-comps] sold lookup for "${fallbackName}" failed: ${soldAttempt.failure.slice(0, 300)}`);
    discovery.note(id, "warn", friendlySoldFailure(soldAttempt.failure));
  }
  // The product's own name backs up the search query for hard facts like capacity (see compFilter.ts).
  // Cross-check every result's photo against this product's reference photos (not the ones that came from eBay: those would
  // only vouch for themselves), falling back to its thumbnail. No photo to compare with = text checks only.
  const referencePhotos = store
    .listProductImages(id)
    .filter((img) => img.kind === "normal" && !img.sourceTitle?.startsWith("eBay listing"))
    .slice(0, 3)
    .map((img) => img.imageData);
  const thumb = store.getProductById(id)?.imageUrl;
  if (referencePhotos.length === 0 && thumb && thumb.startsWith("data:image")) referencePhotos.push(thumb);
  const photoCheck = makePhotoCheck(fallbackName, referencePhotos);
  // A version of a general product (a special edition, a theme, a bundle) is valued only from sales of that version: the words that separate it
  // from its parent must be in a sale's title, or the sale is the standard model's and is left out (no sales left = not enough evidence).
  const self = store.getProductById(id);
  const parentEntry = self?.parentProductId ? store.getProductById(self.parentProductId) : null;
  const requiredTerms = parentEntry ? distinguishingTokens(fallbackName, parentEntry.name).other.filter((t) => !/^\d+$/.test(t)) : [];
  const analysis = await analyzeEbayComps(query, comps, fallbackName, photoCheck, false, requiredTerms, sourceTitle);
  // What sellers are asking for the same thing right now: sold comps stay the main evidence, asking prices fill in
  // when there are few of them (see marketValue.ts). Never fails the research: no data just means sold comps alone.
  const active = await fetchActiveAsks(query, fallbackName, analysis.dominantCondition, photoCheck, false, store.getProductById(id)?.family ?? null, requiredTerms, sourceTitle);
  // Both sides are what a buyer pays IN TOTAL (sold: item + shipping paid; asking: item + the seller's shipping charge).
  const estimate = estimateMarketValue(
    { mean: buyerTotalUsd(analysis.avgSoldPriceUsd, analysis.avgShippingUsd), n: analysis.sampleSize },
    { median: active.medianUsd, n: active.sampleSize }
  );
  // Say how many results were retrieved, accepted, uncertain and rejected, and why: no price from a result that was not verified as this product.
  const soldLine = describeSummary("Sold results", analysis.validation ?? emptySummary());
  const askLine = describeSummary("Asking results", active.validation ?? emptySummary());
  // No sold prices AND no asking prices: this is a failed price check, not a finished one (it is reported and retried), never a quiet "nothing found"
  if (soldAttempt.failure && active.sampleSize === 0 && (active.validation?.retrieved ?? 0) === 0) throw new Error(soldAttempt.failure);
  recordLog({ ts: Date.now(), level: "info", message: `Comparable check for "${fallbackName}": ${soldLine} ${askLine}` });
  discovery.note(id, "step", `${soldLine} ${askLine}`);
  // AI Activity: how many results each provider returned and how many the identity check accepted / rejected / could not tell.
  for (const [provider, v] of [["watchcount", analysis.validation], ["ebay", active.validation]] as const) {
    if (v) apiActivity.identity(provider, { retrieved: v.retrieved, accepted: v.exact + v.compatible, rejected: v.rejected, uncertain: v.uncertain });
  }
  const retrievedTotal = (analysis.validation?.retrieved ?? 0) + (active.validation?.retrieved ?? 0);
  const acceptedTotal = (analysis.validation ? analysis.validation.exact + analysis.validation.compatible : 0) + (active.validation ? active.validation.exact + active.validation.compatible : 0);
  if (retrievedTotal > 0 && acceptedTotal === 0) {
    discovery.note(id, "warn", "None of the results could be verified as this exact product, so I set no price from them (not enough evidence). I did not borrow another model's price.");
  }
  store.setProductCompsValidation(id, { at: Date.now(), sold: analysis.validation ?? null, active: active.validation ?? null });
  store.updateProductEbayComps(id, {
    avgSoldPriceUsd: analysis.avgSoldPriceUsd,
    avgRunTimeDays: analysis.avgRunTimeDays,
    avgShippingUsd: analysis.avgShippingUsd,
    sampleSize: analysis.sampleSize,
    activeMedianUsd: active.medianUsd,
    activeSampleSize: active.sampleSize,
    estimatedValueUsd: estimate.valueUsd,
    estimateBasis: estimate.basis,
    identity: analysis.identity ?? "exact",
  });
  getPrimaryEngine().markEbayCompsResearched(id);
  await refreshMyStoreReference(id, fallbackName);
  // The listings that were just confirmed to be this exact product have real photos of it: keep a few as reference photos.
  void addEbayReferencePhotos(id, fallbackName, active.photos);
  return { ...analysis, photoRejected: analysis.photoRejected + active.photoRejected, activeMedianUsd: active.medianUsd, activeSampleSize: active.sampleSize, estimatedValueUsd: estimate.valueUsd };
}

// What the user's own linked eBay store lists this product for (a price reference of their own, kept apart from the market
// numbers). Quiet no-op when no store is linked. A product none of their listings matches has its old reference cleared.
async function refreshMyStoreReference(productId: string, productName: string): Promise<void> {
  const seller = config.ebayStoreUsername?.trim();
  if (!seller) return;
  const ref = await fetchMyStoreReference(seller, productName);
  store.setProductMyStore(productId, ref);
  const updated = store.getProductById(productId);
  if (updated) sendToRenderer("products:updated", updated);
}

let myStoreBackfillRun = 0;
// After linking (or changing) the store: look up every product in the Database, one at a time, newest linking wins.
async function backfillMyStoreReferences(): Promise<void> {
  const run = ++myStoreBackfillRun;
  for (const product of store.listProducts()) {
    if (run !== myStoreBackfillRun || !config.ebayStoreUsername?.trim()) return;
    await refreshMyStoreReference(product.id, product.name);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Before a deal notification goes out, Clynx asks WatchCount (sold prices) and eBay (what sellers ask now) about the product,
// files the answer in the Database and decides with it (see preAlert.ts), instead of trusting a price the Database may have
// had for days. Skipped when the Database already looked the exact same product up recently. For a product the Database
// doesn't have yet, the entry is created (and filled in in the background) when the lookup finds real prices for it.
const MARKET_RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const MARKET_CHECK_TIMEOUT_MS = 150_000;
const marketChecksInFlight = new Map<string, Promise<MarketCheck | null>>();

function isExactProduct(productName: string, matchedItem: string | null, title: string, unconfirmedCodes: string[] = []): boolean {
  // A listing that states a model number / generation the product's name lacks, and evidence shows it is real, may be a more specific product.
  if (unconfirmedCodes.length > 0) return false;
  const sameName = !!matchedItem && matchedItem.trim().toLowerCase() === productName.trim().toLowerCase();
  if (sameName && compMatchesSpecs(productName, title) && !modelLettersConflict(productName, title)) return true;
  return titleLooksLikeProduct(productName, title);
}

// Listings that asked for a market check which timed out, by product: when the late answer lands they are judged again (scrapeEngine.requalifyListing).
const lateCheckWaiters = new Map<string, Set<string>>();

async function checkMarketBeforeAlert(listing: { title: string; matchedItem: string | null; purpose?: "bundle"; identityTexts?: string[]; listingId?: string }): Promise<MarketCheck | null> {
  const signals = store.getProductSignals(listing.matchedItem, listing.title, listing.identityTexts);
  const exact = !!signals && isExactProduct(signals.name, listing.matchedItem, listing.title, signals.unconfirmedCodes ?? []);
  const recentlyChecked = (checkedAt: number | null | undefined) => !!checkedAt && Date.now() - checkedAt < MARKET_RECENT_MS;
  if (signals && exact && recentlyChecked(signals.checkedAt)) {
    apiActivity.record({ provider: "watchcount", kind: "market_check", outcome: "local_db", route: "none", error: `"${signals.name}" was checked recently: the Database answered, no new lookup` });
    return {
      productId: signals.id,
      productName: signals.name,
      valueUsd: signals.valueUsd,
      refreshed: false,
      note: `"${signals.name}" was checked on WatchCount and eBay recently: using what the Database has.`,
    };
  }
  if (!config.watchCountEnabled) {
    apiActivity.record({ provider: "watchcount", kind: "market_check", outcome: "skipped_disabled", route: "none", error: "WatchCount is turned off in Config: the Database's own numbers decide" });
    return null; // turned off in Config: the Database's own numbers decide
  }
  // A listing more specific than the entry it matched is priced under a name of its own, so the general entry's value is not overwritten
  // with the specific product's comps.
  const moreSpecific = signals && !exact && listing.purpose !== "bundle" ? specificResearchName(signals.name, signals.codeAssessment, listing.title) : null;
  // Beta 12: a listing that is a different / more specific product than the entry it matched (an iPhone 15 Pro Max under an "iPhone 15" search, accepted as a variant) is checked under a
  // name of its own, never under the entry's: the entry's market numbers are not this product's.
  const titleIsOtherProduct = !!listing.matchedItem && !exact && !!listingContradictsEntry(listing.matchedItem, listing.title);
  const name =
    signals && exact
      ? signals.name
      : moreSpecific || (titleIsOtherProduct ? "" : listing.matchedItem?.trim()) || focalProductName({ signalName: null, matchedItem: null, category: null, title: listing.title });
  if (!name) return null;
  const key = name.toLowerCase();
  if (listing.listingId) {
    const waiting = lateCheckWaiters.get(key) ?? new Set<string>();
    waiting.add(listing.listingId);
    lateCheckWaiters.set(key, waiting);
  }
  const running = marketChecksInFlight.get(key);
  if (running) {
    apiActivity.record({ provider: "watchcount", kind: "market_check", outcome: "cached", route: "none", error: `a check for "${name}" was already running: sharing its answer` });
    return running;
  }
  const job = runMarketCheck(name, listing.title, signals && exact ? signals.id : null, listing.purpose, key).finally(() => marketChecksInFlight.delete(key));
  marketChecksInFlight.set(key, job);
  return job;
}

async function runMarketCheck(name: string, listingTitle: string, existingId: string | null, purpose?: "bundle", waitKey?: string): Promise<MarketCheck | null> {
  let id = existingId;
  let created = false;
  if (!id) {
    const before = store.getProductByName(name);
    id = store.addProductStub(randomUUID(), name);
    created = !before && store.getProductById(id)?.name === name;
    const known = store.getProductById(id);
    if (!created && known?.ebayCompsCheckedAt && Date.now() - known.ebayCompsCheckedAt < MARKET_RECENT_MS) {
      const signals = store.getProductSignals(name, listingTitle);
      return { productId: id, productName: known.name, valueUsd: signals?.valueUsd ?? null, refreshed: false, note: `"${known.name}" was checked on WatchCount and eBay recently: using what the Database has.` };
    }
  }
  const productId = id;
  discovery.begin(
    productId,
    name,
    purpose === "bundle" ? "bundle" : "alert",
    purpose === "bundle"
      ? `"${listingTitle}" holds several products, so I'm pricing "${name}" on its own first.`
      : `Before I alert you about "${listingTitle}", I'm double-checking what "${name}" is really worth.`
  );
  const research = fetchAndStoreEbayComps(productId, name, { title: listingTitle });
  const timedOut = Symbol("timeout");
  let timer: NodeJS.Timeout | undefined;
  const winner = await Promise.race([
    research,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), MARKET_CHECK_TIMEOUT_MS);
    }),
  ]).catch((err) => {
    console.error(`[marketCheck] "${name}" failed: ${(err as Error).message}`);
    return null;
  });
  if (timer) clearTimeout(timer);
  if (waitKey && winner !== timedOut) lateCheckWaiters.delete(waitKey); // answered in time: the gate already used the numbers
  if (winner === timedOut || winner === null) {
    discovery.note(productId, "warn", winner === timedOut ? "eBay was too slow to answer, so I'm going with what the Database already knows." : "I couldn't get a price check through, so I'm going with what the Database already knows.");
    discovery.finish(productId, "failed");
    if (winner === timedOut) {
      // It keeps going in the background. The entry created for it stays until the late answer arrives, so that answer is filed instead of lost.
      settleLateMarketCheck({
        research,
        created,
        productId,
        deleteProduct: (id) => store.deleteProduct(id),
        fillIn: () => void runProductLookup(productId, name, { triggeringListing: { title: listingTitle, imageDataUri: null } }),
        note: (message) => recordLog({ ts: Date.now(), level: "info", message: `"${name}": ${message}` }),
        // Beta 12: the late answer is judged against the listings that asked for it (they stayed "worth a look" for want of exactly this number).
        onValue: () => {
          const ids = waitKey ? [...(lateCheckWaiters.get(waitKey) ?? [])] : [];
          if (waitKey) lateCheckWaiters.delete(waitKey);
          for (const id of ids) void getPrimaryEngine().requalifyListing(id, `the late price check for "${name}" finished`).catch(() => undefined);
        },
      });
    } else if (created) {
      store.deleteProduct(productId);
    }
    return { productId, productName: name, valueUsd: null, refreshed: false, note: `Couldn't reach WatchCount/eBay in time for "${name}": using what the Database has${winner === timedOut ? " (the check is still running and will be filed when it finishes)" : ""}.` };
  }
  const valueUsd = winner.estimatedValueUsd ?? winner.avgSoldPriceUsd;
  if (created) {
    if (valueUsd === null) {
      discovery.finish(productId);
      store.deleteProduct(productId);
      return { productId: null, productName: name, valueUsd: null, refreshed: true, note: `WatchCount and eBay had no prices for "${name}": nothing to file in the Database.` };
    }
    runProductLookup(productId, name, { triggeringListing: { title: listingTitle, imageDataUri: null } });
  }
  discovery.finish(productId);
  const updated = store.getProductById(productId);
  if (updated) sendToRenderer("products:updated", updated);
  const soldTotal = buyerTotalUsd(winner.avgSoldPriceUsd, winner.avgShippingUsd);
  const sold = soldTotal !== null ? `sold for about $${Math.round(soldTotal)} with shipping (${winner.sampleSize} sales)` : "no sold comps";
  const asking = winner.activeMedianUsd !== null ? `listed at about $${Math.round(winner.activeMedianUsd)} (${winner.activeSampleSize} listings)` : "no active listings";
  return {
    productId,
    productName: name,
    valueUsd,
    refreshed: true,
    note: `Checked WatchCount and eBay for "${name}": ${sold}, ${asking}. Saved to the Database${created ? " as a new product" : ""}.`,
  };
}

// A listing that holds several products ("PS5 Pro with 2 controllers and a 2TB external hard drive"): Clynx breaks it into items first,
// finds what each extra sells for on its own (the Database's number when it has a recent one, otherwise a real WatchCount/eBay lookup
// that is filed in the Database like any other product), and only then values the lot (see bundleBreakdown.ts). The main item's own
// value is passed in: it is the product the listing was already matched to, priced on its own.
const BUNDLE_MAX_EXTRAS = 4;
async function valueListingBundle(args: { title: string; description: string; mainName: string; mainValueUsd: number }): Promise<BundleValuation | null> {
  const breakdown = await breakDownListing(args.title, args.description);
  if (!breakdown) return null;
  const main = breakdown.items.find((i) => i.role === "main");
  // A single product is nothing to break down.
  const extras = breakdown.items.filter((i) => i !== main).slice(0, BUNDLE_MAX_EXTRAS);
  if (!main || extras.length === 0) return null;
  const priced: PricedBundleItem[] = await Promise.all(
    extras.map(async (item): Promise<PricedBundleItem> => {
      let valueUsd: number | null = null;
      try {
        valueUsd = (await checkMarketBeforeAlert({ title: item.name, matchedItem: item.name, purpose: "bundle" }))?.valueUsd ?? null;
      } catch (err) {
        console.error(`[bundle] pricing "${item.name}" failed: ${(err as Error).message}`);
      }
      const signals = store.getProductSignals(item.name, item.name);
      const exact = !!signals && isExactProduct(signals.name, item.name, item.name);
      // Nothing found: the model's own rough guess stands in, flagged as an estimate.
      const estimated = valueUsd === null && item.guessUsd !== null;
      return { item, unitValueUsd: valueUsd ?? item.guessUsd, runTimeDays: exact ? (signals?.runTimeDays ?? null) : null, estimated };
    })
  );
  return valueBundle({ main: { ...main, name: args.mainName }, mainValueUsd: args.mainValueUsd, extras: priced });
}

// What broken / for-parts copies of a product sell for (the research behind a "(For Parts / Broken)" Database variant): WatchCount
// sold comps for "<product> for parts" and eBay's asking prices in its "For parts or not working" condition, both kept only when
// the listing is really a broken copy of this product. Stored on the variant exactly like a normal product's comps.
async function researchBrokenVariantComps(id: string, variantName: string): Promise<CompsResearchResult> {
  const baseName = baseNameOfBrokenVariant(variantName);
  const baseQuery = await deriveWatchCountQuery(baseName, null, null);
  let analysis: CompAnalysis = { avgSoldPriceUsd: null, avgRunTimeDays: null, avgShippingUsd: null, sampleSize: 0, dominantCondition: null, rejectedCount: 0, photoRejected: 0 };
  if (config.watchCountEnabled) {
    const comps = await timed("ebay_lookup", () => getPrimaryEngine().fetchEbayComps(`${baseQuery} for parts`));
    analysis = await analyzeEbayComps(baseQuery, comps, baseName, null, true);
  }
  const active = await fetchActiveAsks(baseQuery, baseName, null, null, true, store.getProductByName(baseName)?.family ?? store.getProductById(id)?.family ?? null);
  const estimate = estimateMarketValue({ mean: buyerTotalUsd(analysis.avgSoldPriceUsd, analysis.avgShippingUsd), n: analysis.sampleSize }, { median: active.medianUsd, n: active.sampleSize });
  store.updateProductEbayComps(id, {
    avgSoldPriceUsd: analysis.avgSoldPriceUsd,
    avgRunTimeDays: analysis.avgRunTimeDays,
    avgShippingUsd: analysis.avgShippingUsd,
    sampleSize: analysis.sampleSize,
    activeMedianUsd: active.medianUsd,
    activeSampleSize: active.sampleSize,
    estimatedValueUsd: estimate.valueUsd,
    estimateBasis: estimate.basis,
  });
  getPrimaryEngine().markEbayCompsResearched(id);
  return { ...analysis, activeMedianUsd: active.medianUsd, activeSampleSize: active.sampleSize, estimatedValueUsd: estimate.valueUsd };
}

// A broken / for-parts listing of a Search For item that includes broken listings: make sure the product has its "(For Parts / Broken)"
// VARIANT in the Database (a child of the product, not a separate product) and that variant knows what broken ones sell for, so
// the listing can be priced properly. The variant is created the first time one is seen; its eBay research is redone after 3 days.
const brokenVariantsInFlight = new Map<string, Promise<void>>();
async function ensureBrokenVariant(itemName: string, listingTitle: string): Promise<void> {
  const key = itemName.trim().toLowerCase();
  const running = brokenVariantsInFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const parent = store.getProductByName(itemName) ?? store.findMatchingProduct(itemName) ?? createPlainProduct(itemName, null, listingTitle);
    const variantName = brokenVariantName(parent.name);
    let variant = store.getProductByName(variantName);
    let created = false;
    if (!variant) {
      const variantId = store.addProductStub(randomUUID(), variantName);
      store.setProductParent(variantId, parent.id);
      variant = store.getProductById(variantId);
      created = true;
      if (variant) sendToRenderer("products:updated", variant);
      const line: LogLine = {
        ts: Date.now(),
        level: "info",
        message: `Added a "${variantName}" variant under "${parent.name}" in the Database (what broken ones sell for), from "${listingTitle}".`,
        productName: variantName,
      };
      recordLog(line);
      sendToRenderer("engine:log", line);
    }
    if (!variant) return;
    const stale = !variant.ebayCompsCheckedAt || Date.now() - variant.ebayCompsCheckedAt > MARKET_RECENT_MS;
    if (stale) {
      const research = fetchAndStoreEbayComps(variant.id, variantName);
      research.catch((err) => console.error(`[brokenVariant] research for "${variantName}" failed: ${(err as Error).message}`));
      await Promise.race([research.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, MARKET_CHECK_TIMEOUT_MS))]);
      const updated = store.getProductById(variant.id);
      if (updated) sendToRenderer("products:updated", updated);
    }
    // The write-up, family and photos for the new variant fill in behind the scenes.
    if (created) runProductLookup(variant.id, variantName, { skipSiblingDiscovery: true, forcedFamily: parent.family ?? undefined, source: "variant" });
  })().finally(() => brokenVariantsInFlight.delete(key));
  brokenVariantsInFlight.set(key, job);
  return job;
}

// Per explicit instruction — "when Clynx is searching eBay for products, use images straight from eBay as reference
// photos as well to train Clynx better." The photos of the eBay listings confirmed to be this exact product (same
// model numbers/capacity/color, AI-judged brand/edition) are candidates; each still goes through the usual download,
// near-duplicate and vision check before it is kept, so one seller's wrong picture can't poison the gallery.
// Fire-and-forget, best-effort, and bounded: a few per research pass, and no more once the gallery has plenty of them.
const EBAY_REFERENCE_PHOTOS_PER_PASS = 4;
const EBAY_REFERENCE_PHOTOS_MAX = 8;
const GALLERY_SOFT_LIMIT = 16;
async function addEbayReferencePhotos(productId: string, productName: string, photos: Array<{ url: string; label: string }>): Promise<void> {
  if (photos.length === 0) return;
  try {
    const existing = store.listProductImages(productId).filter((img) => img.kind === "normal");
    const fromEbay = existing.filter((img) => img.sourceTitle?.startsWith("eBay listing:")).length;
    const want = Math.min(EBAY_REFERENCE_PHOTOS_PER_PASS, EBAY_REFERENCE_PHOTOS_MAX - fromEbay, GALLERY_SOFT_LIMIT - existing.length);
    if (want <= 0) return;
    const found = await findReferencePhotos(productName, { want, existingImages: existing.map((img) => img.imageData), candidates: photos });
    let stored = 0;
    for (const photo of found.photos) {
      const evidence: FileImageEvidence = { sourceKind: "ebay", title: photo.text ?? photo.label, url: photo.url ?? null, proposer: "ebay-reference-search", picture: photo.verified ? { verdict: "yes" } : null };
      const filed = fileImage(store, productId, photo.imageData, evidence, { mode: identityMode() });
      if (filed.outcome !== "rejected" && filed.outcome !== "duplicate") stored++;
    }
    if (stored > 0) {
      store.touchProduct(productId);
      ensurePhotoDifferenceAnalysis(productId);
      const updated = store.getProductById(productId);
      if (updated) sendToRenderer("products:updated", updated);
    }
  } catch (err) {
    console.error(`[ebayReferencePhotos] "${productName}" failed: ${(err as Error).message}`);
  }
}

interface CompsResearchResult extends CompAnalysis {
  activeMedianUsd: number | null;
  activeSampleSize: number;
  estimatedValueUsd: number | null;
}

// Per explicit instruction — the Database Research tab shows what's
// CURRENTLY being researched, live, "relay its emotional feedback instead
// of its hyper-analysis." A Map (not a single "current" value) because
// runProductLookup genuinely runs concurrently for more than one product at
// once — a user-requested lookup racing an auto-discovered sibling, or two
// siblings discovered together — and every caller (the chat tool, the
// scanner auto-adding a new product, the Refresh button, sibling discovery)
// funnels through this same function, so tracking it here covers all of
// them without duplicating this at each call site.
const activeResearch = new Map<string, ActiveProductResearch>();
function broadcastResearchStatus(): void {
  sendToRenderer("research:status", Array.from(activeResearch.values()));
}

// The Database's Discovery tab: every product Clynx looks into, with its running thoughts about it (see discovery.ts).
const discovery = new DiscoveryFeed((entry) => sendToRenderer("discovery:entry", entry));

const money0 = (n: number) => `$${Math.round(n)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the eBay research found, in Clynx's own words, for the Discovery tab.
function describeCompsFindings(productId: string, result: CompsResearchResult): void {
  const soldTotal = buyerTotalUsd(result.avgSoldPriceUsd, result.avgShippingUsd);
  const thrownOut = result.rejectedCount + result.photoRejected;
  if (thrownOut > 0) discovery.note(productId, "step", `I threw out ${plural(thrownOut, "listing")} that weren't really this exact product (wrong edition, bundle or photos).`);
  if (result.identityNote) discovery.note(productId, "warn", `The sold prices mixed different versions of this product: ${result.identityNote}.`);
  const evidence: string[] = [];
  if (soldTotal !== null && result.sampleSize > 0) evidence.push(`${plural(result.sampleSize, "sale")} averaging ${money0(soldTotal)} with shipping`);
  if (result.activeMedianUsd !== null && result.activeSampleSize > 0) evidence.push(`${plural(result.activeSampleSize, "listing")} asking about ${money0(result.activeMedianUsd)}`);
  if (result.estimatedValueUsd !== null) {
    discovery.note(productId, "finding", `My read: it's worth about ${money0(result.estimatedValueUsd)} to a buyer on eBay${evidence.length ? `, going by ${evidence.join(" and ")}` : ""}.`);
  } else if (evidence.length) {
    discovery.note(productId, "finding", `I only found ${evidence.join(" and ")}: not enough to put a number on it yet.`);
  } else {
    discovery.note(productId, "warn", "I couldn't find eBay sales or listings I trust for this one, so there's no price yet.");
  }
  if (result.avgRunTimeDays !== null && result.sampleSize > 0) {
    discovery.note(productId, "finding", `They sell in ${result.avgRunTimeDays < 1 ? "under a day" : `about ${result.avgRunTimeDays.toFixed(1)} days`} on average.`);
  }
}

// Per explicit instruction — "have Clynx find stock photos of that product
// and download a whole bunch of reference photos... so it'll already be
// familiar with it when it comes across it again on Facebook or eBay."
// Tops a product's reference gallery up to REFERENCE_PHOTO_TARGET verified
// photos (see webResearch.ts's findReferencePhotos for where they come from
// and how they're checked), and — for a brand-new product, or one that still
// has no thumbnail — makes the best of them the Database thumbnail instead
// of the empty box / the one raw listing photo that happened to trigger it.
// Fire-and-forget from runProductLookup: it takes a few seconds, and
// shouldn't hold up the rest of that product's research. Deduped per
// product so two near-simultaneous research passes can't double-fill.
const REFERENCE_PHOTO_TARGET = 10;
const referencePhotoFillInFlight = new Set<string>();
async function fillReferencePhotos(id: string, name: string, replaceThumbnail: boolean, target: number = REFERENCE_PHOTO_TARGET): Promise<void> {
  if (referencePhotoFillInFlight.has(id)) return;
  referencePhotoFillInFlight.add(id);
  try {
    const normalCount = store.listProductImages(id).filter((img) => img.kind === "normal").length;
    const r = await topUpReferencePhotos({
      store,
      id,
      name,
      want: Math.max(0, target - normalCount),
      limit: Store.MAX_IMAGES_PER_PRODUCT,
      find: (n, o) => findReferencePhotos(n, o),
      replaceThumbnail,
      identityMode: identityMode(),
    });
    if (r.added > 0) {
      ensurePhotoDifferenceAnalysis(id);
      discovery.note(id, "step", `Saved ${plural(r.added, "reference photo")} so I'll recognize it on sight next time.`);
    }
    const updated = store.getProductById(id);
    if (updated) sendToRenderer("products:updated", updated);
    if (r.error) console.error(`[referencePhotos] fill failed for "${name}": ${r.error}`);
  } catch (err) {
    console.error(`[referencePhotos] fill failed for "${name}": ${(err as Error).message}`);
  } finally {
    referencePhotoFillInFlight.delete(id);
  }
}

/** The chat's add_reference_photos tool (see referencePhotos.ts): wired to this app's Database, photo search and screen updates. */
async function runAddReferencePhotosTool(args: Record<string, unknown>, userMessage: string | undefined, currentProductId?: string): Promise<string> {
  const started = Date.now();
  let failed = false;
  try {
    return await runAddReferencePhotos(args, userMessage, currentProductId, {
      store,
      find: (n, o) => findReferencePhotos(n, o),
      inFlight: referencePhotoFillInFlight,
      limit: Store.MAX_IMAGES_PER_PRODUCT,
      lowAiMode: isLowAiMode(),
      identityMode: identityMode(),
      onSaved: (product, added) => {
        ensurePhotoDifferenceAnalysis(product.id);
        discovery.note(product.id, "step", `Saved ${plural(added, "reference photo")} you asked for.`);
      },
      onUpdated: (product) => sendToRenderer("products:updated", product),
    });
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    recordStage("chat_tool_photo_search", Date.now() - started, !failed);
  }
}

// Per explicit instruction — products researched before this existed (or
// while the old DuckDuckGo-based photo search was being bot-blocked) are
// stuck with an empty box and no reference photos. This is the manual,
// one-click catch-up: runs fillReferencePhotos over every product that has
// fewer than REFERENCE_PHOTO_BACKFILL_BELOW photos, two products at a time
// (each one fans out into its own handful of parallel downloads, so more
// would just trip image hosts' rate limits), reporting progress to the
// Database screen. Deliberately a button, not automatic: it's ~15 vision
// checks per product, which is cheap but not free across a big library.
const REFERENCE_PHOTO_BACKFILL_BELOW = 5;
const PHOTO_BACKFILL_CONCURRENCY = 2;
let photoBackfill: { done: number; total: number } | null = null;
function productsNeedingPhotos(): Array<{ id: string; name: string }> {
  // Names and ids only: this runs when the Database opens and when the backfill starts, and must not read every product's photo.
  const counts = store.countNormalImagesByProduct();
  return store.listProductIndex().filter((p) => (counts.get(p.id) ?? 0) < REFERENCE_PHOTO_BACKFILL_BELOW);
}
function broadcastPhotoBackfill(): void {
  sendToRenderer("products:photoBackfillProgress", {
    running: photoBackfill !== null,
    done: photoBackfill?.done ?? 0,
    total: photoBackfill?.total ?? 0,
  });
}
async function runPhotoBackfill(): Promise<number> {
  if (photoBackfill) return photoBackfill.total;
  const startStore = store;
  const queue = productsNeedingPhotos();
  if (!queue.length) return 0;
  photoBackfill = { done: 0, total: queue.length };
  broadcastPhotoBackfill();
  let next = 0;
  const worker = async () => {
    while (next < queue.length && store === startStore) {
      const product = queue[next++];
      await fillReferencePhotos(product.id, product.name, false);
      if (photoBackfill) photoBackfill.done++;
      broadcastPhotoBackfill();
    }
  };
  void Promise.all(Array.from({ length: PHOTO_BACKFILL_CONCURRENCY }, worker)).finally(() => {
    photoBackfill = null;
    broadcastPhotoBackfill();
  });
  return queue.length;
}

// Runs in the background — the IPC handler that triggers this returns the
// loading stub immediately so the UI doesn't block, then this pushes a
// live update once the web research resolves. Errors are logged, not
// thrown, since nothing awaits this.
// The Database identity foundation's background fill (identity/foundationStore.ts): only when switched on in the config, a minute after startup, in steps of
// about 20 milliseconds with a longer pause between them, and it stops as soon as the Database it was started for is closed. It only writes the identity tables.
// Veto-only identity safeguard (config.identitySafeguard.mode, off unless config.json says otherwise). Applied once when the Database is opened.
// The Database review screen's backend (review-only; see identityReview.ts). Created lazily, on the first request.
let identityReview: IdentityReview | null = null;
function reviewService(): IdentityReview {
  identityReview ??= new IdentityReview(
    {
      readReviewInput: () => store.readReviewInput(),
      applyCorrection: (batchId, item) => store.applyCorrection(batchId, item),
      undoCorrection: (batchId, proposalId) => store.undoCorrection(batchId, proposalId),
      backupDatabase: (file) => store.backupDatabase(file),
    },
    path.join(app.getPath("userData"), "identity-review"),
    { decisionsEnabled: () => config.databaseReview?.decisions === true, applyEnabled: () => config.databaseReview?.apply === true },
  );
  return identityReview;
}

// Beta 14: Clynx researching products it is unsure about on the web (Google/Brave API when configured, the free engines otherwise). See knowledgeService.ts.
let knowledgeService: KnowledgeService | null = null;
function getKnowledgeService(): KnowledgeService {
  knowledgeService ??= createKnowledgeService({
    store: {
      getKnowledge: (k) => store.getKnowledge(k),
      saveKnowledge: (k) => store.saveKnowledge(k),
      listSiblingNames: (name) => store.listProductIndex().filter((p) => familyKey(p.name) === familyKey(name)).map((p) => p.name),
    },
    mode: () => beta13Flags(config).webKnowledge,
    usage: (key, count) => store.addUsage(key, count ?? 1),
    graph: () => store.knowledgeGraph(),
    web: () => webHardDeps(),
    ai: () => (hasOpenAIAccess() ? openAiKnowledgeAi() : undefined),
    log: (message, productName) => {
      const line: LogLine = { ts: Date.now(), level: "info", message, productName };
      recordLog(line);
      sendToRenderer("engine:log", line);
    },
  });
  return knowledgeService;
}

let visualService: ReturnType<typeof createVisualService> | null = null;
function getVisualService() {
  visualService ??= createVisualService({
    graph: () => store.knowledgeGraph(),
    web: () => webHardDeps(),
    observer: () => (hasOpenAIAccess() ? openAiObserver() : null),
    themes: () => (hasOpenAIAccess() ? openAiThemeClassifier() : undefined),
    mode: () => (beta13Flags(config).visualResearch === "off" ? "off" : "shadow"),
    usage: (key, count) => store.addUsage(key, count ?? 1),
    lowAi: () => isLowAiMode(),
  });
  return visualService;
}

let openAiSearchConfigured = false;
function applyIdentitySafeguard(): void {
  setFilingRecorder((d) => noteDecision(d));
  if (!openAiSearchConfigured) {
    openAiSearchConfigured = true;
    // read live: switching beta13.openaiSearch in config.json takes effect without a restart of this wiring
    configureFreeEngines(() => config.freeSearchEngines === true);
    configureOpenAiSearch({ enabled: () => beta13Flags(config).openaiSearch && hasOpenAIAccess(), lowAi: () => isLowAiMode(), perHour: Math.max(1, config.openaiSearchPerHour ?? OPENAI_SEARCH_UNLIMITED) }, { perHour: Math.max(1, config.openaiLookupPerHour ?? OPENAI_SEARCH_UNLIMITED) });
  }
  getKnowledgeService().install();
  const mode = config.identitySafeguard?.mode === "shadow" || config.identitySafeguard?.mode === "enforce" ? config.identitySafeguard.mode : "off";
  store.setIdentitySafeguard(mode, mode === "off" ? null : createSafeguardLogger(path.join(app.getPath("userData"), "logs")));
  if (mode !== "off") console.log(`[identity] safeguard mode: ${mode}`);
  // Beta 13: the best-match resolver (productResolver.ts). "shadow" keeps today's answer and records every disagreement in AI Activity; "enforce" uses the best match.
  const resolverMode = beta13Flags(config).resolver;
  store.setResolverMode(
    resolverMode,
    resolverMode === "off"
      ? null
      : (m) => noteDecision({ kind: "product_resolver", subject: m.subject, verdict: m.mode === "enforce" ? `used: ${m.resolved ?? "nothing (" + m.status + ")"}` : `would use: ${m.resolved ?? "nothing (" + m.status + ")"}`, thought: `Today's lookup chose ${m.legacy ?? "nothing"}. ${m.why}.` })
  );
}

function scheduleIdentityBackfill(): void {
  if (config.identityFoundation?.schema !== true || config.identityFoundation?.backfill !== true) return;
  const target = store;
  if (!target.identity) return;
  const step = () => {
    if (store !== target || !target.identity) return;
    try {
      const r = target.identity.backfillStep(20);
      if (!r.done) setTimeout(step, 100);
    } catch (err) {
      console.error(`[identity] backfill stopped: ${(err as Error).message}`);
    }
  };
  // (CLYNX_IDENTITY_BACKFILL_DELAY_MS only exists so the integration tests need not wait a minute.)
  setTimeout(step, Number(process.env.CLYNX_IDENTITY_BACKFILL_DELAY_MS) || 60_000);
}

// Research in progress (Database lookups, eBay comps): an automatic update waits for it, the same way it waits for a scan.
let researchActive = 0;
// True while the person is at the keyboard with Clynx in front (any input in the last minute): an automatic update should not close the window under their hands.
function personIsUsingClynx(): boolean {
  try {
    return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused() && powerMonitor.getSystemIdleTime() < 60;
  } catch {
    return false;
  }
}
// What the evidence check has already concluded this session, so a later question about the same product reuses it instead of contradicting or
// repeating it (the Database keeps the same verdicts across sessions: see Store.setProductVariantEvidence / recordVariantClaim).
const variantVerdictMemory = createVerdictMemory();
const verifyClaim = makeClaimVerifier({
  memory: variantVerdictMemory,
  persisted: (claim, parent) => {
    const entry = store.getProductByName(claim);
    if (entry?.variantEvidence) return entry.variantEvidence;
    const lower = claim.toLowerCase();
    return store.getProductById(parent.id)?.variantClaims.find((c) => c.claim.toLowerCase() === lower) ?? null;
  },
  check: (claim, parent, userUrls) => {
    const family = store.getProductById(parent.id)?.family ?? null;
    const brandHints = [family?.split(">")[0].trim() ?? ""].filter(Boolean);
    return verifyVariant(claim, webVerifyDeps(), { brandHints, userUrls, maxSteps: 7 });
  },
});

/** A research that has not finished after this long is stopped and shown as failed (Beta 28 live test: one sat on "Looking into it" for 15+ minutes behind overlapping browser launches). */
const RESEARCH_WATCHDOG_MS = 12 * 60_000;

async function runProductLookup(...args: Parameters<typeof runProductLookupInner>): Promise<void> {
  researchActive++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stuck = new Promise<"stuck">((resolve) => {
      timer = setTimeout(() => resolve("stuck"), RESEARCH_WATCHDOG_MS);
    });
    const outcome = await Promise.race([runProductLookupInner(...args).then(() => "done" as const), stuck]);
    if (outcome === "stuck") {
      const [id, name] = args;
      const friendly = "This research took too long, so I stopped it. I'll try it again by myself.";
      console.error(`[research] "${name}" was still running after ${Math.round(RESEARCH_WATCHDOG_MS / 60_000)} minutes and was stopped`);
      discovery.note(id, "warn", friendly);
      store.markResearchFailed(id, friendly);
      activeResearch.delete(id);
      broadcastResearchStatus();
      discovery.finish(id, "failed");
      const updated = store.getProductById(id);
      if (updated) sendToRenderer("products:updated", updated);
    }
  } finally {
    if (timer) clearTimeout(timer);
    researchActive--;
  }
}
async function runProductLookupInner(
  id: string,
  name: string,
  // Per explicit instruction — set true only for a sibling THIS function
  // itself is auto-creating (see discoverAndCreateSiblingProducts below),
  // so that product's own completion doesn't fan out into ANOTHER round of
  // discovery — without this, 5 auto-added Nintendo 3DS games would each
  // separately go looking for 5 more, compounding into dozens of API calls
  // and products from one single listing. A real, user/scanner-triggered
  // product always discovers its own siblings once; siblings never do.
  // forcedFamily: also set only for an auto-discovered sibling — its own
  // AI-assigned family gets overridden with the EXACT path that triggered
  // its discovery (e.g. "Nintendo 3DS > Games > Nintendo 3DS") rather than
  // trusting a second, separate AI call to independently re-derive and
  // normalize to the same string. resolveFamilyName's fuzzy matching would
  // probably land in the same place anyway, but "definitely the same
  // folder" beats "probably" for something created specifically to belong
  // there.
  // Condition-awareness — see fetchAndStoreEbayComps' own currentListing
  // param. Only set by call sites that genuinely have a live, current
  // listing in scope; everything else keeps today's behavior.
  // source: why this product is being looked into (shown on its Discovery entry).
  opts: { skipSiblingDiscovery?: boolean; forcedFamily?: string; triggeringListing?: { title: string; imageDataUri?: string | null }; source?: DiscoverySource; verdict?: VariantVerdict | null } = {}
): Promise<void> {
  // A user-picked thumbnail (see products:pickThumbnail) is deliberate —
  // research finding (or not finding) a photo of its own should never
  // silently overwrite it. updateProductProfile always writes imageUrl
  // unconditionally, so preserving it means explicitly passing the
  // CURRENT value back through, not just omitting the new one.
  const before = store.getProductById(id);
  const keepThumbnail = before?.keepThumbnail ?? false;
  // Captured before this product's own family gets resolved/written below —
  // "did this product already have a family" is what tells
  // discoverAndCreateSiblingProducts apart a first-time research (worth
  // checking for siblings) from a Refresh of something already tracked
  // (already checked once, don't do it again every refresh).
  const hadFamilyBefore = before?.family != null;
  activeResearch.set(id, { id, name, reaction: null });
  broadcastResearchStatus();
  const source = opts.source ?? "scanner";
  discovery.begin(
    id,
    name,
    source,
    source === "you"
      ? `You asked me to look into "${name}". Let me dig in.`
      : source === "refresh"
        ? `Refreshing what I know about "${name}".`
        : source === "related"
          ? `"${name}" is related to something I just researched, so I'm looking into it too.`
          : source === "variant"
            ? `Finding out what broken and for-parts copies of this sell for.`
            : `I came across "${name}" while scanning. Let me find out what it really is and what it's worth.`
  );
  if (opts.triggeringListing?.title) discovery.note(id, "step", `The listing that caught my eye: "${opts.triggeringListing.title}".`);
  let researchFailed = false;
  try {
    const result = await lookupProduct(name, { verdict: opts.verdict ?? before?.variantEvidence ?? null });
    // Nothing usable came back (search blocked, AI paused...): never saved as the description. The catch below marks the product "needs retry" and leaves what it already has alone.
    if (result.failed) throw new Error(result.failed.reason);
    // Reaction is available as soon as the main research call resolves —
    // broadcast it right away rather than waiting for the remaining steps
    // below (eBay comps, sibling discovery) to also finish, so the
    // Research tab shows it as soon as it genuinely exists.
    const inFlight = activeResearch.get(id);
    if (inFlight) {
      inFlight.reaction = result.reaction;
      broadcastResearchStatus();
    }
    if (result.reaction) discovery.note(id, "reaction", result.reaction);
    discovery.note(id, "step", `Filing it under ${result.category}${result.family ? ` / ${result.family}` : ""}.`);

    // Per explicit instruction: when the family the AI just assigned is
    // itself a real, recognizable brand (Nintendo, Nike, Xbox, ...) rather
    // than an invented grouping, that brand's own logo becomes the family
    // FOLDER's thumbnail in the Database UI (see Database.tsx's FamilyTile)
    // instead of whichever member product happened to have a photo first.
    // Resolved against the canonical family path first (same normalization
    // updateProductProfile applies) so the logo lookup/reuse keys off the
    // same name every product in this family will actually be stored
    // under. Checks for an already-fetched logo (see store.ts's
    // getFamilyLogoUrl) before running a fresh "<brand> logo" image search
    // — the SECOND Xbox product researched should reuse the first one's
    // logo, not search for it again — and only bothers searching at all
    // when isBrandFamily actually said yes, since most families are just
    // organizational groupings with no real logo to find.
    const resolvedFamily = opts.forcedFamily ?? store.resolveFamilyName(result.family);
    let familyLogoUrl: string | null = null;
    if (resolvedFamily) {
      const topLevelFamily = resolvedFamily.split(">")[0].trim();
      familyLogoUrl = store.getFamilyLogoUrl(topLevelFamily);
      if (!familyLogoUrl && result.isBrandFamily) {
        // findBrandLogoImage now vision-verifies each candidate itself
        // (Wikidata's logo property first, then a web search) and returns
        // an already-downloaded data: URI, not a remote URL.
        familyLogoUrl = await findBrandLogoImage(topLevelFamily);
      }
      // Per explicit instruction: a sub-grouping WITHIN the family ("Xbox >
      // Games", "Xbox > Accessories", and one level deeper still for a
      // generation-specific bucket like "Xbox > Games > Xbox 360") is a
      // bucket of similar items, not a specific product and not the
      // family's own brand — it gets its OWN representative photo (e.g. a
      // generic "Xbox games" shot) instead of either the brand logo above
      // or an arbitrary member's own photo (see Database.tsx's FamilyTile).
      // Fire-and-forget: fetching/caching happens in the background (see
      // ensureGroupThumbnail) and pushes its own live update once ready,
      // rather than making this research call wait on it.
      const familySegments = resolvedFamily.split(">").map((s) => s.trim());
      for (let len = 2; len <= familySegments.length; len++) {
        ensureGroupThumbnail(familySegments.slice(0, len));
      }
    }
    // Per explicit instruction — Library's own home-screen category tiles
    // (the top-level "Video Games & Consoles"/"Electronics"/etc. grid, NOT
    // the folder tiles you drill INTO — those keep their existing collage)
    // get a dedicated AI-generated photo with a consistent text label
    // instead (see webResearch.ts's generateCategoryImage). Same
    // fetch-once-cache-forever/fire-and-forget shape as ensureGroupThumbnail
    // right above — category is a small, fixed list (Database.tsx's
    // CATEGORY_ORDER), so this naturally converges to covering all of them
    // the first time each one is ever actually assigned to a product.
    ensureCategoryThumbnail(result.category);

    // Per explicit instruction: once the AI has confidently named an exact,
    // real product (which is the only way a product gets auto-created at
    // all — see onNewProductFound/listings:research below), its Database
    // thumbnail should be a clean, representative photo found via web
    // search rather than whatever real listing photo happened to trigger
    // it — that real photo is still preserved, just in the Reference
    // Photos gallery now instead of as the main thumbnail (see those two
    // callers). Falls back to keeping whatever was already there
    // (typically that same real listing photo) if the web search didn't
    // turn up an image of its own, so a product's thumbnail never goes
    // BLANK just because the search came up empty.
    let imageUrl = keepThumbnail ? (before?.imageUrl ?? null) : (result.imageUrl ?? before?.imageUrl ?? null);
    if (!imageUrl) {
      // Per explicit instruction — the web search above came up completely
      // empty and there's nothing existing to fall back to either: build a
      // collage from whatever real reference photos this product already
      // has (see store.addProductImage — onNewProductFound/
      // listings:research already save the triggering listing's own photo
      // here before this function ever runs) rather than leaving the
      // Database card with no photo at all. Returns null itself (leaving
      // the card genuinely blank) only when fewer than 2 usable photos
      // exist to build one from.
      // Beta 13: the best usable reference photo (never a stored collage of the gallery, which froze any contamination into the thumbnail); the Library draws collages itself.
      imageUrl = selectReferenceImages(store.listProductImages(id), 1)[0]?.imageData ?? null;
    }

    store.updateProductProfile(id, {
      aiSummary: result.aiSummary,
      category: result.category,
      family: resolvedFamily,
      familyLogoUrl,
      imageUrl,
    });
    // a write-up from the AI's memory (no page was read) is marked as such; a normal research clears an earlier failure
    store.setResearchState(id, result.sourced ? null : "unsourced", result.sourced ? null : "No web pages could be read for this one, so the description comes from the AI's own knowledge and is not confirmed. Press Research again to look once more.");
    // What the evidence check found about a specific edition/configuration is kept with the product (never replacing a stronger earlier finding
    // with a weaker one), and said on the Discovery feed in plain words.
    if (result.evidence) {
      const kept = reconcileVerdict(store.getProductById(id)?.variantEvidence ?? null, result.evidence);
      store.setProductVariantEvidence(id, kept);
      discovery.note(id, "step", `Evidence check: ${kept.status}. ${kept.basis}`);
      // A confirmed edition carries the name its sources give it ("XBOX Series X 2TB Galaxy Black Special Edition" for "Xbox Series X Galaxy Edition"), unless the person named it themself.
      if (kept.status === "verified" || kept.status === "supported") {
        const adopted = adoptOfficialName(name, kept.officialName, store.getProductById(id)?.nameLocked ?? false, (n) => !!store.getProductByName(n));
        if (adopted) {
          store.editProductProfile(id, { name: adopted });
          discovery.note(id, "step", `The sources call it "${adopted}", so that is its name now.`);
          name = adopted;
        }
      }
    }

    // Stock photos + a reference gallery (see fillReferencePhotos). A brand-
    // new product (no family yet) gets its stock photo as the thumbnail; an
    // existing one only gets one if it has none.
    void fillReferencePhotos(id, name, !keepThumbnail && !hadFamilyBefore);

    // Condition-awareness — a second, independently-failable research step
    // right alongside the eBay-comps one below, same isolated try/catch
    // posture: a failure here (no image found, a dead search) shouldn't
    // undo the research that already succeeded above. Gated on the same
    // Config toggle that gates flaw detection on live listing photos (one
    // switch for both halves, per explicit instruction).
    if (config.researchCondition) {
      try {
        const poorConditionImage = await findPoorConditionProductImage(name);
        if (poorConditionImage) {
          fileImage(store, id, poorConditionImage, { sourceKind: "web", title: null, proposer: "poor-condition-search", kind: "poor_condition", allowUntitled: true }, { mode: identityMode() });
          discovery.note(id, "step", "Found a photo of a damaged one too, so I can tell the difference.");
        }
      } catch (err) {
        console.error(`[webResearch] poor-condition reference photo search failed for "${name}": ${(err as Error).message}`);
      }
    }

    // Per explicit instruction — "we can look at eBay listings" for real
    // sold-comp data, run as its own step after the summary/image research
    // above (see watchcount.ts): search watchcount.com's sold listings for
    // this exact product name, have the AI discard anything that isn't
    // genuinely the same base product (a special edition, different
    // bundle, or unrelated item), then average the sold price and run
    // time across whatever's left. On its own try/catch — a failure here
    // (watchcount unreachable, no results, an AI-call hiccup) shouldn't
    // undo the research that already succeeded above.
    //
    // Per further explicit instruction — "no reason to search watchcount
    // multiple times" for the same product within one scan: this function
    // can genuinely re-run for an already-tracked product (a Refresh, the
    // "Interested" reinforcement path, research_product re-run-if-existing
    // — see the various runProductLookup call sites above), and each of
    // those would otherwise burn another one of watchcount's limited daily
    // lookups on data that hasn't had time to change. Gated on the engine's
    // own per-scan tracking (see ScrapeEngine.hasResearchedEbayComps),
    // which resets every time a fresh scan actually starts.
    // Per explicit instruction — a Config-level master on/off for this
    // automatic step, checked before the existing once-per-scan throttle
    // (see watchCountEnabled's own doc comment in types.ts). Silent when
    // off — this fires on every product research pass, so a log line every
    // time would just be noise for someone who's deliberately turned the
    // whole feature off, unlike the once-per-scan skip below which is
    // worth surfacing since it's a within-scan exception to normal behavior.
    if (!config.watchCountEnabled) {
      // no-op — WatchCount lookups are turned off in Config
    } else if (config.watchCountOncePerScan && getPrimaryEngine().hasResearchedEbayComps(id)) {
      discovery.note(id, "step", "I already checked eBay for this one during this scan, so I'm reusing those numbers.");
      const line: LogLine = {
        ts: Date.now(),
        level: "info",
        message: `Skipped eBay comps for "${name}" — already checked once this scan.`,
      };
      recordLog(line);
      sendToRenderer("engine:log", line);
    } else {
      try {
        await fetchAndStoreEbayComps(id, name, opts.triggeringListing);
      } catch (err) {
        console.error(`[watchcount] eBay comps research failed for "${name}": ${(err as Error).message}`);
      }
    }

    // Per explicit instruction: a product landing in a generation-specific
    // "Games" sub-family for the FIRST time (never had one before) is
    // exactly the moment worth proactively researching siblings for — see
    // discoverAndCreateSiblingProducts below. Fire-and-forget: this
    // shouldn't make the listing evaluation that triggered it wait on
    // researching a whole batch of unrelated games.
    if (!opts.skipSiblingDiscovery && !hadFamilyBefore && resolvedFamily && config.autoResearchListings && result.sourced) {
      const segments = resolvedFamily.split(">").map((s) => s.trim());
      if (segments.length >= 3 && segments[1].toLowerCase() === "games") {
        discoverAndCreateSiblingProducts(segments[0], segments[2], result.category, resolvedFamily, id).catch((err) =>
          console.error(`[siblings] discovery failed for "${resolvedFamily}": ${(err as Error).message}`)
        );
      }
    }

    // Per explicit instruction, live: "when the ai is researching a
    // product, have it research other variants of that product... iphone
    // 13... mini, plus, pro, pro max... toyota camry LE, XLE, CE, SE...
    // apply this logic to anything that may have specific models." Unlike
    // the Games-sibling check just above (one narrow case, gated on a
    // specific family-path shape), this runs for EVERY first-time research
    // regardless of category/family — the model itself decides whether
    // named variants genuinely exist (see chat.ts's discoverProductVariants),
    // not this code guessing from category. Fire-and-forget, same reasoning
    // as the sibling discovery above.
    if (!opts.skipSiblingDiscovery && !hadFamilyBefore && config.autoResearchListings) {
      discoverAndCreateProductVariants(name, result.category, resolvedFamily, id, result.sourced).catch((err) =>
        console.error(`[variants] discovery failed for "${name}": ${(err as Error).message}`)
      );
    }
  } catch (err) {
    researchFailed = true;
    // The raw error stays in the log; the person sees a plain note, and the product keeps its description, category and place. It is retried later with growing waits.
    const friendly = friendlyResearchFailure((err as Error).message);
    console.error(`[research] "${name}" could not be researched: ${(err as Error).message}`);
    discovery.note(id, "warn", friendly);
    store.markResearchFailed(id, friendly);
  }
  activeResearch.delete(id);
  broadcastResearchStatus();
  // confirmed editions go under their base product, whichever of the two was researched last
  try {
    for (const link of planParentLinks(store.listVariantLinkRows())) {
      store.setProductParent(link.childId, link.parentId);
      const linked = store.getProductById(link.childId);
      if (linked) {
        sendToRenderer("products:updated", linked);
        discovery.note(link.childId, "step", `Filed under "${store.getProductById(link.parentId)?.name ?? "its base product"}".`);
      }
    }
  } catch (err) {
    console.error(`[variants] could not link editions under their base: ${(err as Error).message}`);
  }
  discovery.finish(id, researchFailed ? "failed" : "done");
  const updated = store.getProductById(id);
  if (updated) sendToRenderer("products:updated", updated);
}

// Per explicit instruction: the first time a product lands in a
// generation-specific "Games" sub-family (e.g. researching "Kirby's Extra
// Epic Yarn" creates "Nintendo 3DS > Games > Nintendo 3DS"), proactively go
// find and add other well-known games for that SAME generation instead of
// only ever picking them up one at a time as listings happen to mention
// them — cartridge/disc-based games are easy to research and photograph
// (see chat.ts's discoverSiblingProducts), so there's no reason to wait.
// Capped at a small, fixed number rather than "as many as possible" —
// each one is a full research pass (an AI call, a web image search), and
// an unbounded "add every game ever made for this console" would be both
// expensive and a good way to flood the Database from one single listing.
const SIBLING_DISCOVERY_COUNT = 3;
// Related products (sibling games, variants) used to be researched strictly one after another: with a lookup taking a minute or more, the Discovery tab
// showed one product at a time and the rest of the list waited. Two at a time is the same total work (the same AI and WatchCount calls) in about half the
// time, and finding an existing entry and creating a missing one are a single synchronous step, so two lookups cannot create the same product.
const RELATED_RESEARCH_CONCURRENCY = 2;

/** Runs `fn` over `items` with at most `limit` running at once; each worker takes the next item as soon as it is free. A failure of one does not stop the others. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        console.error(`[related] research failed: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function discoverAndCreateSiblingProducts(brand: string, generation: string, category: string, familyPath: string, parentId?: string): Promise<void> {
  // Fresh query at call time (not the products list from whenever the
  // triggering research started) — if two different games for the same
  // generation get researched close together, the second one's own
  // discovery pass should already see whatever the first one just added,
  // rather than both independently suggesting (and racing to create) the
  // same handful of titles.
  const alreadyTracked = store
    .listProductIndex()
    .filter((p) => p.family && (p.family === familyPath || p.family.toLowerCase().startsWith(`${familyPath.toLowerCase()} >`)))
    .map((p) => p.name);

  const titles = await discoverSiblingProducts({ brand, generation, category, count: SIBLING_DISCOVERY_COUNT, alreadyTracked });
  if (!titles.length) return;
  if (parentId) discovery.note(parentId, "finding", `Other ${generation} games worth tracking: ${titles.join(", ")}. I'll look into them next.`);

  await forEachLimited(titles, RELATED_RESEARCH_CONCURRENCY, async (title) => {
    // Skip anything that already matches an existing product (exactly or
    // fuzzily) ANYWHERE in the Database, not just this family — a game
    // that's somehow already tracked under a different/wrong family
    // shouldn't get a duplicate entry here; Refresh on the existing one is
    // how that'd get corrected instead.
    if (store.findMatchingProduct(title)) return;
    const candidateId = randomUUID();
    const id = store.addProductStub(candidateId, title);
    if (id !== candidateId) return; // already in the Database under this name
    sendToRenderer("products:updated", store.getProductById(id));
    await runProductLookup(id, title, { skipSiblingDiscovery: true, forcedFamily: familyPath, source: "related" });
  });
}

// Per explicit instruction, live: "when the ai is researching a product,
// have it research other variants of that product... apply this logic to
// anything that may have specific models." General counterpart to
// discoverAndCreateSiblingProducts above — same shape (ask the model, skip
// anything already tracked, full research pass per new variant, never lets
// a variant discover ITS own variants), but runs for any first-time
// research at all, not just a "Games" sub-family. familyPath may be null
// (plenty of products have no family) — a discovered variant still gets
// forcedFamily set to it when present, so it lands in the same folder as
// the product that led to finding it, matching Database.tsx's own
// "Variants" section (findVariantSiblings), which links same-category,
// same-base-name products regardless of family.
const VARIANT_DISCOVERY_COUNT = 5;

// Versions and add-ons of a product (owner decisions 2026-10-20), source-based and repeatable: eBay's item specifics first, then the web catalogues, with the model's memory only as an extra
// hint (variantDiscovery.ts / variantQueue.ts). Everything found goes into a persistent queue with a status per name, so nothing is silently dropped by a cap; a background worker checks a
// few at a time until the queue is empty. A version needs more than one voice to become a Database entry (otherwise it stays a suggestion on the product); an add-on found in a source is
// ALWAYS added as its own accessory entry, filed by the same categorizer the Library uses. A failed research is never saved as text.
async function discoverAndCreateProductVariants(productName: string, category: string, familyPath: string | null, parentId?: string, sourced = true): Promise<void> {
  if (!parentId) return; // the confirmed versions are filed under this product
  if (!sourced) discovery.note(parentId, "finding", "I could not read real web pages for this one yet; I will still check eBay's listings and the catalogues for its versions.");
  // Looking for a product's versions and add-ons costs searches and AI calls for every new product the scanner meets: past the day's ceiling it waits for tomorrow.
  if (remainingBackgroundChecks() <= 0) {
    discovery.note(parentId, "finding", "Today's limit for looking into versions and add-ons in the background is used, so I am not looking for this product's versions now.");
    return;
  }
  const aiOk = hasOpenAIAccess() && !isLowAiMode();
  const result = await gatherCandidates(
    { id: parentId, name: productName },
    {
      store,
      ebaySpecifics: async (name) => (hasEbayCredentials() ? await searchEbayAspects(name) : null),
      editions: async (name) => {
        if (beta13Flags(config).webKnowledge === "off") return null;
        const r = await getKnowledgeService().researchEditions(name, null);
        return r.blocked ? null : r.findings;
      },
      memory: async (name) => (aiOk ? await discoverProductVariants({ productName: name, category, alreadyTracked: [], count: VARIANT_DISCOVERY_COUNT }) : null),
      addonPages: async (name) => (beta13Flags(config).webKnowledge === "off" ? null : await fetchAddonPages(name, webVerifyDeps())),
      note: (m) => discovery.note(parentId, "finding", m),
    }
  );
  const queued = result.queued.variants + result.queued.addons;
  if (queued > 0) discovery.note(parentId, "finding", `Found ${result.queued.variants} version${result.queued.variants === 1 ? "" : "s"} and ${result.queued.addons} add-on${result.queued.addons === 1 ? "" : "s"} to check; I will work through them in the background.`);
  // the first pass waits until this research (and any other) is finished; it never runs inside it
  setTimeout(() => void runVariantQueueTick(familyPath), 45_000);
  scheduleVariantQueue();
}

/** Names (versions and add-ons) checked in the background per day unless config.json says otherwise (backgroundVariantsPerDay). */
const BACKGROUND_VARIANTS_PER_DAY = 40;
function remainingBackgroundChecks(): number {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round(config.backgroundVariantsPerDay ?? BACKGROUND_VARIANTS_PER_DAY)) - store.countCandidateChecksSince(startOfDay.getTime());
}
let variantQueueTimer: ReturnType<typeof setInterval> | null = null;
let variantTickRunning = false;

/** One pass of the version / add-on worker (throttled: a few names, then wait). Never overlaps itself. */
async function runVariantQueueTick(familyHint: string | null = null): Promise<void> {
  if (variantTickRunning) return;
  // never while a research is running (the same eBay browser times out when researches overlap) or while the person is using Clynx; the next timer tick tries again
  if (researchActive > 0 || personIsUsingClynx()) return;
  variantTickRunning = true;
  try {
    const result = await runQueueTick({
      store,
      parentOf: (id) => {
        const p = store.getProductById(id);
        return p ? { id: p.id, name: p.name } : null;
      },
      verify: (name, parent) => verifyClaim(name, parent, []),
      createVariant: async (name, parent, verdict) => {
        const candidateId = randomUUID();
        const id = store.addProductStub(candidateId, name);
        if (id !== candidateId) return null; // already in the Database under this name
        store.setProductParent(id, parent.id);
        store.setProductVariantEvidence(id, verdict);
        sendToRenderer("products:updated", store.getProductById(id));
        discovery.note(parent.id, "finding", `Confirmed from sources and added: ${name}.`);
        await runProductLookup(id, name, { skipSiblingDiscovery: true, forcedFamily: familyHint ?? store.getProductById(parent.id)?.family ?? undefined, source: "related", verdict });
        return id;
      },
      rememberSuggestion: (parent, verdict) => {
        store.recordVariantClaim(parent.id, verdict);
        sendToRenderer("products:updated", store.getProductById(parent.id));
      },
      createAddonEntry: async (name, parent, evidence, sources) => {
        // an add-on the person dismissed on this product never comes back, and gets no entry
        const dismissed = store.listAddons(parent.id).some((x) => x.status === "dismissed" && (addonKey(x.name) === addonKey(name) || sameAddonLoosely(x.name, name)));
        if (dismissed) return null;
        // The entry is found by its EXACT name (a fuzzy match returns the console itself for "Xbox Series X Case"); the base product or its parent is never an add-on's entry.
        const baseRow = store.getProductById(parent.id);
        const existing = store.listProductIndex().find((x) => addonEntryKey(x.name) === addonEntryKey(name) && x.id !== parent.id && x.id !== baseRow?.parentProductId);
        let entryId: string | null = existing?.id ?? null;
        let created = false;
        if (!entryId) {
          const candidateId = randomUUID();
          entryId = store.addProductStub(candidateId, name);
          created = entryId === candidateId;
          if (created) sendToRenderer("products:updated", store.getProductById(entryId));
        }
        // the row on the BASE product's page (switched off, no price) linked to its own entry; the toggle and the rough estimate stay on the base product
        store.linkResearchedAddon(parent.id, name, entryId);
        if (created && entryId) {
          // researched like any product: the categorizer files it (Xbox > Accessories, Xbox > Controllers); its name makes it kind "accessory", so it never prices the console
          await runProductLookup(entryId, name, { skipSiblingDiscovery: true, source: "related", forcedFamily: addonFamilyPath(baseRow?.family ?? null, name) ?? undefined });
        }
        discovery.note(parent.id, "finding", `Add-on "${name}" (${sources.join(" + ")}: ${evidence.slice(0, 2).join(", ") || "a source"}) has its own entry.`);
        return entryId;
      },
      paused: () => !hasOpenAIAccess() || isLowAiMode(),
      remainingToday: remainingBackgroundChecks,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      note: (parentId, message) => discovery.note(parentId, "finding", message),
    });
    if (result.stopped) console.log(`[variants] worker paused: ${result.stopped}; ${result.deferred} left in the queue`);
  } catch (err) {
    console.error(`[variants] worker pass failed: ${(err as Error).message}`);
  } finally {
    variantTickRunning = false;
  }
}

/** Keeps checking the queue every few minutes until it is empty (restarts on launch, since the queue lives in the Database). */
function scheduleVariantQueue(): void {
  if (variantQueueTimer) clearInterval(variantQueueTimer);
  const startStore = store;
  variantQueueTimer = setInterval(() => {
    if (store !== startStore || !hasOpenAIAccess() || researchActive > 0) return;
    if (startStore.nextQueuedCandidates("variant", 1).length + startStore.nextQueuedCandidates("addon", 1).length === 0) return;
    void runVariantQueueTick();
  }, 3 * 60_000);
}

// Per explicit instruction — multiple Facebook accounts: the live status
// map every running account's engine reports into, broadcast as a whole
// (mirrors the activeResearch/research:status pattern built for concurrent
// product research) rather than one flat ScrapeStatus like a single-engine
// setup had. Keyed by account id; Dashboard renders one row/Live panel per
// entry.
const engineStatusMap = new Map<string, ScrapeStatus>();
// Status changes arrive in bursts (every listing viewed, every photo
// analysis step, from every engine). The window only applies a few updates a
// second anyway, so these collapse into one send per ~120ms carrying the
// latest map — less to serialize and ship across the process boundary.
let statusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastEngineStatusMap(): void {
  if (statusBroadcastTimer) return;
  statusBroadcastTimer = setTimeout(() => {
    statusBroadcastTimer = null;
    sendToRenderer("engine:statusMap", Object.fromEntries(engineStatusMap));
  }, 120);
}

// One ScrapeEngine per Facebook account — own persistent Playwright
// profile (own login), own location, all sharing the SAME store/mainWindow
// for everything that's meant to stay global (the product database, the
// blacklist, the Feed). onLog/onListing are the only callbacks that differ
// per account (tagging the account's own identity onto what they emit);
// everything else below is the exact same function reference every
// account's engine gets, unchanged from the single-engine version of this.
function createEngineForAccount(accountId: string): ScrapeEngine {
  function currentAccount(): Account {
    return config.accounts.find((a) => a.id === accountId) ?? config.accounts[0];
  }

  const eng = new ScrapeEngine({
    onIdentityDoubt: (name, signals, evidence) => {
      getKnowledgeService().consider(name, signals);
      if (evidence) getVisualService().consider({ key: evidence.listingId, title: evidence.title, images: evidence.images, description: evidence.description });
    },
    checkMarket: checkMarketBeforeAlert,
    ensureBrokenVariant,
    valueBundle: valueListingBundle,
    onAddonsSeen: (mainName, itemNames, listingId) => {
      const base = store.findMatchingProduct(mainName);
      if (!base) return;
      for (const itemName of itemNames) {
        if (isNoiseAddon(itemName)) continue;
        store.noteAddonSeen(base.id, itemName, listingId);
        // a bundle listing that names it is a source: it is queued to get its own accessory entry too (the worker does it later, never inside the scan)
        const cand = addonFromListing(itemName, listingId, base.name);
        if (cand) store.upsertCandidates(base.id, [cand]);
      }
    },
    profileDir: path.join(PROFILES_ROOT, accountId),
    getConfig: (): EngineConfig => ({ ...config, ...currentAccount() }),
    store,
    onLog: (line) => {
      const account = currentAccount();
      const tagged: LogLine = { ...line, accountId, accountLabel: account.label };
      recordLog(tagged);
      sendToRenderer("engine:log", tagged);
    },
    onListing: (record) => {
      // hasSeen() in scrapeEngine.ts guarantees only the FIRST account to
      // ever encounter a given listing id reaches saveScored/onListing at
      // all — every later account re-scanning the same real listing bails
      // out before either runs — so this only ever attaches attribution
      // once, to whichever account actually found it. The foundByAccountId
      // guard is a belt-and-suspenders safety net against attributing an
      // enrichment re-save (eBay comps, photo analysis) to the wrong
      // account if that assumption is ever wrong.
      if (!record.foundByAccountId) {
        const account = currentAccount();
        store.setListingFoundBy(record.id, accountId, account.label);
        record = { ...record, foundByAccountId: accountId, foundByAccountLabel: account.label };
      }
      sendToRenderer("engine:listing", record);
    },
    onProductUpdated: (product) => sendToRenderer("products:updated", product),
    onReferencePhotoAdded: (productId) => ensurePhotoDifferenceAnalysis(productId),
    // Facebook logged this account out (or stopped it with a security check): a notice that stays on the Dashboard until it is
    // fixed, plus one phone push, since the user is probably not looking at the app. Cleared when the session works again.
    onSessionProblem: (problem) => {
      const noticeId = `fb-session:${accountId}`;
      if (!problem) {
        notices.clear(noticeId);
        return;
      }
      const words = describeSessionProblem(problem, currentAccount().label);
      notices.set({ id: noticeId, severity: "error", title: words.title, message: words.message, action: "open-facebook-login", actionLabel: "Open Facebook", accountId });
      void sendSystemAlert(config, `Clynx: ${words.title}`, words.short);
    },
    // Scan cycles failing several times in a row: say why in plain words, with a Try again button, until one works. One phone push
    // per cause, since a stalled scanner is exactly what the user cannot see from the couch.
    onCycleFailing: (info) => {
      const noticeId = `scan-failing:${accountId}`;
      if (!info) {
        notices.clear(noticeId);
        return;
      }
      const label = currentAccount().label;
      notices.set({ id: noticeId, severity: "error", title: `${info.title} (${label})`, message: info.message, action: "retry-scanner", actionLabel: "Try again", accountId });
      void sendSystemAlert(config, `Clynx: ${info.title}`, info.message);
    },
    onStatus: (status) => {
      // The first time any account is seen logged in, remember it for the first-run checklist.
      if (status.loggedIn === true && config.onboarding && !config.onboarding.facebookConnected) {
        config = { ...config, onboarding: { ...config.onboarding, facebookConnected: true } };
        saveConfig(CONFIG_PATH, config);
        sendToRenderer("config:updated", config);
      }
      engineStatusMap.set(accountId, status);
      broadcastEngineStatusMap();
    },
    onNarrate: narrate,
    onBlacklistUpdated: (terms) => sendToRenderer("blacklist:updated", terms),
    onBlacklistImagesUpdated: (images) => sendToRenderer("blacklistImages:updated", images),
    // The alert itself (sendWatchMatchAlert) and store.recordWatchMatch/
    // markWatchMatchNotified already happened inside scrapeEngine.ts's own
    // recordWatchMatchesIfAny, mirroring exactly how sendDealAlert is called
    // directly from there rather than round-tripping through this file. This
    // callback's only remaining job is pushing the renderer fresh state —
    // same "broadcast the full current list" posture as broadcastWatches()
    // below (not reused directly: that helper is scoped inside
    // app.whenReady, while engines are created at module scope) — so the
    // Watch screen's live match count and the Sidebar's unseen-match pulse
    // update without the user needing to manually refresh.
    onWatchMatch: (watch, info) => {
      sendToRenderer("watches:updated", store.listWatches());
      sendToRenderer("listings:refresh");
      notifyWatchMatch(watch, info);
    },
    // Per explicit instruction — same create-stub + background web research
    // pattern as the manual Research button/research_product chat tool (see
    // listings:research below), just triggered by the scanner itself finding
    // something specific it doesn't track yet, instead of the user asking for
    // it directly. imageDataUri is a REAL photo from the actual listing that
    // triggered this — shown immediately as a placeholder thumbnail (so the
    // tile isn't blank while research runs) AND saved into the Reference
    // Photos gallery as real backing evidence, but per explicit instruction
    // NOT kept as the permanent thumbnail — runProductLookup's web image
    // search now gets to replace it with a clean, representative product
    // photo once research finishes, since this is always a confidently-named
    // exact product to begin with (that's the only way a product gets
    // auto-created at all — see specificSubjects in scrapeEngine.ts).
    onNewProductFound: (name, imageDataUri, sourceTitle, relation) => {
      // A specific model (or color) of an existing entry is filed through createSpecificModel (see productIdentity.ts).
      // Condition-awareness — sourceTitle IS the live listing that just triggered this auto-create, so WatchCount's own
      // query can derive from it directly.
      const { product, created } = relation
        ? createSpecificModel(name, imageDataUri, sourceTitle, relation)
        : { product: createPlainProduct(name, imageDataUri, sourceTitle), created: true };
      const parent = relation?.parentId ? store.getProductById(relation.parentId) : null;
      const sibling = relation && !parent ? store.getProductById(relation.familyFromId) : null;
      if (!created) return;
      const account = currentAccount();
      const line: LogLine = {
        ts: Date.now(),
        level: "info",
        message: `New item of interest found while scanning: added "${product.name}" to the Database${
          parent ? ` under "${parent.name}"` : sibling ? ` next to "${sibling.name}"` : ""
        }${imageDataUri ? " with a photo from this listing" : ""} (from "${sourceTitle}").`,
        productName: product.name,
        accountId,
        accountLabel: account.label,
      };
      recordLog(line);
      sendToRenderer("engine:log", line);
    },
  });
  engineStatusMap.set(accountId, eng.getStatus());
  return eng;
}

// Beta 13: every picture goes through fileImage (identity gate, provenance, review queue); these two wrap it for the common cases.
function identityMode() {
  return beta13Flags(config).identityGate;
}
function fileListingPhoto(productId: string, imageData: string, title: string, proposer: string) {
  return fileImage(store, productId, imageData, { sourceKind: "listing", title, proposer }, { mode: identityMode() });
}
function fileUserPhoto(productId: string, imageData: string) {
  return fileImage(store, productId, imageData, { sourceKind: "user", title: null, proposer: "manual", userAuthored: true }, { mode: identityMode() });
}

// A product the scanner found that nothing in the Database matches: its own entry, with the listing's photo as a
// placeholder (the background lookup replaces it with a clean one), researched in the background.
function createPlainProduct(name: string, imageDataUri: string | null, sourceTitle: string): ProductProfile {
  const id = store.addProductStub(randomUUID(), name);
  if (imageDataUri) {
    store.editProductProfile(id, { imageUrl: imageDataUri });
    fileListingPhoto(id, imageDataUri, sourceTitle, "scanner-new-entry");
    ensurePhotoDifferenceAnalysis(id);
  }
  sendToRenderer("products:updated", store.getProductById(id));
  runProductLookup(id, name, { triggeringListing: { title: sourceTitle, imageDataUri } });
  return store.getProductById(id)!;
}

// A specific model or color of a product already in the Database (see productIdentity.ts): the EVGA card under the
// generic RTX 3060 Ti, the white Xbox Series S next to the black one. `relation.parentId` is the general entry it goes
// under (null: a top-level sibling) and it joins the family of `relation.familyFromId`. If an entry by that name (or
// that exact color) already exists (another account made it a moment ago), its gallery gets the photo instead of a twin.
function createSpecificModel(
  name: string,
  imageDataUri: string | null,
  sourceTitle: string,
  relation: { parentId: string | null; familyFromId: string }
): { product: ProductProfile; created: boolean } {
  const twin = store.getProductByName(name) ?? store.findColorVariant(name);
  if (twin) {
    if (imageDataUri) {
      fileListingPhoto(twin.id, imageDataUri, sourceTitle, "scanner-specific-model");
      ensurePhotoDifferenceAnalysis(twin.id);
      sendToRenderer("products:updated", store.getProductById(twin.id));
    }
    return { product: twin, created: false };
  }
  const familyFrom = store.getProductById(relation.familyFromId);
  const id = store.addProductStub(randomUUID(), name);
  if (relation.parentId) store.setProductParent(id, relation.parentId);
  if (imageDataUri) {
    store.editProductProfile(id, { imageUrl: imageDataUri });
    fileListingPhoto(id, imageDataUri, sourceTitle, "scanner-specific-model");
    ensurePhotoDifferenceAnalysis(id);
  }
  sendToRenderer("products:updated", store.getProductById(id));
  // It lands in the same family as what it is a variant of, and doesn't go hunting for yet more variants of itself.
  runProductLookup(id, name, {
    triggeringListing: { title: sourceTitle, imageDataUri },
    skipSiblingDiscovery: true,
    forcedFamily: familyFrom?.family ?? undefined,
  });
  return { product: store.getProductById(id)!, created: true };
}

// Per explicit instruction — "anything with a blank box icon should also be automatically researched and accounted
// for." A Database entry with no thumbnail is one whose research never finished (the AI was unavailable, the app was
// closed mid-lookup) or that only ever got a stub. Each such entry is tried once per session: a photo it already has
// becomes its thumbnail; one that was never researched gets the full lookup (summary, family, photos, eBay value); one
// that was researched but has no photo gets a reference-photo search. Two at a time, in the background.
const blankSweepAttempted = new Set<string>();
// A sweep does this many entries, then the next one starts a few minutes later: a big library of blank entries is
// worked through steadily instead of in one burst of hundreds of searches and AI checks.
const BLANK_SWEEP_BATCH = 10;
// The wait before the next batch. It used to be 5 minutes after EVERY batch, so a Database with hundreds of blank entries (the Discovery tab
// looked asleep between batches) took hours to work through even when every batch finished cleanly. Now a clean batch is followed by a short
// pause, and the long one is kept for after a problem (an image host or the AI refusing), which is what it was meant to protect against.
const BLANK_SWEEP_GAP_MS = 5 * 60_000;
const BLANK_SWEEP_QUICK_GAP_MS = 30_000;
// Just enough photos to give the entry a thumbnail and a start on a gallery; the manual backfill tops them up.
const BLANK_SWEEP_PHOTOS = 3;
let blankSweepRunning = false;
let lastBlankSweepAt = 0;

// One entry with a blank box: finds it a thumbnail from what it already has, or from a search by its name (and does
// the whole first research if it never had one).
async function researchBlankProduct(id: string): Promise<void> {
  const fresh = store.getProductById(id);
  if (!fresh || fresh.imageUrl || fresh.keepThumbnail || activeResearch.has(id)) return;
  const photos = store.listProductImages(id).filter((img) => img.kind === "normal");
  if (photos.length > 0) {
    store.editProductProfile(id, { imageUrl: photos[0].imageData });
    sendToRenderer("products:updated", store.getProductById(id));
    return;
  }
  // First the free way (no AI, no credits): see findFreeReferencePhotos.
  const free = await findFreeReferencePhotos(fresh.name, { want: BLANK_SWEEP_PHOTOS });
  if (free.length > 0) {
    const kept: string[] = [];
    for (const photo of free) {
      const filed = fileImage(store, id, photo.imageData, { sourceKind: /wikipedia/i.test(photo.label) ? "wikipedia" : "ebay", title: photo.text ?? photo.label, url: photo.url ?? null, proposer: "free-search", picture: null }, { mode: identityMode() });
      if (filed.outcome === "trusted") kept.push(photo.imageData);
    }
    const current = store.getProductById(id);
    if (current && !current.imageUrl && !current.keepThumbnail && kept.length) store.editProductProfile(id, { imageUrl: kept[0] });
    store.touchProduct(id);
    sendToRenderer("products:updated", store.getProductById(id));
  }
  // Then, when AI is available, the full research for an entry that never had it, or the vision-checked photo search
  // for one that still has no photo.
  if (!hasOpenAIAccess()) return;
  if (!fresh.aiSummary) {
    await runProductLookup(id, fresh.name, { skipSiblingDiscovery: true, forcedFamily: fresh.family ?? undefined });
  } else if (free.length === 0) {
    await fillReferencePhotos(id, fresh.name, true, BLANK_SWEEP_PHOTOS);
  }
}

// The entries the user is looking at (a tile scrolled into view, a product page, its variants) don't wait for the slow
// background sweep: each blank one is researched as soon as it is seen, at most once every half hour. Requests go into
// one queue worked by a few workers, so scrolling past a hundred blank tiles doesn't start a hundred searches at once.
const blankViewRequestedAt = new Map<string, number>();
const folderImageAttemptedAt = new Map<string, number>();
const thumbnailQueue: Array<{ id: string; store: Store }> = [];
let thumbnailWorkers = 0;
const THUMBNAIL_WORKERS = 3;
function pumpThumbnailQueue(): void {
  while (thumbnailWorkers < THUMBNAIL_WORKERS && thumbnailQueue.length > 0) {
    const job = thumbnailQueue.shift()!;
    if (job.store !== store) continue; // another user's database by now
    thumbnailWorkers++;
    researchBlankProduct(job.id)
      .catch((err) => console.error(`[database] thumbnail research failed: ${(err as Error).message}`))
      .finally(() => {
        thumbnailWorkers--;
        pumpThumbnailQueue();
      });
  }
}
function ensureThumbnailsFor(ids: string[]): number {
  const now = Date.now();
  let queued = 0;
  for (const id of ids.slice(0, 60)) {
    const p = store.getProductById(id);
    if (!p || p.imageUrl || p.keepThumbnail || activeResearch.has(id) || now - (blankViewRequestedAt.get(id) ?? 0) <= 30 * 60_000) continue;
    blankViewRequestedAt.set(id, now);
    thumbnailQueue.push({ id, store });
    queued++;
  }
  pumpThumbnailQueue();
  return queued;
}
// A research that could not run (search blocked, AI paused) is marked "failed" with a due time (Store.markResearchFailed: 10 min, 30 min, 2 h, 6 h, then it is left alone). This looks
// every few minutes for products that are due and tries them again one at a time, only while the AI is reachable, so a pause that ends fixes itself without a burst.
let researchRetryTimer: ReturnType<typeof setInterval> | null = null;
function scheduleResearchRetries(): void {
  if (researchRetryTimer) clearInterval(researchRetryTimer);
  const startStore = store;
  researchRetryTimer = setInterval(() => {
    if (store !== startStore || !hasOpenAIAccess() || researchActive > 0) return;
    const due = startStore.listResearchRetriesDue(Date.now(), 1);
    for (const p of due) void runProductLookup(p.id, p.name, { source: "refresh", skipSiblingDiscovery: true });
  }, 5 * 60_000);
}

async function sweepBlankProducts(): Promise<void> {
  if (blankSweepRunning) return;
  blankSweepRunning = true;
  lastBlankSweepAt = Date.now();
  const startStore = store;
  let moreToDo = false;
  let problems = 0;
  try {
    const allBlanks = startStore.listBlankProductIndex().filter((p) => !activeResearch.has(p.id) && !blankSweepAttempted.has(p.id));
    if (allBlanks.length === 0) return;
    const blanks = allBlanks.slice(0, BLANK_SWEEP_BATCH);
    moreToDo = allBlanks.length > blanks.length;
    console.log(`[database] ${allBlanks.length} entr${allBlanks.length === 1 ? "y has" : "ies have"} no thumbnail: researching ${blanks.length} now`);
    // Two at a time, but each worker takes the next entry as soon as it is free (before, a pair waited for the slower of the two).
    let next = 0;
    const worker = async () => {
      while (next < blanks.length && store === startStore) {
        const p = blanks[next++];
        blankSweepAttempted.add(p.id);
        try {
          await researchBlankProduct(p.id);
        } catch (err) {
          problems++;
          console.error(`[database] auto-research of "${p.name}" failed: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  } finally {
    blankSweepRunning = false;
    if (moreToDo && store === startStore) setTimeout(() => void sweepBlankProducts(), problems > 0 ? BLANK_SWEEP_GAP_MS : BLANK_SWEEP_QUICK_GAP_MS);
  }
}

// "Make sure Database does not contain duplicate listings": folds together Database entries that are the same product
// (see Store.mergeDuplicateProducts), and repoints the Search For items in config that were linked to a removed one.
// Whether a Watch's check is running right now (the sidebar's Watch eye is awake while it is, asleep otherwise).
let watchSearching = false;

// Beta 13: ONE operations service for the Library, shared by the screen (IPC library:op) and the chat tool. Follows the open Database when the user switches.
let libraryOpsFor: { store: Store; ops: LibraryOps } | null = null;
function libraryOps(): LibraryOps {
  if (!libraryOpsFor || libraryOpsFor.store !== store) {
    libraryOpsFor = {
      store,
      ops: new LibraryOps(store, (what) => {
        for (const id of what.productIds) {
          const p = store.getProductById(id);
          if (p) sendToRenderer("products:updated", p);
        }
        sendToRenderer("library:changed", { folders: what.folders, review: what.review });
      }),
    };
  }
  return libraryOpsFor.ops;
}

function mergeDuplicateProductEntries(): void {
  // Beta 13: duplicates are PROPOSED (a "merge" item in Needs review), never folded together on their own: two entries with the same words are sometimes two products,
  // and a merge moves whole photo galleries. Approving one runs store.mergeDuplicateProducts for that group and re-checks the photos it moved.
  try {
    for (const g of store.findDuplicateGroups()) {
      store.addReviewItem({ kind: "merge", subjectId: g.key, reasons: [`${g.ids.length} entries reduce to the same words: ${g.names.map((n) => `"${n}"`).join(", ")}`], evidence: { ids: g.ids, names: g.names } });
    }
  } catch (err) {
    console.error(`[database] duplicate check failed: ${(err as Error).message}`);
  }
}

// Beta 13: the one-time, non-destructive suspect pass over existing photos (store.markSuspectImages): a photo whose own source title contradicts the entry it is filed
// under is set aside for review (not deleted). A verified backup is taken first; the pass runs in small steps a little after start so it never blocks the app.
// Library folder pictures: decorative generated pictures (never product evidence) or a fitting member photo; see folderArtService.ts.
function openAiImageGenerator(): ImageGenerator | null {
  if (!hasOpenAIAccess()) return null;
  return {
    async draw(prompt) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await callOpenAI("images", { model: OPENAI_IMAGE_MODEL, prompt, size: "1024x1024", n: 1 }, controller.signal, "library folder picture");
        if (!res.ok) throw new Error(`the image service answered ${res.status}`);
        const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) throw new Error("no image came back");
        return { dataUri: `data:image/png;base64,${b64}`, costUsd: IMAGE_COST_ESTIMATE_USD };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
let folderArtFor: { store: Store; svc: ReturnType<typeof createFolderArtService> } | null = null;
function folderArt() {
  if (!folderArtFor || folderArtFor.store !== store) {
    folderArtFor = {
      store,
      svc: createFolderArtService({
        store,
        ops: () => libraryOps(),
        generator: () => openAiImageGenerator(),
        // automatic generation costs credits: off in Save-credits mode and when switched off in config.json
        autoGenerate: () => config.folderArt?.generate !== false && !isLowAiMode(),
        limits: () => ({ perDay: config.folderArt?.perDay ?? DEFAULT_LIMITS.perDay, perDayManual: config.folderArt?.perDayManual ?? DEFAULT_LIMITS.perDayManual }),
        changed: () => sendToRenderer("library:changed", { folders: true, review: false }),
      }),
    };
  }
  return folderArtFor.svc;
}
let folderArtTimer: ReturnType<typeof setTimeout> | null = null;
/** Looks over the automatic folders soon (debounced): called after research and at start-up, never because the Library was opened. */
function scheduleFolderArt(delayMs = 15_000): void {
  if (folderArtTimer) clearTimeout(folderArtTimer);
  const target = store;
  folderArtTimer = setTimeout(() => {
    folderArtTimer = null;
    if (store !== target || !target) return;
    void folderArt().refresh().catch((err) => console.error(`[folder-art] ${(err as Error).message}`));
  }, delayMs);
}

function scheduleSuspectPass(): void {
  const target = store;
  // the Trash empties itself after 30 days (and nothing else ever purges)
  setTimeout(() => {
    try {
      if (store === target) target.purgeTrash(TRASH_RETENTION_MS);
    } catch (err) {
      console.error(`[database] trash purge failed: ${(err as Error).message}`);
    }
  }, 60_000);
  if (!target || target.suspectPassDone()) return;
  const step = () => {
    if (store !== target) return;
    try {
      const r = target.markSuspectImages({ limit: 100 });
      if (r.looked === 0) {
        target.finishSuspectPass();
        sendToRenderer("library:changed", { folders: false, review: true });
        console.log("[database] suspect-photo pass finished");
        return;
      }
      setTimeout(step, 50);
    } catch (err) {
      console.error(`[database] suspect-photo pass stopped: ${(err as Error).message}`);
    }
  };
  setTimeout(async () => {
    try {
      await runDatabaseBackup(true);
    } catch {
      /* the backup is a courtesy: the pass changes only a status column and is reversible */
    }
    step();
  }, 25_000);
}

// Called after any accounts CRUD (add/remove) — creates a ScrapeEngine for
// each account that doesn't have one yet, and for one that's been removed,
// stops it and deletes its profile directory (best-effort: a failure here
// is logged, not thrown, since it shouldn't block the removal itself from
// completing).
function syncEnginesWithAccounts(): void {
  for (const account of config.accounts) ensureEngineFor(account.id);
  const currentIds = new Set(config.accounts.map((a) => a.id));
  for (const [id, eng] of engines) {
    if (currentIds.has(id)) continue;
    engines.delete(id);
    engineStatusMap.delete(id);
    restartGuards.delete(id);
    eng
      .shutdown()
      .catch((err) => console.error(`[accounts] failed to stop removed account ${id}: ${(err as Error).message}`))
      .finally(() => {
        try {
          rmSync(path.join(PROFILES_ROOT, id), { recursive: true, force: true });
        } catch (err) {
          console.error(`[accounts] failed to delete profile dir for removed account ${id}: ${(err as Error).message}`);
        }
      });
  }
  broadcastEngineStatusMap();
}

// Multi-user login migration — engines used to be populated for every
// configured account right here at module load. Population now happens
// inside bootstrapUserSession below, once a real per-user config has been
// loaded (a fresh, logged-out app has no accounts to create engines for at
// all yet). Same reasoning for watchScheduler just below: both depend on
// `store`/`config` actually being this USER's, not module scope defaults.
let watchScheduler!: WatchScheduler;
let ebayEngine!: EbayEngine;

// Multi-user login migration — every one of these path constants used to be
// a fixed, install-wide location computed straight off baseDir. Per
// explicit instruction, each logged-in user now gets a fully separate slice
// of local state (own Facebook accounts/browser profiles, own scan
// history/Database, own config down to theme/ntfy/seller-risk/everything
// else in Store) — achieved ENTIRELY by pointing CONFIG_PATH/DB_PATH/
// PROFILES_ROOT at a `data/users/<userId>/` subfolder before the rest of
// startup ever runs, with zero changes needed to store.ts's schema,
// scrapeEngine.ts, or any of the ~120 IPC handlers below that already just
// read/write these three module variables and `config`/`store` directly.
//
// First-login migration: a real pre-multi-user install already has its one
// (implicit, only) user's data sitting at the OLD flat top-level locations
// (LEGACY_CONFIG_PATH/LEGACY_DB_PATH/LEGACY_PROFILES_ROOT). The very first
// time this ever runs on such an install (USERS_ROOT doesn't exist yet at
// all — checked once, before creating it), that data is COPIED (never
// moved — the originals are left in place untouched as a safety net) into
// whichever user happens to log in first. A second user's first login (or
// this same user logging in again later) never re-triggers this, since
// USERS_ROOT already exists by then.
function configurePathsForUser(userId: string): void {
  const isFirstEverLogin = !existsSync(USERS_ROOT);
  const userRoot = path.join(USERS_ROOT, userId);
  mkdirSync(userRoot, { recursive: true });

  CONFIG_PATH = path.join(userRoot, "config.json");
  DB_PATH = path.join(userRoot, "scout.db");
  PROFILES_ROOT = path.join(userRoot, "browser-profiles");

  if (!isFirstEverLogin) return;

  try {
    if (!existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH)) {
      copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    }
  } catch (err) {
    console.error("[migration] failed to copy legacy config.json:", err);
  }
  try {
    if (!existsSync(DB_PATH) && existsSync(LEGACY_DB_PATH)) {
      copyFileSync(LEGACY_DB_PATH, DB_PATH);
      // node:sqlite's WAL-mode sidecar files, if present — copying only the
      // main file and leaving these behind can lose the most recent
      // not-yet-checkpointed writes.
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(LEGACY_DB_PATH + suffix)) copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.error("[migration] failed to copy legacy scout.db:", err);
  }
  try {
    if (!existsSync(PROFILES_ROOT) && existsSync(LEGACY_PROFILES_ROOT)) {
      cpSync(LEGACY_PROFILES_ROOT, PROFILES_ROOT, { recursive: true });
    }
  } catch (err) {
    console.error("[migration] failed to copy legacy browser-profiles:", err);
  }
}

// Multi-user login migration — the shared teardown sequence, factored out so
// both an actual app quit (window-all-closed/before-quit below) and a
// deliberate auth:logout call stop EXACTLY the same things, in the same
// order, rather than maintaining two copies. A no-op if no user is currently
// logged in (e.g. the app is closed straight from the LoginScreen, before
// store/watchScheduler/the sync services were ever constructed).
async function stopUserSession(): Promise<void> {
  if (!hasActiveUserSession) return;
  watchScheduler.stop();
  ebayEngine.stop();
  watchSyncService.stop();
  listingIngestSyncService.stop();
  feedbackSyncService.stop();
  productSyncService.stop();
  if (cloudHeartbeatTimer) {
    clearInterval(cloudHeartbeatTimer);
    cloudHeartbeatTimer = null;
  }
  cloudClient.stopAuthRefresh();
  await Promise.all([...engines.values()].map((e) => e.shutdown()));
}

// Multi-user login migration — the actual "rest of startup" that used to run
// unconditionally at module scope (store, the 4 sync services, every
// account's engine, watchScheduler) now runs here instead, once — and every
// time — a user is actually known: a fresh interactive login/register, or a
// silently-restored session on relaunch (see the auth:* IPC handlers below).
// Deliberately does NOT touch window creation or any of the ~120 existing
// ipcMain.handle/.on registrations — those stay registered once at
// app.whenReady() exactly as before (Electron disallows registering the
// same channel twice, and a bare closure registration has no per-user
// effect of its own); what actually changes per-user is the STATE those
// closures already close over (config/store/engines/watchScheduler/the sync
// services), which is exactly what this function (re)builds.
async function bootstrapUserSession(userId: string, email: string): Promise<void> {
  configurePathsForUser(userId);
  discovery.clear();

  notices.clearAll(); // a different user (or a fresh start) must not inherit the last one's problems
  config = loadConfig(CONFIG_PATH);
  const localOnly = isLocalMode();
  // Scanning needs Google Chrome or Microsoft Edge on this computer (an installed Clynx carries no browser of its own): say so plainly, with a way to fix it.
  syncAiKeyNotice();
  const browserCheck = checkBrowsers();
  if (!browserCheck.preferred) {
    notices.set({ id: "no-browser", severity: "error", title: "Clynx needs Google Chrome", message: browserCheck.instructions, action: "open-browser-download", actionLabel: "Get Google Chrome" });
  }
  const configNotice = takeConfigLoadNotice();
  if (configNotice) {
    const where = configNotice.savedCopy ? ` The damaged file was kept as ${path.basename(configNotice.savedCopy)} in your Clynx data folder.` : "";
    notices.set({
      id: "config-damaged",
      severity: "warning",
      title: configNotice.kind === "restored" ? "Your settings file was damaged and restored" : "Your settings file was damaged and reset",
      message:
        configNotice.kind === "restored"
          ? `Clynx put back your last good settings, so nothing was lost except possibly your most recent change.${where}`
          : `Clynx could not read your settings, so they start from the defaults. Check Config and re-enter anything that looks wrong.${where}`,
      action: "dismiss",
      actionLabel: "Got it",
    });
  }
  // Per explicit instruction — cloud auth IS how the user got into the app
  // at all now; there's no scenario left where you're logged in but cloud
  // sync is "disabled". apiUrl always mirrors the install-level Server URL
  // the LoginScreen actually authenticated against (appSettings.cloudApiUrl,
  // kept in sync with whatever server was used at login — see the auth:login/
  // auth:register handlers), not something set through the Config screen.
  config = { ...config, cloud: { enabled: !localOnly, apiUrl: appSettings.cloudApiUrl } };
  saveConfig(CONFIG_PATH, config);

  // A restore the user asked for last time is carried out first: the current database is moved aside (kept), and the chosen backup takes its place.
  const restore = applyPendingRestore(DB_PATH, (p) => quarantineDatabase(p, "before-restore"));
  if (restore) {
    notices.set(
      "error" in restore
        ? { id: "db-restore", severity: "warning", title: "A backup could not be restored", message: restore.error, action: "dismiss", actionLabel: "Got it" }
        : {
            id: "db-restore",
            severity: "info",
            title: "Your Database was restored from a backup",
            message: `Restored ${restore.restoredFrom}.${restore.keptCopy ? ` The Database you had before was kept as ${path.basename(restore.keptCopy)} in your Clynx data folder.` : ""}`,
            action: "dismiss",
            actionLabel: "Got it",
          }
    );
  }
  // A damaged database is moved aside (never deleted) and a fresh one started, instead of the app failing to log in.
  const dbOpen = openWithRecovery(DB_PATH, () => new Store(DB_PATH, { identityFoundation: config.identityFoundation?.schema === true }));
  store = dbOpen.store;
  applyIdentitySafeguard();
  scheduleSuspectPass();
  scheduleFolderArt(45_000);
  if (dbOpen.recovered) {
    const kept = dbOpen.recovered.damagedCopy ? ` The old database was kept as ${path.basename(dbOpen.recovered.damagedCopy)} in your Clynx data folder.` : "";
    notices.set({
      id: "db-recovered",
      severity: "warning",
      title: dbOpen.recovered.requestedByUser ? "Started a fresh database" : "Your database was damaged, so Clynx started a fresh one",
      message: dbOpen.recovered.requestedByUser
        ? `Your Database, Library and Feed start empty again; your settings and Watches sync back from your account.${kept}`
        : `Clynx found a problem (${dbOpen.recovered.reason}). Your settings are untouched and Watches sync back from your account, but the Database, Library and Feed start empty.${kept}`,
      action: "dismiss",
      actionLabel: "Got it",
    });
  }
  // A full check of a large database takes seconds, so it runs in a separate process a while after startup.
  const dbPathChecked = DB_PATH;
  setTimeout(() => {
    void runIntegrityCheckInBackground(dbPathChecked).then((r) => {
      if (DB_PATH !== dbPathChecked || r.ok) return;
      console.error("[db] integrity check failed:", r.detail);
      notices.set({
        id: "db-damaged",
        severity: "error",
        title: "Your database has damage",
        message: `Clynx's check found a problem (${r.detail.slice(0, 160)}). Scanning may keep working, but data could be missing or wrong. "Back up and start fresh" keeps the damaged file for investigation and restarts Clynx with an empty database.`,
        action: "recover-database",
        actionLabel: "Back up and start fresh",
      });
    });
  }, 90_000);
  scheduleDatabaseBackups();
  mergeDuplicateProductEntries();
  scheduleIdentityBackfill();
  // A little after startup, so the app is up and the first scan isn't competing with it.
  setTimeout(() => void sweepBlankProducts(), 8000);
  scheduleResearchRetries();
  scheduleVariantQueue(); // the version / add-on queue lives in the Database: a restart picks up where it stopped
  watchSyncService = new WatchSyncService(store, cloudClient, () => config);
  scheduleListingPhotoShrink(store);
  listingIngestSyncService = new ListingIngestSyncService(store, cloudClient, () => config);
  feedbackSyncService = new FeedbackSyncService(store, cloudClient, () => config);
  productSyncService = new ProductSyncService(store, cloudClient, () => config);

  // Fresh per-user state — a different user must never see the previous
  // user's accounts, engines, activity log, or in-flight research.
  engines.clear();
  engineStatusMap.clear();
  restartGuards.clear();
  recentLogs.length = 0;
  activeResearch.clear();

  for (const account of config.accounts) ensureEngineFor(account.id);

  // Per explicit instruction — Watch operates independently of the Scanner's
  // own on/off state, so this starts unconditionally here, not gated behind
  // any account's start()/the window even existing yet. config.watch.globallyPaused
  // (checked fresh every tick, see watchScheduler.ts) is the only thing that
  // actually pauses it.
  watchScheduler = new WatchScheduler({
    store,
    getConfig: () => config,
    getEngines: () => engines,
    onLog: (message, level) => {
      const line: LogLine = { ts: Date.now(), level: level ?? "info", message };
      recordLog(line);
      sendToRenderer("engine:log", line);
    },
    onChecked: () => sendToRenderer("watches:updated", store.listWatches()),
    onSearchingChange: (searching) => {
      watchSearching = searching;
      sendToRenderer("watch:searching", searching);
    },
  });
  watchScheduler.start();

  // Per explicit instruction — a second listing source alongside the
  // Facebook accounts above (see types.ts's Config.ebay doc comment);
  // starts unconditionally too, same posture as watchScheduler just above —
  // config.ebay?.enabled and hasEbayCredentials() are both checked fresh
  // every tick inside ebayEngine.ts itself, not gated here.
  ebayEngine = new EbayEngine({
    checkMarket: checkMarketBeforeAlert,
    store,
    getConfig: () => config,
    onLog: (line) => {
      recordLog(line);
      sendToRenderer("engine:log", line);
    },
    onListing: (record) => sendToRenderer("engine:listing", record),
    onNarrate: narrate,
    onWatchMatch: (watch, info) => {
      sendToRenderer("watches:updated", store.listWatches());
      sendToRenderer("listings:refresh");
      notifyWatchMatch(watch, info);
    },
    // Per explicit instruction — "a live view of eBay searching just like
    // the Facebook live scraper": drops eBay into the EXACT SAME
    // engineStatusMap/engine:statusMap broadcast every Facebook account
    // already uses (keyed "ebay" instead of a real account id), so
    // Dashboard's existing LiveAccountTile renders it with zero new
    // plumbing on the renderer side beyond listing it in the tile grid.
    onStatus: (status) => {
      engineStatusMap.set("ebay", status);
      broadcastEngineStatusMap();
    },
  });
  ebayEngine.start();

  // Same wiring the old config.cloud.enabled-gated block in app.whenReady
  // used to do once env-based bootstrapAuth had authenticated — the
  // interactive login that got us into bootstrapUserSession at all is what
  // authenticates cloudClient now, so this just starts the pieces that used
  // to wait on that.
  // Local beta mode talks to no Clynx Cloud server at all: no health check, heartbeat or sync.
  if (!localOnly) {
    cloudClient.checkHealth().then((health) => {
      if (!health.ok) console.warn("[cloud] health check failed at startup:", health.error);
    });
    if (!cloudHeartbeatTimer) {
      cloudHeartbeatTimer = setInterval(() => {
        cloudClient.sendHeartbeat().catch((err) => console.error("[cloud] heartbeat threw unexpectedly:", err));
      }, 30_000);
    }
    watchSyncService.start();
    listingIngestSyncService.start();
    feedbackSyncService.start();
    productSyncService.start();
  }

  hasActiveUserSession = true;
  currentUserId = userId;
  void email; // not otherwise needed by this function — kept for signature symmetry with the auth:* handlers' data
  sendToRenderer("config:updated", config);
  resumeScannersAfterUpdate();
}

// After an automatic update restarted Clynx while scanners were running, start those scanners again (once the new version has been up for a short while). The note is deleted first, so a
// scanner that fails or an app that crashes cannot be restarted in a loop.
function resumeScannersAfterUpdate(): void {
  const file = path.join(baseDir, "updates", "resume-scanners.json");
  try {
    if (!existsSync(file)) return;
    const note = JSON.parse(readFileSync(file, "utf-8")) as { accounts?: unknown; at?: string };
    unlinkSync(file);
    const ids = Array.isArray(note.accounts) ? note.accounts.filter((x): x is string => typeof x === "string") : [];
    if (!ids.length || (note.at && Date.now() - Date.parse(note.at) > 30 * 60_000)) return; // an old note is not acted on
    setTimeout(() => {
      for (const id of ids) {
        if (!config.accounts.some((a) => a.id === id && a.enabled)) continue;
        const eng = ensureEngineFor(id);
        if (!eng.getStatus().running) {
          const line: LogLine = { ts: Date.now(), level: "info", message: "Clynx was updated; starting the scanner again." };
          recordLog(line);
          sendToRenderer("engine:log", line);
          eng.start();
        }
      }
    }, 20_000).unref?.();
  } catch (err) {
    console.error("[updates] could not resume scanners after the update:", err);
  }
}

// Records every way a Clynx process can die or hang. The renderer (the window's page) is reloaded when it crashes - the scanner runs in this main
// process, so it keeps going either way - but at most 3 times in 10 minutes, so a page that crashes at once is not reloaded forever.
function watchProcessHealth(): void {
  app.on("render-process-gone", (_event, webContents, details) => {
    diagnostics.record("renderer-gone", { reason: details.reason, exitCode: details.exitCode, url: webContents.getURL() });
    if (details.reason === "clean-exit" || details.reason === "killed" || !mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return;
    if (windowRecovery.tryAcquire()) {
      diagnostics.record("renderer-reloaded");
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      }, 500);
    } else {
      diagnostics.record("renderer-not-reloaded", { note: "crashed more than 3 times in 10 minutes" });
    }
  });
  app.on("child-process-gone", (_event, details) => {
    diagnostics.record("child-process-gone", { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name, serviceName: details.serviceName });
  });
  mainWindow?.on("unresponsive", () => diagnostics.record("window-unresponsive"));
  mainWindow?.on("responsive", () => diagnostics.record("window-responsive-again"));
}

// Where the app's own pages live (see windowSecurity.ts): the dev server when unpackaged, else the bundled renderer folder.
function appOrigin() {
  return { devUrl: process.env["ELECTRON_RENDERER_URL"] ?? null, rendererDir: path.join(__dirname, "../renderer") };
}

// Safety copies of the Database: one a day at most, taken a few minutes after start and re-checked every few hours, written next to the Database, rotated (dbBackups.ts).
let backupTimer: ReturnType<typeof setInterval> | null = null;
let backupRunning = false;
async function runDatabaseBackup(force: boolean) {
  if (backupRunning || !hasActiveUserSession || !store) return null;
  if (!force && config.backups?.enabled === false) return null;
  backupRunning = true;
  const s = store;
  try {
    const r = await createBackup({ dbPath: DB_PATH, copyTo: (dest) => s.backupDatabaseAsync(dest), force });
    if (!r.ok && !r.skipped) {
      console.error("[backup] failed:", r.reason);
      diagnostics.record("backup-failed", { reason: r.reason });
    }
    return r;
  } finally {
    backupRunning = false;
  }
}
function scheduleDatabaseBackups() {
  if (backupTimer) return; // one timer for the whole run; it always acts on the current user's database
  setTimeout(() => void runDatabaseBackup(false), 5 * 60_000);
  backupTimer = setInterval(() => void runDatabaseBackup(false), 6 * 3600_000);
  backupTimer.unref?.();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    // Matches global.css's --bg for the current theme — Electron paints
    // this immediately, well before the page (and its CSS) ever loads, so
    // a mismatch here would show as a wrong-colored flash on launch,
    // especially noticeable in light mode against the dark hardcoded
    // default this used to always be.
    backgroundColor: config.theme === "light" ? "#f5f3fb" : "#0f0b1e",
    autoHideMenuBar: true,
    // Per explicit instruction — the Clynx "C" mark as the window/taskbar
    // icon. Windows normally shows a packaged .exe's own embedded icon
    // (see package.json's build.win.icon) for the taskbar regardless of
    // this option, but `electron-vite dev` runs through the generic
    // Electron binary, which has no such icon — this is what makes the
    // right icon show up during day-to-day development too. __dirname here
    // is the compiled out/main directory, so ../../resources reaches back
    // to the project root's resources/ folder.
    icon: path.join(__dirname, "../../resources/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  // The window only ever shows the app's own pages: links open in the system browser (http/https only), and any navigation away from the app is refused.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = externalLinkTarget(url);
    if (target) void shell.openExternal(target);
    return { action: "deny" };
  });
  const blockForeignNavigation = (event: Electron.Event, url: string) => {
    if (!isAppUrl(url, appOrigin())) {
      event.preventDefault();
      const target = externalLinkTarget(url);
      if (target) void shell.openExternal(target);
    }
  };
  mainWindow.webContents.on("will-navigate", blockForeignNavigation);
  mainWindow.webContents.on("will-redirect", blockForeignNavigation);

  // Per explicit instruction — the user has to actually deal with (save or
  // deliberately discard) unsaved Config changes before the app closes,
  // not lose them silently. Every close attempt is intercepted and handed
  // to the renderer, which shows its own themed Save/Discard/Cancel dialog
  // ONLY when Config actually has unsaved edits (see Config.tsx) — a close
  // with nothing unsaved gets waved through immediately, so this never
  // adds a prompt to the common case.
  mainWindow.on("close", (event) => {
    // Nobody is logged in (login screen, or a login that failed): there are no Config edits to save and nothing in the renderer to answer
    // the question, so the window must simply close. Before this the X did nothing on the login screen.
    // A window whose page has crashed (and was not brought back) cannot answer the unsaved-changes question either, so it must just close.
    if (allowClose || !hasActiveUserSession || mainWindow?.webContents.isCrashed()) return;
    event.preventDefault();
    sendToRenderer("app:closeRequested");
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return; // a second copy is already shutting itself down — don't build a window or register handlers
  diagnostics.beginSession({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform, packaged: app.isPackaged });
  // Renderer permissions (camera, microphone, location, notifications, ...) are never granted; webviews can never be attached; every IPC handler below refuses calls that
  // do not come from the app's own top-level page.
  setSecretCodec({ available: () => safeStorage.isEncryptionAvailable(), encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) });
  loadProtectedEnv();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  const rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    rawHandle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event.senderFrame, appOrigin())) {
        diagnostics.record("ipc-refused", { channel, url: String(event.senderFrame?.url ?? "").slice(0, 200) });
        throw new Error("This request did not come from the app.");
      }
      return listener(event, ...args);
    })) as typeof ipcMain.handle;
  const rawOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = ((channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void) =>
    rawOn(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event.senderFrame, appOrigin())) {
        diagnostics.record("ipc-refused", { channel, url: String(event.senderFrame?.url ?? "").slice(0, 200) });
        return;
      }
      listener(event, ...args);
    })) as typeof ipcMain.on;
  createWindow();
  watchProcessHealth();

  ipcMain.handle("config:get", () => config);
  ipcMain.handle("config:save", (_e, next: Config) => {
    // The checklist state is owned by the main process (the Config screen has no control for it and may hold an older copy).
    // Switches the Config screen has no control for are owned by the main process: a copy held by the screen must never erase them (a hand-set beta13 flag was lost this way).
    const owned: Partial<Config> = {};
    if (config.beta13) owned.beta13 = { ...config.beta13, ...(next.beta13 ?? {}) };
    if (config.openaiSearchPerHour != null && next.openaiSearchPerHour == null) owned.openaiSearchPerHour = config.openaiSearchPerHour;
    config = { ...DEFAULT_CONFIG, ...next, ...owned, onboarding: config.onboarding ?? next.onboarding ?? DEFAULT_CONFIG.onboarding };
    saveConfig(CONFIG_PATH, config);
    applyIdentitySafeguard(); // a changed matching-safeguard mode takes effect at once
    // Safety net for the general save path — the dedicated accounts:*
    // handlers already call this themselves, but if the account roster
    // ever changes via a plain config:save too, engines stay in sync
    // either way.
    syncEnginesWithAccounts();
    // So another mounted view (e.g. Dashboard's Filters box) reflects a
    // change made from the Config screen itself, same as the reverse
    // direction already works via update_config's own broadcast.
    sendToRenderer("config:updated", config);
  });
  ipcMain.handle("config:reset", () => {
    config = { ...DEFAULT_CONFIG };
    saveConfig(CONFIG_PATH, config);
    syncEnginesWithAccounts();
    sendToRenderer("config:updated", config);
    return config;
  });

  // Per explicit instruction — the Dashboard's own Filters box: a quicker,
  // more visible home for the things a user adjusts often (freshness,
  // rotation) than digging into the full Config screen. A single
  // patch-shaped endpoint (not one IPC channel per field) specifically so
  // more filters can be added here later ("I'll have more soon") without
  // new plumbing each time. Patches against the CURRENT authoritative
  // `config`, not a client-sent full snapshot like config:save above —
  // Dashboard only ever has a few fields in view, so round-tripping its own
  // stale copy of the WHOLE config back through config:save risked silently
  // clobbering something changed elsewhere (Config screen, chat) in
  // between. Price range is no longer here — it's per-item now, set at add
  // time (see add_search_item above).
  ipcMain.handle(
    "filters:update",
    (_e, patch: Partial<Pick<Config, "maxListingAgeHours" | "rotateSearchItems" | "rotateSearchItemsCount">>) => {
      config = { ...config, ...patch };
      saveConfig(CONFIG_PATH, config);
      sendToRenderer("config:updated", config);
      restartAllEnginesIfRunning("your filter changes");
    }
  );
  // Forget one of the "Recent searches" (Dashboard > Add product).
  ipcMain.handle("searches:removeRecent", (_e, args: { item: string; minPriceUsd: number | null; maxPriceUsd: number | null; includeBroken?: boolean; acceptVariants?: boolean }) => {
    config = { ...config, recentSearches: removeRecentSearch(config.recentSearches, args) };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
  });
  // Beta 12: flip "Search for variants" on a Search For entry already on the list. It changes which returned listings are accepted, never what is searched, so no
  // scanner restart or extra search is needed; the recent-searches entry is updated so the choice is remembered next launch.
  ipcMain.handle("filters:setSearchItemVariants", (_e, args: { item: string; acceptVariants: boolean }) => {
    const target = config.searchItems.find((s) => s.item === args.item);
    if (!target) return;
    const acceptVariants = args.acceptVariants === true;
    config = {
      ...config,
      searchItems: config.searchItems.map((s) => (s.item === args.item ? { ...s, acceptVariants } : s)),
      recentSearches: pushRecentSearch(removeRecentSearch(config.recentSearches, { item: target.item, minPriceUsd: target.minPriceUsd, maxPriceUsd: target.maxPriceUsd, includeBroken: !!target.includeBroken, acceptVariants: !acceptVariants }), {
        item: target.item,
        minPriceUsd: target.minPriceUsd,
        maxPriceUsd: target.maxPriceUsd,
        linkedProductId: target.linkedProductId ?? null,
        includeBroken: !!target.includeBroken,
        acceptVariants,
      }),
    };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `${acceptVariants ? "Now also accepting variants of" : "Now accepting only"} "${args.item}" (listings Facebook already returns; no extra searches).` };
    recordLog(line);
    sendToRenderer("engine:log", line);
  });
  ipcMain.handle("filters:removeSearchItem", (_e, args: { item: string }) => {
    config = { ...config, searchItems: config.searchItems.filter((s) => s.item !== args.item) };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
    restartAllEnginesIfRunning("your updated Search For list");
    const line: LogLine = { ts: Date.now(), level: "info", message: `Removed from Search For: "${args.item}"` };
    recordLog(line);
    sendToRenderer("engine:log", line);
  });

  // The other half of the close-guard above — the renderer calls this once
  // it's actually fine to close (nothing was unsaved, or the user just
  // chose Save & Close / Discard & Close on its own dialog).
  ipcMain.on("app:confirmClose", () => {
    allowClose = true;
    mainWindow?.close();
  });

  ipcMain.handle("env:hasOpenAIKey", () => !!process.env.OPENAI_API_KEY);
  ipcMain.handle("env:saveOpenAIKey", (_e, key: string): { ok: boolean; error?: string } => {
    const k = String(key ?? "").trim();
    if (k === "") {
      saveEnvKey("OPENAI_API_KEY", "");
      delete process.env.OPENAI_API_KEY;
      syncAiKeyNotice();
      return { ok: true };
    }
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(k)) return { ok: false, error: "That does not look like an OpenAI API key (it starts with sk- and has no spaces)." };
    saveEnvKey("OPENAI_API_KEY", k);
    syncAiKeyNotice();
    return { ok: true };
  });
  // Cloud accounts choose where AI and eBay come from. Switching never deletes anything: saved keys stay on this computer until the person deletes them here.
  ipcMain.handle("account:setApiSource", (_e, args: { source?: string }): { ok: boolean; error?: string } => {
    if (isLocalMode()) return { ok: false, error: "In local mode you use your own keys." };
    if (args?.source !== "shared" && args?.source !== "own") return { ok: false, error: "Choose shared or own." };
    appSettings = { ...appSettings, aiSource: args.source };
    saveAppSettings(appSettings);
    syncAiKeyNotice();
    return { ok: true };
  });
  // Opt-in protection of the saved keys (see envKeys.ts). A full copy of .env is kept first, the keys are verified before the file is replaced, and turning it off restores plain text.
  ipcMain.handle("env:setKeyProtection", (_e, args: { enabled?: boolean }): { ok: boolean; error?: string; changed?: number; copy?: string } => {
    const enabled = args?.enabled === true;
    try {
      const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
      const result = enabled ? protectEnvText(text, protectSecret, revealSecret) : unprotectEnvText(text, revealSecret);
      if (!result.ok) return { ok: false, error: result.error };
      let copy: string | undefined;
      if (result.changed > 0) {
        copy = `.env.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(ENV_PATH, path.join(baseDir, copy));
        writeFileAtomic(ENV_PATH, result.text.endsWith("\n") ? result.text : result.text + "\n");
      }
      appSettings = { ...appSettings, protectKeys: enabled };
      saveAppSettings(appSettings);
      return { ok: true, changed: result.changed, copy };
    } catch (err) {
      return { ok: false, error: `That did not work (${err instanceof Error ? err.message : "unknown error"}). Your keys were not changed.` };
    }
  });
  // Removes the copies of .env that may still hold the keys in plain text. Only on request.
  ipcMain.handle("env:deleteKeyCopies", (): { ok: boolean; removed: number } => {
    let removed = 0;
    for (const f of envCopies()) {
      try {
        unlinkSync(path.join(baseDir, f));
        removed++;
      } catch {
        /* leave it */
      }
    }
    return { ok: true, removed };
  });
  ipcMain.handle("env:deleteSavedKeys", (): { ok: boolean } => {
    for (const k of ["OPENAI_API_KEY", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"]) {
      saveEnvKey(k, "");
      delete process.env[k];
    }
    syncAiKeyNotice();
    return { ok: true };
  });
  ipcMain.handle("env:saveEbayCredentials", (_e, args: { clientId?: string; clientSecret?: string }): { ok: boolean; error?: string } => {
    const id = String(args?.clientId ?? "").trim();
    const secret = String(args?.clientSecret ?? "").trim();
    if (!/^[A-Za-z0-9._-]{8,200}$/.test(id) || !/^[A-Za-z0-9._-]{8,200}$/.test(secret)) return { ok: false, error: "Enter both the eBay App ID (client id) and Cert ID (client secret) exactly as eBay shows them." };
    saveEnvKey("EBAY_CLIENT_ID", id);
    saveEnvKey("EBAY_CLIENT_SECRET", secret);
    return { ok: true };
  });
  ipcMain.handle("env:hasEbayCredentials", () => hasEbayCredentials());
  // Beta 12 — AI Activity (Activity screen): what the paid and market services were asked to do, and the decisions the AI made. Never a key or a token.
  ipcMain.handle("api:activity", () => {
    const src = effectiveApiSource();
    const aiRoute = src === "shared" ? "Clynx Cloud's shared AI. Tokens are used on Clynx Cloud's OpenAI project, so they will NOT appear on an OpenAI account of your own." : "A key saved on this computer. Usage appears in the OpenAI project that key belongs to.";
    const ebayRoute = src === "shared" && cloudClient.isAuthenticated() ? "Clynx Cloud's eBay access (searches are made by the server, not this computer)" : hasEbayCredentials() ? "eBay keys saved on this computer" : "none (no eBay keys on this computer and not using Clynx Cloud's eBay)";
    apiActivity.setSource({ ai: aiRoute, ebay: ebayRoute, note: `Save OpenAI credits mode: ${config.lowAiMode ? "ON (many photo looks and AI judgements are skipped on purpose)" : "off"}. WatchCount (sold prices): ${config.watchCountEnabled ? "on" : "off"}. OpenAI key on this computer: ${process.env.OPENAI_API_KEY?.trim() ? "present" : "none"}. eBay keys on this computer: ${process.env.EBAY_CLIENT_ID?.trim() && process.env.EBAY_CLIENT_SECRET?.trim() ? "present" : "none"}.` });
    return apiActivity.snapshot();
  });
  // A small, bounded real check through the same code paths the app uses (one tiny AI request, one 20-result eBay search, one WatchCount reachability request).
  ipcMain.handle("api:selfTest", () =>
    runApiSelfTest({
      callOpenAI: callOpenAI as SelfTestDeps["callOpenAI"],
      model: OPENAI_MODEL,
      hasOpenAIAccess,
      openAIRoute: () => (effectiveApiSource() === "shared" ? (cloudClient.isAuthenticated() ? "clynx_cloud" : "none") : process.env.OPENAI_API_KEY?.trim() ? "own_key" : "none"),
      hasEbayCredentials,
      searchEbayItems,
      fetch,
    })
  );

  // Per explicit instruction — multiple Facebook accounts: every engine
  // control now takes {accountId} and dispatches to that ONE account's own
  // ScrapeEngine, instead of the single implicit engine a one-account setup
  // used to have.
  ipcMain.handle("engine:statusMap", (): Record<string, ScrapeStatus> => Object.fromEntries(engineStatusMap));
  ipcMain.handle("notices:list", () => notices.list());
  // The first-run checklist: remember what cannot be seen from the state (dismissed, skipped, "nationwide is fine").
  ipcMain.handle("onboarding:update", (_e, patch: Partial<OnboardingState>) => {
    const allowed: Array<keyof OnboardingState> = ["dismissed", "facebookConnected", "locationChosen", "phoneSkipped"];
    const next = { ...(config.onboarding ?? DEFAULT_CONFIG.onboarding!) };
    for (const key of allowed) if (typeof patch?.[key] === "boolean") next[key] = patch[key] as boolean;
    config = { ...config, onboarding: next };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
  });
  // Phone alerts (ntfy) setup: a new private topic, a test message to the server and topic typed on screen (saved or not), and a save
  // that touches only the ntfy settings. Existing topics (and Watches' own topics) are never changed by any of these on their own.
  ipcMain.handle("ntfy:generateTopic", (): string => generateNtfyTopic());
  ipcMain.handle("ntfy:sendTest", (_e, args: { server: string; topic: string }) => sendTestNotification({ ntfy: { server: String(args?.server ?? ""), topic: String(args?.topic ?? "") } }));
  ipcMain.handle("ntfy:save", (_e, args: { server: string; topic: string }): { ok: boolean; message?: string } => {
    const topic = String(args?.topic ?? "").trim();
    const server = String(args?.server ?? "").trim() || config.ntfy.server;
    if (topic && describeTopicStrength(topic) === "invalid") return { ok: false, message: "Topics can only use letters, numbers, dashes and underscores (up to 64 characters)." };
    config = { ...config, ntfy: { ...config.ntfy, server, topic } };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
    return { ok: true };
  });
  // "Show data folder" on the startup-problem screen: the folder holding the user's database and settings (kept files included).
  ipcMain.handle("app:showDataFolder", async () => {
    const folder = DB_PATH.startsWith(USERS_ROOT) ? path.dirname(DB_PATH) : USERS_ROOT;
    await shell.openPath(existsSync(folder) ? folder : baseDir);
  });
  ipcMain.handle("notices:dismiss", (_e, args: { id: string }) => notices.clear(args.id));
  // Config > Account > Support report: a text file the user can send us. Secrets are removed (supportReport.ts); the user chooses where it is saved.
  ipcMain.handle("support:saveReport", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      const picked = await dialog.showSaveDialog(mainWindow as BrowserWindow, { title: "Save support report", defaultPath: path.join(app.getPath("documents"), `clynx-support-report-${new Date().toISOString().slice(0, 10)}.txt`), filters: [{ name: "Text", extensions: ["txt"] }] });
      if (picked.canceled || !picked.filePath) return { ok: false };
      let tail: string[] = [];
      try {
        tail = readFileSync(diagnostics.file, "utf-8").split(String.fromCharCode(10)).filter(Boolean).slice(-200);
      } catch {
        /* no diagnostics yet */
      }
      const backups = listBackups(backupDirFor(DB_PATH));
      let dbBytes: number | null = null;
      try {
        dbBytes = statSync(DB_PATH).size;
      } catch {
        /* none */
      }
      const text = buildSupportReport({
        generatedAt: new Date().toISOString(),
        app: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, osRelease: os.release(), packaged: app.isPackaged },
        config,
        diagnosticsTail: tail,
        notices: notices.list().map((n) => ({ id: n.id, severity: n.severity, title: n.title, message: n.message })),
        cloud: cloudClient.getStatus(),
        database: { bytes: dbBytes, backups: backups.length, newestBackupAt: backups[0] ? new Date(backups[0].takenAt).toISOString() : null },
        build: { version: buildInfo.version, channel: buildInfo.channel, commit: buildInfo.commit, builtAt: buildInfo.builtAt, localMode: isLocalMode() },
        browser: (() => {
          const b = checkBrowsers();
          return { ok: !!b.preferred, using: b.preferred?.label ?? null, found: b.found.map((f) => f.label) };
        })(),
        recentProblems: recentLogs
          .filter((l) => l.level === "warn" || l.level === "error")
          .slice(-60)
          .map((l) => `${new Date(l.ts).toISOString()} ${l.level}: ${l.message.slice(0, 300)}`),
        homeDir: os.homedir(),
      });
      writeFileSync(picked.filePath, text, "utf-8");
      return { ok: true, path: picked.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Config > Backups
  const backupSummary = () => ({
    enabled: config.backups?.enabled !== false,
    folder: backupDirFor(DB_PATH),
    backups: listBackups(backupDirFor(DB_PATH)).map((b) => ({ name: b.name, takenAt: b.takenAt, bytes: b.bytes })),
  });
  ipcMain.handle("backups:list", () => backupSummary());
  ipcMain.handle("backups:now", async () => {
    const r = await runDatabaseBackup(true);
    return { ok: !!r && r.ok, error: r && !r.ok ? r.reason : r ? undefined : "A backup is already running.", ...backupSummary() };
  });
  ipcMain.handle("backups:restore", (_e, args: { name?: string }) => {
    const r = requestRestore(DB_PATH, String(args?.name ?? ""));
    if (!r.ok) return { ok: false, error: r.reason };
    allowClose = true;
    app.relaunch();
    app.quit();
    return { ok: true };
  });
  // Config > Reset Clynx: back to a freshly installed state for THIS user on THIS computer (the sign-in stays). A safety backup is made first and the reset stops if it cannot be.
  // The steps, in this order, each only after the one before succeeded: backup -> stop everything -> (tell Clynx Cloud to forget the synced data) -> empty the Database -> default
  // Config (-> remove the Facebook logins) -> restart. Nothing is erased if the backup fails.
  ipcMain.handle("app:resetClynx", async (_e, args: { confirm?: string; alsoFacebook?: boolean; alsoCloud?: boolean }) => {
    if (args?.confirm !== RESET_CONFIRM_WORD) return { ok: false, error: `Type ${RESET_CONFIRM_WORD} to confirm.` };
    if (!hasActiveUserSession || !store) return { ok: false, error: "Sign in first." };
    const alsoFacebook = args.alsoFacebook === true;
    const alsoCloud = args.alsoCloud === true && cloudClient.isAuthenticated();
    try {
      // 1. safety copies: the normal backup (restorable in Config > Account > Database backups) and a dedicated folder with the database and the Config
      const normal = await runDatabaseBackup(true);
      if (!normal || (!normal.ok && !normal.skipped)) return { ok: false, error: `Nothing was erased: the safety backup could not be made (${normal && !normal.ok ? normal.reason : "another backup is running, try again in a moment"}).` };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const keepDir = path.join(path.dirname(DB_PATH), "reset-backups", stamp);
      mkdirSync(keepDir, { recursive: true });
      await store.backupDatabaseAsync(path.join(keepDir, "scout.db"));
      if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, path.join(keepDir, "config.json"));
      // 2. stop everything that writes
      for (const eng of engines.values()) await eng.stop().catch(() => undefined);
      watchScheduler.stop();
      ebayEngine.stop();
      watchSyncService.stop();
      listingIngestSyncService.stop();
      feedbackSyncService.stop();
      productSyncService.stop();
      // 3. Clynx Cloud keeps synced copies; without this the next sync would bring everything back
      if (alsoCloud) {
        const ids = store.listIdsForCloudReset();
        // also what the server lists: a copy that only the server holds (an older library, another device) would otherwise be pulled straight back after the restart
        let serverProductIds: string[] = [];
        try {
          const listed = await cloudClient.listProducts();
          if (listed.ok && listed.data) serverProductIds = listed.data.products.map((p) => p.localId);
        } catch {
          /* the local reset still goes ahead; the server copies are then left as they were */
        }
        for (const id of idsToQueueOnReset(ids.products, serverProductIds)) store.addPendingCloudDelete("product", id);
        for (const id of ids.watches) store.addPendingCloudDelete("watch", id);
        for (const id of ids.feedback) store.addPendingCloudDelete("feedback", id);
      }
      // 4. the Database
      store.resetAllData();
      try {
        rmSync(path.join(app.getPath("userData"), "identity-review"), { recursive: true, force: true });
      } catch {
        /* nothing to remove */
      }
      // 5. the Config (and, only when asked, the Facebook logins)
      if (alsoFacebook) {
        for (const eng of engines.values()) await eng.shutdown().catch(() => undefined);
        try {
          rmSync(PROFILES_ROOT, { recursive: true, force: true });
        } catch (err) {
          console.error(`[reset] could not remove the Facebook logins: ${(err as Error).message}`);
        }
      }
      config = freshConfig(config, { keepFacebook: !alsoFacebook });
      saveConfig(CONFIG_PATH, config);
      diagnostics.record("reset-clynx", { alsoFacebook, alsoCloud });
      // 6. start again from the saved state, so nothing in memory outlives the reset
      setTimeout(() => {
        allowClose = true;
        app.relaunch();
        app.quit();
      }, 600);
      return { ok: true, backupFolder: keepDir };
    } catch (err) {
      return { ok: false, error: `The reset stopped part-way: ${err instanceof Error ? err.message : String(err)}. Restart Clynx; your safety backup was made first (Config > Account > Database backups).` };
    }
  });
  // "Back up and start fresh": the open database cannot be renamed, so mark it and restart; the next start moves it aside.
  ipcMain.handle("db:recover", () => {
    requestRecovery(DB_PATH);
    allowClose = true;
    app.relaunch();
    app.quit();
  });

  // Multi-user login migration — the interactive login IS the cloud auth
  // now (no more headless CLYNX_CLOUD_EMAIL/PASSWORD env-based bootstrapAuth
  // — see cloudClient.ts). App.tsx calls getSession once on mount, before
  // showing anything else; if it comes back authenticated, bootstrapUserSession
  // has already fully run (engines/watchScheduler/sync services all up) by
  // the time this resolves, so the renderer can safely go straight to the
  // normal app view. Not gated behind any config.cloud.enabled check —
  // there's no "logged in but cloud disabled" state anymore.
  // Bug fix: the renderer asks "am I logged in?" from a mount effect, and
  // in dev (React StrictMode) or on any window reload that can fire twice
  // at essentially the same moment. Both calls used to run restoreSession()
  // with the SAME single-use refresh token; the second one made the cloud
  // see a token being reused, which it treats as theft and answers by
  // revoking every session ("Refresh token reuse detected; all sessions
  // revoked") — logging the user out for no reason. Concurrent callers now
  // share one in-flight check instead of racing.
  type SessionCheck = { authenticated: boolean; userId: string | null; email: string | null; apiUrl: string | null; startupProblem?: StartupProblem };
  // Opens the user's data. If that fails (a damaged database that cannot be moved aside, a full disk, a locked folder) the user gets a
  // plain-words problem on the login screen with a Try again button, instead of a window stuck on "Loading...".
  async function bootstrapOrExplain(userId: string, email: string): Promise<{ ok: true } | { ok: false; problem: StartupProblem }> {
    try {
      await bootstrapUserSession(userId, email);
      return { ok: true };
    } catch (err) {
      console.error("[startup] opening the user's data failed:", err);
      const folder = DB_PATH.startsWith(USERS_ROOT) ? path.dirname(DB_PATH) : USERS_ROOT;
      return { ok: false, problem: describeStartupFailure(err, folder) };
    }
  }
  let sessionCheckInFlight: Promise<SessionCheck> | null = null;
  async function checkOrRestoreSession(): Promise<SessionCheck> {
    if (hasActiveUserSession && currentUserId) {
      if (isLocalMode()) return { authenticated: true, userId: currentUserId, email: null, apiUrl: null };
      const info = cloudClient.getSessionInfo();
      return { authenticated: true, userId: currentUserId, email: info.email, apiUrl: info.apiUrl ?? appSettings.cloudApiUrl };
    }
    if (isLocalMode()) {
      const opened = await bootstrapOrExplain(LOCAL_USER_ID, "");
      if (!opened.ok) return { authenticated: false, userId: null, email: null, apiUrl: null, startupProblem: opened.problem };
      return { authenticated: true, userId: LOCAL_USER_ID, email: null, apiUrl: null };
    }
    const restored = await cloudClient.restoreSession();
    // The server could not be reached (but never said the sign-in is over): carry on with this computer's data for that account; syncing resumes by itself when the connection returns.
    if (restored.offline && restored.userId) {
      const opened = await bootstrapOrExplain(restored.userId, restored.email ?? "");
      if (!opened.ok) return { authenticated: false, userId: null, email: null, apiUrl: restored.apiUrl, startupProblem: opened.problem };
      notices.set(offlineNotice());
      return { authenticated: true, userId: restored.userId, email: restored.email, apiUrl: restored.apiUrl };
    }
    if (restored.ok && restored.userId) {
      if (restored.apiUrl && restored.apiUrl !== appSettings.cloudApiUrl) {
        appSettings = { ...appSettings, cloudApiUrl: restored.apiUrl };
        saveAppSettings(appSettings);
      }
      const opened = await bootstrapOrExplain(restored.userId, restored.email ?? "");
      if (!opened.ok) return { authenticated: false, userId: null, email: null, apiUrl: restored.apiUrl, startupProblem: opened.problem };
      return { authenticated: true, userId: restored.userId, email: restored.email, apiUrl: restored.apiUrl };
    }
    return { authenticated: false, userId: null, email: null, apiUrl: appSettings.cloudApiUrl };
  }
  ipcMain.handle("auth:getSession", (): Promise<SessionCheck> => {
    if (!sessionCheckInFlight) {
      sessionCheckInFlight = checkOrRestoreSession().finally(() => {
        sessionCheckInFlight = null;
      });
    }
    return sessionCheckInFlight;
  });

  // Beta builds only. Starts (or resumes) a session that lives entirely on this computer: its own folder, its own empty Database, no Clynx Cloud account. It grants access to
  // nothing but that local folder, and a build that was not made for the beta (no build-info with channel "beta") refuses it.
  ipcMain.handle("auth:startLocal", async (): Promise<{ ok: boolean; error?: string; startupProblem?: StartupProblem }> => {
    if (!buildInfo.localModeAllowed) return { ok: false, error: "This build of Clynx requires a Clynx account." };
    appSettings = { ...appSettings, localMode: true };
    saveAppSettings(appSettings);
    const opened = await bootstrapOrExplain(LOCAL_USER_ID, "");
    if (!opened.ok) {
      appSettings = { ...appSettings, localMode: false };
      saveAppSettings(appSettings);
      return { ok: false, error: opened.problem.message, startupProblem: opened.problem };
    }
    return { ok: true };
  });
  // What the Beta panel and the login screen need to know.
  ipcMain.handle("beta:info", () => {
    const browsers = checkBrowsers();
    return {
      version: buildInfo.version,
      channel: buildInfo.channel,
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
      localModeAllowed: buildInfo.localModeAllowed,
      localMode: isLocalMode(),
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      localDataExists: buildInfo.localModeAllowed && localDataExists(USERS_ROOT),
      apiSource: effectiveApiSource(),
      cloudApiUrl: appSettings.cloudApiUrl,
      defaultServerUrl: buildInfo.defaultServerUrl,
      hasSavedKeys: hasSavedKeys(),
      keyProtection: { available: safeStorage.isEncryptionAvailable(), on: appSettings.protectKeys === true, plain: envKeyState(existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "").plain, copies: envCopies().length },
      browser: { ok: !!browsers.preferred, using: browsers.preferred?.label ?? null, found: browsers.found.map((b) => b.label), instructions: browsers.instructions, downloadUrl: CHROME_DOWNLOAD_URL },
    };
  });

  ipcMain.handle(
    "auth:login",
    async (_e, args: { apiUrl: string; email: string; password: string; importLocal?: boolean }): Promise<{ ok: boolean; userId?: string; email?: string; error?: string; startupProblem?: StartupProblem; imported?: string }> => {
      const addr = normalizeServerUrl((args.apiUrl || appSettings.cloudApiUrl || "").trim());
      if (!addr.ok) return { ok: false, error: addr.error };
      const apiUrl = addr.url;
      const result = await cloudClient.login(apiUrl, args.email.trim(), args.password);
      if (!result.ok || !result.data) return { ok: false, error: result.error ?? "Login failed" };
      appSettings = { ...appSettings, cloudApiUrl: apiUrl, localMode: false };
      saveAppSettings(appSettings);
      const imported = args.importLocal === true && buildInfo.localModeAllowed ? importLocalData(USERS_ROOT, result.data.userId) : null;
      const opened = await bootstrapOrExplain(result.data.userId, result.data.email);
      if (!opened.ok) return { ok: false, error: opened.problem.message, startupProblem: opened.problem };
      if (imported) {
        notices.set({
          id: "local-import",
          severity: imported.copied ? "info" : "warning",
          title: imported.copied ? "Your local data was copied into this account" : "Your local data was not copied",
          message: imported.copied ? "The original is still on this computer; nothing was deleted. Your Watches and products now sync with your account." : imported.reason,
          action: "dismiss",
          actionLabel: "Got it",
        });
      }
      return { ok: true, userId: result.data.userId, email: result.data.email, imported: imported ? (imported.copied ? "Your local data was copied into this account. The original stays on this computer." : imported.reason) : undefined };
    }
  );

  ipcMain.handle(
    "auth:register",
    async (_e, args: { apiUrl: string; email: string; password: string; importLocal?: boolean; inviteCode?: string }): Promise<{ ok: boolean; userId?: string; email?: string; error?: string; startupProblem?: StartupProblem; imported?: string }> => {
      const addr = normalizeServerUrl((args.apiUrl || appSettings.cloudApiUrl || "").trim());
      if (!addr.ok) return { ok: false, error: addr.error };
      const apiUrl = addr.url;
      const result = await cloudClient.register(apiUrl, args.email.trim(), args.password, typeof args.inviteCode === "string" ? args.inviteCode.slice(0, 40) : undefined);
      if (!result.ok || !result.data) return { ok: false, error: result.error ?? "Registration failed" };
      appSettings = { ...appSettings, cloudApiUrl: apiUrl, localMode: false };
      saveAppSettings(appSettings);
      const imported = args.importLocal === true && buildInfo.localModeAllowed ? importLocalData(USERS_ROOT, result.data.userId) : null;
      const opened = await bootstrapOrExplain(result.data.userId, result.data.email);
      if (!opened.ok) return { ok: false, error: opened.problem.message, startupProblem: opened.problem };
      if (imported) {
        notices.set({
          id: "local-import",
          severity: imported.copied ? "info" : "warning",
          title: imported.copied ? "Your local data was copied into this account" : "Your local data was not copied",
          message: imported.copied ? "The original is still on this computer; nothing was deleted. Your Watches and products now sync with your account." : imported.reason,
          action: "dismiss",
          actionLabel: "Got it",
        });
      }
      return { ok: true, userId: result.data.userId, email: result.data.email, imported: imported ? (imported.copied ? "Your local data was copied into this account. The original stays on this computer." : imported.reason) : undefined };
    }
  );

  // Reuses the EXACT teardown sequence app-quit uses (see stopUserSession,
  // shared with window-all-closed/before-quit below) rather than
  // duplicating it, then clears every other bit of per-user in-memory state
  // and the persisted cloud session so a relaunch's own auth:getSession
  // correctly reports "not authenticated" and shows the LoginScreen again.
  // Ends the signed-in session on this computer (the data stays in its folder). Used by "Log out" and when the server ends the sign-in.
  const endSession = async (): Promise<void> => {
    await stopUserSession();
    if (hasActiveUserSession) store.close();
    hasActiveUserSession = false;
    currentUserId = null;
    engines.clear();
    engineStatusMap.clear();
    restartGuards.clear();
    recentLogs.length = 0;
    activeResearch.clear();
    config = { ...DEFAULT_CONFIG };
    cloudClient.logout();
    if (appSettings.localMode) {
      appSettings = { ...appSettings, localMode: false }; // leaving local mode; the data stays in its folder and is there again on the next "use on this computer"
      saveAppSettings(appSettings);
    }
  };
  ipcMain.handle("auth:logout", async (): Promise<{ ok: boolean }> => {
    await endSession();
    return { ok: true };
  });
  // The server said this sign-in is over (this computer was removed from the account on the website, the password was reset, the account was disabled): sign out cleanly and say why.
  cloudClient.setSessionListener({
    onRejected: () => {
      void (async () => {
        if (!hasActiveUserSession || isLocalMode()) return;
        await endSession();
        sendToRenderer("auth:signedOut", { reason: "This computer was signed out of your Clynx account (it was removed on the website, your password was changed, or the account was disabled). Your data is still on this computer. Sign in again to continue." });
      })();
    },
    onOnline: () => notices.clear("cloud-offline"),
    onOffline: () => {
      if (hasActiveUserSession && !isLocalMode()) notices.set(offlineNotice());
    },
  });
  // Test connection (sign-in form, before any password is typed) and the "Retry now" button.
  ipcMain.handle("cloud:testServer", (_e, args: { url?: string }) => testServer(String(args?.url ?? ""), { clientVersion: buildInfo.version }));
  ipcMain.handle("cloud:retryNow", async (): Promise<{ online: boolean }> => {
    if (isLocalMode() || !hasActiveUserSession) return { online: false };
    return { online: await cloudClient.retryConnectionNow() };
  });
  // ---- Automatic updates (cloud mode) -------------------------------------------------------------------------------------------------------------------------
  // The server hands over a manifest SIGNED with the update key; this build holds only the public half (resources/update-public.pem). Nothing is installed without the person's
  // click, and a build without that file cannot install updates at all. Local beta mode makes no request (no server), so beta testers keep updating by installer.
  let updatePublicKey: string | null = null;
  try {
    updatePublicKey = readFileSync(path.join(app.getAppPath(), "resources", "update-public.pem"), "utf-8");
    if (!updatePublicKey.includes("BEGIN PUBLIC KEY")) updatePublicKey = null;
  } catch {
    updatePublicKey = null;
  }
  const updateChannel = (): UpdateChannel => appSettings.updateChannel ?? (buildInfo.channel === "production" ? "stable" : "beta");
  const updater = new Updater({
    authHeader: () => cloudClient.getAuthHeader(),
    getServerBase: () => (hasActiveUserSession && !isLocalMode() ? (cloudClient.getSessionInfo().apiUrl ?? appSettings.cloudApiUrl) || null : null),
    publicKeyPem: updatePublicKey,
    currentVersion: buildInfo.version,
    channel: updateChannel,
    mode: () => appSettings.updateMode ?? "automatic",
    isBusy: () => watchSearching || researchActive > 0 || [...engines.values()].some((e) => e.getStatus().running) || personIsUsingClynx(),
    refreshAuth: () => cloudClient.refreshSessionNow(),
    beforeInstall: () => {
      // scanners that are running now are started again by the new version once it is up (an update must not silently end a scan the person left running)
      try {
        const running = [...engines.entries()].filter(([, e]) => e.getStatus().running).map(([id]) => id);
        const file = path.join(baseDir, "updates", "resume-scanners.json");
        if (running.length) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify({ accounts: running, at: new Date().toISOString() }));
        }
      } catch (err) {
        console.error("[updates] could not note the running scanners:", err);
      }
    },
    platform: process.platform,
    arch: process.arch,
    stateFile: path.join(baseDir, "updates", "update-state.json"),
    stagingDir: path.join(baseDir, "updates", "staging"),
    backupBeforeInstall: async () => {
      const r = await runDatabaseBackup(true);
      return !!r && r.ok;
    },
    launchInstaller: (installerPath, args) => {
      // (see installerLauncher.ts: run the installer silently and WAIT for it, then reopen Clynx on the same data folder, whatever the installer's result.) A path with a character that
      // would break a command line makes the hand-off start the installer plainly instead: the update still installs, Clynx just has to be opened by hand afterwards.
      const userData = app.getPath("userData");
      const plan = planInstallerLaunch(isSafeForCommandLine(installerPath, process.execPath, userData) ? process.platform : "plain", installerPath, args, process.execPath, userData);
      const child = spawn(plan.command, plan.args, plan.options);
      child.on("error", (err) => console.error("[updates] installer failed to start:", err));
      child.unref();
    },
    quit: () => {
      allowClose = true;
      app.quit();
    },
    onStatus: () => {
      const info = updater.getStatus();
      sendToRenderer("updates:status", info);
      const s = info.status;
      const req = info.required;
      if (req && (s.state === "ready" || s.state === "available" || s.state === "downloading")) {
        const when = new Date(req.deadline).toLocaleString();
        notices.set({ id: "update", severity: "warning", title: `Clynx ${req.version} is a required update`, message: req.overdue ? "It is installing now. Clynx closes for a moment and reopens, and anything running is started again." : `It installs by itself when Clynx is idle, and at the latest by ${when}. Your data is not affected.`, action: s.state === "ready" ? "install-update" : "dismiss", actionLabel: s.state === "ready" ? "Install now" : "Got it" });
      } else if (s.state === "available") {
        notices.set({ id: "update", severity: "info", title: `Clynx ${s.version} is available`, message: "A new version is ready to download. Your data is not affected. It installs only when you say so.", action: "download-update", actionLabel: "Download it" });
      } else if (s.state === "ready") {
        const auto = info.mode === "automatic";
        notices.set({ id: "update", severity: "info", title: auto ? `Clynx ${s.version} will install by itself` : `Clynx ${s.version} is ready to install`, message: auto ? "It was downloaded and checked (signature and checksums) and installs when Clynx is idle: Clynx closes for a moment and reopens. Your data is not affected." : "It was downloaded and checked (signature and checksums). Installing closes Clynx for a moment and reopens it. Your data is not affected.", action: "install-update", actionLabel: auto ? "Install now" : "Restart and install" });
      } else if (s.state === "downloading" || s.state === "installing") {
        /* shown in Config > Account > Updates */
      } else {
        notices.clear("update");
      }
    },
    onProblem: (p) => {
      notices.set({
        id: "update-problem",
        severity: "warning",
        title: p.kind === "rollback-offered" ? `Clynx ${p.version} had trouble starting` : `The update to ${p.version} did not finish`,
        message: p.message,
        action: p.canRollback ? "rollback-update" : "dismiss",
        actionLabel: p.canRollback ? "Go back to the earlier version" : "Got it",
      });
    },
    log: (m) => console.log(m),
  });
  updater.init();
  updater.startSchedule();
  // a version that has been running for two minutes, with its window up, has proved it starts: that ends the "pending" watch on a freshly installed update
  setTimeout(() => updater.confirmHealthy(), 2 * 60_000).unref?.();
  ipcMain.handle("updates:getStatus", () => updater.getStatus());
  ipcMain.handle("updates:check", () => updater.check({ manual: true }).then(() => updater.getStatus()));
  ipcMain.handle("updates:download", () => updater.download().then(() => updater.getStatus()));
  ipcMain.handle("updates:install", () => updater.installNow());
  ipcMain.handle("updates:rollback", () => updater.rollback());
  ipcMain.handle("updates:setMode", (_e, args: { mode?: string }) => {
    if (args?.mode !== "off" && args?.mode !== "notify" && args?.mode !== "download" && args?.mode !== "automatic") return { ok: false };
    appSettings = { ...appSettings, updateMode: args.mode };
    saveAppSettings(appSettings);
    return { ok: true };
  });
  ipcMain.handle("updates:setChannel", (_e, args: { channel?: string }) => {
    if (args?.channel !== "beta" && args?.channel !== "stable") return { ok: false };
    appSettings = { ...appSettings, updateChannel: args.channel };
    saveAppSettings(appSettings);
    return { ok: true };
  });

  // Opens the person's account on the website in their own browser (only an address on the server they signed in to, https or local development).
  ipcMain.handle("account:openWebsite", (_e, args: { page?: string }): { ok: boolean; error?: string } => {
    const allowed: Record<string, string> = { account: "/account", billing: "/account/billing", devices: "/account/devices", download: "/download", support: "/support" };
    const base = (cloudClient.getSessionInfo().apiUrl ?? appSettings.cloudApiUrl ?? "").replace(/\/+$/, "");
    const safe = safeExternalUrl(base + (allowed[args?.page ?? "account"] ?? "/account"));
    if (!safe.ok) return { ok: false, error: safe.error };
    void shell.openExternal(safe.url);
    return { ok: true };
  });

  // Clynx Cloud Phase 1 — foundation-only wiring, extended for the first UI
  // status readout (Config.tsx's Cloud Sync section): aggregates
  // CloudClient's own auth/heartbeat state with all 4 background sync
  // services' own getStatus(), so the renderer can answer "is this actually
  // working right now" by polling one IPC call instead of reading terminal
  // logs or querying Postgres directly. Cloud sync is unconditionally on for
  // any logged-in user now (see bootstrapUserSession) — this is only ever
  // called once the renderer is past the LoginScreen, so store/the sync
  // services below are always already constructed by the time it runs.
  // Account and subscription (Config > Account). The renderer never talks to the server itself and never sees a token; checkout / portal pages open in the user's own browser,
  // and only an https URL (or http on a local development server) that the server returned is ever opened.
  const openBillingPage = (url: unknown): BillingActionResult => {
    const safe = safeExternalUrl(url);
    if (!safe.ok) return safe;
    void shell.openExternal(safe.url);
    return { ok: true };
  };
  const cloudMessage = (r: { error?: string; status?: number; data?: unknown }): string => {
    const d = (r.data ?? {}) as { error?: string; message?: string };
    if (d.error === "billing_not_configured") return "Billing is not set up on this server yet.";
    if (d.error === "already_subscribed") return d.message ?? "You already have a subscription.";
    if (r.status === 429) return "Too many attempts. Try again in a little while.";
    return d.message ?? r.error ?? "That did not work. Try again.";
  };
  ipcMain.handle("billing:status", async (): Promise<BillingStatus | null> => {
    const r = await cloudClient.getBillingStatus();
    return r.ok && isBillingStatus(r.data) ? r.data : null; // an older or unexpected server answer is treated as "plan unavailable", never shown half-filled
  });
  ipcMain.handle("billing:checkout", async (_e, args: { plan?: string }): Promise<BillingActionResult> => {
    if (args?.plan !== "pro_monthly" && args?.plan !== "pro_yearly") return { ok: false, error: "Choose a plan." };
    const r = await cloudClient.createCheckout(args.plan);
    return r.ok && r.data ? openBillingPage(r.data.url) : { ok: false, error: cloudMessage(r) };
  });
  ipcMain.handle("billing:portal", async (): Promise<BillingActionResult> => {
    const r = await cloudClient.createPortal();
    return r.ok && r.data ? openBillingPage(r.data.url) : { ok: false, error: cloudMessage(r) };
  });
  ipcMain.handle("account:changePassword", async (_e, args: { currentPassword?: string; newPassword?: string }): Promise<BillingActionResult> => {
    if (typeof args?.currentPassword !== "string" || typeof args?.newPassword !== "string" || args.newPassword.length < 8 || args.newPassword.length > 200) return { ok: false, error: "The new password must be 8 to 200 characters." };
    const r = await cloudClient.changePassword(args.currentPassword, args.newPassword);
    return r.ok ? { ok: true } : { ok: false, error: r.status === 401 ? "The current password is not right." : cloudMessage(r) };
  });
  ipcMain.handle("account:delete", async (_e, args: { password?: string }): Promise<BillingActionResult> => {
    if (typeof args?.password !== "string" || !args.password) return { ok: false, error: "Enter your password." };
    const r = await cloudClient.deleteAccount(args.password);
    return r.ok ? { ok: true } : { ok: false, error: r.status === 401 ? "That password is not right." : cloudMessage(r) };
  });
  ipcMain.handle("cloud:getStatus", (): CloudStatus => {
    const cloud = cloudClient.getStatus();
    return {
      enabled: cloud.enabled,
      apiUrl: cloud.apiUrl,
      authenticated: cloud.authenticated,
      deviceId: cloud.deviceId,
      heartbeat: cloud.heartbeat,
      online: cloudClient.getConnection().online,
      lastContactAt: cloudClient.getConnection().lastContactAt,
      sync: {
        watches: watchSyncService.getStatus(),
        feedback: feedbackSyncService.getStatus(),
        products: productSyncService.getStatus(),
        listings: listingIngestSyncService.getStatus(),
      },
    };
  });
  // Per explicit instruction — resolves a pending location change (see
  // resolveAccountLocationIfNeeded/location:setMode) before actually
  // starting, a no-op once already resolved. Logged either way so a
  // resolution failure (a bad city/ZIP, a lookup error) is visible in
  // Activity instead of silently leaving the account scanning the wrong
  // place — Config itself no longer gets a synchronous result to show
  // since it no longer does this work itself.
  ipcMain.handle("engine:start", async (_e, args: { accountId: string }) => {
    const eng = ensureEngineFor(args.accountId);
    // A saved location that hasn't been looked up on Facebook yet is resolved first, which can take minutes (a state looks up
    // ten cities). The account shows as running meanwhile, so the Dashboard says "Scanning" and Stop can cancel the lookup.
    const needsLookup = !!config.accounts.find((a) => a.id === args.accountId && !a.locationResolved);
    if (needsLookup) eng.beginStarting("Looking up your location on Facebook...");
    const resolved = await resolveAccountLocationIfNeeded(args.accountId);
    // Stop was clicked while the lookup ran: nothing to report, and nothing to start.
    if (needsLookup && eng.stopWasRequested) return;
    if (resolved.message) {
      const line: LogLine = { ts: Date.now(), level: resolved.ok ? "info" : "error", message: resolved.message };
      recordLog(line);
      sendToRenderer("engine:log", line);
    }
    if (!resolved.ok) {
      eng.cancelStarting();
      return;
    }
    eng.start();
  });
  ipcMain.handle("engine:stop", (_e, args: { accountId: string }) => ensureEngineFor(args.accountId).stop());
  ipcMain.handle("engine:skipWait", (_e, args: { accountId: string }) => ensureEngineFor(args.accountId).skipWait());
  ipcMain.handle("engine:runOnce", (_e, args: { accountId: string }) => ensureEngineFor(args.accountId).triggerOnce());
  ipcMain.handle("engine:login", (_e, args: { accountId: string }) => ensureEngineFor(args.accountId).login());
  ipcMain.handle("engine:checkLogin", (_e, args: { accountId: string }) => ensureEngineFor(args.accountId).checkLogin());
  // WatchCount login is a shared concern (see getPrimaryEngine) — not
  // per-account, since it's not tied to any one Facebook login at all.
  ipcMain.handle("engine:openWatchCountLogin", () => getPrimaryEngine().openWatchCountLogin());

  // Per explicit instruction — Config's account roster (add/remove/rename/
  // relocate). Each mutation persists via saveConfig and re-syncs engines
  // (see syncEnginesWithAccounts) so adding an account gets it a real
  // ScrapeEngine immediately (ready to log into), and removing one tears
  // its browser session down and deletes its profile directory.
  ipcMain.handle("accounts:list", (): Account[] => config.accounts);
  ipcMain.handle("accounts:add", (_e, args: { label: string }): Account => {
    const account: Account = {
      id: randomUUID(),
      label: args.label.trim() || `Account ${config.accounts.length + 1}`,
      enabled: true,
      browseUrls: [...DEFAULT_BROWSE_URLS],
      locationMode: "country",
      selectedState: null,
      selectedCityOrZip: null,
      searchRadiusMiles: 100,
      locationResolved: true, // country mode's browseUrls is a static list — nothing to resolve
    };
    config = { ...config, accounts: [...config.accounts, account] };
    saveConfig(CONFIG_PATH, config);
    syncEnginesWithAccounts();
    sendToRenderer("config:updated", config);
    return account;
  });
  ipcMain.handle("accounts:update", (_e, args: { id: string; patch: Partial<Pick<Account, "label" | "enabled">> }): Account[] => {
    config = { ...config, accounts: config.accounts.map((a) => (a.id === args.id ? { ...a, ...args.patch } : a)) };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
    return config.accounts;
  });
  ipcMain.handle("accounts:remove", (_e, args: { id: string }): Account[] => {
    // Always leave at least one account — the whole app assumes there's
    // somewhere to scan; deleting the last one would leave getPrimaryEngine
    // and every "for the first account" fallback with nothing to point at.
    if (config.accounts.length <= 1) return config.accounts;
    config = { ...config, accounts: config.accounts.filter((a) => a.id !== args.id) };
    saveConfig(CONFIG_PATH, config);
    syncEnginesWithAccounts();
    sendToRenderer("config:updated", config);
    return config.accounts;
  });

  // Per explicit instruction — Config's own "Search locations" dropdown:
  // "country" restores the full nationwide spread, "state" replaces
  // browseUrls with the AI's own top-10-major-cities lookup for one state
  // (each resolved to a real Facebook location, 40-mile radius), "city"
  // replaces it with exactly one resolved location for a specific city or
  // ZIP. All three fully REPLACE browseUrls rather than appending — this
  // is "where should the scanner look," not "add more places to look."
  // Per explicit instruction — multiple Facebook accounts: this now sets
  // ONE account's location (accountId), not the whole app's — every branch
  // below writes into that one entry in config.accounts instead of the old
  // flat Config fields, and only restarts/discovers via THAT account's own
  // engine.
  ipcMain.handle(
    "location:setMode",
    (
      _e,
      args:
        | { accountId: string; mode: "country" }
        | { accountId: string; mode: "state"; state: string }
        | { accountId: string; mode: "city"; cityOrZip: string }
    ): { ok: boolean; message: string } => {
      // Per explicit instruction — "don't have it immediately open
      // marketplace after applying the setting, just save it until the
      // user starts a scan": this used to open a browser and drive
      // Facebook's own "Change location" dialog right here, synchronously,
      // the moment the mode was changed in Config. Now it ONLY saves the
      // choice; resolveAccountLocationIfNeeded (below) does the actual
      // browser work, lazily, the next time this account's engine starts.
      if (args.mode === "country") {
        updateAccountLocation(args.accountId, {
          locationMode: "country",
          selectedState: null,
          selectedCityOrZip: null,
          searchRadiusMiles: 500,
          // The guessed city-slug list is only a stand-in until the account's next start: its slugs are NOT confirmed places ("/marketplace/augusta"
          // opens Augusta, Georgia; "/marketplace/salem" can stay on the account's own default city). Marking it resolved made the scanner rotate
          // through them as if they were real. Unresolved, the next start drives Facebook's own "Change location" dialog for each nationwide city
          // and keeps only the ones Facebook confirmed (resolveAccountLocationIfNeeded).
          browseUrls: [...DEFAULT_BROWSE_URLS],
          locationResolved: false,
        });
        return { ok: true, message: `Switched to nationwide rotation. The nationwide cities are looked up on Facebook the next time this account starts, so each one is a confirmed place.` };
      }

      if (args.mode === "city") {
        const cityOrZip = args.cityOrZip.trim();
        if (!cityOrZip) return { ok: false, message: "Enter a city or ZIP code first." };
        updateAccountLocation(args.accountId, {
          locationMode: "city",
          selectedCityOrZip: cityOrZip,
          // selectedState/browseUrls are stale until resolution actually
          // runs — left untouched rather than guessed at here; Facebook's
          // own confirmation of what it resolved to is what sets
          // selectedState (see resolveAccountLocationIfNeeded), same as
          // before, just deferred.
          locationResolved: false,
        });
        return { ok: true, message: `Saved — will search ${cityOrZip} once this account starts.` };
      }

      const state = args.state.trim();
      if (!state) return { ok: false, message: "Pick a state first." };
      updateAccountLocation(args.accountId, {
        locationMode: "state",
        selectedState: state,
        selectedCityOrZip: null,
        locationResolved: false,
      });
      return { ok: true, message: `Saved — will search ${state} once this account starts.` };
    }
  );

  ipcMain.handle("listings:list", (_e, args: { limit?: number; offset?: number }) =>
    store.listRecent(args?.limit ?? 200, args?.offset ?? 0)
  );
  // Per explicit instruction — Dashboard's "Listings evaluated" stat needs
  // the TRUE all-time count, not listings.length off the capped
  // listListings(500, 0) page the Feed uses for display.
  ipcMain.handle("listings:count", () => store.countListings());
  // Beta 12: honest stages (listingLifecycle.ts): what happened to each saved listing, adding up to the saved total.
  ipcMain.handle("listings:lifecycle", () => store.lifecycleCounts());
  ipcMain.handle(
    "listings:feedback",
    (_e, args: { id: string; verdict: FeedbackVerdict; note: string | null }) =>
      store.setFeedback(args.id, args.verdict, args.note)
  );
  ipcMain.handle("listings:clearFeedback", (_e, args: { id: string }) => store.clearFeedback(args.id));
  ipcMain.handle("listings:notInterested", (_e, args: { category: string }) => store.recordCategoryDismissal(args.category));
  ipcMain.handle("listings:delete", (_e, args: { id: string }) => store.deleteListing(args.id));
  ipcMain.handle("listings:clearAll", () => store.clearAllListings());

  // The Feed's manual "Research" button (and now the "Interested" button
  // too — see ListingCard.tsx) — the other places (besides chat's
  // research_product) allowed to create a Database entry, since per
  // explicit instruction scanning itself never does anymore. Reuses this
  // listing's own already-evaluated details as the seed instead of asking
  // OpenAI to re-derive a subject from scratch. `reason` is optional — per
  // explicit instruction, clicking Interested now prompts "what made you
  // interested in this?" the same way Not Interested prompts for a reason,
  // and that answer gets folded into the product's notes as real context
  // for why this specific listing was worth buying. `productId` in the
  // response — per explicit instruction, Research now takes the user
  // straight to that product's own Database page — is what lets the
  // renderer navigate there directly instead of trying to re-derive which
  // product this was from the message text.
  ipcMain.handle(
    "listings:research",
    async (_e, args: { id: string; reason?: string }): Promise<{ ok: boolean; message: string; productId: string | null }> => {
      const listing = store.getById(args.id);
      if (!listing) return { ok: false, message: "Listing not found.", productId: null };
      const subject = (listing.matchedItem || listing.extractedAttributes || listing.title).trim();
      if (!subject) return { ok: false, message: "Nothing on this listing to research.", productId: null };
      const reason = args.reason?.trim() || null;

      const listingImage = listing.thumbnailUrl ?? listing.imageUrls[0] ?? null;
      let imageDataUri: string | null | undefined; // undefined = not downloaded yet
      const listingPhoto = async () => (imageDataUri === undefined ? (imageDataUri = listingImage ? await downloadImageAsDataUri(listingImage) : null) : imageDataUri);

      let productName = subject;
      let relationForNew: { parentId: string | null; familyFromId: string } | null = null;
      const existing = store.findMatchingProduct(subject);
      if (existing) {
        // The name matched an existing entry; is this listing really that exact product, or a more specific model of
        // it (an EVGA card under the generic RTX 3060 Ti entry)? See productIdentity.ts.
        const { action } = await resolveIdentityTarget(store, existing, {
          title: listing.title,
          description: listing.description,
          imageDataUri: await listingPhoto(),
        });
        if (action.kind === "create") {
          // The user asked to research it, so give it its own entry under the general one (unless that exact name exists).
          const twin = store.getProductByName(action.name) ?? store.findColorVariant(action.name);
          if (!twin) {
            productName = action.name;
            relationForNew = { parentId: action.parentId, familyFromId: action.familyFromId };
          }
        }
        if (!relationForNew) {
          const target =
            action.kind === "attach" ? (store.getProductById(action.productId) ?? existing) : action.kind === "create" ? (store.getProductByName(action.name) ?? existing) : existing;
          const noteParts = [
            listing.price !== null ? `$${listing.price}` : null,
            listing.extractedAttributes || null,
            listing.photoAnalysis ? `Photo analysis: ${listing.photoAnalysis.slice(0, 500)}` : null,
            reason ? `User was interested because: ${reason}` : null,
          ].filter((p): p is string => !!p);
          const updated = noteParts.length ? store.appendProductObservation(target, subject, noteParts.join(" — ")) : target;
          if (updated) sendToRenderer("products:updated", updated);
          return { ok: true, message: `Reinforced the existing "${target.name}" profile with this listing.`, productId: target.id };
        }
      }

      const id = store.addProductStub(randomUUID(), productName);
      const parentForNew = relationForNew?.parentId ? store.getProductById(relationForNew.parentId) : null;
      const familyFromNew = relationForNew ? store.getProductById(relationForNew.familyFromId) : null;
      if (parentForNew) store.setProductParent(id, parentForNew.id);
      // Per explicit instruction — same pattern as scrapeEngine.ts's
      // onNewProductFound: a real photo from THIS listing shows immediately
      // as a placeholder and is saved into the Reference Photos gallery,
      // but isn't kept as the permanent thumbnail — the background
      // web-research lookup below gets to replace it with a clean,
      // representative product photo instead.
      const photo = await listingPhoto();
      if (photo) {
        store.editProductProfile(id, { imageUrl: photo });
        fileListingPhoto(id, photo, listing.title, "mark-interested");
        ensurePhotoDifferenceAnalysis(id);
      }
      if (reason) {
        store.recordProductObservation(productName, `User was interested because: ${reason}`);
      }
      sendToRenderer("products:updated", store.getProductById(id));
      // Condition-awareness — listing.title is the live listing that just
      // triggered this "mark interested" new-product creation, same
      // reasoning as onNewProductFound's own call above.
      runProductLookup(id, productName, {
        triggeringListing: { title: listing.title, imageDataUri: photo },
        ...(relationForNew ? { skipSiblingDiscovery: true, forcedFamily: familyFromNew?.family ?? undefined } : {}),
      });
      return {
        ok: true,
        message: parentForNew
          ? `Added "${productName}" to the Database under "${parentForNew.name}" and researching it now.`
          : relationForNew
            ? `Added "${productName}" to the Database next to "${familyFromNew?.name ?? "its variants"}" and researching it now.`
            : `Added "${subject}" to the Database and researching it now.`,
        productId: id,
      };
    }
  );

  // A folder tile (a brand, a sub-grouping) that is on screen with nothing to show: its brand logo / group picture, found
  // without AI (see webResearch.ts's findFreeBrandLogo / findFreeGroupImage). True when something new was stored.
  ipcMain.handle("watch:isSearching", (): boolean => watchSearching);
  // Link (or, with an empty value, unlink) the user's own eBay store: its listings become a separate price reference.
  ipcMain.handle("ebayStore:link", (_e, input: string): { ok: boolean; username: string; error?: string } => {
    const raw = typeof input === "string" ? input.trim() : "";
    const username = raw ? parseSellerName(raw) : "";
    if (username === null) return { ok: false, username: config.ebayStoreUsername ?? "", error: "That doesn't look like an eBay username. Use the name shown on your eBay profile (ebay.com/usr/yourname)." };
    if (username && !hasEbayCredentials()) return { ok: false, username: config.ebayStoreUsername ?? "", error: "Clynx needs its eBay keys (EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env) to read your store." };
    config = { ...config, ebayStoreUsername: username };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
    store.clearAllMyStoreRefs();
    for (const product of store.listProducts()) sendToRenderer("products:updated", store.getProductById(product.id));
    if (username) void backfillMyStoreReferences();
    else myStoreBackfillRun++;
    return { ok: true, username };
  });
  ipcMain.handle("watch:setNtfyTopic", (_e, args: { id: string; topic: string | null }): Watch | null => {
    // ntfy topics are letters, digits, underscores and dashes (up to 64); anything else would just fail to send.
    const topic = typeof args.topic === "string" ? args.topic.trim() : "";
    if (topic && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return null;
    const updated = store.setWatchNtfyTopic(args.id, topic || null);
    return updated;
  });
  ipcMain.handle("products:ensureFolderImage", async (_e, args: { segments: string[] }): Promise<boolean> => {
    const segments = Array.isArray(args?.segments) ? args.segments.filter((x) => typeof x === "string" && x.trim()) : [];
    if (segments.length === 0) return false;
    const path = segments.join(" > ");
    const key = path.toLowerCase();
    if (folderImageAttemptedAt.has(key) && Date.now() - (folderImageAttemptedAt.get(key) ?? 0) < 30 * 60_000) return false;
    folderImageAttemptedAt.set(key, Date.now());
    try {
      if (segments.length === 1) {
        if (store.getFamilyLogoUrl(segments[0])) return false;
        const logo = await findBrandLogoImage(segments[0]);
        if (!logo) return false;
        store.setFamilyLogo(segments[0], logo);
        return true;
      }
      if (store.getGroupThumbnail(path)) return false;
      const query = segments.length === 2 ? `${segments[0]} ${segments[1]}` : `${segments[segments.length - 1]} ${segments[1]}`;
      const imageData = await findGroupImage(query);
      if (!imageData) return false;
      store.setGroupThumbnail(path, imageData);
      sendToRenderer("groupThumbnails:updated", { path, imageData });
      return true;
    } catch (err) {
      console.error(`[folder-image] failed for "${path}": ${(err as Error).message}`);
      return false;
    }
  });
  ipcMain.handle("products:ensureThumbnails", (_e, args: { ids: string[] }): number => ensureThumbnailsFor(Array.isArray(args?.ids) ? args.ids.filter((x) => typeof x === "string") : []));
  // Ids and names only (no photos): for screens that just need to look a product up by name (Activity).
  ipcMain.handle("products:listIndex", () => store.listProductIndex());
  ipcMain.handle("products:list", () => {
    // Folds together entries that turned out to be the same product (see Store.mergeDuplicateProducts); a no-op normally.
    mergeDuplicateProductEntries();
    // Opening the Database also checks for blank-box entries, at most every 10 minutes.
    if (Date.now() - lastBlankSweepAt > 10 * 60_000) void sweepBlankProducts();
    return store.listProducts();
  });
  // Looks up an existing Database entry by name using the SAME fuzzy-match logic the scanner
  // itself relies on elsewhere (see store.findMatchingProduct), so what the Dashboard's "Add
  // product" and the Watch form link to is exactly what the live matching engine would find —
  // never a separate, possibly-diverging guess reimplemented client-side.
  ipcMain.handle("products:findMatch", (_e, args: { name: string }): ProductProfile | null => store.findMatchingProduct(args.name));
  // Initial snapshot for whenever the Database screen (re)mounts after
  // research already started elsewhere — see activeResearch/
  // broadcastResearchStatus above for how this stays live afterward.
  ipcMain.handle("research:status", (): ActiveProductResearch[] => Array.from(activeResearch.values()));
  // The Discovery tab's snapshot (live updates arrive as "discovery:entry", see the DiscoveryFeed above).
  ipcMain.handle("discovery:list", () => discovery.list());
  // The Database > Review screen. Everything here reads; nothing changes a Database entry (see identityReview.ts). "review:decide" is refused unless
  // config.databaseReview.decisions is on, takes exactly one suggestion, and even then only records the decision.
  ipcMain.handle("review:get", () => reviewService().get());
  ipcMain.handle("review:run", () => reviewService().run());
  ipcMain.handle("review:history", () => reviewService().history());
  ipcMain.handle("review:decide", (_e, args: { proposalId: string; decision: "approved" | "rejected" | "clear"; note?: string | null }) =>
    reviewService().decide(args?.proposalId, args?.decision === "approved" || args?.decision === "rejected" ? args.decision : "clear", args?.note ?? null));
  // One approved suggestion at a time; refused unless config.databaseReview.apply is on (see identityReview.ts).
  ipcMain.handle("review:apply", (_e, args: { proposalId: string }) => {
    const r = reviewService().apply(args?.proposalId);
    if (r.ok) void reviewService().run();
    return r;
  });
  ipcMain.handle("review:undo", (_e, args: { proposalId: string }) => {
    const r = reviewService().undo(args?.proposalId);
    if (r.ok) void reviewService().run();
    return r;
  });
  // The Database screen's own client-side cache of folder-level thumbnails
  // (see ensureGroupThumbnail above) — fetched once up front since this
  // dataset stays small (one row per distinct sub-grouping actually seen),
  // then kept live via the groupThumbnails:updated push.
  ipcMain.handle("products:listGroupThumbnails", () => store.listGroupThumbnails());


  ipcMain.handle("products:refresh", (_e, args: { id: string }) => {
    const product = store.getProductById(args.id);
    if (!product) return null;
    store.setProductLoading(args.id, true);
    runProductLookup(args.id, product.name, { source: "refresh" });
    return store.getProductById(args.id);
  });

  // The Library's delete goes to the Trash (restorable for 30 days); see libraryOps.ts.
  ipcMain.handle("products:delete", (_e, args: { id: string }) => {
    libraryOps().run({ op: "trashProduct", id: args.id }, { actor: "ui" });
  });
  ipcMain.handle("library:op", (_e, args: { op: LibraryOp; confirm?: string }) => {
    const result = libraryOps().run(args.op, { actor: "ui", confirm: args.confirm });
    // an entry made from a photo gets its own research (summary, prices) like any new entry
    if (result.ok && result.data?.productId) {
      const created = store.getProductById(result.data.productId);
      if (created) runProductLookup(created.id, created.name, { skipSiblingDiscovery: true, forcedFamily: created.family ?? undefined, source: "you" });
    }
    return result;
  });
  ipcMain.handle("library:folders", () => store.listFolders());
  // The automatic folders' own settings: renamed labels and pictures with where each came from.
  ipcMain.handle("library:folderMeta", () => store.listFolderMeta());
  ipcMain.handle("library:uploadFolderThumbnail", async (_e, args: { key: string; dataUri: string; fileName?: string }) => {
    const norm = await normalizeFolderImage(String(args?.dataUri ?? ""));
    if (!norm.ok) return { ok: false, summary: "", error: norm.error };
    return libraryOps().run({ op: "setFolderThumbnail", key: String(args.key ?? ""), imageData: norm.dataUri, fileName: args.fileName }, { actor: "ui" });
  });
  ipcMain.handle("library:generateFolderThumbnail", async (_e, args: { key: string }) => {
    const r = await folderArt().generate(String(args?.key ?? ""), true);
    return { ok: r.ok, summary: r.ok ? r.message : "", error: r.ok ? undefined : r.message };
  });
  ipcMain.handle("library:history", () => libraryOps().recent(30));
  ipcMain.handle("library:trash", () => store.listTrash());
  ipcMain.handle("library:review", async () => {
    // Needs review: pictures set aside, names made from a picture alone, entries that look like duplicates. Pictures are shrunk for the list.
    const items = store.listReviewItems("open").slice(0, 60);
    const out = [];
    for (const item of items) {
      let image: string | null = null;
      let productName: string | null = null;
      let suggestedName: string | null = null;
      if (item.kind === "image") {
        const img = store.getProductImage(item.subjectId);
        if (!img) { store.resolveReviewItem(item.id, "rejected", "system"); continue; }
        image = await makeThumb(img.imageData, 320);
        productName = store.getProductById(img.productId)?.name ?? null;
        const sid = typeof item.evidence.suggestedProductId === "string" ? item.evidence.suggestedProductId : null;
        suggestedName = sid ? (store.getProductById(sid)?.name ?? null) : null;
      }
      out.push({ ...item, image, productName, suggestedName });
    }
    return out;
  });
  ipcMain.handle("products:clearAll", () => store.clearAllProducts());
  // Add-ons (addons.ts): the toggles and the list on a product's Library page. Nothing here changes the base product's value, an alert or a scan.
  const addonsAnswer = (baseId: string | undefined) => (baseId ? store.listAddons(baseId) : []);
  ipcMain.handle("addons:list", (_e, productId: string) => addonsAnswer(String(productId ?? "")));
  // every version / add-on research found for a product, with its status (variantDiscovery.ts)
  ipcMain.handle("variants:found", (_e, productId: string) => store.listCandidates(String(productId ?? "")));
  ipcMain.handle("addons:add", (_e, productId: string, input: { name?: string; role?: AddonRole; standaloneValueUsd?: number | null; enabled?: boolean }) => {
    store.addAddon(String(productId ?? ""), { name: String(input?.name ?? ""), role: input?.role === "expected" ? "expected" : "bonus", standaloneValueUsd: typeof input?.standaloneValueUsd === "number" ? input.standaloneValueUsd : null, enabled: input?.enabled === true });
    return addonsAnswer(String(productId ?? ""));
  });
  ipcMain.handle("addons:setEnabled", (_e, id: string, enabled: boolean) => {
    const base = store.getAddon(String(id ?? ""))?.baseProductId;
    store.setAddonEnabled(String(id ?? ""), enabled === true);
    return addonsAnswer(base);
  });
  ipcMain.handle("addons:setStatus", (_e, id: string, status: AddonStatus) => {
    const base = store.getAddon(String(id ?? ""))?.baseProductId;
    if (status === "confirmed" || status === "dismissed" || status === "suggested") store.setAddonStatus(String(id ?? ""), status);
    return addonsAnswer(base);
  });
  ipcMain.handle("addons:update", (_e, id: string, patch: { name?: string; role?: AddonRole; standaloneValueUsd?: number | null }) => {
    const base = store.getAddon(String(id ?? ""))?.baseProductId;
    store.setAddonDetails(String(id ?? ""), { name: typeof patch?.name === "string" ? patch.name : undefined, role: patch?.role === "expected" || patch?.role === "bonus" ? patch.role : undefined, standaloneValueUsd: patch?.standaloneValueUsd === null ? null : typeof patch?.standaloneValueUsd === "number" ? patch.standaloneValueUsd : undefined });
    return addonsAnswer(base);
  });
  ipcMain.handle("addons:remove", (_e, id: string) => {
    const base = store.getAddon(String(id ?? ""))?.baseProductId;
    store.removeAddon(String(id ?? ""));
    return addonsAnswer(base);
  });
  ipcMain.handle("products:countMissingPhotos", () => productsNeedingPhotos().length);
  ipcMain.handle("products:backfillPhotos", () => runPhotoBackfill());
  ipcMain.handle("products:photoBackfillStatus", () => ({
    running: photoBackfill !== null,
    done: photoBackfill?.done ?? 0,
    total: photoBackfill?.total ?? 0,
  }));
  // Per explicit instruction — "avg. Facebook Marketplace price... place
  // this right above eBay sold comps." A live aggregation (store.ts's
  // getFacebookPriceStats), not a cached field — queried fresh whenever the
  // product's own page wants it, since it should just organically fill in
  // as more real listings get recognized as this product, with no separate
  // "Research now" click needed.
  ipcMain.handle("products:getFacebookPriceStats", (_e, args: { id: string }) => store.getFacebookPriceStats(args.id));

  // Per explicit instruction — the Library's own "+" button: a product the
  // user already has their own photo/info for, added directly with no AI
  // research triggered (contrast with research_product/listings:research,
  // which always kick off runProductLookup). The photo, if given, is opened
  // via the SAME native file picker as every other manual image add in this
  // app (pickImageAsDataUri, defined below) — also saved into the
  // reference-photo gallery, not just set as the thumbnail, so it's there
  // as real backing evidence the same way a scanner-found photo would be.
  ipcMain.handle("products:createManual", async (_e, args: { name: string; category: string }): Promise<ProductProfile | null> => {
    const name = args.name.trim();
    if (!name) return null;
    const imageDataUri = await pickImageAsDataUri(`Choose a photo for "${name}" (optional)`);
    const id = randomUUID();
    store.createManualProduct(id, name, args.category || "Other", imageDataUri);
    if (imageDataUri) {
      fileUserPhoto(id, imageDataUri);
      ensurePhotoDifferenceAnalysis(id);
    }
    return store.getProductById(id);
  });

  ipcMain.handle(
    "products:edit",
    (
      _e,
      args: {
        id: string;
        patch: Partial<{
          name: string;
          aiSummary: string;
          resalePriceUsd: number | null;
          resaleTimeToSell: string | null;
          keepThumbnail: boolean;
          desiredPriceUsd: number | null;
          hardCapAtDesiredPrice: boolean;
          prioritized: boolean;
        }>;
      }
    ) => {
      store.editProductProfile(args.id, args.patch);
      return store.getProductById(args.id);
    }
  );

  // Shared by the manual thumbnail picker and the reference-image gallery
  // below — a native file picker rather than a URL box, since the user is
  // choosing their OWN photo, not pointing at one already on the web. Reads
  // and re-encodes as a data: URI, same storage shape as a research-found
  // photo (see webResearch.ts's downloadImageAsDataUri), so the renderer's
  // <img src=...> needs no special-casing either way.
  const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
  async function pickImageAsDataUri(title: string): Promise<string | null> {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title,
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const mimeType = IMAGE_MIME[path.extname(filePath).toLowerCase()];
    if (!mimeType) return null;
    const buffer = readFileSync(filePath);
    if (buffer.byteLength > 8 * 1024 * 1024) return null; // same generous cap used elsewhere for images
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  ipcMain.handle("products:pickThumbnail", async (_e, args: { id: string }) => {
    const dataUri = await pickImageAsDataUri("Choose a thumbnail image");
    if (!dataUri) return null;
    // Doesn't set keepThumbnail itself — that's a separate, explicit
    // checkbox the user ticks alongside this (see Database.tsx), so
    // picking a new photo to try doesn't silently lock it in forever.
    store.editProductProfile(args.id, { imageUrl: dataUri });
    return store.getProductById(args.id);
  });

  // Per explicit instruction — "give the user the option to use the images
  // from the reference photos while changing a listing's thumbnail":
  // reuses a photo already confirmed/added in the product's OWN reference
  // gallery instead of only ever picking a fresh file from disk. The
  // renderer already has the reference photo's data: URI in hand (from
  // products:listImages) so this just writes it straight through — no new
  // store lookup needed. Broadcasts products:updated (unlike
  // products:pickThumbnail above, which returns directly to its one caller)
  // since this is triggered from ProductImageGallery, a separate component
  // one level below the product list that owns the state to update.
  ipcMain.handle("products:setThumbnailFromImage", (_e, args: { id: string; imageDataUri: string }) => {
    // the renderer hands over the picture; only a real image of sane size becomes a thumbnail (it used to take any string)
    if (typeof args.imageDataUri !== "string" || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(args.imageDataUri) || args.imageDataUri.length > 11_500_000) return store.getProductById(args.id);
    store.editProductProfile(args.id, { imageUrl: args.imageDataUri });
    const updated = store.getProductById(args.id);
    if (updated) sendToRenderer("products:updated", updated);
    return updated;
  });

  // The per-product reference-photo library (see types.ts's ProductImage) —
  // auto-populated from confirmed deals (scrapeEngine.ts's evaluateListing),
  // plus whatever the user adds/removes by hand here.
  ipcMain.handle("products:listImages", (_e, args: { productId: string }) => store.listProductImages(args.productId));
  ipcMain.handle("products:addImage", async (_e, args: { productId: string }) => {
    const dataUri = await pickImageAsDataUri("Add a reference photo");
    if (!dataUri) return null;
    const added = fileUserPhoto(args.productId, dataUri).image;
    ensurePhotoDifferenceAnalysis(args.productId);
    return added;
  });
  ipcMain.handle("products:deleteImage", (_e, args: { imageId: string }) => {
    libraryOps().run({ op: "removeImage", imageId: args.imageId }, { actor: "ui" });
  });

  // The Database grid's per-tile search button — deliberately reuses
  // add_search_item's own logic (via executeChatTool) rather than
  // duplicating it, so a one-click "search for this" from a product tile
  // behaves identically to asking the Dashboard assistant to do it: added
  // to the Search For list (with this product's own logged resale price as
  // the reference, if the user's set one) and an actual search kicked off
  // immediately, same as any other chat-triggered request. Deduped against
  // an existing Search For entry for this product so clicking it again
  // later (to re-check for new listings) doesn't pile up duplicate config
  // entries — it just re-runs the search against the one already there.
  ipcMain.handle("products:searchNow", async (_e, args: { id: string }): Promise<{ ok: boolean; message: string }> => {
    const product = store.getProductById(args.id);
    if (!product) return { ok: false, message: "Product not found." };

    const existing = config.searchItems.find((i) => i.item.toLowerCase() === product.name.toLowerCase());
    if (existing) {
      searchForItemOnActiveAccounts(existing);
      return { ok: true, message: `Searching Facebook Marketplace for "${product.name}" now — check the Feed below.` };
    }

    const message = await executeChatTool(
      {
        name: "add_search_item",
        args: {
          item: product.name,
          matchKeywords: [product.name.toLowerCase()],
          typicalResaleUsd: product.resalePriceUsd ?? 0,
        },
      },
      "dashboard"
    );
    return { ok: !message.startsWith("Failed:"), message };
  });

  // Per explicit instruction — a manual "research eBay comps again" button
  // on a product's own Database page. Deliberately does NOT check
  // config.watchCountOncePerScan/engine.hasResearchedEbayComps the way the
  // automatic runProductLookup step above does — that throttle exists to
  // stop the SAME product burning multiple watchcount lookups incidentally
  // within one scan (re-evaluated listings, the "Interested" reinforcement
  // path, etc.), not to block a deliberate one-off manual request. Still
  // calls markEbayCompsResearched afterward so an automatic re-check later
  // in the same scan is correctly skipped, same as if runProductLookup had
  // done the research itself.
  ipcMain.handle("products:refreshEbayComps", async (_e, args: { id: string }): Promise<{ ok: boolean; message: string }> => {
    const product = store.getProductById(args.id);
    if (!product) return { ok: false, message: "Product not found." };
    try {
      researchActive++;
      let analysis: Awaited<ReturnType<typeof fetchAndStoreEbayComps>>;
      try {
        analysis = await fetchAndStoreEbayComps(args.id, product.name);
      } finally {
        researchActive--;
      }
      sendToRenderer("products:updated", store.getProductById(args.id));
      const rejectedParts = [
        analysis.rejectedCount > 0 ? `${analysis.rejectedCount} didn't match this exact product` : null,
        analysis.photoRejected > 0 ? `${analysis.photoRejected} had photos of a different product` : null,
      ].filter((p): p is string => !!p);
      const rejected = rejectedParts.length ? ` (ignored: ${rejectedParts.join(", ")})` : "";
      const asks = analysis.activeSampleSize > 0 ? ` and ${analysis.activeSampleSize} active listing${analysis.activeSampleSize === 1 ? "" : "s"}` : "";
      return {
        ok: true,
        message:
          analysis.sampleSize > 0 || analysis.estimatedValueUsd !== null
            ? `Found ${analysis.sampleSize} matching sold comp${analysis.sampleSize === 1 ? "" : "s"}${asks}${rejected}.`
            : `Checked WatchCount but found no confidently-matching sold comps${rejected}.`,
      };
    } catch (err) {
      return { ok: false, message: `eBay comps research failed: ${(err as Error).message}` };
    }
  });

  // Per explicit instruction — the Dashboard's own "Search for Products"
  // box (a direct UI alternative to asking the assistant in chat), used
  // for a whole batch of product names composed there at once. Same
  // underlying mechanism as products:searchNow just above — reuses
  // add_search_item via executeChatTool for anything not already tracked
  // (which ONLY adds to the Search For list now — see add_search_item's own
  // doc comment on why the old auto-start/auto-search behavior was
  // removed), and just acknowledges anything that's already a Search For
  // item so re-submitting the same name later doesn't pile up duplicate
  // config entries or re-trigger a search. Sequential, not parallel — each
  // add_search_item call does its own config read-modify-write against the
  // shared in-memory `config`, and running them concurrently could race and
  // drop one. linkedProductId (see SearchItem's own doc comment) is set by
  // Dashboard's "is this what you're searching for?" popup and applies to
  // whichever of `items` actually ends up newly added — in practice always
  // a single name, since that popup only ever fires for one at a time.
  // minPriceUsd/maxPriceUsd, likewise, come from Dashboard's follow-up
  // "Set a price range for ___?" prompt (per explicit instruction — price
  // is per-product now, asked right before the item is actually queued,
  // not a global Dashboard filter) and apply the same way: to whichever
  // name ends up newly added.
  ipcMain.handle(
    "search:addProducts",
    async (
      _e,
      args: { items: string[]; linkedProductId?: string | null; minPriceUsd?: number | null; maxPriceUsd?: number | null; includeBroken?: boolean; acceptVariants?: boolean }
    ): Promise<{ ok: boolean; message: string }> => {
      const seen = new Set<string>();
      const names = args.items.filter((name) => {
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!names.length) return { ok: false, message: "No products given." };

      // Adding products here never turns general (unverified) deal detection off: Search For and general discovery coexist unless the
      // user explicitly disables one (see add_search_item's note above).

      const results: string[] = [];
      for (const name of names) {
        const existing = config.searchItems.find((i) => i.item.toLowerCase() === name.toLowerCase());
        if (existing) {
          // Per explicit instruction — this box should only ever ADD to the
          // Search For list, never trigger a search itself; that's what
          // Start Scanning is for. Previously re-ran an immediate search
          // for an already-tracked item.
          results.push(`"${existing.item}" is already on your Search For list`);
          continue;
        }
        // Per explicit instruction — "the ai needs to be able to recognize
        // shorter versions or abbreviations of products along with
        // different variants... apply that logic to any product if
        // needed": this used to pass just [name.toLowerCase()] here, so a
        // listing titled with the full spelled-out name never matched an
        // item added by its common abbreviation (or vice versa). See
        // products.ts's expandSearchKeywords for the actual expansion (and
        // the safety check keeping it from ever blurring a specific
        // variant like "PS5 Pro" into matching the plain base item).
        const matchKeywords = await expandSearchKeywords(name);
        const message = await executeChatTool(
          {
            name: "add_search_item",
            args: {
              item: name,
              matchKeywords,
              typicalResaleUsd: 0,
              linkedProductId: args.linkedProductId ?? null,
              minPriceUsd: args.minPriceUsd ?? null,
              maxPriceUsd: args.maxPriceUsd ?? null,
              includeBroken: args.includeBroken === true,
              acceptVariants: args.acceptVariants === true,
            },
          },
          "dashboard"
        );
        results.push(message);
      }
      return { ok: true, message: results.join(" · ") };
    }
  );

  // --- Watch (persistent background monitoring) ---------------------------
  // Per explicit instruction — "keep an eye out for this over time and
  // alert me when it appears," fundamentally different lifecycle from
  // Search For (session-scoped, reset every launch): Watches persist in
  // SQLite (see store.ts) and survive restarts. Every mutation broadcasts
  // the FULL current list on "watches:updated" — same posture as
  // blacklist:updated/blacklistImages:updated below, simple and correct
  // for a list this size (a handful to a few dozen objectives, not
  // thousands of listings).
  function broadcastWatches(): void {
    sendToRenderer("watches:updated", store.listWatches());
  }

  ipcMain.handle(
    "watch:create",
    async (
      _e,
      args: {
        name: string;
        platform: WatchPlatform;
        searchPhrase: string;
        linkedProductId: string | null;
        // A Facebook Watch looks out for several things; when given, these are the Watch's
        // terms (searchPhrase/linkedProductId above are then just the first of them).
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
      }
    ): Promise<Watch> => {
      const platform: WatchPlatform = args.platform === "ebay" ? "ebay" : "facebook";
      // Same keyword-expansion (abbreviations/variants) add_search_item's
      // own args already get from search:addProducts above — a Watch's
      // text-matching deserves the exact same breadth a Search For item's
      // does, not a narrower reimplementation.
      // An eBay Watch looks for exactly one thing.
      const termInputs = args.terms?.length ? args.terms : [{ phrase: args.searchPhrase, linkedProductId: args.linkedProductId }];
      const terms = (await buildWatchTerms(platform === "ebay" ? termInputs.slice(0, 1) : termInputs)).slice(0, platform === "ebay" ? 1 : MAX_WATCH_TERMS);
      if (!terms.length) throw new Error("A Watch needs something to look for.");
      const watch = store.createWatch({
        name: args.name.trim() || terms.map((t) => t.phrase).join(", ").slice(0, 60),
        platform,
        terms,
        searchPhrase: terms[0].phrase,
        matchKeywords: terms[0].matchKeywords,
        linkedProductId: terms[0].linkedProductId,
        checkIntervalMinutes: snapToWatchInterval(args.checkIntervalMinutes),
        accountIds: platform === "facebook" ? cleanAccountIds(args.accountIds) : [],
        minPriceUsd: args.minPriceUsd,
        maxPriceUsd: args.maxPriceUsd,
        minProfitUsd: args.minProfitUsd,
        minDiscountPercent: args.minDiscountPercent,
        maxListingAgeMinutes: args.maxListingAgeMinutes,
        minSellerRatingPercent: platform === "ebay" ? sanitizeSellerRating(args.minSellerRatingPercent) : null,
        ...watchLocationFor(platform, args),
      });
      startWatching();
      broadcastWatches();
      const line: LogLine = { ts: Date.now(), level: "info", message: `${platform === "ebay" ? "eBay" : "Facebook"} Watch created: "${watch.name}"` };
      recordLog(line);
      sendToRenderer("engine:log", line);
      return watch;
    }
  );

  ipcMain.handle(
    "watch:update",
    async (
      _e,
      args: {
        id: string;
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
        }>;
      }
    ): Promise<Watch | null> => {
      const patch = { ...args.patch } as any;
      const current = store.getWatchById(args.id);
      if (!current) return null;
      // The Watch's terms: phrases it already had keep their keywords; new ones get
      // theirs worked out. When terms are given they replace the plain phrase/link fields.
      if (Array.isArray(patch.terms)) {
        const built = await buildWatchTerms(patch.terms, current.terms);
        if (!built.length) return current;
        patch.terms = current.platform === "ebay" ? built.slice(0, 1) : built;
        delete patch.searchPhrase;
        delete patch.linkedProductId;
        delete patch.matchKeywords;
      }
      if (typeof patch.checkIntervalMinutes === "number") patch.checkIntervalMinutes = snapToWatchInterval(patch.checkIntervalMinutes);
      if ("accountIds" in patch) patch.accountIds = current.platform === "facebook" ? cleanAccountIds(patch.accountIds) : [];
      // The platform itself can't be edited (see types.ts's WatchPlatform), so
      // the rules below key off the stored one, never the patch. An eBay Watch
      // has no location and a Facebook one has no seller rating; both are
      // forced here so a stale form value can't leave junk behind.
      if (current.platform === "ebay") {
        Object.assign(patch, watchLocationFor("ebay", patch));
        if ("minSellerRatingPercent" in patch) patch.minSellerRatingPercent = sanitizeSellerRating(patch.minSellerRatingPercent);
      } else {
        patch.minSellerRatingPercent = null;
        if (patch.searchRadiusMiles !== null && patch.searchRadiusMiles !== undefined) patch.searchRadiusMiles = snapToFacebookRadius(patch.searchRadiusMiles);
      }
      // A search-phrase edit needs its match keywords re-expanded too —
      // otherwise an edited phrase would keep matching against the OLD
      // phrase's keyword set. Bug found live: WatchFormFlow.tsx's own
      // save() always sends the full form (every field, not a true partial
      // patch) — checking `typeof patch.searchPhrase === "string"` alone
      // meant this real OpenAI call (see products.ts's
      // expandSearchKeywords) re-ran on EVERY single edit, even one that
      // only touched, say, the price — a real, avoidable cost per the
      // app's own "avoid unnecessary OpenAI calls" principle. Comparing
      // against what's actually stored is what makes this fire only when
      // the phrase itself changed.
      const existing = typeof patch.searchPhrase === "string" ? store.getWatchById(args.id) : null;
      if (typeof patch.searchPhrase === "string" && patch.searchPhrase !== existing?.searchPhrase) {
        patch.matchKeywords = await expandSearchKeywords(patch.searchPhrase);
      }
      const updated = store.updateWatch(args.id, patch);
      broadcastWatches();
      return updated;
    }
  );

  ipcMain.handle("watch:setEnabled", (_e, args: { id: string; enabled: boolean }): Watch | null => {
    const updated = store.setWatchEnabled(args.id, args.enabled);
    broadcastWatches();
    return updated;
  });

  ipcMain.handle("watch:delete", (_e, args: { id: string }) => {
    store.deleteWatch(args.id);
    broadcastWatches();
  });

  ipcMain.handle("watch:list", (): Watch[] => store.listWatches());
  ipcMain.handle("watch:getById", (_e, args: { id: string }): Watch | null => store.getWatchById(args.id));
  ipcMain.handle("watch:listMatches", (_e, args: { watchId: string }) => store.listWatchMatches(args.watchId));

  // Per explicit instruction — "global Pause All / Resume All," distinct
  // from each Watch's own individual `enabled` (see types.ts's Config.watch
  // doc comment) — a single flag on Config rather than a bulk UPDATE across
  // every watches row, so per-watch pause state survives a pause/resume
  // cycle intact.
  ipcMain.handle("watch:pauseAll", () => {
    config = { ...config, watch: { ...config.watch, globallyPaused: true } };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
  });
  ipcMain.handle("watch:resumeAll", () => {
    config = { ...config, watch: { ...config.watch, globallyPaused: false } };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
  });
  // Per explicit instruction — drives the Sidebar's unseen-match pulse
  // indicator (see Config.watch.matchesLastViewedAt's own doc comment):
  // called once when the user actually opens the Watch screen, not on
  // every match.
  ipcMain.handle("watch:markMatchesViewed", () => {
    config = { ...config, watch: { ...config.watch, matchesLastViewedAt: Date.now() } };
    saveConfig(CONFIG_PATH, config);
    sendToRenderer("config:updated", config);
  });
  ipcMain.handle("watch:hasUnseenMatches", (): boolean => store.hasUnseenWatchMatches(config.watch.matchesLastViewedAt));

  // Per explicit instruction — every image the AI pulls into the Database
  // gets its own "ask about this image" box in the enlarged (lightbox)
  // view. Pure Q&A, no side effects — see images:feedback below for the
  // "correct the AI" path.
  ipcMain.handle("images:ask", async (_e, args: { imageDataUri: string; question: string; subjectName: string }) => {
    return answerImageQuestion(args.imageDataUri, args.question, args.subjectName);
  });

  // Per explicit instruction: feedback on an image should actually DO
  // something, not just get logged — re-examine the photo in light of it
  // (see vision.ts's reconsiderImageFeedback), then act on what comes back:
  // - reference photo: if it's genuinely a different, specific product,
  //   move it there (an existing match, or a brand-new entry seeded with
  //   this exact photo) instead of leaving a mislabeled photo where it was.
  // - product thumbnail: there's no "somewhere else" for a product's own
  //   defining photo to move TO, so a confirmed mismatch just clears it
  //   (falls back to the placeholder) rather than leaving a wrong photo
  //   representing the product; Refresh/pickThumbnail can then find a
  //   correct one.
  // - blacklisted image: if the AI now believes this was never ineligible
  //   to begin with, remove it from that gallery outright — same effect as
  //   the existing "Remove" button, just triggered by feedback instead of
  //   a manual click.
  // Either way, a reusable one-sentence correction note gets appended to
  // the RELEVANT product's lookout notes (see store.ts's
  // appendProductWatchNote) so the next photo-analysis pass for that
  // product has this exact mistake in its own context — "smart enough not
  // to make the same mistake again" per explicit instruction.
  ipcMain.handle(
    "images:feedback",
    async (
      _e,
      args: {
        imageDataUri: string;
        currentLabel: string;
        feedback: string;
        kind: "reference" | "thumbnail" | "blacklisted";
        imageId?: string;
        productId?: string;
        sourceTitle?: string | null;
      }
    ): Promise<{ ok: boolean; message: string }> => {
      const knownProducts = args.productId
        ? store
            .listProductIndex()
            .map((p) => p.name)
            .filter((n) => n.toLowerCase() !== args.currentLabel.toLowerCase())
        : [];
      const recon = await reconsiderImageFeedback(args.imageDataUri, args.currentLabel, args.feedback, knownProducts);
      if (recon.error) return { ok: false, message: `Couldn't reconsider that image: ${recon.error}` };

      if (args.kind === "blacklisted" && args.imageId) {
        if (recon.actualSubject) {
          store.removeBlacklistedImage(args.imageId);
          sendToRenderer("blacklistImages:updated", store.listBlacklistedImages());
          return {
            ok: true,
            message: `Removed from Blacklisted Images — on a closer look, this actually appears to be "${recon.actualSubject}," not an ineligible category.`,
          };
        }
        return { ok: true, message: "Thanks — noted, but I still think this one's correctly flagged." };
      }

      if (args.kind === "reference" && args.imageId && args.productId) {
        if (recon.note) {
          const updated = store.appendProductWatchNote(args.productId, `Correction: ${recon.note}`);
          if (updated) sendToRenderer("products:updated", updated);
        }
        if (recon.actualSubject && recon.actualSubject.toLowerCase() !== args.currentLabel.toLowerCase()) {
          // Beta 13: the person said it is wrong, so it is set aside at once (not used as a reference); where it belongs is decided in Needs review, not by a picture-only
          // guess, and nothing is deleted before something else is added (audit LB-03).
          const suggestion = store.resolveTarget(recon.actualSubject);
          store.setImageStatus(args.imageId, "needs_review");
          store.addReviewItem({
            kind: "image",
            subjectId: args.imageId,
            reasons: [`you flagged it ("${args.feedback.slice(0, 120)}"); a picture check thinks it shows "${recon.actualSubject}"`],
            evidence: { productId: args.productId, productName: args.currentLabel, sourceTitle: args.sourceTitle ?? null, suggestedSubject: recon.actualSubject, suggestedProductId: suggestion.product?.id ?? null, proposer: "feedback", userFeedback: args.feedback },
          });
          const updated = store.getProductById(args.productId);
          if (updated) sendToRenderer("products:updated", updated);
          return { ok: true, message: `Set that photo aside for review (it looks like "${recon.actualSubject}"). It is no longer used as a reference for "${args.currentLabel}"; open Needs review to move it or put it back.` };
        }
        return { ok: true, message: "Thanks — noted for next time." };
      }

      if (args.kind === "thumbnail" && args.productId) {
        if (recon.note) {
          const updated = store.appendProductWatchNote(args.productId, `Correction: ${recon.note}`);
          if (updated) sendToRenderer("products:updated", updated);
        }
        if (recon.actualSubject && recon.actualSubject.toLowerCase() !== args.currentLabel.toLowerCase()) {
          store.editProductProfile(args.productId, { imageUrl: null, keepThumbnail: false });
          const updated = store.getProductById(args.productId);
          if (updated) sendToRenderer("products:updated", updated);
          return { ok: true, message: "Cleared this thumbnail — it looked like a photo of something else. Refresh will find a new one." };
        }
        return { ok: true, message: "Thanks — noted for next time." };
      }

      return { ok: false, message: "Couldn't figure out what to do with that feedback." };
    }
  );

  // Condition-awareness — ListingCard's "?" badge confirm/deny. Deliberately
  // separate from images:feedback above: that one triggers an AI
  // re-examination and takes one immediate corrective action (move/delete a
  // Database photo); this one is a plain, fast, no-AI capture of the user's
  // raw yes/no answer, which only ever gets used later, batched, as few-shot
  // context on the NEXT listing's own vision call (see store.ts's
  // getFlawFeedbackExamples / vision.ts's buildFlawFeedbackExamplesBlock).
  ipcMain.handle(
    "listings:flawFeedback",
    (
      _e,
      args: { listingId: string; photoNumber: number; description: string; confidence: string; confirmed: boolean; listingTitle: string }
    ): { ok: boolean } => {
      store.addFlawFeedback(args);
      return { ok: true };
    }
  );

  // Per explicit instruction — pipeline instrumentation surfaced to the
  // Activity screen's metrics panel. Pull-based (the renderer polls this
  // every couple seconds) rather than a new push-broadcast channel, since
  // metrics update on every single listing evaluation — far too often to
  // usefully push live, and a couple-second-stale read is entirely fine for
  // a "how's it doing" panel. metrics:reset is what makes an actual
  // before/after benchmark possible: zero everything, run for a while under
  // one configuration, snapshot; reset again, run under another, compare.
  ipcMain.handle("metrics:snapshot", () => getMetricsSnapshot());
  ipcMain.handle("metrics:reset", () => {
    resetMetrics();
    return getMetricsSnapshot();
  });

  // The Database screen's Blacklist section — manual add/remove, separate
  // from the chat tools (add_blacklist_term/remove_blacklist_term) which
  // exist so the user can manage the same list conversationally instead.
  ipcMain.handle("blacklist:list", () => store.listBlacklistTerms());
  ipcMain.handle("blacklist:add", (_e, args: { term: string; imageDataUri?: string | null; sourceTitle?: string | null }) => {
    const added = store.addBlacklistTerm(
      args.term,
      "user",
      args.imageDataUri ? { imageData: args.imageDataUri, sourceTitle: args.sourceTitle ?? null } : null
    );
    if (added && (args.imageDataUri ?? null)) sendToRenderer("blacklistImages:updated", store.listBlacklistedImages());
    return added ? store.listBlacklistTerms() : null;
  });
  ipcMain.handle("blacklist:remove", (_e, args: { term: string }) => {
    store.removeBlacklistTerm(args.term);
    return store.listBlacklistTerms();
  });

  // The image counterpart — see types.ts's BlacklistedImage. Added
  // automatically while scanning (evaluateListing's thumbnail pre-check),
  // reviewed here: confirm keeps it (and promotes it to a trusted reference
  // example for future checks), remove treats it as a mistake and deletes
  // it outright so it stops being used as a reference at all.
  ipcMain.handle("blacklistImages:list", () => store.listBlacklistedImages());
  ipcMain.handle("blacklistImages:confirm", (_e, args: { id: string }) => {
    store.confirmBlacklistedImage(args.id);
    return store.listBlacklistedImages();
  });
  ipcMain.handle("blacklistImages:remove", (_e, args: { id: string }) => {
    store.removeBlacklistedImage(args.id);
    return store.listBlacklistedImages();
  });

  // Chat turns that can be stopped: requestId -> controller. Removed when the turn ends.
  const chatTurns = new Map<string, AbortController>();
  ipcMain.on("ai:chatCancel", (_e, args: { requestId: string }) => {
    chatTurns.get(args?.requestId)?.abort();
  });

  ipcMain.on(
    "ai:chatStart",
    async (
      event,
      args: {
        requestId: string;
        message: string;
        history: ChatMessage[];
        context: ChatContext;
        productId?: string;
        attachments?: ChatAttachment[];
        // Beta 13: the person pressed one of the buttons from an earlier question (ask_choice / a Library confirmation).
        choice?: { choiceId: string; optionId: string };
      }
    ) => {
      // Every event is guarded: the window can be closed or reloaded mid-turn.
      const send = (channel: string, payload: unknown) => {
        try {
          if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
        } catch {
          /* the window went away */
        }
      };
      const controller = new AbortController();
      chatTurns.set(args.requestId, controller);
      let streamedSoFar = "";
      const flags = beta13Flags(config);
      try {
        const recentListings = args.context === "dashboard" || args.context === "global" ? store.listRecent(10, 0) : [];
        // Dashboard (and now "global", the persistent bottom bar) also
        // needs an accurate product count and the real blacklist (see
        // buildDashboardSystemPrompt) — both have their own
        // add_blacklist_term/remove_blacklist_term tools, and a stale
        // "Blacklist (0): none yet" in the system prompt regardless of
        // actual state would be actively misleading.
        const products = args.context === "database" || args.context === "dashboard" || args.context === "global" ? store.listProducts() : [];
        // The Discovery tab passes the product open on the right (context "database"): Clynx then talks about that one.
        const currentProduct = (args.context === "product" || args.context === "database") && args.productId ? store.getProductById(args.productId) : null;
        const blacklistTerms =
          args.context === "database" || args.context === "dashboard" || args.context === "global" ? store.listBlacklistTerms() : [];
        const watches = args.context === "dashboard" || args.context === "global" ? store.listWatches() : [];
        const chatTrace: ChatTrace = { rounds: [], tools: [], totalMs: 0, aiCalls: 0, guards: [] };

        // Pictures: re-checked here (the window is not trusted), and anything that cannot be used is SAID, to the person and to the model - never dropped silently.
        const checked = sanitizeAttachments(args.attachments);
        let notice = "";
        if (!flags.chatAttachments && (args.attachments?.length ?? 0) > 0) {
          checked.accepted.length = 0;
          checked.rejected.push({ name: "photos", reason: "photo attachments are switched off" });
        }
        if (checked.rejected.length) {
          notice = `The user attached photo(s) that could NOT be used: ${checked.rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}. Tell them in one short sentence which ones were not used and why, then answer with what you have.`;
          send("ai:chatStatus", { requestId: args.requestId, stepId: "attachments", kind: "notice", label: `Couldn't use ${checked.rejected.length} photo${checked.rejected.length === 1 ? "" : "s"}: ${checked.rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}`, state: "end", startedAt: Date.now(), ok: false });
        }

        // A button press from an earlier question: run what it confirmed (here, where the authorising token lives) and tell the model the outcome.
        let message = args.message;
        if (args.choice) {
          const pending = pendingChoices.get(args.choice.choiceId);
          pendingChoices.delete(args.choice.choiceId);
          if (pending?.run && args.choice.optionId === "confirm") {
            const r = pending.run();
            message += `\n[The user confirmed. ${r.ok ? `Done: ${r.summary}` : `It failed: ${r.error ?? "unknown error"}`}]`;
          } else if (pending?.run) {
            message += "\n[The user cancelled. Nothing was changed.]";
          }
        }

        const full = await streamChat(
          message,
          args.history,
          args.context,
          config,
          recentLogs,
          recentListings,
          products,
          (delta) => {
            streamedSoFar += delta;
            send("ai:chatChunk", { requestId: args.requestId, delta });
          },
          (call) =>
            executeChatTool(
              call,
              args.context,
              (text) => {
                send("ai:searchUpdate", { requestId: args.requestId, message: text });
              },
              currentProduct?.id,
              flags.chatChoices ? { choice: (choice) => send("ai:chatChoices", { requestId: args.requestId, choice }) } : undefined
            ),
          currentProduct,
          blacklistTerms,
          checked.accepted,
          watches,
          chatTrace,
          {
            signal: controller.signal,
            onStatus: flags.chatStatus ? (e) => send("ai:chatStatus", { requestId: args.requestId, ...e }) : undefined,
            replyStyle: flags.replyStyle,
            notice: notice || undefined,
            thumbnail: async (dataUri) => {
              const small = await makeThumbnail(dataUri, THUMB_MAX_SIDE, 70);
              return small && small.length <= THUMB_MAX_CHARS ? small : null;
            },
          }
        );
        // Model and tool timing for every chat turn (Activity > metrics): how long each model round and each tool took, and which safeguards acted.
        recordStage("chat_turn", chatTrace.totalMs, true);
        for (const r of chatTrace.rounds) recordStage("chat_ai_round", r.ms, true);
        for (const t of chatTrace.tools) recordStage(`chat_tool_${t.name}`, t.ms, true);
        console.log(`[chat] ${args.context}: ${chatTrace.totalMs}ms, ${chatTrace.aiCalls} AI call(s) [${chatTrace.rounds.map((r) => `${r.ms}ms/first word ${r.firstWordMs ?? "-"}ms/${r.promptChars} chars`).join(", ")}], tools [${chatTrace.tools.map((t) => `${t.name} ${t.ms}ms${t.parallel ? " (parallel)" : ""}`).join(", ") || "none"}]${chatTrace.guards.length ? `, safeguards: ${chatTrace.guards.join(", ")}` : ""}`);
        send("ai:chatDone", { requestId: args.requestId, full });
      } catch (err) {
        // Stop keeps what was already said (the window replaces the bubble with `full`), and says it was stopped.
        if (err instanceof ChatStopped) send("ai:chatDone", { requestId: args.requestId, full: streamedSoFar.trim() ? `${streamedSoFar.trim()}\n\n(Stopped.)` : "Stopped." });
        else send("ai:chatError", { requestId: args.requestId, message: (err as Error).message });
      } finally {
        chatTurns.delete(args.requestId);
      }
    }
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Multi-user login migration — both handlers now go through the exact same
// stopUserSession() the auth:logout IPC handler above uses (see its own
// comment), rather than each maintaining its own copy of this sequence.
// stopUserSession itself no-ops if no user was ever actually logged in this
// run (e.g. the app was closed straight from the LoginScreen).
app.on("window-all-closed", async () => {
  await stopUserSession();
  if (hasActiveUserSession) store.close();
  // Quit on every platform, macOS included: closing the window ends the user's session and closes the database, so a "still running with no window" state (the macOS
  // default) could not be reopened correctly.
  app.quit();
});

app.on("before-quit", async () => {
  await stopUserSession();
});

// Reaching here means the app is shutting down in an orderly way; the next start will not report an unexpected end.
app.on("will-quit", () => {
  if (hasInstanceLock) diagnostics.endSession();
});
