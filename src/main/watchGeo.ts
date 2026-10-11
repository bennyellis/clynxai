// Is a listing inside the area a Facebook Watch was told to cover?
//
// Facebook's own radius filter is loose: its results routinely include listings
// from well outside the chosen distance. So the Watch checks for itself:
//   * ZIP / city: the listing's town is looked up (see geocode.ts) and its
//     distance from the Watch's own centre has to be within the radius the user
//     picked;
//   * state: the listing has to be in that state;
//   * whole country: nothing is out of bounds.
// Anything out of bounds is disregarded. A listing whose position can't be worked
// out is treated as out of bounds too (a Watch only wants results it is sure
// about); the one exception is when the Watch's OWN centre can't be placed, since
// then there is nothing to measure against and the radius can't be enforced.
import { distanceMiles, geocodePlace, type GeocodeDeps } from "./geocode.js";
import type { Store } from "./store.js";
import type { Watch } from "./types.js";
import { listingStateMatches } from "./usStates.js";
import { DEFAULT_WATCH_RADIUS_MILES } from "./watchOptions.js";

export interface BoundsVerdict {
  ok: boolean;
  reason: string;
  // The radius could not be enforced because the Watch's own centre couldn't be placed.
  notEnforced?: boolean;
  distanceMiles?: number;
}

export interface WatchGeoDeps {
  store: Store;
  geocode?: GeocodeDeps;
}

/** What to look up to find the Watch's own centre: what the user typed, else Facebook's resolved name. */
function centreQueries(watch: Watch): string[] {
  const typed = (watch.selectedCityOrZip ?? "").trim();
  const resolved = (watch.resolvedLocationLabel ?? "").trim();
  return [typed, resolved].filter((q, i, all) => q && all.indexOf(q) === i);
}

// "Waynesboro, Virginia" / "Waynesboro, VA" -> "waynesboro". A ZIP code has no town.
function townOf(text: string | null | undefined): string | null {
  const first = (text ?? "").split(",")[0].trim().toLowerCase();
  return first && !/^\d/.test(first) ? first : null;
}

export async function checkWatchBounds(watch: Watch, listingLocationText: string | null, deps: WatchGeoDeps): Promise<BoundsVerdict> {
  if (watch.platform !== "facebook" || watch.locationMode === "country") return { ok: true, reason: "no area limit" };

  if (watch.locationMode === "state") {
    const state = watch.selectedState ?? "";
    const verdict = state ? listingStateMatches(listingLocationText, state) : null;
    if (verdict === false) return { ok: false, reason: `its location ("${listingLocationText}") is outside ${state}` };
    return { ok: true, reason: verdict === true ? `in ${state}` : "state not stated on the listing" };
  }

  // ZIP / city
  const radius = watch.searchRadiusMiles ?? DEFAULT_WATCH_RADIUS_MILES;
  let centre = null;
  for (const query of centreQueries(watch)) {
    centre = await geocodePlace(deps.store, query, deps.geocode);
    if (centre) break;
  }
  if (!centre) return { ok: true, reason: "couldn't place the Watch's own location, so the radius isn't enforced", notEnforced: true };

  const text = (listingLocationText ?? "").trim();
  if (!text) return { ok: false, reason: "the listing doesn't say where it is" };
  // A listing in the very town the Watch is centred on is always inside, however
  // small the radius (a town's middle can sit a couple of miles from a ZIP's).
  const homeTown = townOf(watch.resolvedLocationLabel) ?? townOf(watch.selectedCityOrZip);
  if (homeTown && homeTown === townOf(text)) return { ok: true, reason: `in ${text.split(",")[0].trim()}, the Watch's own town`, distanceMiles: 0 };
  const spot = await geocodePlace(deps.store, text, deps.geocode);
  if (!spot) return { ok: false, reason: `couldn't work out where "${text}" is` };

  const miles = distanceMiles(centre, spot);
  if (miles > radius) return { ok: false, reason: `"${text}" is about ${Math.round(miles)} miles away, outside your ${radius}-mile radius`, distanceMiles: miles };
  return { ok: true, reason: `about ${Math.round(miles)} miles away, within ${radius}`, distanceMiles: miles };
}
