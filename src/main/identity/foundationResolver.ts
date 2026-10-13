// The foundation-based resolver, SHADOW MODE ONLY: nothing in the app calls it. It answers two questions from evidence and says explicitly how sure it is:
//   compareProducts(a, b)     are these two Database entries the same product, a different one, a related one, or can't we tell?
//   resolveListing(title)     which entry does this listing belong to, is it a variant or a new model of one, or is the match uncertain?
// Verdicts:
//   confirmed   the same product, with the evidence that makes it so (every stated word, code and capacity agrees, or a short form is backed by independent documents)
//   different   a different product (a code, number, size or capacity disagrees, or each side states something the other does not)
//   related     not the same, but connected: goes-with (one names the other as what it is for or runs on), bundle, edition, variant (narrower by a code or size),
//               family (a family-level entry and one of its members)
//   uncertain   cannot be told from what is written and what the data shows; says what is missing and which way the evidence leans. Never treated as a match,
//               never silently treated as a mismatch
// Nothing here knows a product category. It reads structure (brackets, "for", "with", codes, numbers, capacities) and counts evidence in the data it is given.
// It deliberately does NOT confirm a match because extra words are common: "pro" is as common beside a base name as "microsoft" is, and one is a different product.
import { aliasCovered, definingCodes } from "./codes.js";
import { assessCodes, CodeIndex, type CodeAssessment, type EvidenceDoc } from "./credibility.js";
import { identityTokens, looksLikeAbbreviation } from "./resolver.js";
import { NOISE_WORDS } from "./words.js";

export type Verdict = "confirmed" | "different" | "related" | "uncertain";
export type Relation = "goes-with" | "bundle" | "edition" | "variant" | "family" | "family-sibling" | "alias";
export type Sureness = "high" | "medium" | "low";

export interface ProductVerdict {
  verdict: Verdict;
  relation: Relation | null;
  // Which side is the more specific one (related / uncertain).
  moreSpecific: "a" | "b" | null;
  // For "uncertain": which way the evidence leans, if at all.
  lean: "same" | "different" | null;
  sureness: Sureness;
  reasons: string[];
  // What is not known: uncertainty is listed, never hidden.
  unresolved: string[];
}

export interface NameInfo {
  id: string;
  name: string;
  subject: string;
  words: Set<string>;
  capacities: Set<string>;
  codes: string[];
  // The product this one is FOR / runs on, as written in brackets or after "for"; null when there is none.
  host: { text: string; words: Set<string>; kind: "bracket" | "connector" } | null;
  // What a bracket turned out to be when it is not a host.
  bracket: "qualifier" | "alternate-name" | "edition-theme" | null;
  includes: Set<string> | null; // words after "with" / "includes" / "plus": what a bundle adds
  // The words inside a bracket whatever it turned out to be (a platform, a colour, an edition), and the name's words without them.
  bracketWords: Set<string> | null;
  core: Set<string>;
  generic: boolean; // a family-level entry
  fanOut: number;
}

export interface ResolverContext {
  info(id: string): NameInfo | undefined;
  infos(): NameInfo[];
  codeIndex: CodeIndex;
  // Share of all documents (names, listing titles, photo titles) that contain the word.
  docFrequency(word: string): number;
  // How often a word accompanies the given base words, and in how many documents (evidence only; never confirms by itself).
  companion(baseWords: Set<string>, word: string): { rate: number; support: number };
  // Independent sources using a short form together with the rest of a product's words.
  shortFormSupport(short: string, otherWords: Set<string>): number;
  // In how many OTHER places the Database itself keeps "X" and "X + word" as separate entries: a word that splits entries elsewhere is a variant word here too.
  variantEvidence(word: string): number;
  // In how many entries the word appears (a word shared by many products is a maker or a kind, not something that identifies one of them).
  entryCount(word: string): number;
}

const EDITION_NOUN = /\b(edition|bundle|version|kit|collection|set|pack)\s*[-–—]?\s*$/i;
const CONNECTOR = /\b(for|compatible with|compatible for|fits?|designed for|made for)\s+(.+)$/i;
// "w/" and a spaced "+" mean "with"; "15+" is part of a name
const INCLUDES = /(\bwith\s+|\bincludes?\s+|\bincluding\s+|\bplus\s+|\bw\/\s*|\s\+\s*)(.+)$/i;
// how many places in the data must keep "X" and "X + word" as separate entries (counting the pair being judged) for the word to count as one that separates products
const VARIANT_MIN = 2;
// ...and from this many it is firmly a variant word ("pro" splits entries in many places); fewer is only a lean
const VARIANT_STRONG = 4;
const INCLUDES_NO_PLUS = /(\bwith\s+|\bincludes?\s+|\bincluding\s+|\bw\/\s*|\s\+\s*)(.+)$/i;
const BRACKET_INCLUDES =/^\s*(with|includes?|including|plus)\b/i;

const info = (words: Iterable<string>) => new Set([...words].filter((w) => !NOISE_WORDS.has(w)));
const subset = (small: Set<string>, big: Set<string>) => small.size > 0 && [...small].every((w) => big.has(w));
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((w) => !b.has(w));
const isNumberWord = (w: string) => /^\d+$/.test(w);
const template = (code: string) => code.replace(/\d+/g, "#");
const parts = (code: string) => code.split(/(?<=\D)(?=\d)|(?<=\d)(?=\D)/).filter(Boolean);

