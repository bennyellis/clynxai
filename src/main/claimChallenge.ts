// "Does this model exist?" A seller can advertise an "RTX 4080 Ti" or an "iPhone 15 Pro Plus". Clynx does not assume the name is real, and it does not invent a replacement:
// it reads the maker's own lineup, and only a lineup it actually read can say a name is NOT in it. Alternatives offered are names found on those pages, never made up. When no
// official page could be read the answer is "unverified" - which is not the same as "does not exist". Network is injected; pure otherwise.
import { QUALITY_RANK, sourceQuality, type SourceQuality } from "./evidenceKinds.js";
import { MODEL_SUFFIXES, wordsOf } from "./knowledgeRegistry.js";
import type { VerifyDeps } from "./variantEvidence.js";

export type ChallengeVerdict = "exists_official" | "exists_researched" | "not_in_official_lineup" | "unverified_seller_only" | "unverified_no_official_source";

export interface ChallengeResult {
  verdict: ChallengeVerdict;
  claim: string;
  /** Names of the same line found on official pages. */
  officialLineup: string[];
  /** The closest real names found on official pages (same model number first). */
  alternatives: string[];
  sources: Array<{ url: string; quality: SourceQuality }>;
  searches: string[];
  note: string;
}

const SUFFIXES = [...new Set([...MODEL_SUFFIXES, "ti", "super", "xt", "gt", "gre"])];
const GENERIC = new Set(["nvidia", "geforce", "graphics", "card", "gpu", "apple", "samsung", "galaxy", "amd", "radeon", "intel", "the", "new", "used", "oem", "founders", "edition", "msi", "asus", "gigabyte", "evga", "zotac", "gaming", "oc", "trio", "ventus", "strix", "tuf", "eagle"]);

export interface ParsedClaim {
  /** the word the model number follows: "rtx", "iphone", "galaxy s" -> "rtx" */
  anchor: string;
  number: string;
  suffix: string[];
  /** brand words the claim carries ("nvidia") */
  brand: string[];
}

/** "NVIDIA GeForce RTX 4080 Ti 16GB" -> anchor rtx, number 4080, suffix ["ti"]. null when the name has no model number. */
export function parseModelClaim(claim: string): ParsedClaim | null {
  const w = wordsOf(claim).filter((t) => !/^\d{1,4}(gb|tb)$/.test(t) && !/^(gb|tb)$/.test(t));
  const at = w.findIndex((t, i) => i > 0 && /^\d{1,4}$/.test(t) && !GENERIC.has(w[i - 1]));
  if (at <= 0) return null;
  const anchor = w[at - 1];
  const suffix: string[] = [];
  for (let i = at + 1; i < w.length && suffix.length < 3; i++) {
    if (SUFFIXES.includes(w[i])) suffix.push(w[i]);
    else break;
  }
  return { anchor, number: w[at], suffix, brand: w.filter((t) => ["nvidia", "amd", "intel", "apple", "samsung", "nintendo", "sony", "microsoft", "google"].includes(t)) };
}

const nameOf = (anchor: string, number: string, suffix: string[]) => [anchor, number, ...suffix].join(" ");

/** Every "anchor number [suffixes]" in a text, normalised. */
export function lineupIn(anchor: string, text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`(?:^|[^a-z0-9])${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\d{1,4})((?:[\\s-]+(?:${SUFFIXES.join("|")}))*)(?![a-z0-9])`, "gi");
  for (const m of text.toLowerCase().matchAll(re)) out.add(nameOf(anchor, m[1], m[2].split(/[\s-]+/).filter(Boolean)));
  return [...out];
}

