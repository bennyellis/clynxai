import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Config, ListingRecord, ScrapeStatus } from "../lib/api.js";
import { api } from "../lib/api.js";
import { playStartSound, playStopSound } from "../lib/sound.js";

export function Dashboard({
  status,
  listings,
  onStart,
  onStop,
  onGoToFeed,
}: {
  status: ScrapeStatus;
  listings: ListingRecord[];
  onStart: () => void;
  onStop: () => void;
  onGoToFeed: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const dealsToday = useMemo(() => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return listings.filter((l) => l.isDeal && l.firstSeenAt >= since).length;
  }, [listings]);

  async function run(label: string, fn: () => Promise<void> | void) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", overflow: "hidden" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 30 }}>Dashboard</h1>
        <p style={{ color: "var(--text-muted)", margin: "6px 0 0", fontSize: 15 }}>
          Browsing Facebook Marketplace within your set radius for your Search For items and standout deals.
        </p>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          className="success"
          disabled={!!busy || status.running}
          onClick={() => {
            playStartSound();
            run("start", onStart);
          }}
        >
          {status.running ? "Running..." : "Start Scanner"}
        </button>
        <button
          className="danger-solid"
          disabled={!!busy || !status.running}
          onClick={() => {
            playStopSound();
            run("stop", onStop);
          }}
        >
          {busy === "stop" ? "Stopping..." : "Stop"}
        </button>
      </div>
      <p style={{ fontSize: 13.5, color: "var(--text-dim)", margin: "-4px 0 0" }}>
        Starting the scanner opens a Facebook window if one isn't already open — log in there and set your location
        + max distance filter directly inside it, since it's the exact browser profile the scanner reuses. Watch it
        happen live on the Activity page.
      </p>

      {/* Per explicit instruction — Live moves to its own side column,
          large, instead of a horizontal strip at the bottom — everything
          else squeezes into the remaining space on the left, its own
          independently-scrolling column so a tall Live panel doesn't force
          the whole page to scroll just to reach it. */}
      <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 2, minWidth: 0, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", paddingRight: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
            <StatCard label="Listings evaluated" value={listings.length} />
            <StatCard label="Deals in last 24h" value={dealsToday} accent="var(--success)" />
          </div>

          {status.lastError && (
            <div className="card enter" style={{ borderColor: "rgba(248,113,113,0.35)", color: "var(--danger)" }}>
              Last error: {status.lastError}
            </div>
          )}

          <FiltersCard />

          <BestDealsCard listings={listings} />
        </div>

        <LivePanel status={status} onGoToFeed={onGoToFeed} />
      </div>
    </div>
  );
}

