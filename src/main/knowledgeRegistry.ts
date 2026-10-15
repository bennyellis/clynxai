// What Clynx has LEARNED from the web about a product line (its storage options, and the similar-looking models that are NOT the same product), and the pure rules that
// turn that into identity findings. Kept free of network, store and AI code so the comparable-sale check (compIdentity.ts) can use it without a cycle.
//
// Learned facts only ever ADD caution: they can make a title "a different model", never make a contradicting title acceptable.
import { isColorWord } from "./colors.js";

export interface KnowledgeSource {
  url: string;
  title: string;
  /** manufacturer | retailer | reference | marketplace | other (variantEvidence.classifySource) */
  sourceClass: string;
}

export interface ProductKnowledge {
  /** familyKey(name): the name without capacity, colour and condition words. */
  key: string;
  /** The product name it was researched for. */
  name: string;
  /** Storage options the sources agree exist for this product line ("128gb", "512gb"). */
  capacities: string[];
  /** Different models in the same line that must never be mixed with this one ("meta quest 3s"). */
  distinctModels: Array<{ name: string; evidence: string; sourceUrl: string }>;
  /** Plain sentences describing how the variants differ, taken from the sources. */
  differences: string[];
  summary: string;
  sources: KnowledgeSource[];
  queries: string[];
  /** Which search backends answered ("google-api", "duckduckgo-html"...). */
  backends: string[];
  researchedAt: number;
}

const NOISE = new Set(["console", "system", "bundle", "edition", "headset", "new", "used", "refurbished", "open", "box", "boxed", "like", "excellent", "condition", "with", "and", "the", "a"]);

export function wordsOf(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

const CAPACITY_WORD = /^\d{1,4}(?:gb|tb|mb)$/;

/** "Meta Quest 3 128GB (White)" -> "meta quest 3". Capacity, colour and condition words are not part of what the line IS. */
export function familyKey(name: string): string {
  const w = wordsOf(name);
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (CAPACITY_WORD.test(t)) continue;
    if (/^\d{1,4}$/.test(t) && /^(?:gb|tb|mb)$/.test(w[i + 1] ?? "")) {
      i++;
      continue;
    }
    if (isColorWord(t) || NOISE.has(t)) continue;
    out.push(t);
  }
  return out.join(" ");
}

/** Normalised capacity tokens in a text: "128 GB" -> "128gb". */
export function capacitiesIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of String(text ?? "").toLowerCase().matchAll(/\b(\d{1,4})\s?(gb|tb)\b/g)) found.add(`${m[1]}${m[2]}`);
  return [...found];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A tolerant pattern for a model name: words in order, any spaces or hyphens between them, and "3s" the same as "3 s" only when the name itself is glued. */
export function phraseRegex(phrase: string): RegExp {
  const parts = wordsOf(phrase).map(esc);
  return new RegExp(`(?:^|[^a-z0-9])${parts.join("[\\s-]*")}(?![a-z0-9])`, "i");
}

/** Suffix words that make a model a DIFFERENT product from its base ("Quest 3S", "Series X", "iPhone 15 Pro Max"). */
export const MODEL_SUFFIXES = ["s", "x", "xl", "se", "fe", "pro", "plus", "max", "mini", "lite", "ultra", "slim", "oled", "digital", "v2", "air"];

/** Models in `text` that are `family` plus a model suffix (never the family alone). Returns normalised names like "meta quest 3s". */
export function suffixModelsIn(family: string, text: string): string[] {
  const fam = wordsOf(family);
  if (!fam.length) return [];
  const last = fam[fam.length - 1];
  const glued = /\d$/.test(last);
  const base = fam.map(esc).join("[\\s-]*");
  const found = new Set<string>();
  const lower = String(text ?? "").toLowerCase();
  for (const suf of MODEL_SUFFIXES) {
    // a single letter may be glued to a model number ("3s") or follow a word ("series x"); longer suffixes are separate words
    const sep = suf.length === 1 ? (glued ? "" : "[\\s-]+") : "[\\s-]*";
    const re = new RegExp(`(?:^|[^a-z0-9])${base}${sep}${esc(suf)}(?![a-z0-9])`, "g");
    if (re.test(lower)) found.add(`${fam.join(" ")}${suf.length === 1 && glued ? "" : " "}${suf}`);
  }
  return [...found];
}

export interface KnowledgeFinding {
  code: "MODEL_VARIANT";
  text: string;
}

/**
 * Does the title name a model the web research found to be a DIFFERENT product from the one being priced? Only a model the identity name does not already contain counts
 * ("Meta Quest 3S" on a "Meta Quest 3" product), so a "Quest 3S" entry is not rejected for being a 3S.
 */
export function knowledgeFindings(identityName: string, title: string, k: ProductKnowledge | null | undefined): KnowledgeFinding[] {
  if (!k || !k.distinctModels.length) return [];
  const own = wordsOf(identityName).join(" ");
  const out: KnowledgeFinding[] = [];
  for (const dm of k.distinctModels) {
    if (phraseRegex(dm.name).test(own)) continue; // the product already IS that model
    if (phraseRegex(dm.name).test(title)) out.push({ code: "MODEL_VARIANT", text: `the title names the ${dm.name}, a different model from ${k.key} (${dm.evidence.slice(0, 100)})` });
  }
  return out;
}

// ---- how the comparable check reaches what was learned (set once at start-up from the store, like the picture-filing recorder) ----------------------------------
export type KnowledgeMode = "off" | "shadow" | "enforce";
export interface KnowledgeProvider {
  mode(): KnowledgeMode;
  /** Cached knowledge for a product name (never a network call). */
  lookup(name: string): ProductKnowledge | null;
  /** Called in shadow mode when the knowledge WOULD have changed a verdict. */
  shadow?(info: { name: string; title: string; findings: KnowledgeFinding[] }): void;
}
let provider: KnowledgeProvider | null = null;
export function setKnowledgeProvider(p: KnowledgeProvider | null): void {
  provider = p;
}
export function knowledgeProvider(): KnowledgeProvider | null {
  return provider;
}
