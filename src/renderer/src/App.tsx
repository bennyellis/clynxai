import React, { useCallback, useEffect, useState } from "react";
import { Sidebar, type Screen } from "./components/Sidebar.js";
import { StarfieldBackground } from "./components/StarfieldBackground.js";
import { GlobalAssistantBar } from "./components/GlobalAssistantBar.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Activity } from "./screens/Activity.js";
import { Feed } from "./screens/Feed.js";
import { WatchScreen } from "./screens/Watch.js";
import { ConfigScreen } from "./screens/Config.js";
import { Database } from "./screens/Database.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { api } from "./lib/api.js";
import type { Account, ListingRecord, LogLine, ScrapeStatus } from "./lib/api.js";
import { playDealSound, playClickSound, playHoverSound, setSoundEnabled } from "./lib/sound.js";
import { applyThemeColors } from "./lib/colorScheme.js";
import { onParticlesToggle } from "./lib/particles.js";

const MAX_LOGS = 300;

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

  const checkSession = useCallback(() => {
    api.auth.getSession().then((session) => {
      if (session.apiUrl) setDefaultApiUrl(session.apiUrl);
      setAuthenticated(session.authenticated);
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

  const refreshListings = useCallback(() => {
    api.listListings(500, 0).then(setListings);
  }, []);

  const goToProduct = useCallback((productId: string) => {
    setScreen("database");
    setOpenProductId(productId);
  }, []);

  const clearRequestedProduct = useCallback(() => setOpenProductId(null), []);

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
      setSoundEnabled(c.soundEnabled);
      setParticlesEnabled(c.particlesEnabled);
      setAccounts(c.accounts);
    });
    api.getEngineStatusMap().then(setStatusMap);
    refreshListings();
    refreshUnseenWatchMatches();

    const offLog = api.onLog((line) => {
      setLogs((prev) => [...prev.slice(-MAX_LOGS + 1), line]);
      // "deal" fires exactly once, right when evaluateListing first flags
      // something — unlike onListing below, which re-fires every time that
      // same record gets updated later (eBay comps, photo analysis), so
      // hooking the sound here instead of there avoids playing it 2-3
      // times for one single deal.
      if (line.level === "deal") playDealSound();
    });
    const offListing = () => refreshListings();
    const offListingUnsub = api.onListing(offListing);
    const offListingsRefresh = api.onListingsRefresh(refreshListings);
    const offStatus = api.onStatusMap(setStatusMap);
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
      setSoundEnabled(next.soundEnabled);
      setParticlesEnabled(next.particlesEnabled);
      setAccounts(next.accounts);
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
    const offWatchesUpdated = api.onWatchesUpdated(refreshUnseenWatchMatches);

    return () => {
      offLog();
      offListingUnsub();
      offListingsRefresh();
      offStatus();
      offConfigUpdated();
      offWatchesUpdated();
      offParticlesToggle();
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
        <LoginScreen defaultApiUrl={defaultApiUrl} onAuthenticated={handleAuthenticated} />
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
            ebaySearching={!!statusMap["ebay"]?.running}
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
              <Dashboard
                accounts={accounts}
                statusMap={statusMap}
                listings={listings}
                onStart={(accountId) => api.startEngine(accountId)}
                onStop={(accountId) => api.stopEngine(accountId)}
                onGoToFeed={() => handleSelectScreen("feed")}
              />
            </div>
            <div className="enter" style={{ display: screen === "activity" ? "block" : "none", height: "100%" }}>
              <Activity status={statusMap[accounts[0]?.id ?? ""] ?? EMPTY_STATUS} logs={logs} onGoToProduct={goToProduct} />
            </div>
            <div className="enter" style={{ display: screen === "feed" ? "block" : "none", height: "100%" }}>
              <Feed listings={listings} onRefresh={refreshListings} onGoToProduct={goToProduct} />
            </div>
            <div className="enter" style={{ display: screen === "watch" ? "block" : "none", height: "100%" }}>
              <WatchScreen active={screen === "watch"} />
            </div>
            <div className="enter" style={{ display: screen === "database" ? "block" : "none", height: "100%" }}>
              <Database requestedProductId={openProductId} onRequestedProductHandled={clearRequestedProduct} />
            </div>
            <div className="enter" style={{ display: screen === "config" ? "block" : "none", height: "100%" }}>
              <ConfigScreen
                onDirtyChange={setConfigDirty}
                shakeSignal={configShakeSignal}
                onLoggedOut={() => {
                  setAuthenticated(false);
                  setScreen("dashboard");
                }}
              />
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
