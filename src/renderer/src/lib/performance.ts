// Visual-effects quality, so Clynx stays smooth on any machine.
//
// The backdrop itself is static at every tier (see SpaceBackdrop.tsx), so the
// tiers trade starfield cost and always-on UI animation:
//   visual      — the full look: dense starfield with glow, satellite, meteors, the
//                 occasional logo sweep and ambient UI animation (starfield capped at
//                 about 30fps).
//   balanced    — a thin starfield at about 18fps, 1x resolution, no glow, satellite,
//                 meteors, flybys or logo sweep, no card hover lift, decorative CSS
//                 animation off.
//   performance — NO continuous decorative animation: the starfield is drawn once as
//                 a still image (and again only if the window is resized or the colours
//                 change), hover transitions are off. Functional indicators stay.
// Saved settings from before the rename: "high" is now visual, "lite" is performance.
//
// "auto" (the default) picks a starting tier from the hardware — including the
// GPU: integrated graphics (Intel UHD/HD/Iris) and software rendering start on
// lite — then watches the page's real frame cadence RELATIVE TO THE DISPLAY'S
// OWN REFRESH RATE and steps DOWN if the machine sustainedly can't keep up. It
// only steps down (so it can't flap) and starts fresh on every launch, so a
// slow startup can't leave it stuck low. The user can pin a tier in Config →
// Appearance. This is a per-machine setting (it depends on the GPU/CPU in
// front of you), so it lives in localStorage rather than the synced config.
//
// Separately from the tier, an IDLE state (no input for 30s) throttles the
// starfield and pauses the decorative animations — see isIdle() below — so an
// app left running all day or overnight costs next to nothing.

export type PerfTier = "visual" | "balanced" | "performance";
export type PerfPreference = "auto" | PerfTier;

const PREF_KEY = "clynx.effects";
const TIER_ORDER: PerfTier[] = ["visual", "balanced", "performance"];

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window / blocked storage — the setting just won't persist
  }
}

function isTier(v: unknown): v is PerfTier {
  return v === "visual" || v === "balanced" || v === "performance";
}

// The GPU's own name (e.g. "ANGLE (Intel, Intel(R) UHD Graphics ...)"), read
// once through WebGL. "none" = no hardware WebGL at all (software rendering).
let gpuName: string | null = null;
function detectGpu(): string {
  if (gpuName !== null) return gpuName;
  gpuName = "unknown";
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) {
      gpuName = "none";
    } else {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      gpuName = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "unknown");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // leave it "unknown"
  }
  return gpuName;
}

/** Human-readable GPU name for Config, e.g. "Intel UHD Graphics". */
export function getGpuLabel(): string {
  const raw = detectGpu();
  if (raw === "none") return "software rendering (no GPU acceleration)";
  if (raw === "unknown") return "unknown graphics";
  // "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A68) Direct3D11 ..., D3D11)" -> "Intel UHD Graphics"
  const inner = raw.replace(/^ANGLE \(/, "").replace(/\)$/, "");
  const parts = inner.split(",").map((s) => s.trim());
  const model = (parts[1] || parts[0] || raw).replace(/\(R\)|\(TM\)/gi, "").replace(/\s*\(0x[0-9a-f]+\).*$/i, "").replace(/\s+Direct3D.*$/i, "").trim();
  return model || raw;
}

function hardwareTier(): PerfTier {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "performance";
    const cores = navigator.hardwareConcurrency || 8;
    const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
    if (cores <= 2 || memory <= 2) return "performance";
    const gpu = detectGpu();
    // No hardware WebGL, or a software rasterizer: everything is drawn on the
    // CPU, so keep the effects minimal.
    if (gpu === "none" || /swiftshader|llvmpipe|software|basic render|warp/i.test(gpu)) return "performance";
    let tier: PerfTier = "visual";
    // Integrated Intel graphics (UHD / HD / Iris) share memory bandwidth with
    // the CPU and, at 120-144Hz, can't re-composite a full window every
    // refresh alongside the scanner's browser windows (and everything else the
    // machine is doing), so they start on the lightest tier. Arc is a real GPU.
    if (/intel/i.test(gpu) && !/\barc\b/i.test(gpu)) tier = "performance";
    // A modest CPU/RAM budget caps a strong GPU at balanced — but never raises
    // a tier the checks above already lowered.
    if (tier === "visual" && (cores <= 4 || memory <= 4)) tier = "balanced";
    return tier;
  } catch {
    // fall through to the default
  }
  return "visual";
}

let preference: PerfPreference = (() => {
  const saved = readStorage(PREF_KEY);
  // Settings saved before the modes were renamed (high / lite) keep meaning what they meant.
  if (saved === "high") return "visual";
  if (saved === "lite") return "performance";
  return saved === "auto" || isTier(saved) ? (saved as PerfPreference) : "auto";
})();

// Auto starts from what the hardware suggests and is re-measured on every
// launch. It is deliberately NOT remembered between launches: a slow moment at
// startup (the scanner opening its browser windows, the first data loads)
// used to stick as a permanently lowered tier.
let autoTier: PerfTier = hardwareTier();

const listeners = new Set<() => void>();

export function getTier(): PerfTier {
  return preference === "auto" ? autoTier : preference;
}

export function getPreference(): PerfPreference {
  return preference;
}

