// Finding out that a special edition exists, and what it looks like, from what sources SAY, with no list of characters or franchises built in. A page that mentions
// "Pikachu Edition" next to a console name gives the edition's name, the words used about its design ("yellow", "face on the lid"), and the capitalised terms it is themed on
// ("Pokemon", "Pikachu"). Nothing is believed from one weak source: an edition needs two independent sources, or a manufacturer / specialist one. Pure.
import { sourceQuality, QUALITY_RANK, type SourceQuality } from "./evidenceKinds.js";
import type { Observation } from "./visualProfile.js";

export interface EditionPage {
  url: string;
  title: string;
  text: string;
}

export interface EditionHit {
  /** "Pikachu Edition" */
  name: string;
  quotes: Array<{ text: string; url: string; quality: SourceQuality }>;
  /** Capitalised terms the sentences connect it to ("Pokemon", "Pikachu"): not yet classified as franchise or character. */
  themeTerms: string[];
  sourceUrls: string[];
  bestQuality: SourceQuality;
  /** Which of the product names given (models of the line) the sources name together with this edition: "New Nintendo 3DS XL Pikachu Edition" ties it to that model. */
  models: string[];
}

const GENERIC_EDITION = new Set(["special", "limited", "standard", "collector", "collectors", "digital", "deluxe", "ultimate", "premium", "launch", "day", "one", "new", "the", "this", "that", "every", "each", "an", "a", "all", "its", "our", "your", "first", "last", "complete", "gold", "silver"]);
const STOP_THEME = new Set(["Edition", "Limited", "Special", "Console", "Handheld", "System", "The", "This", "It", "In", "On", "Of", "And", "For", "With", "A", "An", "New", "Nintendo", "Microsoft", "Sony", "Apple", "Xbox", "PlayStation", "Series", "Released", "Released", "Available", "Also", "Another", "Version", "Model", "Color", "Colour", "Design", "Shell", "Faceplate", "Includes", "Features", "Comes", "Came", "Was", "Is", "XL", "LL"]);

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 10 && s.length < 500);

