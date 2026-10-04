import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ListingRecord, PhotoFlaw } from "../lib/api.js";
import { FlameIcon, SOURCE_COLORS, SOURCE_NAMES, SourceLogo, isHotListing } from "./ListingSourceMarks.js";
import { api } from "../lib/api.js";
import { Modal } from "./Modal.js";

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Per explicit instruction — Feed's own card should read like a simplified
// version of the actual Facebook listing, not the app's internal
// bookkeeping. locationText is scraped as "City, ST" (see scraper.ts); this
// keeps just the state, matching the requested "12 weeks old | VA" shape
// instead of the fuller "Fairfield, VA." Falls back to the whole string for
// any listing whose location text doesn't have a comma in it, rather than
// showing nothing.
function stateFromLocationText(locationText: string | null): string | null {
  if (!locationText) return null;
  const parts = locationText.split(",");
  return parts[parts.length - 1]?.trim() || null;
}

// Per explicit instruction — "1/10 of a star granularity" for the seller
// rating, in yellow. A plain row of 5 text stars can only ever step in
// whole-star (or, with extra markup, half-star) increments; overlaying a
// yellow copy on top of a dim one and clipping its width to the exact
// rating/5 percentage gives continuous granularity for free — a 4.7 fills
// the 5th star 70% of the way, not just "half" or "full."
function StarRating({ rating }: { rating: number }) {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  return (
    <span style={{ position: "relative", display: "inline-block", lineHeight: 1, fontSize: 13, letterSpacing: 1 }}>
      <span style={{ color: "var(--border-strong)" }}>★★★★★</span>
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${pct}%`,
          overflow: "hidden",
          whiteSpace: "nowrap",
          color: "var(--warn)",
        }}
      >
        ★★★★★
      </span>
    </span>
  );
}

// Every card in a given grid is still the same size as every other — per
// explicit instruction, just now that size is adjustable (see Feed.tsx's
// thumbnail-size slider) rather than fixed. The middle content block below
// scrolls internally if a particular listing has enough pills/description
// to not otherwise fit, and the action buttons live in their own fixed
// footer outside that scroll area so they're always visible without
// needing to scroll a card to find them. Ratios below preserve exactly
// today's proportions (620/260 height/image at the 300px default width);
// see cardWidth's own comment.
const DEFAULT_CARD_WIDTH = 300;
const DEFAULT_IMAGE_HEIGHT = 260;
const DEFAULT_CARD_HEIGHT = 620;
// Roughly 4 lines at this card's width/font-size — not exact (that's what
// the overflow check below is for), just the clamp height itself.
const DESCRIPTION_CLAMP_LINES = 4;

const carouselArrowStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(20,18,28,0.6)",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "white",
  fontSize: 19,
  lineHeight: 1,
};

export function ListingCard({
  record,
  onDelete,
  onGoToProduct,
  cardWidth = DEFAULT_CARD_WIDTH,
  delayMs = 0,
  justArrived = false,
}: {
  record: ListingRecord;
  onDelete?: () => void;
  // Per explicit instruction — Research (and Interested, which reuses the
  // same backend call) now takes the user straight to that product's own
  // Database page. Optional so this component doesn't strictly require
  // Feed's navigation wiring to render.
  onGoToProduct?: (productId: string) => void;
  // Per explicit instruction — driven by Feed's own thumbnail-size slider,
  // matching the grid's own minmax column width so the image/card scale
  // together with it rather than the image staying a fixed size inside a
  // resizing card.
  cardWidth?: number;
  delayMs?: number;
  // Per explicit instruction — "if it blacklists it in front of the user,
  // have an animation." True only for a listing that arrived WHILE the
  // user is actively watching Feed (see Feed.tsx's recentlyArrivedIds) —
  // that's the one case that gets to play the reveal; a blacklisted
  // listing loaded from history just renders in its already-resolved
  // (no photo) state with no animation replay.
  justArrived?: boolean;
}) {
  const imageHeight = Math.round(cardWidth * (DEFAULT_IMAGE_HEIGHT / DEFAULT_CARD_WIDTH));
  const cardHeight = imageHeight + (DEFAULT_CARD_HEIGHT - DEFAULT_IMAGE_HEIGHT);
  const [saving, setSaving] = useState(false);
  const [researching, setResearching] = useState(false);
  const [researchMsg, setResearchMsg] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descOverflows, setDescOverflows] = useState(false);
  const descRef = useRef<HTMLDivElement>(null);
  const [imgIndex, setImgIndex] = useState(0);
  const [showInterestedDialog, setShowInterestedDialog] = useState(false);
  const [showNotInterestedDialog, setShowNotInterestedDialog] = useState(false);
  const [showBlacklistDialog, setShowBlacklistDialog] = useState(false);
  const [showFlawDialog, setShowFlawDialog] = useState(false);
  const [flawSaving, setFlawSaving] = useState(false);

  // Every photo the scraper found on the listing page, falling back to just
  // the thumbnail if that's all there is (or nothing, for the placeholder
  // box below) — per explicit instruction, replaces the old small strip of
  // 44px thumbnails with an actual carousel through the main image itself.
  const images = record.imageUrls.length > 0 ? record.imageUrls : record.thumbnailUrl ? [record.thumbnailUrl] : [];
  const currentImage = images[imgIndex] ?? null;

  // Condition-awareness — vision.ts's photoNumber is 1-indexed (matches the
  // order it was shown the photos in, the same order as record.imageUrls/
  // images above), imgIndex is 0-indexed, hence the +1. Always [] unless
  // Config.researchCondition was on when this listing was analyzed.
  const currentFlaw: PhotoFlaw | null = record.photoFlaws.find((f) => f.photoNumber === imgIndex + 1) ?? null;

  async function submitFlawFeedback(confirmed: boolean) {
    if (!currentFlaw) return;
    setFlawSaving(true);
    try {
      await api.submitFlawFeedback({
        listingId: record.id,
        photoNumber: currentFlaw.photoNumber,
        description: currentFlaw.description,
        confidence: currentFlaw.confidence,
        confirmed,
        listingTitle: record.title,
      });
    } finally {
      setFlawSaving(false);
      setShowFlawDialog(false);
    }
  }

  // Per explicit instruction — a listing skipped for matching a blacklisted
  // term (see scrapeEngine.ts's evaluateListing, whose reasoning for this
  // exact case always reads "...title matches blacklisted term...") gets
  // its photo hidden rather than shown like an ordinary listing, since it
  // was never actually worth a look. A card that JUST arrived gets to play
  // that as a reveal (photo visible → "Blacklisted" stamps in → photo
  // fades away); one loaded from history renders already-resolved, no
  // animation.
  const isBlacklistedSkip = /\bblacklisted\b/i.test(record.reasoning);
  const [blacklistRevealing, setBlacklistRevealing] = useState(isBlacklistedSkip && justArrived);
  const [photoHidden, setPhotoHidden] = useState(isBlacklistedSkip && !justArrived);
  useEffect(() => {
    if (!(isBlacklistedSkip && justArrived)) return;
    const hideTimer = setTimeout(() => setPhotoHidden(true), 850);
    const settleTimer = setTimeout(() => setBlacklistRevealing(false), 1700);
    return () => {
      clearTimeout(hideTimer);
      clearTimeout(settleTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the initial justArrived/isBlacklistedSkip combination at mount should schedule this, not re-fire on every render
  }, []);

  function prevImage(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setImgIndex((i) => (i - 1 + images.length) % images.length);
  }
  function nextImage(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setImgIndex((i) => (i + 1) % images.length);
  }

  // Only decide whether the "show full description" toggle is worth
  // showing while the text is actually clamped — once expanded the box no
  // longer clips anything, so scrollHeight/clientHeight would trivially
  // match and (wrongly) make the toggle disappear before the user could
  // use it to collapse back. Skipping the re-check while expanded just
  // keeps whatever was already measured.
  useLayoutEffect(() => {
    if (descExpanded) return;
    const el = descRef.current;
    if (!el) return;
    setDescOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [record.description, descExpanded]);

  // The Database only ever gets a new entry when the user actually asks for
  // one — this button (and chat's research_product) are the only two ways
  // that happens now, since scanning stopped auto-adding every product it
  // came across. If this listing's product is already in the Database, the
  // same click just reinforces that entry with this listing's details
  // instead of creating a near-duplicate. Per explicit instruction, this
  // now takes the user straight there afterward — convenient for someone
  // who clicked Research specifically because they want to know more about
  // this product right away, not just quietly reinforce it in the
  // background (that's what Interested already does, without navigating —
  // it's the fast-triage action, this is the "show me now" one).
  async function research() {
    setResearching(true);
    setResearchMsg(null);
    try {
      const res = await api.researchListing(record.id);
      setResearchMsg(res.message);
      if (res.ok && res.productId) onGoToProduct?.(res.productId);
    } finally {
      setResearching(false);
    }
  }

  // Falls back through extractedAttributes → matched Search For item → raw
  // title — used as the default text/context offered in both reason
  // dialogs below (the user can edit or replace it before submitting) and
  // as the Blacklist button's term guess.
  const categoryGuess = record.extractedAttributes.trim() || record.matchedItem || record.title;

  // Per explicit instruction: clicking Interested now removes the listing
  // from the Feed (its job here is done) and adds it to the item's
  // corresponding Database entry — reinforcing one that already exists, or
  // creating a new one seeded with a real photo from this exact listing
  // (see index.ts's listings:research) — same underlying action as the
  // Research button, just triggered automatically instead of a separate
  // click. The reason typed into the dialog becomes both this listing's
  // feedback note and a note on the Database entry itself, so there's a
  // real record of why this specific listing was worth buying.
  async function submitInterested(reason: string) {
    setSaving(true);
    try {
      await api.setFeedback(record.id, "good", reason);
      await api.researchListing(record.id, reason);
      onDelete?.();
    } finally {
      setSaving(false);
      setShowInterestedDialog(false);
    }
  }

  // Per explicit instruction — "Not interested" no longer blacklists
  // anything (that's what the separate Blacklist button below is for). It's
  // meant to be a soft, reversible-in-spirit signal: "I probably won't want
  // this KIND of thing in the future," recorded as feedback the AI can
  // actually learn from (store.recordCategoryDismissal — 3+ dismissals of
  // the same category quietly pre-filters it out of future general-deal AI
  // calls) rather than a hard, permanent skip.
  async function submitNotInterested(reason: string) {
    setSaving(true);
    try {
      await api.setFeedback(record.id, "bad", reason);
      await api.notInterested(reason);
      onDelete?.();
    } finally {
      setSaving(false);
      setShowNotInterestedDialog(false);
    }
  }

  // The Blacklist button (separate from Not Interested) is the one place
  // left that still does the old hard, permanent skip — same term-guess
  // chain as above, shown back to the user in the confirmation so they see
  // exactly what they're committing to before it's irreversible-in-practice
  // (removing a blacklist term later requires going to the Database tab).
  async function confirmBlacklist(shouldBlacklist: boolean) {
    setSaving(true);
    try {
      // Per explicit instruction — "blacklist both the title and the image
      // if possible": this listing's own photo, when it has one, so future
      // visually-similar listings get caught by the Blacklisted Images
      // check too, not just by title text matching.
      if (shouldBlacklist) await api.addBlacklistTerm(categoryGuess, images[0] ?? null, record.title);
      onDelete?.();
    } finally {
      setSaving(false);
      setShowBlacklistDialog(false);
    }
  }

  // Per explicit instruction — no text badge overlaid on the thumbnail at
  // all anymore (the yellow "Possible deal (unverified)" one specifically
  // called out as clutter, generalized to drop the green "Deal" one too,
  // since both were the same overlay). record.isDeal still drives the
  // card's own flash-deal border/glow (see the className below), so a real
  // deal is still visually distinct — just not via text stamped on the photo.

  // Per explicit instruction: the generic "Seller risk" text badge is
  // replaced with a yellow clock icon specifically for the account-age
  // signal (the one objective, easy-to-explain-at-a-glance risk) — other
  // risk reasons no longer get a badge of their own. sellerRisk.ts's exact
  // wording for this check always starts with this phrase.
  const ageRisk = record.sellerRiskReasons.some((r) => r.startsWith("Facebook account is only"));
  // Per explicit instruction: a low-rating-based risk shouldn't display any
  // message for now (more specific handling to come) — filtered out here so
  // only account-age and any other non-rating reasons (e.g. no profile
  // photo) still show in the "potential risks" text below.
  const riskReasons = record.sellerRiskReasons.filter((r) => !/rating/i.test(r));

  // Per explicit instruction — "12 weeks old | VA," the listing's own age
  // and state on one line, same shape Facebook itself shows (just without
  // the city, and without this app's own "found N minutes ago" bookkeeping
  // mixed in alongside it).
  const ageStateLine = [record.listingAge, stateFromLocationText(record.locationText)].filter(Boolean).join(" | ") || null;

  // Per explicit instruction — the old "est. $X-Y (unverified)" text was the
  // general pathway's own AI guess, shown unconditionally even with nothing
  // real behind it. Now: nothing shows here at all unless there's REAL data
  // (the matched product's own average watchcount/eBay sold price — see
  // store.ts's enrichWithMatchedProductPricing) AND this exact listing's
  // price is within 10% of it, in which case it's worth calling out as a
  // strong match against real comps, not just a discount off a typical
  // list price.
  const avgSoldPriceUsd = record.matchedProductAvgSoldPriceUsd;
  const isNearAvgSoldPrice =
    avgSoldPriceUsd !== null && avgSoldPriceUsd > 0 && record.price !== null && Math.abs(record.price - avgSoldPriceUsd) / avgSoldPriceUsd <= 0.1;

  // Per explicit instruction — reported live with a screenshot: when a
  // seller marks a listing down, Facebook shows the current price right
  // next to the original in strikethrough — but plain text extraction
  // (see scraper.ts's description capture) loses that styling, so the two
  // numbers land back to back with nothing between them ("$600$700"),
  // showing up as a broken-looking blob in the description text. Pulled
  // out here into its own clean "$600 ~~$700~~" price-row treatment
  // instead, and stripped from the description so it doesn't ALSO show up
  // there raw. Math.min/max rather than trusting which one came first in
  // the text, so this is right even if a future Facebook layout reorders
  // them — "the lowest price the seller listed it at" is always the one
  // actually shown as record.price, never the crossed-out original.
  const priceDropMatch = record.description.match(/\$\s?([\d,]+)\s*\$\s?([\d,]+)/);
  const priceDropOriginal = priceDropMatch
    ? Math.max(parseInt(priceDropMatch[1].replace(/,/g, ""), 10), parseInt(priceDropMatch[2].replace(/,/g, ""), 10))
    : null;
  const originalPriceUsd = priceDropOriginal !== null && priceDropOriginal !== record.price ? priceDropOriginal : null;
  const cleanedDescription = priceDropMatch ? record.description.replace(priceDropMatch[0], "").trim() : record.description;

  // Per explicit instruction — same marks as the Dashboard's listings:
  // Facebook = blue outline + small Facebook logo, eBay = green outline +
  // small eBay logo, and a really good listing also gets an orange flame and
  // a glow. The glow lives on a wrapper rather than the card itself so its
  // infinite pulse can't replace the card's own entrance animation.
  const hot = isHotListing(record);
  const sourceColor = SOURCE_COLORS[record.source];

  return (
    <div className={hot ? "listing-hot" : undefined} style={{ borderRadius: "var(--radius-lg)" }}>
    <div
      className={`card enter ${record.isDeal ? "flash-deal" : ""}`}
      style={{
        height: cardHeight,
        display: "flex",
        flexDirection: "column",
        padding: 0,
        overflow: "hidden",
        animationDelay: `${delayMs}ms`,
        border: `2px solid ${sourceColor}`,
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          title={SOURCE_NAMES[record.source]}
          style={{ position: "absolute", top: 8, left: 8, zIndex: 2, display: "flex", alignItems: "center", gap: 5, pointerEvents: "none" }}
        >
          <SourceLogo source={record.source} size={20} />
          {hot && <FlameIcon size={24} />}
        </div>
        {/* Per explicit instruction, this stays a real link to the actual
            Facebook listing on click — the one deliberate exception to
            "every image opens a zoomed-in view" (see ImageLightbox.tsx),
            since jumping straight to the source listing is more useful
            here than a larger look at a photo the carousel already shows
            clearly. */}
        <a href={record.url} target="_blank" rel="noreferrer">
          {isBlacklistedSkip ? (
            // Per explicit instruction — "if it blacklists it in front of
            // the user, have an animation that says 'Blacklisted' and make
            // the photo disappear." A fresh arrival shows the photo
            // briefly, stamps "Blacklisted" over it, then fades the photo
            // away entirely; one loaded from history renders already in
            // that resolved (no-photo) state.
            <div style={{ position: "relative", width: "100%", height: imageHeight, background: "var(--bg-elevated)" }}>
              {currentImage && (
                <img
                  src={currentImage}
                  alt=""
                  loading="lazy"
                  className="tile-image"
                  style={{
                    width: "100%",
                    height: imageHeight,
                    objectFit: "cover",
                    display: "block",
                    transition: "opacity 0.7s ease, filter 0.7s ease",
                    opacity: photoHidden ? 0 : 1,
                    filter: photoHidden ? "grayscale(1)" : "none",
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.visibility = "hidden";
                  }}
                />
              )}
              {photoHidden && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    color: "var(--text-dim)",
                  }}
                >
                  🚫 Blacklisted
                </div>
              )}
              {blacklistRevealing && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                  <span
                    style={{
                      fontSize: 17,
                      fontWeight: 800,
                      letterSpacing: 0.3,
                      color: "var(--danger)",
                      textShadow: "0 0 16px rgba(248,113,113,0.7)",
                      animation: "blacklistStamp 1.7s ease forwards",
                    }}
                  >
                    🚫 Blacklisted
                  </span>
                </div>
              )}
            </div>
          ) : currentImage ? (
            <img
              src={currentImage}
              alt=""
              loading="lazy"
              className="tile-image"
              style={{ width: "100%", height: imageHeight, objectFit: "cover", display: "block", background: "var(--bg-elevated)" }}
              onError={(e) => {
                (e.currentTarget.parentElement as HTMLElement).style.display = "none";
              }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: imageHeight,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg-elevated)",
                fontSize: 40,
                color: "var(--text-dim)",
              }}
            >
              📦
            </div>
          )}
        </a>
        {ageRisk && (
          <span
            title="Facebook account is under a year old"
            style={{
              position: "absolute",
              bottom: 10,
              left: 10,
              width: 26,
              height: 26,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(20,18,28,0.72)",
              border: `1px solid var(--warn)`,
              fontSize: 14,
            }}
          >
            🕐
          </span>
        )}
        {currentFlaw && (
          <>
            {/* Pure visual overlay, not a click target — the "?" badge below
                is what's actually clickable. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                border: "2px solid var(--warn)",
                borderRadius: "inherit",
                pointerEvents: "none",
              }}
            />
            <button
              title="Possible condition flaw — click to confirm or deny"
              // Per explicit instruction — same interception prevImage/
              // nextImage already use, needed here for the same reason:
              // stop the surrounding <a href={record.url}> from navigating
              // to Facebook when this badge itself is what's clicked.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShowFlawDialog(true);
              }}
              style={{
                position: "absolute",
                bottom: 10,
                right: 10,
                width: 26,
                height: 26,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(20,18,28,0.72)",
                border: `1px solid var(--warn)`,
                color: "var(--warn)",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                padding: 0,
              }}
            >
              ?
            </button>
          </>
        )}
        {onDelete && (
          <button
            className="icon ghost"
            title="Remove from feed"
            onClick={onDelete}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 32,
              height: 32,
              padding: 0,
              fontSize: 16,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(20,18,28,0.72)",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "white",
            }}
          >
            ×
          </button>
        )}
        {images.length > 1 && (
          <>
            <button
              className="icon ghost"
              title="Previous photo"
              onClick={prevImage}
              style={{ ...carouselArrowStyle, left: 8 }}
            >
              ‹
            </button>
            <button
              className="icon ghost"
              title="Next photo"
              onClick={nextImage}
              style={{ ...carouselArrowStyle, right: 8 }}
            >
              ›
            </button>
            <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 4 }}>
              {images.map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: i === imgIndex ? "white" : "rgba(255,255,255,0.4)",
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div>
          <a
            href={record.url}
            target="_blank"
            rel="noreferrer"
            style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.35, color: "var(--text)", textDecoration: "none", display: "block" }}
          >
            {record.title}
          </a>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>${record.price ?? "?"}</div>
          {originalPriceUsd !== null && (
            <div style={{ fontSize: 15, color: "var(--text-dim)", textDecoration: "line-through" }}>${originalPriceUsd}</div>
          )}
          {record.discountPercent !== null && (
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--success)" }}>
              {record.discountPercent.toFixed(0)}% under ${record.referencePriceUsd}
            </div>
          )}
          {isNearAvgSoldPrice && (
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--success)" }}>
              🔥 within 10% of ${avgSoldPriceUsd?.toFixed(0)} avg. sale price
            </div>
          )}
        </div>

        {/* Per explicit instruction — "12 weeks old | VA," the same shape
            Facebook's own listing page shows just above Seller information,
            not this app's own "found N minutes ago" bookkeeping (still
            available on hover for anyone who wants it). */}
        {ageStateLine && (
          <div title={`Found by the scanner ${timeAgo(record.firstSeenAt)}`} style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {ageStateLine}
          </div>
        )}
        {/* Per explicit instruction — multiple Facebook accounts: which
            login actually has this listing open, so the user knows which
            account to act from (message the seller, etc.) rather than
            guessing. Null for anything found before multi-account existed. */}
        {record.foundByAccountLabel && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>via {record.foundByAccountLabel}</div>
        )}

        {record.matchedItem && (
          <span className="pill" style={{ alignSelf: "flex-start" }}>
            {record.matchedItem}
          </span>
        )}

        {/* The seller's own listing text, in place of the AI's reasoning —
            per explicit instruction, more directly useful for judging a
            listing yourself than the AI's summary of why it scored it a
            certain way. Clamped by default so one long-winded listing
            doesn't blow past the others' height; "Show full description"
            only appears when the text actually needs it. */}
        <div>
          <div
            ref={descRef}
            style={{
              fontSize: 13.5,
              color: "var(--text)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              display: descExpanded ? "block" : "-webkit-box",
              WebkitLineClamp: descExpanded ? undefined : DESCRIPTION_CLAMP_LINES,
              WebkitBoxOrient: descExpanded ? undefined : "vertical",
              overflow: descExpanded ? "visible" : "hidden",
            }}
          >
            {cleanedDescription.trim() ||
              // Per explicit instruction — an instant-skip record (a car,
              // an unrelated item, anything scrapeEngine.ts's
              // recordInstantSkip catches before ever opening the detail
              // page) has no real description to show at all; its own
              // skip reasoning is far more useful here than a flat "no
              // description" dead end.
              (record.reasoning ? `Skipped — ${record.reasoning.replace(/^Skipped( without opening the listing)? — /i, "")}` : "(No description on the listing.)")}
          </div>
          {descOverflows && (
            <button
              className="icon ghost"
              onClick={() => setDescExpanded((v) => !v)}
              style={{ fontSize: 11, padding: "2px 4px", marginTop: 2, color: "var(--text-muted)" }}
            >
              {descExpanded ? "▴ Show less" : "▾ Show full description"}
            </button>
          )}
        </div>

        {/* Per explicit instruction — seller rating and "joined Facebook"
            as their own two lines, the same order/shape as Facebook's own
            "Seller information" section on the listing page. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)" }}>
            {record.sellerName && <span>{record.sellerName}</span>}
            {record.sellerRating !== null ? (
              <>
                <StarRating rating={record.sellerRating} />
                <span>
                  {record.sellerRating.toFixed(1)}
                  {record.sellerRatingCount !== null ? ` (${record.sellerRatingCount})` : ""}
                </span>
              </>
            ) : (
              <span>no seller rating available</span>
            )}
          </div>
          {record.sellerJoinedYear !== null && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Joined Facebook in {record.sellerJoinedYear}</div>
          )}
        </div>

        {record.extractedAttributes && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Notes: {record.extractedAttributes}</div>
        )}
        {!record.sellerRiskPassed && riskReasons.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--warn)" }}>{riskReasons.join("; ")}</div>
        )}

        {researchMsg && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{researchMsg}</div>}
      </div>

      {/* Fixed footer, outside the scrollable content area above, so the
          action buttons are always reachable without needing to scroll a
          particular card to find them. A 2x2 CSS grid rather than a flex
          row — per explicit instruction that Interested must match the
          other buttons' size, a grid guarantees every button in a column is
          exactly as wide as the one above/below it, which a flex row with
          differing label lengths doesn't reliably give you. */}
      <div style={{ flexShrink: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: 12 }}>
        <button
          className="icon"
          disabled={saving}
          onClick={() => setShowInterestedDialog(true)}
          style={{
            width: "100%",
            textAlign: "center",
            borderColor: "var(--success)",
            color: "var(--success)",
          }}
        >
          Interested
        </button>
        <button
          className="icon"
          disabled={saving}
          onClick={() => setShowNotInterestedDialog(true)}
          style={{
            width: "100%",
            textAlign: "center",
            borderColor: "var(--danger)",
            color: "var(--danger)",
          }}
        >
          Not interested
        </button>
        <button
          className="icon"
          disabled={saving}
          onClick={() => setShowBlacklistDialog(true)}
          style={{
            width: "100%",
            textAlign: "center",
            borderColor: "var(--danger)",
            color: "var(--danger)",
            background: "rgba(248, 113, 113, 0.08)",
          }}
        >
          🚫 Blacklist
        </button>
        <button className="icon" disabled={researching} onClick={research} style={{ width: "100%", textAlign: "center" }}>
          {researching ? "Working..." : "🔎 Research"}
        </button>
      </div>

      {showInterestedDialog && (
        <ReasonDialog
          title="What made you interested?"
          helperText={`This gets added to "${categoryGuess}"'s Database entry — real context for why this specific listing was worth buying, not just a price number.`}
          quickReasons={[
            "Great price for what it is",
            "Condition/photos looked good",
            `Exactly the "${categoryGuess}" I've been looking for`,
          ]}
          onSubmit={submitInterested}
          onCancel={() => setShowInterestedDialog(false)}
        />
      )}
      {showNotInterestedDialog && (
        <ReasonDialog
          title="Why aren't you interested?"
          helperText="This helps the AI show you less of this in the future — it won't blacklist anything, so a genuinely great deal like this can still slip through later."
          quickReasons={[
            `Not interested in "${categoryGuess}" in general`,
            "Wrong item — doesn't match what I'm looking for",
            "Price or condition wasn't good enough",
          ]}
          onSubmit={submitNotInterested}
          onCancel={() => setShowNotInterestedDialog(false)}
        />
      )}
      {showBlacklistDialog && (
        <Modal title="Blacklist this item?" onClose={() => setShowBlacklistDialog(false)}>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
            Are you sure you want to blacklist "{categoryGuess}"? Similar listings will be skipped automatically from now on.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} disabled={saving} onClick={() => confirmBlacklist(false)}>
              No
            </button>
            <button className="danger-solid" style={{ flex: 1 }} disabled={saving} onClick={() => confirmBlacklist(true)}>
              Yes, blacklist
            </button>
          </div>
        </Modal>
      )}
      {showFlawDialog && currentFlaw && (
        <Modal title="Does this photo show a damaged item?" onClose={() => setShowFlawDialog(false)}>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>Clynx flagged this: "{currentFlaw.description}"</p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
            Your answer helps Clynx get better at recognizing real flaws over time.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="icon" style={{ flex: 1 }} disabled={flawSaving} onClick={() => submitFlawFeedback(false)}>
              No, looks fine
            </button>
            <button className="primary" style={{ flex: 1 }} disabled={flawSaving} onClick={() => submitFlawFeedback(true)}>
              Yes, that's damage
            </button>
          </div>
        </Modal>
      )}
    </div>
    </div>
  );
}

