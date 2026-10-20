import React from "react";
import clynxMarkSrc from "../assets/clynx/clynx-mark.png";

// One speaker badge for every chat (Discovery, Activity, Library): Clynx is the Clynx logo (never a grey "C"), the person is the word "You" (never a letter in a circle). A few of
// Clynx's own narration rows keep their emoji (a search ack, a deal note); `glyph` is for those only. Static image, no animation.

/** Clynx speaking: the logo in a small round badge, or `glyph` (an emoji) for narration rows. */
export function ClynxAvatar({ size = 26, glyph }: { size?: number; glyph?: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.55),
        background: glyph ? "var(--border)" : "transparent",
      }}
    >
      {glyph ? glyph : <img src={clynxMarkSrc} alt="" width={size} height={size} loading="lazy" decoding="async" style={{ width: size, height: size, objectFit: "contain", display: "block" }} />}
    </div>
  );
}

/** The person speaking: the word "You". */
export function YouLabel({ align = "left" }: { align?: "left" | "right" }) {
  return (
    <div style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, letterSpacing: 0.2, color: "var(--text-muted)", paddingTop: 4, textAlign: align }}>You</div>
  );
}
