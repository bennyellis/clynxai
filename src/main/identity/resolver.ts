// The PROPOSED identity resolver, used only in shadow mode so far (nothing in the live app calls it). It decides how two product texts relate by
// comparing what each one states, looking in BOTH directions, with no knowledge of any product category:
//
//   exact      both state the same things (after generic normalization such as splitting "x360"/"ps5" into letters and number, "2nd" -> "2")
//   possible-alias  equal only if a short letter group is an abbreviation of a longer word on the other side ("ps" / "playstation"). Unreliable
//              on its own ("nintendogs" / "nintendo"), so it is only ever a suggestion for a confirmed alias, never a match
//   line       one side states more than the other (a model number, a version word, a capacity): the more specific one is a narrower product
//   different  each side states something the other does not (different model numbers, different letters, different capacities)
//
// The old matcher (store.isSimilarProductName) says "same" whenever the shorter name's words are inside the longer one, ignoring numbers
// and version words; this one never calls that exact. In shadow mode the two are compared and every disagreement is logged with its evidence.
import { NOISE_WORDS } from "./words.js";

export type IdentityLevel = "exact" | "line" | "different" | "possible-alias";

export interface IdentityComparison {
  level: IdentityLevel;
  // Which side is the more specific one when level is "line".
  moreSpecific: "a" | "b" | null;
  // A short word that looks like an abbreviation of a longer one on the other side (pairs like ["ps", "playstation"]): exact only by inference.
  aliasPairs: Array<[string, string]>;
  onlyInA: string[];
  onlyInB: string[];
  capacity: "equal" | "conflict" | "a-only" | "b-only" | "none";
  reasons: string[];
}

const CAPACITY = /\b(\d+(?:\.\d+)?)\s*-?\s*(tb|gb|mb)\b/g;

export interface IdentityTokens {
  words: Set<string>;
  capacities: Set<string>;
}

