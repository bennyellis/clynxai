import React from "react";
import { createPortal } from "react-dom";

// Generic themed dialog, replacing native window.confirm/prompt popups
// wherever the app needs to ask the user something more involved than a
// single OK/Cancel — those break the app's own dark/gradient look and can't
// hold custom content (a list of quick-pick reasons, styled Yes/No buttons,
// etc.). Backdrop click or the × both just call onClose — callers decide
// what (if anything) that means for their own flow; the explicit buttons
// inside `children` are what should actually trigger an action.
//
// Portals to document.body rather than rendering inline: every card in the
// app carries the shared ".enter" entrance-animation class, whose
// fadeInUp keyframe ends on (and, via animation-fill-mode: both,
// permanently holds) `transform: translateY(0)` — a transform value other
// than `none`, which per the CSS spec makes that element a containing block
// for any `position: fixed` descendant. A modal opened from a button inside
// one of those cards would end up positioned/clipped relative to the
// card's own box instead of the viewport if it weren't portaled out from
// under that ancestor.
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong style={{ fontSize: 16 }}>{title}</strong>
          <button
            className="icon ghost"
            onClick={onClose}
            style={{ width: 32, height: 32, padding: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}
          >
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
