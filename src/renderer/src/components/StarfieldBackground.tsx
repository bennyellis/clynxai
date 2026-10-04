import React, { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
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
  // Per explicit instruction ("make them whiter... range between 50-80%
  // white") — how far this star's own accent color is blended toward pure
  // white (see the mix math in tick()), picked once at spawn so each star
  // keeps a consistent tint rather than flickering between colors.
  whiteMix: number;
  // Per explicit instruction ("spawn in and out having a max life of 7s") —
  // seconds this star has been alive (real elapsed time, see dt in tick(),
  // not the frame counter t used for sine phases) and the seconds it gets
  // before respawnStar replaces it somewhere new. Randomized per star (see
  // respawnStar) so the whole field doesn't blink in/out in unison.
  age: number;
  lifespanSeconds: number;
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
function readPalette(): [number, number, number][] {
  const styles = getComputedStyle(document.documentElement);
  return [
    hexToRgbNumbers(styles.getPropertyValue("--accent-1"), [124, 108, 246]),
    hexToRgbNumbers(styles.getPropertyValue("--accent-2"), [168, 85, 247]),
    hexToRgbNumbers(styles.getPropertyValue("--accent-3"), [79, 142, 247]),
  ];
}

// Per explicit instruction — replaces the old flat, connected-dot
// "geometric network" backdrop with a dense, heavily-3D-ized star field,
// modeled on a real night-sky photo reference: mostly tiny, dim, distant
// points with a much smaller number of large, bright, softly-glowing close
// ones (depth is drawn from Math.pow(random, 2.5), which skews hard toward
// 0/far — real starfields are not an even mix of sizes). Ambient drift is
// slow and wraps at the edges rather than "flying toward camera" — this is
// a calm background texture, not a warp-speed effect.
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let stars: Star[] = [];
    let rafId = 0;
    let t = 0;

    // Raw viewport pixel coordinates (not normalized to center — the repel
    // effect below needs real on-screen distance to each star, not a
    // whole-field direction). Sentinel far off-screen so nothing is "near"
    // the cursor before the first real mousemove or after it leaves the
    // window.
    const cursor = { x: -9999, y: -9999 };

    let palette = readPalette();
    // Colors only ever change on an explicit Config pick (a color-wheel
    // drag or a theme switch) — cheap enough to just re-read the whole
    // palette on any such change. "style" catches lib/colorScheme.ts's
    // inline custom-property writes; "data-theme" catches the light/dark
    // toggle.
    const paletteObserver = new MutationObserver(() => {
      palette = readPalette();
    });
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    // How close the cursor has to be (in screen px) before a star reacts at
    // all — this IS the "local, not the whole field" boundary. Outside
    // this radius, a star's pushX/pushY eases straight back to zero same
    // as any other star on the page. Enlarged per explicit instruction
    // ("make its effect larger").
    const REPEL_RADIUS_PX = 240;
    // Displacement at zero distance (cursor directly on a depth-1/closest
    // star) — scaled down for both farther stars (by depth below) and by
    // the radius falloff as distance grows toward REPEL_RADIUS_PX.
    // Enlarged per explicit instruction ("make its effect larger").
    const REPEL_STRENGTH_PX = 160;
    // How fast pushX/pushY chases its target each frame. Per explicit
    // instruction ("slow down its reaction") — lowered from an earlier,
    // snappier 0.18 so the push visibly winds up and unwinds rather than
    // flinching into place; the larger REPEL_STRENGTH_PX above is what
    // keeps the FINAL displacement big despite the slower approach.
    const PUSH_EASE = 0.05;

    // Per explicit instruction ("spawn in and out having a max life of
    // 7s") — each star lives a random duration up to this max, then
    // respawnStar below replaces it elsewhere; randomized (not all
    // exactly 7s) so deaths/rebirths stay staggered across the field
    // instead of the whole thing blinking at once. Fade durations are
    // kept well under MIN_LIFESPAN_S so even the shortest-lived star still
    // has a stretch of full visibility between fading in and fading out.
    const MAX_LIFESPAN_S = 7;
    const MIN_LIFESPAN_S = 3;
    const FADE_IN_S = 0.6;
    const FADE_OUT_S = 1.0;

    // Mutates `star` in place with a fresh random identity (new position,
    // depth, seeds, lifespan) rather than allocating a new object — used
    // both for the very first fill (see resize()) and every respawn after
    // a star's lifespan expires, so the array itself never changes shape.
    // `staggerAge`, true only on that initial fill, seeds age to a random
    // point within the new lifespan instead of 0 — otherwise every star
    // on the very first frame would start its fade-in at the exact same
    // instant, reading as one single flash-in rather than an already-alive
    // field. Real respawns during runtime always start at age 0 so the
    // fade-in is actually visible when it happens.
    function respawnStar(star: Star, staggerAge: boolean): void {
      // Skews hard toward 0 (far/tiny/dim) with an occasional standout —
      // see the component doc comment above for why an even distribution
      // doesn't read as a real starfield.
      const depth = Math.pow(Math.random(), 2.5);
      const lifespanSeconds = MIN_LIFESPAN_S + Math.random() * (MAX_LIFESPAN_S - MIN_LIFESPAN_S);
      star.x = Math.random() * width;
      star.y = Math.random() * height;
      star.vx = (Math.random() - 0.5) * 0.05;
      star.vy = (Math.random() - 0.5) * 0.05;
      star.depth = depth;
      star.twinkleSeed = Math.random() * Math.PI * 2;
      // Per explicit instruction ("twinkle more") — widened from an
      // earlier 0.4-1.8 range so a visibly larger share of stars sparkle
      // fast enough to actually notice, not just the occasional one.
      star.twinkleSpeed = 0.5 + Math.random() * 2.2;
      star.colorPick = Math.floor(Math.random() * 3) as 0 | 1 | 2;
      star.floatSeedX = Math.random() * Math.PI * 2;
      star.floatSeedY = Math.random() * Math.PI * 2;
      star.floatSeedZ = Math.random() * Math.PI * 2;
      // Per explicit instruction ("float around... more") — roughly
      // doubled from an earlier (0.8+2.2*depth) amplitude and widened the
      // speed range, so the drift reads as genuinely alive rather than
      // barely perceptible, while still scaling with depth so distant
      // stars stay calmer than close ones.
      star.floatSpeed = 0.25 + Math.random() * 0.75;
      star.floatAmp = (1.6 + depth * 4.4) * (0.5 + Math.random() * 0.6);
      star.pushX = 0;
      star.pushY = 0;
      // Per explicit instruction ("make them whiter... range between
      // 50-80% white") — how far this star's accent color gets blended
      // toward white in tick(), fixed for its whole life.
      star.whiteMix = 0.5 + Math.random() * 0.3;
      star.lifespanSeconds = lifespanSeconds;
      star.age = staggerAge ? Math.random() * lifespanSeconds : 0;
    }

    function spawnStar(staggerAge: boolean): Star {
      const star = {} as Star;
      respawnStar(star, staggerAge);
      return star;
    }

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A real starfield photo is DENSE — most of these are cheap (tiny,
      // no glow), so this can afford to be a lot higher than a network of
      // connected dots ever could. Per explicit instruction ("a lot more
      // particles") — roughly doubled both the floor/ceiling and the
      // density (smaller divisor) from an earlier 160-420 range.
      const count = Math.min(900, Math.max(320, Math.floor((width * height) / 1700)));
      stars = Array.from({ length: count }, () => spawnStar(true));
    }
    resize();

    function onMouseMove(e: MouseEvent) {
      cursor.x = e.clientX;
      cursor.y = e.clientY;
    }
    function onMouseLeave() {
      cursor.x = -9999;
      cursor.y = -9999;
    }

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseout", onMouseLeave);

    // Real elapsed time (seconds) since the previous frame — needed for
    // star.age (a wall-clock lifespan), unlike `t` above which is just a
    // frame counter driving sine phases and doesn't need to track actual
    // time. Clamped so a backgrounded/throttled tab resuming after a long
    // pause doesn't instantly age every star past its lifespan at once.
    let lastTime: number | null = null;

    function tick(now: number) {
      const dt = lastTime === null ? 0 : Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      t += 1;

      ctx!.clearRect(0, 0, width, height);

      for (let i = 0; i < stars.length; i++) {
        let star = stars[i];
        star.age += dt;
        if (star.age >= star.lifespanSeconds) {
          respawnStar(star, false);
        }

        star.x += star.vx;
        star.y += star.vy;
        // Wrap, don't bounce — an ambient field drifting slowly past
        // rather than particles bouncing off walls.
        if (star.x < -5) star.x = width + 5;
        else if (star.x > width + 5) star.x = -5;
        if (star.y < -5) star.y = height + 5;
        else if (star.y > height + 5) star.y = -5;

        const floatX = Math.sin(t * 0.01 * star.floatSpeed + star.floatSeedX) * star.floatAmp;
        const floatY = Math.cos(t * 0.011 * star.floatSpeed + star.floatSeedY) * star.floatAmp;
        // Faint faux-z bob (see the Star interface's own comment on
        // floatSeedZ) — no positional effect, just a size/brightness
        // breathe further down, so a star reads as gently coasting nearer
        // and farther even with the cursor nowhere near it.
        const zBob = Math.sin(t * 0.008 * star.floatSpeed + star.floatSeedZ);
        const baseX = star.x + floatX;
        const baseY = star.y + floatY;

        // Local cursor repel: distance is measured against this star's
        // ACTUAL current position (baseX/Y, post-drift-and-float), not the
        // whole viewport, so only stars genuinely near the cursor are ever
        // considered — this is the "local, not everything at once" fix.
        const dx = baseX - cursor.x;
        const dy = baseY - cursor.y;
        const dist = Math.hypot(dx, dy);
        let targetPushX = 0;
        let targetPushY = 0;
        let repelIntensity = 0;
        if (dist < REPEL_RADIUS_PX) {
          // Eased quadratic falloff (not linear) so the push feels strong
          // right next to the cursor and tapers off gently well before the
          // radius edge, instead of a hard, linear-feeling cutoff.
          const t2 = 1 - dist / REPEL_RADIUS_PX;
          repelIntensity = t2 * t2;
          const pushMag = REPEL_STRENGTH_PX * repelIntensity * (0.35 + star.depth * 0.65);
          const safeDist = dist || 0.0001;
          targetPushX = (dx / safeDist) * pushMag;
          targetPushY = (dy / safeDist) * pushMag;
        }
        star.pushX += (targetPushX - star.pushX) * PUSH_EASE;
        star.pushY += (targetPushY - star.pushY) * PUSH_EASE;

        const screenX = baseX + star.pushX;
        const screenY = baseY + star.pushY;

        // 3D read on the movement itself: the same depth value that makes
        // close stars bigger/brighter also makes their SIZE visibly swell
        // as they dodge the cursor (repelIntensity) and gently breathe on
        // their own (zBob) — distant stars barely change either way, the
        // same "closer = more affected" cue the old global parallax used,
        // now driven by actual local motion instead of a flat tilt.
        const sizeScale = 1 + zBob * 0.16 * star.depth + repelIntensity * 0.4 * star.depth;
        const size = (0.5 + star.depth * 2.6) * sizeScale;
        // Per explicit instruction ("twinkle more") — amplitude widened
        // from an earlier 0.8±0.2 (0.6-1.0) to 0.55±0.45 (0.1-1.0), so
        // stars visibly flare and dim instead of just faintly flickering.
        const twinkle = 0.55 + 0.45 * Math.sin(t * 0.02 * star.twinkleSpeed + star.twinkleSeed);
        // Fades a star in from birth and out before its lifespan expires
        // (see MAX_LIFESPAN_S/FADE_*_S above) — the smaller of the two
        // ramps wins, so a star is only ever at full life-opacity once
        // it's past its fade-in AND still well before its fade-out.
        const fadeInFrac = Math.min(1, star.age / FADE_IN_S);
        const fadeOutFrac = Math.min(1, (star.lifespanSeconds - star.age) / FADE_OUT_S);
        const lifeAlpha = Math.max(0, Math.min(fadeInFrac, fadeOutFrac));
        const alpha = Math.min(1, 0.25 + star.depth * 0.75) * twinkle * lifeAlpha;

        // Per explicit instruction ("make them whiter... range between
        // 50-80% white") — blends this star's own accent color toward
        // white by its own fixed whiteMix, so the field reads as a mix of
        // tinted and near-white points rather than uniformly saturated.
        const base = palette[star.colorPick];
        const mixR = base[0] + (255 - base[0]) * star.whiteMix;
        const mixG = base[1] + (255 - base[1]) * star.whiteMix;
        const mixB = base[2] + (255 - base[2]) * star.whiteMix;
        const rgb = `${mixR}, ${mixG}, ${mixB}`;

        // Glow only the brighter/closer stars — canvas shadowBlur is one
        // of the more expensive 2D operations, and on the dim, sub-pixel
        // majority it wouldn't be visible anyway.
        if (star.depth > 0.55) {
          ctx!.shadowColor = `rgba(${rgb}, ${Math.min(1, alpha)})`;
          ctx!.shadowBlur = 3 + star.depth * 7;
        } else {
          ctx!.shadowBlur = 0;
        }

        ctx!.beginPath();
        ctx!.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx!.arc(screenX, screenY, size, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.shadowBlur = 0;

      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      paletteObserver.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseout", onMouseLeave);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
}
