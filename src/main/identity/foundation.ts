// Stage 3a - the additive Database identity foundation: what is STORED about a product's identity and about how products relate, with the evidence behind
// each statement. Pure builders only (no I/O); store.ts persists the results in tables that exist only when the foundation is switched on.
//
// Nothing here decides anything. A relation or an alias is a CANDIDATE until a person approves it or independent evidence corroborates it, and no code in the
// app reads these tables to pick, merge, split, rename or re-value a product. The representation is category-agnostic: attributes are generic kinds
// (word, code, capacity, host) found by patterns, and relations say how two products relate, not what kind of thing either is.
import { createHash } from "node:crypto";
import { definingCodes } from "./codes.js";
import { compareIdentity, identityTokens } from "./resolver.js";
import { NOISE_WORDS } from "./words.js";

export const IDENTITY_VERSION = 1;

export type AttributeKind = "word" | "code" | "capacity" | "number" | "host";
export type AttributeSource = "name" | "filed-title" | "listing-title" | "photo-analysis" | "user";
export interface IdentityAttribute {
  kind: AttributeKind;
  value: string;
  source: AttributeSource;
  // 0..1, uncalibrated: only for ordering and for showing how much stands behind a value.
  confidence: number;
  // What an attribute is worth in telling products apart is NOT decided yet (that needs price evidence, Stage 5).
  weight: "unknown" | "likely-defining";
}

export interface ProductIdentityRow {
  productId: string;
  version: number;
  level: "exact" | "line" | "unknown";
  identityKey: string | null;
  confidence: number;
  attributes: IdentityAttribute[];
  unresolved: string[];
  evidence: { method: string; inputs: { name: string; filedTitles: number }; corroboratedCodes: Array<{ code: string; reason: string }> };
  sourceHash: string;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** The text of a name with any bracketed "host" part ("Pokémon Y (Nintendo 3DS)" -> "Pokémon Y") and the host part itself. */
export function splitHost(name: string): { subject: string; host: string | null } {
  const m = /[(\[]([^)\]]+)[)\]]/.exec(name);
  if (!m) return { subject: name, host: null };
  return { subject: (name.slice(0, m.index) + " " + name.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), host: m[1].trim() };
}

export function hashInputs(name: string, filedTitles: string[]): string {
  return sha(`${IDENTITY_VERSION}|${name}|${[...filedTitles].sort().join("|")}`);
}

/** What a product's own name states, as attributes with their provenance. Deterministic and free. */
export function buildProductIdentity(args: { productId: string; name: string; filedTitles?: string[]; corroborated?: Array<{ code: string; reason: string }> }): ProductIdentityRow {
  const { subject, host } = splitHost(args.name);
  const tokens = identityTokens(subject);
  const codes = definingCodes(subject);
  const corroborated = args.corroborated ?? [];
  const attributes: IdentityAttribute[] = [];
  for (const c of codes) {
    const proven = corroborated.some((x) => x.code === c);
    attributes.push({ kind: "code", value: c, source: "name", confidence: proven ? 0.9 : 0.7, weight: "likely-defining" });
  }
  // A small plain number in a PRODUCT NAME ("iPhone 12", "12 inch skillet") is a deliberate part of the name, unlike a stray number in a listing title.
  for (const w of tokens.words) {
    if (codes.includes(w) || NOISE_WORDS.has(w)) continue;
    if (/^\d+$/.test(w)) attributes.push({ kind: "number", value: w, source: "name", confidence: 0.55, weight: "likely-defining" });
    else attributes.push({ kind: "word", value: w, source: "name", confidence: 0.6, weight: "unknown" });
  }
  for (const cap of tokens.capacities) attributes.push({ kind: "capacity", value: cap, source: "name", confidence: 0.8, weight: "likely-defining" });
  if (host) attributes.push({ kind: "host", value: host.toLowerCase(), source: "name", confidence: 0.6, weight: "unknown" });

  const hasCode = codes.length > 0 || tokens.capacities.size > 0 || attributes.some((a) => a.kind === "number");
  const wordCount = attributes.filter((a) => a.kind === "word").length;
  const level: ProductIdentityRow["level"] = hasCode ? "exact" : wordCount >= 2 ? "line" : "unknown";
  const unresolved: string[] = [];
  if (!hasCode) unresolved.push("the name states no model, version, size or capacity identifier");
  if (wordCount < 2 && !hasCode) unresolved.push("the name is a single word");
  const confidence = Math.min(0.9, 0.3 + (codes.length ? 0.25 : 0) + (tokens.capacities.size ? 0.1 : 0) + (wordCount >= 3 ? 0.1 : 0) + (corroborated.length ? 0.1 : 0));
  const keyParts = [...attributes.filter((a) => a.kind !== "host").map((a) => `${a.kind}:${a.value}`)].sort();
  return {
    productId: args.productId,
    version: IDENTITY_VERSION,
    level,
    identityKey: level === "unknown" ? null : sha(keyParts.join("|")),
    confidence: Number(confidence.toFixed(2)),
    attributes,
    unresolved,
    evidence: { method: "name-attributes/v1", inputs: { name: args.name, filedTitles: (args.filedTitles ?? []).length }, corroboratedCodes: corroborated },
    sourceHash: hashInputs(args.name, args.filedTitles ?? []),
  };
}

