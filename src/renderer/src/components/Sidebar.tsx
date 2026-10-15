import React, { useEffect, useState } from "react";
import clynxMarkSrc from "../assets/clynx/clynx-mark.png";
import { getTier, isIdle } from "../lib/performance.js";

export type Screen = "dashboard" | "activity" | "feed" | "watch" | "database" | "config";

const CLYNX_ICON_SIZE = 40;
const CLYNX_LOCKUP_GAP = 12;
// The sidebar is 220px wide with 14px padding each side, and the lockup
// itself adds 4px each side (see the JSX below) — 220 - 28 - 8 = 184,
// minus a little headroom for rounding/kerning slop.
const CLYNX_LOCKUP_MAX_WIDTH = 178;

// Two guesses at the wordmark's font-size were tried before this and both
// were visibly wrong in the actual app (once too short relative to the
// icon, once so wide it wrapped to two lines) — guessing font metrics from
// outside a real browser just doesn't work reliably. This measures the
// ACTUAL rendered glyphs in the ACTUAL browser this component is running
// in via canvas.measureText (real per-user, per-OS font metrics, not a
// guess), then solves for the font-size that makes "x"'s real ink height
// equal iconSize — i.e. genuinely the same height as the icon, not just
// the same font-size number — and finally clamps that down if the word at
// that size wouldn't fit maxWidth (icon + gap already subtracted), so it
// can never wrap or overflow the sidebar regardless of what font actually
// loads.
function useMatchedWordmarkFontSize(word: string, iconSize: number, maxWidth: number): number {
  const [fontSize, setFontSize] = useState(iconSize * 1.6);
  useEffect(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const probe = 200;
    ctx.font = `300 ${probe}px "Segoe UI", "Century Gothic", sans-serif`;
    const xMetrics = ctx.measureText("x");
    const xHeight = xMetrics.actualBoundingBoxAscent + xMetrics.actualBoundingBoxDescent;
    if (!xHeight) return;
    let target = (iconSize / xHeight) * probe;
    ctx.font = `300 ${target}px "Segoe UI", "Century Gothic", sans-serif`;
    const wordWidth = ctx.measureText(word).width;
    if (wordWidth > maxWidth) target *= maxWidth / wordWidth;
    setFontSize(Math.round(target));
  }, [word, iconSize, maxWidth]);
  return fontSize;
}

