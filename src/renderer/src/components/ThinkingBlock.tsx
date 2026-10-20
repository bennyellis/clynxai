import React, { useEffect, useState } from "react";
import { useChatExtras } from "../lib/chatExtras.js";
import { thinkingSummary } from "../lib/chatStatus.js";
import { hostOf } from "../../../main/thinking.js";
import { useLightbox } from "./ImageLightbox.js";

// "Clynx's thinking" above a reply (AUDITOR proposal section 3, owner-accepted): short first-person lines, the pages Clynx opened (click to open in your browser) and the photos it looked at
// (small thumbnails, click to enlarge). It is OPEN while Clynx works and folds to one line when it is done ("Thought for 12s · looked at 3 pages, 5 photos"); you can open it again. Every item is
// a real event the app recorded (thinking.ts), capped at 20 per turn, with thumbnails no bigger than 160 px. Nothing here is the model's hidden reasoning. No animation.

export function ThinkingBlock({ requestId, working }: { requestId: string; working: boolean }) {
  const { steps } = useChatExtras();
  const mine = steps[requestId];
  const [now, setNow] = useState(() => Date.now());
  const [override, setOverride] = useState<boolean | null>(null); // null = follow "open while working, folded when done"; set once the person opens or closes it themself
  const lightbox = useLightbox();
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  const summary = thinkingSummary(mine, now, working);
  if (summary.items.length === 0) return null;
  const open = override ?? working;

  return (
    <>
      <details
        data-testid="thinking-block"
        open={open}
        onToggle={(e) => {
          const isOpen = (e.currentTarget as HTMLDetailsElement).open;
          if (isOpen !== open) setOverride(isOpen);
        }}
        style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 8px", border: "1px solid var(--border)", borderRadius: 10, padding: "6px 10px", background: "var(--bg-card)" }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--text-muted)" }}>{summary.headline}</summary>
        <div role="list" aria-label="What Clynx did" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {summary.items.map((item, i) => {
            if (item.type === "thought") {
              return (
                <div role="listitem" key={i} style={{ fontStyle: "italic", lineHeight: 1.45 }}>
                  {item.text}
                </div>
              );
            }
            if (item.type === "page" && item.url) {
              const host = hostOf(item.url);
              return (
                <a
                  role="listitem"
                  key={i}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={item.url}
                  style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", textDecoration: "none", minWidth: 0 }}
                >
                  <span aria-hidden="true" style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 4, background: "var(--bg-elevated)", border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>
                    {host.charAt(0).toUpperCase()}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.title && item.title !== host ? item.title : host}
                    <span style={{ color: "var(--text-dim)" }}> · {host}</span>
                  </span>
                </a>
              );
            }
            if (item.type === "image" && item.thumbnail) {
              return (
                <button
                  role="listitem"
                  key={i}
                  type="button"
                  className="ghost"
                  onClick={() => lightbox.open(item.thumbnail as string)}
                  title={item.text ? `${item.text} (click to enlarge)` : "Click to enlarge"}
                  style={{ padding: 0, alignSelf: "flex-start", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", lineHeight: 0 }}
                >
                  <img src={item.thumbnail} alt={item.text ?? "A photo Clynx looked at"} loading="lazy" decoding="async" style={{ maxWidth: 160, maxHeight: 160, objectFit: "contain", display: "block" }} />
                </button>
              );
            }
            return null;
          })}
        </div>
      </details>
      {lightbox.node}
    </>
  );
}
