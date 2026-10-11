import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { Watch as WatchType, WatchMatch, ListingRecord } from "../lib/api.js";
import { WatchFormFlow } from "../components/WatchFormFlow.js";
import { EbayLogo, FacebookLogo } from "../components/ListingSourceMarks.js";
import { ListingCard } from "../components/ListingCard.js";
import { ThumbnailSizeSlider, useThumbnailSize } from "../components/ThumbnailSize.js";
import { Modal } from "../components/Modal.js";
import { formatWatchInterval } from "../../../main/watchOptions.js";

// Per explicit instruction — "Last checked 42 sec ago" needs second-level
// granularity Feed/ListingCard's own timeAgo (minute-granularity) doesn't
// have; a small local variant instead of exporting/sharing one helper for
// two genuinely different precision needs.
function timeAgoShort(ts: number | null): string {
  if (ts === null) return "never";
  const diffMs = Date.now() - ts;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs} sec ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Per explicit instruction — a Watch card's own condition summary, plain-
// English, only listing conditions that are actually SET ("do not require
// every condition" — most Watches will only have 1-3 of these).
function formatConditions(w: WatchType): string[] {
  const lines: string[] = [];
  if (w.maxPriceUsd !== null) lines.push(`≤ $${w.maxPriceUsd}`);
  if (w.minPriceUsd !== null) lines.push(`≥ $${w.minPriceUsd}`);
  if (w.platform === "ebay") {
    // No location on eBay — it's searched nationwide.
    if (w.minSellerRatingPercent !== null) lines.push(`Seller rating ≥ ${w.minSellerRatingPercent}%`);
    if (w.minProfitUsd !== null) lines.push(`≥ $${w.minProfitUsd} estimated profit`);
    if (w.minDiscountPercent !== null) lines.push(`≥ ${w.minDiscountPercent}% below market`);
    if (w.maxListingAgeMinutes !== null) lines.push(`Listed within ${w.maxListingAgeMinutes} min`);
    return lines;
  }
  if (w.locationMode === "city" && w.selectedCityOrZip) {
    lines.push(w.searchRadiusMiles !== null ? `Within ${w.searchRadiusMiles} miles of ${w.selectedCityOrZip}` : w.selectedCityOrZip);
  } else if (w.locationMode === "state" && w.selectedState) {
    lines.push(w.searchRadiusMiles !== null ? `Within ${w.searchRadiusMiles} miles in ${w.selectedState}` : w.selectedState);
  } else if (w.locationMode === "country") {
    lines.push("Nationwide");
  }
  if (w.minProfitUsd !== null) lines.push(`≥ $${w.minProfitUsd} estimated profit`);
  if (w.minDiscountPercent !== null) lines.push(`≥ ${w.minDiscountPercent}% below market`);
  if (w.maxListingAgeMinutes !== null) lines.push(`Listed within ${w.maxListingAgeMinutes} min`);
  return lines;
}

// Where this Watch's notifications go: the topic in Config, or its own ntfy topic (for a Watch run for somebody else,
// like a friend's area, so only their phone hears about their finds).
function WatchNtfyRow({ watch, mainTopic, onSaved }: { watch: WatchType; mainTopic: string; onSaved: (w: WatchType) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(watch.ntfyTopic ?? "");
  const [error, setError] = useState<string | null>(null);
  async function save(topic: string | null) {
    const updated = await api.setWatchNtfyTopic(watch.id, topic);
    if (!updated) {
      setError("Topic names can only use letters, numbers, dashes and underscores.");
      return;
    }
    setError(null);
    setEditing(false);
    onSaved(updated);
  }
  if (!editing) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>
          🔔 Notifies ntfy topic: <strong style={{ color: "var(--text)" }}>{watch.ntfyTopic ?? (mainTopic || "(none set in Config)")}</strong>
          {watch.ntfyTopic ? " (this Watch only)" : ""}
        </span>
        <button className="icon ghost" style={{ fontSize: 11.5, padding: "2px 8px" }} onClick={() => { setDraft(watch.ntfyTopic ?? ""); setEditing(true); }}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>🔔 ntfy topic for this Watch:</span>
        <input
          value={draft}
          placeholder={mainTopic || "topic name"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save(draft.trim() || null);
          }}
          style={{ width: 160, fontSize: 12.5 }}
        />
        <button className="primary" style={{ fontSize: 12, padding: "3px 10px" }} onClick={() => save(draft.trim() || null)}>
          Save
        </button>
        {watch.ntfyTopic && (
          <button className="icon ghost" style={{ fontSize: 12 }} onClick={() => save(null)}>
            Use the Config topic
          </button>
        )}
        <button className="icon ghost" style={{ fontSize: 12 }} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}
    </div>
  );
}

