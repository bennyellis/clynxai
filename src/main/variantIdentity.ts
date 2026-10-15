// What makes one product a VARIANT of another (a storage size, a color, a special edition, a bundle, a regional model, a generation), worked
// out from the words of a name alone: no product, brand or edition is listed here, so a name nobody has seen before is handled the same way
// as "iPhone 15 Pro 256GB Natural Titanium" or "Xbox Series X 2TB Galaxy Black Special Edition".
//
// Pure functions, no I/O. Used by the research planner (what to search for), the evidence check (what a source has to say to count), the
// Database (parent product vs. verified variant) and the comps filter (a special edition's sales are not the standard model's sales).

import { capacityTokens } from "./compFilter.js";
import { colorsIn, isColorWord } from "./colors.js";

/** Words that say nothing about WHICH product it is. */
const NOISE = new Set([
  "the", "a", "an", "and", "or", "with", "for", "of", "in", "to", "by", "w", "new", "used", "brand", "sealed", "console", "edition", "bundle", "official",
  "genuine", "authentic", "condition", "great", "excellent", "good", "like", "pack", "set", "kit", "free", "shipping", "fast", "includes", "included",
]);

/** Words that mark an edition rather than name a model: "Special Edition", "Limited", "Collector's", "Anniversary". */
const EDITION_MARKERS = new Set(["special", "limited", "collector", "collectors", "anniversary", "exclusive", "signature", "founder", "founders", "commemorative", "deluxe"]);

const REGION_WORDS = new Set([
  "us", "usa", "eu", "uk", "jp", "jpn", "japan", "japanese", "asia", "asian", "ntsc", "pal", "international", "intl", "import", "korea", "korean", "canada",
  "canadian", "australia", "australian", "euro", "european",
]);

/** Tier words that make a different product, not a variant of the same one (the Pro is not a special color of the base model). */
const TIER_WORDS = new Set(["ti", "super", "xt", "xtx", "pro", "max", "plus", "slim", "oled", "lite", "mini", "se", "xl", "air", "ultra", "fe"]);

/** Things bought FOR a product, not versions of it. */
const ACCESSORY_NOUNS = new Set([
  "controller", "controllers", "charger", "cable", "case", "dock", "stand", "headset", "remote", "adapter", "battery", "strap", "grip", "skin", "cover",
  "protector", "mount", "holster", "faceplate", "thumbstick", "thumbsticks", "gamepad", "joycon", "joy-con",
]);

const CAPACITY = /^\d+(?:p\d+)?(?:tb|gb|mb)$/;

/** Lowercased, capacities glued ("2 TB" and "2 terabytes" both become "2tb"), apostrophes dropped, "+" and "&" read as "and". */
export function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/(\d)\.(\d)/g, "$1p$2")
    .replace(/(\d+(?:p\d+)?)\s*[-]?\s*(?:terabytes?|tb)\b/g, "$1tb")
    .replace(/(\d+(?:p\d+)?)\s*[-]?\s*(?:gigabytes?|gb)\b/g, "$1gb")
    .replace(/(\d+(?:p\d+)?)\s*[-]?\s*(?:megabytes?|mb)\b/g, "$1mb")
    .replace(/[+&]/g, " and ");
}

export function nameTokens(text: string): string[] {
  return normalizeName(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The tokens that identify a product: no filler words. */
export function identityTokens(text: string): string[] {
  return nameTokens(text).filter((t) => !NOISE.has(t));
}

export type ProductKind = "base" | "accessory" | "bundle";

export interface VariantAttributes {
  capacities: string[];
  colors: string[];
  /** "special", "limited", ... and the themed word before "edition" when it is not a color or capacity ("Zelda Edition" gives "zelda"). */
  editionTerms: string[];
  regions: string[];
  /** Whether the name says it comes with other things ("with 2 controllers", "bundle", "+"). */
  bundle: boolean;
  kind: ProductKind;
}

export function classifyKind(name: string): ProductKind {
  const norm = normalizeName(name);
  if (/\b(bundle|combo|includes?|w\/)\b|\band\b|\bwith\b/.test(norm)) return "bundle";
  if (nameTokens(name).some((t) => ACCESSORY_NOUNS.has(t))) return "accessory";
  return "base";
}

export function extractVariantAttributes(name: string): VariantAttributes {
  const tokens = nameTokens(name);
  const editionTerms = new Set<string>(tokens.filter((t) => EDITION_MARKERS.has(t)));
  // The word(s) just before "edition": "Zelda Edition", "Galaxy Edition", but not "Special Edition" (a marker already) or "Black Edition" (a color).
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] !== "edition") continue;
    const prev = tokens[i - 1];
    if (!NOISE.has(prev) && !EDITION_MARKERS.has(prev) && !isColorWord(prev) && !CAPACITY.test(prev) && !/^\d+$/.test(prev)) editionTerms.add(prev);
  }
  const kind = classifyKind(name);
  return {
    capacities: capacityTokens(name),
    colors: [...colorsIn(name)].sort(),
    editionTerms: [...editionTerms],
    regions: tokens.filter((t) => REGION_WORDS.has(t)),
    bundle: kind === "bundle",
    kind,
  };
}