export async function challengeModelClaim(claim: string, deps: VerifyDeps, opts: { maxPages?: number } = {}): Promise<ChallengeResult> {
  const parsed = parseModelClaim(claim);
  const base: ChallengeResult = { verdict: "unverified_no_official_source", claim, officialLineup: [], alternatives: [], sources: [], searches: [], note: "" };
  if (!parsed) return { ...base, note: "The name has no model number to check against a lineup." };
  deps.reset?.();
  const want = nameOf(parsed.anchor, parsed.number, parsed.suffix);
  const brand = parsed.brand[0] ?? "";
  const queries = [`${brand} ${parsed.anchor} ${parsed.number} series lineup models`.replace(/\s+/g, " ").trim(), `${brand} ${parsed.anchor} ${parsed.number} ${parsed.suffix.join(" ")} official specifications`.replace(/\s+/g, " ").trim()];
  const seen = new Map<string, { url: string; title: string; text: string; quality: SourceQuality }>();
  for (const q of queries) {
    base.searches.push(q);
    let hits: Array<{ title: string; url: string; snippet: string }> = [];
    try {
      hits = await deps.search(q, 8);
    } catch {
      continue;
    }
    for (const h of hits) if (!seen.has(h.url)) seen.set(h.url, { url: h.url, title: h.title, text: `${h.title}. ${h.snippet}`, quality: sourceQuality(h.url, claim, brand ? [brand] : []) });
  }
  // read the official and specialist pages in full
  const ranked = [...seen.values()].sort((a, b) => QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality]);
  await Promise.all(
    ranked
      .filter((p) => p.quality === "official" || p.quality === "specialist")
      .slice(0, opts.maxPages ?? 4)
      .map(async (p) => {
        const text = await deps.fetchText(p.url, { tokens: [parsed.anchor, parsed.number] }).catch(() => null);
        if (text && text.length > p.text.length) p.text = text;
      })
  );
  const official = ranked.filter((p) => p.quality === "official");
  const specialist = ranked.filter((p) => p.quality === "specialist");
  const officialLineup = [...new Set(official.flatMap((p) => lineupIn(parsed.anchor, p.text)))].sort();
  const specialistLineup = [...new Set(specialist.flatMap((p) => lineupIn(parsed.anchor, p.text)))];
  const sources = ranked.filter((p) => p.quality === "official" || p.quality === "specialist").map((p) => ({ url: p.url, quality: p.quality }));
  const sameNumber = (names: string[]) => names.filter((n) => n.split(" ")[1] === parsed.number && n !== want);
  const near = (names: string[]) => {
    const num = Number(parsed.number);
    return names
      .filter((n) => n !== want && n.split(" ")[1] !== parsed.number)
      .sort((a, b) => Math.abs(Number(a.split(" ")[1]) - num) - Math.abs(Number(b.split(" ")[1]) - num))
      .slice(0, 3);
  };
  if (officialLineup.includes(want)) return { ...base, verdict: "exists_official", officialLineup, sources, note: `"${want}" is listed on an official page.` };
  // a lineup is only evidence of absence when it was really read: at least two names of this line on official pages
  if (officialLineup.length >= 2) {
    return { ...base, verdict: "not_in_official_lineup", officialLineup, alternatives: [...sameNumber(officialLineup), ...near(officialLineup)].slice(0, 5), sources, note: `The official pages list ${officialLineup.join(", ")} but not "${want}". The name may be a seller's mistake, a rumour or a custom listing: research the real models rather than assume it.` };
  }
  if (specialistLineup.includes(want)) return { ...base, verdict: "exists_researched", officialLineup, sources, note: `"${want}" is described by an independent specialist source, but no official page confirmed it.` };
  const only = ranked.filter((p) => lineupIn(parsed.anchor, p.text).includes(want));
  if (only.length && only.every((p) => p.quality === "marketplace" || p.quality === "other" || p.quality === "retailer")) {
    return { ...base, verdict: "unverified_seller_only", officialLineup, sources, note: `Only listings or shops call it "${want}"; no official or specialist page does.` };
  }
  return { ...base, verdict: "unverified_no_official_source", officialLineup, sources, note: "No official lineup page could be read, so this does not show the model is real or fake." };
}
