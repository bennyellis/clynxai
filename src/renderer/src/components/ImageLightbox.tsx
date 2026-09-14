import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./Modal.js";
import { api } from "../lib/api.js";

// Per explicit instruction — only Database's Library tab (the product
// tile grid) and Feed's listing cards skip this; every other photo in the
// app opens into this enlarged view. Portals to document.body for the same
// reason Modal.tsx does: an ancestor card carrying the shared ".enter"
// animation class permanently holds a non-"none" CSS transform
// (animation-fill-mode: both), which would otherwise confine a nested
// position:fixed element to that card's own box instead of the viewport.
export interface ImageFeedbackContext {
  // What this image is currently filed/labeled as — a product name for a
  // reference photo or thumbnail, or the AI's own category guess for a
  // blacklisted image. Shown to the user and sent to the AI as context for
  // both "ask about this image" and feedback.
  subjectName: string;
  kind: "reference" | "thumbnail" | "blacklisted";
  imageId?: string; // ProductImage.id (reference) or BlacklistedImage.id (blacklisted)
  productId?: string; // owning product id (reference, thumbnail)
  sourceTitle?: string | null; // the listing title a reference photo came from, if any
  // Called after feedback resolves (whatever the outcome) so the caller's
  // OWN gallery/list can refresh itself — a "moved" reference photo needs
  // to disappear from its old product's gallery, which this component has
  // no direct way to update itself since it doesn't own that list.
  onFeedbackApplied?: () => void;
}

const FEEDBACK_OPTIONS: Record<ImageFeedbackContext["kind"], string[]> = {
  reference: ["Wrong product", "Wrong variant/model", "Blurry / can't tell what it is"],
  thumbnail: ["Wrong product", "Wrong variant/model", "Blurry / can't tell what it is"],
  blacklisted: ["This isn't actually ineligible", "Wrong category — it's a different ineligible type"],
};

