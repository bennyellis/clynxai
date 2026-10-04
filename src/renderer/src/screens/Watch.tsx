import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { Watch as WatchType, WatchMatch, ListingRecord } from "../lib/api.js";
import { WatchFormFlow } from "../components/WatchFormFlow.js";
import { ListingCard } from "../components/ListingCard.js";
import { Modal } from "../components/Modal.js";

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

export function WatchScreen({ active }: { active: boolean }) {
  const [watches, setWatches] = useState<WatchType[]>([]);
  const [globallyPaused, setGloballyPaused] = useState(false);
  // "new" starts the create flow with nothing pre-known; a Watch object
  // opens that same flow already in its "conditions" step, editing it.
  const [formTarget, setFormTarget] = useState<"new" | WatchType | null>(null);
  const [matchesFor, setMatchesFor] = useState<WatchType | null>(null);

  useEffect(() => {
    api.listWatches().then(setWatches);
    api.getConfig().then((c) => setGloballyPaused(c.watch.globallyPaused));
    const offWatches = api.onWatchesUpdated(setWatches);
    const offConfig = api.onConfigUpdated((c) => setGloballyPaused(c.watch.globallyPaused));
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

  async function toggleEnabled(w: WatchType) {
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
        <h1 style={{ margin: 0, fontSize: 30 }}>👁 Watch</h1>
        <p style={{ color: "var(--text-muted)", margin: "6px 0 0", fontSize: 15 }}>Clynx is watching Marketplace for you.</p>
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
                  <div style={{ fontWeight: 700, fontSize: 16, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {w.name}
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
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: "var(--text-muted)" }}>
                  {conditions.length > 0 ? (
                    conditions.map((line, i) => <div key={i}>{line}</div>)
                  ) : (
                    <div style={{ color: "var(--text-dim)" }}>No conditions set — matches on price/keyword alone</div>
                  )}
                </div>
                {(w.minProfitUsd !== null || w.minDiscountPercent !== null) && w.linkedProductId === null && (
                  <div style={{ fontSize: 12, color: "var(--warn)" }}>
                    Waiting for pricing data — link this Watch to a Database product with resale/eBay pricing to enable the profit/discount condition above.
                  </div>
                )}
                <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                  {w.listingsSeenCount} listing{w.listingsSeenCount === 1 ? "" : "s"} seen · {w.matchCount} match
                  {w.matchCount === 1 ? "" : "es"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>Last checked {timeAgoShort(w.lastCheckedAt)}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  <button className="icon" style={{ fontSize: 12.5 }} onClick={() => setMatchesFor(w)}>
                    View Matches
                  </button>
                  <button className="icon ghost" style={{ fontSize: 12.5 }} onClick={() => toggleEnabled(w)}>
                    {w.enabled ? "Pause" : "Resume"}
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

  return (
    <Modal title={`Matches for "${watch.name}"`} onClose={onClose}>
      {matches.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: "var(--text-dim)" }}>No matches yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto" }}>
          {matches.map(({ match, listing }) => (
            <ListingCard key={match.id} record={listing} cardWidth={300} />
          ))}
        </div>
      )}
    </Modal>
  );
}
