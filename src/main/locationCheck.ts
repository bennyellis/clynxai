// Did Facebook really put the page on the place the scanner asked for? The scanner reads the location label back from the page ("Augusta, Georgia") and
// compares it with the label it expected ("Augusta, ME"). Comparing the city alone is not enough: Augusta, Maine and Augusta, Georgia share a name, and
// a slug like /marketplace/augusta lands on Georgia. When both labels name a state, the states have to agree.
import { US_STATE_ABBREVIATIONS } from "./usStates.js";

export type LocationCheck = "match" | "mismatch" | "unknown";

const ABBREVIATIONS = new Set(Object.values(US_STATE_ABBREVIATIONS));
const FULL_TO_ABBR = new Map(Object.entries(US_STATE_ABBREVIATIONS).map(([full, abbr]) => [full.toLowerCase(), abbr]));

function squash(text: string): string {
  return text.toLowerCase().replace(/\bsaint\b/g, "st").replace(/[^a-z0-9]/g, "");
}

export function parseLocationLabel(label: string): { city: string; state: string | null } {
  const comma = label.indexOf(",");
  if (comma === -1) return { city: squash(label), state: null };
  const city = squash(label.slice(0, comma));
  const rest = label.slice(comma + 1).trim().replace(/[.]/g, "");
  const abbr = rest.toUpperCase();
  if (ABBREVIATIONS.has(abbr)) return { city, state: abbr };
  const full = FULL_TO_ABBR.get(rest.toLowerCase());
  return { city, state: full ?? null };
}

/**
 * `match`: same place. `mismatch`: the page is definitely somewhere else (different state, or the same state and a clearly different city), so searching
 * there would file another place's listings under this location. `unknown`: not enough to tell (no label on the page, or a label that carries no state to
 * compare, like an opaque location slug), which keeps the lenient behavior the scanner always had.
 */
export function checkArrivedLocation(expectedLabel: string, arrivedLabel: string | null): LocationCheck {
  if (!arrivedLabel) return "unknown";
  const expected = parseLocationLabel(expectedLabel);
  const arrived = parseLocationLabel(arrivedLabel);
  if (!expected.city || !arrived.city) return "unknown";
  const cityAgrees = arrived.city.includes(expected.city) || expected.city.includes(arrived.city);
  if (expected.state && arrived.state) {
    if (expected.state !== arrived.state) return "mismatch";
    return cityAgrees ? "match" : "mismatch";
  }
  return cityAgrees ? "match" : "unknown";
}
