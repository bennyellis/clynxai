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

import { getTier, type PerfTier } from "./performance.js";

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

type Rgb = [number, number, number];

// --- Legibility ------------------------------------------------------------
// The two colors are arbitrary, so nothing in the stylesheet can assume what
// reads well on them: white text on a white (or yellow) button, or dark text on
// a near-black one, disappears. Everything below is computed from the actual
// picks (and re-computed on every rainbow step) and published as custom
// properties the stylesheet uses instead of hard-coded white:
//   --on-accent-1/2/3 — the text color to use ON a fill of that color (white
//       or near-black, whichever contrasts more);
//   --primary-fill / --on-primary-fill — the primary button's fill (the
//       gradient, or flat primary when the gradient can't hold readable text)
//       and the text color for it;
//   --accent-1/2/3-text, --gradient-text — the accent colors themselves, nudged
//       just far enough toward white (dark theme) or black (light theme) to be
//       readable as TEXT on the page surfaces. Used for links and gradient
//       headings, where the raw color could vanish into the background.
// Contrast is the WCAG ratio; 4.5:1 is the standard bar for normal text.

function channelLuminance(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const LIGHT_TEXT: Rgb = [255, 255, 255];
const DARK_TEXT: Rgb = [18, 16, 31];
const MIN_TEXT_CONTRAST = 4.5;
// For ACCENT-COLORED text and artwork on the page (links, gradient headings, the
// starfield and grid): the WCAG bar for large and UI elements. Deliberately
// lower than 4.5 — the app's default purple already clears it, so the default
// look is untouched, and it still rescues the cases that matter (an accent that
// matches the page and would simply vanish).
const MIN_ACCENT_CONTRAST = 3;
// For text across a multi-color gradient fill: the WCAG bar for large/bold UI
// text. Lower than above on purpose — the app's default purple-to-blue
// gradient with white text sits just above it, and has always looked right.
const MIN_GRADIENT_CONTRAST = 3;
// A button fill closer than this to the surface it sits on gets an edge.
const PRIMARY_EDGE_BELOW_CONTRAST = 1.8;
// The dark theme tints its surfaces toward the primary color; a very bright
// pick (white, yellow) would otherwise lift them enough that the regular
// secondary text colors lose their contrast. Capped at roughly the brightness
// of the app's original purple, so bright picks tint no more than that did.
const MAX_SURFACE_TINT_LUMINANCE = 0.22;

// White text is the convention on saturated mid-tone fills — it's what the app
// has always used on its purple, and what Rainbow keeps — so it wins whenever it
// is readable enough on the fill. Only when white would fade out (a white,
// yellow or other pale/bright fill) does dark text take over.
const MIN_WHITE_ON_FILL_CONTRAST = 3;

/** Text color for text drawn ON these backgrounds: white if it holds up on the worst of them, otherwise whichever of white / near-black does better. */
function textOn(backgrounds: Rgb[]): string {
  const worst = (text: Rgb) => Math.min(...backgrounds.map((bg) => contrast(text, bg)));
  const white = worst(LIGHT_TEXT);
  if (white >= MIN_WHITE_ON_FILL_CONTRAST) return "#ffffff";
  return white >= worst(DARK_TEXT) ? "#ffffff" : toHex(DARK_TEXT);
}

/** `color`, nudged toward white or black only as far as needed to read as text on every surface. */
function readableAsText(color: Rgb, surfaces: Rgb[], towardWhite: boolean): Rgb {
  const target: Rgb = towardWhite ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const candidate = mix(color, target, t);
    if (surfaces.every((surface) => contrast(candidate, surface) >= MIN_ACCENT_CONTRAST)) return candidate;
  }
  return target;
}

/** `color` darkened (toward black) until its luminance is at most `maxLuminance`. */
function dimToLuminance(color: Rgb, maxLuminance: number): Rgb {
  if (luminance(color) <= maxLuminance) return color;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const candidate = mix(color, [0, 0, 0], t);
    if (luminance(candidate) <= maxLuminance) return candidate;
  }
  return [0, 0, 0];
}

