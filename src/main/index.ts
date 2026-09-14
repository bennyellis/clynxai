import "dotenv/config";
import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from "electron";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Store } from "./store.js";
import { ScrapeEngine } from "./scrapeEngine.js";
import { loadConfig, saveConfig, DEFAULT_CONFIG, DEFAULT_BROWSE_URLS } from "./config.js";
import {
  streamChat,
  streamNarration,
  allowedToolNames,
  discoverSiblingProducts,
  type ChatMessage,
  type ChatContext,
  type ChatAttachment,
  type NarrationContext,
  type ToolCall,
} from "./chat.js";
import { randomUUID } from "node:crypto";
import { lookupProduct } from "./products.js";
import { downloadImageAsDataUri, findBrandLogoImage, findGroupImage, buildImageCollage } from "./webResearch.js";
import { answerImageQuestion, reconsiderImageFeedback } from "./vision.js";
import { lookupPrimaryCityInState } from "./locationDiscovery.js";
import { analyzeEbayComps, deriveWatchCountQuery } from "./watchcount.js";
import type { Config, FeedbackVerdict, LogLine, ProductProfile } from "./types.js";

Menu.setApplicationMenu(null);

const baseDir = app.isPackaged ? app.getPath("userData") : app.getAppPath();
const CONFIG_PATH = path.join(baseDir, "config.json");
const PROFILE_DIR = path.join(baseDir, "browser-profile");
const DB_PATH = path.join(baseDir, "data", "scout.db");
const ENV_PATH = path.join(baseDir, ".env");

function saveEnvKey(varName: string, key: string): void {
  const trimmed = key.trim();
  let lines: string[] = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, "utf-8").split("\n").filter((l) => !l.startsWith(`${varName}=`));
  }
  lines.push(`${varName}=${trimmed}`);
  writeFileSync(ENV_PATH, lines.filter(Boolean).join("\n") + "\n", "utf-8");
  process.env[varName] = trimmed;
}

let config: Config = loadConfig(CONFIG_PATH);
// loadConfig already resets the chat-driven AI settings (Search For list,
// custom instructions, general-deal toggle) in memory — write that back to
// disk immediately so config.json matches what's actually running from the
// moment of launch, instead of drifting stale until some unrelated save.
saveConfig(CONFIG_PATH, config);
const store = new Store(DB_PATH);

let mainWindow: BrowserWindow | null = null;
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

