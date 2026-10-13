// Defining codes: the parts of a product's name or a listing's title that identify WHICH product it is, found with patterns that are the same
// for every kind of product (no category knowledge):
//
//   - a word that mixes letters and digits ("1403", "dcd791", "m18", "rtx3060", "ps5", "20v", "5ah")
//   - a bare number of three or more digits ("360", "3060", "12700")
//
// Storage capacities (gb/tb/mb) are handled by compFilter, a year ("2018") and small counts ("2", "10") say nothing about which product it is, so
// they are not codes. Comparing two texts goes BOTH ways: a code the reference has that the candidate lacks is a conflict, and a code the
// candidate has that the reference lacks is an unconfirmed difference (the old checks only looked in the first direction, so a generic name
// accepted every variant).

import { looksLikeAbbreviation } from "./resolver.js";

const CAPACITY = /^\d+(?:p\d+)?(?:tb|gb|mb)$/;
const YEAR = /^(?:19|20)\d\d$/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1p$2")
    .replace(/(\d)\s*[-]?\s*(tb|gb|mb|hz|mah|mm|ah|v)\b/g, "$1$2");
}

function rawTokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Numbers that are never a model identifier whatever the product: an ordinal ("13th", "2nd"), a time ("9pm"), a quantity ("2x"), and a very long
// digit run (eight or more digits: a phone number or an order id; seven-digit part numbers are real identifiers).
const NOT_AN_IDENTIFIER = /^(?:\d+(?:st|nd|rd|th)|\d{1,2}(?:am|pm)|\d+x|\d{8,})$/;

// Text that states a price, a discount or a distance, stripped before looking for codes ("$100 firm", "20% off", "15 dollars").
function withoutAmounts(text: string): string {
  return text.replace(/\$\s*\d[\d,.]*/g, " ").replace(/\d[\d,.]*\s*(?:dollars?|usd|bucks|%|percent)/gi, " ");
}

/** The defining codes of a text, lowercased and de-duplicated, in order of appearance. */
export function definingCodes(text: string): string[] {
  const out: string[] = [];
  for (const t of rawTokens(withoutAmounts(text))) {
    if (!/\d/.test(t)) continue;
    if (CAPACITY.test(t) || YEAR.test(t) || NOT_AN_IDENTIFIER.test(t)) continue;
    const mixed = /[a-z]/.test(t);
    if (!mixed && t.length < 3) continue; // "2", "10": counts and sizes, not identity
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// "3060" is present in "3060", "3060ti" and "rtx3060" (a model number glued to letters) but not in "30601" or "13060".
function presentIn(tokens: string[], wanted: string): boolean {
  return tokens.some((tok) => {
    for (let at = tok.indexOf(wanted); at !== -1; at = tok.indexOf(wanted, at + 1)) {
      if (!/\d/.test(tok[at - 1] ?? "") && !/\d/.test(tok[at + wanted.length] ?? "")) return true;
    }
    return false;
  });
}

// A code like "rtx3060" carries the number "3060": comparing by digit runs lets "x360" and "360" agree.
function sameCode(a: string, b: string): boolean {
  if (a === b) return true;
  const runs = (c: string) => c.match(/\d+/g) ?? [];
  const ra = runs(a);
  const rb = runs(b);
  const longestA = ra.sort((x, y) => y.length - x.length)[0];
  const longestB = rb.sort((x, y) => y.length - x.length)[0];
  return !!longestA && longestA === longestB && longestA.length >= 3;
}

/** Codes in `candidate` that `reference` does not contain. */
export function codesMissingFrom(reference: string, candidate: string): string[] {
  const refTokens = rawTokens(reference);
  return definingCodes(candidate).filter((c) => !presentIn(refTokens, c) && !definingCodes(reference).some((r) => sameCode(r, c)));
}

export type CodeRelation = "equal" | "candidate-has-more" | "reference-has-more" | "conflict";

/** How two texts relate by defining code, looking in both directions. */
export function relateCodes(reference: string, candidate: string): { relation: CodeRelation; extraInCandidate: string[]; missingInCandidate: string[] } {
  const extraInCandidate = codesMissingFrom(reference, candidate);
  const missingInCandidate = codesMissingFrom(candidate, reference);
  const relation: CodeRelation =
    extraInCandidate.length === 0 && missingInCandidate.length === 0
      ? "equal"
      : extraInCandidate.length > 0 && missingInCandidate.length > 0
        ? "conflict"
        : extraInCandidate.length > 0
          ? "candidate-has-more"
          : "reference-has-more";
  return { relation, extraInCandidate, missingInCandidate };
}

/**
 * A name for "this entry's product, more specifically": the entry's own name with the listing's extra defining codes added, in the listing's
 * own spelling ("Xbox Wireless Controller" + "Official Microsoft Xbox 360 ... 1403" -> "Xbox Wireless Controller 360 1403"). Used when a
 * listing turns out to be a more specific product than the entry it matched, so it gets (and prices) an entry of its own.
 */
export function specificNameFor(entryName: string, listingTitle: string, onlyCodes?: string[]): string {
  const extra = onlyCodes ?? codesMissingFrom(entryName, listingTitle);
  if (extra.length === 0) return entryName;
  const spelled = new Map<string, string>();
  for (const w of listingTitle.split(/[^A-Za-z0-9.]+/).filter(Boolean)) spelled.set(normalize(w).replace(/[^a-z0-9]/g, ""), w);
  const added = extra.map((c) => spelled.get(c) ?? c);
  return `${entryName.trim()} ${added.join(" ")}`.replace(/\s+/g, " ").trim();
}

/**
 * A code that is only a short form of words the name already spells out: "ps5" against "PlayStation 5". True when the letters of the code are an
 * abbreviation of a word in the name and its number is a word of the name too. Used only to stop a difference in WRITING from being treated as a
 * difference in product; it never makes two products the same (unsafe abbreviations like this are only ever suggestions elsewhere).
 */
export function aliasCovered(code: string, entryName: string): boolean {
  const m = /^([a-z]{2,4})(\d+)$/.exec(code);
  if (!m) return false;
  const tokens = rawTokens(entryName);
  return tokens.includes(m[2]) && tokens.some((t) => /^[a-z]+$/.test(t) && looksLikeAbbreviation(m[1], t));
}
