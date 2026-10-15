import React, { useEffect, useState } from "react";
import type { ListingRecord, PhotoFlaw } from "../lib/api.js";
import { FlameIcon, HotRing, OUTLINE_WIDTH_PX, SOURCE_NAMES, SourceLogo, isHotListing, listingOutlineColor } from "./ListingSourceMarks.js";
import { api } from "../lib/api.js";
import { Modal } from "./Modal.js";
import { describeDealNumbers } from "../lib/dealNumbers.js";

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
// Taller than before (was 490) to make room for the resale / profit lines under the verdict chip.
const DEFAULT_CARD_HEIGHT = 576;

/** A card's height for a given card width (the Feed's size slider), so the Feed can lay cards out without rendering them. */
export function listingCardHeight(cardWidth: number): number {
  return Math.round(cardWidth * (DEFAULT_IMAGE_HEIGHT / DEFAULT_CARD_WIDTH)) + (DEFAULT_CARD_HEIGHT - DEFAULT_IMAGE_HEIGHT);
}

// The Feed only keeps the cards near the screen mounted (see Feed.tsx), so a card is rebuilt each
// time it scrolls back into view. Which photo of the carousel the user was on is remembered here by
// listing id, so a rebuilt card looks exactly as it was left. Capped, oldest forgotten first.
const cardPhotoIndex = new Map<string, number>();
const CARD_UI_STATE_LIMIT = 1500;

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

// The small labels over a card's photo (Watch find, Just listed): readable on any photo.
const CARD_PILL: React.CSSProperties = {
  background: "rgba(15, 11, 30, 0.82)",
  color: "#fff",
  borderColor: "rgba(255, 255, 255, 0.35)",
  fontSize: 11.5,
  fontWeight: 600,
  padding: "3px 8px",
  whiteSpace: "nowrap",
};