/** Builds the resolver's view of every entry from the names, plus the documents that show how words behave. */
export function buildContext(entries: Array<{ id: string; name: string }>, extraDocs: EvidenceDoc[] = []): ResolverContext {
  const docs: EvidenceDoc[] = [...entries.map((e) => ({ text: e.name, origin: `product:${e.id}`, kind: "product" as const })), ...extraDocs];
  const docWords = docs.map((d) => identityTokens(d.text).words);
  const posting = new Map<string, number[]>();
  docWords.forEach((ws, i) => {
    for (const w of ws) (posting.get(w) ?? posting.set(w, []).get(w)!).push(i);
  });
  const codeIndex = new CodeIndex(docs);

  const raw = entries.map((e) => {
    const text = e.name;
    const br = /[(\[]([^)\]]+)[)\]]/.exec(text);
    let subjectText = br ? (text.slice(0, br.index) + " " + text.slice(br.index + br[0].length)).replace(/\s+/g, " ").trim() : text;
    const before = br ? text.slice(0, br.index) : "";
    let connectorHost: string | null = null;
    const c = CONNECTOR.exec(subjectText);
    if (c) {
      connectorHost = c[2];
      subjectText = subjectText.slice(0, c.index).trim() || subjectText;
    }
    let includesText: string | null = null;
    const inc = INCLUDES.exec(subjectText);
    if (inc) {
      includesText = inc[2];
      subjectText = subjectText.slice(0, inc.index).trim() || subjectText;
    }
    if (br && BRACKET_INCLUDES.test(br[1])) includesText = (includesText ? includesText + " " : "") + br[1].replace(BRACKET_INCLUDES, "");
    return { e, subjectText, bracketText: br && !BRACKET_INCLUDES.test(br[1]) ? br[1] : null, editionBefore: br ? EDITION_NOUN.test(before.trim()) : false, connectorHost, includesText };
  });

  const subjWords = new Map<string, Set<string>>();
  const byToken = new Map<string, string[]>();
  for (const r of raw) {
    const ws = info(identityTokens(r.subjectText).words);
    subjWords.set(r.e.id, ws);
    for (const w of ws) (byToken.get(w) ?? byToken.set(w, []).get(w)!).push(r.e.id);
  }
  const knownProductIn = (ws: Set<string>, selfId: string): boolean => {
    const seen = new Set<string>();
    for (const w of ws) for (const id of byToken.get(w) ?? []) {
      if (id === selfId || seen.has(id)) continue;
      seen.add(id);
      if (subset(subjWords.get(id)!, ws)) return true;
    }
    return false;
  };

  const map = new Map<string, NameInfo>();
  for (const r of raw) {
    const t = identityTokens(r.subjectText);
    const words = info(t.words);
    let host: NameInfo["host"] = null;
    let bracket: NameInfo["bracket"] = null;
    const core = new Set(words);
    let bracketWords: Set<string> | null = null;
    if (r.bracketText) {
      bracketWords = info(identityTokens(r.bracketText).words);
      const bw = info(identityTokens(r.bracketText).words);
      // A bracket is only another way of writing the same name when EVERY word in it is already in the name (exactly, or as a short form of one) and at least
      // half are exact. One extra word ("(Nintendo Switch 2)" after "Nintendo Switch") or one that is not in the name ("(For Parts / Broken)") makes it new information.
      const exact = [...bw].filter((w) => words.has(w)).length;
      const shortForm = [...bw].filter((w) => !words.has(w) && [...words].some((x) => looksLikeAbbreviation(w, x) || looksLikeAbbreviation(x, w))).length;
      if (bw.size > 0 && exact + shortForm === bw.size && exact * 2 >= bw.size) bracket = "alternate-name";
      // a bracket that repeats every word of the name and adds some ("Nintendo Switch (Nintendo Switch 2)") is the same product written out in full, not
      // something the product is for: the name is then as specific as the longer form
      else if (words.size > 0 && [...words].every((w) => bw.has(w)) && bw.size > words.size) {
        bracket = "alternate-name";
        for (const w of bw) words.add(w);
      } else if (r.editionBefore) bracket = "edition-theme";
      else if (knownProductIn(bw, r.e.id)) host = { text: r.bracketText, words: bw, kind: "bracket" };
      else bracket = "qualifier";
      if (bracket === "qualifier") for (const w of bw) words.add(w); // "(Black)" is part of what the name states
    }
    if (r.connectorHost && !host) host = { text: r.connectorHost, words: info(identityTokens(r.connectorHost).words), kind: "connector" };
    map.set(r.e.id, {
      id: r.e.id, name: r.e.name, subject: r.subjectText, words, capacities: new Set(t.capacities), codes: definingCodes(r.subjectText),
      host, bracket, includes: r.includesText ? info(identityTokens(r.includesText).words) : null, bracketWords, core, generic: false, fanOut: 0,
    });
  }
  for (const n of map.values()) {
    let fan = 0;
    if (n.words.size > 0) {
      const lists = [...n.words].map((w) => byToken.get(w) ?? []).sort((a, b) => a.length - b.length);
      for (const id of lists[0]) if (id !== n.id && subset(n.words, subjWords.get(id)!)) fan++;
    }
    n.fanOut = fan;
    const noMarker = n.codes.length === 0 && n.capacities.size === 0 && ![...n.words].some(isNumberWord);
    // a family-level entry is a name many other entries extend; a lone word that few entries extend (a game's one-word title) is a product, not a family
    n.generic = noMarker && (fan >= 6 || (n.words.size <= 1 && fan >= 2));
  }

  const byWords = new Map<string, string>();
  for (const n of map.values()) if (n.words.size > 0) byWords.set([...n.words].sort().join(" "), n.id);
  const splitBases = new Map<string, Set<string>>();
  for (const n of map.values()) {
    if (n.words.size < 2) continue;
    for (const w of n.words) {
      const key = [...n.words].filter((x) => x !== w).sort().join(" ");
      const other = byWords.get(key);
      if (other && other !== n.id) (splitBases.get(w) ?? splitBases.set(w, new Set()).get(w)!).add(key);
    }
  }
  const variantEvidence: ResolverContext["variantEvidence"] = (word) => splitBases.get(word)?.size ?? 0;

  const companion: ResolverContext["companion"] = (base, word) => {
    const lists = [...base].map((w) => posting.get(w) ?? []);
    if (lists.length === 0 || lists.some((l) => l.length === 0)) return { rate: 0, support: 0 };
    lists.sort((a, b) => a.length - b.length);
    let hits = 0;
    let total = 0;
    for (const i of lists[0]) {
      if (!lists.every((l) => l === lists[0] || binaryHas(l, i))) continue;
      total++;
      if (docWords[i].has(word)) hits++;
    }
    return { rate: total ? hits / total : 0, support: hits };
  };
  const shortFormSupport: ResolverContext["shortFormSupport"] = (short, others) => {
    const base = [...others].filter((w) => w !== short);
    const origins = new Set<string>();
    for (const i of posting.get(short) ?? []) if (base.every((w) => docWords[i].has(w))) origins.add(docs[i].origin);
    return origins.size;
  };
  return {
    info: (id) => map.get(id), infos: () => [...map.values()], codeIndex,
    docFrequency: (w) => (posting.get(w)?.length ?? 0) / Math.max(1, docs.length),
    companion, shortFormSupport, variantEvidence, entryCount: (w) => byToken.get(w)?.length ?? 0,
  };
}

