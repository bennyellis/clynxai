// Phase 4 Database review: finds the entries that may be contaminated and proposes (never applies) a correction for each, with the evidence behind it. Pure: it reads the rows
// it is given and returns findings and proposals; it writes nothing, calls nothing, and applies nothing. It is the one implementation behind both the review screen in the app
// and the offline audit tool, so the numbers the audit reports are the numbers the screen shows.
//
// Every finding says whether its evidence is CONFIRMED (something checkable in the data: the filed title states another entry exactly, the resolver confirms two entries are
// one product, a stored number rests on a sample of one) or a HEURISTIC (a lean, a family-level reading, a rule of thumb). Every proposal carries the exact change it would make
// and the exact prior value, so a person sees what would happen and a restore of that prior value undoes it.
import type { EvidenceDoc } from "./credibility.js";
import { buildContext, compareProducts, resolveListing, type ListingResolution, type ProductVerdict } from "./foundationResolver.js";
import { identityTokens } from "./resolver.js";

export type Confidence = "high" | "medium" | "low";
export type Strength = "confirmed" | "heuristic";
export type ReviewCategory = "incorrect-filing" | "suspected-duplicate" | "generic-entry" | "ambiguous-identity" | "suspicious-valuation" | "disputed-alias";
export type FindingKind = "contaminated" | "merged" | "generic-holds-specific" | "filed-under-broader" | "duplicate" | "possible-duplicate" | "valuation" | "alias" | "relation" | "needs-evidence";
export type ProposalAction = "move-listing" | "move-photo" | "review-merge" | "clear-valuation" | "reject-alias-candidate" | "reject-relation-candidate" | "gather-evidence";

export const CATEGORY_LABELS: Record<ReviewCategory, string> = {
  "incorrect-filing": "Incorrect filing",
  "suspected-duplicate": "Suspected duplicate",
  "generic-entry": "Generic entry",
  "ambiguous-identity": "Ambiguous identity",
  "suspicious-valuation": "Suspicious valuation",
  "disputed-alias": "Disputed alias or relation",
};
const CATEGORY_OF: Record<FindingKind, ReviewCategory> = {
  contaminated: "incorrect-filing", merged: "incorrect-filing", "filed-under-broader": "incorrect-filing", duplicate: "suspected-duplicate", "possible-duplicate": "suspected-duplicate",
  "generic-holds-specific": "generic-entry", "needs-evidence": "ambiguous-identity", valuation: "suspicious-valuation", alias: "disputed-alias", relation: "disputed-alias",
};

export interface ReviewProduct {
  id: string;
  name: string;
  category: string | null;
  sold: number | null;
  soldN: number | null;
  est: number | null;
  basis: string | null;
}
export interface ReviewListing {
  id: string;
  title: string;
  productId: string | null;
  seller: string | null;
}
export interface ReviewPhoto {
  id: string;
  productId: string;
  sourceTitle: string | null;
}
export interface ReviewRelation {
  from: string;
  to: string;
  relation: string;
  status: string;
}
export interface ReviewAlias {
  text: string;
  productId: string;
  status: string;
}
export interface ReviewInput {
  products: ReviewProduct[];
  listings: ReviewListing[];
  photos: ReviewPhoto[];
  relations?: ReviewRelation[];
  aliases?: ReviewAlias[];
}

