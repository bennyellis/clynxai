// Fixed choices for a Facebook Watch's settings, shared by the renderer (which
// shows exactly these) and the main process (which snaps anything else to the
// nearest one). Pure data: no imports.

// The search radii Facebook Marketplace's own "Change location" dialog offers.
// A ZIP/city Watch can only pick one of these (the dialog has no custom value).
export const FACEBOOK_RADIUS_OPTIONS_MILES = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500] as const;

export const DEFAULT_WATCH_RADIUS_MILES = 20;

/** The offered radius closest to `miles` (the default when there is no usable value). */
export function snapToFacebookRadius(miles: number | null | undefined): number {
  return snapTo(FACEBOOK_RADIUS_OPTIONS_MILES, miles, DEFAULT_WATCH_RADIUS_MILES);
}

// How often a Facebook Watch looks. Never faster than every 5 minutes: each
// check drives a real browser through Facebook, and hammering it is what gets
// accounts throttled.
export const WATCH_INTERVAL_OPTIONS_MINUTES = [5, 10, 15, 30, 60, 120, 240] as const;

export const DEFAULT_WATCH_INTERVAL_MINUTES = 15;

/** The offered interval closest to `minutes` (the default when there is no usable value). */
export function snapToWatchInterval(minutes: number | null | undefined): number {
  return snapTo(WATCH_INTERVAL_OPTIONS_MINUTES, minutes, DEFAULT_WATCH_INTERVAL_MINUTES);
}

export function formatWatchInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function snapTo(options: readonly number[], value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  let best = options[0];
  for (const option of options) {
    if (Math.abs(option - value) < Math.abs(best - value)) best = option;
  }
  return best;
}
