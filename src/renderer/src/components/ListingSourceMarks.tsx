import React from "react";
import type { ListingRecord } from "../lib/api.js";

export type ListingSource = ListingRecord["source"];

// Outline colors for telling the two marketplaces apart at a glance:
// Facebook blue, eBay green.
export const SOURCE_COLORS: Record<ListingSource, string> = {
  facebook: "#1877f2",
  ebay: "#22c55e",
};

export const SOURCE_NAMES: Record<ListingSource, string> = {
  facebook: "Facebook Marketplace",
  ebay: "eBay",
};

// Thickness of every listing outline (source blue/green, plus the red and
// yellow verdict outlines below) — one constant so they always match.
export const OUTLINE_WIDTH_PX = 4;

// How Clynx itself judged a listing, for the outline color:
//   interested — everything else: keeps its source color (Facebook blue /
//                eBay green)
//   unsure     — Clynx isn't certain: the title and the photos disagree about
//                what the item is (either direction), or it flagged a deal
//                without high confidence: yellow
//   pass       — NOT of interest: automatically blacklisted (a blacklisted
//                term or photo, a learned "you keep dismissing these", or an
//                unshippable bulky category), or a terrible deal (priced at
//                or above what it's worth, or over the max price you set): red
export type ListingVerdict = "interested" | "unsure" | "pass";

export const VERDICT_COLORS: Record<Exclude<ListingVerdict, "interested">, string> = {
  unsure: "var(--warn)",
  pass: "var(--danger)",
};

// These patterns match the reasoning text scrapeEngine.ts / scorer.ts save, so
// if any of those wordings change, update the pattern here too:
//  - photos disagree with the title: scrapeEngine's "Photo/title mismatch"
//    override ("...by title alone, but the photos show...") and the green-flag
//    correction ("...but the photos confirm this is actually...")
//  - auto-blacklisted: "title matches blacklisted term", "the photo itself
//    shows..." (the blacklisted-images check), "bulky/local-pickup-only
//    category", and scorer.ts's "you've consistently marked ... as not
//    interesting"
//  - over your price limit: "...above the $X max price you set..." and
//    "...above the $X hard price cap you set..."
const TITLE_PHOTO_MISMATCH = /by title alone, but the photos show|but the photos confirm this is actually/i;
const AUTO_BLACKLISTED = /\bblacklisted\b|the photo itself shows|bulky\/local-pickup-only|consistently marked/i;
const OVER_PRICE_LIMIT = /max price you set|hard price cap you set/i;

export function listingVerdict(l: ListingRecord): ListingVerdict {
  // Checked first: a photo/title mismatch is saved as a non-deal with no
  // matched item, which would otherwise look like any other non-deal.
  if (TITLE_PHOTO_MISMATCH.test(l.reasoning)) return "unsure";
  if (l.isDeal) return l.confidence === "high" ? "interested" : "unsure";
  if (AUTO_BLACKLISTED.test(l.reasoning) || OVER_PRICE_LIMIT.test(l.reasoning)) return "pass";
  // A terrible deal: priced at or above the item's reference value. (The
  // matched product's average sold price stands in when no reference price
  // was set for the Search For item.)
  if (l.price !== null) {
    if (l.discountPercent !== null) {
      if (l.discountPercent <= 0) return "pass";
    } else if (l.matchedProductAvgSoldPriceUsd !== null && l.matchedProductAvgSoldPriceUsd > 0 && l.price >= l.matchedProductAvgSoldPriceUsd) {
      return "pass";
    }
  }
  return "interested";
}

/** The outline color for a listing: red = pass, yellow = unsure, otherwise its source color. */
export function listingOutlineColor(l: ListingRecord): string {
  const verdict = listingVerdict(l);
  return verdict === "interested" ? SOURCE_COLORS[l.source] : VERDICT_COLORS[verdict];
}

// A "really good" listing: a confirmed deal that's either at least 50% under
// its reference price, or priced at 60% or less of the matched product's
// average sold price. Ordinary deals keep the normal look; only these get
// the flame and glow.
export function isHotListing(l: ListingRecord): boolean {
  if (!l.isDeal || l.price === null) return false;
  if (l.discountPercent !== null && l.discountPercent >= 50) return true;
  const avgSold = l.matchedProductAvgSoldPriceUsd;
  return avgSold !== null && avgSold > 0 && l.price <= avgSold * 0.6;
}

// A really good listing's outline: the card's own border turns transparent
// (and its background stops at the padding edge — `backgroundClip` below) so
// this ring, sitting UNDER the card inside the .listing-hot wrapper, shows
// through as the outline: the normal outline color with a bright sheen
// travelling around the perimeter. The sweep is a rotating gradient moved by a
// transform only (see global.css), so it runs on the GPU compositor.
// Render it as the wrapper's first child; it needs `color` to be the same
// color the plain border would have been.
export function HotRing({ color }: { color: string }) {
  return (
    <span className="hot-ring" style={{ background: color }} aria-hidden="true">
      <span className="hot-ring-sweep" />
    </span>
  );
}

export function FacebookLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Facebook" role="img" style={{ display: "block", flexShrink: 0 }}>
      <rect width="24" height="24" rx="5" fill={SOURCE_COLORS.facebook} />
      <path
        fill="#fff"
        d="M13.5 21v-8h2.7l.4-3.2h-3.1V7.9c0-.9.3-1.5 1.6-1.5h1.7V3.5c-.3 0-1.3-.1-2.4-.1-2.4 0-4.1 1.5-4.1 4.2v2.2H7.5V13h2.8v8h3.2z"
      />
    </svg>
  );
}

// Plain four-color "ebay" wordmark on a white chip, so the colors stay
// readable on any card background.
export function EbayLogo({ height = 18 }: { height?: number }) {
  return (
    <span
      aria-label="eBay"
      role="img"
      style={{ display: "inline-flex", alignItems: "center", background: "#fff", borderRadius: 5, padding: "0 5px", height, flexShrink: 0 }}
    >
      <svg height={height * 0.72} viewBox="0 0 46 20" style={{ display: "block" }}>
        <text x="0" y="16" fontFamily="'Segoe UI', Arial, sans-serif" fontWeight="700" fontSize="21" letterSpacing="-1.2">
          <tspan fill="#e53238">e</tspan>
          <tspan fill="#0064d2">b</tspan>
          <tspan fill="#f5af02">a</tspan>
          <tspan fill="#86b817">y</tspan>
        </text>
      </svg>
    </span>
  );
}

export function SourceLogo({ source, size = 18 }: { source: ListingSource; size?: number }) {
  return source === "ebay" ? <EbayLogo height={size} /> : <FacebookLogo size={size} />;
}

export function FlameIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Hot deal" role="img" style={{ display: "block", filter: "drop-shadow(0 0 4px rgba(249,115,22,0.9))" }}>
      <path
        fill="#f97316"
        d="M12.2 1.5c.6 3.4-1.2 5.2-2.9 7C7.7 10.2 6 12 6 14.8A6.1 6.1 0 0 0 12.1 21 6.1 6.1 0 0 0 18.2 15c0-2.8-1.5-4.5-2.7-5.9-.3 1.2-1 2-1.9 2.4.7-3.4-.2-6.8-1.4-10z"
      />
      <path
        fill="#fbbf24"
        d="M12.3 12.2c.3 1.3-.4 2-1 2.8-.6.7-1.1 1.3-1.1 2.3a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0 2.5-2.5c0-1.2-.6-1.9-1.1-2.6-.4-.5-.8-1.1-.8-2.5z"
      />
    </svg>
  );
}