export interface EvidenceLine {
  text: string;
  strength: Strength;
}
/** One row of the side-by-side view: what is there now, and what the suggestion would make of it. */
export interface CompareRow {
  label: string;
  existing: string;
  proposed: string | null;
  strength: Strength;
}
export interface ReviewFinding {
  id: string;
  kind: FindingKind;
  category: ReviewCategory;
  productId: string;
  product: string;
  confidence: Confidence;
  /** "confirmed" only when every piece of evidence behind the finding is checkable in the data. */
  strength: Strength;
  summary: string;
  evidence: EvidenceLine[];
  rows: CompareRow[];
  related: Array<{ id: string; name: string }>;
  proposalIds: string[];
}
export interface PreviewChange {
  table: string;
  rowLabel: string;
  column: string;
  from: string;
  to: string;
}
export interface ReviewProposal {
  id: string;
  findingId: string;
  productId: string;
  product: string;
  action: ProposalAction;
  confidence: Confidence;
  strength: Strength;
  why: string;
  change: { table: string; key: Record<string, string>; set: Record<string, unknown> } | null;
  before: Record<string, unknown> | null;
  /** Exactly which stored values would change and to what; empty for a suggestion that changes no data. */
  preview: PreviewChange[];
  requiresReview: true;
}
export interface ReviewStats {
  products: number;
  productsWithFiledEvidence: number;
  listingsFiled: number;
  photosWithTitle: number;
  docsSupporting: number;
  docsPointElsewhere: number;
  docsFamilyOnly: number;
  docsUncertain: number;
  docsOther: number;
  aliasesChecked: number;
  aliasesDisputed: number;
  relationsChecked: number;
  relationsDisputed: number;
}
export interface ReviewResult {
  findings: ReviewFinding[];
  proposals: ReviewProposal[];
  stats: ReviewStats;
}
export interface ReviewOptions {
  /** Called now and then so a long run can give the event loop back. */
  yieldNow?: () => Promise<void>;
}

const confOf = (r: { sureness: string }): Confidence => (r.sureness === "high" ? "high" : r.sureness === "medium" ? "medium" : "low");
// A short stable id from the facts of a finding (FNV-1a, twice with different seeds): the same facts give the same id on every run.
const sha = (s: string) => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0").slice(0, 4);
};
const money = (v: number | null | undefined) => (v === null || v === undefined ? "none" : `$${v.toFixed(0)}`);
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// A word in more entries than this says little about which entries to compare.
const COMMON_WORD_ENTRIES = 300;

