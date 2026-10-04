import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Account, Config, ListingRecord, ProductProfile, ScrapeStatus, SearchItem } from "../lib/api.js";
import { api } from "../lib/api.js";
import { playStartSound, playStopSound } from "../lib/sound.js";
import { Modal } from "../components/Modal.js";
import { WatchFormFlow } from "../components/WatchFormFlow.js";
import { FlameIcon, SOURCE_COLORS, SOURCE_NAMES, SourceLogo, isHotListing, type ListingSource } from "../components/ListingSourceMarks.js";

export function Dashboard({
  accounts,
  statusMap,
  listings,
  onStart,
  onStop,
  onGoToFeed,
}: {
  accounts: Account[];
  statusMap: Record<string, ScrapeStatus>;
  listings: ListingRecord[];
  onStart: (accountId: string) => void;
  onStop: (accountId: string) => void;
  onGoToFeed: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Config's "Search Facebook Marketplace" master toggle (see Config.tsx) —
  // fetched independently here rather than lifted into App.tsx/passed down,
  // same self-contained pattern Config.tsx itself already uses for its own
  // api.getConfig()/onConfigUpdated pair. Defaults true so a slow first
  // fetch never flashes the button into a falsely-disabled state.
  const [facebookEnabled, setFacebookEnabled] = useState(true);
  // Config's "Search eBay" toggle — same self-contained fetch, gates whether
  // the Live panel shows an eBay tile at all (see LiveCard below).
  const [ebayEnabled, setEbayEnabled] = useState(false);
  useEffect(() => {
    api.getConfig().then((c) => {
      setFacebookEnabled(c.facebookEnabled !== false);
      setEbayEnabled(!!c.ebay?.enabled);
    });
    const off = api.onConfigUpdated((c) => {
      setFacebookEnabled(c.facebookEnabled !== false);
      setEbayEnabled(!!c.ebay?.enabled);
    });
    return () => {
      off();
    };
  }, []);
  // Per explicit instruction — "the Listings Evaluated caps at 500, make it
  // have no cap": listings.length is capped at whatever page App.tsx's
  // refreshListings fetched (listListings(500, 0), sized for the Feed's own
  // display, not an all-time count) — a real COUNT(*) instead (see
  // store.ts's countListings) has no such ceiling. Re-fetched whenever
  // `listings` itself refreshes (new listing found, feedback, etc.) so this
  // stays live without needing its own separate push event.
  const [totalListingsEvaluated, setTotalListingsEvaluated] = useState(0);
  useEffect(() => {
    api.countListings().then(setTotalListingsEvaluated);
  }, [listings]);

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

  const accountsWithErrors = accounts.filter((a) => statusMap[a.id]?.lastError);
  // Per explicit instruction — back to a single green Start / red Stop
  // pair (not a per-account row each, not a separate "start all" bar on
  // top of that) — these two just act on every account at once now.
  // Disabled accounts are skipped for Start, same as chat's own "start the
  // scanner" tool — enabling/disabling an account in Config is exactly
  // what "should this be included when starting everything" means.
  const startableAccounts = accounts.filter((a) => a.enabled && !statusMap[a.id]?.running);
  const runningAccounts = accounts.filter((a) => statusMap[a.id]?.running);

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
          disabled={!!busy || !startableAccounts.length || !facebookEnabled}
          // Per explicit instruction — "for the start/stop buttons, don't
          // play the D pitch — that's what their own unique chimes are
          // for": App.tsx's global click-sound listener skips any element
          // matching this attribute (or an ancestor of it), so this button
          // only ever plays its own playStartSound() below, not both.
          data-no-click-sound
          onClick={() => {
            playStartSound();
            // Bug found live: this loop used to fire onStart for every
            // account without awaiting any of the returned promises — run()
            // itself did `await fn()`, but a plain for-loop body has nothing
            // to await, so it resolved (and cleared `busy`) almost
            // instantly, well before the actual engine:start IPC round-trips
            // completed. That's why the button never visibly stayed disabled
            // and never showed a "scanning" state — busy was true for a
            // single React tick, not for the real duration of starting.
            run("start", () => Promise.all(startableAccounts.map((account) => onStart(account.id))).then(() => undefined));
          }}
        >
          {!facebookEnabled ? (
            "Facebook Off"
          ) : !startableAccounts.length ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              Scanning
              <span className="typing-dots">
                <span />
                <span />
                <span />
              </span>
            </span>
          ) : (
            "Start Scanner"
          )}
        </button>
        <button
          className="danger-solid"
          disabled={!!busy || !runningAccounts.length}
          data-no-click-sound
          onClick={() => {
            playStopSound();
            run("stop", () => Promise.all(runningAccounts.map((account) => onStop(account.id))).then(() => undefined));
          }}
        >
          {busy === "stop" ? "Stopping..." : "Stop"}
        </button>
      </div>
      <p style={{ fontSize: 13.5, color: "var(--text-dim)", margin: "-4px 0 0" }}>
        Starts every enabled account at once, each opening its own Facebook window if one isn't already open — log in
        there (or from Config's Accounts section) and set that account's location + max distance filter directly
        inside it, since it's the exact browser profile that account reuses. Watch it happen live on the Activity
        page.
      </p>

      {/* Per explicit instruction — Live moves to its own side column,
          large, instead of a horizontal strip at the bottom — everything
          else squeezes into the remaining space on the left, its own
          independently-scrolling column so a tall Live panel doesn't force
          the whole page to scroll just to reach it. */}
      <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 2, minWidth: 0, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", paddingRight: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
            <StatCard label="Listings evaluated" value={totalListingsEvaluated} />
            <StatCard label="Deals in last 24h" value={dealsToday} accent="var(--success)" />
          </div>

          {accountsWithErrors.map((account) => (
            <div key={account.id} className="card enter" style={{ borderColor: "rgba(248,113,113,0.35)", color: "var(--danger)" }}>
              {account.label} — last error: {statusMap[account.id]!.lastError}
            </div>
          ))}

          <FiltersCard />

          <BestDealsCard listings={listings} />
        </div>

        {/* Per explicit instruction — "I don't like how there's one Live for
            each account, I think it should just be a big window and it
            should display everything that each account sees in one spot":
            a single Live card now (was one full-size card stacked per
            account) — see LiveCard below for how each account's own tile
            shrinks to fit alongside the others once more than one is
            running. */}
        <div style={{ flex: 1, minWidth: 280, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <LiveCard accounts={accounts} statusMap={statusMap} onGoToFeed={onGoToFeed} ebayEnabled={ebayEnabled} />
        </div>
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
          const hot = isHotListing(l);
          const sourceColor = SOURCE_COLORS[l.source];
          return (
            <a
              key={l.id}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={`Open the original ${SOURCE_NAMES[l.source]} listing`}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              {/* Per explicit instruction — Facebook listings get a blue
                  outline + small Facebook logo, eBay ones a green outline +
                  small eBay logo, and a really good one also gets an orange
                  flame and a glow (see global.css's .listing-hot). */}
              <div
                className={`card${hot ? " listing-hot" : ""}`}
                style={{ padding: 0, overflow: "hidden", cursor: "pointer", border: `2px solid ${sourceColor}`, ["--source-color" as string]: sourceColor }}
              >
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
                  <div style={{ position: "absolute", top: 6, right: 6, display: "flex", alignItems: "center", gap: 5 }}>
                    {hot && <FlameIcon size={22} />}
                    <SourceLogo source={l.source} size={18} />
                  </div>
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

// Per explicit instruction — "I don't like how there's one Live for each
// account, I think it should just be a big window and it should display
// everything that each account sees in one spot. If there are multiple
// accounts running, make each Live image smaller": one outer card (one
// header, one "Feed →" link) instead of a fully separate card per account,
// with each account's own tile arranged in a grid inside it — a single
// account still gets the full-size big-square treatment (unchanged from
// before), 2+ accounts shrink to fit side by side via the grid's own
// minmax, same concurrent glance-at-everything-at-once idea the old
// stacked-cards version had, just laid out together instead of requiring a
// long scroll to see the Nth account.
function LiveCard({
  accounts,
  statusMap,
  onGoToFeed,
  ebayEnabled,
}: {
  accounts: Account[];
  statusMap: Record<string, ScrapeStatus>;
  onGoToFeed: () => void;
  // Per explicit instruction — "a live view of eBay searching just like the
  // Facebook live scraper": eBay isn't a real Facebook Account (no
  // browser/login/location), so it's a synthetic extra tile here rather
  // than something threaded through the real `accounts` list — shown
  // whenever Config's "Search eBay" toggle is on, same gating the eBay
  // engine itself uses, not just whenever credentials happen to exist.
  ebayEnabled: boolean;
}) {
  const tileCount = accounts.length + (ebayEnabled ? 1 : 0);
  const compact = tileCount > 1;
  return (
    <div className="card enter" style={{ flex: 1, minWidth: 280, padding: 14, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>🔴 Live</div>
        <button className="icon ghost" style={{ fontSize: 12 }} onClick={onGoToFeed}>
          Feed →
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: compact ? "repeat(auto-fit, minmax(180px, 1fr))" : "1fr",
          gap: 12,
          alignItems: "start",
        }}
      >
        {accounts.map((account) => (
          <LiveAccountTile key={account.id} status={statusMap[account.id]} label={account.label} compact={compact} source="facebook" />
        ))}
        {ebayEnabled && (
          <LiveAccountTile
            key="ebay"
            status={statusMap["ebay"]}
            label="eBay"
            compact={compact}
            source="ebay"
            offMessage="eBay is on but idle — it searches by keyword, so add a Search For item (or a Watch) and it starts within seconds. Check Activity if it doesn't."
          />
        )}
      </div>
    </div>
  );
}

// Per explicit instruction — "still have the ai give concurrent emotional
// feedback on its feelings towards the listing and logical feedback based
// on what it's actively doing": every account's tile keeps BOTH of those
// running independently and at the same time — currentActionNote/the
// "Currently viewing"/"Analyzing photos..." labels are the logical,
// what's-it-doing-right-now half, and currentReaction (the vision model's
// own first-person take, see vision.ts's expertTake) is the emotional half
// — neither was removed by folding every account into one shared card,
// they're just smaller now when there's more than one tile to fit.
// `status` is optional for the brief window before that account's first
// engine:statusMap push has arrived (a just-added account, or right at app
// startup) — treated the same as a freshly-idle account rather than
// rendering broken/undefined fields.
function LiveAccountTile({
  status,
  label,
  compact,
  offMessage,
  source,
}: {
  status: ScrapeStatus | undefined;
  label: string;
  compact: boolean;
  // Which marketplace this tile is watching — drives the small logo next to
  // the label and the colored outline on the "currently viewing" photo.
  source: ListingSource;
  // Per explicit instruction — eBay's tile reuses this exact component
  // ("a live view of eBay searching just like the Facebook live scraper")
  // but has no "Start Scanner" button of its own to point at — it's a
  // Config toggle instead — so the not-running placeholder text needs its
  // own wording rather than Facebook's "Start the scanner..." default.
  offMessage?: string;
}) {
  const {
    currentListing = null,
    upcomingListings = [],
    currentActionNote = null,
    running = false,
    analyzingPhotos = false,
    currentReaction = null,
    loggedIn = null,
  } = status ?? {};

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: compact ? 10 : 0,
        borderRadius: 12,
        background: compact ? "var(--bg-elevated)" : "transparent",
        border: compact ? "1px solid var(--border)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: compact ? 12.5 : 14 }}>
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
        <SourceLogo source={source} size={16} />
        {label}
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
            padding: compact ? "18px 12px" : "36px 16px",
            borderRadius: 12,
            background: "var(--gradient-soft)",
            border: "1px solid var(--border-strong)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: compact ? 22 : 30 }}>📍</div>
          <div style={{ fontWeight: 700, fontSize: compact ? 12.5 : 14, animation: "liveActionPulse 1.8s ease-in-out infinite" }}>
            {currentActionNote}
          </div>
        </div>
      ) : currentListing ? (
        <div key={currentListing.id} className="enter">
          <div style={{ position: "relative", width: "100%", aspectRatio: "1 / 1", borderRadius: 12, overflow: "hidden", background: "var(--bg-elevated)", boxShadow: `0 0 0 2px ${SOURCE_COLORS[source]}` }}>
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
              fontSize: compact ? 12.5 : 14,
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
          <div style={{ fontSize: compact ? 15 : 18, fontWeight: 700, marginTop: 2 }}>
            {currentListing.price !== null ? `$${currentListing.price}` : "—"}
          </div>
        </div>
      ) : (
        <div
          className="enter-fade"
          style={{
            padding: compact ? "18px 12px" : "36px 16px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            textAlign: "center",
            fontSize: 12.5,
            color: "var(--text-dim)",
          }}
        >
          {running
            ? loggedIn === false
              ? "⚠ Not logged into Facebook in this account's browser window — log in there, then it'll pick back up on its own next cycle."
              : "Between cycles — sleeping a bit before the next pass."
            : (offMessage ?? "Start the scanner to watch it work here, live.")}
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
          {upcomingListings.slice(0, compact ? 2 : 3).map((l, i) => {
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
              ...(compact
                ? { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }
                : {}),
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
// Per explicit instruction — "format like [product] $000-111" on each
// Search For pill, "if the user selects no min/max just leave the
// $000-111 part blank." Both set is the exact literal format asked for;
// only-one-set falls back to a sensible open-ended label rather than
// inventing a fake other bound.
function formatPriceRangeLabel(minPriceUsd: number | null, maxPriceUsd: number | null): string {
  if (minPriceUsd == null && maxPriceUsd == null) return "";
  if (minPriceUsd != null && maxPriceUsd != null) return `$${minPriceUsd}-${maxPriceUsd}`;
  if (minPriceUsd != null) return `$${minPriceUsd}+`;
  return `up to $${maxPriceUsd}`;
}

function parsePriceDraft(v: string): number | null {
  if (!v.trim()) return null;
  const n = Math.max(0, Number(v));
  return Number.isFinite(n) ? n : null;
}

function FiltersCard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [rotateCountDraft, setRotateCountDraft] = useState("5");
  const [focusedField, setFocusedField] = useState<"rotateCount" | null>(null);
  // Per explicit instruction — "Add product" used to only stage a LOCAL
  // draft pill, requiring a separate "Search N products" click to actually
  // submit the batch. That extra step is gone now: clicking Add product (or
  // pressing Enter) submits that ONE name immediately via
  // api.searchForProducts, same as before, just with no batching/staging in
  // between.
  const [draftInput, setDraftInput] = useState("");
  const [adding, setAdding] = useState(false);
  // Per explicit instruction — "if the ai already has prior knowledge on
  // the thing you are searching for, have it bring up an image from
  // Database... prompting the user with a popup asking if that's what
  // you're searching for": holds the name being added and whatever image is
  // being confirmed against while that popup is on screen, cleared either
  // way once the user answers. `product` is set only for a genuine Database
  // match (so its id can be linked on confirm); per further explicit
  // instruction ("ask the user 100% of the time... if it's something not
  // found in Database, pull a related image from google images"), this now
  // ALSO gets populated with no `product` but a web-sourced `imageUrl` when
  // there's no Database match at all — the popup shows either way, never
  // silently skipped.
  const [pendingMatch, setPendingMatch] = useState<{ name: string; product: ProductProfile | null; imageUrl: string | null } | null>(
    null
  );
  // Per explicit instruction — "they may want to have multiple products
  // with multiple different min/max prices... each time they set one of
  // those parameters should only apply to the product they're trying to
  // search before it's officially queued": once identity is confirmed
  // (pendingMatch above), this holds that name + linkedProductId while a
  // "Set a price range for ___?" prompt collects its own min/max — the item
  // only actually gets added to the Search For list (via addToSearchList)
  // once this step is answered either way, with whatever price range was
  // chosen baked in from the start, never added price-less and patched
  // after.
  const [pendingPrice, setPendingPrice] = useState<{ name: string; linkedProductId: string | null } | null>(null);
  const [priceMinDraft, setPriceMinDraft] = useState("");
  const [priceMaxDraft, setPriceMaxDraft] = useState("");
  // Per explicit instruction — "Search For = search for this now, Watch =
  // continue looking for this over time... provide an action such as
  // Watch so the user can turn something they're currently searching for
  // into a persistent Watch." Does NOT change Search For's own session-reset
  // behavior at all — this only READS the pill's current item/price range
  // to prefill a brand-new, independent Watch; the Search For entry itself
  // is untouched either way.
  const [watchPromoteTarget, setWatchPromoteTarget] = useState<SearchItem | null>(null);

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c);
      setRotateCountDraft(String(c.rotateSearchItemsCount));
    });
    const off = api.onConfigUpdated((next) => {
      setConfig(next);
      if (focusedField !== "rotateCount") setRotateCountDraft(String(next.rotateSearchItemsCount));
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusedField is read, not depended on, to avoid resubscribing on every focus change
  }, []);

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

  async function addToSearchList(
    name: string,
    linkedProductId: string | null,
    minPriceUsd: number | null,
    maxPriceUsd: number | null
  ) {
    if (!name || adding) return;
    setAdding(true);
    try {
      // Per explicit instruction — adding a product here only queues it on
      // the Search For list (shows up via config.searchItems once
      // onConfigUpdated lands); it no longer starts or restarts any
      // account's scanner or runs an immediate search itself (see index.ts's
      // add_search_item) — Start Scanning is the only thing that does that
      // now, same as any other change to what you're looking for.
      await api.searchForProducts([name], linkedProductId, minPriceUsd, maxPriceUsd);
    } finally {
      setAdding(false);
    }
  }

  // Per explicit instruction — "if the ai already has prior knowledge on
  // the thing you are searching for, have it bring up an image from
  // Database... prompting the user with a popup" + further explicit
  // instruction ("ask the user 100% of the time what they're searching
  // for... if it's something not found in Database, pull a related image
  // from google images"): checks for an existing Database entry first,
  // using the same fuzzy-match logic the scanner itself relies on (see
  // index.ts's products:findMatch) — if that finds one WITH a photo, the
  // popup confirms against it exactly like before. Otherwise (no match, or
  // a match with no photo), this now falls through to a fresh web-sourced
  // reference image (products:findReferenceImage — the same search+vision-
  // verification pass lookupProduct itself uses for a new Database entry's
  // photo) instead of silently adding — the popup always shows now, with
  // whatever photo (Database or web) it could find, or none at all if
  // neither turned anything up.
  async function handleAddClick() {
    const name = draftInput.trim();
    if (!name || adding) return;
    setDraftInput("");
    setAdding(true);
    try {
      const match = await api.findMatchingProduct(name).catch(() => null);
      if (match?.imageUrl) {
        setPendingMatch({ name, product: match, imageUrl: match.imageUrl });
        return;
      }
      const referenceImageUrl = await api.findReferenceImage(name).catch(() => null);
      setPendingMatch({ name, product: null, imageUrl: referenceImageUrl });
    } finally {
      setAdding(false);
    }
  }

  function confirmPendingMatch(confirmed: boolean) {
    if (!pendingMatch) return;
    const { name, product } = pendingMatch;
    setPendingMatch(null);
    // Per explicit instruction — price range is asked NEXT, before this
    // product is actually queued: "prompt the user with the min/max prices
    // after they add the product/hit enter... whatever the user sets have
    // that be applied to the product... before it's officially queued."
    setPriceMinDraft("");
    setPriceMaxDraft("");
    setPendingPrice({ name, linkedProductId: confirmed ? (product?.id ?? null) : null });
  }

  function submitPendingPrice() {
    if (!pendingPrice) return;
    const { name, linkedProductId } = pendingPrice;
    setPendingPrice(null);
    addToSearchList(name, linkedProductId, parsePriceDraft(priceMinDraft), parsePriceDraft(priceMaxDraft));
  }

  function skipPendingPrice() {
    if (!pendingPrice) return;
    const { name, linkedProductId } = pendingPrice;
    setPendingPrice(null);
    addToSearchList(name, linkedProductId, null, null);
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
            Nothing queued yet — add a product below, then hit Start Scanning to actually search for it.
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
                {formatPriceRangeLabel(s.minPriceUsd, s.maxPriceUsd) && (
                  <span style={{ color: "var(--text-dim)", fontWeight: 600, fontSize: 13 }}>
                    {formatPriceRangeLabel(s.minPriceUsd, s.maxPriceUsd)}
                  </span>
                )}
                <button
                  className="icon ghost"
                  title={`Turn "${s.item}" into a persistent Watch`}
                  onClick={() => setWatchPromoteTarget(s)}
                  style={{ padding: "0 4px", fontSize: 13, lineHeight: 1, color: "var(--text-dim)" }}
                >
                  👁
                </button>
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
                handleAddClick();
              }
            }}
            style={{ flex: 1, minWidth: 160 }}
          />
          <button type="button" className="primary" onClick={handleAddClick} disabled={!draftInput.trim() || adding}>
            {adding ? "Adding…" : "Add product"}
          </button>
        </div>
      </div>

      {pendingMatch && (
        <Modal title="Is this what you're searching for?" onClose={() => setPendingMatch(null)}>
          {pendingMatch.imageUrl ? (
            <img
              src={pendingMatch.imageUrl}
              alt={pendingMatch.product?.name ?? pendingMatch.name}
              style={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 10, background: "var(--bg-elevated)", display: "block" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: 160,
                borderRadius: 10,
                background: "var(--bg-elevated)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 40,
              }}
            >
              📦
            </div>
          )}
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            {pendingMatch.product ? (
              <>
                Already have "{pendingMatch.product.name}" in the Database. If this is it, matching gets a lot more
                precise — listings get compared against this exact photo, not just the title, so things like games
                or accessories that merely mention "{pendingMatch.name}" get filtered out.
              </>
            ) : pendingMatch.imageUrl ? (
              <>
                Nothing in the Database yet for "{pendingMatch.name}" — here's a reference photo pulled from the
                web. Confirm it looks right before the scanner starts hunting for it.
              </>
            ) : (
              <>
                Nothing in the Database yet for "{pendingMatch.name}", and couldn't find a reference photo either —
                just confirming before the scanner starts hunting for it.
              </>
            )}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => confirmPendingMatch(false)}>
              No, something else
            </button>
            <button className="primary" style={{ flex: 1 }} onClick={() => confirmPendingMatch(true)}>
              Yes, that's it
            </button>
          </div>
        </Modal>
      )}

      {/* Per explicit instruction — asked right after identity is
          confirmed, before the product is actually added to the Search For
          list: "each time they set one of those parameters should only
          apply to the product they're trying to search before it's
          officially queued." Closing this without an explicit choice
          (Escape, clicking outside) behaves the same as "Skip" — identity
          was already confirmed by this point, so the product still gets
          added, just with no price limit. */}
      {pendingPrice && (
        <Modal title={`Set a price range for "${pendingPrice.name}"?`} onClose={skipPendingPrice}>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.5 }}>
            Only want to see "{pendingPrice.name}" listings within a certain price? This applies to this product
            only — each product on your Search For list can have its own range.
          </p>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 13.5, color: "var(--text-muted)" }}>Min. Price</label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-dim)" }}>$</span>
                <input
                  type="number"
                  min={0}
                  placeholder="No minimum"
                  value={priceMinDraft}
                  onChange={(e) => setPriceMinDraft(e.target.value)}
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
                  value={priceMaxDraft}
                  onChange={(e) => setPriceMaxDraft(e.target.value)}
                  style={{ width: 110 }}
                />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={skipPendingPrice}>
              Skip — no price limit
            </button>
            <button className="primary" style={{ flex: 1 }} onClick={submitPendingPrice}>
              Set price
            </button>
          </div>
        </Modal>
      )}

      {watchPromoteTarget && (
        <WatchFormFlow
          initial={{
            searchPhrase: watchPromoteTarget.item,
            linkedProductId: watchPromoteTarget.linkedProductId ?? null,
            minPriceUsd: watchPromoteTarget.minPriceUsd,
            maxPriceUsd: watchPromoteTarget.maxPriceUsd,
          }}
          onClose={() => setWatchPromoteTarget(null)}
          onSaved={() => setWatchPromoteTarget(null)}
        />
      )}

      {config.searchItems.length > 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14.5,
              color: "var(--text)",
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
            {config.rotateSearchItems
              ? "Facebook can only search one product at a time — the scanner sticks with one item across however many locations it takes to evaluate that many listings, then moves to the next. Runs independently of location rotation."
              : "Unchecked: no dedicated search per item — the scanner browses generally and only evaluates listings that already look relevant to something above, moving on fast from locations with nothing of interest."}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
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
