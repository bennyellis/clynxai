// Per explicit instruction ("instead of choosing colors, allow the user to
// use a color wheel to pick a primary and accent color") — turns the two
// hex colors the user picks in Config (via native <input type="color">
// wheels) into every derived CSS custom property the rest of the app reads
// (see global.css's :root block for the full list this mirrors). Shared
// between App.tsx (applies on startup / on a live config:updated push) and
// Config.tsx (applies immediately as the user drags each color wheel, the
// same "preview before Save" posture as the existing theme toggle).
//
// Applied via documentElement.style.setProperty rather than a CSS
// [data-scheme="..."] attribute block: an inline style always wins the
// cascade over any selector-based rule regardless of source order, which
// matters here because the color is arbitrary/user-chosen, not one of a
// fixed set of presets a stylesheet could enumerate ahead of time.
//
// This also fixes the "everything still looks kinda purple" bug the fixed-
// preset version of this feature had — --bg/--bg-elevated/--bg-card were
// never part of that scheme system, so the whole app canvas stayed tinted
// toward this app's original purple no matter which accent scheme was
// picked. Deriving a real (if subtle) background tint from the user's own
// primary color, per theme, is what actually lets a different color choice
// change the app's overall mood instead of just its buttons.

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(num)) return [124, 108, 246]; // fallback: original accent-1
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function toRgbString([r, g, b]: [number, number, number]): string {
  return `${r}, ${g}, ${b}`;
}

// Linear per-channel blend between two colors — deliberately simple RGB
// mixing (no HSL hue rotation) so the result stays predictable for any
// arbitrary pair of user-picked colors rather than occasionally producing a
// muddy or unexpectedly-hued blend.
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

export function applyColorScheme(primaryHex: string, accentHex: string, theme: "dark" | "light"): void {
  const root = document.documentElement.style;
  const primaryRgb = hexToRgb(primaryHex);
  const accentRgb = hexToRgb(accentHex);
  // A third gradient/particle tone derived from the two picks (an even
  // blend) — keeps the original 3-stop gradient's visual richness without
  // asking the user to pick a 3rd color themselves.
  const blendHex = toHex(mix(primaryRgb, accentRgb, 0.5));

  root.setProperty("--accent-1", primaryHex);
  root.setProperty("--accent-2", accentHex);
  root.setProperty("--accent-3", blendHex);
  root.setProperty("--accent-1-rgb", toRgbString(primaryRgb));
  root.setProperty("--accent-2-rgb", toRgbString(accentRgb));
  root.setProperty("--gradient", "linear-gradient(135deg, var(--accent-3), var(--accent-1) 55%, var(--accent-2))");
  root.setProperty("--gradient-soft", "linear-gradient(135deg, rgba(var(--accent-1-rgb), 0.16), rgba(var(--accent-2-rgb), 0.1))");
  root.setProperty("--border", "rgba(var(--accent-2-rgb), 0.16)");
  root.setProperty("--border-strong", "rgba(var(--accent-2-rgb), 0.32)");
  root.setProperty("--shadow-glow", "0 8px 30px rgba(var(--accent-1-rgb), 0.28)");

  // Background tint — deliberately low ratios so the surface stays usably
  // dark (or usably near-white in light mode) no matter how bright a color
  // the user picks; this is meant to read as "the whole app leans toward
  // your color," not a full repaint of the canvas.
  if (theme === "light") {
    const white: [number, number, number] = [255, 255, 255];
    const lightBase: [number, number, number] = [247, 246, 251];
    root.setProperty("--bg", toHex(mix(lightBase, primaryRgb, 0.05)));
    root.setProperty("--bg-elevated", "#ffffff");
    root.setProperty("--bg-card", "#ffffff");
    root.setProperty("--bg-card-hover", toHex(mix(white, primaryRgb, 0.06)));
  } else {
    const darkBase: [number, number, number] = [10, 10, 18];
    root.setProperty("--bg", toHex(mix(darkBase, primaryRgb, 0.1)));
    root.setProperty("--bg-elevated", toHex(mix(darkBase, primaryRgb, 0.16)));
    root.setProperty("--bg-card", toHex(mix(darkBase, primaryRgb, 0.22)));
    root.setProperty("--bg-card-hover", toHex(mix(darkBase, primaryRgb, 0.3)));
  }
}

// --- Rainbow mode ----------------------------------------------------------
// Per explicit instruction ("a rainbow option for the color scheme... fade
// through colors to create a really nice aesthetic vibe"): rather than a
// second code path for every gradient/glow/particle, this just drives the
// SAME applyColorScheme above with a slowly rotating pair of hues, so every
// accent-derived CSS custom property (and the starfield/click particles,
// which read those properties) follows along for free. The primary leads and
// the accent trails it by a fixed hue offset, so the two-tone gradients
// always show two neighboring colors mid-fade rather than one flat color.

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]);
}

// One full trip around the color wheel. Slow on purpose: a gentle drift
// reads as ambience; anything much faster starts to feel like a flashing
// light.
const RAINBOW_CYCLE_MS = 48_000;
// Style recalculation across the whole app is the cost here (every var()
// consumer re-resolves), so this updates ~20 times a second rather than
// every frame; at this cycle length each step shifts the hue by under half a
// degree, which still looks perfectly continuous.
const RAINBOW_STEP_MS = 50;
const RAINBOW_ACCENT_HUE_OFFSET = 55;

let rainbowFrame: number | null = null;
let rainbowTheme: "dark" | "light" = "dark";

export function startRainbow(theme: "dark" | "light"): void {
  rainbowTheme = theme;
  if (rainbowFrame !== null) return;
  const startedAt = performance.now();
  let lastStep = 0;
  const tick = (now: number) => {
    rainbowFrame = requestAnimationFrame(tick);
    if (now - lastStep < RAINBOW_STEP_MS) return;
    lastStep = now;
    const hue = (((now - startedAt) / RAINBOW_CYCLE_MS) * 360) % 360;
    applyColorScheme(hslToHex(hue, 78, 62), hslToHex((hue + RAINBOW_ACCENT_HUE_OFFSET) % 360, 82, 60), rainbowTheme);
  };
  rainbowFrame = requestAnimationFrame(tick);
}

export function stopRainbow(): void {
  if (rainbowFrame !== null) cancelAnimationFrame(rainbowFrame);
  rainbowFrame = null;
}

// The one entry point App.tsx and Config.tsx use, so "which colors are
// showing" has a single answer: rainbow when it's on, otherwise the two
// picked colors.
export function applyThemeColors(colors: { primaryColor: string; accentColor: string; theme: "dark" | "light"; rainbowEnabled?: boolean }): void {
  if (colors.rainbowEnabled) {
    startRainbow(colors.theme);
    return;
  }
  stopRainbow();
  applyColorScheme(colors.primaryColor, colors.accentColor, colors.theme);
}
