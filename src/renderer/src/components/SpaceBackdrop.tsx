import React from "react";

// The app's backdrop, behind the interactive starfield canvas (see
// StarfieldBackground.tsx). Pure markup and STATIC on purpose: it is painted
// once and never animates. On integrated graphics every large moving layer
// has to be re-blended across the whole window on every display refresh, which
// is what made the old drifting version stutter the entire app. All motion in
// the scene — twinkling stars, the satellite circling the ring, the occasional
// meteor — is drawn by the starfield canvas instead, which is cheap and
// frame-rate capped. Every color comes from the live --accent-* variables, so
// custom colors and rainbow mode recolor the whole thing automatically.
//
// Layers, back to front (the vignette is part of the container's own
// background):
//   nebula  — soft primary/accent/blend glows
//   aurora  — two wide ribbons of light across the upper screen
//   orbit   — one thin ellipse around the screen center; the satellite that
//             rides it is drawn by the starfield (see ORBIT in that file,
//             which must match the geometry in global.css)
//   grid    — a perspective grid receding to the horizon. The
//             converging lines are a static image; the horizontal rows are
//             drawn and scrolled toward you by the starfield canvas (the
//             static bd-grid-rows copy only shows while that canvas isn't
//             running — see global.css)
export function SpaceBackdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="bd-nebula bd-nebula-1" />
      <div className="bd-nebula bd-nebula-2" />
      <div className="bd-aurora bd-aurora-1" />
      <div className="bd-aurora bd-aurora-2" />
      <div className="bd-orbit" />
      <div className="bd-grid" />
      <div className="bd-grid-rows" />
    </div>
  );
}
