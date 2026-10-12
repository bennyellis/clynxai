import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type Screen } from "./components/Sidebar.js";
import { StarfieldBackground } from "./components/StarfieldBackground.js";
import { SpaceBackdrop } from "./components/SpaceBackdrop.js";
import { GlobalAssistantBar } from "./components/GlobalAssistantBar.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Activity } from "./screens/Activity.js";
import { Feed } from "./screens/Feed.js";
import { WatchScreen } from "./screens/Watch.js";
import { ConfigScreen } from "./screens/Config.js";
import { Database } from "./screens/Database.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { useNotices } from "./components/NoticesPanel.js";
import { describeScannerState } from "./lib/scannerState.js";
import { FreezeWhenHidden, ScreenActive } from "./lib/screenActive.js";
import { getTier } from "./lib/performance.js";
import { api } from "./lib/api.js";
import type { Account, ListingRecord, LogLine, ScrapeStatus, StartupProblem } from "./lib/api.js";
import { playDealSound, playClickSound, playHoverSound, setSoundEnabled } from "./lib/sound.js";
import { applyPanelTransparency, applyThemeColors } from "./lib/colorScheme.js";
import { onParticlesToggle } from "./lib/particles.js";

const MAX_LOGS = 300;

// Every refresh hands back brand-new objects for all 500 listings, even the
// ones that haven't changed — so every card would look "changed" to React and
// re-render on every refresh. This keeps the previous object for any listing
// whose content is identical, so only listings that actually changed (a new
// one, a re-scored one, a deleted one) cause any rendering at all. If nothing
// changed it returns the previous array itself, so the whole tree is skipped.
//
// The comparison is a cheap fingerprint of the fields that can change after a
// listing is first saved — NOT a JSON.stringify of the whole record. Real
// records carry multi-KB descriptions and photo analyses, and stringifying
// 500 of them on every refresh (several MB) froze the UI thread for tens of
// milliseconds each time. Long text is stamped by length plus its first and
// last characters, which is enough to notice any real re-score or edit.
function textStamp(s: string | null | undefined): string {
  return s ? `${s.length}:${s.slice(0, 16)}:${s.slice(-16)}` : "";
}
const listingSignatures = new WeakMap<ListingRecord, string>();
function listingSignature(l: ListingRecord): string {
  let sig = listingSignatures.get(l);
  if (sig === undefined) {
    const imgs = l.imageUrls ?? [];
    sig = [
      l.id, l.source, l.title, l.price, textStamp(l.thumbnailUrl), imgs.length, textStamp(imgs[0]), textStamp(imgs[imgs.length - 1]),
      textStamp(l.description), l.locationText, l.listingAge, l.matchedItem, l.referencePriceUsd, l.discountPercent,
      l.conditionImpact, l.confidence, textStamp(l.reasoning), textStamp(l.extractedAttributes), l.shippingMentioned,
      l.isDeal, l.dealTier, l.dealStatus, l.gateHeadline, l.gateStars, l.requiredDiscountPercent, l.targetPriceUsd, l.gateFacts?.lotValueUsd, l.gateFacts?.profitAtAskUsd, l.gateFacts?.sampleSize, l.gateFacts?.evidenceLevel, l.estimatedValueRange, l.notified, l.feedback, l.feedbackNote,
      l.sellerName, l.sellerJoinedYear, l.sellerRating, l.sellerRatingCount, l.sellerHasProfilePhoto, l.sellerRiskPassed,
      l.sellerRiskReasons?.length ?? 0, textStamp(l.photoAnalysis), l.photoAnalysisCheckedAt, l.photoFlaws?.length ?? 0,
      l.matchedProductAvgSoldPriceUsd, l.matchedProductAvgRunTimeDays, l.foundByAccountId,
    ].join("|");
    listingSignatures.set(l, sig);
  }
  return sig;
}
const MAX_LISTINGS_IN_MEMORY = 500;