// Shared by both the Interested and Not Interested flows — per explicit
// instruction, Interested now prompts for a reason "just like the Not
// Interested button" instead of the two diverging. Replaces the old
// "blacklist this category?" window.confirm with an actual question about
// WHY, whose answer actually trains the AI (see submitInterested/
// submitNotInterested above) instead of just being a yes/no. Quick-pick
// reasons cover the common cases in one click; the text field is there for
// anything more specific. Cancel (the × / backdrop click) leaves the
// listing untouched — this should never fire on an accidental click the
// way the old window.confirm effectively did (it acted no matter which
// button you picked).
function ReasonDialog({
  title,
  helperText,
  quickReasons,
  onSubmit,
  onCancel,
}: {
  title: string;
  helperText: string;
  quickReasons: string[];
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [customReason, setCustomReason] = useState("");

  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{helperText}</p>
      {quickReasons.map((reason) => (
        <button key={reason} className="icon ghost" style={{ textAlign: "left", border: "1px solid var(--border)" }} onClick={() => onSubmit(reason)}>
          {reason}
        </button>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={customReason}
          onChange={(e) => setCustomReason(e.target.value)}
          placeholder="Or type your own reason..."
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && customReason.trim()) onSubmit(customReason.trim());
          }}
        />
        <button className="primary" disabled={!customReason.trim()} onClick={() => onSubmit(customReason.trim())}>
          Submit
        </button>
      </div>
    </Modal>
  );
}
