import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Per explicit instruction — "overlay an extra large black cursor over the
// user's own... it'll make the app cooler," then a reference image for the
// exact shape. Several bugs reported live afterward, all fixed here:
//
// 1. "the real cursor still shows when hovering over something": the old
//    version only ever set document.body.style.cursor = "none" — but CSS
//    cursor is happily overridden by any MORE SPECIFIC rule, and this app
//    sets `cursor: "pointer"`/`"zoom-in"` inline on tons of individual
//    buttons/images throughout (Dashboard, Database, Feed, ...), each of
//    which quietly beat the body-level "none" the instant you hovered one.
//    A single global `*, *::before, *::after { cursor: none !important; }`
//    stylesheet (injected on mount, removed on unmount) is what actually
//    wins over every one of those inline styles everywhere, all at once.
//
// 2. "the large cursor just lags": the old version wrote a new transform to
//    the DOM synchronously inside the native mousemove handler, AND applied
//    a filter: drop-shadow — a genuinely expensive repaint recomputed on
//    every single mouse-move event, often more often than the screen can
//    even redraw. This tracks the latest position in a plain variable
//    (cheap) and only WRITES to the DOM once per animation frame via
//    requestAnimationFrame. The drop-shadow is gone entirely.
//
// 3. "you kinda have to cover the whole 'max price' part if you even wanna
//    click on it" — TWO separate causes, both real:
//    a) The path's own tip sits at viewBox point (3,3), not the SVG's own
//       (0,0) corner — at a 3.5x scale-up (24 -> 84px) that tip rendered
//       10.5px right/down from the true mouse position. Fixed by shifting
//       the SVG by that same -10.5px on both axes.
//    b) Verified live in the real app (a fix that tested correctly in
//       isolation still failed here) — per Modal.tsx's OWN doc comment,
//       solving this exact class of bug already: this app's shared `.enter`
//       entrance animation ends on (and holds, via animation-fill-mode:
//       both) `transform: translateY(0)`, and per the CSS spec ANY
//       transform other than `none` makes that element a containing block
//       for `position: fixed` descendants — so depending on exactly where
//       in the tree this rendered, "fixed" could resolve relative to some
//       nearby animated card instead of the real viewport. Modal.tsx's own
//       fix for this was portaling straight to document.body; doing the
//       same here sidesteps the whole ancestor-transform risk category
//       instead of chasing exactly which ancestor caused it.
//
// Per further explicit instruction ("make sure the particles stem ONLY
// from the cursor") this component was briefly changed to also publish its
// tracked position for ClickParticles to read — reverted after live testing
// showed that value can be a frame stale relative to a real click. See
// ClickParticles' own doc comment.
const CURSOR_VIEWBOX_PX = 24;
// Per explicit instruction ("make the custom cursor 30% smaller") — was 84.
const CURSOR_RENDER_PX = 84 * 0.7;
const CURSOR_SCALE = CURSOR_RENDER_PX / CURSOR_VIEWBOX_PX;
// The path's own tip sits at viewBox point (3,3) — see bug 3a above. This
// stays proportional to CURSOR_RENDER_PX automatically since it's derived
// from the same scale factor, so resizing the cursor can never reintroduce
// that misalignment.
const CURSOR_TIP_OFFSET_PX = 3 * CURSOR_SCALE;

export function CustomCursor() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `*, *::before, *::after { cursor: none !important; }`;
    document.head.appendChild(style);

    let latestX = 0;
    let latestY = 0;
    let rafId = 0;

    function onMove(e: MouseEvent) {
      latestX = e.clientX;
      latestY = e.clientY;
    }

    function tick() {
      const el = ref.current;
      if (el) el.style.transform = `translate(${latestX}px, ${latestY}px)`;
      rafId = requestAnimationFrame(tick);
    }

    window.addEventListener("mousemove", onMove);
    rafId = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(rafId);
      document.head.removeChild(style);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        pointerEvents: "none",
        zIndex: 999999,
        willChange: "transform",
      }}
    >
      {/* Black fill with a thin white outline, per a reference image. The
          SVG is shifted by -CURSOR_TIP_OFFSET_PX on both axes so the path's
          own tip (viewBox point 3,3) lands exactly on the wrapper's
          translated origin — see bug 3a above. */}
      <svg
        width={CURSOR_RENDER_PX}
        height={CURSOR_RENDER_PX}
        viewBox={`0 0 ${CURSOR_VIEWBOX_PX} ${CURSOR_VIEWBOX_PX}`}
        style={{ position: "absolute", top: -CURSOR_TIP_OFFSET_PX, left: -CURSOR_TIP_OFFSET_PX }}
      >
        <path
          d="M3 3 L10.07 19.97 L12.58 12.58 L19.97 10.07 Z"
          fill="#000000"
          stroke="#ffffff"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>,
    document.body
  );
}