function apply(): void {
  document.documentElement.setAttribute("data-perf", getTier());
  listeners.forEach((l) => l());
}

export function setPreference(next: PerfPreference): void {
  preference = next;
  writeStorage(PREF_KEY, next);
  // A manual change is a fresh start for auto-detection too.
  if (next === "auto") {
    autoTier = hardwareTier();
    windowGaps.length = 0;
    slowWindows = 0;
  }
  apply();
}

export function subscribeTier(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- Idle state ---------------------------------------------------------------
// No keyboard/mouse/wheel input for IDLE_AFTER_MS = idle. While idle the
// starfield drops to a trickle and global.css pauses the decorative
// animations (html[data-idle]); the first input brings everything back.
const IDLE_AFTER_MS = 30_000;
let lastInputAt = typeof performance !== "undefined" ? performance.now() : 0;
let idle = false;

export function isIdle(): boolean {
  return idle || unfocused;
}

// The window is visible but does not have focus (another program, or the scanner's browser, is in front). After a few seconds the decorative
// layers throttle hard (see StarfieldBackground) and CSS animations pause; focusing the window brings everything back at once.
const UNFOCUSED_AFTER_MS = 3000;
let unfocused = false;
let unfocusTimer: ReturnType<typeof setTimeout> | null = null;
export function isUnfocused(): boolean {
  return unfocused;
}
function setUnfocused(next: boolean): void {
  if (unfocused === next) return;
  unfocused = next;
  if (next) document.documentElement.setAttribute("data-idle", "");
  else if (!idle) document.documentElement.removeAttribute("data-idle");
}

function setIdle(next: boolean): void {
  if (idle === next) return;
  idle = next;
  if (next) document.documentElement.setAttribute("data-idle", "");
  else if (!unfocused) document.documentElement.removeAttribute("data-idle");
}

export function initPerformance(): void {
  apply();
  const noteInput = () => {
    lastInputAt = performance.now();
    if (idle) setIdle(false);
  };
  for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "focus"]) {
    window.addEventListener(type, noteInput, { passive: true, capture: true });
  }
  setInterval(() => {
    if (!idle && performance.now() - lastInputAt > IDLE_AFTER_MS) setIdle(true);
  }, 2000);
  window.addEventListener("blur", () => {
    if (unfocusTimer) clearTimeout(unfocusTimer);
    unfocusTimer = setTimeout(() => setUnfocused(true), UNFOCUSED_AFTER_MS);
  });
  window.addEventListener("focus", () => {
    if (unfocusTimer) clearTimeout(unfocusTimer);
    unfocusTimer = null;
    setUnfocused(false);
  });
  // A window that starts without focus (opened behind something) gets the same treatment.
  if (!document.hasFocus()) unfocusTimer = setTimeout(() => setUnfocused(true), UNFOCUSED_AFTER_MS);
}

// --- Frame-time watchdog ------------------------------------------------------
// The starfield calls this on every display refresh with the wall-clock gap
// since the previous one (whether or not the canvas redrew — this is the whole
// page's cadence, not the canvas's own capped rate). A sustained average gap
// well above ONE REFRESH OF THIS DISPLAY means the machine is struggling: on a
// 144Hz screen, limping along at ~80fps is visible stutter even though it would
// be a perfectly smooth 60Hz experience, so "struggling" is judged against the
// display's own refresh interval, not a fixed fps.
const WINDOW_FRAMES = 90;
// Frames in the first seconds after launch aren't representative — the app is
// busy loading data, restoring the session and starting the scanner.
const WARMUP_MS = 15_000;
// One refresh interval of the display, estimated as the fastest typical (25th
// percentile) frame gap seen in any window — only ever lowered, so a rough
// patch can't inflate it. Starts at 60Hz and clamps to [4ms, 16.7ms].
let vsyncMs = 16.7;
// Average gap above this many refresh intervals = struggling.
const STRUGGLE_FACTOR = 1.35;
const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
const windowGaps: number[] = [];
let slowWindows = 0;

export function reportFrame(frameGapMs: number): void {
  if (preference !== "auto") return;
  if (idle) return;
  if (performance.now() - startedAt < WARMUP_MS) return;
  // Ignore stalls from the window being hidden/resumed — not a speed signal.
  if (frameGapMs <= 0 || frameGapMs > 250) return;
  windowGaps.push(frameGapMs);
  if (windowGaps.length < WINDOW_FRAMES) return;
  const sorted = windowGaps.slice().sort((a, b) => a - b);
  const avg = windowGaps.reduce((a, b) => a + b, 0) / windowGaps.length;
  windowGaps.length = 0;
  vsyncMs = Math.max(4, Math.min(vsyncMs, sorted[Math.floor(sorted.length * 0.25)]));
  // Lite is the floor.
  const struggling = autoTier !== "performance" && avg > vsyncMs * STRUGGLE_FACTOR;
  slowWindows = struggling ? slowWindows + 1 : 0;
  // Two slow windows in a row (a couple of seconds) before acting, so a
  // one-off hitch (a big list rendering) doesn't downgrade the session.
  if (slowWindows >= 2) {
    slowWindows = 0;
    const next = TIER_ORDER[TIER_ORDER.indexOf(autoTier) + 1];
    if (next) {
      autoTier = next;
      apply();
    }
  }
}
