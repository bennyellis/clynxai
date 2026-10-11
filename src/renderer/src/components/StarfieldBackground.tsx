import React, { useEffect, useRef } from "react";
import { getTier, isIdle, reportFrame, subscribeTier } from "../lib/performance.js";
import clynxMarkSrc from "../assets/clynx/clynx-mark.png";

interface Star {
  // Forward-flight model (see TRAVEL_SPEED below). The camera flies toward the
  // vanishing point at the center of the horizon — the same point the floor
  // grid's lines converge on — so every star streams outward from it, growing
  // and brightening as it comes closer. A star is fixed in the world at (wx, wy)
  // and only its distance z changes:
  //   wx: sideways, in half-screen-widths at the far plane (-1..1)
  //   wy: height above the horizon, in sky-heights at the far plane (-1..0)
  //   z:  distance, 1 = far plane (just spawned), 0 = at the camera
  //   exitZ: the distance at which it has flown off the screen (the larger of
  //          |wx| and |wy|); it respawns at the far plane soon after
  wx: number;
  wy: number;
  z: number;
  exitZ: number;
  // 0 = far/tiny/dim, 1 = close/big/bright — the one number every other
  // per-star visual (size, brightness, glow, cursor-repel push/size-pop
  // strength) is derived from, so "closer" reads consistently across all
  // of them at once instead of each trait being picked independently.
  depth: number;
  twinkleSeed: number;
  twinkleSpeed: number;
  colorPick: 0 | 1 | 2;
  // Per explicit instruction ("make sure the particles kinda float around
  // or oscillate a little... makes the app feel alive") — a gentle bob
  // layered on TOP of the slow linear drift (vx/vy) above, not a
  // replacement for it: independent phase/speed per axis so stars don't
  // all bob in unison, and amplitude scales with depth (closer stars
  // float a bit more) to match the same "closer = more affected" logic
  // the cursor repel below also uses.
  floatSeedX: number;
  floatSeedY: number;
  // Third independent phase, used only for a slow size/brightness "breathe"
  // (see zBob in tick()) — a faux z-axis drift distinct from the x/y float
  // above, so a star reads as gently coasting toward/away from the viewer
  // rather than only sliding sideways. Deliberately its own seed (not
  // reused from floatSeedX/Y) so the breathing doesn't visibly sync with
  // the sideways bob.
  floatSeedZ: number;
  floatSpeed: number;
  floatAmp: number;
  // Current eased cursor-repel displacement (see REPEL_* below) — stored
  // per-star rather than recomputed fresh each frame so the push smoothly
  // ramps in/out as the cursor enters/leaves range instead of popping.
  pushX: number;
  pushY: number;
  // Index into the precomputed color table's 4 white-blend levels (50-80%
  // toward white, per explicit instruction) — picked once at spawn so each
  // star keeps a consistent tint.
  whiteIdx: number;
  // Seconds since this star spawned (real elapsed time, see dt in tick(), not
  // the frame counter t used for sine phases) — used to fade a new star in at
  // the far plane so it never pops into existence.
  age: number;
}

