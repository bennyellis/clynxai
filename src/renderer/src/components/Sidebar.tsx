import React from "react";
import { playTabSwitchSound } from "../lib/sound.js";

export type Screen = "dashboard" | "activity" | "feed" | "database" | "config";

function IconSvg({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
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

// Speedometer — a gauge arc + needle, for "how fast the scanner is
// running" at a glance rather than a generic dashboard glyph. Per explicit
// instruction, this one always reads as "running hot" now, not just on
// hover: green, needle pinned straight up (see global.css's
// icon-speedometer-needle-group base transform), with a couple of short
// motion-line strokes trailing off the tip. Both the needle and the speed
// lines live in one <g> so they rotate together — the arc they pivot
// inside stays fixed either way. Hovering plays a bigger, distinct sweep
// (bottom → top → middle) — see global.css's iconNeedleSweepFull.
function SpeedometerIcon() {
  return (
    <IconSvg className="icon-speedometer">
      <path d="M12 21a9 9 0 1 1 9-9" />
      <g className="icon-speedometer-needle-group">
        <path className="icon-speedometer-needle" d="M12 12l4-4" />
        <path className="icon-speedometer-speedlines" d="M17 6l1.8-1.3M18.8 7.8l2.1-.6M19.3 9.8l2.2.4" />
      </g>
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
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
function InfoBubbleIcon() {
  return (
    <IconSvg className="icon-info">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line className="icon-info-dot" x1="12" y1="8" x2="12.01" y2="8" />
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

// Pulse/EKG line — the standard "activity" glyph, for the scan log's own
// page. Per explicit instruction, this should actually mimic a heart
// monitor rather than just bouncing — the line "draws" itself left to
// right on hover (a classic stroke-dashoffset reveal, see global.css's
// iconEkgDraw), and keeps redrawing on a loop, in the scanner's success
// color, the whole time scanning is actually running — see Sidebar's own
// `running` prop below.
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

export function Sidebar({
  active,
  onSelect,
  loggedIn,
  running,
}: {
  active: Screen;
  onSelect: (s: Screen) => void;
  loggedIn: boolean | null;
  running: boolean;
}) {
  // Activity's own icon needs the live `running` prop (see ActivityIcon's
  // continuous pulse while scanning) — built inside the component instead
  // of as a module-level constant for exactly that reason.
  const items: Array<{ id: Screen; label: string; icon: React.ReactNode }> = [
    { id: "dashboard", label: "Dashboard", icon: <SpeedometerIcon /> },
    { id: "activity", label: "Activity", icon: <ActivityIcon live={running} /> },
    { id: "feed", label: "Feed", icon: <FeedIcon /> },
    { id: "database", label: "Database", icon: <InfoBubbleIcon /> },
    { id: "config", label: "Config", icon: <GearIcon /> },
  ];
  return (
    <div
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--bg-elevated)",
        display: "flex",
        flexDirection: "column",
        padding: "20px 14px",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 8px 24px" }}>
        <div
          className="logo-badge"
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: "var(--gradient)",
            backgroundSize: "200% auto",
            boxShadow: "var(--shadow-glow)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            color: "white",
            animation: "shimmer 5s linear infinite",
            cursor: "default",
          }}
        >
          S
        </div>
        <div>
          <div className="glow-text" style={{ fontWeight: 700, fontSize: 15 }}>Marketplace Scout</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Deal finder</div>
        </div>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item) => (
          <button
            key={item.id}
            className={`nav-item ghost${active === item.id ? " active" : ""}`}
            onClick={() => {
              // Only on an actual switch — re-clicking the tab you're
              // already on doesn't navigate anywhere, so it shouldn't sound
              // like it did.
              if (active !== item.id) playTabSwitchSound();
              onSelect(item.id);
            }}
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
            <span style={{ width: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{item.icon}</span>
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
          {running ? "Scanning" : "Idle"}
        </div>
      </div>
    </div>
  );
}