// Folds listings the main process just announced into the current list without refetching it:
// a listing already here is replaced if it really changed (same signature check as above),
// a new one is added at the top. Unchanged records keep their identity, so their cards don't
// re-render. (Refetching all 500 listings on every announcement cost ~0.7s of the main
// process and several MB of IPC each time, continuously while a scan was running.)
function applyListingUpdates(prev: ListingRecord[], updates: ListingRecord[]): ListingRecord[] {
  const indexById = new Map(prev.map((l, i) => [l.id, i]));
  let next = prev;
  const fresh: ListingRecord[] = [];
  for (const record of updates) {
    const i = indexById.get(record.id);
    if (i === undefined) {
      fresh.push(record);
    } else if (listingSignature(next[i]) !== listingSignature(record)) {
      if (next === prev) next = prev.slice();
      next[i] = record;
    }
  }
  if (!fresh.length) return next;
  fresh.sort((x, y) => y.firstSeenAt - x.firstSeenAt);
  return [...fresh, ...next].slice(0, MAX_LISTINGS_IN_MEMORY);
}

function reconcileListings(prev: ListingRecord[], next: ListingRecord[]): ListingRecord[] {
  const prevById = new Map(prev.map((l) => [l.id, l]));
  let identical = prev.length === next.length;
  const merged = next.map((incoming, i) => {
    const old = prevById.get(incoming.id);
    const kept = old && listingSignature(old) === listingSignature(incoming) ? old : incoming;
    if (identical && prev[i] !== kept) identical = false;
    return kept;
  });
  return identical ? prev : merged;
}

// Fallback for Activity's "currently searching" pill before that account's
// first engine:statusMap push has arrived (or if there are no accounts at
// all yet, briefly, on a very first launch) — same idle shape ScrapeStatus
// state used to be initialized to before it became a per-account map.
const EMPTY_STATUS: ScrapeStatus = {
  running: false,
  loggedIn: null,
  currentSearch: null,
  listingsThisCycle: 0,
  locationIndex: 0,
  lastCycleStartedAt: null,
  lastCycleFinishedAt: null,
  lastError: null,
  currentListing: null,
  upcomingListings: [],
  currentActionNote: null,
  analyzingPhotos: false,
  currentReaction: null,
};

const DEFAULT_CLOUD_API_URL = "http://localhost:8787";

// Each screen only re-renders when ITS props change (the screens are all
// mounted at once, so without this every status/log update re-rendered all of
// them, including hundreds of Feed cards).
const DashboardMemo = React.memo(Dashboard);
const ActivityMemo = React.memo(Activity);
const FeedMemo = React.memo(Feed);
const WatchMemo = React.memo(WatchScreen);
const DatabaseMemo = React.memo(Database);
const ConfigMemo = React.memo(ConfigScreen);

// How often the live scan panels may repaint, by performance mode: Visual as designed, Balanced about 1.6x slower, Performance 2.5x slower
// (a log line is still on screen within about 0.6 s). Only the on-screen representation is throttled; every event is still received,
// stored and acted on at once.
function liveMs(base: number): number {
  const tier = getTier();
  return tier === "visual" ? base : Math.round(base * (tier === "balanced" ? 1.6 : 2.5));
}