/** The searchable terms of an identity (what the candidate index is built from). */
export function identityTermsOf(name: string): Array<{ term: string; kind: "word" | "code" | "capacity" }> {
  const { subject, host } = splitHost(name);
  const out = new Map<string, { term: string; kind: "word" | "code" | "capacity" }>();
  const t = identityTokens(subject);
  const codes = new Set(definingCodes(subject));
  for (const w of t.words) if (!NOISE_WORDS.has(w)) out.set(`${codes.has(w) ? "code" : "word"}:${w}`, { term: w, kind: codes.has(w) ? "code" : "word" });
  for (const c of t.capacities) out.set(`capacity:${c}`, { term: c, kind: "capacity" });
  // the whole identifier too ("m18"), since the word list above holds it only in split form ("m", "18")
  for (const c of codes) out.set(`code:${c}`, { term: c, kind: "code" });
  if (host) for (const w of identityTokens(host).words) if (!NOISE_WORDS.has(w)) out.set(`word:${w}`, { term: w, kind: "word" });
  return [...out.values()];
}

// ---------- relations

export type RelationKind = "narrower-than" | "references" | "same-as";
export type RelationStatus = "candidate" | "confirmed" | "rejected";

export interface RelationCandidate {
  // The product that is narrower / that does the referencing / (same-as: the lower id).
  fromProductId: string;
  toProductId: string;
  relation: RelationKind;
  // For "references": how the one points at the other ("for", "with", "includes", "mentions"). Null otherwise.
  role: string | null;
  confidence: number;
  evidence: Record<string, unknown>;
  // What this relation could ALSO be, so nobody treats it as the one obvious reading.
  ambiguity: string[];
}

const CONNECTORS: Array<[RegExp, string]> = [
  [/\b(?:for|fits?|compatible with|designed for)\s+/i, "for"],
  [/\bwith\s+/i, "with"],
  [/\b(?:includes?|including|plus)\s+/i, "includes"],
];

/**
 * How a name points at another product without being that product: its words sit in brackets ("X (Some Product)") or after a connector ("Cable for Some
 * Product"). Returns the role, or null when the name simply contains the other's words as part of its own description.
 */
export function referenceRole(narrowerName: string, baseName: string): string | null {
  const base = [...identityTokens(baseName).words].filter((w) => !NOISE_WORDS.has(w));
  if (base.length === 0) return null;
  const holds = (text: string) => {
    const w = identityTokens(text).words;
    return base.every((b) => w.has(b));
  };
  const { host } = splitHost(narrowerName);
  if (host && holds(host)) return "for";
  for (const [re, role] of CONNECTORS) {
    const m = re.exec(narrowerName);
    if (m && holds(narrowerName.slice(m.index + m[0].length))) return role;
  }
  return null;
}

/** The candidate relation between two products, if any. Everything it returns is a suggestion with its ambiguity attached; none of it is acted on. */
export function classifyRelation(a: { id: string; name: string }, b: { id: string; name: string }): RelationCandidate | null {
  const cmp = compareIdentity(a.name, b.name);
  if (cmp.level === "different") return null;
  if (cmp.level === "exact" || cmp.level === "possible-alias") {
    const [from, to] = a.id < b.id ? [a, b] : [b, a];
    return {
      fromProductId: from.id,
      toProductId: to.id,
      relation: "same-as",
      role: null,
      confidence: cmp.level === "exact" ? 0.5 : 0.3,
      evidence: { method: "identity-compare/v1", level: cmp.level, aliasPairs: cmp.aliasPairs, names: [a.name, b.name] },
      ambiguity: cmp.level === "exact" ? ["identical by stated words; the products may still differ in something neither name states"] : ["equal only if a short form means the longer word; unreliable on its own"],
    };
  }
  // line: one is narrower than the other
  const narrower = cmp.moreSpecific === "a" ? a : b;
  const base = cmp.moreSpecific === "a" ? b : a;
  const extras = cmp.moreSpecific === "a" ? cmp.onlyInA : cmp.onlyInB;
  const role = referenceRole(narrower.name, base.name);
  if (role) {
    return {
      fromProductId: narrower.id,
      toProductId: base.id,
      relation: "references",
      role,
      confidence: 0.6,
      evidence: { method: "identity-compare/v1", extras, names: [narrower.name, base.name] },
      ambiguity: ["the first names the second as what it goes with or runs on; it is not the second product", "it could be an accessory, a component, a game or software, or a bundle that includes it"],
    };
  }
  return {
    fromProductId: narrower.id,
    toProductId: base.id,
    relation: "narrower-than",
    role: null,
    confidence: 0.5,
    evidence: { method: "identity-compare/v1", extras, names: [narrower.name, base.name] },
    ambiguity: ["the first states more than the second", "it could be a more specific version of it, or an accessory, component or bundle related to it: not decided"],
  };
}

/** Short forms found in titles filed under a product ("ps5" under "PlayStation 5 Slim"): candidate aliases, never confirmed here. */
export function aliasCandidatesFor(args: { name: string; titles: string[]; isCovered: (code: string, name: string) => boolean }): Array<{ alias: string; support: number; examples: string[] }> {
  const found = new Map<string, { support: number; examples: string[] }>();
  for (const t of args.titles) {
    for (const c of definingCodes(t)) {
      if (!args.isCovered(c, args.name)) continue;
      const row = found.get(c) ?? { support: 0, examples: [] };
      row.support++;
      if (row.examples.length < 3) row.examples.push(t);
      found.set(c, row);
    }
  }
  return [...found].map(([alias, v]) => ({ alias, ...v }));
}