// Custom properties store their author-time string verbatim (a hex literal
// here, per global.css's :root block) — browsers never resolve them to
// rgb() the way a real CSS color property would, so this component has to
// do that conversion itself before it can use the value as raw RGB numbers.
function hexToRgbNumbers(hex: string, fallback: [number, number, number]): [number, number, number] {
  const clean = hex.trim().replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (full.length !== 6 || Number.isNaN(parseInt(full, 16))) return fallback;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// Reads whichever primary/accent/blend colors are CURRENTLY active (set as
// inline custom properties on documentElement by lib/colorScheme.ts) so
// this canvas re-themes along with the rest of the app the instant a
// different color is picked in Config. Returned as raw [r,g,b] numbers
// (not a pre-joined "r, g, b" string) so tick() can cheaply blend each
// star's own whiteMix in per-frame without re-parsing a string every time.
//
// The stars, grid, satellite and meteors are drawn in the accent colors'
// READABLE versions (--accent-N-text, see lib/colorScheme.ts) rather than the
// raw accents. Those are the same colors unless an accent would blend into the
// page — a white or pastel accent on the light theme, a black or navy one on
// the dark theme — in which case they're shifted just far enough to show, so
// the animated background can never vanish into the page.
function readPalette(): [number, number, number][] {
  const styles = getComputedStyle(document.documentElement);
  const read = (n: number, fallback: [number, number, number]): [number, number, number] => {
    const raw = styles.getPropertyValue(`--accent-${n}-text`) || styles.getPropertyValue(`--accent-${n}`);
    return hexToRgbNumbers(raw, fallback);
  };
  return [read(1, [124, 108, 246]), read(2, [168, 85, 247]), read(3, [79, 142, 247])];
}

// Per explicit instruction — replaces the old flat, connected-dot
// "geometric network" backdrop with a dense, heavily-3D-ized star field,
// modeled on a real night-sky photo reference: mostly tiny, dim, distant
// points with a much smaller number of large, bright, softly-glowing close
// ones (depth now comes from each star's distance, and because far stars
// vastly outnumber near ones in the flight below, the mix still skews hard
// toward 0/far — real starfields are not an even mix of sizes). The field is
// in forward flight (see "Forward flight" in the effect below): the stars
// stream out from the grid's vanishing point as if flying through them — a
// calm cruise, not a warp-speed effect.
//
// Cursor interaction, reworked per explicit instruction ("instead of all
// of them reacting to the cursor at once, make it local... make the
// cursor more of a repellant than a follow-my-lead"): this used to be a
// GLOBAL parallax tilt — cursor position normalized to the viewport
// center, so every star on screen shifted at once, all in the same
// direction, all the time, whether the cursor was near them or not (more
// a "whole field tilts with you" effect than something living near the
// mouse). It's now a LOCAL, radius-bounded push (see REPEL_RADIUS_PX
// below): only stars within that radius of the actual cursor position are
// affected at all, and they're pushed AWAY from it rather than toward/with
// it, fading smoothly to zero at the radius edge. Per a follow-up
// instruction ("reacts too violently... slow down its reaction but make
// its effect larger"), the push's own EASE is deliberately slow (PUSH_EASE)
// while its RANGE/MAGNITUDE (REPEL_RADIUS_PX/REPEL_STRENGTH_PX) are large —
// a big, unhurried shove instead of a snappy, small flinch. The 3D read
// comes from the SAME depth value driving everything else here — closer
// (high-depth) stars get pushed farther and visibly bulge larger as they
// dodge the cursor (see the sizeScale repel term in tick()), while far
// ones barely react. A second, independent slow sine per star
// (floatSeedZ) also gently breathes each star's size/brightness on top of
// that, simulating a faint bob toward and away from the viewer even with
// no cursor involved at all.
export function StarfieldBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    // global.css sets `zoom: 0.95` on <body> (the whole UI is scaled down a
    // touch). The canvas cancels that out (zoom: 1/uiZoom) so it covers the
    // whole window and its drawing coordinates are plain on-screen pixels —
    // the same space mouse events use, which the cursor-repel needs. The CSS
    // backdrop pieces the canvas has to line up with (the grid's height, the
    // orbit ring's radii) are sized in the UI's zoomed units, so their
    // on-screen size is uiZoom times the nominal value.
    let uiZoom = 1;
    let stars: Star[] = [];
    let rafId = 0;
    let t = 0;

    // Raw viewport pixel coordinates (the repel effect needs real on-screen
    // distance to each star). Sentinel far off-screen so nothing is "near"
    // the cursor before the first mousemove or after it leaves the window.
    const cursor = { x: -9999, y: -9999 };

    // Performance rework — what changed and why, since this is the one thing
    // that runs every single frame for the whole life of the app:
    //  * Effects tiers (lib/performance.ts): star count, resolution, frame
    //    rate and glow all scale with the tier, which auto-detects weak
    //    machines (and can be pinned in Config → Appearance).
    //  * Colors are precomputed once per palette change into a small table,
    //    and alpha goes through globalAlpha — so the hot loop no longer
    //    builds ~900 color strings per frame (constant GC churn).
    //  * The glow is a second, larger, faint disc instead of canvas
    //    shadowBlur, which was by far the most expensive call here.
    //  * Distance checks compare squared distances; the sqrt only happens
    //    for the few stars actually inside the repel radius.
    //  * Motion is scaled by real elapsed time, not per-frame: a 144Hz
    //    monitor used to run the whole field 2.4x too fast, and any frame
    //    skipping would have slowed it. Now it's the same speed everywhere.
    //  * Hidden (minimized/covered) window: no work. An UNFOCUSED but visible
    //    window keeps full speed — while the scanner runs, its browser windows
    //    hold focus and this window is exactly what you're watching.
    //  * The canvas is the ONLY thing in the backdrop that moves (the CSS
    //    backdrop is fully static — see SpaceBackdrop.tsx), and it's frame-rate
    //    capped per tier: every redraw makes the GPU re-composite the whole
    //    window, which integrated graphics can't afford at 144 times a second.
    //    Stars drift slowly, so a cap is invisible.
    //  * The satellite on the orbit ring and the occasional meteor are drawn
    //    here too (they used to be animated CSS layers — the single biggest
    //    cost in the whole app).
    // Each star's tint: on the dark sky a pale version of its color (50-80%
    // toward white); on the light theme a deeper one (0-30% toward black) so it
    // shows against the pale page. Both tables have the same number of levels.
    const WHITE_LEVELS = [0.5, 0.6, 0.7, 0.8];
    const BLACK_LEVELS = [0, 0.1, 0.2, 0.3];
    function buildColorTable(palette: [number, number, number][], light: boolean): string[][] {
      const target = light ? 0 : 255;
      return palette.map((base) =>
        (light ? BLACK_LEVELS : WHITE_LEVELS).map(
          (w) => `rgb(${Math.round(base[0] + (target - base[0]) * w)}, ${Math.round(base[1] + (target - base[1]) * w)}, ${Math.round(base[2] + (target - base[2]) * w)})`
        )
      );
    }
    const isLightTheme = () => document.documentElement.getAttribute("data-theme") === "light";
    let lightTheme = isLightTheme();
    let palette = readPalette();
    let colorTable = buildColorTable(palette, lightTheme);
    let paletteDirty = false;
    let lastPaletteRead = 0;
    // Colors only change on an explicit Config pick, a theme switch, or
    // rainbow mode's gentle fade — the observer just flags it, and the loop
    // re-reads at most a few times a second (see tick()).
    const paletteObserver = new MutationObserver(() => {
      paletteDirty = true;
    });
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    // frameMs is the minimum time between canvas redraws (the draw check
    // allows 20% slack so vsync jitter can't halve the rate). On a 60Hz screen
    // that works out to ~60fps / 30fps / 30fps; on a 144Hz screen ~48 / 36 / 36.
    // Every redraw makes the GPU re-present the whole window, so slow-drifting
    // stars (and the grid) don't get more than they need. `extras` = the
    // satellite and meteors.
    const TIERS = {
      high: { density: 1700, max: 900, min: 320, dprCap: 2, frameMs: 20, halo: true, extras: true },
      balanced: { density: 3600, max: 420, min: 160, dprCap: 1.5, frameMs: 33, halo: false, extras: true },
      lite: { density: 9000, max: 160, min: 80, dprCap: 1, frameMs: 33, halo: false, extras: false },
    } as const;
    // While the user is idle (see lib/performance.ts) the field just trickles.
    const IDLE_FRAME_MS = 66;

    // The orbit ring from global.css's .bd-orbit — center (50%, 44%), radii
    // (69vw, 27vh), tilted -12deg. Keep in sync with that rule. The satellite
    // circles it once per periodS.
    const ORBIT = { cx: 0.5, cy: 0.44, rx: 0.69, ry: 0.27, tilt: (-12 * Math.PI) / 180, periodS: 160 };
    const ORBIT_COS = Math.cos(ORBIT.tilt);
    const ORBIT_SIN = Math.sin(ORBIT.tilt);
    let orbitAngle = Math.random() * Math.PI * 2;

    // The grid's horizontal rows (global.css's .bd-grid is the static
    // converging lines; this draws the rows and scrolls them toward you).
    // Geometry matches that element — the bottom 36vh — and the original
    // static image: 9 rows at y = H * (k/9)^2, so spacing grows toward the
    // viewer. Scrolling just advances k by a fraction, wrapping every row
    // period, so the loop is seamless. Drawing them here (rather than as a
    // moving CSS layer) costs a few line strokes inside a canvas that is
    // already being redrawn — no extra layer for the GPU to composite.
    const GRID_ROWS = 9;
    // How far the converging lines fan out: 6000 units either side of center in
    // a 1000-unit-wide box = 6 screen-widths at the bottom of the grid. Keep in
    // sync with the mask images in global.css (.bd-grid / .bd-grid-rows).
    const GRID_FAN_HALF_WIDTHS = 6;
    const GRID_HEIGHT_FRAC = 0.36;
    const GRID_ROW_PERIOD_S = 1.0;
    let gridPhase = 0;

    // A meteor streaks across every so often (one at a time, 0.9s each).
    const METEOR_DURATION_S = 0.9;
    const METEOR_TRAVEL_PX = 480;
    const METEOR_LENGTH_PX = 150;
    const METEOR_ANGLE = (28 * Math.PI) / 180;
    const meteor = { active: false, x: 0, y: 0, age: 0 };
    let clockS = 0;
    let nextMeteorAtS = 4 + Math.random() * 6;

    // --- Flybys -----------------------------------------------------------------
    // Per explicit instruction: every 15-30 seconds an object related to the app
    // drifts across the sky, and (follow-up) "have them move similar to how the
    // star particles do". So a flyby uses the very same forward-flight model as
    // the stars: it starts tiny and dim out near the vanishing point at the
    // center of the horizon, then streams outward as the camera closes on it —
    // slow at first, then faster, growing and brightening as it comes near, with a
    // short speed trail, the same gentle bob, and the same cursor push — until it
    // sweeps off the edge of the screen. Which object it is, for a Clynx that finds
    // deals for resale: a price tag, a magnifying glass (the scanner), a spinning
    // coin, a shipping parcel, the lynx itself as a constellation, or the Clynx
    // logo. One at a
    // time, never the same one twice running.
    type FlybyKind = "tag" | "magnifier" | "coin" | "parcel" | "lynx" | "logo";
    const FLYBY_KINDS: FlybyKind[] = ["tag", "magnifier", "coin", "parcel", "lynx", "logo"];
    const FLYBY_MIN_GAP_S = 15;
    const FLYBY_MAX_GAP_S = 30;
    // Distance covered per second (the stars' is 0.06): a little slower, so it can be looked at.
    const FLYBY_SPEED = 0.04;
    // Half-width of the object in px at the far plane and when close, mapped from
    // the same depth value the stars' sizes come from.
    const FLYBY_SIZE_FAR = 10;
    const FLYBY_SIZE_NEAR = 150;
    const FLYBY_FADE_IN_S = 1.6;
    // Seconds of path drawn behind it as the speed trail.
    const FLYBY_TRAIL_S = 0.45;
    const flyby = {
      active: false,
      kind: "tag" as FlybyKind,
      wx: 0,
      wy: 0,
      z: 1,
      age: 0,
      tilt: 0,
      spin: 0, // radians per second it slowly turns
      seed: 0,
      color: 0 as 0 | 1 | 2,
      pushX: 0,
      pushY: 0,
    };
    let flybyClockS = 0;
    // The first one comes a little sooner, so it is seen soon after the app opens.
    let nextFlybyAtS = 6 + Math.random() * 8;
    let lastFlybyKind: FlybyKind | null = null;

    // The Clynx logo is a white line drawing on a transparent background (the same
    // PNG the sidebar uses). To draw it in a flyby's color it is tinted once into
    // a small canvas ("source-in" keeps the logo's shape and swaps its color),
    // and that is reused until the color changes.
    const markImage = new Image();
    markImage.src = clynxMarkSrc;
    let markTint: { ink: string; canvas: HTMLCanvasElement } | null = null;
    function getTintedMark(ink: string): HTMLCanvasElement | null {
      if (!markImage.complete || !markImage.naturalWidth) return null;
      if (markTint && markTint.ink === ink) return markTint.canvas;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = Math.round((320 * markImage.naturalHeight) / markImage.naturalWidth);
      const tctx = canvas.getContext("2d");
      if (!tctx) return null;
      tctx.drawImage(markImage, 0, 0, canvas.width, canvas.height);
      tctx.globalCompositeOperation = "source-in";
      tctx.fillStyle = `rgb(${ink})`;
      tctx.fillRect(0, 0, canvas.width, canvas.height);
      markTint = { ink, canvas };
      return canvas;
    }

    function startFlyby(requested?: FlybyKind): void {
      const choices = FLYBY_KINDS.filter((k) => k !== lastFlybyKind);
      const kind = requested ?? choices[Math.floor(Math.random() * choices.length)];
      lastFlybyKind = kind;
      // A world offset picked exactly the way a star's is (anywhere across the
      // sky: the whole width, any height above the horizon), so flybys show up in
      // the same places the stars do. Two kinds of path are skipped: one that leaves
      // the screen very close to the line of flight (the object would hang near the
      // vanishing point for ages, then balloon into a huge blob dead ahead), and one
      // that leaves almost at once (a star on such a path is gone in under a second
      // too, but an object needs a few seconds to be seen).
      let wx = 0;
      let wy = 0;
      let exitDistance = 0;
      do {
        wx = Math.random() * 2 - 1;
        wy = -(0.03 + Math.random() * 0.97);
        exitDistance = Math.max(Math.abs(wx), Math.abs(wy));
      } while (exitDistance < 0.3 || exitDistance > 0.85);
      flyby.kind = kind;
      flyby.wx = wx;
      flyby.wy = wy;
      flyby.z = 1;
      flyby.age = 0;
      flyby.seed = Math.random() * TAU;
      // Tipped a little and turning slowly (the lynx and the logo stay upright, so they read).
      flyby.tilt = kind === "lynx" || kind === "logo" ? 0 : (Math.random() - 0.5) * 0.6;
      flyby.spin = kind === "lynx" || kind === "logo" ? 0 : (Math.random() < 0.5 ? -1 : 1) * (0.03 + Math.random() * 0.05);
      flyby.color = Math.floor(Math.random() * 3) as 0 | 1 | 2;
      flyby.pushX = 0;
      flyby.pushY = 0;
      flyby.active = true;
    }
    function onFlybyRequest(e: Event): void {
      const kind = (e as CustomEvent<FlybyKind | undefined>).detail;
      startFlyby(kind && FLYBY_KINDS.includes(kind) ? kind : undefined);
    }

    // How close the cursor has to be (in screen px) before a star reacts at
    // all — this IS the "local, not the whole field" boundary. Large radius
    // and strength with a slow ease = a big, unhurried shove (per explicit
    // instruction), not a snappy flinch.
    const REPEL_RADIUS_PX = 240;
    const REPEL_RADIUS_SQ = REPEL_RADIUS_PX * REPEL_RADIUS_PX;
    const REPEL_STRENGTH_PX = 160;
    // Per-60fps-frame ease; converted to a time-based factor in tick().
    const PUSH_EASE = 0.05;

    // --- Forward flight -------------------------------------------------------
    // Per explicit instruction ("make it look like you're traveling forward in
    // space"): instead of drifting around in place, the stars stream outward
    // from the vanishing point at the center of the horizon (where the grid's
    // converging lines meet) as if the camera were flying forward — slow and
    // tiny near the vanishing point, then speeding up, growing and brightening
    // as they swing out toward the edges of the screen. They only exist in the
    // sky above the horizon (the grid is the floor), and a star is recycled to
    // the far plane the moment it leaves the screen.
    //
    // Distance runs from 1 (far plane) toward 0 (the camera); a star at distance
    // z sits at (center + world offset / z) on screen. TRAVEL_SPEED is how much
    // distance is covered per second: a star that exits near the screen edge
    // lives about (1 - exitZ) / TRAVEL_SPEED seconds, so 0.06 is a calm cruise
    // (about 8 seconds for a typical star).
    const TRAVEL_SPEED = 0.06;
    // The central "hole": stars are never spawned right on the line of flight,
    // where they would sit near the vanishing point for ages and then balloon
    // into a big bright blob dead ahead. Everything leaves the screen at
    // exitZ >= this, comfortably before reaching the camera.
    const MIN_EXIT_Z = 0.12;
    // A star is respawned once it is this much past its exit distance.
    const RESPAWN_PAST_EXIT = 0.88;
    // Speed streaks: a nearer star is drawn as a short trail back along its path,
    // as long as the ground it covers in this many seconds — computed from its
    // velocity, not from the frame gap, so streaks look the same at 30fps and 60.
    const STREAK_SECONDS = 0.09;
    const STREAK_MIN_DEPTH = 0.18;
    const STREAK_MIN_PX = 1.5;
    const FADE_IN_S = 0.6;

    // The focal point and the size of the sky, recomputed from the current
    // window each frame so a resize needs no star rebuild.
    let focalX = 0;
    let focalY = 0; // the horizon (top of the floor grid)
    let skyHalfWidth = 0;
    let skyHeight = 0;
    function updateFocus(): void {
      const gridH = height * GRID_HEIGHT_FRAC * uiZoom;
      focalX = width / 2;
      focalY = height - gridH;
      skyHalfWidth = width / 2;
      skyHeight = focalY;
    }

    // Mutates `star` in place with a fresh random identity rather than
    // allocating a new object, so the array never changes shape. `initial` (true
    // only on the first fill) scatters stars along their whole path so the
    // field is already in full flight on the first frame instead of every star
    // appearing at the far plane at once.
    function respawnStar(star: Star, initial: boolean): void {
      let wx = 0;
      let wy = 0;
      let exitZ = 0;
      do {
        wx = Math.random() * 2 - 1;
        wy = -(0.03 + Math.random() * 0.97); // above the horizon only
        exitZ = Math.max(Math.abs(wx), Math.abs(wy));
        // First fill: a star that flies for longer is more likely to be caught
        // mid-flight at any instant, so favour long-lived paths (keeps the
        // opening field the same mix as the steady state).
      } while (exitZ < MIN_EXIT_Z || (initial && Math.random() > 1 - exitZ));
      star.wx = wx;
      star.wy = wy;
      star.exitZ = exitZ;
      star.z = initial ? exitZ + Math.random() * (1 - exitZ) : 1;
      star.depth = Math.pow(1 - star.z, 1.25);
      star.twinkleSeed = Math.random() * Math.PI * 2;
      star.twinkleSpeed = 0.5 + Math.random() * 2.2;
      star.colorPick = Math.floor(Math.random() * 3) as 0 | 1 | 2;
      star.floatSeedX = Math.random() * Math.PI * 2;
      star.floatSeedY = Math.random() * Math.PI * 2;
      star.floatSeedZ = Math.random() * Math.PI * 2;
      star.floatSpeed = 0.25 + Math.random() * 0.75;
      // Random factor only; the depth-dependent size of the bob is applied each
      // frame (depth now changes as the star flies in).
      star.floatAmp = 0.5 + Math.random() * 0.6;
      star.pushX = 0;
      star.pushY = 0;
      star.whiteIdx = Math.floor(Math.random() * WHITE_LEVELS.length);
      star.age = initial ? FADE_IN_S : 0;
    }

    function spawnStar(initial: boolean): Star {
      const star = {} as Star;
      respawnStar(star, initial);
      return star;
    }

    function resize() {
      const p = TIERS[getTier()];
      dpr = Math.min(window.devicePixelRatio || 1, p.dprCap);
      uiZoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
      (canvas!.style as CSSStyleDeclaration & { zoom: string }).zoom = String(1 / uiZoom);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(p.max, Math.max(p.min, Math.floor((width * height) / p.density)));
      stars = Array.from({ length: count }, () => spawnStar(true));
    }
    resize();

    // Dragging the window edge fires resize continuously; rebuilding the
    // canvas and every star on each event is wasted work.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    function onResize() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    }
    function onMouseMove(e: MouseEvent) {
      cursor.x = e.clientX;
      cursor.y = e.clientY;
    }
    function onMouseLeave() {
      cursor.x = -9999;
      cursor.y = -9999;
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseout", onMouseLeave);
    // A tier change (auto step-down, or the Config picker) rebuilds the field
    // at the new density/resolution.
    const unsubscribeTier = subscribeTier(resize);

    const TAU = Math.PI * 2;
    let lastTickAt: number | null = null;
    let lastRafAt: number | null = null;

    // document.hasFocus() on every display refresh is wasted work; track it.
    let focused = document.hasFocus();
    const onFocus = () => {
      focused = true;
    };
    const onBlur = () => {
      focused = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    // Lets the page ask for a flyby right now (optionally of one kind) instead of
    // waiting out the timer.
    window.addEventListener("clynx:flyby", onFlybyRequest);
    // Tell the stylesheet this canvas now draws the grid's rows (it hides its
    // static copy of them — see global.css's .bd-grid-rows).
    document.documentElement.setAttribute("data-grid-live", "");

    // --- Aurora ---------------------------------------------------------------
    // Per explicit instruction ("make it so the auroras are animated as well").
    // The two ribbons of colored light across the upper sky used to be static CSS
    // layers; animating big CSS layers is what made the whole app stutter (every
    // refresh re-blends them across the window), so they live HERE instead, drawn
    // into the canvas that is already being redrawn at a capped rate. Each ribbon
    // is a few soft, pre-rendered glows ("blobs") — the same shapes the CSS
    // version used — and every blob sways, drifts, swells and fades on its own
    // slow cycle (20-45 seconds), so the curtains shimmer and slowly shift
    // rather than just sliding as one piece. Costs a handful of image blits per
    // frame. The static CSS ribbons remain as the fallback when the animated
    // background is switched off (global.css hides them while the canvas runs).
    //
    // Geometry matches the CSS ribbons: a box 1.5 screen-widths wide centered on
    // the screen, `top`/`height` as fractions of the UI-zoomed viewport height,
    // tilted a few degrees. A blob is an ellipse `rx` (fraction of the box width)
    // wide and half the box tall, centered `x` of the way across, in accent
    // color `c` (0 = primary, 1 = accent, 2 = the blend) at strength `a`.
    interface AuroraBlob { x: number; rx: number; c: 0 | 1 | 2; a: number; period: number; phase: number }
    interface AuroraRibbon { top: number; height: number; tiltDeg: number; period: number; phase: number; blobs: AuroraBlob[] }
    const AURORA_RIBBONS: AuroraRibbon[] = [
      {
        top: 0.06, height: 0.34, tiltDeg: -7, period: 41, phase: 0.6,
        blobs: [
          { x: 0.30, rx: 0.28, c: 2, a: 0.36, period: 27, phase: 0.0 },
          { x: 0.62, rx: 0.30, c: 0, a: 0.32, period: 34, phase: 2.1 },
          { x: 0.84, rx: 0.22, c: 1, a: 0.28, period: 23, phase: 4.2 },
        ],
      },
      {
        top: 0.24, height: 0.26, tiltDeg: 9, period: 53, phase: 3.3,
        blobs: [
          { x: 0.36, rx: 0.30, c: 1, a: 0.30, period: 31, phase: 1.3 },
          { x: 0.66, rx: 0.26, c: 2, a: 0.30, period: 38, phase: 5.0 },
        ],
      },
    ];
    // Overall ribbon strength, as the CSS had it: 0.55 on the dark sky, 0.35 on the light theme.
    const AURORA_OPACITY_DARK = 0.55;
    const AURORA_OPACITY_LIGHT = 0.35;
    let auroraSprites: HTMLCanvasElement[] = [];
    let auroraT = 0;

    // One soft elliptical glow per accent color (full strength at the center,
    // fading to nothing at the edge); each blob is a scaled, faded copy of one.
    function buildAuroraSprites(): void {
      const styles = getComputedStyle(document.documentElement);
      const fallbacks: [number, number, number][] = [[124, 108, 246], [168, 85, 247], [79, 142, 247]];
      auroraSprites = [1, 2, 3].map((n, i) => {
        const [r, g, b] = hexToRgbNumbers(styles.getPropertyValue(`--accent-${n}`), fallbacks[i]);
        const sprite = document.createElement("canvas");
        sprite.width = 256;
        sprite.height = 128;
        const sctx = sprite.getContext("2d")!;
        sctx.translate(128, 64);
        sctx.scale(128, 64);
        const grad = sctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        sctx.fillStyle = grad;
        sctx.fillRect(-1, -1, 2, 2);
        return sprite;
      });
    }
    buildAuroraSprites();

    function drawAurora(): void {
      const opacity = lightTheme ? AURORA_OPACITY_LIGHT : AURORA_OPACITY_DARK;
      for (const ribbon of AURORA_RIBBONS) {
        const boxW = width * 1.5;
        const boxH = height * ribbon.height * uiZoom;
        const cy = height * ribbon.top * uiZoom + boxH / 2;
        const sway = Math.sin((auroraT * TAU) / ribbon.period + ribbon.phase);
        ctx!.save();
        // The whole ribbon sways sideways, bobs a little and rocks a few degrees.
        ctx!.translate(width / 2 + sway * width * 0.04, cy + Math.sin((auroraT * TAU) / (ribbon.period * 1.3) + ribbon.phase * 1.7) * height * uiZoom * 0.02);
        ctx!.rotate(((ribbon.tiltDeg + sway * 2.5) * Math.PI) / 180);
        for (const blob of ribbon.blobs) {
          const w = (auroraT * TAU) / blob.period;
          const bx = (blob.x - 0.5) * boxW + Math.sin(w + blob.phase) * boxW * 0.05;
          const by = Math.sin(w * 1.25 + blob.phase * 1.7) * boxH * 0.1;
          // Each glow swells and fades on its own cycle, so brightness ripples along the ribbon.
          const breathe = 0.65 + 0.35 * Math.sin(w * 1.6 + blob.phase * 2.3);
          const rx = blob.rx * boxW * (1 + 0.08 * Math.sin(w * 0.9 + blob.phase));
          const ry = boxH / 2;
          ctx!.globalAlpha = opacity * blob.a * breathe;
          ctx!.drawImage(auroraSprites[blob.c], bx - rx, by - ry, rx * 2, ry * 2);
        }
        ctx!.restore();
      }
      ctx!.globalAlpha = 1;
    }

    function drawGrid(): void {
      const gridH = height * GRID_HEIGHT_FRAC * uiZoom;
      const top = height - gridH;
      const [r, g, b] = palette[0];
      ctx!.lineWidth = 1;
      for (let i = 0; i <= GRID_ROWS; i++) {
        const k = i + gridPhase;
        const f = k / GRID_ROWS;
        // k = 0 would sit on the horizon (invisible); k past 9 is below the screen.
        if (f <= 0) continue;
        if (f > 1.02) break;
        const u = f * f; // fraction of the way down the grid
        const alpha = 0.55 * Math.min(1, u / 0.45);
        if (alpha < 0.01) continue;
        const y = Math.round(top + gridH * u) + 0.5;
        // A row only exists where the converging lines do. Those fan out from
        // the center and reach GRID_FAN_HALF_WIDTHS screen-widths either side
        // at the bottom of the grid, so at this height (u of the way down)
        // they cover that far times u — beyond it a row would hang off the side
        // of the grid with no line crossing it. (Matches the .bd-grid mask.)
        const half = GRID_FAN_HALF_WIDTHS * width * u;
        const x0 = Math.max(0, width / 2 - half);
        const x1 = Math.min(width, width / 2 + half);
        if (x1 - x0 < 1) continue;
        ctx!.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
        ctx!.beginPath();
        ctx!.moveTo(x0, y);
        ctx!.lineTo(x1, y);
        ctx!.stroke();
      }
    }

    function drawSatellite(): void {
      const a = ORBIT.rx * width * uiZoom * Math.cos(orbitAngle);
      const b = ORBIT.ry * height * uiZoom * Math.sin(orbitAngle);
      const x = ORBIT.cx * width + a * ORBIT_COS - b * ORBIT_SIN;
      const y = ORBIT.cy * height + a * ORBIT_SIN + b * ORBIT_COS;
      // Off-screen for part of each orbit (the ring is wider than the window).
      if (x < -40 || x > width + 40 || y < -40 || y > height + 40) return;
      const [r, g, bl] = palette[1];
      const glow = `rgb(${r}, ${g}, ${bl})`;
      ctx!.fillStyle = glow;
      ctx!.globalAlpha = 0.1;
      ctx!.beginPath();
      ctx!.arc(x, y, 15, 0, TAU);
      ctx!.fill();
      ctx!.globalAlpha = 0.28;
      ctx!.beginPath();
      ctx!.arc(x, y, 7, 0, TAU);
      ctx!.fill();
      ctx!.globalAlpha = 1;
      ctx!.fillStyle = lightTheme ? glow : "#fff";
      ctx!.beginPath();
      ctx!.arc(x, y, 2.4, 0, TAU);
      ctx!.fill();
    }

    function drawMeteor(dt: number): void {
      meteor.age += dt;
      const p = meteor.age / METEOR_DURATION_S;
      if (p >= 1) {
        meteor.active = false;
        return;
      }
      const dx = Math.cos(METEOR_ANGLE);
      const dy = Math.sin(METEOR_ANGLE);
      const hx = meteor.x + dx * METEOR_TRAVEL_PX * p;
      const hy = meteor.y + dy * METEOR_TRAVEL_PX * p;
      const tx = hx - dx * METEOR_LENGTH_PX;
      const ty = hy - dy * METEOR_LENGTH_PX;
      const envelope = p < 0.12 ? p / 0.12 : p > 0.7 ? (1 - p) / 0.3 : 1;
      const grad = ctx!.createLinearGradient(tx, ty, hx, hy);
      const [mr, mg, mb] = lightTheme ? palette[1] : [255, 255, 255];
      grad.addColorStop(0, `rgba(${mr}, ${mg}, ${mb}, 0)`);
      grad.addColorStop(1, `rgba(${mr}, ${mg}, ${mb}, 0.95)`);
      ctx!.globalAlpha = envelope;
      ctx!.strokeStyle = grad;
      ctx!.lineWidth = 1.6;
      ctx!.lineCap = "round";
      ctx!.beginPath();
      ctx!.moveTo(tx, ty);
      ctx!.lineTo(hx, hy);
      ctx!.stroke();
      ctx!.globalAlpha = 1;
    }

    // The objects, drawn in a unit space (roughly -1..1 each way) that the caller
    // scales to the flyby's current size. `lw(px)` is a line width in on-screen
    // px, converted to that unit space. `ink` is the "r, g, b" of its color.
    function drawFlybyShape(kind: FlybyKind, ink: string, size: number, age: number, seed: number): void {
      const c = ctx!;
      const lw = (px: number) => px / size;
      const line = (a: number) => `rgba(${ink}, ${a})`;
      const edge = Math.max(1.4, size * 0.035);
      c.lineJoin = "round";
      c.lineCap = "round";
      c.strokeStyle = line(0.95);
      c.fillStyle = line(0.22);
      c.lineWidth = lw(edge);

      if (kind === "tag") {
        // A price tag with a punched hole, its string, and a dollar sign.
        c.beginPath();
        c.moveTo(-0.5, -0.5);
        c.lineTo(0, -0.95);
        c.lineTo(0.5, -0.5);
        c.lineTo(0.5, 0.9);
        c.lineTo(-0.5, 0.9);
        c.closePath();
        c.fill();
        c.stroke();
        c.beginPath();
        c.arc(0, -0.52, 0.1, 0, TAU);
        c.stroke();
        c.strokeStyle = line(0.65);
        c.beginPath();
        c.moveTo(0, -0.52);
        c.quadraticCurveTo(0.5, -1.25, 0.95, -0.8);
        c.stroke();
        c.fillStyle = line(0.95);
        c.font = "700 0.95px Arial, sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("$", 0, 0.34);
      } else if (kind === "magnifier") {
        // The scanner: a magnifying glass, with a glint on the lens.
        c.beginPath();
        c.arc(-0.18, -0.18, 0.58, 0, TAU);
        c.fill();
        c.stroke();
        c.lineWidth = lw(edge * 2.6);
        c.beginPath();
        c.moveTo(0.25, 0.25);
        c.lineTo(0.86, 0.86);
        c.stroke();
        c.strokeStyle = line(0.75);
        c.lineWidth = lw(edge * 0.9);
        c.beginPath();
        c.arc(-0.18, -0.18, 0.4, Math.PI * 1.05, Math.PI * 1.45);
        c.stroke();
      } else if (kind === "coin") {
        // A coin turning over on its way past.
        const turn = Math.max(0.07, Math.abs(Math.cos(age * 2.4 + seed)));
        c.save();
        c.scale(turn, 1);
        c.beginPath();
        c.arc(0, 0, 0.82, 0, TAU);
        c.fill();
        c.stroke();
        c.strokeStyle = line(0.55);
        c.beginPath();
        c.arc(0, 0, 0.62, 0, TAU);
        c.stroke();
        c.fillStyle = line(0.95);
        c.font = "700 1.05px Arial, sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("$", 0, 0.05);
        c.restore();
      } else if (kind === "parcel") {
        // A shipping box seen corner-on, with a strip of tape down the top.
        c.beginPath();
        c.moveTo(0, -0.92);
        c.lineTo(0.8, -0.46);
        c.lineTo(0.8, 0.46);
        c.lineTo(0, 0.92);
        c.lineTo(-0.8, 0.46);
        c.lineTo(-0.8, -0.46);
        c.closePath();
        c.fill();
        c.stroke();
        c.strokeStyle = line(0.6);
        c.beginPath();
        c.moveTo(-0.8, -0.46);
        c.lineTo(0, 0);
        c.lineTo(0.8, -0.46);
        c.moveTo(0, 0);
        c.lineTo(0, 0.92);
        c.stroke();
        c.strokeStyle = line(0.5);
        c.lineCap = "butt";
        c.lineWidth = lw(Math.max(3, size * 0.16));
        c.beginPath();
        c.moveTo(0, -0.9);
        c.lineTo(0, -0.02);
        c.stroke();
        c.lineCap = "round";
      } else if (kind === "logo") {
        // The Clynx logo, in the flyby's color, with a bolder soft copy behind it.
        const mark = getTintedMark(ink);
        if (mark) {
          const h = (2 * mark.height) / mark.width;
          c.globalAlpha *= 0.4;
          c.drawImage(mark, -1.06, -h / 2 - 0.03, 2.12, h + 0.06);
          c.globalAlpha /= 0.4;
          // The logo's lines are thin, so it is stamped a few times a hair apart to
          // give it the weight of the other objects' outlines.
          const thick = Math.max(0.012, 1.4 / size);
          for (const [ox, oy] of [[0, 0], [thick, 0], [-thick, 0], [0, thick], [0, -thick]]) c.drawImage(mark, -1 + ox, -h / 2 + oy, 2, h);
        }
      } else {
        // The lynx as a constellation: the outline of its face (tufted ears and
        // cheek ruffs) joined up between a few stars, with two bright eyes.
        const outline: Array<[number, number]> = [
          [-0.55, -0.95], [-0.82, -0.3], [-0.98, 0.15], [-0.55, 0.78], [0, 0.96],
          [0.55, 0.78], [0.98, 0.15], [0.82, -0.3], [0.55, -0.95], [0.2, -0.5], [0, -0.4], [-0.2, -0.5],
        ];
        c.strokeStyle = line(0.6);
        c.lineWidth = lw(Math.max(1, size * 0.022));
        c.beginPath();
        outline.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
        c.closePath();
        c.stroke();
        c.beginPath();
        c.moveTo(-0.55, -0.95); c.lineTo(-0.66, -1.28); // the ear tufts
        c.moveTo(0.55, -0.95); c.lineTo(0.66, -1.28);
        c.moveTo(0, 0.2); c.lineTo(-0.16, 0.48); // nose to mouth
        c.moveTo(0, 0.2); c.lineTo(0.16, 0.48);
        c.stroke();
        // The stars at its corners, each twinkling on its own.
        c.fillStyle = line(0.95);
        const dots: Array<[number, number]> = [...outline, [-0.66, -1.28], [0.66, -1.28], [0, 0.2], [-0.16, 0.48], [0.16, 0.48]];
        dots.forEach(([x, y], i) => {
          const tw = 0.6 + 0.4 * Math.sin(age * 3 + seed + i * 1.9);
          c.globalAlpha *= tw;
          c.beginPath();
          c.arc(x, y, 0.045, 0, TAU);
          c.fill();
          c.globalAlpha /= tw;
        });
        // The eyes: bigger, with a halo.
        for (const ex of [-0.36, 0.36]) {
          c.fillStyle = line(0.22);
          c.beginPath();
          c.arc(ex, -0.08, 0.2, 0, TAU);
          c.fill();
          c.fillStyle = line(1);
          c.beginPath();
          c.arc(ex, -0.08, 0.085, 0, TAU);
          c.fill();
        }
      }
    }

    function drawFlyby(dt: number): void {
      flyby.age += dt;
      flyby.z -= FLYBY_SPEED * dt;
      // Distance in -> size, like a star's: 0 = far plane, 1 = close.
      const depth = Math.pow(1 - Math.max(flyby.z, 0), 1.25);
      const invZ = 1 / Math.max(flyby.z, 0.02);
      const size = FLYBY_SIZE_FAR + (FLYBY_SIZE_NEAR - FLYBY_SIZE_FAR) * depth;

      // Perspective from the vanishing point, plus the stars' gentle bob.
      const bob = 1.6 + depth * 7;
      const floatX = Math.sin(t * 0.008 + flyby.seed) * bob;
      const floatY = Math.cos(t * 0.009 + flyby.seed * 1.7) * bob;
      const baseX = focalX + flyby.wx * skyHalfWidth * invZ + floatX;
      const baseY = focalY + flyby.wy * skyHeight * invZ + floatY;

      // The cursor shoves it aside the way it does the stars (same radius and strength).
      const dx = baseX - cursor.x;
      const dy = baseY - cursor.y;
      const d2 = dx * dx + dy * dy;
      let targetPushX = 0;
      let targetPushY = 0;
      if (d2 < REPEL_RADIUS_SQ) {
        const dist = Math.sqrt(d2) || 0.0001;
        const k = 1 - dist / REPEL_RADIUS_PX;
        const mag = REPEL_STRENGTH_PX * k * k * (0.35 + depth * 0.65);
        targetPushX = (dx / dist) * mag;
        targetPushY = (dy / dist) * mag;
      }
      const ease = 1 - Math.pow(1 - PUSH_EASE, Math.min(6, dt * 60));
      flyby.pushX += (targetPushX - flyby.pushX) * ease;
      flyby.pushY += (targetPushY - flyby.pushY) * ease;
      const x = baseX + flyby.pushX;
      const y = baseY + flyby.pushY;

      // Gone once it has swept completely off the screen.
      const reach = size * 1.7;
      if (flyby.age > 1 && (x < -reach || x > width + reach || y < -reach || y > height + reach || flyby.z < 0.03)) {
        flyby.active = false;
        return;
      }

      const [r, g, b] = palette[flyby.color];
      const target = lightTheme ? 0 : 255;
      const mix = lightTheme ? 0.15 : 0.62;
      const ink = `${Math.round(r + (target - r) * mix)}, ${Math.round(g + (target - g) * mix)}, ${Math.round(b + (target - b) * mix)}`;
      const fade = Math.min(1, flyby.age / FLYBY_FADE_IN_S);
      const strength = fade * (0.35 + 0.65 * Math.min(1, depth * 2.2)) * (lightTheme ? 0.85 : 0.95);

      // Speed trail: where it was a moment ago, further in along the same line
      // from the vanishing point.
      const invZPrev = 1 / Math.max(flyby.z + FLYBY_SPEED * FLYBY_TRAIL_S, 0.02);
      const prevX = focalX + flyby.wx * skyHalfWidth * invZPrev + floatX + flyby.pushX;
      const prevY = focalY + flyby.wy * skyHeight * invZPrev + floatY + flyby.pushY;
      if (Math.hypot(x - prevX, y - prevY) > 3) {
        const trail = ctx!.createLinearGradient(prevX, prevY, x, y);
        trail.addColorStop(0, `rgba(${ink}, 0)`);
        trail.addColorStop(1, `rgba(${ink}, ${(0.55 * strength).toFixed(3)})`);
        ctx!.strokeStyle = trail;
        ctx!.lineWidth = Math.max(1.5, size * 0.28);
        ctx!.lineCap = "round";
        ctx!.beginPath();
        ctx!.moveTo(prevX, prevY);
        ctx!.lineTo(x, y);
        ctx!.stroke();
      }

      // A soft glow behind it.
      const glow = ctx!.createRadialGradient(x, y, 0, x, y, size * 2.2);
      glow.addColorStop(0, `rgba(${ink}, ${(0.42 * strength).toFixed(3)})`);
      glow.addColorStop(1, `rgba(${ink}, 0)`);
      ctx!.fillStyle = glow;
      ctx!.fillRect(x - size * 2.2, y - size * 2.2, size * 4.4, size * 4.4);

      ctx!.save();
      ctx!.translate(x, y);
      ctx!.rotate(flyby.tilt + flyby.spin * flyby.age + Math.sin(t * 0.012 + flyby.seed) * 0.06);
      ctx!.scale(size, size);
      ctx!.globalAlpha = strength;
      drawFlybyShape(flyby.kind, ink, size, flyby.age, flyby.seed);
      ctx!.restore();
      ctx!.globalAlpha = 1;
    }

    function tick(now: number) {
      rafId = requestAnimationFrame(tick);
      // Nothing is visible, so nothing to draw — and forget the clocks so the
      // first frame back doesn't see a huge gap.
      if (document.hidden) {
        lastTickAt = null;
        lastRafAt = null;
        return;
      }
      const p = TIERS[getTier()];
      // Report the real display cadence on EVERY callback (drawn or not): the
      // auto-quality governor needs to know how the whole page is keeping up,
      // not how often this canvas chose to redraw.
      if (lastRafAt !== null && focused) reportFrame(now - lastRafAt);
      lastRafAt = now;
      const minFrameMs = isIdle() ? Math.max(p.frameMs, IDLE_FRAME_MS) : p.frameMs;
      if (lastTickAt !== null && now - lastTickAt < minFrameMs * 0.8) return;
      const frameGapMs = lastTickAt === null ? 0 : now - lastTickAt;
      lastTickAt = now;

      // Everything below was tuned per 60fps frame; `step` is "how many
      // 60fps frames of time just passed" (clamped so a long stall doesn't
      // teleport the field).
      const step = Math.min(6, frameGapMs / 16.667 || 1);
      const dt = Math.min(0.1, frameGapMs / 1000);
      t += step;
      const pushEase = 1 - Math.pow(1 - PUSH_EASE, step);

      if (paletteDirty && now - lastPaletteRead > 250) {
        lightTheme = isLightTheme();
        palette = readPalette();
        colorTable = buildColorTable(palette, lightTheme);
        buildAuroraSprites();
        paletteDirty = false;
        lastPaletteRead = now;
      }

      ctx!.clearRect(0, 0, width, height);
      // Back to front: the aurora ribbons, the scrolling grid, then the stars.
      // Both animate at every tier and in both themes — at the canvas's own
      // capped rate, so they cost no extra frames.
      auroraT += dt;
      drawAurora();
      gridPhase = (gridPhase + dt / GRID_ROW_PERIOD_S) % 1;
      drawGrid();
      const haloOn = p.halo;

      updateFocus();
      const travelDz = TRAVEL_SPEED * dt;
      for (let i = 0; i < stars.length; i++) {
        const star = stars[i];
        star.age += dt;
        star.z -= travelDz;
        // Flown off the screen (past its exit distance) — back to the far plane.
        if (star.z < star.exitZ * RESPAWN_PAST_EXIT) {
          respawnStar(star, false);
        }
        // Distance in -> size/brightness/glow/push strength. 0 = far plane, 1 = close.
        star.depth = Math.pow(1 - star.z, 1.25);

        // Perspective projection from the vanishing point.
        const invZ = 1 / star.z;
        const projX = focalX + star.wx * skyHalfWidth * invZ;
        const projY = focalY + star.wy * skyHeight * invZ;

        const bobAmp = star.floatAmp * (1.6 + star.depth * 4.4) * 0.6;
        const floatX = Math.sin(t * 0.01 * star.floatSpeed + star.floatSeedX) * bobAmp;
        const floatY = Math.cos(t * 0.011 * star.floatSpeed + star.floatSeedY) * bobAmp;
        // Faint size breathe on top of the flight.
        const zBob = Math.sin(t * 0.008 * star.floatSpeed + star.floatSeedZ);
        const baseX = projX + floatX;
        const baseY = projY + floatY;

        // Local cursor repel, measured against the star's ACTUAL position.
        const dx = baseX - cursor.x;
        const dy = baseY - cursor.y;
        const d2 = dx * dx + dy * dy;
        let targetPushX = 0;
        let targetPushY = 0;
        let repelIntensity = 0;
        if (d2 < REPEL_RADIUS_SQ) {
          const dist = Math.sqrt(d2);
          // Eased quadratic falloff so the push is strong right next to the
          // cursor and tapers gently well before the radius edge.
          const t2 = 1 - dist / REPEL_RADIUS_PX;
          repelIntensity = t2 * t2;
          const pushMag = REPEL_STRENGTH_PX * repelIntensity * (0.35 + star.depth * 0.65);
          const safeDist = dist || 0.0001;
          targetPushX = (dx / safeDist) * pushMag;
          targetPushY = (dy / safeDist) * pushMag;
        }
        star.pushX += (targetPushX - star.pushX) * pushEase;
        star.pushY += (targetPushY - star.pushY) * pushEase;

        const screenX = baseX + star.pushX;
        const screenY = baseY + star.pushY;
        // Off the visible area (the margin covers glow and streak): nothing to draw.
        if (screenX < -40 || screenX > width + 40 || screenY < -40 || screenY > height + 40) continue;

        // Closer stars swell as they dodge the cursor and breathe on their
        // own; distant ones barely change.
        const sizeScale = 1 + zBob * 0.16 * star.depth + repelIntensity * 0.4 * star.depth;
        const size = (0.5 + star.depth * 2.6) * sizeScale;
        const twinkle = 0.55 + 0.45 * Math.sin(t * 0.02 * star.twinkleSpeed + star.twinkleSeed);
        const lifeAlpha = Math.min(1, star.age / FADE_IN_S);
        const alpha = Math.min(1, Math.min(1, 0.25 + star.depth * 0.75) * twinkle * lifeAlpha);
        if (alpha < 0.02) continue;

        const tint = colorTable[star.colorPick][star.whiteIdx];
        ctx!.fillStyle = tint;

        // Speed streak: where this star was a moment ago, a little further out
        // along the same line from the vanishing point. Nearer stars move fastest,
        // so they get the longest trails; the far field stays as plain points.
        if (star.depth > STREAK_MIN_DEPTH) {
          const invZPrev = 1 / (star.z + TRAVEL_SPEED * STREAK_SECONDS);
          const prevX = focalX + star.wx * skyHalfWidth * invZPrev + floatX + star.pushX;
          const prevY = focalY + star.wy * skyHeight * invZPrev + floatY + star.pushY;
          if (Math.hypot(screenX - prevX, screenY - prevY) > STREAK_MIN_PX) {
            ctx!.globalAlpha = alpha * 0.5;
            ctx!.strokeStyle = tint;
            ctx!.lineWidth = Math.max(1, size * 0.9);
            ctx!.lineCap = "round";
            ctx!.beginPath();
            ctx!.moveTo(prevX, prevY);
            ctx!.lineTo(screenX, screenY);
            ctx!.stroke();
          }
        }

        // Soft glow for the brighter, closer stars (high tier only).
        if (haloOn && star.depth > 0.55) {
          ctx!.globalAlpha = alpha * 0.16;
          ctx!.beginPath();
          ctx!.arc(screenX, screenY, size * 3.2, 0, TAU);
          ctx!.fill();
        }
        ctx!.globalAlpha = alpha;
        if (size < 1.1) {
          // Sub-pixel points: a tiny square is indistinguishable from a
          // circle here and far cheaper to fill.
          ctx!.fillRect(screenX - size, screenY - size, size * 2, size * 2);
        } else {
          ctx!.beginPath();
          ctx!.arc(screenX, screenY, size, 0, TAU);
          ctx!.fill();
        }
      }
      ctx!.globalAlpha = 1;

      // The flyby: a new one starts every 15-30s (not while the app is idle — the
      // field is only trickling then, and an object would just stutter across).
      // Unlike the satellite and meteors this runs on every quality tier: it is a
      // single small shape, and the canvas is being redrawn anyway.
      flybyClockS += dt;
      if (!flyby.active && flybyClockS >= nextFlybyAtS && !isIdle()) {
        startFlyby();
        nextFlybyAtS = flybyClockS + FLYBY_MIN_GAP_S + Math.random() * (FLYBY_MAX_GAP_S - FLYBY_MIN_GAP_S);
      }
      if (flyby.active) drawFlyby(dt);

      if (p.extras) {
        clockS += dt;
        orbitAngle = (orbitAngle + (TAU / ORBIT.periodS) * dt) % TAU;
        drawSatellite();
        // Meteors: one at a time, at random intervals (white on the dark sky,
        // in the accent color on the light theme).
        if (!meteor.active && clockS >= nextMeteorAtS) {
          meteor.active = true;
          meteor.age = 0;
          meteor.x = width * (0.05 + Math.random() * 0.7);
          meteor.y = height * (0.03 + Math.random() * 0.3);
          nextMeteorAtS = clockS + 12 + Math.random() * 16;
        }
        if (meteor.active) drawMeteor(dt);
      }
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      paletteObserver.disconnect();
      unsubscribeTier();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("clynx:flyby", onFlybyRequest);
      document.documentElement.removeAttribute("data-grid-live");
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseout", onMouseLeave);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
}
