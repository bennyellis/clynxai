// Shadow-mode analysis: runs the current matcher and the proposed resolver side by side over a set of products and listings and records where they
// disagree, with the evidence. PURE: it takes plain data and returns plain data. It performs no I/O, never imports the notification, AI, scraper or
// Database-writing code, and cannot change anything; the command-line runner that feeds it from a read-only copy of a database lives in
// audit/phase4_shadow/. A disagreement is NOT proof the new resolver is right; the report keeps the two sides apart for human review.
import { codesMissingFrom } from "./codes.js";
import { compareIdentity, identityTokens, type IdentityComparison } from "./resolver.js";

export interface ShadowProduct {
  id: string;
  name: string;
  category: string;
  parentId: string | null;
  valueUsd: number | null;
  // Titles of the listings that were filed under this product (reference-photo source titles and listings pointing at it).
  titles: string[];
  // What the existing comps pass concluded about this entry, when known.
  compsIdentity: string | null;
}

export interface ShadowListing {
  id: string;
  title: string;
  price: number | null;
  productId: string | null;
}

export type Matcher = (a: string, b: string) => boolean;

export interface PairDisagreement {
  kind: "old-same/new-line" | "old-same/new-different" | "old-different/new-exact" | "old-different/new-possible-alias";
  a: string;
  b: string;
  categoryA: string;
  categoryB: string;
  newLevel: IdentityComparison["level"];
  evidence: IdentityComparison;
}

export interface PairResult {
  pairs: number;
  // rows: old same / not; columns: new exact / line / different
  matrix: { oldSame: Record<IdentityComparison["level"], number>; oldNot: Record<IdentityComparison["level"], number> };
  disagreements: PairDisagreement[];
  // per product: how many OTHER entries each method treats as the same product (lookup ambiguity)
  collisions: Array<{ id: string; name: string; category: string; old: number; newExact: number }>;
  byCategory: Record<string, { pairs: number; oldSame: number; oldSameNewLineOrDifferent: number; oldNotNewExact: number }>;
}

export function comparePairs(products: ShadowProduct[], oldSame: Matcher, optional?: ReadonlySet<string>): PairResult {
  const empty = () => ({ exact: 0, line: 0, different: 0, "possible-alias": 0 });
  const matrix = { oldSame: empty(), oldNot: empty() };
  const disagreements: PairDisagreement[] = [];
  const oldCount = new Map<string, number>();
  const newCount = new Map<string, number>();
  const byCategory: PairResult["byCategory"] = {};
  let pairs = 0;
  for (let i = 0; i < products.length; i++) {
    for (let j = i + 1; j < products.length; j++) {
      const a = products[i];
      const b = products[j];
      const o = oldSame(a.name, b.name);
      const cmp = compareIdentity(a.name, b.name, optional);
      pairs++;
      (o ? matrix.oldSame : matrix.oldNot)[cmp.level]++;
      if (o) oldCount.set(a.id, (oldCount.get(a.id) ?? 0) + 1), oldCount.set(b.id, (oldCount.get(b.id) ?? 0) + 1);
      if (cmp.level === "exact") newCount.set(a.id, (newCount.get(a.id) ?? 0) + 1), newCount.set(b.id, (newCount.get(b.id) ?? 0) + 1);
      const cat = a.category === b.category ? a.category : "(different categories)";
      const row = (byCategory[cat] ??= { pairs: 0, oldSame: 0, oldSameNewLineOrDifferent: 0, oldNotNewExact: 0 });
      row.pairs++;
      if (o) row.oldSame++;
      if (o && cmp.level !== "exact") {
        row.oldSameNewLineOrDifferent++;
        disagreements.push({ kind: cmp.level === "line" || cmp.level === "possible-alias" ? "old-same/new-line" : "old-same/new-different", a: a.name, b: b.name, categoryA: a.category, categoryB: b.category, newLevel: cmp.level, evidence: cmp });
      } else if (!o && (cmp.level === "exact" || cmp.level === "possible-alias")) {
        if (cmp.level === "exact") row.oldNotNewExact++;
        disagreements.push({ kind: cmp.level === "exact" ? "old-different/new-exact" : "old-different/new-possible-alias", a: a.name, b: b.name, categoryA: a.category, categoryB: b.category, newLevel: cmp.level, evidence: cmp });
      }
    }
  }
  const collisions = products
    .map((p) => ({ id: p.id, name: p.name, category: p.category, old: oldCount.get(p.id) ?? 0, newExact: newCount.get(p.id) ?? 0 }))
    .filter((c) => c.old > 0 || c.newExact > 0);
  return { pairs, matrix, disagreements, collisions, byCategory };
}

// ---------- generic entries that have more specific siblings, and what was filed under them

export interface GenericWithSpecific {
  generic: { id: string; name: string; category: string; filedTitles: number };
  specific: { id: string; name: string };
  distinguishing: string[];
  // Titles filed under the generic entry that state every distinguishing word of the specific one: likely misfiled.
  likelyMisfiled: string[];
}

