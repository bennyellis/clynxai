// Universal comparable-sale identity validation. A search result (a WatchCount sold sale, an eBay active listing) is never assumed to be the product
// just because the search returned it: eBay and WatchCount searches are loose (an "iPhone 16" search returns iPhone 14s, cases, lots). Every candidate
// title is compared with the identity of the product being priced BEFORE its price is used, and gets one of four verdicts:
//   exact       every attribute the product states is stated, and equal, in the title
//   compatible  nothing contradicts and the core identity (model, tier, kind) is confirmed; an attribute that barely moves the price is simply unstated
//   uncertain   the title does not let us tell (no model number, no capacity for a product priced by capacity, names several models, is more specific)
//   rejected    the title contradicts the product (another model number, another tier, another lettered model, another capacity / color / edition, a part,
//               an accessory, a lot)
// Only exact and compatible comparables are used for a value, a profit, a sell-through figure or a Database price. A missing attribute is uncertainty,
// not a mismatch; a stated, different attribute is a mismatch. The rules are about the words of a name (digits next to a word, tier words, capacity,
// color, edition), never about a product list.
//
// Reuses the existing building blocks (compFilter.ts hard facts, colors.ts, variantIdentity.ts editions and kinds) instead of a second matcher.
import {
  ACCESSORY_WORDS,
  NOT_THE_PRODUCT_WORDS,
  TIER_WORDS,
  capacityTokens,
  hasSpecToken,
  hasTierWord,
  modelLetters,
  tokens,
} from "./compFilter.js";
import { colorsIn } from "./colors.js";
import { hardwareTail, mediaAmbiguity, mediaSignal, namesGamePlatform, stripDescriptors } from "./productKind.js";
import { editionConflict, extractVariantAttributes, identityTokens } from "./variantIdentity.js";
import { attributeFindings } from "./identityModel.js";
import { knowledgeFindings, knowledgeProvider } from "./knowledgeRegistry.js";

export type CompVerdict = "exact" | "compatible" | "uncertain" | "rejected";

export type CompReason =
  | "MODEL_NUMBER"
  | "MODEL_LETTER"
  | "GENERATION"
  | "TIER"
  | "CAPACITY"
  | "COLOR"
  | "EDITION"
  | "ACCESSORY"
  | "MEDIA"
  | "KIND_AMBIGUOUS"
  | "LOT_OR_BUNDLE"
  | "NOT_WORKING"
  | "MODEL_NOT_STATED"
  | "CAPACITY_NOT_STATED"
  | "MULTIPLE_MODELS"
  | "MORE_SPECIFIC"
  | "WORDS_MISSING"
  | "COLOR_NOT_STATED"
  | "EDITION_NOT_STATED"
  | "DRIVE"
  | "BOARD_DESIGN"
  | "BOARD_DESIGN_NOT_STATED"
  | "REGION"
  | "LOCK"
  | "SKU"
  | "MODEL_VARIANT";

export interface CompJudgement {
  verdict: CompVerdict;
  reasons: Array<{ code: CompReason; text: string }>;
}

const RANK: Record<CompVerdict, number> = { exact: 0, compatible: 1, uncertain: 2, rejected: 3 };
const worse = (a: CompVerdict, b: CompVerdict): CompVerdict => (RANK[a] >= RANK[b] ? a : b);

// A title that is plainly about something that goes WITH the product, not the product.
const COMPATIBLE_WITH = /\b(compatible with|compatible for|fits|fit for|designed for|made for|for use with|replacement for|case for|cover for|protector for|charger for|cable for|stand for|skin for|accessor(?:y|ies) for)\b/i;
const LOT = /\b(lot|lot of|set of|bulk|wholesale|\d+\s*x\s|\sx\s*\d+\b|\d+\s*[- ]?pack|bundle|combo|job lot)\b|\+/i;

function normalizedTitleTokens(text: string): string[] {
  return tokens(text);
}

