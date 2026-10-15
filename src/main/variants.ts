// Product variant identity: what separates a parent product ("Xbox Series X") from a distinct, verifiable variant of it ("Xbox Series X 2TB
// Galaxy Black Special Edition"), and from accessories and look-alike names. Everything here is pure (no AI, no network, no store) so the rules
// can be tested alone.
//
// Nothing in this file knows a particular product. A variant is recognised by structure: its name contains every word of the parent's name AND
// carries extra distinguishing words (a capacity, a colour, an edition, a bundle, a region, a generation, or simply a name the parent lacks).
// Those extra words are the variant's "required tokens": a sold comp that lacks them is a different product and must not be used to value it.
import { colorsIn, isColorWord } from "./colors.js";

export type VariantRelation =
  | "same" // the same product, only wording differs
  | "variant" // a distinct variant of the parent (extra distinguishing words)
  | "accessory" // something made for / sold with the parent, not a version of it
  | "different"; // does not contain the parent at all

export interface VariantAttributes {
  capacity: string[]; // "2tb", "256gb"
  colors: string[];
  edition: string[]; // the words naming an edition ("galaxy black special edition" -> galaxy, black, special, limited, ...)
  bundle: boolean;
  region: string[];
  generation: string[];
  carrier: string[];
}

const CAPACITY = /^\d+(?:p\d+)?(?:tb|gb|mb)$/;

/** Words that never distinguish one product from another. */
const FILLER = new Set(
  (
    "a an the and or with for of in on to at by from new used like sealed brand console system unit version model original official only " +
    "genuine authentic factory nib boxed box edition bundle pack set"
  ).split(" ")
);

/** Words that mark an extra as an accessory or part, when nothing else in the extra describes a version of the product. */
const ACCESSORY_NOUNS = new Set(
  (
    "controller controllers headset headphones case cover skin decal charger cable cord adapter dock stand mount remote battery " +
    "protector keyboard mouse card cartridge disc game games manual box strap bag sleeve stylus pen kit"
  ).split(" ")
);

/** Words that say what an edition is called. A seller's invented colourway has no such word, so it is judged by evidence instead. */
const EDITION_WORDS = new Set(
  (
    "special limited collector collectors anniversary deluxe premium signature founders founder launch exclusive commemorative platinum " +
    "ultimate champion legacy"
  ).split(" ")
);

const REGION_WORDS = new Set("us usa uk eu europe asia japan japanese jp international global pal ntsc korea korean china chinese india au canada".split(" "));
const CARRIER_WORDS = new Set("unlocked verizon att tmobile sprint cricket boost metro carrier-locked".split(" "));
const BUNDLE_WORDS = new Set("bundle bundled combo pack kit set".split(" "));