export function WatchScreen({ active }: { active: boolean }) {
  const [mainNtfyTopic, setMainNtfyTopic] = useState("");
  const [watches, setWatches] = useState<WatchType[]>([]);
  const [globallyPaused, setGloballyPaused] = useState(false);
  // Account id -> label, for "Using: Account 1, Account 2".
  const [accountLabels, setAccountLabels] = useState<Record<string, string>>({});
  // eBay Watches only run while "Search eBay" is on and API credentials exist.
  const [ebayEnabled, setEbayEnabled] = useState(true);
  const [hasEbayCredentials, setHasEbayCredentials] = useState(true);
  // "new" starts the create flow with nothing pre-known; a Watch object
  // opens that same flow already in its "conditions" step, editing it.
  const [formTarget, setFormTarget] = useState<"new" | WatchType | null>(null);
  const [matchesFor, setMatchesFor] = useState<WatchType | null>(null);

  useEffect(() => {
    api.listWatches().then(setWatches);
    api.getConfig().then((c) => {
      setGloballyPaused(c.watch.globallyPaused);
      setMainNtfyTopic(c.ntfy?.topic ?? "");
      setEbayEnabled(c.ebay?.enabled ?? false);
      setAccountLabels(Object.fromEntries(c.accounts.map((a) => [a.id, a.label])));
    });
    api.hasEbayCredentials().then(setHasEbayCredentials);
    const offWatches = api.onWatchesUpdated(setWatches);
    const offConfig = api.onConfigUpdated((c) => {
      setGloballyPaused(c.watch.globallyPaused);
      setMainNtfyTopic(c.ntfy?.topic ?? "");
      setEbayEnabled(c.ebay?.enabled ?? false);
      setAccountLabels(Object.fromEntries(c.accounts.map((a) => [a.id, a.label])));
    });
    return () => {
      offWatches();
      offConfig();
    };
  }, []);

  // Per explicit instruction — the Sidebar's unseen-match pulse should
  // clear the moment the user actually opens this screen, not per-match.
  // Bug found live: App.tsx keeps every screen permanently mounted (just
  // toggling display:none on tab switches, so state survives navigating
  // away) — a plain mount-only effect here would only ever fire once, at
  // app STARTUP, clearing the indicator before the user had ever actually
  // looked at this tab. Gating on the `active` prop (screen === "watch" in
  // App.tsx) instead means this only fires on a genuine visit, and again on
  // every subsequent one.
  useEffect(() => {
    if (active) api.markWatchMatchesViewed();
  }, [active]);

  // A Watch is only actually watching when it is on AND "Pause All" is off. The button
  // says what it will do: Pause when it is watching, Resume otherwise. Under Pause All
  // there is no resuming just one, so Resume turns Pause All off (and turns this Watch
  // on if it had been paused by itself too).
  async function toggleEnabled(w: WatchType) {
    if (globallyPaused) {
      if (!w.enabled) await api.setWatchEnabled(w.id, true);
      await api.resumeAllWatches();
      return;
    }
    await api.setWatchEnabled(w.id, !w.enabled);
  }

  async function remove(w: WatchType) {
    await api.deleteWatch(w.id);
  }

  async function togglePauseAll() {
    if (globallyPaused) await api.resumeAllWatches();
    else await api.pauseAllWatches();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", overflowY: "auto" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28 }}>Watch</h1>
        <p style={{ color: "var(--text-muted)", margin: "6px 0 0", fontSize: 15 }}>Clynx is watching Facebook Marketplace and eBay for you.</p>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <button className="primary" onClick={() => setFormTarget("new")}>
          + Create Watch
        </button>
        <button className="icon" onClick={togglePauseAll} disabled={watches.length === 0}>
          {globallyPaused ? "Resume All" : "Pause All"}
        </button>
      </div>

      {watches.length === 0 ? (
        <div className="card enter" style={{ padding: 24, color: "var(--text-dim)", textAlign: "center", fontSize: 14 }}>
          Nothing being watched yet — create one to have Clynx keep an eye out for something over time, even when the
          Scanner isn't running.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
          {watches.map((w) => {
            const effectivelyWatching = w.enabled && !globallyPaused;
            const conditions = formatConditions(w);
            return (
              <div key={w.id} className="card enter" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 18 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    {w.platform === "ebay" ? <EbayLogo height={18} /> : <FacebookLogo size={18} />}
                    <div style={{ fontWeight: 700, fontSize: 16, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {w.name}
                    </div>
                  </div>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12.5,
                      flexShrink: 0,
                      color: effectivelyWatching ? "var(--success)" : "var(--text-dim)",
                    }}
                  >
                    <span className={`dot ${effectivelyWatching ? "on" : "off"}`} />
                    {globallyPaused ? "Paused (all)" : w.enabled ? "Watching" : "Paused"}
                  </span>
                </div>
                {w.platform === "facebook" && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {w.terms.map((t) => (
                      <span key={t.phrase} className="pill" style={{ fontSize: 12.5 }}>
                        {t.phrase}
                      </span>
                    ))}
                  </div>
                )}
                {w.platform === "facebook" && (
                  <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                    Checks every {formatWatchInterval(w.checkIntervalMinutes)} ·{" "}
                    {w.accountIds.length
                      ? `using ${w.accountIds.map((id) => accountLabels[id] ?? "a removed account").join(", ")}`
                      : "using any logged-in account"}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: "var(--text-muted)" }}>
                  {conditions.length > 0 ? (
                    conditions.map((line, i) => <div key={i}>{line}</div>)
                  ) : (
                    <div style={{ color: "var(--text-dim)" }}>No conditions set — matches on price/keyword alone</div>
                  )}
                </div>
                {w.platform === "ebay" && (!ebayEnabled || !hasEbayCredentials) && (
                  <div style={{ fontSize: 12, color: "var(--warn)" }}>
                    {!ebayEnabled
                      ? 'eBay searching is off — turn on "Search eBay" in Config to run this Watch.'
                      : "eBay API credentials aren't set up yet (see .env.example) — this Watch can't run until they are."}
                  </div>
                )}
                {(w.minProfitUsd !== null || w.minDiscountPercent !== null) && w.terms.every((t) => t.linkedProductId === null) && (
                  <div style={{ fontSize: 12, color: "var(--warn)" }}>
                    Waiting for pricing data — link this Watch to a Database product with resale/eBay pricing to enable the profit/discount condition above.
                  </div>
                )}
                {w.platform === "facebook" && w.searchLinks.length > 0 && (
                  <details style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    <summary style={{ cursor: "pointer" }}>
                      {w.searchLinks.length} search{w.searchLinks.length === 1 ? "" : "es"} on Facebook
                    </summary>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                      {w.searchLinks.map((l) => (
                        <a key={`${l.term}|${l.place}`} href={l.url} target="_blank" rel="noreferrer" title={l.url} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {l.term} · {l.place}
                        </a>
                      ))}
                    </div>
                  </details>
                )}
                <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                  {w.listingsSeenCount} listing{w.listingsSeenCount === 1 ? "" : "s"} seen · {w.matchCount} match
                  {w.matchCount === 1 ? "" : "es"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>Last checked {timeAgoShort(Math.max(w.lastCheckedAt ?? 0, w.lastActiveCheckAt ?? 0) || null)}</div>
                <WatchNtfyRow watch={w} mainTopic={mainNtfyTopic} onSaved={(updated) => setWatches((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))} />
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  <button className="icon" style={{ fontSize: 12.5 }} onClick={() => setMatchesFor(w)}>
                    View Matches
                  </button>
                  <button className="icon ghost" style={{ fontSize: 12.5 }} onClick={() => toggleEnabled(w)}>
                    {effectivelyWatching ? "Pause" : "Resume"}
                  </button>
                  <button className="icon ghost" style={{ fontSize: 12.5 }} onClick={() => setFormTarget(w)}>
                    Edit
                  </button>
                  <button className="icon ghost" style={{ fontSize: 12.5, color: "var(--danger)" }} onClick={() => remove(w)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formTarget && (
        <WatchFormFlow watch={formTarget === "new" ? undefined : formTarget} onClose={() => setFormTarget(null)} onSaved={() => setFormTarget(null)} />
      )}
      {matchesFor && <WatchMatchesModal watch={matchesFor} onClose={() => setMatchesFor(null)} />}
    </div>
  );
}

// Per explicit instruction — "reuse the canonical listing record rather
// than copying the entire listing into the Watch system": store.ts's
// listWatchMatches already joins each match against its real listings row,
// so this just hands that straight to the SAME ListingCard every other
// screen uses — no new card component needed.
function WatchMatchesModal({ watch, onClose }: { watch: WatchType; onClose: () => void }) {
  const [matches, setMatches] = useState<Array<{ match: WatchMatch; listing: ListingRecord }>>([]);

  useEffect(() => {
    api.listWatchMatches(watch.id).then(setMatches);
  }, [watch.id]);

  // Laid out like the Feed: a wide window with a grid of the same full cards (same size slider, remembered separately), so several
  // matches can be compared at a glance instead of scrolling one narrow column.
  const [cardSize, setCardSize] = useThumbnailSize("watchMatchCardSize", 300);

  return (
    <Modal title={`Matches for "${watch.name}"`} onClose={onClose} width={1180}>
      {matches.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-dim)" }}>No matches yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, color: "var(--text-muted)", fontWeight: 600 }}>
              {matches.length} match{matches.length === 1 ? "" : "es"}
            </span>
            <ThumbnailSizeSlider value={cardSize} onChange={setCardSize} min={220} max={480} step={20} />
          </div>
          <div
            data-testid="watch-match-grid"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))`,
              gap: 14,
              maxHeight: "calc(100vh - 190px)",
              overflowY: "auto",
              paddingRight: 4,
              alignItems: "start",
            }}
          >
            {matches.map(({ match, listing }) => (
              <ListingCard key={match.id} record={listing} cardWidth={cardSize} animate={false} />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
