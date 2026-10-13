// Phase 4 veto-only identity safeguard (decision logic). Given a listing and the Database entry the EXISTING matcher chose for it, say whether the match
// stands, is vetoed, or cannot be judged. It never picks another product: the only outputs are "allow", "veto" and "unsure", and "unsure" is treated exactly like
// "allow" by every caller (uncertainty is not proof that the products differ). A veto needs reliable evidence that the listing and the entry are materially
// different products:
//   * the listing's text resolves with confidence to ANOTHER entry that the resolver says is a different product (a code, number, size or each-side extra differs),
//   * it is something that goes WITH the entry (an accessory for it, a game that runs on it), or
//   * it states a variant marker the entry lacks, backed by evidence in the Database (a credible code, or a word that separates entries in several places), or
//   * its model code follows the pattern of the entry's family but with another value (a new model beside the entry).
// Nothing here knows a product category. Pure: no I/O, no network, no AI.
import { compareProducts, resolveListing, type ListingResolution, type ResolverContext } from "./foundationResolver.js";

export type Decision = "allow" | "veto" | "unsure";
export type VetoKind = "different-product" | "accessory-or-companion" | "variant" | "sibling-model";

export interface SafeguardDecision {
  decision: Decision;
  kind: VetoKind | null;
  reason: string;
  evidence: string[];
  /** The entry or family the evidence points to instead (information only; the safeguard never re-files anything). */
  against: { id: string | null; name: string } | null;
}

interface Judged {
  decision: Decision;
  kind: VetoKind | null;
  reason: string;
  against: { id: string | null; name: string } | null;
  confirmsEntry: boolean;
  resolution: ListingResolution;
}

const unsure = (resolution: ListingResolution, reason: string, confirmsEntry = false): Judged => ({ decision: confirmsEntry ? "allow" : "unsure", kind: null, reason, against: null, confirmsEntry, resolution });

function judge(text: string, entry: { id: string; name: string }, entries: Array<{ id: string; name: string }>, ctx: ResolverContext, seller?: string | null): Judged {
  const r = resolveListing(text, entries, ctx, { seller });
  const entryInfo = ctx.info(entry.id);
  if (!entryInfo) return unsure(r, "the entry is not known to the resolver yet");

  if (r.verdict === "confirmed" && r.product) {
    if (r.product.id === entry.id) return unsure(r, `the text states what "${entry.name}" states`, true);
    const other = ctx.info(r.product.id);
    if (!other) return unsure(r, "the other entry is not known to the resolver yet");
    const v = compareProducts(entryInfo, other, ctx);
    if (v.verdict === "confirmed") return unsure(r, `"${r.product.name}" is the same product as "${entry.name}"`, true);
    if (v.verdict === "different") {
      return { decision: "veto", kind: "different-product", reason: `the text is "${r.product.name}", a different product than "${entry.name}" (${v.reasons[0] ?? "they differ"})`, against: r.product, confirmsEntry: false, resolution: r };
    }
    if (v.verdict === "related" && v.relation === "goes-with") {
      return { decision: "veto", kind: "accessory-or-companion", reason: `the text is "${r.product.name}", which goes with "${entry.name}" but is not it (${v.reasons[0] ?? ""})`, against: r.product, confirmsEntry: false, resolution: r };
    }
    // the text is a narrower product than the entry by a model marker or a word the Database uses to tell entries apart in several places. A capacity, or a number
    // that may be a count or a model-line number ("2 remotes", a CFI-1200 style code on the same console), does not count on its own.
    if (v.verdict === "related" && v.relation === "variant" && v.moreSpecific === "b" && (v.variantBasis === "evidence-word" || v.variantBasis === "marker") && v.sureness !== "low") {
      return { decision: "veto", kind: "variant", reason: `the text is "${r.product.name}", a more specific product than "${entry.name}" (${v.reasons[0] ?? "it states a variant the entry lacks"})`, against: r.product, confirmsEntry: false, resolution: r };
    }
    // a narrower or broader member of the same family, a bundle, an edition, a size: the same kind of product; not enough to say the entry is wrong
    return unsure(r, `the text is "${r.product.name}", related to "${entry.name}" (${v.relation ?? v.verdict})`);
  }

  if (r.verdict === "related" && r.product) {
    if (r.product.id === entry.id) {
      if (r.relation === "goes-with") {
        return { decision: "veto", kind: "accessory-or-companion", reason: `the text names "${entry.name}" only as what it is for or runs on; the listing is not that product`, against: null, confirmsEntry: false, resolution: r };
      }
      // A "variant" reading of the entry's OWN text (a code seen in other titles, a descriptive word, a model number of the same line) is never a veto: measured on real
      // titles it was wrong far more often than right (a spec, a colour, a region name, a model number of the same product).
    } else if (r.relation === "goes-with") {
      // an accessory / game for ANOTHER entry: if that entry is the same product as the matched one, the listing goes with it
      const host = ctx.info(r.product.id);
      if (host && compareProducts(entryInfo, host, ctx).verdict === "confirmed") {
        return { decision: "veto", kind: "accessory-or-companion", reason: `the text is something for "${r.product.name}", which is the same product as "${entry.name}"; the listing is not that product`, against: null, confirmsEntry: false, resolution: r };
      }
    }
    return unsure(r, r.reasons[0] ?? "the text only relates to the entry");
  }

  // One entry leads the title although the resolver will not claim it (a weak variant word, a second product named beside it): if the matched entry is something that goes
  // with the lead (a game for a console, an accessory for a device), or the lead is clear and the matched entry is plainly another product, the match does not stand.
  if (r.verdict === "uncertain" && r.leading && r.leading.id !== entry.id) {
    const lead = ctx.info(r.leading.id);
    if (lead) {
      const v = compareProducts(entryInfo, lead, ctx);
      if (v.verdict === "related" && v.relation === "goes-with") {
        return { decision: "veto", kind: "accessory-or-companion", reason: `the text leads with "${r.leading.name}", which goes with "${entry.name}" but is not it`, against: { id: r.leading.id, name: r.leading.name }, confirmsEntry: false, resolution: r };
      }
      if (r.leading.confident && v.verdict === "different") {
        return { decision: "veto", kind: "different-product", reason: `the text is clearly "${r.leading.name}", a different product than "${entry.name}" (${v.reasons[0] ?? "they differ"})`, against: { id: r.leading.id, name: r.leading.name }, confirmsEntry: false, resolution: r };
      }
    }
  }
  return unsure(r, r.reasons[0] ?? "the evidence does not settle it");
}