export function ImageLightbox({
  src,
  alt,
  context,
  onClose,
}: {
  src: string;
  alt?: string;
  context?: ImageFeedbackContext;
  onClose: () => void;
}) {
  // Per explicit instruction — every image the AI pulls in gets a chatbox
  // underneath it here, ready to answer a free-text question about that
  // exact photo. Deliberately a single question/answer exchange, not a
  // scrolling history — this is a quick "what am I looking at" check, not
  // a whole conversation.
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackResult, setFeedbackResult] = useState<string | null>(null);
  // Per explicit instruction — picking "Wrong product" or "Wrong
  // variant/model" no longer submits that bare phrase outright: it holds
  // here while a follow-up asks whether the user actually KNOWS what this
  // is. Knowing the real answer up front is a much stronger correction
  // than making the AI re-guess purely from re-examining the same photo —
  // see submitFeedback below, which folds this into the feedback text sent
  // to reconsiderImageFeedback when given.
  const [correctionReason, setCorrectionReason] = useState<string | null>(null);
  const [knownProductName, setKnownProductName] = useState("");

  // Options that actually mean "this is filed under the wrong product" (as
  // opposed to "blurry" or the blacklisted-specific ones) — only these
  // trigger the known-product follow-up.
  const CORRECTABLE_OPTIONS = new Set(["Wrong product", "Wrong variant/model"]);

  function pickOption(option: string) {
    if (CORRECTABLE_OPTIONS.has(option)) {
      setCorrectionReason(option);
      setKnownProductName("");
    } else {
      submitFeedback(option);
    }
  }

  async function askQuestion() {
    const q = question.trim();
    if (!q || !context || asking) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const result = await api.askAboutImage(src, q, context.subjectName);
      if (result.answer) setAnswer(result.answer);
      else setAskError(result.error ?? "Couldn't get an answer.");
    } finally {
      setAsking(false);
    }
  }

  async function submitFeedback(reason: string) {
    if (!context || submittingFeedback) return;
    setSubmittingFeedback(true);
    try {
      const result = await api.submitImageFeedback({
        imageDataUri: src,
        currentLabel: context.subjectName,
        feedback: reason,
        kind: context.kind,
        imageId: context.imageId,
        productId: context.productId,
        sourceTitle: context.sourceTitle,
      });
      setFeedbackResult(result.message);
      context.onFeedbackApplied?.();
    } finally {
      setSubmittingFeedback(false);
      setShowFeedback(false);
      setFeedbackText("");
      setCorrectionReason(null);
      setKnownProductName("");
    }
  }

  // The user actually knows the right answer — folds it directly into the
  // feedback text as an explicit statement rather than a vague complaint,
  // so reconsiderImageFeedback has a concrete name to act on instead of
  // re-guessing blind from the same photo that was already misidentified.
  function submitKnownCorrection() {
    const name = knownProductName.trim();
    if (!name || !correctionReason) return;
    submitFeedback(`${correctionReason} — the user says this is actually: "${name}"`);
  }

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10, 8, 20, 0.85)",
        backdropFilter: "blur(4px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        zIndex: 1100,
        cursor: "zoom-out",
        animation: "fadeIn 0.15s ease both",
        padding: 20,
      }}
    >
      <img
        src={src}
        alt={alt ?? ""}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "90vw",
          maxHeight: context ? "60vh" : "90vh",
          borderRadius: 12,
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.6)",
          cursor: "default",
          display: "block",
        }}
      />

      {/* Per explicit instruction — "display text underneath the image of
          what the AI thinks it is": subjectName is exactly that (a product
          name for a reference/thumbnail photo, the AI's own category guess
          for a blacklisted one) — already computed by the caller, just not
          previously shown here at all. */}
      {context && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 12.5, color: "var(--text-muted)", textAlign: "center", cursor: "default" }}
        >
          {context.kind === "blacklisted" ? "The AI has this flagged as: " : "The AI has this filed as: "}
          <strong style={{ color: "var(--text)" }}>{context.subjectName}</strong>
        </div>
      )}

      {context && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "min(90vw, 480px)",
            background: "var(--bg-card)",
            border: "1px solid var(--border-strong)",
            borderRadius: 14,
            padding: 14,
            cursor: "default",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && askQuestion()}
              placeholder="Ask about this image..."
              style={{ flex: 1, background: "var(--bg-elevated)" }}
            />
            <button className="icon" disabled={!question.trim() || asking} onClick={askQuestion}>
              {asking ? "..." : "Ask"}
            </button>
            <button
              className="icon ghost"
              title="Give feedback on this image"
              onClick={() => setShowFeedback(true)}
              style={{
                width: 34,
                height: 34,
                padding: 0,
                borderRadius: "50%",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              ?
            </button>
          </div>

          {asking && <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>Looking closely at the image...</div>}
          {!asking && answer && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{answer}</div>}
          {!asking && askError && <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{askError}</div>}
          {feedbackResult && <div style={{ fontSize: 12.5, color: "var(--success)" }}>{feedbackResult}</div>}
        </div>
      )}

      <button
        onClick={onClose}
        title="Close"
        style={{
          position: "fixed",
          top: 20,
          right: 24,
          width: 36,
          height: 36,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.3)",
          background: "rgba(20,18,28,0.72)",
          color: "white",
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ×
      </button>

      {showFeedback && context && (
        <Modal
          title={correctionReason ? "Do you know what this actually is?" : "What's wrong with this image?"}
          onClose={() => {
            setShowFeedback(false);
            setCorrectionReason(null);
            setKnownProductName("");
          }}
        >
          {correctionReason ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                If you know the real product, telling us directly is a much better correction than making the AI
                guess again from the same photo.
              </p>
              <input
                autoFocus
                value={knownProductName}
                onChange={(e) => setKnownProductName(e.target.value)}
                placeholder="e.g. Xbox Series S (Black)"
                onKeyDown={(e) => e.key === "Enter" && knownProductName.trim() && submitKnownCorrection()}
              />
              <button className="primary" disabled={!knownProductName.trim() || submittingFeedback} onClick={submitKnownCorrection}>
                {submittingFeedback ? "Working on it..." : "Submit correction"}
              </button>
              <button className="icon ghost" disabled={submittingFeedback} onClick={() => submitFeedback(correctionReason)}>
                I don't know — let the AI figure it out
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {FEEDBACK_OPTIONS[context.kind].map((option) => (
                <button
                  key={option}
                  className="icon ghost"
                  disabled={submittingFeedback}
                  style={{ textAlign: "left", border: "1px solid var(--border)" }}
                  onClick={() => pickOption(option)}
                >
                  {option}
                </button>
              ))}
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Other — describe what's wrong..."
                rows={2}
                style={{ resize: "vertical" }}
              />
              <button
                className="primary"
                disabled={!feedbackText.trim() || submittingFeedback}
                onClick={() => submitFeedback(feedbackText.trim())}
              >
                {submittingFeedback ? "Working on it..." : "Submit"}
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>,
    document.body
  );
}

// Small hook so every gallery doesn't repeat the same "which image is
// zoomed" state/handlers — pass the returned props straight onto whatever
// <img> should be clickable. `open`'s second argument enables the
// ask/feedback panel — omit it for a plain zoom with no AI context (there
// currently isn't a case that does this, but the panel requires knowing
// what the image IS filed under, so it stays optional rather than assumed).
export function useLightbox() {
  const [src, setSrc] = React.useState<string | null>(null);
  const [context, setContext] = React.useState<ImageFeedbackContext | undefined>(undefined);
  return {
    open: (imgSrc: string, ctx?: ImageFeedbackContext) => {
      setSrc(imgSrc);
      setContext(ctx);
    },
    close: () => setSrc(null),
    node: src ? <ImageLightbox src={src} context={context} onClose={() => setSrc(null)} /> : null,
  };
}
