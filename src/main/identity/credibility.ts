// Which "extra" identifiers in a listing title are credible enough to matter?
//
// A listing title often states codes the matched Database entry's name does not ("360", "1403", "16e", but also a seller's own inventory code like
// "O1766" or a number that belongs to something else in the listing). Only an identifier that independent evidence shows to be a real model or version
// marker may downgrade a listing or start any extra price research. Evidence, in order of strength:
//
//   narrower sibling   another Database entry whose name contains the identifier and everything the matched entry's name says: a known narrower version
//   photo analysis     the product names the photo analysis gave THIS listing contain it
//   seen elsewhere     two or more other documents from different sources (entries, other sellers' listings, reference-photo titles) contain it next
//                      to the product's own words
//
// Documents that merely MENTION the product ("Some Game (the product)", "Cable for the product") do not vouch for an identifier that belongs to
// the mentioning item. A code that is only a short form of words the name already spells out ("ps5" for "playstation 5") is not an extra. A code with no
// evidence is "unverified": it neither lowers the verdict nor triggers research, and it is never treated as confirmed either. No category is named here.
import { aliasCovered, codesMissingFrom, definingCodes, specificNameFor } from "./codes.js";
import { identityTokens } from "./resolver.js";

export interface EvidenceDoc {
  text: string;
  // Where it came from: a Database entry ("product:<id>"), a seller ("seller:<name>"), or just its own wording ("title:<text>").
  origin: string;
  kind: "product" | "listing" | "photo";
}

const key = (c: string) => c;
const runKey = (c: string) => {
  const runs = (c.match(/\d+/g) ?? []).sort((a, b) => b.length - a.length);
  return runs[0] && runs[0].length >= 3 ? `#${runs[0]}` : null;
};

/** An index from identifier to the documents containing it, built once and reused. */
export class CodeIndex {
  private byCode = new Map<string, number[]>();
  readonly docs: EvidenceDoc[];
  constructor(docs: EvidenceDoc[]) {
    this.docs = docs;
    docs.forEach((d, i) => {
      for (const c of definingCodes(d.text)) {
        for (const k of [key(c), runKey(c)]) {
          if (!k) continue;
          const list = this.byCode.get(k);
          if (list) {
            if (list[list.length - 1] !== i) list.push(i);
          } else this.byCode.set(k, [i]);
        }
      }
    });
  }
  docsWith(code: string): EvidenceDoc[] {
    const ids = new Set<number>([...(this.byCode.get(key(code)) ?? []), ...(runKey(code) ? (this.byCode.get(runKey(code) as string) ?? []) : [])]);
    return [...ids].map((i) => this.docs[i]);
  }
}

export type CodeReason = "narrower-sibling" | "related-product" | "photo-analysis" | "seen-in-multiple-sources";
export type UnverifiedReason = "single-sighting" | "only-mentions-the-product" | "no-evidence";
export type DismissedReason = "short-form-of-the-name";

export interface CodeAssessment {
  // Identifiers backed by evidence: these may downgrade the verdict and start research. `support` is what vouches for it (for the audit trail).
  credible: Array<{ code: string; reason: CodeReason; support: string[]; siblingName?: string }>;
  // Identifiers with no evidence: informational only.
  unverified: Array<{ code: string; reason: UnverifiedReason }>;
  dismissed: Array<{ code: string; reason: DismissedReason }>;
}

export const NO_CODES: CodeAssessment = { credible: [], unverified: [], dismissed: [] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Does `doc` name the product only as something it is FOR or WITH (in brackets or after a connector, even by one of its words), while the identifier sits on the item doing the mentioning?
function mentionsProductOnly(doc: string, productWords: Set<string>, code: string): boolean {
  const lower = doc.toLowerCase();
  const segments: string[] = [];
  for (const m of lower.matchAll(/[(\[]([^)\]]*)[)\]]/g)) segments.push(m[1]);
  const after = /\b(?:for|with|compatible with|fits?|includes?|plus)\b(.*)$/.exec(lower);
  if (after) segments.push(after[1]);
  for (const seg of segments) {
    const words = identityTokens(seg).words;
    // naming ANY of the product's own words in the bracket / after the connector marks the doc as being about something that goes with the product
    const holdsProduct = [...productWords].some((w) => !/^\d+$/.test(w) && words.has(w)) || (productWords.size > 0 && [...productWords].every((w) => words.has(w)));
    const codeInside = definingCodes(seg).some((c) => c === code);
    if (holdsProduct && !codeInside) return true;
  }
  return false;
}

