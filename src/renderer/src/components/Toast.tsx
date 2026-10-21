import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface ToastItem {
  id: string;
  message: string;
  productId: string | null;
  tone: "good" | "info";
}

const SHOW_MS = 8000;

/** One short disappearing message (about 8 seconds; hovering or focusing it pauses the clock). Opacity and transform only. Announced politely to screen readers; clicking opens the product it is about. */
export function ToastHost({ onOpenProduct }: { onOpenProduct: (productId: string) => void }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const [paused, setPaused] = useState(false);
  const left = useRef(SHOW_MS);
  const started = useRef(0);
  useEffect(() => api.onToast((t) => { left.current = SHOW_MS; setToast(t); }), []);
  useEffect(() => {
    if (!toast || paused) return;
    started.current = Date.now();
    const timer = setTimeout(() => setToast(null), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(500, left.current - (Date.now() - started.current));
    };
  }, [toast, paused]);
  return (
    <div aria-live="polite" role="status" style={{ position: "fixed", right: 20, bottom: 20, zIndex: 9000, pointerEvents: "none" }}>
      {toast && (
        <div
          key={toast.id}
          className="toast-card"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          style={{ pointerEvents: "auto", maxWidth: 380, padding: "12px 14px", borderRadius: 12, background: "var(--bg-elevated, #1c2030)", border: `1px solid ${toast.tone === "good" ? "var(--success)" : "var(--border-strong)"}`, color: "var(--text)", boxShadow: "0 8px 30px rgba(0,0,0,0.35)", display: "flex", gap: 10, alignItems: "flex-start" }}
        >
          <button
            className="icon ghost"
            style={{ flex: 1, textAlign: "left", padding: 0, fontSize: 14.5, lineHeight: 1.45, whiteSpace: "normal" }}
            disabled={!toast.productId}
            onClick={() => {
              if (toast.productId) onOpenProduct(toast.productId);
              setToast(null);
            }}
          >
            {toast.message}
          </button>
          <button className="icon ghost" aria-label="Dismiss" onClick={() => setToast(null)} style={{ padding: "0 4px" }}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