// Per explicit instruction — "when the user changes something in the
// filters or adds a new product to search for, stop the scan and restart
// it. this can prevent bugs." scrapeEngine.ts already re-fetches config
// fresh at several points mid-cycle (see runCycle's own getConfig() calls)
// so a change usually takes effect within moments anyway — but a full
// stop-then-start guarantees a completely clean cycle (fresh browser
// navigation, no lingering in-flight assumptions from before the change),
// which is a stronger guarantee against staleness than the surgical
// approach alone. Deliberately does NOTHING if the scanner isn't currently
// running — a filter/search-item change shouldn't start it on its own,
// that's still a separate, deliberate action (see add_search_item below,
// which already does its own explicit start-if-idle and calls this only
// for the "was already running" case).
let engineRestartInFlight = false;
let engineRestartQueued = false;
function restartEngineIfRunning(reason: string): void {
  if (!engine.getStatus().running) return;
  if (engineRestartInFlight) {
    // Another restart (e.g. for an earlier item in the same "Search for
    // Products" batch) is already tearing down/relaunching the browser —
    // queue one more pass after it finishes instead of racing a second
    // stop() against the same in-flight context close. The queued pass
    // still picks up whatever the LATEST config is by the time it runs
    // (engine.start()/getConfig() always reads current state), so nothing
    // from this request is lost, it just doesn't get its own separate
    // restart cycle.
    engineRestartQueued = true;
    return;
  }
  engineRestartInFlight = true;
  (async () => {
    do {
      engineRestartQueued = false;
      const line: LogLine = { ts: Date.now(), level: "info", message: `Restarting the scanner to apply ${reason}...` };
      recordLog(line);
      mainWindow?.webContents.send("engine:log", line);
      await engine.stop();
      engine.start();
    } while (engineRestartQueued);
  })()
    .catch((err) => console.error(`[engine-restart] failed to restart after ${reason}: ${(err as Error).message}`))
    .finally(() => {
      engineRestartInFlight = false;
    });
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
  const line: LogLine = { ts: Date.now(), level: "error", message: `Unhandled error (recovered, scanner should keep running): ${message}` };
  recordLog(line);
  mainWindow?.webContents.send("engine:log", line);
});
process.on("uncaughtException", (err) => {
  const line: LogLine = { ts: Date.now(), level: "error", message: `Unexpected error (recovered, scanner should keep running): ${err.message}` };
  recordLog(line);
  mainWindow?.webContents.send("engine:log", line);
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

// onSearchUpdate lets add_search_item report back a second time, after its
// fire-and-forget searchForItemNow actually finishes — the tool's own
// return value only covers the instant confirmation ("Searching..."), which
// used to be the last the user ever heard about it. currentProductId is
// only set (and only meaningful) for a "product"-context call — it's what
// add_product_watch_note attaches its note to, since that tool only makes
// sense scoped to whichever product page the conversation is happening on.
async function executeChatTool(
  call: ToolCall,
  context: ChatContext,
  onSearchUpdate?: (message: string) => void,
  currentProductId?: string
): Promise<string> {
  if (!allowedToolNames(context).has(call.name)) {
    return `Failed: "${call.name}" isn't available from this chat.`;
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
    const newItem = { item, matchKeywords, typicalResaleUsd };
    config = { ...config, searchItems: [...config.searchItems, newItem] };
    saveConfig(CONFIG_PATH, config);
    // Verified live miss — this was the actual root cause of "it doesn't
    // display the product that was searched for": every OTHER
    // config-mutating handler broadcasts config:updated so the renderer's
    // live copy (Dashboard's FiltersCard "Currently searching for" pills)
    // picks up the change immediately, but this one never did — the new
    // item was genuinely saved and used by the scanner, it just never told
    // the UI, so it looked like adding a product silently did nothing.
    mainWindow?.webContents.send("config:updated", config);
    const line: LogLine = {
      ts: Date.now(),
      level: "info",
      message: `Chat added to Search For: "${item}"${typicalResaleUsd > 0 ? ` (~$${typicalResaleUsd})` : " (no price set yet)"}`,
    };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
    // Per explicit instruction — asking the assistant to search for
    // something shouldn't require a separate trip to click "Start Scanner"
    // too, so this still starts the scanner fresh if it wasn't already
    // running — and when it wasn't, the one-off searchForItemNow right
    // below still fires for an immediate look rather than waiting for the
    // fresh cycle's own first pass to reach it.
    //
    // If the scanner WAS already running, per further explicit instruction
    // ("stop the scan and restart it" on a filter/search-item change — see
    // restartEngineIfRunning) this now does a full restart INSTEAD of the
    // one-off search, not alongside it — running both at once would race
    // restartEngineIfRunning's own engine.stop() (which tears down the
    // shared browser context) against searchForItemNow trying to use that
    // same context, risking a spurious "page closed"-type error for no
    // real benefit once the restart's own fresh cycle already covers
    // finding this item shortly anyway.
    if (!engine.getStatus().running) {
      engine.start();
      engine
        .searchForItemNow(newItem)
        .then((result) => onSearchUpdate?.(describeSearchOutcome(item, result)))
        .catch((err) => onSearchUpdate?.(`Search for "${item}" hit an unexpected error: ${(err as Error).message}`));
    } else {
      restartEngineIfRunning("your updated Search For list");
      onSearchUpdate?.(`Restarting the scanner so it picks up "${item}" from a clean cycle — check Activity for progress.`);
    }
    return typicalResaleUsd > 0
      ? `Added "${item}" to your Search For list with a reference price of $${typicalResaleUsd} — searching for it on Facebook Marketplace now.`
      : `Added "${item}" to your Search For list, but with no reference resale price set yet, so I can't tell you're getting a genuine deal on it. Searching for it now anyway so you can see what's out there.`;
  }

  if (call.name === "add_custom_instruction") {
    const instruction = String(call.args.instruction ?? "").trim();
    if (!instruction) return "Failed: no instruction text given.";
    config = { ...config, customInstructions: [config.customInstructions, instruction].filter(Boolean).join("\n") };
    saveConfig(CONFIG_PATH, config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat added custom instruction: "${instruction}"` };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
    return `Added to custom instructions: "${instruction}"`;
  }

  if (call.name === "research_product") {
    const product = String(call.args.product ?? "").trim();
    if (!product) return "Failed: no product name given.";
    // Fuzzy, not just exact — asking to research "PS5 Slim" when the
    // Database already has "PlayStation 5 Slim" (see store.ts's
    // findMatchingProduct) should refresh/reinforce that one entry, not
    // spawn a near-duplicate under the new phrasing.
    const existing = store.findMatchingProduct(product);
    if (existing) {
      store.setProductLoading(existing.id, true);
      mainWindow?.webContents.send("products:updated", store.getProductById(existing.id));
      runProductLookup(existing.id, existing.name);
      return `Already have a Database profile for "${existing.name}" — refreshing it with a fresh web search now, check the Database tab in a moment.`;
    }
    const id = randomUUID();
    store.addProductStub(id, product);
    mainWindow?.webContents.send("products:updated", store.getProductById(id));
    runProductLookup(id, product);
    return `Added "${product}" to the Database and researching it now — variant/identifying details will show up on the Database tab in a moment.`;
  }

  if (call.name === "add_product_watch_note") {
    if (!currentProductId) return "Failed: no product context for this note.";
    const note = String(call.args.note ?? "").trim();
    if (!note) return "Failed: no note text given.";
    const updated = store.appendProductWatchNote(currentProductId, note);
    if (!updated) return "Failed: that product no longer exists.";
    mainWindow?.webContents.send("products:updated", updated);
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
    mainWindow?.webContents.send("engine:log", line);
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
    mainWindow?.webContents.send("blacklist:updated", store.listBlacklistTerms());
    if (contextProduct?.imageUrl) mainWindow?.webContents.send("blacklistImages:updated", store.listBlacklistedImages());
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat blacklisted "${added.term}" — matching listings will be skipped automatically.` };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
    return `Blacklisted "${added.term}" — matching listings will be skipped automatically from now on.`;
  }

  if (call.name === "remove_blacklist_term") {
    const term = String(call.args.term ?? "").trim();
    if (!term) return "Failed: no term given.";
    store.removeBlacklistTerm(term);
    mainWindow?.webContents.send("blacklist:updated", store.listBlacklistTerms());
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
    mainWindow?.webContents.send("engine:log", line);
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
    mainWindow?.webContents.send("config:updated", config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat removed from Search For: "${item}"` };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
    restartEngineIfRunning("your updated Search For list");
    return `Removed "${item}" from your Search For list.`;
  }

  if (call.name === "update_config") {
    const a = call.args as Record<string, unknown>;
    const patch: Partial<Config> = {};
    const changed: string[] = [];

    if (typeof a.dealThresholdPercent === "number") { patch.dealThresholdPercent = a.dealThresholdPercent; changed.push("deal threshold"); }
    if (typeof a.listingsPerLocation === "number") { patch.listingsPerLocation = Math.max(1, Math.round(a.listingsPerLocation)); changed.push("listings per location"); }
    if (typeof a.pollIntervalMinutesMin === "number") { patch.pollIntervalMinutesMin = Math.max(0.5, a.pollIntervalMinutesMin); changed.push("min poll interval"); }
    if (typeof a.pollIntervalMinutesMax === "number") { patch.pollIntervalMinutesMax = Math.max(0.5, a.pollIntervalMinutesMax); changed.push("max poll interval"); }
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
    if (isNullableNumber("maxPriceUsd")) {
      patch.maxPriceUsd = a.maxPriceUsd as number | null;
      changed.push("max price");
    }
    if (isNullableNumber("minPriceUsd")) {
      patch.minPriceUsd = a.minPriceUsd as number | null;
      changed.push("min price");
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
    mainWindow?.webContents.send("config:updated", config);
    const line: LogLine = { ts: Date.now(), level: "info", message: `Chat updated settings: ${changed.join(", ")}` };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
    return `Updated: ${changed.join(", ")}.`;
  }

  if (call.name === "start_scanner") {
    if (engine.getStatus().running) return "The scanner is already running.";
    engine.start();
    return "Scanner started.";
  }

  if (call.name === "stop_scanner") {
    // Gating this on `running` alone used to leave a lingering window open
    // — running is only ever true during the continuous scan loop, but a
    // browser can also be open from login() or a chat-triggered search,
    // neither of which sets it. "Stop" should always close whatever's
    // actually open, not just decline when the specific loop isn't going.
    const wasRunning = engine.getStatus().running;
    const hadBrowser = engine.hasOpenBrowser();
    if (!wasRunning && !hadBrowser) return "Nothing to stop — the scanner isn't running and no browser window is open.";
    await engine.stop();
    return wasRunning ? "Scanner stopped, browser closed." : "Browser closed.";
  }

  if (call.name === "clear_feed") {
    const countBefore = store.listRecent(1, 0).length > 0;
    store.clearAllListings();
    const line: LogLine = { ts: Date.now(), level: "info", message: "Chat cleared the Feed." };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
    mainWindow?.webContents.send("listings:refresh");
    return countBefore ? "Feed cleared — every listing has been permanently deleted." : "Feed was already empty.";
  }

  return "Unknown tool.";
}

// Live one-liners the AI generates on its own — a reaction to a deal, or a
// recap after finishing a batch — streamed to the renderer on their own
// channel so the UI can tell "the AI chose to comment" apart from "the AI
// replied to your message." Best-effort: swallow failures so an OpenAI
// hiccup never interrupts scraping.
async function narrate(ctx: NarrationContext): Promise<void> {
  if (!process.env.OPENAI_API_KEY || !mainWindow) return;
  const requestId = randomUUID();
  try {
    mainWindow.webContents.send("ai:narrationStart", { requestId, kind: ctx.kind });
    const full = await streamNarration(ctx, (delta) => {
      mainWindow?.webContents.send("ai:narrationChunk", { requestId, delta });
    });
    mainWindow.webContents.send("ai:narrationDone", { requestId, full });
  } catch {
    mainWindow.webContents.send("ai:narrationError", { requestId });
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
const groupThumbnailsInFlight = new Set<string>();
function ensureGroupThumbnail(segments: string[]): void {
  if (segments.length < 2) return; // the top-level brand itself uses familyLogoUrl, not this
  const path = segments.join(" > ");
  const key = path.toLowerCase();
  if (groupThumbnailsInFlight.has(key) || store.getGroupThumbnail(path)) return;
  groupThumbnailsInFlight.add(key);
  (async () => {
    try {
      // "Xbox > Games" -> "Xbox Games"; "Xbox > Games > Xbox 360" -> "Xbox
      // 360 Games" (the specific generation first, since it's the more
      // useful search term, followed by the bucket word).
      const bucket = segments[1];
      const query = segments.length === 2 ? `${segments[0]} ${bucket}` : `${segments[segments.length - 1]} ${bucket}`;
      // findGroupImage now vision-verifies each candidate itself and
      // returns an already-downloaded data: URI, not a remote URL.
      const imageData = await findGroupImage(query);
      if (imageData) {
        store.setGroupThumbnail(path, imageData);
        mainWindow?.webContents.send("groupThumbnails:updated", { path, imageData });
      }
    } catch (err) {
      console.error(`[group-thumbnail] failed for "${path}": ${(err as Error).message}`);
    } finally {
      groupThumbnailsInFlight.delete(key);
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
async function fetchAndStoreEbayComps(
  id: string,
  fallbackName: string
): Promise<{ avgSoldPriceUsd: number | null; avgRunTimeDays: number | null; avgShippingUsd: number | null; sampleSize: number }> {
  const images = [...store.listProductImages(id)].sort((a, b) => a.createdAt - b.createdAt);
  const original = images.find((img) => img.sourceTitle);
  const query = await deriveWatchCountQuery(fallbackName, original?.sourceTitle ?? null, original?.imageData ?? null);
  const comps = await engine.fetchEbayComps(query);
  const analysis = await analyzeEbayComps(query, comps);
  store.updateProductEbayComps(id, analysis);
  engine.markEbayCompsResearched(id);
  return analysis;
}

// Runs in the background — the IPC handler that triggers this returns the
// loading stub immediately so the UI doesn't block, then this pushes a
// live update once the web research resolves. Errors are logged, not
// thrown, since nothing awaits this.
async function runProductLookup(
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
  opts: { skipSiblingDiscovery?: boolean; forcedFamily?: string } = {}
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
  try {
    const result = await lookupProduct(name);

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
      imageUrl = await buildImageCollage(store.listProductImages(id).map((img) => img.imageData));
    }

    store.updateProductProfile(id, {
      ...result,
      family: resolvedFamily,
      familyLogoUrl,
      imageUrl,
    });

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
    if (config.watchCountOncePerScan && engine.hasResearchedEbayComps(id)) {
      const line: LogLine = {
        ts: Date.now(),
        level: "info",
        message: `Skipped eBay comps for "${name}" — already checked once this scan.`,
      };
      recordLog(line);
      mainWindow?.webContents.send("engine:log", line);
    } else {
      try {
        await fetchAndStoreEbayComps(id, name);
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
    if (!opts.skipSiblingDiscovery && !hadFamilyBefore && resolvedFamily && config.autoResearchListings) {
      const segments = resolvedFamily.split(">").map((s) => s.trim());
      if (segments.length >= 3 && segments[1].toLowerCase() === "games") {
        discoverAndCreateSiblingProducts(segments[0], segments[2], result.category, resolvedFamily).catch((err) =>
          console.error(`[siblings] discovery failed for "${resolvedFamily}": ${(err as Error).message}`)
        );
      }
    }
  } catch (err) {
    store.updateProductProfile(id, {
      aiSummary: `(Research failed: ${(err as Error).message})`,
      category: "Other",
      family: before?.family ?? null,
      familyLogoUrl: before?.familyLogoUrl ?? null,
      imageUrl: before?.imageUrl ?? null,
    });
  }
  const updated = store.getProductById(id);
  if (updated) mainWindow?.webContents.send("products:updated", updated);
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
const SIBLING_DISCOVERY_COUNT = 6;

async function discoverAndCreateSiblingProducts(brand: string, generation: string, category: string, familyPath: string): Promise<void> {
  // Fresh query at call time (not the products list from whenever the
  // triggering research started) — if two different games for the same
  // generation get researched close together, the second one's own
  // discovery pass should already see whatever the first one just added,
  // rather than both independently suggesting (and racing to create) the
  // same handful of titles.
  const alreadyTracked = store
    .listProducts()
    .filter((p) => p.family && (p.family === familyPath || p.family.toLowerCase().startsWith(`${familyPath.toLowerCase()} >`)))
    .map((p) => p.name);

  const titles = await discoverSiblingProducts({ brand, generation, category, count: SIBLING_DISCOVERY_COUNT, alreadyTracked });
  if (!titles.length) return;

  for (const title of titles) {
    // Skip anything that already matches an existing product (exactly or
    // fuzzily) ANYWHERE in the Database, not just this family — a game
    // that's somehow already tracked under a different/wrong family
    // shouldn't get a duplicate entry here; Refresh on the existing one is
    // how that'd get corrected instead.
    if (store.findMatchingProduct(title)) continue;
    const id = randomUUID();
    store.addProductStub(id, title);
    mainWindow?.webContents.send("products:updated", store.getProductById(id));
    await runProductLookup(id, title, { skipSiblingDiscovery: true, forcedFamily: familyPath });
  }
}

const engine = new ScrapeEngine({
  profileDir: PROFILE_DIR,
  getConfig: () => config,
  store,
  onLog: (line) => {
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
  },
  onListing: (record) => mainWindow?.webContents.send("engine:listing", record),
  onProductUpdated: (product) => mainWindow?.webContents.send("products:updated", product),
  onStatus: (status) => mainWindow?.webContents.send("engine:status", status),
  onNarrate: narrate,
  onBlacklistUpdated: (terms) => mainWindow?.webContents.send("blacklist:updated", terms),
  onBlacklistImagesUpdated: (images) => mainWindow?.webContents.send("blacklistImages:updated", images),
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
  onNewProductFound: (name, imageDataUri, sourceTitle) => {
    const id = randomUUID();
    store.addProductStub(id, name);
    if (imageDataUri) {
      store.editProductProfile(id, { imageUrl: imageDataUri });
      store.addProductImage(id, imageDataUri, sourceTitle);
    }
    mainWindow?.webContents.send("products:updated", store.getProductById(id));
    runProductLookup(id, name);
    const line: LogLine = {
      ts: Date.now(),
      level: "info",
      message: `New item of interest found while scanning: added "${name}" to the Database${
        imageDataUri ? " with a photo from this listing" : ""
      } (from "${sourceTitle}").`,
      productName: name,
    };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
  },
});

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
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Per explicit instruction — the user has to actually deal with (save or
  // deliberately discard) unsaved Config changes before the app closes,
  // not lose them silently. Every close attempt is intercepted and handed
  // to the renderer, which shows its own themed Save/Discard/Cancel dialog
  // ONLY when Config actually has unsaved edits (see Config.tsx) — a close
  // with nothing unsaved gets waved through immediately, so this never
  // adds a prompt to the common case.
  mainWindow.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    mainWindow?.webContents.send("app:closeRequested");
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle("config:get", () => config);
  ipcMain.handle("config:save", (_e, next: Config) => {
    config = { ...DEFAULT_CONFIG, ...next };
    saveConfig(CONFIG_PATH, config);
    // So another mounted view (e.g. Dashboard's Filters box) reflects a
    // change made from the Config screen itself, same as the reverse
    // direction already works via update_config's own broadcast.
    mainWindow?.webContents.send("config:updated", config);
  });
  ipcMain.handle("config:reset", () => {
    config = { ...DEFAULT_CONFIG };
    saveConfig(CONFIG_PATH, config);
    mainWindow?.webContents.send("config:updated", config);
    return config;
  });

  // Per explicit instruction — the Dashboard's own Filters box: a quicker,
  // more visible home for the things a user adjusts often (current Search
  // For items, price range, freshness) than digging into the full Config
  // screen. A single patch-shaped endpoint (not one IPC channel per field)
  // specifically so more filters can be added here later ("I'll have more
  // soon") without new plumbing each time. Patches against the CURRENT
  // authoritative `config`, not a client-sent full snapshot like
  // config:save above — Dashboard only ever has a few fields in view, so
  // round-tripping its own stale copy of the WHOLE config back through
  // config:save risked silently clobbering something changed elsewhere
  // (Config screen, chat) in between.
  ipcMain.handle(
    "filters:update",
    (_e, patch: Partial<Pick<Config, "minPriceUsd" | "maxPriceUsd" | "maxListingAgeHours" | "rotateSearchItems" | "rotateSearchItemsCount">>) => {
      config = { ...config, ...patch };
      saveConfig(CONFIG_PATH, config);
      mainWindow?.webContents.send("config:updated", config);
      restartEngineIfRunning("your filter changes");
    }
  );
  ipcMain.handle("filters:removeSearchItem", (_e, args: { item: string }) => {
    config = { ...config, searchItems: config.searchItems.filter((s) => s.item !== args.item) };
    saveConfig(CONFIG_PATH, config);
    mainWindow?.webContents.send("config:updated", config);
    restartEngineIfRunning("your updated Search For list");
    const line: LogLine = { ts: Date.now(), level: "info", message: `Removed from Search For: "${args.item}"` };
    recordLog(line);
    mainWindow?.webContents.send("engine:log", line);
  });

  // The other half of the close-guard above — the renderer calls this once
  // it's actually fine to close (nothing was unsaved, or the user just
  // chose Save & Close / Discard & Close on its own dialog).
  ipcMain.on("app:confirmClose", () => {
    allowClose = true;
    mainWindow?.close();
  });

  ipcMain.handle("env:hasOpenAIKey", () => !!process.env.OPENAI_API_KEY);
  ipcMain.handle("env:saveOpenAIKey", (_e, key: string) => saveEnvKey("OPENAI_API_KEY", key));

  ipcMain.handle("engine:status", () => engine.getStatus());
  ipcMain.handle("engine:start", () => engine.start());
  ipcMain.handle("engine:stop", () => engine.stop());
  ipcMain.handle("engine:runOnce", () => engine.triggerOnce());
  ipcMain.handle("engine:login", () => engine.login());
  ipcMain.handle("engine:checkLogin", () => engine.checkLogin());
  ipcMain.handle("engine:openWatchCountLogin", () => engine.openWatchCountLogin());

  // Per explicit instruction — Config's own "Search locations" dropdown:
  // "country" restores the full nationwide spread, "state" replaces
  // browseUrls with the AI's own top-10-major-cities lookup for one state
  // (each resolved to a real Facebook location, 40-mile radius), "city"
  // replaces it with exactly one resolved location for a specific city or
  // ZIP. All three fully REPLACE browseUrls rather than appending — this
  // is "where should the scanner look," not "add more places to look."
  ipcMain.handle(
    "location:setMode",
    async (
      _e,
      args: { mode: "country" } | { mode: "state"; state: string } | { mode: "city"; cityOrZip: string }
    ): Promise<{ ok: boolean; message: string }> => {
      if (args.mode === "country") {
        config = {
          ...config,
          locationMode: "country",
          selectedState: null,
          selectedCityOrZip: null,
          searchRadiusMiles: 100,
          browseUrls: [...DEFAULT_BROWSE_URLS],
        };
        saveConfig(CONFIG_PATH, config);
        mainWindow?.webContents.send("config:updated", config);
        restartEngineIfRunning("your location settings");
        return { ok: true, message: `Switched to nationwide rotation — ${DEFAULT_BROWSE_URLS.length} locations.` };
      }

      if (args.mode === "city") {
        const cityOrZip = args.cityOrZip.trim();
        if (!cityOrZip) return { ok: false, message: "Enter a city or ZIP code first." };
        // Per explicit instruction — a specific city/ZIP search should only
        // ever cover 20 miles around that exact spot, set live in the SAME
        // "Change location" dialog visit (and the same Apply click) that
        // resolves the location itself, not left to drift until the next
        // scan cycle's own verifyOrSetRadius check corrects it.
        const CITY_MODE_RADIUS_MILES = 20;
        const [result] = await engine.discoverLocations([cityOrZip], CITY_MODE_RADIUS_MILES);
        if (!result.url) {
          return {
            ok: false,
            message: `Couldn't find "${cityOrZip}" on Facebook Marketplace (${result.error ?? "no matching suggestion"}) — try typing it exactly as you would into Facebook's own location search, e.g. "Sacramento, California" (full state name, not an abbreviation).`,
          };
        }
        // Per explicit instruction — a specific city/ZIP search should also
        // skip any listing that resolves to a different state entirely (a
        // wide-enough radius near a state line can still pull in
        // out-of-state listings). A ZIP code alone doesn't say what state
        // it's in, so this trusts Facebook's OWN confirmation of the
        // location it actually applied (see scraper.ts's changeLocation),
        // not the raw text the user typed in.
        config = {
          ...config,
          locationMode: "city",
          selectedState: result.resolvedState,
          selectedCityOrZip: cityOrZip,
          searchRadiusMiles: CITY_MODE_RADIUS_MILES,
          browseUrls: [result.url],
        };
        saveConfig(CONFIG_PATH, config);
        mainWindow?.webContents.send("config:updated", config);
        restartEngineIfRunning("your location settings");
        return { ok: true, message: `Now searching only ${cityOrZip}, within ${CITY_MODE_RADIUS_MILES} miles.` };
      }

      const state = args.state.trim();
      if (!state) return { ok: false, message: "Pick a state first." };
      // Per explicit instruction — resolving 10 separate cities (10 real
      // "Change location" dialog drives) before a scan could even start was
      // genuinely slow for what it bought. One well-chosen city with a
      // wide-enough radius covers a state just as well for browsing
      // purposes, so this now asks the AI for just the ONE most
      // populous/well-known city in the state, formatted as "City, ST" —
      // the literal string that gets typed into Facebook's own location
      // search — and resolves that single location instead of ten.
      const STATE_MODE_RADIUS_MILES = 40;
      let primaryCity: string;
      try {
        primaryCity = await lookupPrimaryCityInState(state);
      } catch (err) {
        return { ok: false, message: `Couldn't look up a city for ${state}: ${(err as Error).message}` };
      }
      const [result] = await engine.discoverLocations([primaryCity], STATE_MODE_RADIUS_MILES);
      if (!result.url) {
        return {
          ok: false,
          message: `Found "${primaryCity}" as ${state}'s primary city but couldn't resolve it on Facebook Marketplace (${result.error ?? "no matching suggestion"}) — check Activity for details.`,
        };
      }
      config = {
        ...config,
        locationMode: "state",
        selectedState: state,
        selectedCityOrZip: null,
        searchRadiusMiles: STATE_MODE_RADIUS_MILES,
        browseUrls: [result.url],
      };
      saveConfig(CONFIG_PATH, config);
      mainWindow?.webContents.send("config:updated", config);
      restartEngineIfRunning("your location settings");
      return {
        ok: true,
        message: `Now searching ${primaryCity} (${state}), within ${STATE_MODE_RADIUS_MILES} miles — anything found outside ${state} is skipped.`,
      };
    }
  );

  ipcMain.handle("listings:list", (_e, args: { limit?: number; offset?: number }) =>
    store.listRecent(args?.limit ?? 200, args?.offset ?? 0)
  );
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

      const existing = store.findMatchingProduct(subject);
      if (existing) {
        const noteParts = [
          listing.price !== null ? `$${listing.price}` : null,
          listing.extractedAttributes || null,
          listing.photoAnalysis ? `Photo analysis: ${listing.photoAnalysis.slice(0, 500)}` : null,
          reason ? `User was interested because: ${reason}` : null,
        ].filter((p): p is string => !!p);
        const updated = noteParts.length ? store.recordProductObservation(subject, noteParts.join(" — ")) : existing;
        if (updated) mainWindow?.webContents.send("products:updated", updated);
        return { ok: true, message: `Reinforced the existing "${existing.name}" profile with this listing.`, productId: existing.id };
      }

      const id = randomUUID();
      store.addProductStub(id, subject);
      // Per explicit instruction — same pattern as scrapeEngine.ts's
      // onNewProductFound: a real photo from THIS listing shows immediately
      // as a placeholder and is saved into the Reference Photos gallery,
      // but isn't kept as the permanent thumbnail — the background
      // web-research lookup below gets to replace it with a clean,
      // representative product photo instead.
      const listingImage = listing.thumbnailUrl ?? listing.imageUrls[0] ?? null;
      const imageDataUri = listingImage ? await downloadImageAsDataUri(listingImage) : null;
      if (imageDataUri) {
        store.editProductProfile(id, { imageUrl: imageDataUri });
        store.addProductImage(id, imageDataUri, listing.title);
      }
      if (reason) {
        store.recordProductObservation(subject, `User was interested because: ${reason}`);
      }
      mainWindow?.webContents.send("products:updated", store.getProductById(id));
      runProductLookup(id, subject);
      return { ok: true, message: `Added "${subject}" to the Database and researching it now.`, productId: id };
    }
  );

  ipcMain.handle("products:list", () => store.listProducts());
  // The Database screen's own client-side cache of folder-level thumbnails
  // (see ensureGroupThumbnail above) — fetched once up front since this
  // dataset stays small (one row per distinct sub-grouping actually seen),
  // then kept live via the groupThumbnails:updated push.
  ipcMain.handle("products:listGroupThumbnails", () => store.listGroupThumbnails());


  ipcMain.handle("products:refresh", (_e, args: { id: string }) => {
    const product = store.getProductById(args.id);
    if (!product) return null;
    store.setProductLoading(args.id, true);
    runProductLookup(args.id, product.name);
    return store.getProductById(args.id);
  });

  ipcMain.handle("products:delete", (_e, args: { id: string }) => store.deleteProduct(args.id));
  ipcMain.handle("products:clearAll", () => store.clearAllProducts());

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
    if (imageDataUri) store.addProductImage(id, imageDataUri, null);
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
    store.editProductProfile(args.id, { imageUrl: args.imageDataUri });
    const updated = store.getProductById(args.id);
    if (updated) mainWindow?.webContents.send("products:updated", updated);
    return updated;
  });

  // The per-product reference-photo library (see types.ts's ProductImage) —
  // auto-populated from confirmed deals (scrapeEngine.ts's evaluateListing),
  // plus whatever the user adds/removes by hand here.
  ipcMain.handle("products:listImages", (_e, args: { productId: string }) => store.listProductImages(args.productId));
  ipcMain.handle("products:addImage", async (_e, args: { productId: string }) => {
    const dataUri = await pickImageAsDataUri("Add a reference photo");
    if (!dataUri) return null;
    return store.addProductImage(args.productId, dataUri, null);
  });
  ipcMain.handle("products:deleteImage", (_e, args: { imageId: string }) => store.deleteProductImage(args.imageId));

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
      engine.searchForItemNow(existing).catch(() => {});
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
      const analysis = await fetchAndStoreEbayComps(args.id, product.name);
      mainWindow?.webContents.send("products:updated", store.getProductById(args.id));
      return {
        ok: true,
        message:
          analysis.sampleSize > 0
            ? `Found ${analysis.sampleSize} matching sold comp(s) on WatchCount.`
            : "Checked WatchCount but found no confidently-matching sold comps.",
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
  // (which itself adds to the Search For list, starts the scanner if it
  // isn't already running, and kicks off an immediate dedicated search),
  // and just re-triggers searchForItemNow for anything that's already a
  // Search For item so re-submitting the same name later doesn't pile up
  // duplicate config entries. Sequential, not parallel — each add_search_item
  // call does its own config read-modify-write against the shared in-memory
  // `config`, and running them concurrently could race and drop one.
  ipcMain.handle(
    "search:addProducts",
    async (_e, args: { items: string[] }): Promise<{ ok: boolean; message: string }> => {
      const seen = new Set<string>();
      const names = args.items.filter((name) => {
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!names.length) return { ok: false, message: "No products given." };

      // Per explicit instruction — using this box at all is an inherently
      // exclusive ask, same as a chat request phrased "find me PS5s, I
      // don't want to see t-shirts or random junk" (see the chat
      // assistant's own set_general_deal_detection guidance above, which
      // already turns this off for that kind of request) — just never
      // wired up for the Dashboard's own search box until now. Without it,
      // general deal detection staying on by default meant evaluateListing's
      // off-topic skip (scrapeEngine.ts) never actually fired, so nothing
      // stopped the scanner from opening whatever unrelated stuff the
      // plain general-feed browse turned up right after the dedicated
      // search finished — reported live as "searched xbox series x
      // correctly, but after looking at one listing, lost all the terms
      // and went back to a general search." Deliberately fires on EVERY
      // submission through this box, not just a brand new item — hitting
      // Search again for something already tracked is the same exclusive
      // intent repeated, and it's also the only way an already-running
      // session (started before this fix existed) gets it applied without
      // a full app restart.
      if (config.generalDeal.enabled) {
        config = { ...config, generalDeal: { ...config.generalDeal, enabled: false } };
        saveConfig(CONFIG_PATH, config);
        mainWindow?.webContents.send("config:updated", config);
        const line: LogLine = {
          ts: Date.now(),
          level: "info",
          message: "Turned general (unverified) deal detection off — searching for a specific product now stays focused on your Search For list only.",
        };
        recordLog(line);
        mainWindow?.webContents.send("engine:log", line);
      }

      const results: string[] = [];
      for (const name of names) {
        const existing = config.searchItems.find((i) => i.item.toLowerCase() === name.toLowerCase());
        if (existing) {
          engine.searchForItemNow(existing).catch(() => {});
          results.push(`Searching for "${existing.item}" again`);
          continue;
        }
        const message = await executeChatTool(
          { name: "add_search_item", args: { item: name, matchKeywords: [name.toLowerCase()], typicalResaleUsd: 0 } },
          "dashboard"
        );
        results.push(message);
      }
      return { ok: true, message: results.join(" · ") };
    }
  );

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
            .listProducts()
            .map((p) => p.name)
            .filter((n) => n.toLowerCase() !== args.currentLabel.toLowerCase())
        : [];
      const recon = await reconsiderImageFeedback(args.imageDataUri, args.currentLabel, args.feedback, knownProducts);
      if (recon.error) return { ok: false, message: `Couldn't reconsider that image: ${recon.error}` };

      if (args.kind === "blacklisted" && args.imageId) {
        if (recon.actualSubject) {
          store.removeBlacklistedImage(args.imageId);
          mainWindow?.webContents.send("blacklistImages:updated", store.listBlacklistedImages());
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
          if (updated) mainWindow?.webContents.send("products:updated", updated);
        }
        if (recon.actualSubject && recon.actualSubject.toLowerCase() !== args.currentLabel.toLowerCase()) {
          store.deleteProductImage(args.imageId);
          let target = store.findMatchingProduct(recon.actualSubject);
          if (target) {
            store.addProductImage(target.id, args.imageDataUri, args.sourceTitle ?? null);
            mainWindow?.webContents.send("products:updated", store.getProductById(target.id));
          } else {
            const newId = randomUUID();
            store.addProductStub(newId, recon.actualSubject);
            store.editProductProfile(newId, { imageUrl: args.imageDataUri, keepThumbnail: true });
            mainWindow?.webContents.send("products:updated", store.getProductById(newId));
            runProductLookup(newId, recon.actualSubject);
            target = store.getProductById(newId);
          }
          return { ok: true, message: `Moved to "${target?.name ?? recon.actualSubject}" — thanks for catching that.` };
        }
        return { ok: true, message: "Thanks — noted for next time." };
      }

      if (args.kind === "thumbnail" && args.productId) {
        if (recon.note) {
          const updated = store.appendProductWatchNote(args.productId, `Correction: ${recon.note}`);
          if (updated) mainWindow?.webContents.send("products:updated", updated);
        }
        if (recon.actualSubject && recon.actualSubject.toLowerCase() !== args.currentLabel.toLowerCase()) {
          store.editProductProfile(args.productId, { imageUrl: null, keepThumbnail: false });
          const updated = store.getProductById(args.productId);
          if (updated) mainWindow?.webContents.send("products:updated", updated);
          return { ok: true, message: "Cleared this thumbnail — it looked like a photo of something else. Refresh will find a new one." };
        }
        return { ok: true, message: "Thanks — noted for next time." };
      }

      return { ok: false, message: "Couldn't figure out what to do with that feedback." };
    }
  );

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
    if (added && (args.imageDataUri ?? null)) mainWindow?.webContents.send("blacklistImages:updated", store.listBlacklistedImages());
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
      }
    ) => {
      try {
        const recentListings = args.context === "dashboard" || args.context === "global" ? store.listRecent(10, 0) : [];
        // Dashboard (and now "global", the persistent bottom bar) also
        // needs an accurate product count and the real blacklist (see
        // buildDashboardSystemPrompt) — both have their own
        // add_blacklist_term/remove_blacklist_term tools, and a stale
        // "Blacklist (0): none yet" in the system prompt regardless of
        // actual state would be actively misleading.
        const products = args.context === "database" || args.context === "dashboard" || args.context === "global" ? store.listProducts() : [];
        const currentProduct = args.context === "product" && args.productId ? store.getProductById(args.productId) : null;
        const blacklistTerms =
          args.context === "database" || args.context === "dashboard" || args.context === "global" ? store.listBlacklistTerms() : [];
        const full = await streamChat(
          args.message,
          args.history,
          args.context,
          config,
          recentLogs,
          recentListings,
          products,
          (delta) => {
            event.sender.send("ai:chatChunk", { requestId: args.requestId, delta });
          },
          (call) =>
            executeChatTool(
              call,
              args.context,
              (message) => {
                event.sender.send("ai:searchUpdate", { requestId: args.requestId, message });
              },
              currentProduct?.id
            ),
          currentProduct,
          blacklistTerms,
          args.attachments ?? []
        );
        event.sender.send("ai:chatDone", { requestId: args.requestId, full });
      } catch (err) {
        event.sender.send("ai:chatError", { requestId: args.requestId, message: (err as Error).message });
      }
    }
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await engine.shutdown();
  store.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await engine.shutdown();
});