/** word -> numbers that directly follow it: "iphone 16" and "iphone16" both give iphone -> 16; "ps5" gives ps -> 5; "galaxy s24" gives s -> 24. */
function numberSlots(text: string): Map<string, Set<string>> {
  const toks = normalizedTitleTokens(text);
  const slots = new Map<string, Set<string>>();
  const add = (word: string, num: string) => {
    const set = slots.get(word) ?? new Set<string>();
    set.add(num);
    slots.set(word, set);
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const glued = /^([a-z]{1,10})(\d{1,5})$/.exec(t);
    if (glued) add(glued[1], glued[2]);
    if (/^[a-z]{2,}$/.test(t) && /^\d{1,4}$/.test(toks[i + 1] ?? "") && !/^(?:gb|tb|mb)$/.test(toks[i + 1])) add(t, toks[i + 1]);
  }
  // "iPhone 15/16", "iPhone 15 or 16": a title naming several numbers for the same word
  for (const m of text.toLowerCase().matchAll(/\b([a-z]{2,})\s*(\d{1,4}(?:\s*(?:\/|,|or|and|&)\s*\d{1,4})+)/g)) {
    for (const n of m[2].split(/\s*(?:\/|,|or|and|&)\s*/)) if (/^\d{1,4}$/.test(n)) add(m[1], n);
  }
  return slots;
}

/** "2nd", "3rd gen": ordinal generations. */
function ordinals(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b(?:\s*gen(?:eration)?)?|\bgen(?:eration)?\s*(\d{1,2})\b/g)) found.add(m[1] ?? m[2]);
  return found;
}

function modelLetterWords(text: string): Set<string> {
  return new Set(modelLetters(text).keys());
}

/** What one reference (the product's name, a search query, the listing it came from) requires of a title. */
/** Which Xbox a text is about: "series", "one", "360", "unstated" (just "Xbox"), or null when it does not name an Xbox. */
function xboxGeneration(text: string): "series" | "one" | "360" | "unstated" | null {
  if (!/\bxbox/i.test(text)) return null;
  // the generation can be anywhere in the title ("Xbox 1TB Series X", "Xbox White Series S", "Xbox SeriesX", "Xbox, Series X, 1TB"), not just right after the word "Xbox"
  if (/\bseries\s*-?\s*[xs]\b|\bseries[xs]\b/i.test(text)) return "series";
  if (/\b360\b/.test(text)) return "360";
  if (/\bxbox\s*one\b|\bone\s*[xs]\b/i.test(text) || (/\bone\b/i.test(text) && !/\bday\s*one\b/i.test(text))) return "one";
  return "unstated";
}