export async function analyzeReview(input: ReviewInput, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const prods = input.products;
  const byId = new Map(prods.map((p) => [p.id, p]));
  const nameOf = (id: string | null) => (id ? (byId.get(id)?.name ?? "(removed entry)") : "(no entry)");
  const docs: EvidenceDoc[] = [
    ...input.listings.map((l) => ({ text: l.title, origin: l.seller ? `seller:${l.seller.toLowerCase()}` : `title:${l.title.toLowerCase()}`, kind: "listing" as const })),
    ...input.photos.filter((i) => i.sourceTitle).map((i) => ({ text: i.sourceTitle as string, origin: `title:${(i.sourceTitle as string).toLowerCase()}`, kind: "photo" as const })),
  ];
  const entries = prods.map((p) => ({ id: p.id, name: p.name }));
  const ctx = buildContext(entries, docs);
  const info = (id: string) => ctx.info(id)!;
  let work = 0;
  const maybeYield = async () => {
    if (++work % 400 === 0 && opts.yieldNow) await opts.yieldNow();
  };

  // entries that share a distinguishing word with a text: what the resolver needs to read, instead of every entry
  const postings = new Map<string, string[]>();
  for (const i of ctx.infos()) for (const w of new Set([...i.words, ...(i.host?.words ?? [])])) (postings.get(w) ?? postings.set(w, []).get(w)!).push(i.id);
  const candidatesFor = (text: string, extra: string[] = []): Array<{ id: string; name: string }> => {
    const ids = new Set<string>(extra);
    for (const w of identityTokens(text).words) {
      const list = postings.get(w);
      if (list && list.length <= COMMON_WORD_ENTRIES) for (const id of list) ids.add(id);
    }
    return [...ids].map((id) => byId.get(id)).filter((p): p is ReviewProduct => !!p).map((p) => ({ id: p.id, name: p.name }));
  };

  const cache = new Map<string, ListingResolution>();
  const resolve = (title: string, seller?: string | null, extra: string[] = []): ListingResolution => {
    const k = title.toLowerCase() + "\u0001" + extra.join(",");
    let r = cache.get(k);
    if (!r) {
      r = resolveListing(title, candidatesFor(title, extra), ctx, { seller });
      cache.set(k, r);
    }
    return r;
  };

  const findings: ReviewFinding[] = [];
  const proposals: ReviewProposal[] = [];
  const addFinding = (f: Omit<ReviewFinding, "id" | "category" | "proposalIds">): ReviewFinding => {
    const full: ReviewFinding = { ...f, id: sha(`${f.kind}|${f.productId}|${f.related.map((r) => r.id).join(",")}|${f.evidence[0]?.text ?? ""}`), category: CATEGORY_OF[f.kind], proposalIds: [] };
    findings.push(full);
    return full;
  };
  const addProposal = (finding: ReviewFinding, p: Omit<ReviewProposal, "id" | "findingId" | "requiresReview" | "productId" | "product" | "strength"> & { strength?: Strength }): ReviewProposal => {
    const full: ReviewProposal = { id: sha(`${finding.id}|${p.action}|${JSON.stringify(p.change?.key ?? p.why)}`), findingId: finding.id, productId: finding.productId, product: finding.product, requiresReview: true, strength: p.strength ?? finding.strength, ...p };
    proposals.push(full);
    finding.proposalIds.push(full.id);
    return full;
  };

  type Doc = { kind: "listing" | "photo"; id: string; title: string; res: ListingResolution };
  const filed = new Map<string, Doc[]>();
  for (const l of input.listings) if (l.productId) (filed.get(l.productId) ?? filed.set(l.productId, []).get(l.productId)!).push({ kind: "listing", id: l.id, title: l.title, res: resolve(l.title, l.seller, [l.productId]) });
  for (const i of input.photos) if (i.sourceTitle) (filed.get(i.productId) ?? filed.set(i.productId, []).get(i.productId)!).push({ kind: "photo", id: i.id, title: i.sourceTitle, res: resolve(i.sourceTitle, null, [i.productId]) });

  const stats: ReviewStats = {
    products: prods.length, productsWithFiledEvidence: filed.size, listingsFiled: 0, photosWithTitle: 0, docsSupporting: 0, docsPointElsewhere: 0, docsFamilyOnly: 0, docsUncertain: 0, docsOther: 0,
    aliasesChecked: 0, aliasesDisputed: 0, relationsChecked: 0, relationsDisputed: 0,
  };
  const movePreview = (d: Doc, fromId: string, toId: string): PreviewChange[] => [
    { table: d.kind === "listing" ? "listings" : "product_images", rowLabel: `${d.kind === "listing" ? "Listing" : "Photo"} "${clip(d.title, 60)}"`, column: "filed under", from: nameOf(fromId), to: nameOf(toId) },
  ];

  for (const [pid, ds] of filed) {
    const p = byId.get(pid);
    if (!p) continue;
    await maybeYield();
    const pi = info(pid);
    const elsewhere: Array<{ d: Doc; target: { id: string; name: string }; v: ProductVerdict }> = [];
    const specifics: Array<{ d: Doc; target: { id: string; name: string } }> = [];
    let supporting = 0;
    for (const d of ds) {
      if (d.kind === "listing") stats.listingsFiled++;
      else stats.photosWithTitle++;
      const r = d.res;
      if (r.verdict === "confirmed" && r.product?.id === pid) {
        stats.docsSupporting++;
        supporting++;
      } else if (r.verdict === "confirmed" && r.product && r.product.id !== pid) {
        const v = compareProducts(pi, info(r.product.id), ctx);
        if (v.verdict === "confirmed") {
          stats.docsOther++; // the same product under another entry: a duplicate, not contamination
          continue;
        }
        if (v.verdict === "related" && v.relation !== "goes-with" && v.moreSpecific === "b") {
          specifics.push({ d, target: r.product });
          stats.docsPointElsewhere++;
          continue;
        }
        if (v.verdict === "related" && v.relation !== "goes-with" && v.moreSpecific === "a") {
          stats.docsUncertain++; // less specific than the entry: it cannot show the entry's variant
          continue;
        }
        stats.docsPointElsewhere++;
        elsewhere.push({ d, target: r.product, v });
      } else if (r.verdict === "related" && r.product?.id === pid && (r.relation === "family" || r.relation === "variant")) {
        stats.docsFamilyOnly++;
        specifics.push({ d, target: { id: "", name: r.newModel?.note ?? "no specific entry" } });
      } else if (r.verdict === "uncertain" || r.verdict === "related") {
        stats.docsUncertain++;
      } else stats.docsOther++;
    }

    // filed material that is confidently a different product
    const real = elsewhere.filter((e) => e.v.verdict === "different" || e.v.verdict === "related");
    if (real.length) {
      const confidence: Confidence = real.some((e) => e.d.res.sureness === "high") && supporting === 0 ? "high" : real.some((e) => e.d.res.sureness !== "low") ? "medium" : "low";
      const distinctTargets = new Set(real.map((e) => e.target.id));
      const lines: EvidenceLine[] = real.slice(0, 8).map((e) => ({
        text: `${e.d.kind} "${clip(e.d.title)}" is "${e.target.name}" (${e.v.verdict}${e.v.relation ? "/" + e.v.relation : ""})`,
        strength: e.d.res.sureness === "high" && (e.v.verdict === "different" || e.v.relation === "goes-with") ? "confirmed" : "heuristic",
      }));
      const f = addFinding({
        kind: distinctTargets.size >= 2 || (supporting > 0 && real.length > 0) ? "merged" : "contaminated", productId: pid, product: p.name, confidence, strength: lines.every((l) => l.strength === "confirmed") ? "confirmed" : "heuristic",
        summary: `${real.length} of ${ds.length} filed items are confidently a different product${supporting ? ` (${supporting} support this entry)` : " (none support this entry)"}`,
        evidence: lines,
        rows: real.slice(0, 6).map((e) => ({ label: `${e.d.kind === "listing" ? "Listing" : "Photo"} "${clip(e.d.title, 50)}"`, existing: `filed under "${p.name}"`, proposed: `belongs to "${e.target.name}"`, strength: (e.d.res.sureness === "high" ? "confirmed" : "heuristic") as Strength })),
        related: [...new Map(real.map((e) => [e.target.id, e.target])).values()].slice(0, 5),
      });
      for (const e of real) {
        addProposal(f, {
          action: e.d.kind === "listing" ? "move-listing" : "move-photo", confidence: confOf(e.d.res) === "high" && supporting === 0 ? "high" : "medium",
          why: `"${clip(e.d.title)}" resolves to "${e.target.name}", not "${p.name}"`,
          change: { table: e.d.kind === "listing" ? "listings" : "product_images", key: { id: e.d.id }, set: { product_id: e.target.id } }, before: { product_id: pid },
          preview: movePreview(e.d, pid, e.target.id),
          strength: e.d.res.sureness === "high" ? "confirmed" : "heuristic",
        });
      }
    }
    // an entry holding items that name something more specific
    if (specifics.length) {
      const generic = pi.generic || pi.words.size <= 1;
      const lines: EvidenceLine[] = specifics.slice(0, 8).map((s) => ({ text: `${s.d.kind} "${clip(s.d.title)}" names ${s.target.id ? `the more specific "${s.target.name}"` : "something more specific than this entry (no entry for it yet)"}`, strength: s.target.id && s.d.res.sureness !== "low" ? "confirmed" : "heuristic" }));
      const f = addFinding({
        kind: generic ? "generic-holds-specific" : "filed-under-broader", productId: pid, product: p.name, confidence: specifics.some((s) => s.target.id) ? "high" : "medium", strength: lines.every((l) => l.strength === "confirmed") ? "confirmed" : "heuristic",
        summary: `${generic ? "family-level entry" : "entry"} with ${specifics.length} filed item(s) that name something more specific`,
        evidence: lines,
        rows: specifics.slice(0, 6).map((s) => ({ label: `${s.d.kind === "listing" ? "Listing" : "Photo"} "${clip(s.d.title, 50)}"`, existing: `filed under "${p.name}"`, proposed: s.target.id ? `would be filed under "${s.target.name}"` : "no better entry exists yet", strength: (s.target.id ? "confirmed" : "heuristic") as Strength })),
        related: specifics.filter((s) => s.target.id).slice(0, 5).map((s) => s.target),
      });
      for (const s of specifics.filter((x) => x.target.id)) {
        addProposal(f, {
          action: s.d.kind === "listing" ? "move-listing" : "move-photo", confidence: "medium", why: `"${clip(s.d.title)}" is the more specific "${s.target.name}", filed under "${p.name}"`,
          change: { table: s.d.kind === "listing" ? "listings" : "product_images", key: { id: s.d.id }, set: { product_id: s.target.id } }, before: { product_id: pid },
          preview: movePreview(s.d, pid, s.target.id), strength: s.d.res.sureness !== "low" ? "confirmed" : "heuristic",
        });
      }
    }
    // material is filed but none of it supports the entry
    if (ds.length > 0 && supporting === 0 && real.length === 0 && !specifics.length) {
      addFinding({
        kind: "needs-evidence", productId: pid, product: p.name, confidence: "low", strength: "heuristic", summary: `${ds.length} filed item(s), none states what the entry states`,
        evidence: ds.slice(0, 5).map((d) => ({ text: `${d.kind} "${clip(d.title)}" -> ${d.res.verdict}`, strength: "heuristic" as Strength })),
        rows: [{ label: "What is filed", existing: `${ds.length} item(s) under "${p.name}"`, proposed: "needs a person to say what this entry is", strength: "heuristic" }], related: [],
      });
    }
  }

  // duplicates: entries that read as the same product (candidates by shared words, so it scales)
  const dupPairs: Array<{ a: ReviewProduct; b: ReviewProduct; v: ProductVerdict }> = [];
  const seenPair = new Set<string>();
  for (const a of prods) {
    await maybeYield();
    const ia = info(a.id);
    const near = new Set<string>();
    for (const w of new Set([...ia.words, ...(ia.host?.words ?? [])])) {
      const list = postings.get(w);
      if (list && list.length <= COMMON_WORD_ENTRIES) for (const id of list) near.add(id);
    }
    for (const id of near) {
      if (id === a.id) continue;
      const key = a.id < id ? `${a.id}|${id}` : `${id}|${a.id}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const b = byId.get(id)!;
      const [x, y] = a.id < id ? [a, b] : [b, a];
      const v = compareProducts(info(x.id), info(y.id), ctx);
      if (v.verdict === "confirmed" || (v.verdict === "uncertain" && v.lean === "same")) dupPairs.push({ a: x, b: y, v });
    }
  }
  dupPairs.sort((p, q) => (p.a.name + p.b.name).localeCompare(q.a.name + q.b.name));
  for (const d of dupPairs) {
    const sameCategory = d.a.category === d.b.category;
    const sure = d.v.verdict === "confirmed";
    const f = addFinding({
      kind: sure ? "duplicate" : "possible-duplicate", productId: d.a.id, product: d.a.name, confidence: sure ? (sameCategory ? "high" : "medium") : "low", strength: sure ? "confirmed" : "heuristic",
      summary: `"${d.a.name}" and "${d.b.name}" read as the same product (${d.v.reasons[0] ?? ""})${sameCategory ? "" : "; categories differ"}`,
      evidence: [{ text: d.v.reasons.join("; "), strength: sure ? "confirmed" : "heuristic" }],
      rows: [
        { label: "Name", existing: d.a.name, proposed: d.b.name, strength: sure ? "confirmed" : "heuristic" },
        { label: "Category", existing: d.a.category ?? "(none)", proposed: d.b.category ?? "(none)", strength: "confirmed" },
        { label: "Stored value", existing: `${money(d.a.est ?? d.a.sold)} (${d.a.soldN ?? 0} sales)`, proposed: `${money(d.b.est ?? d.b.sold)} (${d.b.soldN ?? 0} sales)`, strength: "confirmed" },
      ],
      related: [{ id: d.b.id, name: d.b.name }],
    });
    if (sure) {
      addProposal(f, {
        action: "review-merge", confidence: sameCategory ? "high" : "medium", why: `"${d.b.name}" reads as the same product as "${d.a.name}": a person decides which name to keep; nothing is merged automatically`,
        change: null, before: null, preview: [],
      });
    }
  }

  // valuations
  const valued = prods.filter((p) => p.sold != null || p.est != null);
  const valueOf = (p: ReviewProduct) => p.est ?? p.sold ?? null;
  for (const p of valued) {
    await maybeYield();
    const pi = info(p.id);
    const val = valueOf(p)!;
    const flags: EvidenceLine[] = [];
    let conf: Confidence = "low";
    if (pi.generic || pi.words.size <= 1) {
      flags.push({ text: `a value (${money(val)}) is held on a family-level entry`, strength: "confirmed" });
      conf = "medium";
    }
    if ((p.soldN ?? 0) <= 1 && p.est == null) flags.push({ text: `the average rests on ${p.soldN ?? 0} comparable sale(s)`, strength: "confirmed" });
    const dup = dupPairs.find((d) => (d.a.id === p.id || d.b.id === p.id) && d.v.verdict === "confirmed");
    let divergence = false;
    if (dup) {
      const other = dup.a.id === p.id ? dup.b : dup.a;
      const ov = valueOf(other);
      if (ov != null && Math.abs(ov - val) / Math.max(ov, val) >= 0.3) {
        flags.push({ text: `the same product under "${other.name}" is valued ${money(ov)} (this one ${money(val)})`, strength: "confirmed" });
        conf = "high";
        divergence = true;
      }
    }
    const contaminated = findings.find((f) => (f.kind === "contaminated" || f.kind === "merged") && f.productId === p.id);
    if (contaminated) {
      flags.push({ text: "its filed material includes other products, so comparable sales found for it may mix products", strength: "heuristic" });
      conf = conf === "high" ? "high" : "medium";
    }
    // far from its own variants (only when the sample is small)
    if ((p.soldN ?? 0) <= 2) {
      const near = new Set<string>();
      for (const w of new Set([...pi.words, ...(pi.host?.words ?? [])])) {
        const list = postings.get(w);
        if (list && list.length <= COMMON_WORD_ENTRIES) for (const id of list) near.add(id);
      }
      const sib = [...near]
        .map((id) => byId.get(id)!)
        .filter((q) => q.id !== p.id && valueOf(q) != null && (q.soldN ?? 0) >= 3)
        .filter((q) => {
          const v = compareProducts(pi, info(q.id), ctx);
          return v.verdict === "related" && v.relation === "variant";
        });
      if (sib.length) {
        const med = sib.map((q) => valueOf(q)!).sort((x, y) => x - y)[Math.floor(sib.length / 2)];
        if (val > med * 3 || val < med / 3) flags.push({ text: `its value is more than 3x away from its variants' median (${money(med)}) on a sample of ${p.soldN ?? 0}`, strength: "heuristic" });
      }
    }
    if (flags.length) {
      const f = addFinding({
        kind: "valuation", productId: p.id, product: p.name, confidence: conf, strength: divergence ? "confirmed" : "heuristic", summary: flags[0].text, evidence: flags,
        rows: [
          { label: "Stored value", existing: `${money(val)} from ${p.soldN ?? 0} sale(s)`, proposed: conf !== "low" ? "cleared, to be researched again" : null, strength: divergence ? "confirmed" : "heuristic" },
        ],
        related: [],
      });
      if (conf !== "low") {
        addProposal(f, {
          action: "clear-valuation", confidence: conf, why: flags.map((x) => x.text).join("; "),
          change: { table: "products", key: { id: p.id }, set: { ebay_avg_sold_price_usd: null, ebay_comps_sample_size: null, ebay_est_value_usd: null, ebay_est_basis: null } },
          before: { ebay_avg_sold_price_usd: p.sold, ebay_comps_sample_size: p.soldN, ebay_est_value_usd: p.est, ebay_est_basis: p.basis },
          preview: [
            { table: "products", rowLabel: `Entry "${p.name}"`, column: "average sold price", from: money(p.sold), to: "none" },
            { table: "products", rowLabel: `Entry "${p.name}"`, column: "number of sales", from: String(p.soldN ?? "none"), to: "none" },
            { table: "products", rowLabel: `Entry "${p.name}"`, column: "estimated value", from: money(p.est), to: "none" },
            { table: "products", rowLabel: `Entry "${p.name}"`, column: "value basis", from: p.basis ?? "none", to: "none" },
          ],
        });
      }
    }
  }

  // candidate aliases and relations (only exist when the identity foundation is on)
  for (const a of input.aliases ?? []) {
    stats.aliasesChecked++;
    const target = byId.get(a.productId);
    if (!target) continue;
    const r = resolve(a.text, null, [a.productId]);
    const wrong = (r.verdict === "confirmed" && r.product && r.product.id !== a.productId && compareProducts(info(a.productId), info(r.product.id), ctx).verdict !== "confirmed") || (r.verdict === "related" && r.relation === "goes-with");
    if (wrong) {
      stats.aliasesDisputed++;
      const f = addFinding({
        kind: "alias", productId: a.productId, product: target.name, confidence: confOf(r), strength: r.verdict === "confirmed" ? "confirmed" : "heuristic",
        summary: `alias candidate "${a.text}" resolves to ${r.verdict === "related" ? `an item that goes with "${r.product?.name}"` : `"${r.product?.name}"`}, not "${target.name}"`,
        evidence: [{ text: r.reasons.join("; "), strength: r.verdict === "confirmed" ? "confirmed" : "heuristic" }],
        rows: [{ label: `Alias "${a.text}"`, existing: `candidate for "${target.name}"`, proposed: "rejected as an alias of this entry", strength: r.verdict === "confirmed" ? "confirmed" : "heuristic" }],
        related: r.product ? [r.product] : [],
      });
      addProposal(f, {
        action: "reject-alias-candidate", confidence: confOf(r), why: `alias candidate "${a.text}" does not stand for "${target.name}" (${r.reasons[0] ?? ""})`,
        change: { table: "product_aliases", key: { alias_text: a.text, product_id: a.productId }, set: { status: "rejected" } }, before: { status: a.status },
        preview: [{ table: "product_aliases", rowLabel: `Alias "${a.text}" -> "${target.name}"`, column: "status", from: a.status, to: "rejected" }],
      });
    }
  }
  for (const r of input.relations ?? []) {
    stats.relationsChecked++;
    const f0 = byId.get(r.from);
    const t = byId.get(r.to);
    if (!f0 || !t) continue;
    await maybeYield();
    const v = compareProducts(info(f0.id), info(t.id), ctx);
    const conflicts = (r.relation === "same-as" && (v.verdict === "different" || (v.verdict === "related" && v.relation !== "alias"))) || (r.relation === "narrower-than" && v.verdict === "confirmed");
    if (conflicts) {
      stats.relationsDisputed++;
      const sure = v.verdict === "confirmed" || v.verdict === "different";
      const f = addFinding({
        kind: "relation", productId: f0.id, product: f0.name, confidence: sure ? "high" : "medium", strength: sure ? "confirmed" : "heuristic",
        summary: `candidate relation "${r.relation}" to "${t.name}" disagrees with the resolver (${v.verdict}${v.relation ? "/" + v.relation : ""})`,
        evidence: [{ text: v.reasons.join("; "), strength: sure ? "confirmed" : "heuristic" }],
        rows: [{ label: `"${f0.name}" ${r.relation} "${t.name}"`, existing: `candidate (${r.status})`, proposed: "rejected", strength: sure ? "confirmed" : "heuristic" }],
        related: [{ id: t.id, name: t.name }],
      });
      addProposal(f, {
        action: "reject-relation-candidate", confidence: "medium", why: `"${f0.name}" ${r.relation} "${t.name}" is contradicted by the current read (${v.verdict}${v.relation ? "/" + v.relation : ""})`,
        change: { table: "product_relations", key: { from_product_id: r.from, to_product_id: r.to, relation: r.relation }, set: { status: "rejected" } }, before: { status: r.status },
        preview: [{ table: "product_relations", rowLabel: `"${f0.name}" ${r.relation} "${t.name}"`, column: "status", from: r.status, to: "rejected" }],
      });
    }
  }

  // entries with nothing filed that show what they are
  for (const p of prods) {
    if (filed.has(p.id)) continue;
    const pi = info(p.id);
    if (pi.words.size <= 1 || (pi.generic && !pi.host)) {
      const f = addFinding({
        kind: "needs-evidence", productId: p.id, product: p.name, confidence: "low", strength: "heuristic",
        summary: pi.words.size <= 1 ? "a one-word entry with no filed listing or photo title" : "a family-level entry with no filed listing or photo title", evidence: [],
        rows: [{ label: "What is filed", existing: "nothing that shows what this entry is", proposed: "gather evidence (no data changes)", strength: "heuristic" }], related: [],
      });
      addProposal(f, { action: "gather-evidence", confidence: "low", why: "nothing filed under this entry shows what it stands for", change: null, before: null, preview: [] });
    }
  }
  return { findings, proposals, stats };
}