function IconSvg({ className, children, size = 21 }: { className?: string; children: React.ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

// Speedometer — redrawn after the user's reference image: a half-circle dial
// whose band is hairline-thin at the left and thick at the right (the inner
// edge is a smaller circle shifted left, so the two edges meet at the left
// end), with a teardrop needle pivoting on a round hub. Filled shapes in
// currentColor, so it still takes the nav color when idle and turns green
// when `live` (the Facebook accounts OR the eBay engine are searching).
//
// The needle is parked all the way to the LEFT when idle and swings all the
// way to the RIGHT while the nav item is hovered. When the scanner STARTS
// (`live` flips on), the needle sweeps left to right slowly enough to watch
// while the icon fades red -> green in lockstep (both driven by one animated
// number, see global.css's --speedo-run); once there it holds at the right
// and subtly fluctuates, with three motion lines streaming off the left of
// the dial (they sit outside the 24-unit box, which global.css lets
// overflow). Stopping runs it back: needle to the left, color fading out.
//
// Geometry (24-unit box): outer arc is a semicircle centered (12,17) r=10;
// the inner edge is centered (10,17) r=8, so the band is 0 wide at x=2 and 4
// wide at x=22. The needle's hub is (10,16.4) r=1.6, tip (16.6,10.6).
function SpeedometerIcon({ live }: { live: boolean }) {
  return (
    <IconSvg className={`icon-speedometer${live ? " is-live" : ""}`} size={26}>
      <path d="M2 17A10 10 0 0 1 22 17L18 17A8 8 0 0 0 2 17Z" fill="currentColor" stroke="none" />
      {/* Two nested groups sharing one pivot: the outer one holds the POSE
          (parked all the way left; swings all the way right on hover), the
          inner one holds the live-scanning wobble, so the two animations
          never fight over the same transform. */}
      <g className="icon-speedometer-needle-group">
        <g className="icon-speedometer-needle-wobble">
          <path d="M10.941 17.694L16.6 10.6L9.059 15.106A1.6 1.6 0 0 0 10.941 17.694Z" fill="currentColor" stroke="none" />
        </g>
      </g>
      <g className="icon-speedometer-speedlines">
        <path className="icon-speedometer-speedline icon-speedometer-speedline-1" d="M0.5 9.5h-3" />
        <path className="icon-speedometer-speedline icon-speedometer-speedline-2" d="M0.5 13h-4" />
        <path className="icon-speedometer-speedline icon-speedometer-speedline-3" d="M0.5 16.5h-3" />
      </g>
    </IconSvg>
  );
}

// Gear — the standard settings/config cog shape. Spins on hover — see
// global.css's iconGearSpin.
function GearIcon() {
  return (
    <IconSvg className="icon-gear">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </IconSvg>
  );
}

// "i" info bubble — a plain circle with an i, for the reference/knowledge
// screen rather than the old hex/cell glyph. Per explicit instruction, only
// the DOT lights up on hover (a little glow, like a light turning on) — see
// global.css's iconDotLightUp, applied to icon-info-dot alone; the circle
// and stem stay still.
// While something in the Database is actively happening (a product being researched, photos being filled in) a green copy of
// the icon fades in over it and back out, over and over (opacity only: see global.css's iconDatabaseGlow).
function InfoBubbleIcon({ busy }: { busy: boolean }) {
  return (
    <IconSvg className={`icon-info${busy ? " is-busy" : ""}`}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line className="icon-info-dot" x1="12" y1="8" x2="12.01" y2="8" />
      {busy && (
        <g className="icon-info-glow" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </g>
      )}
    </IconSvg>
  );
}

// Per explicit instruction — each line fades in on its own, staggered, on
// hover (see global.css's iconLineFadeIn) rather than the whole icon moving.
function FeedIcon() {
  return (
    <IconSvg className="icon-feed">
      <line className="icon-feed-line-1" x1="4" y1="6" x2="20" y2="6" />
      <line className="icon-feed-line-2" x1="4" y1="12" x2="20" y2="12" />
      <line className="icon-feed-line-3" x1="4" y1="18" x2="20" y2="18" />
    </IconSvg>
  );
}

// Per explicit instruction — "when the user hovers over the Watch
// navigation item, animate the eye with a quick, natural blink: open →
// closed → open. Do not make it continuously flash." One-shot hover
// animation, same idiom as InfoBubbleIcon's iconDotLightUp above (no
// `infinite`, targets one tagged sub-element) — see global.css's
// iconEyeBlink, a scaleY squash-and-release on this whole group rather
// than a path morph (CSS can't animate between two different `d` shapes
// without a JS library; a vertical squash reads as a blink just as well
// and needs none).
//
// Per explicit instruction — while Watch is actually running (not paused, at
// least one watch enabled) the eye turns the scanner's green, the pupil looks
// around (global.css's iconEyeLook, on the inner group so it never fights the
// blink for the same transform) and the eye blinks on its own at a random
// 7-10 second interval. The blink reuses the hover animation by toggling
// `is-blinking` for one beat — a real timer, since a CSS loop can't be random.
// Per explicit instruction — "whenever a Watch is active but not currently viewing anything, have the Watch icon close its
// eye and go to sleep when it's not currently searching on its active interval." So an active Watch has two states: awake
// (a check is running: the eye is open, looking around, blinking) and asleep (waiting for its next interval: the lid is
// shut and a couple of Zs drift up). `searching` flips as each check starts and ends.
function WatchIcon({ live, searching }: { live: boolean; searching: boolean }) {
  const asleep = live && !searching;
  const awake = live && searching;
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (!awake) {
      setBlinking(false);
      return;
    }
    let scheduleTimer: ReturnType<typeof setTimeout>;
    let blinkTimer: ReturnType<typeof setTimeout>;
    function scheduleNext() {
      scheduleTimer = setTimeout(() => {
        setBlinking(true);
        blinkTimer = setTimeout(() => {
          setBlinking(false);
          scheduleNext();
        }, 320);
      }, 7000 + Math.random() * 3000);
    }
    scheduleNext();
    return () => {
      clearTimeout(scheduleTimer);
      clearTimeout(blinkTimer);
    };
  }, [awake]);
  return (
    <IconSvg className={`icon-watch${live ? " is-live" : ""}${asleep ? " is-asleep" : ""}${blinking ? " is-blinking" : ""}`}>
      <g className="icon-watch-lid">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <g className="icon-watch-look">
          <circle cx="12" cy="12" r="3" />
        </g>
      </g>
      {/* The sleeping eye's Zs: only visible (and only animating) while asleep. */}
      {/* Drawn as lines, not text, so the nav button's own label stays just "Watch". */}
      <polyline className="icon-watch-z icon-watch-z1" points="15.5 4.5 19.5 4.5 15.5 9 19.5 9" />
      <polyline className="icon-watch-z icon-watch-z2" points="19.6 0.8 22.4 0.8 19.6 3.8 22.4 3.8" />
    </IconSvg>
  );
}

