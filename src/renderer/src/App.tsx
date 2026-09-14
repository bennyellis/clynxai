import React, { useCallback, useEffect, useState } from "react";
import { Sidebar, type Screen } from "./components/Sidebar.js";
import { GeometricBackground } from "./components/GeometricBackground.js";
import { GlobalAssistantBar } from "./components/GlobalAssistantBar.js";
import { ClickParticles } from "./components/ClickParticles.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Activity } from "./screens/Activity.js";
import { Feed } from "./screens/Feed.js";
import { ConfigScreen } from "./screens/Config.js";
import { Database } from "./screens/Database.js";
import { api } from "./lib/api.js";
import type { ListingRecord, LogLine, ScrapeStatus } from "./lib/api.js";
import { playDealSound, setSoundEnabled } from "./lib/sound.js";

const MAX_LOGS = 300;

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [status, setStatus] = useState<ScrapeStatus>({
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
  });
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
    // Per explicit instruction — applies the persisted light/dark choice
    // (see Config.tsx's Appearance section) as early as possible on
    // startup. The native window's own background (index.ts's
    // BrowserWindow backgroundColor) already matches this before the page
    // even loads, so this is just the web content catching up to it.
    api.getConfig().then((c) => {
      document.documentElement.setAttribute("data-theme", c.theme);
      setSoundEnabled(c.soundEnabled);
    });
    api.getEngineStatus().then(setStatus);
    refreshListings();

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
    const offStatus = api.onStatus(setStatus);
    // Per explicit instruction — a chat-driven theme change (e.g. asking
    // the global assistant for dark mode) needs to actually repaint the
    // app immediately, the same way picking it in Config's own Appearance
    // section already does live — reported live as "asked it to switch to
    // dark mode... it couldn't do it," half of which was this listener
    // simply not existing yet (see index.ts's update_config handler, which
    // now broadcasts config:updated after any successful change).
    const offConfigUpdated = api.onConfigUpdated((next) => {
      document.documentElement.setAttribute("data-theme", next.theme);
      setSoundEnabled(next.soundEnabled);
    });

    return () => {
      offLog();
      offListingUnsub();
      offListingsRefresh();
      offStatus();
      offConfigUpdated();
    };
  }, [refreshListings]);

  return (
    <div style={{ display: "flex", height: "100%", position: "relative" }}>
      <GeometricBackground />
      <Sidebar active={screen} onSelect={handleSelectScreen} loggedIn={status.loggedIn} running={status.running} />
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
            status={status}
            listings={listings}
            onStart={() => api.startEngine()}
            onStop={() => api.stopEngine()}
            onGoToFeed={() => handleSelectScreen("feed")}
          />
        </div>
        <div className="enter" style={{ display: screen === "activity" ? "block" : "none", height: "100%" }}>
          <Activity status={status} logs={logs} onGoToProduct={goToProduct} />
        </div>
        <div className="enter" style={{ display: screen === "feed" ? "block" : "none", height: "100%" }}>
          <Feed listings={listings} onRefresh={refreshListings} onGoToProduct={goToProduct} />
        </div>
        <div className="enter" style={{ display: screen === "database" ? "block" : "none", height: "100%" }}>
          <Database requestedProductId={openProductId} onRequestedProductHandled={clearRequestedProduct} />
        </div>
        <div className="enter" style={{ display: screen === "config" ? "block" : "none", height: "100%" }}>
          <ConfigScreen onDirtyChange={setConfigDirty} shakeSignal={configShakeSignal} />
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
      <ClickParticles />
    </div>
  );
}
