import React, { useEffect, useRef, useState } from "react";
import type { Config as ConfigType } from "../lib/api.js";
import { api } from "../lib/api.js";
import { Modal } from "../components/Modal.js";
import { setSoundEnabled } from "../lib/sound.js";

// Per explicit instruction — the "State" location mode's own picker.
// Alaska and Hawaii deliberately excluded — per explicit instruction,
// ineligible (this app's whole model is nationwide mail-order resale, and
// neither is practical to ship from/to the same way the contiguous states
// are).
const US_STATES = [
  "Alabama", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida",
  "Georgia", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska",
  "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
  "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

export function ConfigScreen({
  onDirtyChange,
  shakeSignal,
}: {
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

  // Per explicit instruction — Config's "Search locations" dropdown. Local
  // drafts (not staged into `config`/Save the way most fields here are) —
  // this applies immediately through its own IPC round trip, same
  // "instant, not batched" posture as setTheme/toggleSound above, since
  // switching where the scanner looks is a real action (it drives a live
  // browser to look things up), not just a settings value to save for
  // later. Synced from the loaded config once, then left alone — the
  // dropdown is what the user is actively choosing, not a live mirror of
  // config.locationMode after that.
  const [locationDraftMode, setLocationDraftMode] = useState<ConfigType["locationMode"]>("country");
  const [stateDraft, setStateDraft] = useState("");
  const [cityDraft, setCityDraft] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationResult, setLocationResult] = useState<string | null>(null);
  const syncedLocationDraftRef = useRef(false);
  // Per explicit instruction — watchcount.com's anonymous usage cap
  // (20 lookups/day) is well below a logged-in account's (200/day), and
  // Google/Facebook sign-in specifically fails inside this app's
  // automated browser (a restriction those providers apply to any
  // automation-flagged browser, unrelated to watchcount) — but its plain
  // email + password login isn't affected by that. Just opens the window;
  // there's no reliable "logged in now" signal to poll for the way
  // Facebook's isLoggedIn check has, so this can't show more than "opened."
  const [watchCountOpening, setWatchCountOpening] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c);
      setSavedSnapshot(JSON.stringify(c));
      if (!syncedLocationDraftRef.current) {
        syncedLocationDraftRef.current = true;
        setLocationDraftMode(c.locationMode);
        setStateDraft(c.selectedState ?? "");
        setCityDraft(c.selectedCityOrZip ?? "");
      }
    });
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
  // same attribute.
  function setTheme(theme: ConfigType["theme"]) {
    update("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }

  // Same "applies immediately, not just staged" posture as setTheme above —
  // per explicit instruction, a Sound on/off switch.
  function toggleSound(enabled: boolean) {
    update("soundEnabled", enabled);
    setSoundEnabled(enabled);
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
  async function applyLocationMode() {
    setLocationBusy(true);
    setLocationResult(null);
    try {
      const args =
        locationDraftMode === "country"
          ? ({ mode: "country" } as const)
          : locationDraftMode === "state"
            ? ({ mode: "state", state: stateDraft } as const)
            : ({ mode: "city", cityOrZip: cityDraft } as const);
      const res = await api.setLocationMode(args);
      setLocationResult(res.message);
    } finally {
      setLocationBusy(false);
    }
  }

  return (
    <div
      className={shaking ? "shake-deny" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%", overflowY: "auto", paddingRight: 4 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30 }}>Config</h1>
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

      <Section title="Facebook Marketplace">
        <Field label="Search locations">
          <select value={locationDraftMode} onChange={(e) => setLocationDraftMode(e.target.value as ConfigType["locationMode"])}>
            <option value="country">Whole country</option>
            <option value="state">State</option>
            <option value="city">City/ZIP code</option>
          </select>
        </Field>

        {locationDraftMode === "state" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <select value={stateDraft} onChange={(e) => setStateDraft(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">Choose a state…</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button type="button" className="primary" disabled={!stateDraft || locationBusy} onClick={applyLocationMode}>
              {locationBusy ? "Looking up city…" : "Apply"}
            </button>
          </div>
        )}

        {locationDraftMode === "city" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input
              value={cityDraft}
              onChange={(e) => setCityDraft(e.target.value)}
              placeholder='e.g. "Austin, Texas" or a ZIP code'
              style={{ minWidth: 200 }}
            />
            <button type="button" className="primary" disabled={!cityDraft.trim() || locationBusy} onClick={applyLocationMode}>
              {locationBusy ? "Looking it up…" : "Apply"}
            </button>
          </div>
        )}

        {locationDraftMode === "country" && (
          <div style={{ marginTop: 8 }}>
            <button type="button" className="primary" disabled={locationBusy} onClick={applyLocationMode}>
              {locationBusy ? "Working…" : "Apply"}
            </button>
          </div>
        )}

        {locationBusy && (
          <p style={{ fontSize: 14, color: "var(--text-dim)", margin: "8px 0 0" }}>
            {locationDraftMode === "state"
              ? "Asking the AI for this state's primary city, then looking it up on Facebook Marketplace..."
              : "Looking this up on Facebook Marketplace..."}
          </p>
        )}
        {locationResult && !locationBusy && (
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "8px 0 0" }}>{locationResult}</p>
        )}

        <p style={{ fontSize: 14, color: "var(--text-dim)", margin: "10px 0 0" }}>
          How many listings to evaluate at one location before rotating to the next — {cfg.browseUrls.length} location
          {cfg.browseUrls.length === 1 ? "" : "s"} configured right now
          {cfg.locationMode === "country"
            ? ", spread nationwide so the scanner keeps moving around the country instead of sitting in one city"
            : cfg.locationMode === "state"
              ? ` — ${cfg.selectedState}'s primary city (${cfg.searchRadiusMiles}-mile radius), skipping anything outside ${cfg.selectedState}`
              : ` — just ${cfg.selectedCityOrZip} (${cfg.searchRadiusMiles}-mile radius)${cfg.selectedState ? `, skipping anything outside ${cfg.selectedState}` : ""}`}
          .
        </p>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Field label="Listings per location before rotating">
            <input
              type="number"
              min={1}
              style={{ width: 100 }}
              value={cfg.listingsPerLocation}
              onChange={(e) => update("listingsPerLocation", Math.max(1, Number(e.target.value)))}
            />
          </Field>
          <Field label="How recent a listing must be">
            <select
              value={cfg.maxListingAgeHours === null ? "any" : String(cfg.maxListingAgeHours)}
              onChange={(e) => update("maxListingAgeHours", e.target.value === "any" ? null : Number(e.target.value))}
            >
              <option value="24">Last 24 hours</option>
              <option value="168">Last 7 days</option>
              <option value="720">Last 30 days</option>
              <option value="any">Any time — no freshness filter</option>
            </select>
          </Field>
          <Field label="Max price">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--text-dim)" }}>$</span>
              <input
                type="number"
                min={0}
                step={1}
                placeholder="No limit"
                style={{ width: 110 }}
                value={cfg.maxPriceUsd ?? ""}
                onChange={(e) => update("maxPriceUsd", e.target.value === "" ? null : Math.max(0, Number(e.target.value)))}
              />
            </div>
          </Field>
        </div>
        <p style={{ fontSize: 14, color: "var(--text-dim)", margin: "10px 0 0" }}>
          Defaults to the last 24 hours, since this is built for a fast-moving business — broaden it if you'd rather
          see more (older) listings than miss ones outside that window. Applied two ways: Facebook's own "Date
          listed" filter is used on the search results page where possible (skips even opening a stale listing), and
          it's enforced again after the fact regardless, so the window is always respected even if that live filter
          click doesn't land. Max price is a hard ceiling on top of that — empty means no limit — checked before a
          listing is ever opened, same as the freshness window.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "var(--text-muted)", textTransform: "none", fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={cfg.photoAnalysis.enabled}
              onChange={(e) => update("photoAnalysis", { enabled: e.target.checked })}
            />
            Automatically analyze photos (deal verification, ineligible-item detection, Database matching)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "var(--text-muted)", textTransform: "none", fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={cfg.autoResearchListings}
              onChange={(e) => update("autoResearchListings", e.target.checked)}
            />
            Automatically research listings (auto-create new Database entries for items it doesn't track yet — turn
            off to only reinforce existing ones, and add new ones yourself via Research)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "var(--text-muted)", textTransform: "none", fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={cfg.ignoreBlacklist}
              onChange={(e) => update("ignoreBlacklist", e.target.checked)}
            />
            Ignore Blacklist (temporarily stop auto-skipping listings that match a blacklisted term or image, without
            clearing the list itself)
          </label>
        </div>
      </Section>

      <Section title="Seller Risk">
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, marginBottom: 12 }}>
          <input type="checkbox" checked={cfg.sellerRisk.enabled} onChange={(e) => update("sellerRisk", { ...cfg.sellerRisk, enabled: e.target.checked })} />
          Screen sellers before opening a listing
        </label>
        <Field label="Minimum seller rating">
          <StarRatingPicker
            value={cfg.sellerRisk.minRating}
            disabled={!cfg.sellerRisk.enabled}
            onChange={(minRating) => update("sellerRisk", { ...cfg.sellerRisk, minRating })}
          />
        </Field>
        <p style={{ fontSize: 14, color: "var(--text-dim)", margin: "10px 0 0" }}>
          Click the left or right half of a star for half-point precision (e.g. 4.5). "Any rating" skips this check
          entirely — a seller with no rating at all still passes.
        </p>
      </Section>

      <Section title="eBay Sold Comps (WatchCount.com)">
        <p style={{ fontSize: 14, color: "var(--text-dim)", margin: "0 0 10px" }}>
          Every time a product gets researched, the assistant checks WatchCount's sold eBay listings for real comps
          (sold price, time to sell) — see that product's own Database page for the results. Anonymous lookups are
          capped at 20/day; a free WatchCount account raises that to 200/day.
        </p>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14.5, color: "var(--text)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={cfg.watchCountOncePerScan}
            onChange={(e) => update("watchCountOncePerScan", e.target.checked)}
          />
          Only check each product once per scan
        </label>
        <p style={{ fontSize: 13.5, color: "var(--text-dim)", margin: "4px 0 10px" }}>
          If the scanner matches the same product again later in the same scan (a Refresh, marking a listing
          Interested, anything that re-triggers research), skip the WatchCount lookup instead of spending another one
          of its limited daily lookups on data that hasn't had time to change. Resets every time the scanner starts.
        </p>
        <button type="button" className="primary" disabled={watchCountOpening} onClick={openWatchCountLogin}>
          {watchCountOpening ? "Opening..." : "Log into WatchCount.com"}
        </button>
        <p style={{ fontSize: 13.5, color: "var(--text-dim)", margin: "10px 0 0" }}>
          Opens a real WatchCount window on the same browser profile the lookups themselves use — log in there with
          email + password, not Google/Facebook: those providers refuse to sign in inside an automated browser
          window like this one (their own restriction, not WatchCount's), but a plain email + password account isn't
          affected. This app never sees your password.
        </p>
      </Section>

      <Section title="Appearance">
        <div style={{ display: "flex", gap: 8 }}>
          <button className={cfg.theme === "dark" ? "primary" : ""} type="button" onClick={() => setTheme("dark")}>
            🌙 Dark
          </button>
          <button className={cfg.theme === "light" ? "primary" : ""} type="button" onClick={() => setTheme("light")}>
            ☀️ Light
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className={cfg.soundEnabled ? "primary" : ""} type="button" onClick={() => toggleSound(true)}>
            🔊 Sound on
          </button>
          <button className={!cfg.soundEnabled ? "primary" : ""} type="button" onClick={() => toggleSound(false)}>
            🔇 Sound off
          </button>
        </div>
      </Section>

      <Section title="Push notifications (ntfy)">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Field label="Server">
            <input value={config.ntfy.server} onChange={(e) => update("ntfy", { ...config.ntfy, server: e.target.value })} />
          </Field>
          <Field label="Topic (private, hard to guess)">
            <input value={config.ntfy.topic} onChange={(e) => update("ntfy", { ...config.ntfy, topic: e.target.value })} />
          </Field>
        </div>
        <p style={{ fontSize: 14, color: "var(--text-dim)", margin: "8px 0 0" }}>
          Install the ntfy app and subscribe to this exact topic name to get alerts on your phone.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div style={{ fontWeight: 700, marginBottom: 12 }}>{title}</div>
      {children}
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