/**
 * Evaluates a match the existing matcher made. `title` is the listing's own title; `matchedName` is the name the extraction step gave it (the string the matcher
 * actually looked up), when there is one. Evidence from either can veto, evidence from either that CONFIRMS the entry outweighs a veto from the other
 * (conflicting evidence is treated as unsure, never as a veto).
 */
export function evaluateMatch(
  args: { title: string; matchedName: string | null; entry: { id: string; name: string }; seller?: string | null },
  entries: Array<{ id: string; name: string }>,
  ctx: ResolverContext,
  opts: { exempt?: (entry: { id: string; name: string }) => boolean } = {},
): SafeguardDecision {
  // An entry that stands for a CONDITION of a product (for example the broken / for-parts variant) is the right place for listings that say so, and its name reads as "different"
  // from the listing's main text by design: it is not judged.
  if (opts.exempt?.(args.entry)) return { decision: "unsure", kind: null, reason: "this entry stands for a condition of a product (for example broken / for parts); it is not judged by name", evidence: [], against: null };
  const t = judge(args.title, args.entry, entries, ctx, args.seller);
  const sameText = !args.matchedName || args.matchedName.trim().toLowerCase() === args.title.trim().toLowerCase();
  const m = sameText ? null : judge(args.matchedName as string, args.entry, entries, ctx, args.seller);
  const evidence = [`title: ${t.reason}`, ...(m ? [`name "${args.matchedName}": ${m.reason}`] : [])];
  // The listing's own title decides. The extracted name is the very string the existing matcher looked up, so it can never CONFIRM the entry (that would be
  // circular); it can only add a veto where the title is silent, and a veto from it is dropped when the title confirms the entry.
  if (t.confirmsEntry) {
    if (m?.decision === "veto") return { decision: "unsure", kind: null, reason: "the title confirms the entry but the extracted name points away; treated as unsure, not as a veto", evidence, against: null };
    return { decision: "allow", kind: null, reason: t.reason, evidence, against: null };
  }
  if (t.decision === "veto") return { decision: "veto", kind: t.kind, reason: t.reason, evidence, against: t.against };
  if (m?.decision === "veto") return { decision: "veto", kind: m.kind, reason: `the extracted name "${args.matchedName}" ${m.reason}`, evidence, against: m.against };
  return { decision: "unsure", kind: null, reason: t.reason, evidence, against: null };
}