export default function App() {
  // Multi-user login migration — the entire app (Dashboard/Config/Watch/
  // everything below) stays hidden behind LoginScreen until this resolves.
  // authChecked distinguishes "still checking" (brief loading state) from
  // "checked, and not authenticated" (show LoginScreen) — both start false/
  // false so a fresh mount never flashes the real app before the check
  // lands.
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [defaultApiUrl, setDefaultApiUrl] = useState(DEFAULT_CLOUD_API_URL);
  // Opening the user's data failed (see index.ts's bootstrapOrExplain): shown on the login screen with a Try again button.
  const [startupProblem, setStartupProblem] = useState<StartupProblem | null>(null);

  const checkSession = useCallback(() => {
    api.auth
      .getSession()
      .then((session) => {
        if (session.apiUrl) setDefaultApiUrl(session.apiUrl);
        setAuthenticated(session.authenticated);
        setStartupProblem(session.startupProblem ?? null);
        setAuthChecked(true);
      })
      .catch((err: Error) => {
        // Never leave the window on "Loading...": say that something went wrong and offer to try again.
        setStartupProblem({
          kind: "unknown",
          title: "Clynx couldn't start",
          message: `Something went wrong while starting (${String(err?.message ?? err).split("\n")[0].slice(0, 140)}). Click Try again.`,
          folder: null,
        });
        setAuthenticated(false);
        setAuthChecked(true);
      });
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Passed to LoginScreen — re-checks session state after a successful
  // login/register rather than just trusting that call's own result,
  // matching the app's existing "re-fetch from main after a mutation"
  // posture elsewhere (config:updated, watches:updated, etc.).
  const handleAuthenticated = useCallback(() => {
    setAuthChecked(false);
    checkSession();
  }, [checkSession]);

  const [screen, setScreen] = useState<Screen>("dashboard");
  // Per explicit instruction — multiple Facebook accounts, each its own
  // ScrapeEngine/status (see index.ts's engineStatusMap) — a flat map
  // instead of one shared ScrapeStatus, keyed by account id. Dashboard
  // renders one row/Live panel per account; Sidebar/Activity still reduce
  // this down to an aggregate or "the first account" respectively, since
  // full per-account detail there wasn't asked for.
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, ScrapeStatus>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [listings, setListings] = useState<ListingRecord[]>([]);
  // Per explicit instruction — Feed's Research button takes the user
  // straight to that product's own Database page. Database.tsx consumes
  // this (via requestedProductId/onRequestedProductHandled below) and
  // clears it back to null once it's actually navigated there.
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  // Per explicit instruction — Config reports its own unsaved-changes state
  // up here (see ConfigScreen's onDirtyChange), since App.tsx is what
  // actually decides whether a Sidebar tab switch is allowed to go through.
  const [configDirty, setConfigDirty] = useState(false);
  // Incrementing, not a boolean — bumped every time a switch gets denied so
  // ConfigScreen's shake/highlight effect (keyed on this value changing)
  // still re-fires on a second denied attempt even before the first one's
  // animation has finished.
  const [configShakeSignal, setConfigShakeSignal] = useState(0);
  // Per explicit instruction — Config's "No particles" switch. Defaults
  // true (particles on) — matches DEFAULT_CONFIG, and avoids a flash of
  // "off" before the real config loads.
  const [particlesEnabled, setParticlesEnabled] = useState(true);
  // Per explicit instruction — "a subtle indicator/pulse until the user
  // visits Watch." Refreshed on mount and whenever config or the watches
  // list changes (a new match, or the user visiting Watch and clearing
  // config.watch.matchesLastViewedAt) — see index.ts's watch:hasUnseenMatches.
  const [hasUnseenWatchMatches, setHasUnseenWatchMatches] = useState(false);
  const refreshUnseenWatchMatches = useCallback(() => {
    api.hasUnseenWatchMatches().then(setHasUnseenWatchMatches);
  }, []);
  // The sidebar shows the scanner and Watch as two separate things: the
  // Dashboard icon is live while the SCANNER works, the Watch eye is live while
  // WATCH is on. Watch is on when it isn't paused globally and at least one
  // watch is enabled (the same rule the Watch screen uses for "Watching"). The
  // eBay engine also searches for Watches, so eBay only counts as scanner
  // activity when there are Search For items it could be searching for.
  const [hasSearchItems, setHasSearchItems] = useState(false);
  // What the scanner is doing, in one word: the Feed's empty states say the right thing for each (see lib/scannerState.ts). Only the kind is
  // passed down, so the Feed does not re-render on every scan tick.
  const notices = useNotices();
  // eBay stands in for "the scanner" in the sidebar icons only when Facebook is
  // switched off (then it's the only thing there is to scan with).
  const [facebookEnabled, setFacebookEnabled] = useState(true);
  const [watchPaused, setWatchPaused] = useState(false);
  // A Watch's check is running right now (the Watch eye is awake); otherwise an active Watch sleeps between intervals.
  const [watchSearching, setWatchSearching] = useState(false);
  // Something in the Database is actively happening (a product being researched, reference photos being filled in).
  const [researchActive, setResearchActive] = useState(false);
  const [photoBackfillActive, setPhotoBackfillActive] = useState(false);
  // A Facebook Watch is checked by the Facebook side regardless; an eBay Watch
  // only actually runs while "Search eBay" is on, so the two are counted
  // separately and only the runnable ones turn the Watch eye green.
  const [enabledFacebookWatchCount, setEnabledFacebookWatchCount] = useState(0);
  const [enabledEbayWatchCount, setEnabledEbayWatchCount] = useState(0);
  const [ebayEnabled, setEbayEnabled] = useState(false);
  const refreshEnabledWatchCount = useCallback(() => {
    api.listWatches().then((watches) => {
      setEnabledFacebookWatchCount(watches.filter((w) => w.enabled && w.platform === "facebook").length);
      setEnabledEbayWatchCount(watches.filter((w) => w.enabled && w.platform === "ebay").length);
    });
  }, []);

  // Fetches up to 500 listings and re-renders everything that shows them,
  // so it must not run once per event: a single eBay search or a busy
  // Facebook cycle emits dozens of engine:listing events within a second
  // (one per evaluated listing, plus a re-emit for every enrichment of the
  // same one). Push-driven refreshes are coalesced into one trailing fetch;
  // the first event in a burst starts a short timer and every event until it
  // fires rides along. User-initiated refreshes (a delete, Clear all) use
  // refreshListingsNow so the UI never feels laggy after a click.
  const listingsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshListingsNow = useCallback(() => {
    if (listingsRefreshTimer.current) {
      clearTimeout(listingsRefreshTimer.current);
      listingsRefreshTimer.current = null;
    }
    api.listListings(500, 0).then((next) => setListings((prev) => reconcileListings(prev, next)));
  }, []);
  const refreshListings = useCallback(() => {
    if (listingsRefreshTimer.current) return;
    listingsRefreshTimer.current = setTimeout(() => {
      listingsRefreshTimer.current = null;
      api.listListings(500, 0).then((next) => setListings((prev) => reconcileListings(prev, next)));
    }, 600);
  }, []);
  useEffect(
    () => () => {
      if (listingsRefreshTimer.current) clearTimeout(listingsRefreshTimer.current);
    },
    []
  );

  const goToProduct = useCallback((productId: string) => {
    setScreen("database");
    setOpenProductId(productId);
  }, []);

  const clearRequestedProduct = useCallback(() => setOpenProductId(null), []);
  const startAccount = useCallback((accountId: string) => api.startEngine(accountId), []);
  const stopAccount = useCallback((accountId: string) => api.stopEngine(accountId), []);
  const handleLoggedOut = useCallback(() => {
    setAuthenticated(false);
    setScreen("dashboard");
  }, []);

  // Per explicit instruction — trying to tab away from Config with unsaved
  // changes is denied (not just discouraged): the screen shakes and Save
  // highlights instead of actually switching. Navigating TO Config, or
  // switching while Config isn't dirty, is untouched.
  const handleSelectScreen = useCallback(
    (next: Screen) => {
      if (screen === "config" && next !== "config" && configDirty) {
        setConfigShakeSignal((n) => n + 1);
        return;
      }
      setScreen(next);
    },
    [screen, configDirty]
  );

  const goToFeed = useCallback(() => handleSelectScreen("feed"), [handleSelectScreen]);
  const goToDashboard = useCallback(() => handleSelectScreen("dashboard"), [handleSelectScreen]);
  const goToConfig = useCallback(() => handleSelectScreen("config"), [handleSelectScreen]);
  const scannerKind = useMemo(() => describeScannerState({ accounts, statusMap, notices, facebookEnabled }).kind, [accounts, statusMap, notices, facebookEnabled]);

  // A clicked desktop notification (a Watch found something) opens the screen it names.
  useEffect(() => {
    const off = api.onNavigate((target) => {
      if (target === "feed" || target === "watch" || target === "dashboard") handleSelectScreen(target);
    });
    return () => {
      off();
    };
  }, [handleSelectScreen]);

  useEffect(() => {
    // Multi-user login migration — none of this should run (or, on a
    // relaunch, re-run redundantly) until a user is actually authenticated:
    // before that, main's `config`/`store`/engines are either the inert
    // pre-login defaults or don't exist for this session yet at all (see
    // index.ts's bootstrapUserSession).
    if (!authenticated) return;
    // Per explicit instruction — applies the persisted light/dark choice
    // (see Config.tsx's Appearance section) as early as possible on
    // startup. The native window's own background (index.ts's
    // BrowserWindow backgroundColor) already matches this before the page
    // even loads, so this is just the web content catching up to it.
    api.getConfig().then((c) => {
      document.documentElement.setAttribute("data-theme", c.theme);
      applyThemeColors(c);
      applyPanelTransparency(c.panelTransparency);
      setSoundEnabled(c.soundEnabled);
      setParticlesEnabled(c.particlesEnabled);
      setAccounts(c.accounts);
      setHasSearchItems(c.searchItems.length > 0);
      setFacebookEnabled(c.facebookEnabled !== false);
      setEbayEnabled(c.ebay?.enabled ?? false);
      setWatchPaused(c.watch.globallyPaused);
    });
    api.getEngineStatusMap().then(setStatusMap);
    refreshListings();
    refreshUnseenWatchMatches();
    refreshEnabledWatchCount();

    // Log lines and status updates arrive dozens of times a second during
    // a scan, and each setState here re-renders the app root and everything
    // under it. Lines are collected and flushed as ONE update four times a
    // second; status pushes keep only the latest and apply it five times a
    // second. Nothing is lost — the log gets every line, the Live panel just
    // shows the newest state — but the UI does a fraction of the work.
    let pendingLogs: LogLine[] = [];
    let logFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushLogs = () => {
      logFlushTimer = null;
      const batch = pendingLogs;
      pendingLogs = [];
      if (batch.length) setLogs((prev) => [...prev, ...batch].slice(-MAX_LOGS));
    };
    const offLog = api.onLog((line) => {
      pendingLogs.push(line);
      if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, liveMs(250));
      // "deal" fires exactly once, right when evaluateListing first flags
      // something — unlike onListing below, which re-fires every time that
      // same record gets updated later (eBay comps, photo analysis), so
      // hooking the sound here instead of there avoids playing it 2-3
      // times for one single deal. Played immediately, not batched.
      if (line.level === "deal") playDealSound();
    });
    // Each announced listing is applied in place (see applyListingUpdates), batched so a burst
    // of announcements is a single state update. A full refetch still happens for the cases
    // the main process flags with listings:refresh (a clear, a deletion, a Watch match...).
    let pendingListings = new Map<string, ListingRecord>();
    let listingFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushListings = () => {
      listingFlushTimer = null;
      const batch = [...pendingListings.values()];
      pendingListings = new Map();
      if (batch.length) setListings((prev) => applyListingUpdates(prev, batch));
    };
    const offListingUnsub = api.onListing((record) => {
      if (!record) return;
      pendingListings.set(record.id, record);
      if (!listingFlushTimer) listingFlushTimer = setTimeout(flushListings, 300);
    });
    const offListingsRefresh = api.onListingsRefresh(refreshListings);
    let latestStatusMap: Record<string, ScrapeStatus> | null = null;
    let statusFlushTimer: ReturnType<typeof setTimeout> | null = null;
    // Only the fast-changing "what is it looking at right now" fields are throttled in the lighter modes. A change that matters at once
    // (started/stopped, logged in/out, an error, the pause between passes) is always shown within 200 ms, in every mode.
    let lastStatusSig = "";
    let statusTimerSlow = false;
    const statusSig = (map: Record<string, ScrapeStatus>) =>
      Object.entries(map)
        .map(([id, s]) => `${id}:${s.running}|${s.loggedIn}|${s.lastError ?? ""}|${s.sleepingUntil ?? ""}|${s.lastCycleFinishedAt ?? ""}`)
        .join(";");
    const offStatus = api.onStatusMap((map) => {
      latestStatusMap = map;
      const urgent = statusSig(map) !== lastStatusSig;
      if (statusFlushTimer && !(urgent && statusTimerSlow)) return;
      if (statusFlushTimer) clearTimeout(statusFlushTimer);
      statusTimerSlow = !urgent && liveMs(200) > 200;
      statusFlushTimer = setTimeout(() => {
        statusFlushTimer = null;
        if (latestStatusMap) {
          lastStatusSig = statusSig(latestStatusMap);
          setStatusMap(latestStatusMap);
        }
        latestStatusMap = null;
      }, urgent ? 200 : liveMs(200));
    });
    // Per explicit instruction — a chat-driven theme change (e.g. asking
    // the global assistant for dark mode) needs to actually repaint the
    // app immediately, the same way picking it in Config's own Appearance
    // section already does live — reported live as "asked it to switch to
    // dark mode... it couldn't do it," half of which was this listener
    // simply not existing yet (see index.ts's update_config handler, which
    // now broadcasts config:updated after any successful change).
    const offConfigUpdated = api.onConfigUpdated((next) => {
      document.documentElement.setAttribute("data-theme", next.theme);
      applyThemeColors(next);
      applyPanelTransparency(next.panelTransparency);
      setSoundEnabled(next.soundEnabled);
      setParticlesEnabled(next.particlesEnabled);
      setAccounts(next.accounts);
      setHasSearchItems(next.searchItems.length > 0);
      setFacebookEnabled(next.facebookEnabled !== false);
      setEbayEnabled(next.ebay?.enabled ?? false);
      setWatchPaused(next.watch.globallyPaused);
      // Covers both a new watch match landing AND the Watch screen itself
      // clearing matchesLastViewedAt — both travel through config:updated.
      refreshUnseenWatchMatches();
    });
    // Per explicit instruction — Config's "No particles" switch previews
    // live (see lib/particles.ts) the same way theme/colorScheme already
    // do, rather than only taking effect after Save.
    const offParticlesToggle = onParticlesToggle(setParticlesEnabled);
    // A new Watch match (Phase 2) broadcasts watches:updated — re-check the
    // pulse indicator the same way onListing already re-checks listings.
    // (A watch being added, removed, paused or resumed also broadcasts this, so
    // it keeps the Watch icon's on/off state current too.)
    void api.isWatchSearching().then(setWatchSearching);
    const offWatchSearching = api.onWatchSearching(setWatchSearching);
    void api.getResearchStatus().then((list) => setResearchActive(list.length > 0));
    const offResearch = api.onResearchStatus((list) => setResearchActive(list.length > 0));
    void api.getPhotoBackfillStatus().then((p) => setPhotoBackfillActive(p.running));
    const offBackfill = api.onPhotoBackfillProgress((p) => setPhotoBackfillActive(p.running));
    const offWatchesUpdated = api.onWatchesUpdated(() => {
      refreshUnseenWatchMatches();
      refreshEnabledWatchCount();
    });

    return () => {
      offWatchSearching();
      offResearch();
      offBackfill();
      offLog();
      offListingUnsub();
      offListingsRefresh();
      offStatus();
      offConfigUpdated();
      offWatchesUpdated();
      offParticlesToggle();
      if (logFlushTimer) clearTimeout(logFlushTimer);
      if (statusFlushTimer) clearTimeout(statusFlushTimer);
    };
  }, [authenticated, refreshListings, refreshUnseenWatchMatches]);

  useEffect(() => {
    // Per explicit instruction — "make that D pitched sound play after
    // every clickable thing is clicked": one global listener here instead
    // of wiring playClickSound into every individual onClick across the
    // whole app (previously just Database/Sidebar's own tab switches — see
    // sound.ts's playClickSound, renamed from playTabSwitchSound for this).
    // Capture phase (true), not bubble, so a component that calls
    // stopPropagation() in its own click handler still gets heard here.
    // Never fires for a genuinely disabled button/input — browsers don't
    // dispatch a click event for those at all, so no extra check is needed
    // to avoid "sounding like it worked" when it didn't.
    const CLICKABLE_SELECTOR = 'button, a, [role="button"], input[type="checkbox"], input[type="radio"], select';
    function onGlobalClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const clickable = target?.closest(CLICKABLE_SELECTOR);
      // Per explicit instruction — "for the start/stop buttons, don't play
      // the D pitch, that's what their own unique chimes are for": Dashboard's
      // Start/Stop buttons (and anything else that ever needs this) carry
      // data-no-click-sound and play their own dedicated chime directly —
      // this skips them (checked on the clickable element itself or any
      // ancestor of it) so they never double up on both sounds at once.
      if (clickable && !clickable.closest("[data-no-click-sound]")) playClickSound();
    }
    document.addEventListener("click", onGlobalClick, true);

    // Per explicit instruction — "a tiny little sound that plays when
    // hovering over something": the same set of elements the click sound
    // covers (limited to important regions, see below), but fired once per ENTRY into one (mouseover bubbles up from
    // every child, so tracking the last clickable we were over is what stops
    // moving across a button's own icon/label from re-ticking), skipping
    // disabled controls and anything tagged data-no-hover-sound, and
    // rate-limited so sweeping the cursor across a row of buttons doesn't
    // turn into a machine-gun burst.
    let lastHovered: Element | null = null;
    let lastHoverSoundAt = 0;
    function onGlobalHover(e: MouseEvent) {
      const clickable = (e.target as HTMLElement | null)?.closest(CLICKABLE_SELECTOR) ?? null;
      if (clickable === lastHovered) return;
      lastHovered = clickable;
      if (!clickable) return;
      if ((clickable as HTMLButtonElement).disabled || clickable.getAttribute("aria-disabled") === "true") return;
      // Per explicit instruction — only things that matter get the tick: the
      // left panel (tagged data-hover-sound), not every secondary/tertiary
      // button in the screens. Tag any other region or control with the
      // same attribute to opt it in.
      if (!clickable.closest("[data-hover-sound]")) return;
      if (clickable.closest("[data-no-hover-sound]")) return;
      const now = performance.now();
      if (now - lastHoverSoundAt < 70) return;
      lastHoverSoundAt = now;
      playHoverSound();
    }
    document.addEventListener("mouseover", onGlobalHover, true);

    return () => {
      document.removeEventListener("click", onGlobalClick, true);
      document.removeEventListener("mouseover", onGlobalHover, true);
    };
  }, []);

  // Multi-user login migration — nothing below (Sidebar, every screen, the
  // assistant bar) mounts until a session is confirmed authenticated.
  // particlesEnabled's default (true) already covers the login screen too,
  // so the background stays consistent whether or not anyone's logged in
  // yet.
  return (
    <div style={{ display: "flex", height: "100%", position: "relative" }}>
      <SpaceBackdrop />
      {particlesEnabled && <StarfieldBackground />}
      {!authChecked ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            position: "relative",
            zIndex: 1,
          }}
        >
          Loading...
        </div>
      ) : !authenticated ? (
        <LoginScreen defaultApiUrl={defaultApiUrl} onAuthenticated={handleAuthenticated} startupProblem={startupProblem} onRetry={handleAuthenticated} />
      ) : (
        <>
          <Sidebar
            active={screen}
            onSelect={handleSelectScreen}
            loggedIn={
              accounts.some((a) => statusMap[a.id]?.loggedIn === true)
                ? true
                : accounts.some((a) => statusMap[a.id]?.loggedIn === false)
                  ? false
                  : null
            }
            runningCount={accounts.filter((a) => statusMap[a.id]?.running).length}
            accountCount={accounts.length}
            ebaySearching={!!statusMap["ebay"]?.running && hasSearchItems}
            facebookEnabled={facebookEnabled}
            watchRunning={!watchPaused && (enabledFacebookWatchCount > 0 || (ebayEnabled && enabledEbayWatchCount > 0))}
            watchSearching={watchSearching}
            databaseBusy={researchActive || photoBackfillActive}
            hasUnseenWatchMatches={hasUnseenWatchMatches}
          />
          <div style={{ flex: 1, minWidth: 0, padding: 28, overflow: "hidden", position: "relative", zIndex: 1 }}>
            {/* Every screen stays mounted all the time now, just hidden via
                display:none when not active — per explicit instruction, switching
                tabs shouldn't wipe out whatever the user was doing on the one
                they left (a chat conversation and its unsent draft, a Feed
                search/filter, an in-progress Config edit). Conditionally
                rendering (the old `{screen === X && <X/>}` approach) unmounted
                the inactive screen entirely, throwing all of that away. A screen
                re-appearing from display:none still replays its own "enter"
                animation, since a display:none element is removed from the
                render tree entirely and gets a fresh one when it returns. */}
            <div className="enter" style={{ display: screen === "dashboard" ? "block" : "none", height: "100%" }}>
              <ScreenActive active={screen === "dashboard"}>
                <FreezeWhenHidden active={screen === "dashboard"}>
                  <DashboardMemo
                    accounts={accounts}
                    statusMap={statusMap}
                    listings={listings}
                    onStart={startAccount}
                    onStop={stopAccount}
                    onGoToFeed={goToFeed}
                    onGoToConfig={goToConfig}
                  />
                </FreezeWhenHidden>
              </ScreenActive>
            </div>
            <div className="enter" style={{ display: screen === "activity" ? "block" : "none", height: "100%" }}>
              <ScreenActive active={screen === "activity"}>
                <FreezeWhenHidden active={screen === "activity"}>
                  <ActivityMemo status={statusMap[accounts[0]?.id ?? ""] ?? EMPTY_STATUS} logs={logs} onGoToProduct={goToProduct} />
                </FreezeWhenHidden>
              </ScreenActive>
            </div>
            <div className="enter" style={{ display: screen === "feed" ? "block" : "none", height: "100%" }}>
              <ScreenActive active={screen === "feed"}>
                <FreezeWhenHidden active={screen === "feed"}>
                  <FeedMemo active={screen === "feed"} listings={listings} onRefresh={refreshListingsNow} onGoToProduct={goToProduct} scannerKind={scannerKind} hasSearchItems={hasSearchItems} onGoToDashboard={goToDashboard} />
                </FreezeWhenHidden>
              </ScreenActive>
            </div>
            <div className="enter" style={{ display: screen === "watch" ? "block" : "none", height: "100%" }}>
              <ScreenActive active={screen === "watch"}>
                <FreezeWhenHidden active={screen === "watch"}>
                  <WatchMemo active={screen === "watch"} />
                </FreezeWhenHidden>
              </ScreenActive>
            </div>
            <div className="enter" style={{ display: screen === "database" ? "block" : "none", height: "100%" }}>
              <ScreenActive active={screen === "database"}>
                <FreezeWhenHidden active={screen === "database" || openProductId !== null}>
                  <DatabaseMemo active={screen === "database" || openProductId !== null} requestedProductId={openProductId} onRequestedProductHandled={clearRequestedProduct} />
                </FreezeWhenHidden>
              </ScreenActive>
            </div>
            <div className="enter" style={{ display: screen === "config" ? "block" : "none", height: "100%" }}>
              <ScreenActive active={screen === "config"}>
                <FreezeWhenHidden active={screen === "config"}>
                  <ConfigMemo active={screen === "config"} onDirtyChange={setConfigDirty} shakeSignal={configShakeSignal} onLoggedOut={handleLoggedOut} />
                </FreezeWhenHidden>
              </ScreenActive>
            </div>
          </div>
          {/* Per explicit instruction — reachable from every screen except
              Activity, which already IS a full-page assistant (Activity moved
              out of Dashboard into its own screen — Dashboard itself now gets
              this floating bar too, so a setting can still be changed "the
              exact same way" from right there, not just from Activity's own
              embedded chat). Kept mounted (just hidden) rather than
              conditionally rendered so its own conversation and open/minimized
              state survive switching screens, same as everything else in this
              component. */}
          <div style={{ display: screen === "activity" ? "none" : "block" }}>
            <GlobalAssistantBar />
          </div>
        </>
      )}
    </div>
  );
}
