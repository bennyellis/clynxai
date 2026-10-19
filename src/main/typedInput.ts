// What the user typed is correct until proven otherwise. The only things repaired here are a spelling slip and the word order of a real product title ("Xbox X series" -> "Xbox Series X"),
// and only deterministically against words Clynx already knows (the Database's own names and a small list of common product words): no AI, no guessing, and a word that is already known is
// NEVER changed. Every repair is reported so the person (and Clynx's answer) can say "I read that as ...". Pure, no I/O.
import { identityTokens } from "./variantIdentity.js";
import { kindOfName } from "./productKind.js";

export interface Vocabulary {
  /** Lowercase words that may be used to repair a typo. */
  words: Set<string>;
  /** Whole product titles whose word order is authoritative (original casing). */
  titles: string[];
}

export interface Correction {
  kind: "spelling" | "word-order";
  from: string;
  to: string;
}

export interface NormalizedPhrase {
  text: string;
  original: string;
  corrections: Correction[];
}

const BUILTIN_WORDS = (
  "xbox series one playstation nintendo switch steam deck meta quest iphone ipad ipod macbook airpods apple samsung galaxy google pixel sony microsoft oled lite pro max plus mini ultra slim digital disc " +
  "console edition special limited collector collectors anniversary exclusive bundle black white blue red green gray grey silver gold pink purple orange yellow controller wireless halo infinite zelda mario " +
  "pokemon starfield forza horizon cyberpunk guardians kindle nikon canon gopro dyson roomba keurig vitamix kitchenaid nest ring fitbit garmin bose beats jbl logitech razer corsair nvidia radeon geforce"
).split(" ");

const BUILTIN_TITLES = ["Xbox Series X", "Xbox Series S", "Xbox One X", "Xbox One S", "PlayStation 5", "PlayStation 4", "Nintendo Switch", "Nintendo Switch 2", "Nintendo 3DS", "Steam Deck", "Meta Quest 3", "Game Boy Advance"];

export function buildVocabulary(productNames: string[]): Vocabulary {
  const words = new Set(BUILTIN_WORDS);
  const titles = [...BUILTIN_TITLES];
  for (const name of productNames) {
    const toks = wordsOf(name);
    for (const t of toks) if (/^[a-z]{3,}$/.test(t)) words.add(t);
    if (toks.length >= 3 && toks.length <= 5) titles.push(name.trim());
  }
  return { words, titles };
}

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Edit distance, giving up above `max` (returns max + 1). */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // two neighbouring letters swapped ("swtich") is one slip, not two
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** The one known word within one edit (two for long words) of an unknown word, or null when there is none or more than one equally close. */
function repairWord(word: string, vocab: Vocabulary): string | null {
  if (!/^[a-z]{4,}$/.test(word) || vocab.words.has(word)) return null;
  const max = word.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestD = max + 1;
  let tie = false;
  for (const known of vocab.words) {
    const d = distance(word, known, max);
    if (d < bestD) {
      best = known;
      bestD = d;
      tie = false;
    } else if (d === bestD && d <= max) tie = true;
  }
  return best && !tie && bestD <= max ? best : null;
}

export function normalizeTypedProduct(phrase: string, vocab: Vocabulary): NormalizedPhrase {
  const original = phrase.trim();
  const corrections: Correction[] = [];
  let words = original.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { text: original, original, corrections };

  // 1. spelling: only a word that is not a known word, with exactly one nearest known word
  words = words.map((w) => {
    const bare = w.toLowerCase().replace(/[^a-z]/g, "");
    if (bare !== w.toLowerCase().replace(/[^a-z0-9]/g, "")) return w; // has digits: never touched
    const fix = repairWord(bare, vocab);
    if (!fix) return w;
    const shown = vocab.titles.flatMap((t) => t.split(/\s+/)).find((x) => x.toLowerCase() === fix) ?? fix.charAt(0).toUpperCase() + fix.slice(1);
    corrections.push({ kind: "spelling", from: w, to: shown });
    return shown;
  });

  // 2. word order: a window of words that is a reordering of a known title is rewritten in that title's order ("Xbox X series" -> "Xbox Series X")
  const bare = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const ordered = [...vocab.titles].sort((a, b) => wordsOf(b).length - wordsOf(a).length);
  for (const title of ordered) {
    const tw = wordsOf(title);
    if (tw.length < 3 || tw.length > words.length) continue;
    const sortedTitle = [...tw].sort().join(" ");
    for (let i = 0; i + tw.length <= words.length; i++) {
      const window = bare.slice(i, i + tw.length);
      if (window.join(" ") === tw.join(" ")) break; // already in order
      if ([...window].sort().join(" ") !== sortedTitle) continue;
      const from = words.slice(i, i + tw.length).join(" ");
      words = [...words.slice(0, i), ...title.split(/\s+/), ...words.slice(i + tw.length)];
      corrections.push({ kind: "word-order", from, to: title });
      return { text: words.join(" "), original, corrections };
    }
  }
  return { text: corrections.length ? words.join(" ") : original, original, corrections };
}

/** "I read "xbox seris x" as "xbox Series X"." for the answer; empty when nothing was repaired. */
export function describeCorrections(n: NormalizedPhrase): string {
  if (n.corrections.length === 0) return "";
  const how = n.corrections.map((c) => (c.kind === "spelling" ? `spelling "${c.from}" -> "${c.to}"` : `word order "${c.from}" -> "${c.to}"`)).join("; ");
  return `I read "${n.original}" as "${n.text}" (${how}). Tell the user this correction in one short sentence and keep the original wording as what they typed.`;
}

export type Placement =
  | { kind: "ok" }
  | { kind: "gibberish" }
  | { kind: "choose"; options: string[] };

function wordLike(token: string, vocab: Vocabulary): boolean {
  if (vocab.words.has(token) || /\d/.test(token) || token.length <= 2) return true;
  if (!/[aeiouy]/.test(token)) return false;
  return !/[^aeiouy]{5,}/.test(token) && !/(.)\1{3,}/.test(token);
}

/**
 * Can Clynx place this phrase at all, and is it ambiguous between a game and a console already in the Database? A phrase of only non-words is not placed (nothing is created, the
 * user is asked); a phrase that is inside both a game's and a console's name ("halo infinite") is put to the user as a choice instead of being filed under either.
 */
export function placePhrase(phrase: string, vocab: Vocabulary, tracked: Array<{ name: string }>): Placement {
  const tokens = wordsOf(phrase);
  if (tokens.length === 0) return { kind: "gibberish" };
  if (tokens.every((t) => !wordLike(t, vocab))) return { kind: "gibberish" };
  const mine = identityTokens(phrase);
  if (mine.length === 0) return { kind: "ok" };
  const inside = tracked.filter((p) => {
    const theirs = identityTokens(p.name);
    return mine.every((t) => theirs.includes(t));
  });
  const games = inside.filter((p) => kindOfName(p.name) === "game");
  const machines = inside.filter((p) => kindOfName(p.name) === "hardware");
  if (games.length > 0 && machines.length > 0) return { kind: "choose", options: [...games.slice(0, 2), ...machines.slice(0, 2)].map((p) => p.name) };
  return { kind: "ok" };
}
