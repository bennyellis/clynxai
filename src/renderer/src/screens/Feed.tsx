import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ListingRecord } from "../lib/api.js";
import { ListingCard, listingCardHeight } from "../components/ListingCard.js";
import { Modal } from "../components/Modal.js";
import { ThumbnailSizeSlider, useThumbnailSize } from "../components/ThumbnailSize.js";
import { api } from "../lib/api.js";

type Filter = "all" | "deals" | "watch";
const FILTER_LABELS: Record<Filter, string> = { all: "all", deals: "deals", watch: "Watch finds" };
type SourceFilter = "all" | "facebook" | "ebay";
const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = { all: "All sources", facebook: "Facebook", ebay: "eBay" };

// The Feed is a "treadmill": only the cards on (or just off) the screen exist as page elements.
// Every card has the same height, so where each one belongs is plain arithmetic: the list is one tall,
// empty scroll area, and the few rows currently in view are placed at their position inside it.
// Cards that scroll out are dropped and rebuilt when they scroll back, so what the page has to hold
// (elements, decoded photos, memory) stays the same whether there are 20 listings or 500.
const GRID_GAP = 16;
// Rows kept mounted above and below the visible ones, so fast scrolling doesn't show gaps.
const OVERSCAN_ROWS = 2;

export function Feed({
  active,
  listings,
  onRefresh,
  onGoToProduct,
}: {
  // False while another screen is showing. Every screen stays mounted (just
  // hidden) so state survives tab switches, but a hidden Feed has no reason
  // to render or re-render hundreds of cards on every incoming listing.
  active: boolean;
  listings: ListingRecord[];
  onRefresh: () => void;
  // Per explicit instruction — the Research button takes the user straight
  // to that product's own Database page instead of leaving them on Feed.
  onGoToProduct: (productId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  // Per explicit instruction — see only Facebook listings, only eBay ones,
  // or both. Combines with the All/Deals filter and the search box.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [clearing, setClearing] = useState(false);
  // Per explicit instruction — popups should match the app's own theme, not
  // the browser's native window.confirm.
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);
  // Per explicit instruction — a way to find a specific listing the AI
  // already evaluated but the user scrolled past, since the grid below can
  // grow to hold a lot of them.
  const [searchQuery, setSearchQuery] = useState("");
  // Per explicit instruction — small → extra large card size, remembered
  // per this grid. 300 matches the card's original fixed minimum width, so
  // an existing user's layout doesn't visibly change until they move it.
  const [cardSize, setCardSize] = useThumbnailSize("feedCardSize", 300);

  // Per explicit instruction — "add everything that the ai is spotting" to
  // Feed, live, even something instantly skipped/blacklisted before ever
  // being scored (a car, an unrelated item, a blacklisted term match). This
  // used to be filtered out entirely as clutter — reversed now, per
  // explicit request, in favor of watching the scanner actually work.
  // "All" vs "Deals" (and the search box) stay exactly as they were.
  const filtered = useMemo(() => {
    let result = filter === "deals" ? listings.filter((l) => l.isDeal) : filter === "watch" ? listings.filter((l) => l.watchNames.length > 0) : listings;
    if (sourceFilter !== "all") result = result.filter((l) => l.source === sourceFilter);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (l) => l.title.toLowerCase().includes(q) || (l.matchedItem ?? "").toLowerCase().includes(q) || l.extractedAttributes.toLowerCase().includes(q)
      );
    }
    return result;
  }, [listings, filter, sourceFilter, searchQuery]);

  // A different filter/search is a different list — start from the top of it.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filter, sourceFilter, searchQuery]);

  // Which rows are on screen. Re-measured on scroll (once per frame at most) and whenever the window,
  // the card size or the list changes; the state only changes when the set of rows to mount does, so
  // scrolling within a row re-renders nothing.
  const cardHeight = listingCardHeight(cardSize);
  const rowHeight = cardHeight + GRID_GAP;
  const contentRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ cols: 1, firstRow: 0, lastRow: -1 });
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || scroller.clientHeight === 0) return; // hidden (another screen is showing)
    const cols = Math.max(1, Math.floor((content.clientWidth + GRID_GAP) / (cardSize + GRID_GAP)));
    const firstRow = Math.max(0, Math.floor(scroller.scrollTop / rowHeight) - OVERSCAN_ROWS);
    const lastRow = Math.floor((scroller.scrollTop + scroller.clientHeight) / rowHeight) + OVERSCAN_ROWS;
    setLayout((prev) => (prev.cols === cols && prev.firstRow === firstRow && prev.lastRow === lastRow ? prev : { cols, firstRow, lastRow }));
  }, [cardSize, rowHeight]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!active || !scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(scroller);
    measure();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active, measure, filtered.length]);

  const { cols, firstRow, lastRow } = layout;
  const totalRows = Math.ceil(filtered.length / cols);
  const startIndex = firstRow * cols;
  const shown = useMemo(
    () => (active ? filtered.slice(startIndex, Math.max(startIndex, (lastRow + 1) * cols)) : []),
    [active, filtered, startIndex, lastRow, cols]
  );

  // Per explicit instruction — a listing that arrives WHILE the user is
  // watching Feed gets to play its "reveal" (see ListingCard's Blacklisted
  // animation); one that was already here from before a page open/refresh
  // just renders in its final state immediately, no replay. Tracks ids
  // already seen via a ref (not state) so this never itself triggers a
  // re-render — only new arrivals get added to the recentlyArrived state,
  // and each ages out a few seconds later on its own.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [recentlyArrivedIds, setRecentlyArrivedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const freshlySeen = seenIdsRef.current.size > 0;
    const newIds = listings.map((l) => l.id).filter((id) => !seenIdsRef.current.has(id));
    for (const l of listings) seenIdsRef.current.add(l.id);
    if (!freshlySeen || newIds.length === 0) return; // first mount: nothing "just arrived", everything is history
    setRecentlyArrivedIds((prev) => new Set([...prev, ...newIds]));
    const timer = setTimeout(() => {
      setRecentlyArrivedIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [listings]);

  const handleDelete = useCallback(
    async (id: string) => {
      await api.deleteListing(id);
      onRefresh();
    },
    [onRefresh]
  );

  async function handleClearAll() {
    setShowClearAllDialog(false);
    setClearing(true);
    try {
      await api.clearAllListings();
      onRefresh();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Feed</h1>
          <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>Deals and flagged listings, most recent first.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search listings by title or product..."
            style={{ width: 240 }}
          />
          <ThumbnailSizeSlider value={cardSize} onChange={setCardSize} min={220} max={480} step={20} />
          {(["all", "deals", "watch"] as Filter[]).map((f) => (
            <button
              key={f}
              className={filter === f ? "seg on" : "seg"}
              onClick={() => setFilter(f)}
              style={{ textTransform: "capitalize" }}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
          <div style={{ display: "flex", gap: 8, paddingLeft: 12, marginLeft: 4, borderLeft: "1px solid var(--border-strong)" }}>
            {(["all", "facebook", "ebay"] as SourceFilter[]).map((src) => (
              <button key={src} className={sourceFilter === src ? "seg on" : "seg"} onClick={() => setSourceFilter(src)}>
                {SOURCE_FILTER_LABELS[src]}
              </button>
            ))}
          </div>
          <button className="danger" disabled={clearing || !listings.length} onClick={() => setShowClearAllDialog(true)}>
            {clearing ? "Clearing..." : "Clear all"}
          </button>
        </div>
      </div>

      {showClearAllDialog && (
        <Modal title="Clear the whole Feed?" onClose={() => setShowClearAllDialog(false)}>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
            Delete all {listings.length} listing{listings.length === 1 ? "" : "s"} from the Feed? This can't be undone.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} onClick={() => setShowClearAllDialog(false)}>
              Cancel
            </button>
            <button className="danger-solid" style={{ flex: 1 }} onClick={handleClearAll}>
              Delete all
            </button>
          </div>
        </Modal>
      )}

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", paddingRight: 4, paddingBottom: 64 }}>
        {filtered.length === 0 && (
          <div className="card" style={{ color: "var(--text-dim)" }}>
            {searchQuery.trim()
              ? `No listings match "${searchQuery.trim()}".`
              : sourceFilter !== "all"
                ? `No ${SOURCE_FILTER_LABELS[sourceFilter]} listings here yet.`
                : "Nothing here yet."}
          </div>
        )}
        {/* One tall, empty area the size of the whole list; only the rows in view are placed inside it. */}
        <div ref={contentRef} style={{ position: "relative", height: totalRows > 0 ? totalRows * rowHeight - GRID_GAP : 0 }}>
          <div
            style={{
              position: "absolute",
              top: firstRow * rowHeight,
              left: 0,
              right: 0,
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: GRID_GAP,
            }}
          >
            {shown.map((record) => (
              <ListingCard
                key={record.id}
                record={record}
                onDelete={handleDelete}
                onGoToProduct={onGoToProduct}
                cardWidth={cardSize}
                animate={recentlyArrivedIds.has(record.id)}
                justArrived={recentlyArrivedIds.has(record.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