export function assessCodes(args: { entryId?: string | null; entryName: string; title: string; index: CodeIndex; independentTexts?: string[]; seller?: string | null }): CodeAssessment {
  const raw = codesMissingFrom(args.entryName, args.title);
  if (raw.length === 0) return NO_CODES;
  const out: CodeAssessment = { credible: [], unverified: [], dismissed: [] };
  const productWords = identityTokens(args.entryName).words;
  const distinctive = [...productWords].filter((w) => !/^\d+$/.test(w));
  const ownTitle = norm(args.title);
  const ownOrigins = new Set<string>([`title:${ownTitle}`, ...(args.seller ? [`seller:${args.seller.toLowerCase()}`] : []), ...(args.entryId ? [`product:${args.entryId}`] : [])]);

  for (const code of raw) {
    if (aliasCovered(code, args.entryName)) {
      out.dismissed.push({ code, reason: "short-form-of-the-name" });
      continue;
    }
    // photo analysis named this very listing with the identifier in it, next to the product's own words
    const vouched = (args.independentTexts ?? []).filter((t) => definingCodes(t).some((c) => c === code || (c.length >= 4 && c.includes(code))) && (distinctive.length === 0 || distinctive.some((w) => identityTokens(t).words.has(w))));
    if (vouched.length > 0) {
      out.credible.push({ code, reason: "photo-analysis", support: vouched.slice(0, 2) });
      continue;
    }
    const docs = args.index.docsWith(code).filter((d) => {
      // The listing's own text is not evidence about itself (a Database entry that happens to read the same IS: it is a known product).
      if ((d.kind !== "product" && norm(d.text) === ownTitle) || ownOrigins.has(d.origin)) return false;
      const words = identityTokens(d.text).words;
      if (distinctive.length > 0 && !distinctive.some((w) => words.has(w))) return false; // not about this product
      return !mentionsProductOnly(d.text, productWords, code);
    });
    // A Database entry that carries the identifier next to the product's own words is a known product with that marker: a narrower version of this
    // entry when it also says everything the entry says, otherwise a related model (same family, another version).
    const known = docs.filter((d) => d.kind === "product");
    const sibling = known.find((d) => {
      const words = identityTokens(d.text).words;
      return [...productWords].every((w) => words.has(w));
    });
    if (sibling) {
      out.credible.push({ code, reason: "narrower-sibling", support: [sibling.text], siblingName: sibling.text });
      continue;
    }
    if (known.length > 0) {
      out.credible.push({ code, reason: "related-product", support: [known[0].text] });
      continue;
    }
    const origins = new Set(docs.map((d) => d.origin));
    if (origins.size >= 2) {
      out.credible.push({ code, reason: "seen-in-multiple-sources", support: docs.slice(0, 3).map((d) => d.text) });
      continue;
    }
    const anyDoc = args.index.docsWith(code).some((d) => (d.kind === "product" || norm(d.text) !== ownTitle) && !ownOrigins.has(d.origin));
    out.unverified.push({ code, reason: docs.length === 1 ? "single-sighting" : anyDoc ? "only-mentions-the-product" : "no-evidence" });
  }
  return out;
}

/**
 * The name under which a listing that is more specific than the entry it matched should be priced: a known narrower sibling's own name when evidence
 * points to one, else the entry's name plus only the CREDIBLE codes. Null when no code is credible: unverified codes (a seller's own inventory code)
 * never start research and never invent a name.
 */
export function specificResearchName(entryName: string, assessment: CodeAssessment | undefined, listingTitle: string): string | null {
  const credible = assessment?.credible ?? [];
  if (credible.length === 0) return null;
  return credible.find((c) => c.siblingName)?.siblingName ?? specificNameFor(entryName, listingTitle, credible.map((c) => c.code));
}
