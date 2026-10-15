import { colorsConflict } from "./colors.js";

// Deterministic "is this eBay listing really the product we searched for" checks. eBay's own search (and
// WatchCount's) is loose: a search for a 4TB card also returns the 1TB and 2TB cards, a "3060" search returns
// "3060 Ti", and so on. The AI identity pass that follows is a judgment call a fast model can get wrong, so
// the things that are plain facts (capacity, model numbers, tier words like Ti/Pro/OLED) are checked here in
// code first and never left to the model.

// Tier/variant words that make a different product from the base one. A listing must agree with the
// reference on every one of them: "3060 Ti" isn't a "3060", and a "Switch" isn't a "Switch OLED".
export const TIER_WORDS = ["ti", "super", "xt", "xtx", "pro", "max", "plus", "slim", "oled", "lite", "mini", "se", "xl", "air", "ultra", "fe"];

const CAPACITY_TOKEN = /^\d+(?:p\d+)?(?:tb|gb|mb)$/;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1p$2")
    .replace(/(\d)\s*[-]?\s*(tb|gb|mb|hz|mah|mm)\b/g, "$1$2");
}

export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Tokens that carry a digit: model numbers, capacities, generations ("3060", "4tb", "ps5", "13"). */
export function specTokens(text: string): string[] {
  return [...new Set(tokens(text).filter((t) => /\d/.test(t)))];
}

export function capacityTokens(text: string): string[] {
  return specTokens(text).filter((t) => CAPACITY_TOKEN.test(t));
}

// "3060" is present in "3060", "3060ti", "rtx3060" and "rtx3060ti" (a model number glued to letters) but not in "30601" or "13060".
export function hasSpecToken(titleTokens: string[], wanted: string): boolean {
  return titleTokens.some((tok) => {
    for (let at = tok.indexOf(wanted); at !== -1; at = tok.indexOf(wanted, at + 1)) {
      if (!/\d/.test(tok[at - 1] ?? "") && !/\d/.test(tok[at + wanted.length] ?? "")) return true;
    }
    return false;
  });
}

export function hasTierWord(text: string, word: string): boolean {
  // letters on either side would make it part of another word ("pro" in "protector"); digits are fine ("3060ti").
  return new RegExp(`(?<![a-z])${word}(?![a-z])`).test(normalize(text));
}

// A lone letter after a word is part of a model's name: "Series S" / "Series X", "One S" / "One X", "Galaxy Z". Maps each such
// word to the letters that follow it ("series" -> {s} for "Xbox Series S"; "Series X|S" gives {x, s}).
export function modelLetters(text: string): Map<string, Set<string>> {
  const toks = tokens(text);
  const map = new Map<string, Set<string>>();
  for (let i = 0; i < toks.length; i++) {
    const word = toks[i];
    if (word.length < 3 || /\d/.test(word)) continue;
    const letters = new Set<string>();
    for (let j = i + 1; j <= i + 2 && j < toks.length && toks[j].length === 1 && /[b-hj-z]/.test(toks[j]); j++) letters.add(toks[j]);
    if (letters.size === 0) continue;
    const have = map.get(word) ?? new Set<string>();
    letters.forEach((l) => have.add(l));
    map.set(word, have);
  }
  return map;
}

export function hasModelLetters(text: string): boolean {
  return modelLetters(text).size > 0;
}

/** A name that picks ONE lettered model ("Xbox Series S"), as opposed to naming several ("Series X|S") or none. */
export function hasSingleModelLetter(text: string): boolean {
  return [...modelLetters(text).values()].some((letters) => letters.size === 1);
}

/**
 * True when the two texts name different lettered models of the same line: an Xbox "Series S" is not a "Series X", a "One S" not a
 * "One X". (A title naming both, like "Series X|S", doesn't conflict with either.) Single letters have no digits to compare, so
 * plain word matching can never tell these apart, and their prices differ by hundreds of dollars.
 */
export function modelLettersConflict(reference: string, title: string): boolean {
  const wanted = modelLetters(reference);
  const found = modelLetters(title);
  for (const [word, letters] of wanted) {
    const there = found.get(word);
    if (there && ![...letters].some((l) => there.has(l))) return true;
  }
  return false;
}