/** Counts used by the audit report: what could put a wrong product or number in front of a decision ("core") versus informational findings. */
export function summarizeReview(result: ReviewResult, totalProducts: number) {
  const { findings, proposals } = result;
  const byKind: Record<string, { findings: number; products: number; high: number; medium: number; low: number }> = {};
  for (const f of findings) {
    const k = (byKind[f.kind] ??= { findings: 0, products: 0, high: 0, medium: 0, low: 0 });
    k.findings++;
    k[f.confidence]++;
  }
  for (const kind of Object.keys(byKind)) byKind[kind].products = new Set(findings.filter((f) => f.kind === kind).map((f) => f.productId)).size;
  const coreKinds = new Set<FindingKind>(["contaminated", "merged", "generic-holds-specific", "duplicate", "alias", "relation"]);
  const isCore = (f: ReviewFinding) => coreKinds.has(f.kind) || (f.kind === "valuation" && f.confidence !== "low");
  const core = new Set(findings.filter(isCore).map((f) => f.productId));
  const flagged = (c?: Confidence) => new Set(findings.filter((f) => !c || f.confidence === c).map((f) => f.productId)).size;
  const byAction: Record<string, number> = {};
  for (const p of proposals) byAction[p.action] = (byAction[p.action] ?? 0) + 1;
  const byCategory: Record<string, { findings: number; confirmed: number; heuristic: number }> = {};
  for (const f of findings) {
    const c = (byCategory[f.category] ??= { findings: 0, confirmed: 0, heuristic: 0 });
    c.findings++;
    c[f.strength]++;
  }
  return {
    findingsByKind: byKind,
    findingsByCategory: byCategory,
    productsFlagged: {
      any: flagged(), high: flagged("high"), medium: flagged("medium"), core: core.size, ofTotal: totalProducts,
      withDifferentProductMaterialFiled: new Set(findings.filter((f) => f.kind === "contaminated" || f.kind === "merged").map((f) => f.productId)).size,
      informationalOnly: new Set(findings.filter((f) => !isCore(f)).map((f) => f.productId).filter((id) => !core.has(id))).size,
    },
    proposals: { total: proposals.length, byAction, byConfidence: { high: proposals.filter((p) => p.confidence === "high").length, medium: proposals.filter((p) => p.confidence === "medium").length, low: proposals.filter((p) => p.confidence === "low").length } },
  };
}
