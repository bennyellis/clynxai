import React, { useEffect, useRef, useState } from "react";
import type { Account, CloudStatus, Config as ConfigType } from "../lib/api.js";
import { api } from "../lib/api.js";
import { Modal } from "../components/Modal.js";
import { setSoundEnabled } from "../lib/sound.js";
import { notifyParticlesToggle } from "../lib/particles.js";
import { getGpuLabel, getPreference, getTier, setPreference, type PerfPreference } from "../lib/performance.js";
import { applyPanelTransparency, applyThemeColors } from "../lib/colorScheme.js";

// Per explicit instruction — the "State" location mode's own picker.
// Alaska and Hawaii deliberately excluded — per explicit instruction,
// ineligible (this app's whole model is nationwide mail-order resale, and
// neither is practical to ship from/to the same way the contiguous states
// are).
export const US_STATES = [
  "Alabama", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida",
  "Georgia", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska",
  "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
  "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

export function ConfigScreen({
  active = true,
  onDirtyChange,
  shakeSignal,
  onLoggedOut,
}: {
  // Whether Config is the screen being shown (every screen stays mounted, just hidden). Account cards use it to drop
  // their "Saved ..." notes once the user has left.
  active?: boolean;
  // Per explicit instruction — App.tsx needs to know whether it's safe to
  // switch away from this screen (see the Sidebar's onSelect wrapper),
  // which means Config has to report its own dirty state upward instead
  // of App.tsx trying to duplicate the JSON-diff logic that already lives
  // here.
  onDirtyChange?: (dirty: boolean) => void;
  // Incrementing counter (not a boolean) — App.tsx bumps this every time
  // it BLOCKS a tab switch, so the same "denied again" signal still
  // triggers a fresh shake/highlight even if the previous one hasn't
  // finished animating out yet (a plain boolean flipping true→true on a
  // second denied attempt wouldn't re-fire the effect below at all).
  shakeSignal?: number;
  // Multi-user login migration — Config can't flip App.tsx's own
  // authenticated state directly, so it reports a successful log-out
  // upward instead (see the Cloud Sync section's own "Log out" button) —
  // App.tsx is what actually decides to unmount everything and go back to
  // LoginScreen.
  onLoggedOut?: () => void;
} = {}) {
  const [config, setConfig] = useState<ConfigType | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  // Per explicit instruction — shaking the screen (a fast, small shake,
  // 0.5s) and highlighting Save when a tab switch gets denied for having
  // unsaved changes. Both reset themselves via setTimeout rather than
  // waiting on the CSS animation's own "end" event, which is simpler and
  // doesn't need an animationend listener wired up just to clear a class.
  const [shaking, setShaking] = useState(false);
  const [highlightSave, setHighlightSave] = useState(false);
  // Per explicit instruction — you have to actually deal with unsaved
  // Config changes before the app closes, not lose them silently. Compared
  // as JSON against whatever was last successfully loaded/saved, rather
  // than a plain boolean flipped on every field's onChange — that would
  // also need its own careful resetting after every save/load, where this
  // is self-correcting: once `config` matches `savedSnapshot` again
  // (because a save just wrote it, or a fresh load just set both), dirty
  // naturally goes back to false on its own.
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  // Refs, not just closing over `config`/`savedSnapshot` — the
  // app:closeRequested listener below subscribes ONCE (empty deps, so it
  // isn't torn down and rebuilt on every keystroke) but still needs to see
  // whatever the LATEST values actually are whenever a close is attempted.
  const configRef = useRef(config);
  const savedSnapshotRef = useRef(savedSnapshot);
  configRef.current = config;
  savedSnapshotRef.current = savedSnapshot;

  // Per explicit instruction — multiple Facebook accounts: adding one is
  // its own quick round trip (labeled, then immediately editable — see
  // AccountCard for the location picker/login/remove UI each one gets).
  const [addingAccount, setAddingAccount] = useState(false);
  // Per explicit instruction — watchcount.com's anonymous usage cap
  // (20 lookups/day) is well below a logged-in account's (200/day), and
  // Google/Facebook sign-in specifically fails inside this app's
  // automated browser (a restriction those providers apply to any
  // automation-flagged browser, unrelated to watchcount) — but its plain
  // email + password login isn't affected by that. Just opens the window;
  // there's no reliable "logged in now" signal to poll for the way
  // Facebook's isLoggedIn check has, so this can't show more than "opened."
  const [watchCountOpening, setWatchCountOpening] = useState(false);
  const [tab, setTab] = useState<ConfigTab>("sources");
  // Visual-effects quality (lib/performance.ts) — per machine, so it lives in
  // localStorage rather than the synced config, and applies instantly.
  const [effects, setEffects] = useState<PerfPreference>(getPreference());
  function changeEffects(next: PerfPreference) {
    setPreference(next);
    setEffects(next);
  }
  // eBay Browse API credentials live in .env, not Config — this is just a
  // one-time read so the toggle below can tell the user whether flipping it
  // on will actually do anything yet. No live polling (same posture as
  // watchCountOpening above): adding/changing .env needs an app restart to
  // take effect anyway (dotenv loads once at startup), so a fresher check
  // here wouldn't reflect reality any better.
  const [hasEbayCredentials, setHasEbayCredentials] = useState(true);

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c);
      setSavedSnapshot(JSON.stringify(c));
    });
    api.hasEbayCredentials().then(setHasEbayCredentials);
  }, []);

  useEffect(() => {
    const off = api.onCloseRequested(() => {
      const dirty = !!configRef.current && JSON.stringify(configRef.current) !== savedSnapshotRef.current;
      if (dirty) setShowCloseDialog(true);
      else api.confirmClose();
    });
    return () => {
      off();
    };
  }, []);

  // Per explicit instruction — a chat-driven config change (see index.ts's
  // update_config handler broadcasting config:updated) should show up here
  // live too, not just take effect silently until this screen happens to
  // reload. Skipped while there are unsaved local edits (dirty) so an
  // in-progress change on THIS screen never gets silently overwritten by
  // something changed elsewhere — the fresh value is still just a reload
  // away once the user's own edit is dealt with.
  useEffect(() => {
    const off = api.onConfigUpdated((next) => {
      const isDirty = !!configRef.current && JSON.stringify(configRef.current) !== savedSnapshotRef.current;
      if (isDirty) return;
      setConfig(next);
      setSavedSnapshot(JSON.stringify(next));
    });
    return () => {
      off();
    };
  }, []);

  const dirty = !!config && JSON.stringify(config) !== savedSnapshot;

  // Per explicit instruction — reports dirty state up to App.tsx, which is
  // what actually decides whether a Sidebar tab switch is allowed to
  // proceed or gets denied (shaken) instead. Only fires on an actual
  // true/false transition thanks to the dependency array, not every
  // keystroke.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Per explicit instruction — App.tsx bumps shakeSignal every time it
  // denies a tab switch; this reacts by shaking the screen (0.5s) and
  // pulsing the Save button, both self-clearing via timers.
  useEffect(() => {
    if (!shakeSignal) return;
    setShaking(true);
    setHighlightSave(true);
    const shakeTimer = setTimeout(() => setShaking(false), 500);
    const highlightTimer = setTimeout(() => setHighlightSave(false), 1300);
    return () => {
      clearTimeout(shakeTimer);
      clearTimeout(highlightTimer);
    };
  }, [shakeSignal]);

  if (!config) return <div style={{ color: "var(--text-muted)" }}>Loading...</div>;
  const cfg = config;

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      await api.saveConfig(config);
      setSavedSnapshot(JSON.stringify(config));
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  async function resetConfig() {
    setShowResetDialog(false);
    setResetting(true);
    try {
      const fresh = await api.resetConfig();
      setConfig(fresh);
      applyPanelTransparency(fresh.panelTransparency);
      setSavedSnapshot(JSON.stringify(fresh));
      setSavedAt(Date.now());
    } finally {
      setResetting(false);
    }
  }

  function update<K extends keyof ConfigType>(key: K, value: ConfigType[K]) {
    setConfig((c) => (c ? { ...c, [key]: value } : c));
  }

  // Applied immediately (not just staged like every other field here) so
  // picking a theme previews live instead of only taking effect after
  // Save — matches App.tsx's own startup read of config.theme onto the
  // same attribute. Also reruns applyColorScheme with the NEW theme: the
  // background tint it computes is theme-aware (a dark vs. a near-white
  // base), and that inline style value doesn't update on its own just
  // because data-theme changed — see colorScheme.ts's own comment on why
  // this has to be inline rather than a [data-theme] CSS override.
  function setTheme(theme: ConfigType["theme"]) {
    update("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
    applyThemeColors({ ...cfg, theme });
  }

  // Same "applies immediately, not just staged" posture as setTheme above —
  // per explicit instruction ("instead of choosing colors, allow the user
  // to use a color wheel to pick a primary and accent color"). See
  // lib/colorScheme.ts for what actually gets derived from these two hex
  // values (every accent-driven CSS custom property, plus the background
  // tint).
  function setPrimaryColor(hex: string) {
    update("primaryColor", hex);
    applyThemeColors({ ...cfg, primaryColor: hex });
  }
  function setAccentColor(hex: string) {
    update("accentColor", hex);
    applyThemeColors({ ...cfg, accentColor: hex });
  }
  // Same "applies immediately" posture — see how much of the animated background
  // shows through the panels while dragging, not after Save.
  function setPanelTransparency(percent: number) {
    update("panelTransparency", percent);
    applyPanelTransparency(percent);
  }
  // Same "applies immediately" posture — the rainbow starts fading the
  // moment it's switched on, and switching it off snaps straight back to
  // whatever two colors are picked underneath.
  function setRainbow(enabled: boolean) {
    update("rainbowEnabled", enabled);
    applyThemeColors({ ...cfg, rainbowEnabled: enabled });
  }

  // Same "applies immediately, not just staged" posture as setTheme above —
  // per explicit instruction, a Sound on/off switch.
  function toggleSound(enabled: boolean) {
    update("soundEnabled", enabled);
    setSoundEnabled(enabled);
  }

  // Same "applies immediately, not just staged" posture as setTheme above —
  // per explicit instruction, a "No particles" switch that turns off both
  // the starfield background and the click-particle bursts in one toggle.
  function toggleParticles(enabled: boolean) {
    update("particlesEnabled", enabled);
    notifyParticlesToggle(enabled);
  }

  async function openWatchCountLogin() {
    setWatchCountOpening(true);
    try {
      await api.openWatchCountLogin();
    } finally {
      setWatchCountOpening(false);
    }
  }

  // Per explicit instruction — "State" and "City/ZIP" both drive a real
  // browser lookup on Facebook (see index.ts's location:setMode / the
  // "Change location" dialog automation in scraper.ts/locationDiscovery.ts)
  // before anything actually changes — one single resolved location either
  // way now (State mode used to resolve up to 10 separate cities, which was
  // genuinely slow for little benefit) — busy state stays up the whole
  // time, and the result (success or a specific failure reason) replaces
  // it once the round trip resolves. onConfigUpdated
  // (already wired above) picks up the new browseUrls/searchRadiusMiles
  // once it succeeds, same as any other chat/IPC-driven config change.
  async function addAccount() {
    setAddingAccount(true);
    try {
      await api.addAccount(`Account ${cfg.accounts.length + 1}`);
    } finally {
      setAddingAccount(false);
    }
  }

  return (
    <div
      className={shaking ? "shake-deny" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Config</h1>
          <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>Everything the scout needs to run, in one place.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {dirty ? (
            <span className="pill" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
              unsaved changes
            </span>
          ) : (
            savedAt && <span className="pill">saved {new Date(savedAt).toLocaleTimeString()}</span>
          )}
          <button className="danger" disabled={resetting} onClick={() => setShowResetDialog(true)}>
            {resetting ? "Resetting..." : "Reset to defaults"}
          </button>
          <button
            className={`primary${highlightSave ? " save-highlight" : ""}`}
            disabled={saving || !dirty}
            onClick={save}
          >
            {saving ? "Saving..." : "Save config"}
          </button>
        </div>
      </div>

      {showResetDialog && (
        <Modal title="Reset all Config to defaults?" onClose={() => setShowResetDialog(false)}>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            This clears your Search For list and custom instructions, resets browse locations back to the nationwide
            default list, and resets every other setting on this screen. Your OpenAI key and Feed history are not
            affected.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setShowResetDialog(false)}>
              Cancel
            </button>
            <button className="danger-solid" style={{ flex: 1 }} onClick={resetConfig}>
              Reset
            </button>
          </div>
        </Modal>
      )}

      {showCloseDialog && (
        <Modal title="Unsaved Config changes" onClose={() => setShowCloseDialog(false)}>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            You have unsaved changes on this screen. Save them before closing, or discard them?
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setShowCloseDialog(false)}>
              Cancel
            </button>
            <button
              className="danger-solid"
              style={{ flex: 1 }}
              onClick={() => {
                setShowCloseDialog(false);
                api.confirmClose();
              }}
            >
              Discard & close
            </button>
            <button
              className="primary"
              style={{ flex: 1 }}
              onClick={async () => {
                await save();
                setShowCloseDialog(false);
                api.confirmClose();
              }}
            >
              Save & close
            </button>
          </div>
        </Modal>
      )}

      <TabBar active={tab} onChange={setTab} />

      {/* Like Feed: the title row and the tabs stay put, and only the settings below them scroll. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 20, paddingRight: 4, paddingBottom: 64 }}>

      {tab === "sources" && (
        <>
          <Section title="Facebook accounts" subtitle="Each account is its own Facebook login and browser, scanning its own location.">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {cfg.accounts.map((account) => (
                <AccountCard key={account.id} account={account} active={active} />
              ))}
            </div>
            <button type="button" className="primary" style={{ marginTop: 14, alignSelf: "flex-start" }} disabled={addingAccount} onClick={addAccount}>
              {addingAccount ? "Adding..." : "+ Add account"}
            </button>
          </Section>

          <Section title="Facebook Marketplace">
            <CheckRow
              title="Search Facebook Marketplace"
              description={'Turn off and "Start Scanner" won\'t start any account.'}
              checked={cfg.facebookEnabled !== false}
              onChange={(v) => update("facebookEnabled", v)}
            />
            <SettingRow title="Listings per location" description="How many to scan before moving to the next place.">
              <input
                type="number"
                min={1}
                style={{ width: 90 }}
                value={cfg.listingsPerLocation}
                onChange={(e) => update("listingsPerLocation", Math.max(1, Number(e.target.value)))}
              />
            </SettingRow>
            <SettingRow
              title="Wait between passes (minutes)"
              description="How long the scanner sleeps after finishing a pass, picked at random between these two. Set both to 0 for no wait (that reloads Facebook constantly, so a little wait is kinder to your account). The Dashboard's Live panel counts the wait down and has a Skip wait button."
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  style={{ width: 80 }}
                  value={cfg.pollIntervalMinutesMin}
                  onChange={(e) => {
                    const v = Math.max(0, Number(e.target.value) || 0);
                    update("pollIntervalMinutesMin", v);
                    if (v > cfg.pollIntervalMinutesMax) update("pollIntervalMinutesMax", v);
                  }}
                />
                <span style={{ color: "var(--text-dim)" }}>to</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  style={{ width: 80 }}
                  value={cfg.pollIntervalMinutesMax}
                  onChange={(e) => {
                    const v = Math.max(0, Number(e.target.value) || 0);
                    update("pollIntervalMinutesMax", v);
                    if (v < cfg.pollIntervalMinutesMin) update("pollIntervalMinutesMin", v);
                  }}
                />
              </div>
            </SettingRow>
            <SettingRow title="Listing age limit" description="Skip listings older than this.">
              <select
                value={cfg.maxListingAgeHours === null ? "any" : String(cfg.maxListingAgeHours)}
                onChange={(e) => update("maxListingAgeHours", e.target.value === "any" ? null : Number(e.target.value))}
              >
                <option value="24">Last 24 hours</option>
                <option value="168">Last 7 days</option>
                <option value="720">Last 30 days</option>
                <option value="any">Any time</option>
              </select>
            </SettingRow>
            <CheckRow
              title="Analyze photos"
              description="Verifies deals, spots ineligible items and matches the Database."
              checked={cfg.photoAnalysis.enabled}
              onChange={(v) => update("photoAnalysis", { enabled: v })}
            />
            <CheckRow
              title="Auto-research new items"
              description="Adds products it doesn't know yet to the Database."
              checked={cfg.autoResearchListings}
              onChange={(v) => update("autoResearchListings", v)}
            />
            <CheckRow
              title="Research condition"
              description={'Flags possible damage in photos with a yellow "?". Needs photo analysis on.'}
              checked={cfg.researchCondition}
              onChange={(v) => update("researchCondition", v)}
            />
            <CheckRow
              title="Ignore Blacklist"
              description="Temporarily stop skipping blacklisted listings, without clearing the list."
              checked={cfg.ignoreBlacklist}
              onChange={(v) => update("ignoreBlacklist", v)}
            />
          </Section>

          <Section title="eBay Marketplace">
            <CheckRow
              title="Search eBay"
              description="Searches every Search For item and Watch by keyword. No login needed."
              checked={cfg.ebay?.enabled ?? false}
              onChange={(v) => update("ebay", { enabled: v })}
            />
            {!hasEbayCredentials && (
              <p style={{ fontSize: 13.5, color: "var(--warn)", margin: "4px 0 0" }}>
                No eBay API credentials found. Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to .env (see .env.example) and
                restart Clynx.
              </p>
            )}
          </Section>
        </>
      )}

      {tab === "deals" && (
        <>
          <Section title="Seller risk">
            <CheckRow
              title="Screen sellers before opening a listing"
              description="Skips sellers that fail the checks below."
              checked={cfg.sellerRisk.enabled}
              onChange={(v) => update("sellerRisk", { ...cfg.sellerRisk, enabled: v })}
            />
            <SettingRow title="Minimum seller rating" description={'Half stars allowed. "Any rating" skips this check, and sellers with no rating always pass.'}>
              <StarRatingPicker
                value={cfg.sellerRisk.minRating}
                disabled={!cfg.sellerRisk.enabled}
                onChange={(minRating) => update("sellerRisk", { ...cfg.sellerRisk, minRating })}
              />
            </SettingRow>
          </Section>

          <Section title="OpenAI usage" subtitle="Clynx only spends OpenAI credits on its core jobs.">
            <CheckRow
              title="Save OpenAI credits"
              description="Clynx only spends OpenAI credits on the essentials (the assistant, product research, Watch checks, deal-spotting on listings that match no tracked product, comparing a listing to your Database). Everything else runs without it: photos and logos come from eBay and Wikipedia, comps are filtered by plain text checks, listings whose title names a Database product are priced with plain math, and the extra photo-screening and auto-created variants are off. Turn this off for the fuller, costlier behavior."
              checked={cfg.lowAiMode}
              onChange={(v) => update("lowAiMode", v)}
            />
          </Section>

          <Section title="Your eBay store" subtitle="Link the eBay account you sell from, so Clynx also knows what YOU list things for.">
            <EbayStoreLink linked={cfg.ebayStoreUsername ?? ""} onLinked={(name) => update("ebayStoreUsername", name)} />
          </Section>

          <Section title="Resale profit" subtitle="How Clynx decides whether a listing is a good deal: what you'd keep selling it on eBay, minus what it costs.">
            <SettingRow title="You keep (of the sold price)" description="eBay takes about 13.75%, so 84% is a safe estimate. Shipping doesn't matter: it's a share of the total the buyer paid.">
              <input
                type="number"
                min={60}
                max={95}
                style={{ width: 90 }}
                value={cfg.ebayNetPercent}
                onChange={(e) => update("ebayNetPercent", Math.min(95, Math.max(60, Number(e.target.value) || 84)))}
              />
            </SettingRow>
            <SettingRow title="Minimum profit margin (%)" description="A listing is a deal when buying it leaves at least this much of what you'd keep as profit.">
              <input
                type="number"
                min={0}
                max={90}
                style={{ width: 90 }}
                value={cfg.minProfitMarginPercent}
                onChange={(e) => update("minProfitMarginPercent", Math.min(90, Math.max(0, Number(e.target.value) || 0)))}
              />
            </SettingRow>
            <SettingRow
              title="Skip deals that need more than ___% off"
              description="If getting that minimum margin would mean haggling the seller down by more than this share of their asking price, Clynx skips the listing (no alert). Lower is stricter: 0 means only listings that are already a good deal at the asking price."
            >
              <input
                type="number"
                min={0}
                max={60}
                style={{ width: 90 }}
                value={cfg.maxNegotiationPercent ?? 15}
                onChange={(e) => update("maxNegotiationPercent", Math.min(60, Math.max(0, Number(e.target.value) || 0)))}
              />
            </SettingRow>
          </Section>

          <Section title="eBay sold comps (WatchCount.com)" subtitle="Real sold prices and time-to-sell for every researched product.">
            <CheckRow
              title="Look up sold comps"
              description="Free: 20 lookups/day anonymous, 200/day with a WatchCount account."
              checked={cfg.watchCountEnabled}
              onChange={(v) => update("watchCountEnabled", v)}
            />
            <CheckRow
              title="Only once per product per scan"
              description="Don't re-spend a lookup on the same product in the same scan."
              checked={cfg.watchCountOncePerScan}
              disabled={!cfg.watchCountEnabled}
              onChange={(v) => update("watchCountOncePerScan", v)}
            />
            <SettingRow title="WatchCount login" description="Use email + password. Google and Facebook sign-in don't work in this window.">
              <button type="button" className="primary" disabled={watchCountOpening} onClick={openWatchCountLogin}>
                {watchCountOpening ? "Opening..." : "Log in"}
              </button>
            </SettingRow>
          </Section>
        </>
      )}

      {tab === "appearance" && (
        <Section title="Appearance">
          <SettingRow title="Theme">
            <div style={{ display: "flex", gap: 8 }}>
              <button className={cfg.theme === "dark" ? "seg on" : "seg"} type="button" onClick={() => setTheme("dark")}>
                🌙 Dark
              </button>
              <button className={cfg.theme === "light" ? "seg on" : "seg"} type="button" onClick={() => setTheme("light")}>
                ☀️ Light
              </button>
            </div>
          </SettingRow>
          <SettingRow title="Colors" description="Rainbow slowly fades the whole app through every color.">
            <div style={{ display: "flex", gap: 8 }}>
              <button className={!cfg.rainbowEnabled ? "seg on" : "seg"} type="button" onClick={() => setRainbow(false)}>
                🎨 Custom
              </button>
              <button className={cfg.rainbowEnabled ? "seg on" : "seg"} type="button" onClick={() => setRainbow(true)}>
                🌈 Rainbow
              </button>
            </div>
          </SettingRow>
          {!cfg.rainbowEnabled && (
            <>
              <SettingRow title="Primary color">
                <ColorPick value={cfg.primaryColor} onChange={setPrimaryColor} title="Pick the app's primary accent" />
              </SettingRow>
              <SettingRow title="Accent color">
                <ColorPick value={cfg.accentColor} onChange={setAccentColor} title="Pick the app's secondary accent" />
              </SettingRow>
            </>
          )}
          <SettingRow
            title="Panel transparency"
            description="How much of the animated background shows through the panels. 0% is solid; higher lets more of the sky through."
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range"
                min={0}
                max={90}
                step={5}
                value={cfg.panelTransparency ?? 20}
                onChange={(e) => setPanelTransparency(Number(e.target.value))}
                title="Panel transparency"
                style={{ width: 150 }}
              />
              <span style={{ minWidth: 38, textAlign: "right", fontSize: 13.5, color: "var(--text-muted)" }}>{cfg.panelTransparency ?? 20}%</span>
            </div>
          </SettingRow>
          <SettingRow
            title="Effects quality"
            description={
              effects === "auto"
                ? `Auto picks for your graphics (${getGpuLabel()}) and lowers itself if your computer struggles — currently ${getTier() === "high" ? "full" : getTier() === "balanced" ? "balanced" : "low power"}.`
                : "Lower settings thin out the stars and switch off ambient animations — smoother on older computers."
            }
          >
            <select value={effects} onChange={(e) => changeEffects(e.target.value as PerfPreference)}>
              <option value="auto">Auto (recommended)</option>
              <option value="high">Full</option>
              <option value="balanced">Balanced</option>
              <option value="lite">Low power</option>
            </select>
          </SettingRow>
          <CheckRow title="Sound" description="Start/stop chimes, tab ticks and the deal alert." checked={cfg.soundEnabled} onChange={toggleSound} />
          <CheckRow title="Animated background" description="Cursor-reactive stars, the orbiting satellite, meteors and click bursts. Off = a still backdrop." checked={cfg.particlesEnabled} onChange={toggleParticles} />
        </Section>
      )}

      {tab === "notifications" && (
        <Section title="Desktop notifications" subtitle="A Windows notification when a Watch finds something. Clicking it opens Feed.">
          <CheckRow title="Watch finds" description="Pop up a notification for each listing a Watch reports." checked={cfg.desktopNotifications !== false} onChange={(v) => update("desktopNotifications", v)} />
        </Section>
      )}

      {tab === "notifications" && (
        <Section title="Push notifications (ntfy)" subtitle="Install the ntfy app and subscribe to your topic to get alerts on your phone.">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <Field label="Server">
              <input value={cfg.ntfy.server} onChange={(e) => update("ntfy", { ...cfg.ntfy, server: e.target.value })} />
            </Field>
            <Field label="Topic (private, hard to guess)">
              <input value={cfg.ntfy.topic} onChange={(e) => update("ntfy", { ...cfg.ntfy, topic: e.target.value })} />
            </Field>
          </div>
        </Section>
      )}

      {tab === "account" && <CloudSyncSection onLoggedOut={onLoggedOut} />}
      </div>
    </div>
  );
}

// First UI change in the whole cloud migration — everything before this was
// backend-only (see cloudClient.ts/watchSync.ts/feedbackSync.ts/
// productSync.ts/listingIngestSync.ts), so the only way to tell cloud sync
// was actually working was reading terminal logs or querying Postgres
// directly. Started as a purely read-only status readout (poll main on an
// interval, same pattern as Activity.tsx's own MetricsPanel) — the multi-
// user login migration adds the one actual control it needed: logging out.
// Cloud sync itself is no longer something to turn on/off from here at all
// (see index.ts's bootstrapUserSession) — being logged in now IS what turns
// it on, unconditionally, for whichever user is currently signed in.
function CloudSyncSection({ onLoggedOut }: { onLoggedOut?: () => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  async function logOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api.auth.logout();
      onLoggedOut?.();
    } finally {
      setLoggingOut(false);
    }
  }

  // Mirrors Activity.tsx's MetricsPanel poll-on-an-interval pattern exactly
  // (immediate poll on mount, then setInterval, cleaned up on unmount) — the
  // established "renderer polls main for live status" approach in this app,
  // not a new one. A slower interval than MetricsPanel's 2s is enough here:
  // the underlying data only changes on a heartbeat (60s) or sync tick
  // (60-120s depending on the service), not per-listing.
  useEffect(() => {
    let cancelled = false;
    function poll() {
      api.cloud.getStatus().then((s) => {
        if (!cancelled) setStatus(s);
      });
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <Section title="Cloud Sync">
      <p style={{ fontSize: 13.5, color: "var(--text-dim)", margin: "0 0 12px" }}>
        Watches, feedback, Database products and scanned listings sync to your Clynx account while you're logged in.
      </p>
      {!status ? (
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>Loading...</p>
      ) : !status.enabled ? (
        <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>Cloud sync isn't active for this session yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <CloudStatusRow
              label="Authentication"
              ok={status.authenticated}
              detail={status.authenticated ? "Authenticated" : "Not authenticated"}
            />
            <CloudStatusRow
              label="Heartbeat"
              ok={!!status.heartbeat.lastAt && !status.heartbeat.lastError}
              detail={
                status.heartbeat.lastAt
                  ? `Last sent ${timeAgo(status.heartbeat.lastAt)}${status.heartbeat.lastError ? ` — ${status.heartbeat.lastError}` : ""}`
                  : status.heartbeat.lastError ?? "Never sent yet"
              }
            />
          </div>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-dim)", margin: "0 0 6px" }}>Background sync</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SyncStatusRow label="Watches" status={status.sync.watches} />
              <SyncStatusRow label="Feed feedback" status={status.sync.feedback} />
              <SyncStatusRow label="Database products" status={status.sync.products} />
              <SyncStatusRow label="Listing ingestion" status={status.sync.listings} />
            </div>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: 0 }}>
            Device ID: {status.deviceId ?? "not registered yet"} · {status.apiUrl ?? "no API URL configured"}
          </p>
        </div>
      )}
      <button
        type="button"
        className="danger"
        disabled={loggingOut}
        onClick={logOut}
        style={{ alignSelf: "flex-start", marginTop: 14 }}
      >
        {loggingOut ? "Logging out..." : "Log out"}
      </button>
    </Section>
  );
}

// A single-line status row with a colored dot — same `.dot` classes
// Activity.tsx's own "narrating" pill and Sidebar's connection indicators
// already use for on/off/error states, so this reads as a native part of
// the app rather than a bolted-on widget.
function CloudStatusRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
      <span className={`dot ${ok ? "on" : "off"}`} style={{ width: 7, height: 7, flexShrink: 0 }} />
      <span style={{ color: "var(--text-muted)", minWidth: 110 }}>{label}</span>
      <span style={{ color: ok ? "var(--text)" : "var(--text-dim)" }}>{detail}</span>
    </div>
  );
}

// One row per background sync service — a compact list, same shape as the
// Accounts section's own per-account cards or Activity.tsx's per-account
// discovery rate list: a label on the left, the live value on the right.
// No lastAt at all yet (service enabled but its first tick, 15s after
// startup, hasn't landed) reads as "off" rather than "error" — there's
// nothing wrong yet, just nothing to report.
function SyncStatusRow({ label, status }: { label: string; status: { lastAt: number | null; lastError: string | null } }) {
  const state: "on" | "off" | "err" = status.lastError ? "err" : status.lastAt ? "on" : "off";
  const detail = status.lastAt
    ? `Last synced ${timeAgo(status.lastAt)}${status.lastError ? ` — ${status.lastError}` : ""}`
    : status.lastError ?? "Not synced yet";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
      <span className={`dot ${state}`} style={{ width: 7, height: 7, flexShrink: 0 }} />
      <span style={{ color: "var(--text-muted)", minWidth: 130 }}>{label}</span>
      <span style={{ color: state === "err" ? "var(--danger)" : "var(--text)" }}>{detail}</span>
    </div>
  );
}

// Same minute-granularity relative-time helper as ListingCard.tsx's own
// timeAgo (heartbeats/sync ticks here run 60-120s apart, so that precision
// fits — unlike Watch.tsx's own timeAgoShort, built for a "last checked 42
// sec ago" display that updates every few seconds). Kept as its own local
// copy rather than importing ListingCard's, matching this codebase's
// existing convention of a small private helper per file that needs one
// (see ListingCard.tsx and Watch.tsx, neither of which exports theirs).
function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type ConfigTab = "sources" | "deals" | "appearance" | "notifications" | "account";

const CONFIG_TABS: Array<{ id: ConfigTab; label: string }> = [
  { id: "sources", label: "Sources" },
  { id: "deals", label: "Deals" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "account", label: "Account" },
];

// Config used to be one very long page of stacked cards. Tabs keep each
// group of related settings on its own short screen; everything still reads
// and writes the same single config object, so switching tabs never loses
// an unsaved edit.
function TabBar({ active, onChange }: { active: ConfigTab; onChange: (tab: ConfigTab) => void }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
      }}
    >
      {CONFIG_TABS.map((t) => (
        <button key={t.id} type="button" className={active === t.id ? "seg on" : "seg"} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Links the user's own eBay seller account: Clynx then shows what their store lists each product for, as a price reference
// separate from the market numbers (WatchCount's sold prices and everyone's asking prices).
function EbayStoreLink({ linked, onLinked }: { linked: string; onLinked: (name: string) => void }) {
  const [text, setText] = useState(linked);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => setText(linked), [linked]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  async function submit(value: string) {
    setBusy(true);
    try {
      const result = await api.linkEbayStore(value);
      if (!result.ok) {
        setNote({ text: result.error ?? "Couldn't link that store.", ok: false });
        return;
      }
      onLinked(result.username);
      setText(result.username);
      setNote({
        text: result.username
          ? `Linked ${result.username}. Clynx is checking your listings against every product in the Database now; your prices show up on each product page.`
          : "Unlinked your eBay store.",
        ok: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingRow
      title={linked ? `Linked: ${linked}` : "eBay username"}
      description="Your eBay username (the name on ebay.com/usr/yourname, or paste that link). Clynx reads your public listings only. It never signs in or changes anything on your account."
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          style={{ width: 220 }}
          placeholder="your_ebay_username"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() && text.trim() !== linked) void submit(text);
          }}
        />
        <button className="icon" disabled={busy || !text.trim() || text.trim() === linked} onClick={() => void submit(text)}>
          {busy ? "Linking…" : linked ? "Change" : "Link store"}
        </button>
        {linked && (
          <button className="icon" disabled={busy} onClick={() => void submit("")}>
            Unlink
          </button>
        )}
      </div>
      {note && <div style={{ fontSize: 12.5, marginTop: 8, color: note.ok ? "var(--success)" : "var(--danger, #e5484d)" }}>{note.text}</div>}
    </SettingRow>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 13.5, color: "var(--text-dim)", marginTop: 3 }}>{subtitle}</div>}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>{children}</div>
    </div>
  );
}

// One setting per row: name + a single short line of explanation on the
// left, the control on the right, a hairline divider between rows.
function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        padding: "12px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14.5, color: "var(--text)" }}>{title}</div>
        {description && <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2, lineHeight: 1.4 }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function CheckRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow title={title} description={description}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, cursor: disabled ? "default" : "pointer" }}
      />
    </SettingRow>
  );
}

function ColorPick({ value, onChange, title }: { value: string; onChange: (hex: string) => void; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 13.5, color: "var(--text-dim)" }}>{value}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 46, height: 36, padding: 2, cursor: "pointer" }}
        title={title}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label>{label}</label>
      {children}
    </div>
  );
}

// Per explicit instruction — multiple Facebook accounts, each scanning its
// own location concurrently. One of these per configured account, each
// managing its OWN location-picker draft state independently (mirrors
// exactly what the single-account version of this screen used to do with
// its own locationDraftMode/stateDraft/cityDraft/etc. — just one
// independent copy per account now instead of one shared copy). Mutations
// (label/enabled/location) all go through their own IPC round trip and
// broadcast config:updated, which the parent ConfigScreen already listens
// for (see its onConfigUpdated effect) — no separate refresh plumbing
// needed here, this component just re-renders with fresh props once that
// lands.
function AccountCard({ account, active }: { account: Account; active: boolean }) {
  const [labelDraft, setLabelDraft] = useState(account.label);
  const [locationDraftMode, setLocationDraftMode] = useState<Account["locationMode"]>(account.locationMode);
  const [stateDraft, setStateDraft] = useState(account.selectedState ?? "");
  const [cityDraft, setCityDraft] = useState(account.selectedCityOrZip ?? "");
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationResult, setLocationResult] = useState<string | null>(null);
  // "Saved ..." confirmations only matter right after saving: they appear then, and are gone once the user leaves Config.
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!active) {
      setLocationResult(null);
      setJustSaved(false);
    }
  }, [active]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  // Whether this account's Facebook session is logged in: true / false once Clynx has checked, null before it has.
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getEngineStatusMap()
      .then((map) => {
        if (!cancelled) setLoggedIn(map[account.id]?.loggedIn ?? null);
      })
      .catch(() => {});
    const off = api.onStatusMap((map) => setLoggedIn(map[account.id]?.loggedIn ?? null));
    return () => {
      cancelled = true;
      off();
    };
  }, [account.id]);

  function logIn() {
    setLoggingIn(true);
    api.login(account.id).finally(() => setLoggingIn(false));
  }

  // Saves a location choice the moment it is made (there is no Apply button): picking "Whole country" or a state saves
  // right away, a city/ZIP saves when the field is left or Enter is pressed. Nothing is sent if it's what is already saved.
  async function saveLocation(mode: Account["locationMode"], state: string, city: string) {
    if (mode === "state" && !state) return;
    if (mode === "city" && !city.trim()) return;
    const unchanged =
      mode === account.locationMode &&
      (mode === "country" || (mode === "state" && state === (account.selectedState ?? "")) || (mode === "city" && city.trim() === (account.selectedCityOrZip ?? "").trim()));
    if (unchanged) return;
    setLocationBusy(true);
    setLocationResult(null);
    try {
      const args =
        mode === "country"
          ? ({ accountId: account.id, mode: "country" } as const)
          : mode === "state"
            ? ({ accountId: account.id, mode: "state", state } as const)
            : ({ accountId: account.id, mode: "city", cityOrZip: city.trim() } as const);
      const res = await api.setLocationMode(args);
      setLocationResult(res.message);
      setJustSaved(true);
    } finally {
      setLocationBusy(false);
    }
  }

  async function saveLabel() {
    const trimmed = labelDraft.trim();
    if (!trimmed || trimmed === account.label) {
      setLabelDraft(account.label);
      return;
    }
    await api.updateAccount(account.id, { label: trimmed });
  }

  async function doRemove() {
    setRemoving(true);
    try {
      await api.removeAccount(account.id);
    } finally {
      setRemoving(false);
      setShowRemoveDialog(false);
    }
  }

  return (
    <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={saveLabel}
            style={{ fontWeight: 700, fontSize: 16, maxWidth: 240 }}
          />
          {/* Small and quiet, right beside the name: it only needs to be glanceable. */}
          {loggedIn === true && <span style={{ fontSize: 11.5, color: "var(--success)", fontWeight: 600, whiteSpace: "nowrap" }}>✓ Logged in</span>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className={account.enabled ? "primary" : "ghost"}
            type="button"
            title={account.enabled ? "Included in \"Start all\" / chat-driven start" : "Skipped by \"Start all\" — still loggable/startable on its own"}
            onClick={() => api.updateAccount(account.id, { enabled: !account.enabled })}
          >
            {account.enabled ? "Enabled" : "Disabled"}
          </button>
          {loggedIn === null ? (
            // Not checked yet (the account hasn't started): no assumption either way, but a way in if it's needed.
            <button className="ghost" type="button" disabled={loggingIn} onClick={logIn} style={{ fontSize: 12.5 }}>
              {loggingIn ? "Opening..." : "Log in"}
            </button>
          ) : null}
          <button className="danger" type="button" onClick={() => setShowRemoveDialog(true)}>
            Remove
          </button>
        </div>
      </div>

      {/* Clynx found this account logged out: say so and offer the way back in. */}
      {loggedIn === false && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid var(--warn)",
            background: "var(--warn-bg, rgba(251, 191, 36, 0.08))",
          }}
        >
          <span style={{ fontSize: 13.5, color: "var(--warn)", fontWeight: 600 }}>
            ⚠ {account.label} isn't logged in to Facebook, so it can't scan or run Watches until it is.
          </span>
          <button type="button" className="primary" disabled={loggingIn} onClick={logIn}>
            {loggingIn ? "Opening..." : "Log in now"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={locationDraftMode}
          onChange={(e) => {
            const mode = e.target.value as Account["locationMode"];
            setLocationDraftMode(mode);
            void saveLocation(mode, stateDraft, cityDraft);
          }}
        >
          <option value="country">Whole country</option>
          <option value="state">State</option>
          <option value="city">City/ZIP code</option>
        </select>
        {locationDraftMode === "state" && (
          <select
            value={stateDraft}
            onChange={(e) => {
              setStateDraft(e.target.value);
              void saveLocation("state", e.target.value, cityDraft);
            }}
            style={{ minWidth: 180 }}
          >
            <option value="">Choose a state…</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {locationDraftMode === "city" && (
          <input
            value={cityDraft}
            onChange={(e) => setCityDraft(e.target.value)}
            onBlur={() => void saveLocation("city", stateDraft, cityDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveLocation("city", stateDraft, cityDraft);
            }}
            placeholder='e.g. "Austin, Texas" or a ZIP code'
            style={{ minWidth: 200 }}
          />
        )}
        {locationBusy && <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Saving…</span>}
      </div>
      {locationResult && !locationBusy && <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: 0 }}>{locationResult}</p>}

      {/* Per explicit instruction — changing location mode now only saves
          the choice; it no longer opens a browser to resolve it right away
          (see index.ts's location:setMode). The actual lookup happens the
          next time this account starts, so until then browseUrls/
          searchRadiusMiles below still reflect whatever was PREVIOUSLY
          resolved, not the newly-saved selection — this note is what keeps
          that from reading as if the new choice already silently failed to
          apply. */}
      {!account.locationResolved ? (
        justSaved ? (
          <p style={{ fontSize: 13.5, color: "var(--warn)", margin: 0 }}>
            Saved — {account.locationMode === "state" ? account.selectedState : account.selectedCityOrZip} will be looked
            up on Facebook Marketplace the next time this account starts.
          </p>
        ) : null
      ) : (
        <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>
          {account.browseUrls.length} location{account.browseUrls.length === 1 ? "" : "s"} configured
          {account.locationMode === "state"
            ? ` — ${account.selectedState} (${account.searchRadiusMiles}-mile radius)`
            : account.locationMode === "city"
              ? ` — ${account.selectedCityOrZip} (${account.searchRadiusMiles}-mile radius)`
              : ", spread nationwide"}
        </p>
      )}

      {showRemoveDialog && (
        <Modal title={`Remove "${account.label}"?`} onClose={() => setShowRemoveDialog(false)}>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            This stops its scanning and permanently deletes its saved Facebook login — you'd need to log in again from
            scratch if you re-add it. Listings it already found stay in your Feed either way. This can't be undone.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setShowRemoveDialog(false)}>
              Cancel
            </button>
            <button className="danger-solid" style={{ flex: 1 }} disabled={removing} onClick={doRemove}>
              {removing ? "Removing..." : "Remove"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Per explicit instruction — a clickable 5-star control split into halves
// (10 total zones) so the user can land on e.g. 4.5 instead of only whole
// numbers. null means "no minimum" (the seller-rating check is skipped
// entirely, including a seller with no rating at all) — represented as an
// all-empty row plus the "Any rating" label, not as 0 stars, since 0 would
// misleadingly read as "reject everyone."
const STAR_PATH = "M12 2.5l2.9 6.06 6.6.87-4.83 4.6 1.24 6.6L12 17.6l-5.91 3.03 1.24-6.6-4.83-4.6 6.6-.87L12 2.5z";

function StarRatingPicker({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const display = value ?? 0;
  function fillFor(star: number): "empty" | "half" | "full" {
    if (display >= star) return "full";
    if (display >= star - 0.5) return "half";
    return "empty";
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      <div style={{ display: "flex", gap: 2 }}>
        {[1, 2, 3, 4, 5].map((star) => (
          <div key={star} style={{ position: "relative", width: 22, height: 22 }}>
            <svg viewBox="0 0 24 24" width={22} height={22} style={{ position: "absolute", inset: 0 }}>
              <path d={STAR_PATH} fill="none" stroke="var(--border-strong)" strokeWidth={1.5} strokeLinejoin="round" />
            </svg>
            {fillFor(star) !== "empty" && (
              <svg
                viewBox="0 0 24 24"
                width={22}
                height={22}
                style={{
                  position: "absolute",
                  inset: 0,
                  clipPath: fillFor(star) === "half" ? "inset(0 50% 0 0)" : "none",
                }}
              >
                <path d={STAR_PATH} fill="var(--accent-1)" stroke="var(--accent-1)" strokeWidth={1.5} strokeLinejoin="round" />
              </svg>
            )}
            <div style={{ position: "absolute", inset: 0, display: "flex", cursor: "pointer" }}>
              <div style={{ flex: 1 }} onClick={() => onChange(star - 0.5)} title={`${star - 0.5} stars`} />
              <div style={{ flex: 1 }} onClick={() => onChange(star)} title={`${star} stars`} />
            </div>
          </div>
        ))}
      </div>
      <span style={{ fontSize: 15, color: "var(--text-muted)", minWidth: 74 }}>{value === null ? "Any rating" : `${value.toFixed(1)}+`}</span>
      <button type="button" className="icon ghost" style={{ fontSize: 13 }} onClick={() => onChange(value === null ? 3.5 : null)}>
        {value === null ? "Set minimum" : "Clear"}
      </button>
    </div>
  );
}