/**
 * True when `title` could be the product described by `reference` as far as the hard facts go: every model
 * number / capacity in the reference appears in the title, the title doesn't name a different capacity, and
 * the two agree on tier words (Ti / Pro / OLED / ...). Says nothing about brand, edition or bundle: that's
 * the AI pass's job.
 */
export function compMatchesSpecs(reference: string, title: string): boolean {
  const titleTokens = tokens(title);
  const wanted = specTokens(reference);
  for (const spec of wanted) if (!hasSpecToken(titleTokens, spec)) return false;

  const wantedCapacities = capacityTokens(reference);
  if (wantedCapacities.length > 0) {
    for (const cap of capacityTokens(title)) if (!wantedCapacities.includes(cap)) return false;
  }

  for (const word of TIER_WORDS) {
    if (hasTierWord(reference, word) !== hasTierWord(title, word)) return false;
  }
  // A white console's sale isn't a black console's sale (a title that names no color is let through to the AI pass).
  if (colorsConflict(reference, title)) return false;
  // ...and a Series S isn't a Series X.
  if (modelLettersConflict(reference, title)) return false;
  return true;
}

/**
 * The text the hard-fact checks should be run against: the search query, plus any capacity the product's own
 * name states that the query dropped (a query derived from a listing title can lose "4TB" while the Database
 * entry is explicitly the 4TB one).
 */
export function specReference(query: string, productName: string): string {
  const missing = capacityTokens(productName).filter((cap) => !capacityTokens(query).includes(cap));
  return capacityTokens(query).length === 0 && missing.length > 0 ? `${query} ${missing.join(" ")}` : query;
}

// Words that mean an eBay listing is for something ELSE than the product itself (its case, a box, parts, a lot of them,
// a different edition).
export const NOT_THE_PRODUCT_WORDS = /\b(parts?|repair|broken|not working|non[- ]?working|doesn'?t work|won'?t (turn on|power on|boot)|no power|faulty|defective|bricked|case only|empty box|box only|replacement|skin|decal|cover|stand only|charger only|cable only|manual only|lot of|bundle|read description|for parts|limited edition|special edition|collector'?s|steelbook)\b/i;

// Things that get sold FOR a product (parts and accessories), whose photos and prices are not the product's.
export const ACCESSORY_WORDS = /\b(motherboard|mainboard|controllers?|joysticks?|thumbsticks?|fan|heatsink|faceplate|remote|keyboard|headset|battery|charger|cable|adapter|dock|mount|psu|hdmi|protector|tempered|holster|backplate|housing)\b/g;

/**
 * Does an eBay listing title look like it is for exactly this product? Plain text checks, no AI: every word of the
 * product's name is in the title, the hard facts agree (model number, capacity, tier words, color), and the title
 * doesn't say parts / case only / bundle / special edition (unless the product's own name does).
 */
export function titleLooksLikeProduct(productName: string, title: string): boolean {
  const wanted = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !["the", "and", "for", "with", "of", "edition"].includes(w));
  if (wanted.length === 0) return false;
  const haystack = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (!wanted.every((w) => haystack.includes(w))) return false;
  if (NOT_THE_PRODUCT_WORDS.test(title) && !NOT_THE_PRODUCT_WORDS.test(productName)) return false;
  // A part or accessory of the product (its motherboard, a controller for it) is not the product, unless the product's
  // own name says so (the "Xbox Wireless Controller" entry is all about controllers).
  const lowerName = productName.toLowerCase();
  for (const m of title.toLowerCase().matchAll(ACCESSORY_WORDS)) {
    if (!lowerName.includes(m[1])) return false;
  }
  return compMatchesSpecs(productName, title);
}

/** WatchCount/eBay search choke on characters like "|" ("Series X|S" returned nothing at all). */
export function sanitizeSearchQuery(query: string): string {
  return query
    .replace(/[|/\\]+/g, " ")
    .replace(/[^\p{L}\p{N}\s.\-+&']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