function binaryHas(sorted: number[], x: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === x) return true;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function mk(verdict: Verdict, relation: Relation | null, sureness: Sureness, reasons: string[], opts: { unresolved?: string[]; moreSpecific?: "a" | "b" | null; lean?: "same" | "different" | null } = {}): ProductVerdict {
  return { verdict, relation, moreSpecific: opts.moreSpecific ?? null, lean: opts.lean ?? null, sureness, reasons, unresolved: opts.unresolved ?? [] };
}

/** Short forms ("ps" for "playstation") that account for part of the difference, given at least one other word both names share to anchor them. */
function pairShortForms(onlyA: string[], onlyB: string[], shared: number): { pairs: Array<[string, string]>; restA: string[]; restB: string[] } {
  const restA = [...onlyA];
  const restB = [...onlyB];
  const pairs: Array<[string, string]> = [];
  if (shared < 1) return { pairs, restA, restB };
  for (const x of [...restA]) {
    const j = restB.findIndex((y) => looksLikeAbbreviation(x, y) || looksLikeAbbreviation(y, x));
    if (j >= 0) {
      pairs.push([x, restB[j]]);
      restA.splice(restA.indexOf(x), 1);
      restB.splice(j, 1);
    }
  }
  return { pairs, restA, restB };
}

