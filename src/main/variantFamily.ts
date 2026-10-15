// "Search for variants" (Beta 12, pure). Decides, for a listing Facebook ALREADY returned, whether it is a variant of the product family a Search For entry names. Nothing here
// searches: the Marketplace keyword stays the entry's own text, so enabling variants makes no extra query, browser session or keyword fan-out.
//
// A listing is accepted for a variant-enabled entry when every word of the entry's phrase is in the title (the same test as always) AND nothing says it is a different thing:
//   - not a different model: another number next to the family word (iPhone 14 / 16), another lettered model (Series S for Series X), another generation;
//   - not an accessory or a part (a case, a controller, "parts only") and not software or a game that merely names the platform (photoIdentity / productKind);
// and a variant word is welcome: a tier (Plus, Pro, Max, Mini, Lite, OLED, Slim...), an edition, a colour, a capacity.
// The entry itself decides the rest: if it states a tier or edition ("iPhone 15 Pro"), listings that lack it are still its own business (the title must contain the phrase).
import { classifyComparable } from "./compIdentity.js";
import { accessorySignal, mediaSignal } from "./productKind.js";

// What makes a title "a different thing" for a family match. TIER, EDITION, CAPACITY, COLOR and the *_NOT_STATED reasons are exactly what a variant adds, so they never reject.
const REJECTING = new Set(["MODEL_NUMBER", "MODEL_LETTER", "GENERATION", "ACCESSORY", "MEDIA"]);

export interface VariantDecision {
  accept: boolean;
  /** Why not (for the log / tests). */
  reason: string | null;
  /** The listing is a variant of the entry rather than the entry itself (so it must be priced as its own product). */
  isVariant: boolean;
}

/**
 * `terms` are the entry's match phrases (already known to be contained in the title word by word); `strictVariantWords` are the tier words the plain matcher would have rejected
 * ("pro", "max"...) that this title carries beyond the entry's own words.
 */
export function variantFamilyDecision(entryName: string, terms: string[], title: string, strictVariantWords: string[]): VariantDecision {
  const own = terms.join(" ").toLowerCase();
  const entryIsAccessory = !!accessorySignal(entryName);
  const mediaInTitle = mediaSignal(title);
  if (mediaInTitle && !mediaSignal(entryName)) return { accept: false, reason: `a game or software for a platform ("${mediaInTitle}")`, isVariant: false };
  const acc = accessorySignal(title);
  if (acc && !entryIsAccessory && !own.includes(acc.toLowerCase())) return { accept: false, reason: `about an accessory ("${acc}")`, isVariant: false };
  const j = classifyComparable({ name: entryName }, title);
  const hard = j.reasons.find((r) => REJECTING.has(r.code));
  if (hard) return { accept: false, reason: `${hard.code.toLowerCase().replace(/_/g, " ")}: ${hard.text}`, isVariant: false };
  const isVariant = strictVariantWords.length > 0 || j.reasons.some((r) => ["TIER", "EDITION", "MORE_SPECIFIC"].includes(r.code));
  return { accept: true, reason: null, isVariant };
}
