// Does this sold comp belong to this product? Reuses compIdentity.classifyComparable (kind, edition, generation, accessories, for-parts) and never invents its own rules:
//  1. an exact identifier (GTIN, then ePID) is the strongest evidence; a disagreeing identifier is a rejection;
//  2. otherwise the title is judged against the product's official name (and the search query) by classifyComparable;
//  3. a comp only prices a product when its verdict is exact or compatible. UNCERTAIN NEVER PRICES. A photo check can only make a comp worse (a different-looking item is rejected); it
//     never promotes an uncertain comp (that needs trusted reference photos and fail-closed handling, which are a later step).
// The verdict and the reason are kept with the comp so a wrong match can be audited.
import { classifyComparable, usableForValuation, type CompIdentityInput, type CompReason, type CompVerdict } from "../compIdentity.js";
import { normEpid, normGtin, type SoldComp } from "./types.js";

export interface ProductIdentity extends CompIdentityInput {
  id: string;
  gtin?: string | null;
  epid?: string | null;
}

export type PhotoVerdict = "same" | "different" | "unknown";

export interface CompMatch {
  compId: string;
  productId: string;
  verdict: CompVerdict;
  reason: string;
  /** "gtin" / "epid" when an identifier decided, else "title". */
  basis: "gtin" | "epid" | "title";
  photoCheck: PhotoVerdict | null;
  accepted: boolean;
}

const NEVER_BY_ID: CompReason[] = ["NOT_WORKING", "LOT_OR_BUNDLE", "ACCESSORY", "MEDIA"];
const ID_CONFLICT: CompReason[] = ["EDITION", "GENERATION", "TIER", "CAPACITY", "COLOR", "MODEL_NUMBER", "MODEL_LETTER", "MODEL_VARIANT", "SKU", "REGION"];
const BROKEN_CONDITION = /\b(for parts|parts only|not working|parts or repair|broken|damaged|salvage|untested|as is|as-is|cracked)\b/i;

const reasonText = (j: { reasons: Array<{ code: CompReason; text: string }> }) => j.reasons.map((r) => `${r.code}: ${r.text}`).join("; ");

/** The synchronous part: identifiers, then the title rules. */
export function matchComp(product: ProductIdentity, comp: SoldComp): CompMatch {
  const base = { compId: comp.id, productId: product.id, photoCheck: null as PhotoVerdict | null };
  // An identifier only counts when it is a real code on BOTH sides ("N/A", "0", "Does not apply" and spreadsheet-mangled numbers normalise to nothing and are ignored, never "equal").
  const pg = normGtin(product.gtin);
  const cg = normGtin(comp.gtin);
  const pe = normEpid(product.epid);
  const ce = normEpid(comp.epid);
  if (pg && cg && pg !== cg) return { ...base, verdict: "rejected", reason: `GTIN differs (${comp.gtin} is not ${product.gtin})`, basis: "gtin", accepted: false };
  if (pe && ce && pe !== ce) return { ...base, verdict: "rejected", reason: `ePID differs (${comp.epid} is not ${product.epid})`, basis: "epid", accepted: false };

  const judged = classifyComparable(product, comp.title);
  const idBasis = pg && cg ? "gtin" : pe && ce ? "epid" : null;
  if (idBasis) {
    // The identifier says it IS the product; only a listing that is plainly not a working, single, complete product still fails.
    const bad = judged.reasons.filter((r) => NEVER_BY_ID.includes(r.code));
    if (bad.length > 0 || (!product.broken && comp.condition && BROKEN_CONDITION.test(comp.condition))) {
      const why = bad.length > 0 ? reasonText({ reasons: bad }) : `condition "${comp.condition}"`;
      return { ...base, verdict: "rejected", reason: `${idBasis.toUpperCase()} matches but ${why}`, basis: idBasis, accepted: false };
    }
    // Sellers often paste the base model's code onto a variant: when the TITLE names a different edition, generation, size, colour or model, the code alone does not decide. Held as
    // uncertain (it never prices), with the conflict kept as the reason.
    // (Only when the title is plainly about the same product line; a title that says nothing about the product leaves the code to decide.)
    const lineWord = (product.name.toLowerCase().match(/[a-z0-9]+/) ?? [""])[0];
    const aboutSameLine = lineWord.length >= 3 && new RegExp(`\\b${lineWord}`).test(comp.title.toLowerCase());
    const conflicts = judged.reasons.filter((r) => ID_CONFLICT.includes(r.code));
    if (aboutSameLine && conflicts.length > 0 && judged.verdict === "rejected") {
      return { ...base, verdict: "uncertain", reason: `${idBasis.toUpperCase()} matches but the title conflicts: ${reasonText({ reasons: conflicts })}`, basis: idBasis, accepted: false };
    }
    return { ...base, verdict: "exact", reason: `${idBasis.toUpperCase()} matches`, basis: idBasis, accepted: true };
  }
  // No identifier on both sides: the title, then the listed condition (a title can look fine while the condition field says "for parts")
  if (judged.verdict !== "rejected" && !product.broken && comp.condition && BROKEN_CONDITION.test(comp.condition)) {
    return { ...base, verdict: "rejected", reason: `NOT_WORKING: condition says "${comp.condition}"`, basis: "title", accepted: false };
  }
  // The product's own first word (its brand or line: "xbox", "dyson") has to appear: a title that matches most of the other words but names a different brand ("PlayStation 5 Galaxy Black
  // Special Edition Console" for an Xbox product) is not this product. (compIdentity alone lets such a title through when fewer than half the name's words are missing.)
  const anchor = (product.name.toLowerCase().match(/[a-z0-9]+/) ?? [""])[0];
  if (usableForValuation(judged.verdict) && anchor.length >= 3 && !new RegExp(`\\b${anchor}`).test(comp.title.toLowerCase())) {
    return { ...base, verdict: "rejected", reason: `BRAND: the title never mentions "${anchor}"`, basis: "title", accepted: false };
  }
  return { ...base, verdict: judged.verdict, reason: judged.reasons.length > 0 ? reasonText(judged) : "title matches the product's name", basis: "title", accepted: usableForValuation(judged.verdict) };
}

/** Judge every comp; an optional photo check can only downgrade (never promote). */
export async function matchAll(product: ProductIdentity, comps: SoldComp[], photoCheck?: (comp: SoldComp, product: ProductIdentity) => Promise<PhotoVerdict>): Promise<CompMatch[]> {
  const out: CompMatch[] = [];
  for (const comp of comps) {
    let m = matchComp(product, comp);
    if (photoCheck && comp.imageUrl && m.verdict !== "rejected") {
      let p: PhotoVerdict = "unknown";
      try {
        p = await photoCheck(comp, product);
      } catch {
        p = "unknown";
      }
      m = { ...m, photoCheck: p };
      if (p === "different") m = { ...m, verdict: "rejected", accepted: false, reason: `${m.reason}${m.reason ? "; " : ""}PHOTO: the picture does not look like this product` };
    }
    out.push(m);
  }
  return out;
}