/** Are these two Database entries the same product? */
export function compareProducts(a: NameInfo, b: NameInfo, ctx: ResolverContext): ProductVerdict {
  // 1. one names the other as what it goes with: the first is NOT the second
  for (const [x, y, side] of [[a, b, "a"], [b, a, "b"]] as const) {
    if (x.host && y.words.size > 0 && subset(y.words, x.host.words) && !subset(y.words, x.words)) {
      return mk("related", "goes-with", "high", [`"${x.name}" names "${y.name}" as what it is for or runs on; it is not that product`], { moreSpecific: side, unresolved: ["whether it is an accessory, a part, software or a compatible product depends on the category"] });
    }
  }
  if (a.host && b.host) {
    const sameHost = a.host.words.size === b.host.words.size && [...a.host.words].every((w) => b.host!.words.has(w));
    if (!sameHost) {
      const subjSame = minus(a.words, b.words).length === 0 && minus(b.words, a.words).length === 0;
      return mk("different", subjSame ? "variant" : null, "high", [subjSame ? `the same title for different hosts (${a.host.text} / ${b.host.text})` : "they are for different things"]);
    }
  } else if ((a.host || b.host) && minus(a.words, b.words).length === 0 && minus(b.words, a.words).length === 0) {
    return mk("uncertain", null, "low", ["one is written as being for something and the other is not"], { unresolved: ["whether the host is part of the product's identity"] });
  }

  // the same core with different bracketed content (a platform, a colour, an edition) is a different product
  if (a.bracketWords && b.bracketWords) {
    const sameCore = minus(a.core, b.core).length === 0 && minus(b.core, a.core).length === 0;
    const sameBr = a.bracketWords.size === b.bracketWords.size && [...a.bracketWords].every((w) => b.bracketWords!.has(w));
    if (sameCore && !sameBr) return mk("different", "variant", "high", [`the same name with different bracketed content (${[...a.bracketWords].join(" ")} / ${[...b.bracketWords].join(" ")})`]);
  }
  // one is the other plus what it comes with
  if (!!a.includes !== !!b.includes && minus(a.words, b.words).length === 0 && minus(b.words, a.words).length === 0) {
    const side: "a" | "b" = a.includes ? "a" : "b";
    const bundle = side === "a" ? a : b;
    return mk("related", "bundle", "high", [`"${bundle.name}" is the other product plus: ${[...bundle.includes!].join(" ")}`], { moreSpecific: side, unresolved: ["whether a bundle is priced as the product alone"] });
  }

  let onlyA = minus(a.words, b.words);
  let onlyB = minus(b.words, a.words);
  const capA = [...a.capacities];
  const capB = [...b.capacities];
  if (capA.length > 0 && capB.length > 0 && !capA.some((c) => b.capacities.has(c))) return mk("different", null, "high", [`capacity differs (${capA.join("/")} vs ${capB.join("/")})`]);
  const capOne: "a" | "b" | null = capA.length && !capB.length ? "a" : capB.length && !capA.length ? "b" : null;

  // 2. short forms that stand for the same word, anchored by shared words
  const shared = [...a.words].filter((w) => b.words.has(w)).length;
  // a letters-only word that already separates entries elsewhere ("pro", "max") is a word in its own right, never the short form of another
  const standalone = (w: string) => !/\d/.test(w) && ctx.variantEvidence(w) >= VARIANT_MIN;
  const sf = pairShortForms(onlyA.filter((w) => !standalone(w)), onlyB.filter((w) => !standalone(w)), shared);
  sf.restA.push(...onlyA.filter(standalone));
  sf.restB.push(...onlyB.filter(standalone));
  let aliasNote: string | null = null;
  let aliasWeak = false;
  if (sf.pairs.length > 0) {
    const everything = new Set([...a.words, ...b.words]);
    const support = sf.pairs.reduce((m, [x, y]) => Math.max(m, ctx.shortFormSupport(x.length <= y.length ? x : y, new Set([...everything].filter((w) => w !== x && w !== y)))), 0);
    // a short form no other document uses this way, anchored by a single shared word, is a coincidence of letters ("se" in "sierra")
    if (support >= 2 || shared >= 2) {
      aliasNote = `"${sf.pairs[0][0]}" and "${sf.pairs[0][1]}" ${support >= 2 ? `are used for the same product in ${support} independent documents` : "may be short forms of each other"}`;
      aliasWeak = support < 2;
      onlyA = sf.restA;
      onlyB = sf.restB;
    }
  }

  if (onlyA.length === 0 && onlyB.length === 0) {
    if (capOne) return mk("related", "variant", "high", [`one states a capacity (${capOne === "a" ? capA[0] : capB[0]}) the other does not`], { moreSpecific: capOne, unresolved: ["whether the other is that capacity"] });
    if (aliasNote) return aliasWeak ? mk("uncertain", "alias", "low", [aliasNote], { lean: "same", unresolved: ["no independent document uses both forms for the same product"] }) : mk("confirmed", "alias", "medium", [aliasNote]);
    return mk("confirmed", null, "high", ["every stated word, code and capacity agrees"]);
  }
  // 3. each states something the other does not
  if (onlyA.length > 0 && onlyB.length > 0) {
    const small = Math.max(onlyA.length, onlyB.length) <= 2 && shared >= 2;
    return mk("different", small ? "family-sibling" : null, "high", [`each states something the other does not (${onlyA.join(" ")} | ${onlyB.join(" ")})`]);
  }
  // 4. one is narrower than the other
  const [narrow, broad, side] = onlyA.length > 0 ? ([a, b, "a"] as const) : ([b, a, "b"] as const);
  const extras = onlyA.length > 0 ? onlyA : onlyB;
  if (narrow.includes && narrow.includes.size > 0) {
    return mk("related", "bundle", "high", [`"${narrow.name}" is "${broad.name}" plus: ${[...narrow.includes].join(" ")}`], { moreSpecific: side, unresolved: ["whether a bundle is priced as the product alone"] });
  }
  if (broad.generic) return mk("related", "family", "high", [`"${broad.name}" is a family-level entry (${broad.words.size <= 1 ? "one word" : "contained in " + broad.fanOut + " other entries"}); "${narrow.name}" is a member, not the same product`], { moreSpecific: side });
  if (narrow.bracket === "edition-theme") return mk("related", "edition", "medium", [`"${narrow.name}" is an edition themed after something in brackets`], { moreSpecific: side });
  if (extras.some((w) => /\d/.test(w)) || capOne === side) {
    return mk("related", "variant", "high", [`"${narrow.name}" also states ${[...extras.filter((w) => /\d/.test(w)), ...(capOne === side ? [side === "a" ? capA[0] : capB[0]] : [])].join(", ")}`], { moreSpecific: side, unresolved: ["whether that is a different product or a different way of writing it"] });
  }
  // a single letter after a model ("S", "X", "e") or a word that already separates entries in several other places (the data keeps "X" and "X + word" apart)
  // Only words that come AFTER the shared name count ("13 Pro", "3DS XL"): a word in front ("Apple", "New", "Handmade") is as often a maker or a descriptor of the
  // same product, and the data keeping both spellings as separate entries is exactly what duplicates look like.
  const order = [...narrow.words];
  const lastShared = order.reduce((m, w, i) => (broad.words.has(w) ? i : m), -1);
  const trailing = extras.every((w) => order.indexOf(w) > lastShared);
  if (trailing && extras.every((w) => w.length === 1 || ctx.variantEvidence(w) >= VARIANT_MIN)) {
    const why = extras.map((w) => (w.length === 1 ? `"${w}" is a single-letter model marker` : `"${w}" separates entries in ${ctx.variantEvidence(w)} other places in the data`));
    const strong = extras.every((w) => w.length === 1 || ctx.variantEvidence(w) >= VARIANT_STRONG);
    const reasonText = `"${narrow.name}" also states ${extras.join(" ")}: ${why.join("; ")}${aliasNote ? "; " + aliasNote : ""}`;
    if (strong) return mk("related", "variant", "medium", [reasonText], { moreSpecific: side, unresolved: ["whether the data's own split holds for this pair"] });
    return mk("uncertain", null, "low", [reasonText], { moreSpecific: side, lean: "different", unresolved: [`"${extras.join(" ")}" separates entries in only ${Math.min(...extras.map((w) => ctx.variantEvidence(w)))} places in the data`] });
  }
  // plain extra words only: never confirmed on how common they are; the evidence only says which way it leans
  const leading = (() => {
    const first = [...narrow.words][0];
    return extras.length === 1 && first === extras[0]; // a single word put in front of the base name ("Microsoft Xbox ...")
  })();
  const comp = extras.map((w) => ctx.companion(broad.words, w));
  const habitual = comp.every((c) => c.support >= 3 && c.rate >= 0.5);
  const reasons = [`"${narrow.name}" also states ${extras.join(" ")}${aliasNote ? "; " + aliasNote : ""}`];
  if (habitual && leading) reasons.push(`"${extras[0]}" accompanies "${broad.name}" in ${Math.round(comp[0].rate * 100)}% of ${comp[0].support >= 3 ? "its" : ""} documents, which is what a maker or descriptor does, but a variant word does the same`);
  return mk("uncertain", null, habitual && leading ? "medium" : "low", reasons, {
    moreSpecific: side, lean: habitual && leading ? "same" : null,
    unresolved: [`nothing shows whether "${extras.join(" ")}" changes the product (an accessory, part, edition, variant or just wording)`],
  });
}