function judgeAgainst(reference: string, title: string, requiredTerms: string[], broken: boolean): CompJudgement {
  const reasons: CompJudgement["reasons"] = [];
  let verdict: CompVerdict = "exact";
  const mark = (v: CompVerdict, code: CompReason, text: string) => {
    verdict = worse(verdict, v);
    reasons.push({ code, text });
  };
  const titleTokens = normalizedTitleTokens(title);
  const refSlots = numberSlots(reference);
  const titleSlots = numberSlots(title);

  // ---- kind: a part, an accessory, a lot, something that is not working
  if (!broken) {
    // EVERY such phrase in the title counts, not only the first ("Special Edition ... For Parts Not Working"), and a phrase the product's own name uses ("Special Edition") only excuses itself
    const lowRef = reference.toLowerCase();
    for (const m of title.matchAll(new RegExp(NOT_THE_PRODUCT_WORDS.source, "gi"))) {
      // an edition word is the edition check's business, not a "part"
      if (/^(limited edition|special edition|collector'?s|steelbook)$/i.test(m[0]) || lowRef.includes(m[0].toLowerCase())) continue;
      mark("rejected", /lot|bundle/i.test(m[0]) ? "LOT_OR_BUNDLE" : "NOT_WORKING", `the title says "${m[0]}"`);
      break;
    }
  }
  // ---- Xbox generation: an Xbox 360 or Xbox One is not a Series X, and a bare "Xbox" does not say which
  const xboxRef = xboxGeneration(reference);
  const xboxTitle = xboxGeneration(title);
  if (xboxRef && xboxRef !== "unstated" && xboxTitle) {
    if (xboxTitle === "unstated") mark("uncertain", "MODEL_NOT_STATED", `the title says "Xbox" but not which one (the product is the Xbox ${xboxRef})`);
    else if (xboxTitle !== xboxRef) mark("rejected", "MODEL_NUMBER", `a different Xbox generation: ${xboxTitle} instead of ${xboxRef}`);
  }
  const lowerRef = reference.toLowerCase();
  const scanned = stripDescriptors(title).toLowerCase();
  for (const m of scanned.matchAll(ACCESSORY_WORDS)) {
    // "Console Neon Blue Red Joy-Con 32GB HAC-001": an accessory word followed by the machine's own capacity / model code is describing the machine
    if (!lowerRef.includes(m[1]) && !hardwareTail(scanned.slice((m.index ?? 0) + m[0].length))) {
      mark("rejected", "ACCESSORY", `the title mentions "${m[1]}", which is something for the product, not the product`);
      break;
    }
  }
  // A game, disc or other software that merely names the platform or shares a word ("Guardians of the Galaxy (Xbox Series X)") is not the console named "... Galaxy ...".
  const mediaInTitle = mediaSignal(title);
  if (mediaInTitle && !mediaSignal(reference)) mark("rejected", "MEDIA", `the title reads as a game or software for a platform ("${mediaInTitle}"), not the product`);
  else if (!mediaInTitle) {
    // "Halo Xbox Series X Brand New": the words cannot tell a special-edition console from the game (or a mislisting); never exact on words alone, the photos decide.
    const ambiguous = mediaAmbiguity(title);
    if (ambiguous) mark("uncertain", "KIND_AMBIGUOUS", `the title could be the console or a game for it ("${ambiguous}" before the platform name): the photos have to confirm it`);
  }
  if (COMPATIBLE_WITH.test(title) && !COMPATIBLE_WITH.test(reference)) mark("rejected", "ACCESSORY", `the title says it is for the product ("${COMPATIBLE_WITH.exec(title)?.[0]}")`);
  if (LOT.test(title) && !LOT.test(reference) && !reasons.some((r) => r.code === "LOT_OR_BUNDLE")) mark("rejected", "LOT_OR_BUNDLE", `the title is a lot, a multi-pack or a bundle`);

  // ---- model numbers: the number next to a word. iPhone 14 is not iPhone 16.
  const modelProblems: string[] = [];
  for (const [word, wanted] of refSlots) {
    const found = titleSlots.get(word);
    if (!found) continue;
    const missing = [...wanted].filter((n) => !found.has(n));
    if (missing.length === 0) {
      if (found.size > wanted.size && [...found].some((n) => !wanted.has(n))) mark("uncertain", "MULTIPLE_MODELS", `the title names several "${word}" numbers (${[...found].join(", ")})`);
      continue;
    }
    modelProblems.push(`${word} ${[...found].join("/")} instead of ${word} ${[...wanted].join("/")}`);
  }
  if (modelProblems.length) mark("rejected", "MODEL_NUMBER", `a different model number: ${modelProblems.join("; ")}`);
  // a bare model number the title never states and no competing number explains (3060, a4562): not confirmed
  for (const t of specTokensOf(reference)) {
    if (/^\d+(?:p\d+)?(?:tb|gb|mb)$/.test(t)) continue;
    if (hasSpecToken(titleTokens, t)) continue;
    if (modelProblems.length) continue;
    // a competing number of the same prefix ("ps4" for "ps5", "s23" for "s24")
    const prefix = /^([a-z]+)\d+$/.exec(t)?.[1];
    if (prefix && titleTokens.some((x) => new RegExp(`^${prefix}\\d+$`).test(x))) {
      mark("rejected", "MODEL_NUMBER", `a different model than ${t}`);
      continue;
    }
    mark("uncertain", "MODEL_NOT_STATED", `the title does not state "${t}"`);
  }
  // the reference says only "Xbox Wireless Controller" and the title says "Xbox 360 ...": the title is narrower than a generic entry. That is not a contradiction (a
  // generic entry spans versions; the population split in identity/populations.ts separates their prices and flags the value approximate), so it is compatible, not excluded.
  for (const [word, found] of titleSlots) {
    if (!refSlots.has(word) && identityTokens(reference).includes(word) && found.size > 0) mark("compatible", "MORE_SPECIFIC", `the title says ${word} ${[...found][0]}, the product does not name a number`);
  }

  // ---- generation words (2nd gen)
  const refGen = ordinals(reference);
  const titleGen = ordinals(title);
  if (refGen.size && titleGen.size && ![...refGen].some((g) => titleGen.has(g))) mark("rejected", "GENERATION", `generation ${[...titleGen].join("/")} instead of ${[...refGen].join("/")}`);
  else if (refGen.size && !titleGen.size) mark("uncertain", "MODEL_NOT_STATED", "the title does not state the generation");

  // ---- tier: Pro / Max / Plus / Slim / OLED ... a tier is a different product
  for (const w of TIER_WORDS) {
    const a = hasTierWord(reference, w);
    const b = hasTierWord(title, w);
    if (a !== b) mark("rejected", "TIER", a ? `the title does not say "${w}" (the product is a ${w})` : `the title says "${w}" and the product is not a ${w}`);
  }

  // ---- lettered models: Series S / Series X / One X
  const refLetters = modelLetters(reference);
  const titleLetters = modelLetters(title);
  for (const [word, letters] of refLetters) {
    const there = titleLetters.get(word);
    if (there && ![...letters].some((l) => there.has(l))) mark("rejected", "MODEL_LETTER", `"${word} ${[...there].join("/")}" instead of "${word} ${[...letters].join("/")}"`);
    else if (!there) {
      const other = [...modelLetterWords(title)].filter((w) => !refLetters.has(w));
      if (other.length) mark("rejected", "MODEL_LETTER", `the title is a different line ("${other[0]}"), not "${word}"`);
    }
  }

  // ---- capacity: a stated, different capacity is a different product; none stated is uncertain when the product is priced by capacity
  const refCaps = capacityTokens(reference);
  const titleCaps = capacityTokens(title);
  if (refCaps.length) {
    if (titleCaps.length === 0) {
      // When the title carries the product's own themed edition word ("Galaxy") together with its other words, that alone makes it very likely the same product: an edition sold in one
      // configuration is not made doubtful by a seller leaving out the size. A plain product with no themed word still needs its capacity.
      const themed = extractVariantAttributes(reference).editionTerms.filter((t) => !["special", "limited", "collector", "collectors", "exclusive", "anniversary", "signature", "founder", "founders", "commemorative", "deluxe"].includes(t));
      const titleHas = new Set(identityTokens(title));
      // only for game consoles: a limited console edition ships in one configuration, whereas a phone or laptop edition comes in several sizes and the size still matters
      const themedNamed = themed.length > 0 && themed.every((t) => titleHas.has(t)) && namesGamePlatform(reference);
      mark(themedNamed ? "compatible" : "uncertain", "CAPACITY_NOT_STATED", `the title does not state a capacity (the product is ${refCaps.join("/")})${themedNamed ? "; it names the edition, which is enough to go on" : ""}`);
    }
    else if (titleCaps.some((c) => !refCaps.includes(c))) mark("rejected", "CAPACITY", `${titleCaps.join("/")} instead of ${refCaps.join("/")}`);
  } else if (titleCaps.length) {
    // the title is more specific than the product (it names a capacity the product does not): the same product, a narrower one
    if (verdict === "exact") verdict = "compatible";
  }

  // ---- color: a stated, different color is a different listing for valuation; none stated barely matters
  const refColors = colorsIn(reference);
  const titleColors = colorsIn(title);
  if (refColors.size && titleColors.size && ![...refColors].some((c) => titleColors.has(c))) mark("rejected", "COLOR", `${[...titleColors].join("/")} instead of ${[...refColors].join("/")}`);
  else if (refColors.size && !titleColors.size) mark("compatible", "COLOR_NOT_STATED", "the title does not state a color");

  // ---- edition: special / limited / themed editions are products of their own
  if (editionConflict(reference, title, requiredTerms)) mark("rejected", "EDITION", "a different edition (an edition the product lacks, or the product's edition missing)");
  else if (extractVariantAttributes(reference).editionTerms.length === 0 && requiredTerms.length === 0) {
    // nothing to compare
  }

  // ---- Beta 13 attributes: optical drive, board design (GPU partner line), region, carrier lock, manufacturer model codes
  for (const f of attributeFindings(reference, title)) mark(f.verdict, f.code, f.text);

  // ---- the product's own plain words, when nothing above settled it: a missing brand is normal, several missing words are not
  const refWords = identityTokens(reference).filter((t) => /^[a-z]+$/.test(t) && t.length > 2 && !TIER_WORDS.includes(t) && !colorsIn(t).size);
  const have = new Set(titleTokens);
  const missingWords = refWords.filter((w) => !have.has(w));
  if (refWords.length >= 3 && missingWords.length / refWords.length > 0.5) mark("uncertain", "WORDS_MISSING", `the title leaves out most of the product's words (${missingWords.slice(0, 3).join(", ")})`);

  return { verdict, reasons };
}

function specTokensOf(text: string): string[] {
  return [...new Set(tokens(text).filter((t) => /\d/.test(t)))].filter((t) => !/^\d{1,2}$/.test(t) || true);
}

export interface CompIdentityInput {
  /** The Database product's name. */
  name: string;
  /** The search query that retrieved the results (it may be looser or tighter than the name). */
  query?: string | null;
  /** The Marketplace listing the product was found from: contributes the attributes the name leaves open (capacity, color). */
  sourceTitle?: string | null;
  /** Words that separate this product from its general parent (see variantIdentity.ts). */
  requiredTerms?: string[];
  /** Judging comps of a broken / for-parts variant. */
  broken?: boolean;
}

/** Attributes the Marketplace listing states that the product's name leaves open: the listing is the unit being priced. */
function listingAttributes(name: string, sourceTitle: string | null | undefined): string {
  if (!sourceTitle) return "";
  const parts: string[] = [];
  if (capacityTokens(name).length === 0) parts.push(...capacityTokens(sourceTitle));
  if (colorsIn(name).size === 0) parts.push(...colorsIn(sourceTitle));
  return parts.join(" ");
}

/**
 * The verdict for one candidate title: the worst verdict across the product's name, the search query and the listing's own attributes (all must
 * hold; the query being looser than the name never lets a contradicting title through).
 */
export function classifyComparable(identity: CompIdentityInput, title: string): CompJudgement {
  const references = [identity.name];
  if (identity.query && identity.query.trim() && identity.query.trim().toLowerCase() !== identity.name.trim().toLowerCase()) references.push(identity.query);
  const extra = listingAttributes(identity.name, identity.sourceTitle);
  if (extra) references.push(`${identity.name} ${extra}`);
  let result: CompJudgement = { verdict: "exact", reasons: [] };
  for (const ref of references) {
    const j = judgeAgainst(ref, title, identity.requiredTerms ?? [], !!identity.broken);
    result = { verdict: worse(result.verdict, j.verdict), reasons: [...result.reasons, ...j.reasons.filter((r) => !result.reasons.some((x) => x.code === r.code && x.text === r.text))] };
  }
  // What Clynx learned from the web about this product line (a different model that looks the same, e.g. "Quest 3S" for a "Quest 3"): it can only make a title worse.
  const kp = knowledgeProvider();
  if (kp && kp.mode() !== "off") {
    const found = knowledgeFindings(identity.name, title, kp.lookup(identity.name));
    if (found.length) {
      if (kp.mode() === "enforce") result = { verdict: worse(result.verdict, "rejected"), reasons: [...result.reasons, ...found] };
      else kp.shadow?.({ name: identity.name, title, findings: found });
    }
  }
  // an "exact" that only the (looser) query confirmed, with the name stating more, is still exact: every reference passed
  return result;
}

/** Only these are used for a value, a profit, a sell-through figure or a Database price. */
export function usableForValuation(v: CompVerdict): boolean {
  return v === "exact" || v === "compatible";
}

export interface ValidationSummary {
  retrieved: number;
  exact: number;
  compatible: number;
  uncertain: number;
  rejected: number;
  /** reason code -> how many candidates (uncertain and rejected) carried it. */
  reasons: Record<string, number>;
  /** A few examples of what was left out, for the log. */
  examples: Array<{ title: string; verdict: CompVerdict; reason: string }>;
}

export function emptySummary(): ValidationSummary {
  return { retrieved: 0, exact: 0, compatible: 0, uncertain: 0, rejected: 0, reasons: {}, examples: [] };
}

export function tallyJudgement(summary: ValidationSummary, title: string, j: CompJudgement): void {
  summary.retrieved++;
  summary[j.verdict]++;
  if (j.verdict === "uncertain" || j.verdict === "rejected") {
    const strong = j.reasons.filter((r) => (j.verdict === "rejected" ? !/_NOT_STATED$|^MORE_SPECIFIC$|^WORDS_MISSING$|^MULTIPLE_MODELS$/.test(r.code) : true));
    const first = strong[0] ?? j.reasons[0];
    if (first) {
      summary.reasons[first.code] = (summary.reasons[first.code] ?? 0) + 1;
      if (summary.examples.length < 4) summary.examples.push({ title: title.slice(0, 80), verdict: j.verdict, reason: first.text });
    }
  }
}

export function describeSummary(label: string, s: ValidationSummary): string {
  if (s.retrieved === 0) return `${label}: nothing retrieved.`;
  const accepted = s.exact + s.compatible;
  const reasons = Object.entries(s.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, n]) => `${code.toLowerCase().replace(/_/g, " ")} x${n}`)
    .join(", ");
  return `${label}: retrieved ${s.retrieved}, accepted ${accepted} (${s.exact} exact, ${s.compatible} compatible), uncertain ${s.uncertain}, rejected ${s.rejected}${reasons ? ` (${reasons})` : ""}.`;
}

/**
 * A listing (not a search result) against the Database entry it was matched to: true only when the title CONTRADICTS the entry's identity, so the
 * entry's value must not be used for it. Missing information is never a contradiction.
 */
export function listingContradictsEntry(entryName: string, listingTitle: string): string | null {
  const j = classifyComparable({ name: entryName }, listingTitle);
  if (j.verdict !== "rejected") return null;
  // Identity attributes, and a title that says outright it is something FOR the product. A listing that merely mentions extras ("with 2 controllers") is a
  // bundle of the product, whose value the bundle logic prices from the product's own value, so it is not a contradiction here.
  const hard = j.reasons.find((r) => ["MODEL_NUMBER", "MODEL_LETTER", "GENERATION", "TIER", "CAPACITY", "EDITION", "MEDIA", "MODEL_VARIANT"].includes(r.code) || (r.code === "ACCESSORY" && /says it is for the product/.test(r.text)));
  return hard ? `${hard.code.toLowerCase().replace(/_/g, " ")}: ${hard.text}` : null;
}