export function identityTokens(text: string, optional?: ReadonlySet<string>): IdentityTokens {
  // A possessive ("Cord's") is not a word "s": a stray one made "Xbox Series X ... Cord's" look like a Series S.
  let s = text.toLowerCase().replace(/['’]s\b/g, "");
  const capacities = new Set<string>();
  s = s.replace(CAPACITY, (_m, n: string, unit: string) => {
    capacities.add(`${n.replace(".", "p")}${unit}`);
    return " ";
  });
  // "+" after a name is part of it ("S21+" is not "S21"); written as a word so it compares like one.
  s = s.replace(/(\d)\.(\d)/g, "$1p$2").replace(/(\w)\s*\+(?![a-z0-9])/g, "$1 plus ").replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1");
  const words = new Set<string>();
  // Filler is judged on whole words first, THEN glued letter+number words are split ("7a" must not lose its "a" to the article filter).
  for (const whole of s.split(/[^a-z0-9]+/)) {
    if (!whole || NOISE_WORDS.has(whole)) continue;
    for (const w of whole.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").split(" ")) {
      if (w && !optional?.has(w)) words.add(w);
    }
  }
  return { words, capacities };
}

// "ps" for "playstation", "nin" for "nintendo": a short letter group whose letters appear in order inside a longer word that starts with the same
// letter. Only ever used to explain a leftover pair of unshared words, never to bridge a number or a lone letter.
export function looksLikeAbbreviation(short: string, long: string): boolean {
  if (short === long || short.length < 2 || long.length < short.length + 2) return false;
  if (!/^[a-z]+$/.test(short) || !/^[a-z]+$/.test(long)) return false;
  if (short[0] !== long[0]) return false;
  let at = 0;
  for (const ch of short) {
    at = long.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

// `optional`: words that, in the data being compared, often begin a name without changing what it is (learned by learnOptionalWords, never listed here).
export function compareIdentity(a: string, b: string, optional?: ReadonlySet<string>): IdentityComparison {
  const A = identityTokens(a, optional);
  const B = identityTokens(b, optional);
  const reasons: string[] = [];
  const onlyInA = [...A.words].filter((w) => !B.words.has(w));
  const onlyInB = [...B.words].filter((w) => !A.words.has(w));

  // capacity: both state one and they differ = different products; only one states it = that side is narrower
  const capA = [...A.capacities];
  const capB = [...B.capacities];
  let capacity: IdentityComparison["capacity"] = "none";
  if (capA.length && capB.length) capacity = capA.some((c) => B.capacities.has(c)) ? "equal" : "conflict";
  else if (capA.length) capacity = "a-only";
  else if (capB.length) capacity = "b-only";

  // pair up leftover words that look like abbreviations of each other
  const aliasPairs: Array<[string, string]> = [];
  const restA = [...onlyInA];
  const restB = [...onlyInB];
  for (const x of [...restA]) {
    const j = restB.findIndex((y) => looksLikeAbbreviation(x, y) || looksLikeAbbreviation(y, x));
    if (j >= 0) {
      aliasPairs.push([x, restB[j]]);
      restA.splice(restA.indexOf(x), 1);
      restB.splice(j, 1);
    }
  }

  // A short form only counts when it explains the WHOLE difference between the two names ("ps 5 slim" / "playstation 5 slim"). Otherwise it is
  // coincidence ("ds" fits inside "division") and the pairing is discarded.
  if (aliasPairs.length > 0 && (restA.length > 0 || restB.length > 0)) {
    aliasPairs.length = 0;
    restA.splice(0, restA.length, ...onlyInA);
    restB.splice(0, restB.length, ...onlyInB);
  }

  if (capacity === "conflict") reasons.push(`capacity differs (${capA.join("/")} vs ${capB.join("/")})`);
  if (restA.length && restB.length) {
    reasons.push(`each states something the other does not (${restA.join(" ")} | ${restB.join(" ")})`);
    return { level: "different", moreSpecific: null, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  }
  if (capacity === "conflict") return { level: "different", moreSpecific: null, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };

  const aExtra = restA.length > 0 || capacity === "a-only";
  const bExtra = restB.length > 0 || capacity === "b-only";
  if (aExtra && bExtra) {
    // one has extra words, the other an extra capacity: each is narrower in its own way
    reasons.push("each is more specific than the other in a different way");
    return { level: "different", moreSpecific: null, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  }
  if (aExtra || bExtra) {
    const side = aExtra ? "a" : "b";
    reasons.push(`${side === "a" ? "first" : "second"} also states: ${[...(aExtra ? restA : restB), ...(capacity === `${side}-only` ? [side === "a" ? capA[0] : capB[0]] : [])].join(" ")}`);
    return { level: "line", moreSpecific: side, aliasPairs, onlyInA: restA, onlyInB: restB, capacity, reasons };
  }
  if (aliasPairs.length) {
    reasons.push(`equal only if ${aliasPairs.map(([x, y]) => `"${x}" means "${y}"`).join(", ")}`);
    return { level: "possible-alias", moreSpecific: null, aliasPairs, onlyInA: [], onlyInB: [], capacity, reasons };
  }
  return { level: "exact", moreSpecific: null, aliasPairs, onlyInA: [], onlyInB: [], capacity, reasons };
}

/**
 * Words that start many different names in a collection ("microsoft ...", "samsung ...", "sony ..."): by how the data itself is written, they say who
 * makes something, not which product it is, so a name with and without them is not two products. Learned from the names given, never listed in code.
 */
export function learnOptionalWords(names: string[], minNames = 4): Set<string> {
  const firsts = new Map<string, number>();
  for (const n of names) {
    const first = n.toLowerCase().split(/[^a-z0-9]+/).find((w) => w && !NOISE_WORDS.has(w));
    if (first && !/\d/.test(first)) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  return new Set([...firsts].filter(([, n]) => n >= minNames).map(([w]) => w));
}
