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