export interface Distinguishing {
  capacities: string[];
  colors: string[];
  editionTerms: string[];
  regions: string[];
  /** Any other word the longer name has and the shorter one does not ("galaxy", "zelda", "spiderman"): themed names no word list could know. */
  other: string[];
  all: string[];
}

/** What `name` says that `parentName` does not: the words that make it a more specific product. Empty when it says nothing more. */
export function distinguishingTokens(name: string, parentName: string): Distinguishing {
  const parent = new Set(identityTokens(parentName));
  const out: Distinguishing = { capacities: [], colors: [], editionTerms: [], regions: [], other: [], all: [] };
  const seen = new Set<string>();
  for (const t of identityTokens(name)) {
    if (parent.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.all.push(t);
    if (CAPACITY.test(t)) out.capacities.push(t);
    else if (isColorWord(t)) out.colors.push(t);
    else if (EDITION_MARKERS.has(t)) out.editionTerms.push(t);
    else if (REGION_WORDS.has(t)) out.regions.push(t);
    else out.other.push(t);
  }
  return out;
}

/** True when `name` is the same product line as `parentName` plus something more (a capacity, color, edition, theme, region). */
export function isMoreSpecific(name: string, parentName: string): boolean {
  const mine = new Set(identityTokens(name));
  const theirs = identityTokens(parentName);
  if (theirs.length === 0 || !theirs.every((t) => mine.has(t))) return false;
  return distinguishingTokens(name, parentName).all.length > 0;
}

function tierWordsOf(name: string): Set<string> {
  return new Set(nameTokens(name).filter((t) => TIER_WORDS.has(t)));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * The tracked product that `name` is a more specific version of, if any: its words are all in `name`, it is not an accessory standing in for a
 * device (a controller is not a version of the console), it is not a different tier (a Pro is a product of its own), and nothing it already says
 * (a color, a capacity, an edition) is contradicted. Among several, the most specific one wins. null when there is no such entry.
 */
export function findParentCandidate<T extends { name: string }>(name: string, candidates: T[]): T | null {
  const mine = new Set(identityTokens(name));
  const myKind = classifyKind(name);
  const myColors = colorsIn(name);
  const myCaps = new Set(capacityTokens(name));
  const myTiers = tierWordsOf(name);
  let best: { entry: T; size: number } | null = null;
  for (const entry of candidates) {
    const theirs = identityTokens(entry.name);
    if (theirs.length < 2 || theirs.length >= mine.size) continue;
    if (!theirs.every((t) => mine.has(t))) continue;
    const theirKind = classifyKind(entry.name);
    if (myKind === "accessory" && theirKind !== "accessory") continue;
    if (theirKind === "accessory" && myKind !== "accessory") continue;
    if (!sameSet(tierWordsOf(entry.name), myTiers)) continue;
    const theirColors = colorsIn(entry.name);
    if (theirColors.size > 0 && ![...theirColors].every((c) => myColors.has(c))) continue;
    if (!capacityTokens(entry.name).every((c) => myCaps.has(c))) continue;
    if (best === null || theirs.length > best.size) best = { entry, size: theirs.length };
  }
  return best ? best.entry : null;
}

/** The product line with the variant words taken out ("Xbox Series X 2TB Galaxy Black Special Edition" -> "Xbox Series X Galaxy"): what to search when the full title finds nothing. */
export function parentGuess(name: string): string {
  const words = name.trim().split(/\s+/);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const norm = nameTokens(words[i]);
    if (norm.length === 0) continue;
    if (norm.every((t) => CAPACITY.test(t) || isColorWord(t) || EDITION_MARKERS.has(t) || REGION_WORDS.has(t) || NOISE.has(t))) continue;
    kept.push(words[i].replace(/^[(\[]+|[)\],.;:]+$/g, ""));
  }
  return kept.join(" ").trim() || name.trim();
}

export type SearchPurpose = "exact" | "official" | "parent_attributes" | "manufacturer_site" | "parent_variants" | "alternate_names";

export interface SearchStep {
  query: string;
  purpose: SearchPurpose;
}

function capacityAlternates(name: string): string[] {
  const out: string[] = [];
  for (const cap of capacityTokens(name)) {
    const m = /^(\d+(?:p\d+)?)(tb|gb|mb)$/.exec(cap);
    if (!m) continue;
    const n = m[1].replace("p", ".");
    out.push(`${n} ${m[2].toUpperCase()}`, `${n} ${m[2] === "tb" ? "terabyte" : m[2] === "gb" ? "gigabyte" : "megabyte"}`);
  }
  return out;
}

/**
 * The searches to try, in order, for a product title. An exact-title search that finds nothing proves nothing (sellers abbreviate, retailers
 * reorder words, manufacturers say "Galaxy Black" where a listing says "Black Galaxy"), so the plan goes on to: the product line plus the
 * distinctive attributes, the manufacturer's own site, the line's list of editions and options, and alternate spellings of the same facts.
 * `brandHints` are manufacturer or company names to aim the site search at (the first word of the name is always tried).
 */
export function buildSearchPlan(name: string, opts: { brandHints?: string[]; maxSteps?: number } = {}): SearchStep[] {
  const clean = name.trim().replace(/\s+/g, " ");
  const maxSteps = opts.maxSteps ?? 7;
  const steps: SearchStep[] = [];
  const add = (query: string, purpose: SearchPurpose) => {
    const q = query.trim().replace(/\s+/g, " ");
    if (q && !steps.some((s) => s.query.toLowerCase() === q.toLowerCase())) steps.push({ query: q, purpose });
  };
  const attrs = extractVariantAttributes(clean);
  const parent = parentGuess(clean);
  const attrWords = [...attrs.colors, ...attrs.editionTerms.filter((t) => !["special", "limited", "exclusive"].includes(t)), ...attrs.capacities.map((c) => capacityAlternates(c)[0] ?? c)]
    .join(" ")
    .trim();
  const attrWordsFull = [attrs.capacities.map((c) => capacityAlternates(c)[0] ?? c).join(" "), attrs.colors.join(" "), attrs.editionTerms.join(" "), attrs.regions.join(" ")]
    .join(" ")
    .trim();

  add(`"${clean}"`, "exact");
  if (!/\bofficial\b/i.test(clean)) add(`${clean} official`, "official");
  if (parent.toLowerCase() !== clean.toLowerCase()) add(`${parent} ${attrWordsFull}`, "parent_attributes");
  const first = identityTokens(parent).find((t) => t.length >= 3 && /^[a-z]+$/.test(t));
  const brands = [...new Set([...(first ? [first] : []), ...(opts.brandHints ?? []).map((b) => b.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean)])].slice(0, 3);
  for (const b of brands) add(`${parent} ${attrWords || attrWordsFull} site:${b}.com`, "manufacturer_site");
  if (parent.toLowerCase() !== clean.toLowerCase() || attrWordsFull) add(`${parent} editions colors storage options`, "parent_variants");
  const alts = capacityAlternates(clean);
  if (alts.length > 0) {
    let swapped = clean;
    for (const cap of capacityTokens(clean)) swapped = swapped.replace(new RegExp(cap.replace(/(\d)p(\d)/, "$1.$2"), "i"), capacityAlternates(cap)[0] ?? cap);
    add(swapped, "alternate_names");
  }
  add(`${parent} ${attrs.colors.join(" ")} ${attrs.editionTerms.join(" ")} edition`, "alternate_names");
  return steps.slice(0, maxSteps);
}

const EDITION_PHRASE = /\b(special|limited|collectors?|anniversary|exclusive|commemorative|signature|founders?|deluxe)\s+(edition|bundle|release|model|version|run|pack)\b/;

/**
 * True when a sold comp or listing title is a DIFFERENT edition from the product being valued, so its price is not this product's price:
 *  - the product names an edition ("Special Edition", "Zelda Edition") or a distinguishing word the caller knows (`required`: the words that
 *    separate it from its parent, e.g. "galaxy") and the title does not say it; or
 *  - the title says it is a special/limited/collector's/anniversary edition and the product does not.
 * "Limited time offer" is not an edition. A comp that fails this is left out of the value rather than borrowed from the standard model.
 */
export function editionConflict(reference: string, title: string, required: string[] = []): boolean {
  const refAttrs = extractVariantAttributes(reference);
  const titleTokens = new Set(identityTokens(title));
  const wanted = new Set<string>([...refAttrs.editionTerms, ...required.map((r) => r.toLowerCase())]);
  for (const t of wanted) if (!titleTokens.has(t)) return true;
  if (EDITION_PHRASE.test(normalizeName(title)) && refAttrs.editionTerms.length === 0 && !EDITION_PHRASE.test(normalizeName(reference))) return true;
  return false;
}