// ---------- listings

export interface ListingResolution {
  verdict: Verdict;
  relation: Relation | null;
  product: { id: string; name: string } | null;
  sureness: Sureness;
  reasons: string[];
  unresolved: string[];
  // A genuine new model: the title states a marker no entry has, and the nearest family is named. Never folded into a generic entry.
  newModel: { family: string | null; codes: string[]; note: string } | null;
  alsoMentions: Array<{ id: string; name: string; as: "bundle" | "mention" }>;
  alternatives: Array<{ id: string; name: string }>;
  codes: CodeAssessment | null;
}

export function resolveListing(title: string, candidates: Array<{ id: string; name: string }>, ctx: ResolverContext, opts: { independentTexts?: string[]; seller?: string | null } = {}): ListingResolution {
  const blank = (verdict: Verdict, reasons: string[], unresolved: string[], extra: Partial<ListingResolution> = {}): ListingResolution => ({
    verdict, relation: null, product: null, sureness: "low", reasons, unresolved, newModel: null, alsoMentions: [], alternatives: [], codes: null, ...extra,
  });
  // split the title into what it IS (before "for X" / "with Y" / a bracket) and what it merely goes with or includes
  const br = /[(\[]([^)\]]+)[)\]]/.exec(title);
  let main = br ? (title.slice(0, br.index) + " " + title.slice(br.index + br[0].length)).trim() : title;
  let hostText: string | null = br ? br[1] : null;
  const conn = CONNECTOR.exec(main);
  if (conn) {
    hostText = hostText ?? conn[2];
    main = main.slice(0, conn.index).trim() || main;
  }
  let includeText: string | null = null;
  // "plus" is also part of a name ("... 16 Plus"): when an entry has the word and the title states all of that entry's words, it is a name word, not "and also"
  const titleWords = info(identityTokens(title).words);
  const plusIsName = /\bplus\b/i.test(title) && candidates.some((c) => {
    const e = ctx.info(c.id);
    return !!e && e.words.has("plus") && subset(e.words, titleWords);
  });
  const inc = (plusIsName ? INCLUDES_NO_PLUS : INCLUDES).exec(main);
  if (inc) {
    includeText = inc[2];
    main = main.slice(0, inc.index).trim() || main;
  }
  const mainTok = identityTokens(main);
  const mw = info(mainTok.words);
  // what the title says about the item itself: the first phrase, before a second item ("... and a controller", "& Portal") or a dash; pieces of a model-like code are not words
  const firstPhrase = main.split(/\s(?:and|&)\s|,|\s[-–—]\s/i)[0];
  const codePieces0 = new Set(definingCodes(title).flatMap(parts));
  const primary = info(identityTokens(firstPhrase).words);
  for (const w of codePieces0) primary.delete(w);
  const hostW = hostText ? info(identityTokens(hostText).words) : new Set<string>();
  const inclW = includeText ? info(identityTokens(includeText).words) : new Set<string>();
  const fullTok = identityTokens(title);
  const fullW = info(fullTok.words);

  // an entry's model code ("2DS", "SL5") must appear in the title as that code: its digits and letters turning up in separate words ("Black 2 ... DS") is not it
  const titleCodes = new Set(definingCodes(title));
  type Fit = { e: NameInfo; covered: number };
  const fitIn = (words: Set<string>, caps: Set<string>, hostWords: Set<string>): { fits: Fit[]; partial: Array<{ e: NameInfo; missing: string[]; shared: number }> } => {
    const fits: Fit[] = [];
    const partial: Array<{ e: NameInfo; missing: string[]; shared: number }> = [];
    for (const c of candidates) {
      const e = ctx.info(c.id);
      if (!e) continue;
      const missing = [...e.words].filter((w) => !words.has(w));
      const capsOk = e.capacities.size === 0 || [...e.capacities].some((x) => caps.has(x));
      const hostOk = !e.host || [...e.host.words].every((w) => hostWords.has(w) || words.has(w));
      const sharedN = e.words.size - missing.length;
      const codesOk = e.codes.every((c) => titleCodes.has(c));
      // an entry that is a bundle ("... (includes a controller)") only fits a title that states what it includes
      const inclOk = !e.includes || [...e.includes].every((w) => fullW.has(w));
      if (missing.length === 0 && capsOk && hostOk && codesOk && inclOk) fits.push({ e, covered: e.words.size + e.capacities.size + (e.host ? e.host.words.size : 0) });
      else if (sharedN >= 1 && missing.length <= 3) partial.push({ e, missing, shared: sharedN });
    }
    return { fits, partial };
  };

  let { fits, partial } = fitIn(mw, mainTok.capacities, hostW);
  // a title that is FOR something names that something only as its host
  if (hostText && fits.length === 0) {
    const inHost = fitIn(new Set([...hostW]), fullTok.capacities, new Set());
    const hostFit = inHost.fits.filter((f) => !f.e.generic).sort((x, y) => y.covered - x.covered)[0];
    if (hostFit) {
      return blank("related", [`the title names "${hostFit.e.name}" only as what it is for or runs on; the listing is not that product`], ["no entry for the item itself (an accessory, part, software or compatible product)"], {
        relation: "goes-with", product: { id: hostFit.e.id, name: hostFit.e.name }, sureness: "high", newModel: { family: hostFit.e.name, codes: [], note: "the item itself has no entry" },
      });
    }
  }
  // the title's own first words (before any "with ...") may not name an entry; then the whole title is used
  if (fits.length === 0 && includeText) ({ fits, partial } = fitIn(fullW, fullTok.capacities, hostW));

  // No entry fits outright. Titles often leave out a maker word the entry carries ("3ds xl" for "Nintendo 3DS XL"). Exactly ONE word may be missing, and only when the
  // title keeps two or more of the entry's words including a number, a single letter or a model code, the missing word is plain (no number, letter or code piece), and
  // the Database does not use it to tell entries apart (fewer than 3 "X" / "X + word" pairs) and it appears in at least 5 entries (a maker or a kind, not a feature of one product).
  const omitted = new Map<string, string>();
  if (fits.length === 0) {
    for (const c of candidates) {
      const e = ctx.info(c.id);
      if (!e) continue;
      const missing = [...e.words].filter((w) => !mw.has(w));
      if (missing.length !== 1) continue;
      const m = missing[0];
      const sharedN = e.words.size - 1;
      const keepsMarker = [...e.words].some((w) => w !== m && (isNumberWord(w) || w.length === 1 || e.codes.some((cc) => parts(cc).includes(w))));
      const capsOk = e.capacities.size === 0 || [...e.capacities].some((x) => mainTok.capacities.has(x));
      const hostOk = !e.host || [...e.host.words].every((w) => hostW.has(w) || mw.has(w));
      if (sharedN < 2 || !keepsMarker || isNumberWord(m) || m.length <= 1 || ctx.variantEvidence(m) >= VARIANT_MIN || ctx.entryCount(m) < 5 || !capsOk || !hostOk || !e.codes.every((cc) => titleCodes.has(cc))) continue;
      fits.push({ e, covered: sharedN + e.capacities.size + (e.host ? e.host.words.size : 0) });
      omitted.set(e.id, m);
    }
  }

  if (fits.length === 0) {
    const tcodes = definingCodes(title);
    const sibling = partial
      .map((p) => {
        const entryParts = new Set(p.e.codes.flatMap(parts));
        const residual = [...p.e.words].filter((w) => !entryParts.has(w));
        const residualOk = residual.every((w) => fullW.has(w));
        const sameTemplate = p.e.codes.some((c) => tcodes.some((tc) => tc !== c && template(tc) === template(c)));
        const numberSwap = p.missing.some(isNumberWord) && [...fullW].some((w) => isNumberWord(w) && !p.e.words.has(w));
        return { p, residualOk, sameTemplate, numberSwap };
      })
      .filter((s) => s.residualOk && (s.sameTemplate || s.numberSwap))
      .sort((x, y) => y.p.shared - x.p.shared)[0];
    if (sibling) {
      return blank("uncertain", [`no entry states everything in the title; "${sibling.p.e.name}" is the nearest family`], ["no entry for this exact model"], {
        newModel: { family: sibling.p.e.name, codes: tcodes.filter((c) => !sibling.p.e.codes.includes(c)), note: "the title's marker follows the pattern of this family's markers but is a different value: a new model of the family" },
        alternatives: partial.slice(0, 3).map((p) => ({ id: p.e.id, name: p.e.name })),
      });
    }
    return blank("uncertain", ["no Database entry states what this title states"], ["unknown product: no entry and no family"], { alternatives: partial.slice(0, 3).map((p) => ({ id: p.e.id, name: p.e.name })) });
  }

  // Which entry explains the title best: first by the defining words (numbers, single letters) the title states that the entry leaves unexplained,
  // then by how much of the entry the title covers, then specific before family-level, then by how few other words are left over.
  const defining = (w: string) => isNumberWord(w) || w.length === 1;
  const rank = (f: Fit) => {
    const left = [...mw].filter((w) => !f.e.words.has(w) && !(f.e.host && f.e.host.words.has(w)));
    // a capacity the title states and the entry states too is a defining match; an entry with no capacity cannot claim it
    const capMatch = f.e.capacities.size > 0 && [...f.e.capacities].some((x) => mainTok.capacities.has(x)) ? 1 : 0;
    return { leftDefining: left.filter(defining).length, left: left.length, capMatch };
  };
  const ranked = fits.map((f) => ({ f, ...rank(f) }));
  ranked.sort((x, y) => x.leftDefining - y.leftDefining || y.capMatch - x.capMatch || y.f.covered - x.f.covered || Number(x.f.e.generic) - Number(y.f.e.generic) || x.left - y.left);
  fits = ranked.map((r) => r.f);
  const best = fits[0];
  const bestRank = ranked[0];
  // entries that explain the title exactly as well, whatever their kind: the title could be either
  const tie = ranked.filter((r) => r.leftDefining === bestRank.leftDefining && r.capMatch === bestRank.capMatch && r.f.covered === bestRank.f.covered && r.left === bestRank.left).map((r) => r.f);
  if (omitted.size > 1) {
    // several entries fit only if a plain word is left out. The most specific wins unless what sets it apart is ordinary listing wording ("new" in "New condition 3DS XL").
    const ambiguous = fits.slice(1).some((f) => minus(best.e.words, f.e.words).some((w) => ctx.docFrequency(w) >= 0.04));
    if (ambiguous || tie.length > 1) {
      return blank("uncertain", [`${omitted.size} entries fit if a plain word is left out of the title`], ["which of them (the title leaves out a word, and what separates the entries is also ordinary listing wording)"], { alternatives: fits.slice(0, 4).map((f) => ({ id: f.e.id, name: f.e.name })) });
    }
  }
  const assessment = assessCodes({ entryId: best.e.id, entryName: best.e.name, title, index: ctx.codeIndex, independentTexts: opts.independentTexts, seller: opts.seller });
  const product = { id: best.e.id, name: best.e.name };
  const alternatives = fits.slice(1, 4).map((f) => ({ id: f.e.id, name: f.e.name }));

  const alsoMentions: ListingResolution["alsoMentions"] = [];
  const others = candidates
    .map((c) => ctx.info(c.id))
    .filter((e): e is NameInfo => !!e && e.id !== best.e.id && !e.generic && e.words.size > 0 && subset(e.words, fullW) && !subset(e.words, best.e.words));
  const rivals: string[] = [];
  for (const e of others) {
    const distinguishing = new Set(minus(e.words, best.e.words));
    const asBundle = subset(distinguishing, inclW);
    alsoMentions.push({ id: e.id, name: e.name, as: asBundle ? "bundle" : "mention" });
    // another whole product, not offered as part of a bundle, named beside this one: the title is about more than one thing
    const platform = new Set([...hostW, ...(best.e.host ? best.e.host.words : []), ...(best.e.bracketWords ?? [])]);
    if (!asBundle && !subset(distinguishing, platform) && (distinguishing.size >= 2 || [...distinguishing].some(defining))) rivals.push(e.name);
  }

  const base = { product, alsoMentions, alternatives, codes: assessment, newModel: null as ListingResolution["newModel"] };
  // a sibling entry whose marker follows the same pattern as one in the title but differs ("SL5" in the Database, "SL6" in the title): a new model of that family
  const tcodes = definingCodes(title).filter((c) => !best.e.codes.includes(c));
  const patternSibling = tcodes.length
    ? candidates
        .map((c) => ctx.info(c.id))
        .find((e): e is NameInfo => !!e && e.id !== best.e.id && e.codes.some((c) => !definingCodes(title).includes(c) && tcodes.some((tc) => tc !== c && template(tc) === template(c))) && subset(info([...e.words].filter((w) => !new Set(e.codes.flatMap(parts)).has(w))), fullW))
    : undefined;
  // words the title states that the entry does not, and that are not ordinary listing vocabulary: a possible variant with no entry
  // when a word is missing the whole title is judged (a second item after "&" could be what the listing really is); otherwise only the item's own phrase
  const rareExtras = [...(omitted.has(best.e.id) ? mw : primary)].filter((w) => !best.e.words.has(w) && !isNumberWord(w) && ctx.docFrequency(w) < 0.02 && !definingCodes(w).length);
  const unvCodes = assessment.unverified.map((u) => u.code);
  if (tie.length > 1) {
    return { verdict: "uncertain", relation: null, sureness: "low", reasons: [`${tie.length} entries fit equally well`], unresolved: ["which of them"], ...base, product: null, alternatives: tie.map((f) => ({ id: f.e.id, name: f.e.name })) };
  }
  if (rivals.length) {
    return { verdict: "uncertain", relation: null, sureness: "low", reasons: [`the title names "${best.e.name}" and also ${rivals.slice(0, 3).map((r) => `"${r}"`).join(", ")}, which are different products`], unresolved: ["which of the products named is the item being sold"], ...base, product: null, alternatives: [product, ...alsoMentions.filter((m) => m.as === "mention").map((m) => ({ id: m.id, name: m.name }))].slice(0, 4) };
  }
  if (best.e.generic) {
    const extras = [...primary].filter((w) => !best.e.words.has(w));
    if (extras.length === 0) {
      return { verdict: "confirmed", relation: null, sureness: "medium", reasons: [`the title states what the family-level entry "${best.e.name}" states and nothing more`], unresolved: ["the title does not say which variant; the entry is the right place, but it is not a specific variant"], ...base };
    }
    const small = best.e.words.size / Math.max(1, mw.size) < 0.34;
    // wording that changes nothing (a maker, "console", "bundle"): no number or letter marker, nothing rare, no code the data backs. The entry is still the right place.
    const marker = extras.some(defining) || assessment.credible.length > 0 || rareExtras.length > 0;
    if (!marker && !small) {
      return { verdict: "confirmed", relation: null, sureness: "medium", reasons: [`the title states what the family-level entry "${best.e.name}" states, plus only ordinary listing wording (${extras.slice(0, 4).join(" ")})`], unresolved: ["the title does not say which variant; the entry is the right place, but it is not a specific variant", ...(unvCodes.length ? [`${unvCodes.join(", ")} is not confirmed as a model marker (maybe a seller's own code)`] : [])], ...base };
    }
    return { verdict: "related", relation: "family", sureness: small ? "low" : "medium", reasons: [`only a family-level entry ("${best.e.name}") fits; the title states more than it does`], unresolved: small ? ["no specific entry for this product", `"${best.e.name}" is a small part of the title: the item may only mention it rather than belong to it`] : ["no specific entry for this product"], ...base, newModel: { family: best.e.name, codes: [], note: small ? "the title may only mention this family; whether the item belongs to it is not established" : "the listing is a member of this family; no specific entry exists" } };
  }
  if (patternSibling && assessment.credible.length === 0) {
    const marker = tcodes.find((tc) => patternSibling.codes.some((c) => template(tc) === template(c)))!;
    return { verdict: "related", relation: "variant", sureness: "medium", reasons: [`the title's marker ${marker} follows the pattern of "${patternSibling.name}" but is a different value`], unresolved: [`no entry for ${marker}`], ...base,
      newModel: { family: patternSibling.name, codes: [marker], note: "a new model of a family that already has other models: recognised as such, not folded into the nearest entry" } };
  }
  if (assessment.credible.length > 0) {
    const sib = assessment.credible.find((c) => c.siblingName);
    return { verdict: "related", relation: "variant", sureness: "high", reasons: [`the title states ${assessment.credible.map((c) => c.code).join(", ")} which evidence shows is a real marker "${best.e.name}" lacks`], unresolved: sib ? [] : ["no entry for this exact variant"], ...base,
      newModel: sib ? null : { family: best.e.name, codes: assessment.credible.map((c) => c.code), note: "a marker seen in the data but with no entry of its own: a variant to recognise, not to fold into the entry" } };
  }
  // a word AFTER the entry's own words that the data uses to tell entries apart elsewhere ("Pro", "XL", a single letter): the title names a variant this entry is not
  const mainOrder = [...identityTokens(firstPhrase).words].filter((w) => !NOISE_WORDS.has(w));
  const lastEntryWord = mainOrder.reduce((m, w, i) => (best.e.words.has(w) ? i : m), -1);
  const codePieces = new Set([...titleCodes].flatMap(parts)); // the "o" of a seller's "O1766" is part of a code, not a marker of its own
  // ordinary listing wording ("new", "used") is never a variant word, however the data happens to pair it
  const variantWords = mainOrder.filter((w, i) => i > lastEntryWord && !best.e.words.has(w) && !isNumberWord(w) && !codePieces.has(w) && (w.length === 1 || (ctx.variantEvidence(w) >= VARIANT_STRONG || (ctx.variantEvidence(w) >= VARIANT_MIN && ctx.docFrequency(w) < 0.04))));
  if (variantWords.length && !variantWords.every((w) => w.length === 1 || ctx.variantEvidence(w) >= VARIANT_STRONG)) {
    return { verdict: "uncertain", relation: null, sureness: "low", reasons: [`the title also states ${variantWords.join(" ")}, which separates entries in a few places in the data; "${best.e.name}" lacks it`], unresolved: [`whether "${variantWords.join(" ")}" makes this a different variant`], ...base, product: null, alternatives: [product] };
  }
  if (variantWords.length) {
    return { verdict: "related", relation: "variant", sureness: "medium", reasons: [`the title also states ${variantWords.join(" ")}, which the data uses to tell entries apart elsewhere; "${best.e.name}" lacks it`], unresolved: [`no entry for the ${variantWords.join(" ")} variant`], ...base,
      newModel: { family: best.e.name, codes: [], note: "a variant of this entry that has no entry of its own: recognised as a variant, not folded into the entry" } };
  }
  // the entry's name is a small part of a title that states much else, most of it unfamiliar: the title may only mention the entry ("Minecraft ... Keychain")
  const shareOfTitle = [...best.e.words].filter((w) => mw.has(w)).length / Math.max(1, mw.size);
  if (shareOfTitle < 0.2 && rareExtras.length >= 3 && assessment.credible.length === 0) {
    return { verdict: "uncertain", relation: null, sureness: "low", reasons: [`"${best.e.name}" is a small part of a title that mostly states other things (${rareExtras.slice(0, 4).join(", ")})`], unresolved: ["whether the item is that product or only mentions it"], ...base, product: null, alternatives: [product] };
  }
  const unv = assessment.unverified.map((u) => u.code);
  const unresolved: string[] = [];
  if (unv.length) unresolved.push(`${unv.join(", ")} is not confirmed as a model marker (maybe a seller's own code)`);
  if (rareExtras.length) unresolved.push(`the title also states ${rareExtras.slice(0, 4).join(", ")}, which the entry does not and which is not ordinary listing wording (could be a variant with no entry)`);
  const left = omitted.get(best.e.id);
  // a word missing from the title AND a rare word beyond the entry: two doubts at once, so no claim
  if (left && rareExtras.length) {
    return { verdict: "uncertain", relation: null, sureness: "low", reasons: [`the title leaves out "${left}", which "${best.e.name}" states, and also states ${rareExtras.slice(0, 3).join(", ")}, which it does not`], unresolved: ["whether this is that product or a variant that has no entry"], ...base, product: null, alternatives: [product] };
  }
  if (left) unresolved.push(`the title leaves out "${left}", which the entry states (no entry exists without it)`);
  return { verdict: "confirmed", relation: null, sureness: unresolved.length ? "medium" : "high", reasons: [left ? `the title states everything "${best.e.name}" states except the plain word "${left}"` : `the title states everything "${best.e.name}" states`], unresolved, ...base };
}
