import React, { useState } from "react";

// Per explicit instruction — a small → extra large size control for any
// grid of thumbnails, remembered per-grid (Feed, Database's product
// library, its Blacklisted Images gallery each get their own independent
// setting under their own storageKey) rather than one global size, since a
// rich Feed card and a plain image tile don't need the same range. Stored
// in localStorage — a per-viewer display preference, not app behavior, so
// this doesn't belong in the synced Config the way theme/freshness do.
export function useThumbnailSize(storageKey: string, defaultPx: number): [number, (px: number) => void] {
  const [size, setSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      const n = saved ? Number(saved) : NaN;
      return Number.isFinite(n) ? n : defaultPx;
    } catch {
      return defaultPx;
    }
  });

  function setAndPersist(px: number) {
    setSize(px);
    try {
      localStorage.setItem(storageKey, String(px));
    } catch {
      // best-effort — a private window or blocked storage just means the
      // choice doesn't survive a reload, not worth surfacing an error for
    }
  }

  return [size, setAndPersist];
}

export function ThumbnailSizeSlider({
  value,
  onChange,
  min,
  max,
  step = 10,
}: {
  value: number;
  onChange: (px: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--text-dim)" }}>
      <span>Small</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        title="Thumbnail size"
        style={{ width: 110 }}
      />
      <span>Extra large</span>
    </div>
  );
}
