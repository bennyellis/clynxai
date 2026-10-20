import React from "react";
import clynxMarkSrc from "../assets/clynx/clynx-mark.png";
import type { LiveTileModel, TileTone } from "../lib/liveFeed.js";

// One tile of the Discovery Live feed: the Dashboard's Live-tile look (the pulsing red dot while it works, the photo, one status line), stacked vertically. A researching tile is the full
// live tile; a finished one is one compact line. The product's photo, else the Clynx logo (never a mixed emoji). Only transform / opacity animate (the dot reuses liveDotPulse).

const TONE_COLOR: Record<TileTone, string> = {
  live: "var(--danger)",
  good: "var(--success)",
  info: "var(--accent-1-text)",
  warn: "var(--warn)",
  bad: "var(--danger)",
  dim: "var(--text-dim)",
};

function Thumb({ url, size }: { url: string | null; size: number }) {
  return (
    <div
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: size > 40 ? 12 : 8,
        overflow: "hidden",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <img src={clynxMarkSrc} alt="" loading="lazy" decoding="async" style={{ width: "62%", height: "62%", objectFit: "contain", display: "block", opacity: 0.85 }} />
      )}
    </div>
  );
}

export function LiveFeedTile({ name, photoUrl, model, active, badge, onClick }: { name: string; photoUrl: string | null; model: LiveTileModel; active: boolean; badge?: string; onClick: () => void }) {
  const color = TONE_COLOR[model.tone];
  const chip = (
    <span className="pill" style={{ fontSize: 11, padding: "1px 8px", color, borderColor: color, flexShrink: 0, whiteSpace: "nowrap" }}>
      {model.chip}
    </span>
  );
  if (model.compact) {
    return (
      <button
        className="ghost"
        onClick={onClick}
        data-testid="live-tile-compact"
        title={name}
        aria-label={`${name}, ${model.chip}`}
        aria-current={active ? "true" : undefined}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "7px 14px", borderRadius: 0, borderBottom: "1px solid var(--border)", borderLeft: `3px solid ${active ? "var(--accent-1)" : "transparent"}`, background: active ? "var(--bg-card-hover)" : "transparent" }}
      >
        <Thumb url={photoUrl} size={30} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.line}</div>
        </div>
        {chip}
      </button>
    );
  }
  return (
    <button
      className="ghost"
      onClick={onClick}
      data-testid="live-tile"
      title={name}
      aria-label={`${name}, ${model.chip}`}
      aria-current={active ? "true" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 8, width: "calc(100% - 20px)", margin: "10px 10px 0", textAlign: "left", padding: 10, borderRadius: 12, border: `1px solid ${active ? "var(--accent-1)" : "var(--border)"}`, background: "var(--bg-elevated)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 12.5 }}>
        <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", background: "currentColor", color: "var(--danger)", boxShadow: "0 0 8px currentColor", animation: "liveDotPulse 1.6s ease-in-out infinite", flexShrink: 0 }} />
        <span style={{ marginLeft: "auto" }}>{chip}</span>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Thumb url={photoUrl} size={56} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{model.line}</div>
          {badge && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.4 }}>{badge}</div>}
        </div>
      </div>
    </button>
  );
}