// Pulse/EKG line — the standard "activity" glyph, for the scan log's own
// page. Per explicit instruction, this should actually mimic a heart
// monitor rather than just bouncing — the line "draws" itself left to
// right on hover (a classic stroke-dashoffset reveal, see global.css's
// iconEkgDraw). While scanning is actually running, in the scanner's success
// color, it draws the line, holds, ERASES it, then draws it again (see
// global.css's iconEkgDrawErase) — see Sidebar's own `running` prop below.
function ActivityIcon({ live }: { live: boolean }) {
  return (
    <IconSvg className={`icon-activity${live ? " is-live" : ""}`}>
      {/* Points deliberately listed left-to-right (2,12 -> 22,12), the
          reverse of the standard Feather "activity" glyph's own order —
          same rendered shape either way, but global.css's iconEkgDraw
          stroke-dashoffset reveal draws from the path's FIRST point
          onward, so this is what makes the trace actually sweep left to
          right instead of right to left. */}
      <polyline className="icon-activity-line" points="2 12 6 12 9 3 15 21 18 12 22 12" />
    </IconSvg>
  );
}

// Per explicit instruction — the actual Clynx brand mark (the user's own
// file, trimmed/resized but otherwise unedited — see assets/clynx), not a
// hand-built recreation. It's a plain white line-art PNG with a real alpha
// channel (transparent everywhere except the linework itself), which is
// what makes the mask-based color layer below possible: `mask-image` reads
// that same alpha shape, so anything painted underneath it only shows up
// exactly where the logo's lines are.
//
// Two layers, stacked exactly on top of each other:
// 1. The image itself, always fully visible — the "all white" resting look.
// 2. A diagonal gradient band masked to the same shape, continuously
//    translated across it — see global.css's clynxMarkComet. A rotating
//    conic gradient was the first attempt here and looked wrong: a radial
//    sweep from the shape's center lights up whatever the current angle
//    happens to cross, which for a shape this irregular flares up
//    disconnected parts at once instead of reading as one thing moving.
//    A single beam translating in a consistent direction reads much more
//    like color actually traveling along the lines, with the rest of the
//    logo staying plain white underneath it wherever the beam currently
//    isn't. A true "flows along this exact path" trace isn't possible
//    without vector path data (only a raster image was available), but
//    this is the closest raster equivalent.
function ClynxMark({ size = 34 }: { size?: number }) {
  const maskStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    WebkitMaskImage: `url(${clynxMarkSrc})`,
    maskImage: `url(${clynxMarkSrc})`,
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
  };
  // The light sweeps across the mark once every ~25 s (never continuously) and only in the Visual effects mode; skipped while idle.
  const [go, setGo] = useState(false);
  useEffect(() => {
    let off: ReturnType<typeof setTimeout> | null = null;
    const play = () => {
      if (getTier() !== "visual" || isIdle() || document.hidden) return;
      setGo(true);
      off = setTimeout(() => setGo(false), 3000);
    };
    const first = setTimeout(play, 4000);
    const every = setInterval(play, 25_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      if (off) clearTimeout(off);
    };
  }, []);
  return (
    <div className="clynx-mark" style={{ position: "relative", width: size, height: size }} aria-hidden="true">
      <img src={clynxMarkSrc} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
      <div className="clynx-mark-comet" style={maskStyle}>
        <div className={go ? "clynx-mark-comet-band comet-go" : "clynx-mark-comet-band"} />
      </div>
    </div>
  );
}

