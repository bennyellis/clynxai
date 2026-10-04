import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Per explicit instruction — "light particle animations to each click...
// only make them appear when something clickable is clicked." Mounted
// once at the app root (see App.tsx) rather than wired into every button/
// link individually — a single capture-phase document listener sees every
// click app-wide, and walks a few ancestors up from the actual click
// target to decide whether it landed on something clickable, the same
// "is this really interactive" heuristic a person would use by eye
// (a button/link/role="button", or an element that registered its own
// onclick). Purely decorative — pointer-events: none on the overlay means
// this can never intercept or interfere with the click it's reacting to.
//
// Portals to document.body, per further explicit instruction ("I see in
// some places the particles spawn way to the left") — likely the REAL
// explanation all along, not just CustomCursor's own separate lag bug:
// this app's shared `.enter` entrance animation holds a permanent
// `transform: translateY(0)` (animation-fill-mode: both), which per the
// CSS spec makes that element a containing block for any `position: fixed`
// descendant — see Modal.tsx and CustomCursor.tsx's own doc comments,
// which hit the exact same class of bug. "In some places" fits a
// containing-block bug precisely (it only misfires depending on this
// overlay's position in the tree relative to an animated card at any given
// moment) far better than a flat coordinate-math bug would. Portaling
// straight to document.body removes it from that tree entirely.
interface Burst {
  id: number;
  x: number;
  y: number;
}

const PARTICLES_PER_BURST = 7;
const PARTICLE_COLORS = ["var(--accent-1)", "var(--accent-2)", "var(--accent-3)"];

function isClickableTarget(target: EventTarget | null): boolean {
  let node = target as HTMLElement | null;
  for (let depth = 0; depth < 6 && node; depth++) {
    const role = node.getAttribute?.("role");
    if (
      node.tagName === "BUTTON" ||
      node.tagName === "A" ||
      node.tagName === "SELECT" ||
      node.tagName === "INPUT" ||
      role === "button" ||
      role === "link" ||
      node.onclick != null ||
      node.style?.cursor === "pointer"
    ) {
      return !(node as HTMLButtonElement).disabled;
    }
    node = node.parentElement;
  }
  return false;
}

export function ClickParticles() {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const nextIdRef = useRef(0);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!isClickableTarget(e.target)) return;
      const id = nextIdRef.current++;
      // Per explicit instruction — "make sure that when you click, the
      // particles stem ONLY from the cursor": this event's own clientX/Y
      // IS the cursor's true position at the instant of the click — the
      // most direct, always-accurate source there is. An earlier attempt
      // here read from a shared position CustomCursor updates once per
      // animation frame instead, on the theory that it'd guarantee the two
      // never disagree — verified live that it does the opposite: that
      // value only updates on the next rAF tick after a real mousemove, so
      // it can be a frame stale (confirmed a real case diverging by 100+
      // px in testing). The actual "particles spawn to the left" bug this
      // was meant to fix was CustomCursor's own rendering lag (a
      // filter: drop-shadow recomputed on every mousemove) making the
      // VISIBLE cursor trail behind the true pointer — fixed there
      // directly (see that component) — not a real inaccuracy here.
      setBursts((prev) => [...prev, { id, x: e.clientX, y: e.clientY }]);
      setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 700);
    }
    // Capture phase — sees every click before any component's own
    // stopPropagation could swallow it.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return createPortal(
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999, overflow: "hidden" }}>
      {bursts.map((b) => (
        <div key={b.id} style={{ position: "absolute", left: b.x, top: b.y, width: 0, height: 0 }}>
          {Array.from({ length: PARTICLES_PER_BURST }).map((_, i) => {
            const angle = (360 / PARTICLES_PER_BURST) * i + (Math.random() * 20 - 10);
            const distance = 22 + Math.random() * 14;
            const size = 3 + Math.random() * 3;
            return (
              <span
                key={i}
                className="click-particle"
                style={
                  {
                    width: size,
                    height: size,
                    background: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
                    color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
                    // Read by the clickParticleFly keyframe (both its 0%
                    // and 100% states) — a custom property, not a plain
                    // `transform` style, since the keyframe's own
                    // transform would otherwise just override/ignore an
                    // inline transform while the animation is running.
                    "--r": `${angle}deg`,
                    "--particle-distance": `${distance}px`,
                    animationDelay: `${Math.random() * 40}ms`,
                  } as React.CSSProperties
                }
              />
            );
          })}
        </div>
      ))}
    </div>,
    document.body
  );
}