function ListingCardImpl({
  record,
  onDelete,
  onGoToProduct,
  cardWidth = DEFAULT_CARD_WIDTH,
  delayMs = 0,
  justArrived = false,
  animate = true,
}: {
  record: ListingRecord;
  onDelete?: (id: string) => void;
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
  // Play the card's fade-in. The Feed turns this off for cards that are only being scrolled into
  // view (they would otherwise fade in again every time), leaving it on for new arrivals.
  animate?: boolean;
}) {
  const imageHeight = Math.round(cardWidth * (DEFAULT_IMAGE_HEIGHT / DEFAULT_CARD_WIDTH));
  const cardHeight = imageHeight + (DEFAULT_CARD_HEIGHT - DEFAULT_IMAGE_HEIGHT);
  const [saving, setSaving] = useState(false);
  const [researching, setResearching] = useState(false);
  const [researchMsg, setResearchMsg] = useState<string | null>(null);
  const [imgIndex, setImgIndex] = useState(() => cardPhotoIndex.get(record.id) ?? 0);
  useEffect(() => {
    cardPhotoIndex.delete(record.id); // re-insert so the most recently touched is last
    if (imgIndex === 0) return;
    cardPhotoIndex.set(record.id, imgIndex);
    if (cardPhotoIndex.size > CARD_UI_STATE_LIMIT) cardPhotoIndex.delete(cardPhotoIndex.keys().next().value as string);
  }, [record.id, imgIndex]);
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
  async function submitInterested(reason: string, goToProduct = false) {
    setSaving(true);
    setResearching(goToProduct);
    setResearchMsg(null);
    try {
      await api.setFeedback(record.id, "good", reason);
      const res = await api.researchListing(record.id, reason || undefined);
      // Research from the Interested dialog also takes the user to that product's Database page; if it
      // couldn't be researched, stay put and say why instead of silently dropping the listing.
      if (goToProduct && !res.ok) {
        setResearchMsg(res.message);
        return;
      }
      onDelete?.(record.id);
      if (goToProduct && res.productId) onGoToProduct?.(res.productId);
      setShowInterestedDialog(false);
    } finally {
      setSaving(false);
      setResearching(false);
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
      onDelete?.(record.id);
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
      onDelete?.(record.id);
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

  // The yellow clock on the photo: the one objective seller-risk signal worth a glance (account age).
  const ageRisk = record.sellerRiskReasons.some((r) => r.startsWith("Facebook account is only"));

  // A seller's mark-down shows as "$600$700" in the scraped text (current price, then the crossed-out
  // original, with the strikethrough lost), so the original is pulled out of the description for the price row.
  const priceDropMatch = record.description.match(/\$\s?([\d,]+)\s*\$\s?([\d,]+)/);
  const priceDropOriginal = priceDropMatch
    ? Math.max(parseInt(priceDropMatch[1].replace(/,/g, ""), 10), parseInt(priceDropMatch[2].replace(/,/g, ""), 10))
    : null;
  const originalPriceUsd = priceDropOriginal !== null && priceDropOriginal !== record.price ? priceDropOriginal : null;

  // eBay shows the item price plus what the seller charges to ship it; Facebook is just the price.
  const shippingUsd = record.source === "ebay" ? record.shippingCostUsd : null;
  const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

  // Facebook sellers are rated in stars, eBay sellers in percent positive feedback.
  const sellerRatingLine =
    record.source === "facebook" && record.sellerRating !== null ? (
      <>
        <StarRating rating={record.sellerRating} />
        <span>
          {record.sellerRating.toFixed(1)}
          {record.sellerRatingCount !== null ? ` (${record.sellerRatingCount})` : ""}
        </span>
      </>
    ) : record.source === "ebay" && record.sellerFeedbackPercent != null ? (
      <span>{record.sellerFeedbackPercent.toFixed(1)}% positive</span>
    ) : null;
  // The Deal Quality Gate's saved decision, so the card says what Clynx decided and why. Only for listings that were actually
  // gated (older ones have no verdict and look as before). A negotiation opportunity shows the discount the seller must give.
  const verdictChip =
    record.dealStatus === "profitable_now"
      ? { label: "Deal", color: "var(--success)", detail: record.gateHeadline ?? "Profitable at the asking price" }
      : record.dealStatus === "negotiation"
        ? {
            label: "Negotiate",
            color: "var(--warn)",
            detail:
              record.requiredDiscountPercent !== null
                ? `Needs ${record.requiredDiscountPercent}% off${record.targetPriceUsd !== null ? ` · offer ~$${Math.round(record.targetPriceUsd)}` : ""}`
                : (record.gateHeadline ?? "A deal if the seller comes down"),
          }
        : record.dealStatus === "worth_a_look"
          ? { label: "Worth a look", color: "var(--accent-3-text)", detail: record.gateHeadline ?? "Interesting, not fully verified" }
          : null;

  // Database discovery: a listing that is not a deal says where it stands, so "Clynx never looked at it" and "Clynx looked and it is not
  // worth it" do not look alike. Only for the listings that have no verdict chip above (a deal, a negotiation or a worth-a-look says it all).
  const researchNote =
    !verdictChip && record.researchStatus && record.researchStatus !== "researched"
      ? {
          label:
            record.researchStatus === "unresearched"
              ? "Not researched"
              : record.researchStatus === "insufficient_evidence"
                ? "Not enough evidence"
                : record.researchStatus === "confirmed_unprofitable"
                  ? "Not profitable"
                  : "Rejected",
          color: record.researchStatus === "confirmed_unprofitable" || record.researchStatus === "rejected" ? "var(--text-dim)" : "var(--warn)",
          detail: record.researchReason ?? "",
        }
      : null;

  // The money, from the numbers the gate saved with its verdict (null for listings that were never gated).
  const dealNumbers = describeDealNumbers(record);

  // Facebook shows where the item is; eBay doesn't (it ships).
  const locationLine = record.source === "facebook" ? record.locationText : null;
  const ageLocationLine = [record.listingAge, locationLine].filter(Boolean).join(" · ") || null;

  // Per explicit instruction — same marks as the Dashboard's listings:
  // Facebook = blue outline + small Facebook logo, eBay = green outline +
  // small eBay logo, and a really good listing also gets an orange flame and
  // a glow. The glow lives on a wrapper rather than the card itself so its
  // infinite pulse can't replace the card's own entrance animation.
  // The outline is the source color (blue/green) unless Clynx judged the
  // listing not of interest (red) or isn't sure about it (yellow) — see
  // listingVerdict in ListingSourceMarks.tsx.
  const hot = isHotListing(record);
  const outlineColor = listingOutlineColor(record);

  return (
    <div className={hot ? "listing-hot" : undefined} style={{ borderRadius: "var(--radius-lg)" }}>
    {hot && <HotRing color={outlineColor} />}
    <div
      className={`card${animate ? " enter" : ""} ${record.isDeal ? "flash-deal" : ""}`}
      style={{
        height: cardHeight,
        // A card that is scrolled off-screen skips layout and painting until it nears the
        // viewport (it keeps its height, so the scroll bar doesn't jump).
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${cardHeight}px`,
        display: "flex",
        flexDirection: "column",
        padding: 0,
        overflow: "hidden",
        animationDelay: `${delayMs}ms`,
        // A hot card's border is transparent so its HotRing shows through.
        border: `${OUTLINE_WIDTH_PX}px solid ${hot ? "transparent" : outlineColor}`,
        backgroundClip: hot ? "padding-box" : undefined,
        // A hot card's HotRing shimmers underneath it, so its fill stays solid.
        backgroundColor: hot ? "var(--bg-card)" : undefined,
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          title={SOURCE_NAMES[record.source]}
          style={{ position: "absolute", top: 8, left: 8, zIndex: 2, display: "flex", alignItems: "center", gap: 5, pointerEvents: "none" }}
        >
          <SourceLogo source={record.source} size={20} />
          {hot && <FlameIcon size={24} />}
          {/* A listing a Watch found, and Facebook's own "Just listed" badge. */}
          {record.watchNames.length > 0 && (
            <span className="pill" title={`Found by Watch: ${record.watchNames.join(", ")}`} style={CARD_PILL}>
              👁 Watch
            </span>
          )}
          {record.justListed && (
            <span className="pill" style={CARD_PILL}>
              Just listed
            </span>
          )}
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
              decoding="async"
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
            onClick={() => onDelete(record.id)}
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

      <div style={{ padding: "12px 14px 0", display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 0, overflow: "hidden" }}>
        <a
          href={record.url}
          target="_blank"
          rel="noreferrer"
          title={record.title}
          style={{
            fontWeight: 700,
            fontSize: 15,
            lineHeight: 1.35,
            color: "var(--text)",
            textDecoration: "none",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            flexShrink: 0, // never squeezed by the lines below it (the title lost its second line on cards with long explanations)
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            overflowWrap: "anywhere",
          }}
        >
          {record.title}
        </a>

        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--text)" }}>${record.price ?? "?"}</div>
          {originalPriceUsd !== null && (
            <div style={{ fontSize: 14, color: "var(--text-dim)", textDecoration: "line-through" }}>${originalPriceUsd}</div>
          )}
          {shippingUsd != null && (
            <div style={{ fontSize: 14, color: "var(--text-muted)" }}>+ {shippingUsd === 0 ? "free" : money(shippingUsd)} shipping</div>
          )}
        </div>

        {verdictChip && (
          <div
            title={record.gateHeadline ?? undefined}
            style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12.5, lineHeight: 1.35, minWidth: 0 }}
          >
            <span className="pill" style={{ flexShrink: 0, color: verdictChip.color, borderColor: verdictChip.color, fontWeight: 700, fontSize: 11.5, padding: "2px 8px" }}>
              {verdictChip.label}
            </span>
            <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{verdictChip.detail}</span>
          </div>
        )}

        {record.conditionAssessment && (record.conditionAssessment.defects.length > 0 || record.conditionAssessment.statements.length > 0) && (() => {
          const c = record.conditionAssessment!;
          const undisclosed = c.flags.some((f) => f.flag === "UNDISCLOSED_DAMAGE");
          const compare = c.profitAtAskNewUsd !== null && c.profitAtAskLegacyUsd !== null && c.profitAtAskNewUsd !== c.profitAtAskLegacyUsd;
          const lines = [
            ...c.defects.map((d) => `${d.cls.replace(/_/g, " ")}${d.area ? ` (${d.area})` : ""} — ${d.source === "text+vision" ? "seller and photos agree" : d.source === "vision" ? "seen in the photos, not in the listing" : "from the listing text"}`),
            ...c.flags.filter((f) => f.flag !== "UNDISCLOSED_DAMAGE").map((f) => f.text),
            ...c.statements,
            ...(compare ? [`${c.mode === "shadow" ? "Would change" : "Changed"} the profit at this price: $${c.profitAtAskNewUsd} by defect vs $${c.profitAtAskLegacyUsd} with the old flat factor.`] : []),
            ...(c.explanation.length ? [c.explanation[c.explanation.length - 1]] : []),
          ];
          return (
            <div data-testid="condition-note" title={lines.join("\n")} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12.5, lineHeight: 1.35, minWidth: 0 }}>
              <span className="pill" style={{ flexShrink: 0, color: undisclosed ? "var(--warn)" : "var(--text-muted)", borderColor: undisclosed ? "var(--warn)" : "var(--border-strong)", fontWeight: 600, fontSize: 11, padding: "2px 8px" }}>
                {undisclosed ? "Undisclosed damage" : c.defects.length ? "Condition" : "Condition check"}
              </span>
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lines[0]}</span>
            </div>
          );
        })()}

        {researchNote && (
          <div
            data-testid="research-note"
            title={researchNote.detail || undefined}
            style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12.5, lineHeight: 1.35, minWidth: 0 }}
          >
            <span className="pill" style={{ flexShrink: 0, color: researchNote.color, borderColor: researchNote.color, fontWeight: 600, fontSize: 11, padding: "2px 8px" }}>
              {researchNote.label}
            </span>
            <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{researchNote.detail}</span>
          </div>
        )}

        {dealNumbers && (
          <div
            data-testid="deal-numbers"
            title={dealNumbers.allReasons.join("\n")}
            style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5, lineHeight: 1.35, minWidth: 0 }}
          >
            {dealNumbers.hasFigures ? (
              <div style={{ display: "flex", gap: "2px 12px", flexWrap: "wrap", color: "var(--text-muted)" }}>
                <span>
                  Sells <b style={{ color: "var(--text)" }}>{dealNumbers.resale}</b>
                </span>
                {dealNumbers.keep && (
                  <span>
                    Keep <b style={{ color: "var(--text)" }}>{dealNumbers.keep}</b>
                  </span>
                )}
                {dealNumbers.profit && (
                  <span>
                    Profit{" "}
                    <b style={{ color: dealNumbers.profitTone === "good" ? "var(--success)" : dealNumbers.profitTone === "bad" ? "var(--danger)" : "var(--text)" }}>
                      {dealNumbers.profit}
                      {dealNumbers.margin ? ` (${dealNumbers.margin})` : ""}
                    </b>
                  </span>
                )}
              </div>
            ) : null}
            <div style={{ color: dealNumbers.supportTone === "warn" ? "var(--warn)" : "var(--text-dim)" }}>{dealNumbers.support}</div>
            {dealNumbers.atTarget && <div style={{ color: "var(--text-muted)" }}>{dealNumbers.atTarget}</div>}
            {dealNumbers.reasons.map((text) => (
              <div key={text} style={{ color: "var(--text-dim)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {text}
              </div>
            ))}
          </div>
        )}

        {ageLocationLine && (
          <div title={`Found by the scanner ${timeAgo(record.firstSeenAt)}`} style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
            {ageLocationLine}
          </div>
        )}

        {sellerRatingLine && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)" }}>{sellerRatingLine}</div>
        )}
      </div>

      <div style={{ flexShrink: 0, display: "flex", gap: 8, padding: 12 }}>
        <button
          className="icon"
          disabled={saving}
          onClick={() => setShowInterestedDialog(true)}
          style={{ flex: 1, textAlign: "center", borderColor: "var(--success)", color: "var(--success)" }}
        >
          Interested
        </button>
        <button
          className="icon"
          disabled={saving}
          onClick={() => setShowNotInterestedDialog(true)}
          style={{ flex: 1, textAlign: "center", borderColor: "var(--danger)", color: "var(--danger)" }}
        >
          Not interested
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
          extra={{
            label: researching ? "Researching…" : "Research this product",
            icon: <MagnifierIcon />,
            color: "var(--success)",
            disabled: saving,
            onClick: () => submitInterested("", true),
          }}
          message={researchMsg}
          onSubmit={(reason) => submitInterested(reason)}
          onCancel={() => setShowInterestedDialog(false)}
        />
      )}
      {showNotInterestedDialog && (
        <ReasonDialog
          title="Why aren't you interested?"
          helperText="This helps Clynx show you less of this in the future. Blacklisting skips this kind of listing automatically from now on."
          quickReasons={[
            `Not interested in "${categoryGuess}" in general`,
            "Wrong item — doesn't match what I'm looking for",
            "Price or condition wasn't good enough",
          ]}
          extra={{
            label: "Blacklist this kind of listing",
            icon: <NoSignIcon />,
            color: "var(--danger)",
            disabled: saving,
            onClick: () => {
              setShowNotInterestedDialog(false);
              setShowBlacklistDialog(true);
            },
          }}
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

const ICON_PROPS = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round" as const, "aria-hidden": true };

function MagnifierIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
    </svg>
  );
}

function NoSignIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6 18.4 18.4" />
    </svg>
  );
}

// Memoized: with a stable onDelete/onGoToProduct (Feed passes the same
// functions every render) and unchanged listings keeping their identity (see
// App.tsx's reconcileListings), a card now re-renders only when it actually
// changed — not once per incoming scan event.
export const ListingCard = React.memo(ListingCardImpl);

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
  extra,
  message,
  onSubmit,
  onCancel,
}: {
  title: string;
  helperText: string;
  quickReasons: string[];
  // A bigger, outlined action offered beside the reasons (Research under Interested, Blacklist under Not interested).
  extra?: { label: string; icon: React.ReactNode; color: string; disabled?: boolean; onClick: () => void };
  message?: string | null;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [customReason, setCustomReason] = useState("");

  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{helperText}</p>
      {extra && (
        <button
          className="icon"
          disabled={extra.disabled}
          onClick={extra.onClick}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, borderColor: extra.color, color: extra.color, fontWeight: 600 }}
        >
          {extra.icon}
          {extra.label}
        </button>
      )}
      {message && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{message}</div>}
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