/** Words in a variant's required tokens that are too common in listing titles to demand of a comp. */
const LOW_SIGNAL = new Set(
  "bundle edition version console system disc drive pack set kit combo with the and for new used digital physical standard".split(" ")
);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/(\d)\.(\d)/g, "$1p$2")
    .replace(/(\d)\s*[-]?\s*(tb|gb|mb)\b/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

export function parseVariantAttributes(name: string): VariantAttributes {
  const toks = tokenize(name);
  const edition: string[] = [];
  const idx = toks.indexOf("edition");
  if (idx > 0) {
    // the words immediately in front of "edition" name it ("galaxy black special edition")
    for (let i = Math.max(0, idx - 3); i < idx; i++) edition.push(toks[i]);
  }
  for (const t of toks) if (EDITION_WORDS.has(t) && !edition.includes(t)) edition.push(t);
  const generation: string[] = [];
  const lower = normalize(name);
  for (const m of lower.matchAll(/\b(\d+(?:st|nd|rd|th) gen|gen \d+|generation \d+|mk ?[ivx\d]+|mark [ivx]+|20[12]\d)\b/g)) generation.push(m[1]);
  return {
    capacity: [...new Set(toks.filter((t) => CAPACITY.test(t)))],
    colors: [...colorsIn(name)],
    edition,
    bundle: toks.some((t) => BUNDLE_WORDS.has(t)),
    region: toks.filter((t) => REGION_WORDS.has(t)),
    generation,
    carrier: toks.filter((t) => CARRIER_WORDS.has(t)),
  };
}

export function hasVariantAttributes(a: VariantAttributes): boolean {
  return a.capacity.length + a.colors.length + a.edition.length + a.region.length + a.generation.length + a.carrier.length > 0 || a.bundle;
}

/** The tokens of `name` that `parentName` does not have, minus filler. Empty when the name adds nothing. */
export function extraTokens(name: string, parentName: string): string[] {
  const parent = new Set(tokenize(parentName));
  return tokenize(name).filter((t) => !parent.has(t) && !FILLER.has(t) && t.length > 0);
}

function containsAllTokens(name: string, parentName: string): boolean {
  const have = new Set(tokenize(name));
  return tokenize(parentName).every((t) => have.has(t) || FILLER.has(t));
}

/** "Seagate 2TB Expansion Card for Xbox Series X": the parent's name comes after "for" / "compatible with", so it is the accessory's target. */
function parentAfterFor(name: string, parentName: string): boolean {
  const toks = tokenize(name);
  const parent = tokenize(parentName).filter((t) => !FILLER.has(t));
  if (parent.length === 0) return false;
  const first = toks.indexOf(parent[0]);
  if (first <= 0) return false;
  const before = toks.slice(0, first);
  return before.includes("for") || (before.includes("compatible") && before.includes("with")) || before.includes("fits");
}

/**
 * How `candidate` relates to an existing product named `existing`. Used before a research request is folded into an existing entry:
 * only "same" may be folded; a "variant" gets its own entry linked to the parent; an "accessory" or "different" product is its own thing.
 */
export function variantRelation(candidate: string, existing: string): VariantRelation {
  if (!containsAllTokens(candidate, existing)) return "different";
  if (parentAfterFor(candidate, existing)) return "accessory";
  const extras = extraTokens(candidate, existing);
  if (extras.length === 0) return "same";
  const attrs = parseVariantAttributes(extras.join(" "));
  const hasAccessoryNoun = extras.some((t) => ACCESSORY_NOUNS.has(t));
  const describesVersion = attrs.capacity.length > 0 || attrs.edition.length > 0 || attrs.bundle || attrs.generation.length > 0 || attrs.region.length > 0 || attrs.carrier.length > 0;
  if (hasAccessoryNoun && !describesVersion) return "accessory";
  // A bare colour is how a base product is routinely written ("Xbox Series S Black"), and the Database's own matcher (store.ts) already
  // lets a colourless name match any colour, so a colour alone does not split a research request off from the existing entry.
  if (extras.every((t) => isColorWord(t))) return "same";
  return "variant";
}

/**
 * The words a sold comp's title must contain to count as THIS variant rather than the parent: the variant's extra words, without the
 * ones every listing writes differently ("bundle", "edition", "disc drive", "special"). Capacity and colour are always required.
 */
export function requiredVariantTokens(name: string, parentName: string | null): string[] {
  if (!parentName || variantRelation(name, parentName) !== "variant") return [];
  const extras = extraTokens(name, parentName).filter((t) => !LOW_SIGNAL.has(t) && !EDITION_WORDS.has(t));
  return [...new Set(extras)];
}

/** True when a title contains every required token (a capacity written "2 TB" counts as "2tb"). */
export function titleHasTokens(title: string, required: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(tokenize(title));
  return required.every((t) => have.has(t));
}

/**
 * Valuing a variant: a comp is usable only when its title carries the variant's own words. Returns what to keep and why anything was dropped,
 * so the caller can say "insufficient evidence" instead of quietly pricing a special edition off standard-model sales.
 */
export function filterCompsForVariant<T extends { title: string }>(name: string, parentName: string | null, comps: T[]): { kept: T[]; required: string[]; dropped: number } {
  const required = requiredVariantTokens(name, parentName);
  if (required.length === 0) return { kept: comps, required, dropped: 0 };
  const kept = comps.filter((c) => titleHasTokens(c.title, required));
  return { kept, required, dropped: comps.length - kept.length };
}

/**
 * Valuing a parent: comps that are really one of its known variants must not drag its price (a 2TB special edition is not a standard
 * console). `children` are the names of the parent's tracked variants.
 */
export function filterCompsForParent<T extends { title: string }>(parentName: string, children: string[], comps: T[]): { kept: T[]; dropped: number } {
  const childTokens = children.map((c) => requiredVariantTokens(c, parentName)).filter((r) => r.length > 0);
  if (childTokens.length === 0) return { kept: comps, dropped: 0 };
  const kept = comps.filter((c) => !childTokens.some((req) => titleHasTokens(c.title, req)));
  return { kept, dropped: comps.length - kept.length };
}

/** Enough matched sold comps (or asking prices) to put a number on a variant. Below this the honest answer is "insufficient evidence". */
export const MIN_VARIANT_COMPS = 2;
export const MIN_VARIANT_ASKS = 3;

export type ValuationEvidence = { enough: true } | { enough: false; reason: string };

export function variantValuationEvidence(name: string, parentName: string | null, soldMatched: number, activeMatched: number, droppedAsOtherVersion: number): ValuationEvidence {
  const required = requiredVariantTokens(name, parentName);
  if (required.length === 0 || soldMatched >= MIN_VARIANT_COMPS || activeMatched >= MIN_VARIANT_ASKS) return { enough: true };
  const dropped = droppedAsOtherVersion > 0 ? ` ${droppedAsOtherVersion} sold listing${droppedAsOtherVersion === 1 ? "" : "s"} for other versions (the standard model, say) were set aside rather than used as its price.` : "";
  return {
    enough: false,
    reason: `Insufficient evidence to value "${name}": only ${soldMatched} sold listing${soldMatched === 1 ? "" : "s"} and ${activeMatched} asking price${activeMatched === 1 ? "" : "s"} name "${required.join(" ")}".${dropped}`,
  };
}

/**
 * One test for any eBay title being used to value `name`: it must carry the variant's own words, and must not be one of the product's own
 * tracked variants (so a parent's price is not pulled by its special edition, and a variant's is not pulled by the standard model).
 */
export function variantTitleGate(name: string, parentName: string | null, childNames: string[]): (title: string) => boolean {
  const required = requiredVariantTokens(name, parentName);
  const childReqs = childNames.map((c) => requiredVariantTokens(c, name)).filter((r) => r.length > 0);
  return (title) => titleHasTokens(title, required) && !childReqs.some((r) => titleHasTokens(title, r));
}

/** A search query that still carries the variant's words (a query derived from a listing title can drop "2TB" or the edition's name). */
export function ensureQueryHasTokens(query: string, required: string[]): string {
  const have = new Set(tokenize(query));
  const missing = required.filter((t) => !have.has(t));
  return missing.length ? `${query} ${missing.join(" ")}`.trim() : query;
}

/**
 * The distinguishing words of a free-form name when no parent is known (a chat search such as "Xbox Series X 2TB Galaxy Black Special Edition"):
 * its capacities, colours and the words that name its edition. A name with none of those has nothing to verify beyond its own wording.
 */
export function inferDistinguishingTokens(name: string): string[] {
  const attrs = parseVariantAttributes(name);
  const out = [...attrs.capacity, ...attrs.colors, ...attrs.edition.filter((t) => !EDITION_WORDS.has(t) && !LOW_SIGNAL.has(t))];
  return [...new Set(out.filter((t) => !FILLER.has(t)))];
}