export function genericsWithSpecificSiblings(products: ShadowProduct[]): GenericWithSpecific[] {
  const out: GenericWithSpecific[] = [];
  for (const a of products) {
    for (const b of products) {
      if (a.id === b.id) continue;
      const cmp = compareIdentity(a.name, b.name);
      if (cmp.level !== "line" || cmp.moreSpecific !== "b") continue;
      const need = cmp.onlyInB;
      if (need.length === 0) continue;
      const misfiled = a.titles.filter((t) => {
        const tokens = identityTokens(t).words;
        return need.every((w) => tokens.has(w));
      });
      out.push({ generic: { id: a.id, name: a.name, category: a.category, filedTitles: a.titles.length }, specific: { id: b.id, name: b.name }, distinguishing: need, likelyMisfiled: misfiled });
    }
  }
  return out;
}

// ---------- possibly mixed entries, from the titles filed under them

export interface MixedAssessment {
  id: string;
  name: string;
  category: string;
  titles: number;
  assessable: boolean;
  mixed: boolean;
  // "code": two groups of titles that state different model numbers; "word": different version words only.
  kind: "code" | "word" | null;
  groups: Array<{ token: string; count: number }>;
}

export function assessMixed(p: ShadowProduct): MixedAssessment {
  const distinct = [...new Set(p.titles.map((t) => t.toLowerCase().trim()).filter(Boolean))];
  const base: MixedAssessment = { id: p.id, name: p.name, category: p.category, titles: distinct.length, assessable: distinct.length >= 4, mixed: false, kind: null, groups: [] };
  if (!base.assessable) return base;
  const nameWords = identityTokens(p.name).words;
  const residual = distinct.map((t) => new Set([...identityTokens(t).words].filter((w) => !nameWords.has(w) && w.length > 1)));
  const df = new Map<string, number>();
  for (const r of residual) for (const w of r) df.set(w, (df.get(w) ?? 0) + 1);
  const cands = [...df].filter(([, n]) => n >= 2 && n <= distinct.length - 1).map(([w]) => w);
  let best: { x: string; y: string; score: number; kind: "code" | "word" } | null = null;
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const x = cands[i];
      const y = cands[j];
      if (residual.some((r) => r.has(x) && r.has(y))) continue; // they co-occur: not two separate versions
      const score = Math.min(df.get(x)!, df.get(y)!);
      const kind = /\d/.test(x) && /\d/.test(y) ? "code" : "word";
      const rank = (k: "code" | "word") => (k === "code" ? 1000 : 0);
      if (!best || rank(kind) + score > rank(best.kind) + best.score) best = { x, y, score, kind };
    }
  }
  if (best) {
    base.mixed = true;
    base.kind = best.kind;
    base.groups = [
      { token: best.x, count: df.get(best.x)! },
      { token: best.y, count: df.get(best.y)! },
    ];
  }
  return base;
}

// ---------- listings against entries

export interface TitleResolution {
  listingId: string;
  title: string;
  storedProductId: string | null;
  oldPick: string | null;
  newPick: string | null;
  newLevel: "exact" | "line" | null;
  extraCodes: string[];
  ambiguous: boolean;
}

// The existing title-to-entry rule (store.getProductSignals' fallback): the product whose whole name appears in the title wins, the most words first.
export function oldTitlePick(title: string, products: ShadowProduct[], specsOk: (name: string, title: string) => boolean): string | null {
  const hay = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let best: { id: string; words: number } | null = null;
  for (const p of products) {
    const words = p.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !["the", "and", "for", "with", "of"].includes(w));
    if (words.length < 2 || !words.every((w) => hay.includes(w)) || !specsOk(p.name, title)) continue;
    if (!best || words.length > best.words) best = { id: p.id, words: words.length };
  }
  return best?.id ?? null;
}

// The proposed rule: entries whose stated words are all in the title are candidates; the one covering the most wins; a model number the title states
// and the entry lacks makes the match "line" (the listing is narrower than the entry); a tie is reported as ambiguous.
export function newTitlePick(title: string, products: ShadowProduct[]): { id: string | null; level: "exact" | "line" | null; extraCodes: string[]; ambiguous: boolean } {
  const t = identityTokens(title);
  const scored: Array<{ id: string; covered: number; extra: string[] }> = [];
  for (const p of products) {
    const n = identityTokens(p.name);
    if (n.words.size < 2) continue;
    if (![...n.words].every((w) => t.words.has(w))) continue;
    if (n.capacities.size > 0 && ![...n.capacities].some((c) => t.capacities.has(c))) continue;
    scored.push({ id: p.id, covered: n.words.size + n.capacities.size, extra: codesMissingFrom(p.name, title) });
  }
  if (scored.length === 0) return { id: null, level: null, extraCodes: [], ambiguous: false };
  scored.sort((a, b) => a.extra.length - b.extra.length || b.covered - a.covered);
  const top = scored[0];
  const tie = scored.filter((s) => s.extra.length === top.extra.length && s.covered === top.covered);
  return { id: top.id, level: top.extra.length === 0 ? "exact" : "line", extraCodes: top.extra, ambiguous: tie.length > 1 };
}

export function resolveListings(listings: ShadowListing[], products: ShadowProduct[], specsOk: (name: string, title: string) => boolean): TitleResolution[] {
  return listings.map((l) => {
    const n = newTitlePick(l.title, products);
    return { listingId: l.id, title: l.title, storedProductId: l.productId, oldPick: oldTitlePick(l.title, products, specsOk), newPick: n.id, newLevel: n.level, extraCodes: n.extraCodes, ambiguous: n.ambiguous };
  });
}
