import React, { createContext, useContext } from "react";
import { attentionBelow, attentionLabel, emptyAttention, shouldPulse, type AttentionSummary } from "./attention";

export const AttentionContext = createContext<AttentionSummary>(emptyAttention);

/** The pulsing dot for a tile or folder: shown while any unopened item touches these entries; steady rather than pulsing beyond the first few. Renders nothing when there is nothing waiting. */
export function AttentionDot({ productIds, className }: { productIds: ReadonlyArray<string>; className?: string }) {
  const summary = useContext(AttentionContext);
  const n = attentionBelow(summary, productIds);
  if (n === 0) return null;
  return <span className={`nav-item-pulse-dot attention-dot${shouldPulse(summary, productIds) ? "" : " steady"}${className ? ` ${className}` : ""}`} role="img" aria-label={attentionLabel(n)} />;
}

/** Entries that have a high-demand model below them (hotParents.ts): their price gets a green frame. */
export const HotParentsContext = createContext<ReadonlySet<string>>(new Set());