export function Sidebar({
  active,
  onSelect,
  loggedIn,
  runningCount,
  accountCount,
  ebaySearching,
  facebookEnabled,
  watchRunning,
  watchSearching,
  databaseBusy,
  hasUnseenWatchMatches,
}: {
  active: Screen;
  onSelect: (s: Screen) => void;
  // Per explicit instruction — multiple Facebook accounts: aggregated
  // across all of them (see App.tsx) rather than one flat boolean, since
  // there's no single "the" login/running state anymore. loggedIn stays
  // tri-state (true if ANY account is logged in, false if none are but at
  // least one status is known, null if nothing's known yet) since the
  // Sidebar is a glance-level summary, not a per-account breakdown — that
  // detail lives on Dashboard.
  loggedIn: boolean | null;
  runningCount: number;
  accountCount: number;
  // The eBay engine isn't one of the Facebook accounts counted above, but
  // it is "actively searching" all the same — folded into the green
  // Dashboard/Activity icons and the footer status text. (App.tsx only passes
  // true when eBay is searching for Search For items; eBay searching on behalf
  // of a Watch alone is Watch activity, not the scanner.)
  ebaySearching: boolean;
  // Whether Facebook scanning is switched on in Config. The Dashboard's
  // "scanner" is the Start Scanner button, i.e. the Facebook accounts; eBay is a
  // separate background poller with no button of its own. So eBay lights the
  // Dashboard/Activity icons only when Facebook is off and eBay is therefore
  // the only scanning there is.
  facebookEnabled: boolean;
  // Watch is on (not paused, at least one watch enabled) — drives the green,
  // looking-around Watch eye. Independent of `running` above, so the scanner
  // and Watch can each be live on their own or both at once.
  watchRunning: boolean;
  // A Watch's check is running right now: the eye is awake. False while an active Watch waits for its next interval (asleep).
  watchSearching: boolean;
  // Something in the Database is actively happening right now (research running, photos being filled in): its icon glows green.
  databaseBusy: boolean;
  // Per explicit instruction — "a subtle indicator/pulse until the user
  // visits Watch." App.tsx derives this from api.hasUnseenWatchMatches
  // (compares real match timestamps against config.watch.matchesLastViewedAt
  // — see index.ts's watch:hasUnseenMatches) rather than Sidebar knowing
  // anything about Watch's own data model.
  hasUnseenWatchMatches: boolean;
}) {
  const running = runningCount > 0 || ebaySearching;
  // What the Dashboard and Activity ICONS follow: the scanner proper (see
  // facebookEnabled above). `running` still drives the footer status, which
  // names eBay explicitly ("eBay searching").
  const scannerLive = runningCount > 0 || (ebaySearching && !facebookEnabled);
  // Per explicit instruction — "an occasional but random glitch effect" on
  // the logo. A fixed-period CSS loop would read as mechanically regular;
  // this instead schedules each burst at a genuinely random delay (4-10s)
  // via a real timer, so the effect fires unpredictably rather than on a
  // metronome. `glitching` just toggles a class on for the short burst
  // window — see global.css's clynxGlitchBurst for what actually happens
  // to the logo while it's on.
  const [glitching, setGlitching] = useState(false);
  const wordmarkFontSize = useMatchedWordmarkFontSize(
    "clynx",
    CLYNX_ICON_SIZE,
    CLYNX_LOCKUP_MAX_WIDTH - CLYNX_ICON_SIZE - CLYNX_LOCKUP_GAP
  );
  useEffect(() => {
    let scheduleTimer: ReturnType<typeof setTimeout>;
    let burstTimer: ReturnType<typeof setTimeout>;
    function scheduleNext() {
      const delay = 4000 + Math.random() * 6000;
      scheduleTimer = setTimeout(() => {
        setGlitching(true);
        burstTimer = setTimeout(() => {
          setGlitching(false);
          scheduleNext();
        }, 380);
      }, delay);
    }
    scheduleNext();
    return () => {
      clearTimeout(scheduleTimer);
      clearTimeout(burstTimer);
    };
  }, []);

  // Activity's own icon needs the live `running` prop (see ActivityIcon's
  // continuous pulse while scanning) — built inside the component instead
  // of as a module-level constant for exactly that reason.
  const items: Array<{ id: Screen; label: string; icon: React.ReactNode }> = [
    { id: "dashboard", label: "Dashboard", icon: <SpeedometerIcon live={scannerLive} /> },
    { id: "activity", label: "Activity", icon: <ActivityIcon live={scannerLive} /> },
    { id: "feed", label: "Feed", icon: <FeedIcon /> },
    { id: "watch", label: "Watch", icon: <WatchIcon live={watchRunning} searching={watchSearching} /> },
    { id: "database", label: "Database", icon: <InfoBubbleIcon busy={databaseBusy} /> },
    { id: "config", label: "Config", icon: <GearIcon /> },
  ];
  return (
    <div
      // Everything on this left panel is a "primary" destination, so it's
      // the one region that plays the hover tick (see App.tsx's hover
      // listener, which only ticks inside [data-hover-sound]).
      data-hover-sound
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--panel-elevated)",
        display: "flex",
        flexDirection: "column",
        padding: "20px 14px",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div
        className={`clynx-lockup${glitching ? " clynx-glitch" : ""}`}
        style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: CLYNX_LOCKUP_GAP, padding: "4px 4px 28px" }}
      >
        <ClynxMark size={CLYNX_ICON_SIZE} />
        {/* whiteSpace: nowrap is a deliberate safety net, not the primary
            fix — useMatchedWordmarkFontSize already clamps its own output
            to fit, but this guarantees a measurement glitch degrades into
            "slightly clipped" instead of the word wrapping onto a second
            line the way it did with a blind, unclamped font-size. */}
        <div className="clynx-wordmark glow-text" style={{ fontSize: wordmarkFontSize, whiteSpace: "nowrap" }}>
          c
          {/* Per explicit instruction — "l" should sit at the same height
              as the other lowercase letters instead of its normal full
              ascender. Needs its own inline-block box to be transform-able
              at all, which means it also needs its own independent
              background-clip:text pass (a plain inline span would just
              inherit glow-text's color:transparent with nothing of its own
              to clip a background against, and render invisible) — same
              gradient/animation as the word around it, just painted on a
              separate, smaller box, so the two may drift a pixel out of
              sync with each other without being visually obvious. */}
          <span className="clynx-l glow-text">l</span>
          ynx
        </div>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item) => (
          <button
            key={item.id}
            className={`nav-item ghost${active === item.id ? " active" : ""}`}
            onClick={() => onSelect(item.id)}
            aria-current={active === item.id ? "page" : undefined}
            style={{
              justifyContent: "flex-start",
              display: "flex",
              alignItems: "center",
              gap: 13,
              padding: "14px 15px",
              textAlign: "left",
              fontSize: 16,
              background: active === item.id ? "var(--gradient-soft)" : "transparent",
              border: active === item.id ? "1px solid var(--border-strong)" : "1px solid transparent",
              color: active === item.id ? "var(--text)" : "var(--text-muted)",
            }}
          >
            <span style={{ width: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, position: "relative" }}>
              {item.icon}
              {item.id === "watch" && hasUnseenWatchMatches && <span className="nav-item-pulse-dot" />}
            </span>
            {item.label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, padding: "0 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
          <span className={`dot ${loggedIn ? "on" : loggedIn === false ? "err" : "off"}`} />
          {loggedIn === null ? "Facebook: unknown" : loggedIn ? "Facebook: logged in" : "Facebook: not logged in"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
          <span className={`dot ${running ? "on" : "off"}`} />
          {(() => {
            const facebookText = accountCount > 1 ? `${runningCount}/${accountCount} scanning` : runningCount > 0 ? "Scanning" : "Idle";
            if (!ebaySearching) return facebookText;
            return runningCount > 0 || accountCount > 1 ? `${facebookText} · eBay` : "eBay searching";
          })()}
        </div>
      </div>
    </div>
  );
}