// Per explicit instruction — fills the empty space that used to sit below
// the filters card: the top 5 confirmed deals, ranked by discount% (the
// core "how good is this deal" number this whole app is built around),
// each linking straight to the real Facebook listing from its own square
// thumbnail. Avg sale price/time to sell come from the SAME matched-product
// watchcount data Feed's own flame badge uses (see store.ts's
// enrichWithMatchedProductPricing) — real comps, not a guess — and are
// simply omitted per-deal when that data doesn't exist yet, rather than
// showing a placeholder.
function BestDealsCard({ listings }: { listings: ListingRecord[] }) {
  const bestDeals = useMemo(
    () =>
      listings
        .filter((l) => l.isDeal)
        .sort((a, b) => (b.discountPercent ?? -1) - (a.discountPercent ?? -1))
        .slice(0, 5),
    [listings]
  );

  if (bestDeals.length === 0) {
    return (
      <div className="card enter" style={{ color: "var(--text-dim)", fontSize: 14 }}>
        🏆 No confirmed deals yet — the best ones found while scanning will show up here.
      </div>
    );
  }

  return (
    <div className="card enter" style={{ display: "flex", flexDirection: "column", gap: 14, padding: 22 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>🏆 Best Deals</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 14 }}>
        {bestDeals.map((l) => {
          const thumbnail = l.thumbnailUrl ?? l.imageUrls[0] ?? null;
          const runTime = l.matchedProductAvgRunTimeDays;
          return (
            <a
              key={l.id}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title="Open the original Facebook Marketplace listing"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="card" style={{ padding: 0, overflow: "hidden", cursor: "pointer" }}>
                <div style={{ position: "relative", width: "100%", aspectRatio: "1 / 1", background: "var(--bg-elevated)" }}>
                  {thumbnail ? (
                    <img
                      src={thumbnail}
                      alt=""
                      loading="lazy"
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>
                      📦
                    </div>
                  )}
                  {l.discountPercent !== null && (
                    <span
                      className="pill"
                      style={{
                        position: "absolute",
                        top: 6,
                        left: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        background: "rgba(20,18,28,0.72)",
                        border: "1px solid rgba(255,255,255,0.25)",
                        color: "var(--success)",
                      }}
                    >
                      {l.discountPercent.toFixed(0)}% under
                    </span>
                  )}
                </div>
                <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      display: "-webkit-box",
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {l.title}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{l.price !== null ? `$${l.price}` : "—"}</div>
                  {(l.matchedProductAvgSoldPriceUsd !== null || runTime !== null) && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      {l.matchedProductAvgSoldPriceUsd !== null && `avg. sale $${l.matchedProductAvgSoldPriceUsd.toFixed(0)}`}
                      {l.matchedProductAvgSoldPriceUsd !== null && runTime !== null && " · "}
                      {runTime !== null && `sells in ${runTime < 1 ? `${(runTime * 24).toFixed(1)}h` : `${runTime.toFixed(1)}d`}`}
                    </div>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// Per explicit instruction — Live moves off the bottom strip and onto its
// own side column: a big card for whatever ONE listing the AI is on right
// now, plus a fading "up next" queue of what's coming right after it
// (another listing, or an in-between action like switching locations).
// Purely a glanceable panel, not a management surface — Feed is still
// where you act on things, and now also shows everything live itself (see
// Feed.tsx), so Live doesn't need to double as a "recent finds" history the
// way its old horizontal-strip version did.
function LivePanel({ status, onGoToFeed }: { status: ScrapeStatus; onGoToFeed: () => void }) {
  const { currentListing, upcomingListings, currentActionNote, running, analyzingPhotos, currentReaction } = status;

  return (
    <div
      className="card enter"
      style={{ flex: 1, minWidth: 280, padding: 14, display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: "currentColor",
              color: running ? "var(--danger)" : "var(--text-dim)",
              animation: running ? "liveDotPulse 1.6s ease-in-out infinite" : undefined,
              flexShrink: 0,
            }}
          />
          Live
        </div>
        <button className="icon ghost" style={{ fontSize: 12 }} onClick={onGoToFeed}>
          Feed →
        </button>
      </div>

      {/* The big "currently viewing" card — an in-between action note (see
          scrapeEngine.ts's runCycle) takes priority over a stale listing,
          a listing takes priority over the idle/not-running placeholder.
          Each of the three is keyed so switching between them always
          replays its own "enter" animation instead of the DOM just
          patching text in place. */}
      {currentActionNote ? (
        <div
          key={`action-${currentActionNote}`}
          className="enter-fade"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "36px 16px",
            borderRadius: 12,
            background: "var(--gradient-soft)",
            border: "1px solid var(--border-strong)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 30 }}>📍</div>
          <div style={{ fontWeight: 700, fontSize: 14, animation: "liveActionPulse 1.8s ease-in-out infinite" }}>{currentActionNote}</div>
        </div>
      ) : currentListing ? (
        <div key={currentListing.id} className="enter">
          <div style={{ position: "relative", width: "100%", aspectRatio: "1 / 1", borderRadius: 12, overflow: "hidden", background: "var(--bg-elevated)" }}>
            {currentListing.thumbnailUrl ? (
              <img
                src={currentListing.thumbnailUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.visibility = "hidden";
                }}
              />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>
                📦
              </div>
            )}
            {running && <div className="live-scan-overlay" />}
            <span
              className="pill"
              style={{
                position: "absolute",
                top: 8,
                left: 8,
                fontSize: 10.5,
                fontWeight: 700,
                background: "rgba(20,18,28,0.72)",
                border: "1px solid rgba(255,255,255,0.25)",
                color: "white",
              }}
            >
              {analyzingPhotos ? "📸 Researching photos..." : "🔎 Currently viewing"}
            </span>
          </div>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              marginTop: 6,
              lineHeight: 1.3,
              display: "-webkit-box",
              WebkitLineClamp: 1,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {currentListing.title}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{currentListing.price !== null ? `$${currentListing.price}` : "—"}</div>
        </div>
      ) : (
        <div
          className="enter-fade"
          style={{
            padding: "36px 16px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            textAlign: "center",
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          {running ? "Between cycles — sleeping a bit before the next pass." : "Start the scanner to watch it work here, live."}
        </div>
      )}

      {/* The fading "up next" queue — each item's own animation-delay
          staggers its slide-in into a little cascade, and opacity steps
          down per position so it visually trails off rather than stopping
          abruptly. Per explicit instruction — capped to 3 (was 5) and made
          more compact so the AI Feedback box below never needs a scroll to
          reach; keeping the big square image was the priority, this is
          what gave up the room for it. */}
      {upcomingListings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Up next
          </div>
          {upcomingListings.slice(0, 3).map((l, i) => {
            const opacity = Math.max(0.22, 1 - i * 0.18);
            return (
              <div
                key={l.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity,
                  transition: "opacity 0.3s ease",
                  animation: "liveQueueIn 0.4s ease both",
                  animationDelay: `${i * 70}ms`,
                }}
              >
                <div style={{ width: 22, height: 22, borderRadius: 5, overflow: "hidden", flexShrink: 0, background: "var(--bg-elevated)" }}>
                  {l.thumbnailUrl ? (
                    <img src={l.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>
                      📦
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.title}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per explicit instruction — "have the AI place its thoughts in a
          new bubble under the queue with a faded text in the box saying AI
          Feedback": moved down here (below Up next, was previously right
          under the price) with its own faded section label matching Up
          next's own style, rather than blending into the listing card
          above it. The vision model's own first-person reaction (see
          vision.ts's expertTake), shown once photo analysis actually
          resolves for THIS listing — cleared the instant a different
          listing comes into view (see scrapeEngine.ts), so it never
          lingers as a stale take on the wrong item. */}
      {currentReaction && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            AI Feedback
          </div>
          <div
            key={currentReaction}
            className="enter-fade"
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              fontSize: 12,
              lineHeight: 1.45,
              fontStyle: "italic",
              color: "var(--text-muted)",
            }}
          >
            💭 "{currentReaction}"
          </div>
        </div>
      )}
    </div>
  );
}

// Per explicit instruction — a quicker, more visible home on the Dashboard
// itself for the things a user adjusts often (what's currently being
// searched for, price range) than digging into the full Config screen for
// them. Fetches its own slice of config directly (Dashboard doesn't
// otherwise receive it as a prop) and stays live via onConfigUpdated, so a
// change made here, in Config, or by any of the chat assistants (all three
// now go through the same update_config path — see chat.ts) shows up
// wherever else this is open too.
function FiltersCard() {
  const [config, setConfig] = useState<Config | null>(null);
  // Local drafts so typing a price doesn't fire a save on every keystroke —
  // committed on blur/Enter instead. Re-synced from config whenever it
  // changes elsewhere (see the effect below), same guard-against-clobbering
  // idea as Config.tsx's own live-sync, just simpler here since there's no
  // multi-field "dirty" concept — only re-sync a field the user isn't
  // actively typing in (tracked via which input is currently focused).
  const [minDraft, setMinDraft] = useState("");
  const [maxDraft, setMaxDraft] = useState("");
  const [rotateCountDraft, setRotateCountDraft] = useState("5");
  const [focusedField, setFocusedField] = useState<"min" | "max" | "rotateCount" | null>(null);
  // Per explicit instruction — "Add product" used to only stage a LOCAL
  // draft pill, requiring a separate "Search N products" click to actually
  // submit the batch. That extra step is gone now: clicking Add product (or
  // pressing Enter) submits that ONE name immediately via
  // api.searchForProducts, same as before, just with no batching/staging in
  // between.
  //
  // Per further explicit instruction — there used to also be a per-product
  // "max budget" filter entered right alongside the name here. Removed for
  // being functionally the same thing as the Min/Max Price filters just
  // below — one global "what am I willing to pay" is now the only price
  // knob, so adding a product is just a name again.
  const [draftInput, setDraftInput] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c);
      setMinDraft(c.minPriceUsd?.toString() ?? "");
      setMaxDraft(c.maxPriceUsd?.toString() ?? "");
      setRotateCountDraft(String(c.rotateSearchItemsCount));
    });
    const off = api.onConfigUpdated((next) => {
      setConfig(next);
      if (focusedField !== "min") setMinDraft(next.minPriceUsd?.toString() ?? "");
      if (focusedField !== "max") setMaxDraft(next.maxPriceUsd?.toString() ?? "");
      if (focusedField !== "rotateCount") setRotateCountDraft(String(next.rotateSearchItemsCount));
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusedField is read, not depended on, to avoid resubscribing on every focus change
  }, []);

  function commitPriceRange(nextMin: string, nextMax: string) {
    const minPriceUsd = nextMin.trim() ? Math.max(0, Number(nextMin)) : null;
    const maxPriceUsd = nextMax.trim() ? Math.max(0, Number(nextMax)) : null;
    if ((nextMin.trim() && !Number.isFinite(minPriceUsd)) || (nextMax.trim() && !Number.isFinite(maxPriceUsd))) return;
    api.updateFilters({ minPriceUsd, maxPriceUsd });
  }

  function commitRotateCount(next: string) {
    const n = Math.max(1, Math.round(Number(next)));
    if (!next.trim() || !Number.isFinite(n)) {
      setRotateCountDraft(String(config?.rotateSearchItemsCount ?? 5));
      return;
    }
    setConfig((c) => (c ? { ...c, rotateSearchItemsCount: n } : c));
    setRotateCountDraft(String(n));
    api.updateFilters({ rotateSearchItemsCount: n });
  }

  function toggleRotate(next: boolean) {
    setConfig((c) => (c ? { ...c, rotateSearchItems: next } : c));
    api.updateFilters({ rotateSearchItems: next });
  }

  async function removeItem(item: string) {
    // Optimistic — removes it from view immediately rather than waiting on
    // the round trip, since onConfigUpdated will reconcile either way.
    setConfig((c) => (c ? { ...c, searchItems: c.searchItems.filter((s) => s.item !== item) } : c));
    await api.removeSearchItem(item);
  }

  async function addAndSearch() {
    const name = draftInput.trim();
    if (!name || searching) return;
    setDraftInput("");
    setSearching(true);
    try {
      // The submitted item shows up via config.searchItems (and the
      // Activity page's own feed) once onConfigUpdated/engine:log land —
      // this also starts the scanner itself if it isn't already running
      // (see index.ts's search:addProducts), so there's nothing else the
      // user needs to click for this one item to actually start getting
      // searched.
      await api.searchForProducts([name]);
    } finally {
      setSearching(false);
    }
  }

  if (!config) return null;

  return (
    <div className="card enter" style={{ display: "flex", flexDirection: "column", gap: 14, padding: 22 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Search for Products</div>

      {/* Per explicit instruction — "make sure that you can see the queue
          of products. make that queue highly visible": its own tinted,
          bordered block instead of a plain label + flat pills, so newly
          added items are impossible to miss (this is also the section a
          real bug — see index.ts's add_search_item, which never used to
          broadcast config:updated — could make look like "adding a product
          does nothing," even though it was actually being tracked and
          searched the whole time). Rendered even when empty, so its own
          presence/empty-state is part of what makes "did my add actually
          register" obvious at a glance. */}
      <div
        className="enter"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "12px 14px",
          borderRadius: 10,
          background: "var(--gradient-soft)",
          border: "1px solid var(--border-strong)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15.5, fontWeight: 700 }}>🔎 Currently searching for</span>
          <span className="pill" style={{ fontSize: 12.5, fontWeight: 700 }}>
            {config.searchItems.length}
          </span>
        </div>
        {config.searchItems.length === 0 ? (
          <div style={{ fontSize: 14, color: "var(--text-dim)" }}>
            Nothing queued yet — add a product below and it starts searching right away.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {config.searchItems.map((s) => (
              <span
                key={s.item}
                className="pill enter-fade"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 7px 7px 14px", fontSize: 14.5 }}
              >
                {s.item}
                <button
                  className="icon ghost"
                  title={`Remove "${s.item}"`}
                  onClick={() => removeItem(s.item)}
                  style={{ padding: "0 4px", fontSize: 12, lineHeight: 1, color: "var(--text-dim)" }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="Add product…"
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addAndSearch();
              }
            }}
            style={{ flex: 1, minWidth: 160 }}
          />
          <button type="button" className="primary" onClick={addAndSearch} disabled={!draftInput.trim() || searching}>
            {searching ? "Adding…" : "Add product"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14.5,
            color: config.searchItems.length > 1 ? "var(--text)" : "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={config.rotateSearchItems}
            onChange={(e) => toggleRotate(e.target.checked)}
          />
          Rotate search terms every
          <input
            type="number"
            min={1}
            value={rotateCountDraft}
            disabled={!config.rotateSearchItems}
            onFocus={() => setFocusedField("rotateCount")}
            onChange={(e) => setRotateCountDraft(e.target.value)}
            onBlur={() => {
              setFocusedField(null);
              commitRotateCount(rotateCountDraft);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 52 }}
          />
          listings
        </label>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", paddingLeft: 22 }}>
          {config.searchItems.length > 1
            ? config.rotateSearchItems
              ? "Facebook can only search one product at a time — the scanner sticks with one item across however many locations it takes to evaluate that many listings, then moves to the next. Runs independently of location rotation."
              : "Unchecked: no dedicated search per item — the scanner browses generally and only evaluates listings that already look relevant to something above, moving on fast from locations with nothing of interest."
            : "Only matters with 2+ products above — with one (or none), the scanner just searches for that directly."}
        </div>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 13.5, color: "var(--text-muted)" }}>Min. Price</label>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-dim)" }}>$</span>
            <input
              type="number"
              min={0}
              placeholder="No minimum"
              value={minDraft}
              onFocus={() => setFocusedField("min")}
              onChange={(e) => setMinDraft(e.target.value)}
              onBlur={() => {
                setFocusedField(null);
                commitPriceRange(minDraft, maxDraft);
              }}
              style={{ width: 110 }}
            />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 13.5, color: "var(--text-muted)" }}>Max. Price</label>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-dim)" }}>$</span>
            <input
              type="number"
              min={0}
              placeholder="No maximum"
              value={maxDraft}
              onFocus={() => setFocusedField("max")}
              onChange={(e) => setMaxDraft(e.target.value)}
              onBlur={() => {
                setFocusedField(null);
                commitPriceRange(minDraft, maxDraft);
              }}
              style={{ width: 110 }}
            />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 13.5, color: "var(--text-muted)" }}>Date Listed</label>
          <select
            value={config.maxListingAgeHours === null ? "any" : String(config.maxListingAgeHours)}
            onChange={(e) => {
              const value = e.target.value === "any" ? null : Number(e.target.value);
              setConfig((c) => (c ? { ...c, maxListingAgeHours: value } : c));
              api.updateFilters({ maxListingAgeHours: value });
            }}
          >
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
            <option value="720">Last 30 days</option>
            <option value="any">Any time</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const display = useCountUp(value);
  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ fontSize: 13.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 40, fontWeight: 700, marginTop: 6, color: accent ?? "var(--text)" }}>{display}</div>
    </div>
  );
}

// Animates a number ticking up (or down) toward its target over ~500ms
// instead of jumping straight to the new value.
function useCountUp(target: number, durationMs = 500): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return display;
}
