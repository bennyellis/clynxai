// Turns a place name or ZIP code into coordinates, so a Facebook Watch can tell
// whether a listing is inside the radius the user chose.
//
// Uses OpenStreetMap's free Nominatim service. Its usage policy asks for at most
// one request a second, a real User-Agent, and caching, so: lookups are queued one
// at a time with a gap between them, and every answer (including "no such place")
// is remembered in the local database (Store.getGeocode/setGeocode), which means a
// given place is only ever looked up once. A lookup that FAILS (offline, service
// down) is not remembered for long, so it can succeed later.
import type { Store } from "./store.js";

export interface GeoPoint {
  lat: number;
  lon: number;
  label: string | null;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Clynx/1.0 (desktop app; results cached locally)";
const MIN_GAP_MS = 1100;
const REQUEST_TIMEOUT_MS = 8000;
// A place the service said doesn't exist is asked about again after a week.
const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// After a failed request (offline, error status), don't try that same place again for a minute.
const FAILURE_RETRY_MS = 60 * 1000;

export interface GeocodeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const recentFailures = new Map<string, number>();

/** The cache key / query for a piece of place text ("Staunton, VA" and "staunton,  va" are the same place). */
export function placeKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function isZip(text: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(text.trim());
}

function buildUrl(text: string): string {
  const params = new URLSearchParams({ format: "json", limit: "1", countrycodes: "us" });
  if (isZip(text)) params.set("postalcode", text.trim().slice(0, 5));
  else params.set("q", /\b(usa|united states)\b/i.test(text) ? text.trim() : `${text.trim()}, USA`);
  return `${NOMINATIM_URL}?${params.toString()}`;
}

/** Where a place is, or null when it can't be found (or can't be looked up right now). */
export async function geocodePlace(store: Store, text: string, deps: GeocodeDeps = {}): Promise<GeoPoint | null> {
  const key = placeKey(text);
  if (!key) return null;
  const now = deps.now ?? Date.now;

  const cached = store.getGeocode(key);
  if (cached) {
    if (cached.found) return { lat: cached.lat, lon: cached.lon, label: cached.label };
    if (now() - cached.fetchedAt < NOT_FOUND_TTL_MS) return null;
  }
  const failedAt = recentFailures.get(key);
  if (failedAt !== undefined && now() - failedAt < FAILURE_RETRY_MS) return null;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // One request at a time, spaced out. Re-checks the cache once it is this
  // lookup's turn: an earlier queued lookup may have just answered the same place.
  const run = async (): Promise<GeoPoint | null> => {
    const again = store.getGeocode(key);
    if (again?.found) return { lat: again.lat, lon: again.lon, label: again.label };
    const wait = lastRequestAt + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(buildUrl(text), { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
      const rows = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
      const top = rows[0];
      const lat = top ? Number(top.lat) : NaN;
      const lon = top ? Number(top.lon) : NaN;
      if (!top || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        store.setGeocode(key, { found: false });
        return null;
      }
      store.setGeocode(key, { found: true, lat, lon, label: top.display_name ?? null });
      return { lat, lon, label: top.display_name ?? null };
    } catch {
      recentFailures.set(key, now());
      return null;
    }
  };
  const result = chain.then(run, run);
  chain = result.then(
    () => {},
    () => {}
  );
  return result;
}

const EARTH_RADIUS_MILES = 3958.8;

/** Great-circle distance between two points, in miles. */
export function distanceMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Test hook: forget the in-memory queue spacing and failure memory. */
export function resetGeocoderForTests(): void {
  chain = Promise.resolve();
  lastRequestAt = 0;
  recentFailures.clear();
}