/** "Pikachu Edition", "Majora's Mask Special Edition" -> the words before "Edition", capitalised like a name. */
const EDITION_RE = /\b((?:[A-Z][\w'’.&:!\-]*)(?:\s+(?:of|the|and|&|[A-Z][\w'’.&:!\-]*)){0,4})\s+(?:(?:Limited|Special|Collector['’]?s)\s+)?(Edition|Style)\b/g;

/** The product names (longest match wins: "New Nintendo 3DS XL" hides "New Nintendo 3DS") that a sentence names. */
function modelsNamedIn(names: string[], sentence: string): string[] {
  const t = ` ${sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const found = names.filter((n) => n && t.includes(` ${n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `));
  return found.filter((n) => !found.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase())));
}

export function extractEditions(familyNames: string[], pages: EditionPage[], brandHints: string[] = []): EditionHit[] {
  const family = familyNames.map((f) => f.toLowerCase());
  const famWords = new Set(familyNames.flatMap((f) => f.toLowerCase().split(/\s+/)));
  const byName = new Map<string, EditionHit>();
  for (const page of pages) {
    const quality = sourceQuality(page.url, familyNames[0] ?? "", brandHints);
    for (const s of sentencesOf(page.text)) {
      if (!family.some((f) => s.toLowerCase().includes(f)) && !/\bedition\b/i.test(s)) continue;
      for (const m of s.matchAll(EDITION_RE)) {
        const words = m[1].split(/\s+/).filter((w) => !GENERIC_EDITION.has(w.toLowerCase()));
        // drop family words that lead the capture ("New Nintendo 3DS XL Pikachu" -> "Pikachu")
        while (words.length && famWords.has(words[0].toLowerCase())) words.shift();
        if (!words.length) continue;
        const name = `${words.join(" ")} ${m[2]}`;
        const k = name.toLowerCase();
        const hit = byName.get(k) ?? { name, quotes: [], themeTerms: [], sourceUrls: [], bestQuality: "other" as SourceQuality, models: [] };
        for (const mname of modelsNamedIn(familyNames, s)) if (!hit.models.includes(mname)) hit.models.push(mname);
        if (!hit.sourceUrls.includes(page.url)) hit.sourceUrls.push(page.url);
        if (hit.quotes.length < 4 && !hit.quotes.some((q) => q.url === page.url)) hit.quotes.push({ text: s.slice(0, 260), url: page.url, quality });
        if (QUALITY_RANK[quality] < QUALITY_RANK[hit.bestQuality]) hit.bestQuality = quality;
        for (const t of s.match(/\b[A-ZÉ][\wé'’\-]{2,}\b/g) ?? []) {
          if (STOP_THEME.has(t) || famWords.has(t.toLowerCase()) || family.some((f) => f.includes(t.toLowerCase()))) continue;
          if (!hit.themeTerms.includes(t)) hit.themeTerms.push(t);
        }
        byName.set(k, hit);
      }
    }
  }
  const independent = (h: EditionHit) => new Set(h.quotes.filter((q) => q.quality !== "marketplace").map((q) => { try { return new URL(q.url).hostname.replace(/^www\./, ""); } catch { return q.url; } })).size;
  return [...byName.values()]
    .filter((h) => h.bestQuality === "official" || h.bestQuality === "specialist" || independent(h) >= 2)
    .map((h) => ({ ...h, themeTerms: h.themeTerms.slice(0, 8) }))
    .sort((a, b) => QUALITY_RANK[a.bestQuality] - QUALITY_RANK[b.bestQuality] || b.sourceUrls.length - a.sourceUrls.length);
}

const WORD_STOP = new Set(["with", "and", "the", "that", "this", "from", "have", "has", "edition", "special", "limited", "console", "handheld", "game", "system", "nintendo", "shell", "design", "face", "image"]);
const tokensOf = (s: string) => [...new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !WORD_STOP.has(t)))];

export interface EditionMatch {
  edition: string;
  /** distinct things SEEN (colours, artwork words) that the sources' own words about this edition also say */
  matched: string[];
  score: number;
  strength: "likely" | "possible" | "unsupported";
}

/**
 * How well what was SEEN fits the way sources describe each edition. Colour and artwork words only. A name that merely sounds right (no matching description) is "unsupported":
 * the edition is known to exist, but the photo gives no reason to pick it.
 */
export function matchEditions(obs: Observation, editions: EditionHit[]): EditionMatch[] {
  const seen = new Set<string>([...obs.colors.flatMap(tokensOf), ...obs.artwork.flatMap(tokensOf)]);
  const out: EditionMatch[] = [];
  for (const e of editions) {
    const pool = new Set(tokensOf(e.quotes.map((q) => q.text).join(" ") + " " + e.name));
    const matched = [...seen].filter((t) => pool.has(t));
    const colorHit = obs.colors.flatMap(tokensOf).some((c) => pool.has(c));
    const artHit = obs.artwork.flatMap(tokensOf).some((a) => pool.has(a));
    const score = seen.size ? matched.length / seen.size : 0;
    const strength = matched.length >= 2 && colorHit && artHit ? "likely" : matched.length >= 1 && (colorHit || artHit) ? "possible" : "unsupported";
    out.push({ edition: e.name, matched, score, strength });
  }
  return out.sort((a, b) => b.matched.length - a.matched.length || b.score - a.score);
}

// ---- discovery for "what special editions exist?" (a person asked), as opposed to deciding what one photographed item is ------------------------------------------------
export interface EditionFinding {
  name: string;
  /** confirmed: an official or specialist source, or two independent ones. reported: one collector catalogue or one source only (said, not proven). */
  support: "confirmed" | "reported";
  sources: Array<{ url: string; quality: SourceQuality; quote: string }>;
  models: string[];
  themeTerms: string[];
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/**
 * Every named edition the pages mention next to the product line, with how well each is supported. Unlike extractEditions (which decides what a photo shows and so insists on two
 * sources), this lists what the sources SAY and labels how strong that is: a catalogue page that lists thirty editions is exactly the source for "what exists". It reads the whole page,
 * not sentence by sentence, because catalogues are lists, not prose.
 */
export function discoverEditions(familyNames: string[], pages: EditionPage[], brandHints: string[] = []): EditionFinding[] {
  const family = familyNames.map((f) => f.toLowerCase());
  const famWords = new Set(familyNames.flatMap((f) => f.toLowerCase().split(/\s+/)));
  const byName = new Map<string, EditionFinding>();
  for (const page of pages) {
    const lower = page.text.toLowerCase();
    if (!family.some((f) => lower.includes(f)) && !family.some((f) => f.split(" ").filter((w) => w.length > 2).every((w) => lower.includes(w)))) continue;
    const quality = sourceQuality(page.url, familyNames[0] ?? "", brandHints);
    for (const m of page.text.matchAll(EDITION_RE)) {
      const words = m[1].split(/\s+/).filter((w) => !GENERIC_EDITION.has(w.toLowerCase()));
      while (words.length && famWords.has(words[0].toLowerCase())) words.shift();
      if (!words.length) continue;
      const name = `${words.join(" ")} ${m[2]}`;
      const at = m.index ?? 0;
      const quote = page.text.slice(Math.max(0, at - 90), Math.min(page.text.length, at + m[0].length + 140)).replace(/\s+/g, " ").trim();
      const f = byName.get(name.toLowerCase()) ?? { name, support: "reported" as const, sources: [], models: [], themeTerms: [] };
      if (!f.sources.some((x) => x.url === page.url)) f.sources.push({ url: page.url, quality, quote });
      for (const mname of modelsNamedIn(familyNames, quote)) if (!f.models.includes(mname)) f.models.push(mname);
      for (const t of quote.match(/\b[A-ZÉ][\wé'’\-]{2,}\b/g) ?? []) if (!STOP_THEME.has(t) && !famWords.has(t.toLowerCase()) && !f.themeTerms.includes(t) && f.themeTerms.length < 6) f.themeTerms.push(t);
      byName.set(name.toLowerCase(), f);
    }
  }
  const out = [...byName.values()].map((f) => {
    const hosts = new Set(f.sources.filter((s) => s.quality !== "marketplace").map((s) => hostOf(s.url)));
    const strong = f.sources.some((s) => s.quality === "official" || s.quality === "specialist");
    return { ...f, support: strong || hosts.size >= 2 ? ("confirmed" as const) : ("reported" as const) };
  });
  return out.sort((a, b) => (a.support === b.support ? b.sources.length - a.sources.length : a.support === "confirmed" ? -1 : 1));
}
