// The dearer rungs of the resolve ladder (identityLadder.ts): read the listing's PHOTOS for the line's visual tells, read LABELS and model numbers in the photos, and vote among what eBay's search
// by image returns. Each takes its eyes (a vision call, an OCR call, an image search) as an injected function, so this file is pure and tested with fakes; the real calls are in visionRungs.ts.
// A rung never invents: when its eyes say nothing or are unsure, it returns the candidates it was given, unchanged.
import type { Candidate, Identity, Rung } from "./identityLadder.js";
import { nameKey } from "./modelFacts.js";

/** What each candidate looks like, from the line's facts (modelFacts tells), for the photo question. */
export interface CandidateTells {
  name: string;
  /** Plain-words tells: "a disc slot on the front", "white, no disc slot". */
  tells: string[];
  /** Model numbers / codes printed on the product or box (only when the owner or a source gave them). */
  codes?: string[];
}

export type PhotoAsk = (args: { images: string[]; candidates: CandidateTells[]; question: string }) => Promise<{ pick: number | null; confident: boolean; reason: string } | null>;
export type LabelAsk = (args: { images: string[] }) => Promise<string[] | null>;
export type ImageSearchAsk = (args: { image: string }) => Promise<string[] | null>;

const norm = (s: string) => nameKey(s);

function keep(identity: Identity, found: string): { candidates: Candidate[]; confidence: Identity["confidence"]; found: string; missing: string[] } {
  return { candidates: identity.candidates, confidence: identity.confidence, found, missing: identity.missing };
}

/** Rung 1: all of the listing's photos, read for the tells that separate the candidates (colour, disc slot, ports). */
export function photoRung(args: { images: () => Promise<string[]>; tellsFor: (name: string) => string[]; ask: PhotoAsk }): Rung {
  return async (identity) => {
    const images = (await args.images()).slice(0, 6);
    if (images.length === 0) return keep(identity, "the listing has no photos to read");
    const cands: CandidateTells[] = identity.candidates.map((c) => ({ name: c.name, tells: args.tellsFor(c.name) }));
    const r = await args.ask({ images, candidates: cands, question: "Which of these is the product in the photos?" }).catch(() => null);
    if (!r || r.pick === null || r.pick < 0 || r.pick >= identity.candidates.length) return keep(identity, r ? `the photos did not settle it (${r.reason})` : "the photos could not be read");
    const chosen = identity.candidates[r.pick];
    return r.confident
      ? { candidates: [chosen], confidence: "settled", found: `the photos show ${chosen.name} (${r.reason})`, missing: [] }
      : { candidates: identity.candidates, confidence: "likely", found: `the photos lean towards ${chosen.name} but are not sure (${r.reason})`, missing: identity.missing };
  };
}

/** Rung 2: labels, packaging, model numbers and codes printed in the photos, matched to the candidates' known codes. */
export function labelsRung(args: { images: () => Promise<string[]>; codesFor: (name: string) => string[]; ask: LabelAsk }): Rung {
  return async (identity) => {
    const images = (await args.images()).slice(0, 6);
    if (images.length === 0) return keep(identity, "no photos to read labels from");
    const read = await args.ask({ images }).catch(() => null);
    if (!read || read.length === 0) return keep(identity, "no readable label or model number in the photos");
    const seen = new Set(read.map((c) => norm(c).replace(/ /g, "")));
    const hits = identity.candidates.filter((c) => args.codesFor(c.name).some((code) => seen.has(norm(code).replace(/ /g, ""))));
    if (hits.length === 1) return { candidates: hits, confidence: "settled", found: `a printed code in the photos names ${hits[0].name}`, missing: [] };
    return keep(identity, hits.length > 1 ? "the codes in the photos fit more than one model" : `read ${read.slice(0, 3).join(", ")} but none is a code Clynx knows for these models`);
  };
}

/** Rung 3: the titles eBay returns for a search by the listing's photo; each is matched to a candidate and the top matches vote. Needs several agreeing results. */
export function imageSearchRung(args: { images: () => Promise<string[]>; matchTitle: (title: string, candidates: Candidate[]) => string | null; ask: ImageSearchAsk; minVotes?: number; minShare?: number }): Rung {
  return async (identity) => {
    const images = await args.images();
    if (images.length === 0) return keep(identity, "no photo to search by");
    const titles = await args.ask({ image: images[0] }).catch(() => null);
    if (!titles || titles.length === 0) return keep(identity, "eBay's image search returned nothing (or is not available)");
    const votes = new Map<string, number>();
    let voted = 0;
    for (const t of titles.slice(0, 10)) {
      const name = args.matchTitle(t, identity.candidates);
      if (name) {
        votes.set(name, (votes.get(name) ?? 0) + 1);
        voted++;
      }
    }
    const [top, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const minVotes = args.minVotes ?? 3;
    const share = voted > 0 ? n / voted : 0;
    if (top && n >= minVotes && share >= (args.minShare ?? 0.7)) {
      const chosen = identity.candidates.find((c) => c.name === top) as Candidate;
      return { candidates: [chosen], confidence: "likely", found: `${n} of the ${voted} matching eBay results look like ${top}`, missing: [] };
    }
    return keep(identity, voted === 0 ? "none of eBay's image-search results matched these models" : `eBay's image search was split (${[...votes.entries()].map(([k, v]) => `${k} ${v}`).join(", ")})`);
  };
}