// `rainbow` keeps the text on every accent fill WHITE, exactly as before the
// legibility work: Rainbow's colors are always the same mid-bright saturation,
// white reads on all of them, and the text color should not flip between white
// and black as the hue drifts through yellow and green.
export function applyColorScheme(primaryHex: string, accentHex: string, theme: "dark" | "light", rainbow = false): void {
  const root = document.documentElement.style;
  const primaryRgb = hexToRgb(primaryHex);
  const accentRgb = hexToRgb(accentHex);
  // A third gradient/particle tone derived from the two picks (an even
  // blend) — keeps the original 3-stop gradient's visual richness without
  // asking the user to pick a 3rd color themselves.
  const blendRgb = mix(primaryRgb, accentRgb, 0.5);
  const blendHex = toHex(blendRgb);

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
  let surfaces: Rgb[];
  if (theme === "light") {
    const white: Rgb = [255, 255, 255];
    const lightBase: Rgb = [247, 246, 251];
    const bg = mix(lightBase, primaryRgb, 0.05);
    const cardHover = mix(white, primaryRgb, 0.06);
    root.setProperty("--bg", toHex(bg));
    root.setProperty("--bg-elevated", "#ffffff");
    root.setProperty("--bg-card", "#ffffff");
    root.setProperty("--bg-card-hover", toHex(cardHover));
    surfaces = [bg, white, cardHover];
  } else {
    const darkBase: Rgb = [10, 10, 18];
    const tint = dimToLuminance(primaryRgb, MAX_SURFACE_TINT_LUMINANCE);
    const bg = mix(darkBase, tint, 0.1);
    const elevated = mix(darkBase, tint, 0.16);
    const card = mix(darkBase, tint, 0.22);
    const cardHover = mix(darkBase, tint, 0.3);
    root.setProperty("--bg", toHex(bg));
    root.setProperty("--bg-elevated", toHex(elevated));
    root.setProperty("--bg-card", toHex(card));
    root.setProperty("--bg-card-hover", toHex(cardHover));
    surfaces = [bg, elevated, card, cardHover];
  }

  // Legible text on the accent fills, and legible accent-colored text on the surfaces.
  const onFill = (backgrounds: Rgb[]) => (rainbow ? "#ffffff" : textOn(backgrounds));
  root.setProperty("--on-accent-1", onFill([primaryRgb]));
  root.setProperty("--on-accent-2", onFill([accentRgb]));
  root.setProperty("--on-accent-3", onFill([blendRgb]));
  // The primary button's fill is the 3-stop gradient — but one text color has
  // to read across ALL of it, which is impossible when the stops sit far apart
  // in brightness (white -> black). If the best single text color can't reach
  // 3:1 on the worst stop, the button gets a flat primary-color fill instead
  // (and text chosen for that). Rainbow keeps the gradient with white text.
  const gradientStops = [primaryRgb, accentRgb, blendRgb];
  const gradientText = textOn(gradientStops);
  const gradientTextRgb = gradientText === "#ffffff" ? LIGHT_TEXT : DARK_TEXT;
  const gradientHoldsText = Math.min(...gradientStops.map((stop) => contrast(gradientTextRgb, stop))) >= MIN_GRADIENT_CONTRAST;
  root.setProperty("--primary-fill", rainbow || gradientHoldsText ? "var(--gradient)" : "var(--accent-1)");
  const onPrimaryFill = rainbow ? "#ffffff" : gradientHoldsText ? gradientText : textOn([primaryRgb]);
  root.setProperty("--on-primary-fill", onPrimaryFill);
  // A fill that matches the surface it sits on (a white button on a white card,
  // a black one on the dark theme) loses its shape — give it a thin edge in the
  // text color. Most fills clear the surface easily and get no edge at all.
  const fillBlendsIn = !rainbow && surfaces.some((surface) => contrast(primaryRgb, surface) < PRIMARY_EDGE_BELOW_CONTRAST);
  root.setProperty(
    "--primary-edge",
    fillBlendsIn ? `inset 0 0 0 1.5px color-mix(in srgb, ${onPrimaryFill} 45%, transparent)` : "0 0 0 0 transparent"
  );
  const towardWhite = theme === "dark";
  root.setProperty("--accent-1-text", toHex(readableAsText(primaryRgb, surfaces, towardWhite)));
  root.setProperty("--accent-2-text", toHex(readableAsText(accentRgb, surfaces, towardWhite)));
  root.setProperty("--accent-3-text", toHex(readableAsText(blendRgb, surfaces, towardWhite)));
  root.setProperty("--gradient-text", "linear-gradient(135deg, var(--accent-3-text), var(--accent-1-text) 55%, var(--accent-2-text))");
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
const RAINBOW_STEP_MS: Record<PerfTier, number> = { visual: 70, balanced: 140, performance: 320 };
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
    if (now - lastStep < RAINBOW_STEP_MS[getTier()]) return;
    lastStep = now;
    const hue = (((now - startedAt) / RAINBOW_CYCLE_MS) * 360) % 360;
    applyColorScheme(hslToHex(hue, 78, 62), hslToHex((hue + RAINBOW_ACCENT_HUE_OFFSET) % 360, 82, 60), rainbowTheme, true);
  };
  rainbowFrame = requestAnimationFrame(tick);
}

export function stopRainbow(): void {
  if (rainbowFrame !== null) cancelAnimationFrame(rainbowFrame);
  rainbowFrame = null;
}

// How much of the animated background shows through the app's panels. A percentage
// (0 = solid, 90 = nearly clear) published as --panel-opacity, which global.css
// turns into the translucent --panel-card / --panel-elevated fills. Kept apart
// from applyColorScheme so Rainbow's 20-steps-a-second color updates don't
// rewrite it, and clamped so a bad saved value can never make panels invisible.
export function applyPanelTransparency(percent: number | undefined): void {
  const clamped = Math.max(0, Math.min(90, Number.isFinite(percent as number) ? (percent as number) : 20));
  document.documentElement.style.setProperty("--panel-opacity", String(+(1 - clamped / 100).toFixed(2)));
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
