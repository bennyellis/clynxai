// The naming engine (Phase 1 of the Beta 30 plan): one simple name per product, every other name kept as an alias, a detail folded out of the name only when it does not move the price, and a
// VISIBLE note whenever something was folded. It reads the model facts (modelFacts.ts) and never touches the Database: it only says what a name should be. Creation-time use on every insert path and
// the clean-up of existing duplicates are Phase 2.
//
// The canonical format is "<Line> <state / edition word> (<hardware: colour, capacity>)", e.g. "Xbox Series X (Black)", "Xbox Series X Digital (White)", "Xbox Series X Galaxy Edition",
// "Xbox Series S (White, 512GB)". The rule: a detail is in the name only when models that differ in it have a real price or function difference.
import { brokenVariantName } from "./brokenVariant.js";
import { applyOverrides, buildAliasIndex, colourWordsIn, lineFor, nameKey, SEED_LINES, stripColours, type AliasHit, type LineFact } from "./modelFacts.js";

export interface FoldedDetail {
  kind: "colour" | "condition";
  /** What was taken out of the name ("Carbon Black", "Brand New"). */
  value: string;
}

export interface NameResolution {
  /** The one name this product goes by. */
  canonical: string;
  /** The entry above it ("Xbox Series X" above its models; "Nintendo Switch" above the OLED), or null. */
  parent: string | null;
  how: "model" | "folded" | "unchanged";
  /** The line it belongs to, when Clynx knows it. */
  line: string | null;
  folded: FoldedDetail[];
  /** The name as it was typed or found, to keep as an alias of the entry. Null when it already IS the canonical name. */
  alias: string | null;
  /** true when the name only says the LINE ("Xbox Series X"), not which model: it was matched to the line's default model and a later step may have to ask (Phase 3). */
  generic: boolean;
}

export interface NamingFacts {
  lines: ReadonlyArray<LineFact>;
  index: Map<string, AliasHit>;
}

/** The facts in force: the seeds plus the owner's edits. Build it once and pass it around. */
export function namingFacts(overrides: ReadonlyArray<{ canonical: string; addAliases?: string[]; attrs?: Record<string, string> }> = []): NamingFacts {
  const lines = overrides.length ? applyOverrides(SEED_LINES, overrides) : SEED_LINES;
  return { lines, index: buildAliasIndex(lines) };
}
const DEFAULT_FACTS = namingFacts();

const CONDITION_FILLER = /\b(?:brand new|new in box|new sealed|factory sealed|sealed|like new|open box|used|refurbished|renewed|pre-?owned|mint condition|excellent condition|great condition|good condition|nib|nwt|free shipping|fast shipping)\b/gi;

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** "2nd gen", "gen 2", "(2nd generation)" are one thing: "(2nd generation)". A model generation is part of the name (a different product), never folded. */
export function normalizeGeneration(name: string): string {
  return name
    .replace(/\(?\s*\b(\d{1,2})(?:st|nd|rd|th)\s*gen(?:eration)?\s*\)?/gi, (_m, d: string) => ` (${ordinal(Number(d))} generation) `)
    .replace(/\(?\s*\bgen(?:eration)?\s*(\d{1,2})\b\s*\)?/gi, (_m, d: string) => ` (${ordinal(Number(d))} generation) `)
    .replace(/\s+/g, " ")
    .trim();
}

function parentOf(model: { canonical: string; parent?: string }): string | null {
  return model.parent && nameKey(model.parent) !== nameKey(model.canonical) ? model.parent : null;
}

/**
 * The name a product should have. A model Clynx knows (by its canonical name or any alias) gets its canonical name and its parent. Anything else keeps its words, minus the condition filler
 * ("Brand New", "Used") and, unless the line's facts say colour matters, minus the colour; every removal is reported in `folded` so it can be shown. Generations are normalised, never removed.
 */
export function resolveName(raw: string, facts: NamingFacts = DEFAULT_FACTS): NameResolution {
  const typed = String(raw ?? "").replace(/\s+/g, " ").trim();
  const result = (r: Omit<NameResolution, "alias" | "generic"> & { generic?: boolean }): NameResolution => ({ generic: false, ...r, alias: nameKey(typed) === nameKey(r.canonical) ? null : typed || null });
  if (!typed) return result({ canonical: "", parent: null, how: "unchanged", line: null, folded: [] });

  // 1. a model Clynx knows, under any of its names (also with the condition filler taken off)
  const noFiller = typed.replace(CONDITION_FILLER, " ").replace(/\s+/g, " ").trim();
  // a maker's name in front ("Apple AirPods Pro") is not part of the line's own name
  const MAKER = /^(?:microsoft|apple|valve|sony|samsung|nintendo|google|logitech|razer|bose|jbl|dyson|kitchenaid|dewalt|canon|nikon|gopro)\s+/i;
  const generation = normalizeGeneration(noFiller);
  const noMaker = generation.replace(MAKER, "");
  // The name as typed first, then with the filler off, then without the maker, then without the colour (only for lines whose colour does not move the price).
  const attempts: Array<{ text: string; dropColour: boolean }> = [typed, noFiller, generation, noMaker].map((text) => ({ text, dropColour: false }));
  for (const text of [generation, noMaker]) attempts.push({ text: stripColours(text), dropColour: true });
  for (const { text, dropColour } of attempts) {
    const hit = facts.index.get(nameKey(text));
    if (!hit) continue;
    if (dropColour && (hit.line.keepColour || hit.line.distinguishing?.includes("colour"))) continue;
    const folded: FoldedDetail[] = [];
    for (const m of typed.matchAll(CONDITION_FILLER)) folded.push({ kind: "condition", value: m[0] });
    if (dropColour) for (const c of colourWordsIn(generation)) folded.push({ kind: "colour", value: c });
    return result({ canonical: hit.model.canonical, parent: parentOf(hit.model), how: "model", line: hit.line.name, generic: hit.line.models.length > 1 && nameKey(text) === nameKey(hit.line.name), folded });
  }

  // 2. the general rule
  const folded: FoldedDetail[] = [];
  for (const m of typed.matchAll(CONDITION_FILLER)) folded.push({ kind: "condition", value: m[0] });
  let name = generation;
  if (!lineFor(name, facts.lines) && lineFor(noMaker, facts.lines)) name = noMaker;
  const line = lineFor(name, facts.lines);
  const colourMatters = Boolean(line?.keepColour || line?.distinguishing?.includes("colour"));
  if (!colourMatters) {
    const colours = colourWordsIn(name);
    const stripped = stripColours(name);
    // never strip a name down to nothing: "Black Friday" or "Silver" alone stay as they are
    if (colours.length > 0 && stripped.split(" ").filter(Boolean).length >= 2) {
      for (const c of colours) folded.push({ kind: "colour", value: c });
      name = stripped;
    }
  }
  // a name that opens with the line's own words is spelled the way the line spells it ("kitchenaid artisan" -> "KitchenAid Artisan")
  if (line) {
    const lk = nameKey(line.name);
    const nk = nameKey(name);
    if (nk === lk) name = line.name;
    else if (nk.startsWith(`${lk} `)) name = `${line.name} ${name.split(/\s+/).slice(line.name.split(/\s+/).length).join(" ")}`.trim();
  }
  const changed = folded.length > 0 || nameKey(name) !== nameKey(typed) || name !== typed;
  return result({ canonical: name, parent: null, how: folded.length > 0 || changed ? "folded" : "unchanged", line: line?.name ?? null, folded });
}

/** The sentence shown where details were folded out of a name (never a silent merge). Empty when nothing was folded. */
export function foldedNotice(resolution: Pick<NameResolution, "folded">): string {
  const colours = [...new Set(resolution.folded.filter((f) => f.kind === "colour").map((f) => f.value.toLowerCase()))];
  const parts: string[] = [];
  if (colours.length > 0) {
    parts.push(`I left the colour (${colours.join(", ")}) out of the name: models that differ only in colour sell for about the same unless the sales say otherwise, so they share one entry.`);
  }
  return parts.join(" ");
}

export interface PriceGroup {
  value: string;
  medianUsd: number;
  n: number;
}

/** A group needs this many sold sales before its median counts, and two groups before a comparison is possible. */
export const MIN_GROUP_SALES = 3;
/** Models of one line that differ in an attribute by at least this share of the cheaper one's price do have a real price difference. */
export const DISTINGUISHING_GAP = 0.1;

export interface AttributeVerdict {
  /** true: the attribute moves the price, keep it in the name. false: it does not, fold it. null: not enough sales to say. */
  distinguishing: boolean | null;
  gapPercent: number | null;
  /** The visible note (with the evidence) when the attribute is folded; null otherwise. */
  notice: string | null;
  reason: string;
}

/** Does an attribute (colour, carrier...) change what a model sells for? Decided from sold medians per value; says "not enough sales" instead of guessing. */
export function judgeAttribute(attributeLabel: string, groups: ReadonlyArray<PriceGroup>): AttributeVerdict {
  const usable = groups.filter((g) => g.n >= MIN_GROUP_SALES && g.medianUsd > 0);
  if (usable.length < 2) return { distinguishing: null, gapPercent: null, notice: null, reason: "not enough sold sales per value to say" };
  const lo = Math.min(...usable.map((g) => g.medianUsd));
  const hi = Math.max(...usable.map((g) => g.medianUsd));
  const gap = (hi - lo) / lo;
  if (gap >= DISTINGUISHING_GAP) return { distinguishing: true, gapPercent: Math.round(gap * 100), notice: null, reason: `${Math.round(gap * 100)}% apart` };
  const evidence = usable.map((g) => `${g.value} $${Math.round(g.medianUsd)} (${g.n} sale${g.n === 1 ? "" : "s"})`).join(", ");
  return {
    distinguishing: false,
    gapPercent: Math.round(gap * 100),
    notice: `${attributeLabel}s of this model sell for about the same (${evidence}), so they share one entry.`,
    reason: `only ${Math.round(gap * 100)}% apart`,
  };
}

// ---- phones: lock state and carrier are what the price turns on

export type LockState = "unlocked" | "locked" | "unknown";

export interface PhoneParse {
  /** "iPhone 15 Pro", "Samsung Galaxy S24 Ultra", "Google Pixel 8 Pro", or null when it is not a phone model Clynx recognises. */
  model: string | null;
  storage: string | null;
  lock: LockState;
  carrier: string | null;
  /** Why it is not a normal entry at all (an iCloud / activation lock, MDM, blacklisted, financed with a balance): it goes to For Parts and never alerts. */
  forParts: string | null;
}

const CARRIERS: Array<[RegExp, string]> = [
  [/\bt-?\s?mobile\b/i, "T-Mobile"],
  [/\bverizon\b/i, "Verizon"],
  [/\bat\s?&\s?t\b|\batt\b/i, "AT&T"],
  [/\bxfinity\b/i, "Xfinity"],
  [/\bcricket\b/i, "Cricket"],
  [/\bmetro\s?(?:by\s?t-?mobile|pcs)?\b/i, "Metro"],
  [/\bboost\b/i, "Boost"],
  [/\bsprint\b/i, "Sprint"],
  [/\bus\s?cellular\b/i, "US Cellular"],
  [/\bstraight\s?talk\b/i, "Straight Talk"],
  [/\btracfone\b/i, "Tracfone"],
  [/\bvisible\b/i, "Visible"],
  [/\bgoogle\s?fi\b/i, "Google Fi"],
];

const NEGATION = "(?:no|not|without|removed|off|cleared|never|isn'?t|is not|free of|turned off|signed out)";
const FOR_PARTS_PATTERNS: Array<[RegExp, string]> = [
  [/\bicloud\s*(?:locked|lock|activation|account)\b|\bactivation\s*lock(?:ed)?\b|\bfind\s*my\s*(?:iphone|device)?\s*(?:is\s*)?on\b|\bapple\s*id\s*locked\b/i, "iCloud / activation locked"],
  [/\bmdm\b|\bremote\s*management\b|\bsupervised\b/i, "MDM / remote management"],
  [/\bblacklist(?:ed)?\b|\bblocked\s*imei\b|\bbad\s*(?:imei|esn)\b|\breported\s*(?:lost|stolen)\b/i, "blacklisted"],
  [/\bfinanced\b|\bpayment\s*plan\b|\bowe[sd]?\b|\bbalance\s*(?:owed|due|remaining)\b|\bnot\s*paid\s*off\b|\bmonthly\s*payments?\b/i, "financed with a balance"],
];

/** A forbidding phrase counts only if it is not negated right before it ("no iCloud lock", "iCloud removed", "not blacklisted", "paid off"). */
function forPartsReason(text: string): string | null {
  for (const [re, reason] of FOR_PARTS_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20).toLowerCase();
    if (new RegExp(`${NEGATION}\\s*(?:an?\\s+|the\\s+)?$`).test(before) || /^\s*(?:removed|off|cleared|free|clean|disabled|is off|is removed)/.test(after) || /\bpaid\s*off\b/.test(before + m[0] + after)) continue;
    return reason;
  }
  return null;
}

const PIXEL_SUFFIX: Record<string, string> = { "pro xl": "Pro XL", pro: "Pro", xl: "XL", a: "a" };
const MODEL_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/\biphone\s*(se|x[rs]?|\d{1,2})(?:\s*(pro\s*max|pro|plus|mini|e)\b)?/i, (m) => `iPhone ${m[1].toUpperCase() === "SE" ? "SE" : m[1].toUpperCase().replace(/^X([RS])$/, "X$1")}${m[2] ? ` ${m[2].replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}` : ""}`],
  [/\bgalaxy\s*(s|note|z\s*fold|z\s*flip|a)\s*(\d{1,2})(?:\s*(ultra|plus|\+|fe)\b)?/i, (m) => `Samsung Galaxy ${m[1].replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}${m[2]}${m[3] ? ` ${m[3] === "+" ? "Plus" : m[3].replace(/^\w/, (c) => c.toUpperCase())}` : ""}`],
  [/\bpixel\s*(\d{1,2})(?:\s*(pro\s*xl|pro|xl|a)\b)?/i, (m) => `Google Pixel ${m[1]}${m[2] ? ` ${PIXEL_SUFFIX[m[2].replace(/\s+/g, " ").toLowerCase()] ?? m[2]}` : ""}`],
];

/** Reads a phone listing's words (title, description, item specifics joined): the model, the storage, the lock state, the carrier, and whether it is a For Parts case. */
export function parsePhone(text: string): PhoneParse {
  const t = String(text ?? "");
  let model: string | null = null;
  for (const [re, build] of MODEL_PATTERNS) {
    const m = re.exec(t);
    if (m) {
      model = build(m);
      break;
    }
  }
  const storageMatch = /\b(\d{2,4})\s?(gb)\b|\b(\d{1,2})\s?(tb)\b/i.exec(t);
  const storage = storageMatch ? `${storageMatch[1] ?? storageMatch[3]}${(storageMatch[2] ?? storageMatch[4]).toUpperCase()}` : null;
  const forParts = forPartsReason(t);
  const carrierHit = CARRIERS.find(([re]) => re.test(t));
  const carrier = carrierHit ? carrierHit[1] : null;
  const saysUnlocked = /\b(?:factory\s*|fully\s*|carrier\s*|network\s*|sim\s*)?unlocked\b|\bsim[- ]?free\b|\bno\s*(?:carrier\s*)?restrictions\b|\bworks\s*(?:with|on)\s*(?:all|any)\s*carriers?\b/i.test(t);
  const saysLocked = /\b(?:carrier\s*|network\s*|sim\s*)?locked\b/i.test(t.replace(/\b(?:un|not\s*)locked\b/gi, " ")) || /\blocked\s*to\b/i.test(t);
  const nowUnlocked = /\b(?:now|been|was\s+locked,?\s*now|has\s*been|got)\s*(?:carrier\s*)?unlocked\b|\bunlocked\s*by\s*(?:the\s*)?(?:carrier|seller|owner)\b|\bsettings\s*(?:say|show|screen)s?\s*no\s*(?:sim\s*)?restrictions\b/i.test(t);
  let lock: LockState = "unknown";
  if (nowUnlocked || (saysUnlocked && !saysLocked)) lock = "unlocked";
  else if (saysLocked) lock = "locked";
  else if (carrier && !saysUnlocked) lock = "locked"; // "T-Mobile iPhone 15" is locked to that carrier
  return { model, storage, lock, carrier: lock === "locked" ? carrier : null, forParts };
}

export interface PhoneEntry {
  name: string;
  /** The entry above it: the model for Unlocked / Locked, the Locked entry for a carrier. */
  parent: string | null;
  kind: "normal" | "for_parts";
  /** "vague" when the lock state is not known yet: the name is the model and size only, and Phase 3 asks for the rest. */
  certainty: "settled" | "vague";
}

/** The entry a phone listing belongs to, created on demand: "iPhone 15 Pro Unlocked (256GB)", "iPhone 15 Pro Locked (256GB)", "iPhone 15 Pro Locked T-Mobile (256GB)". */
export function phoneEntry(p: PhoneParse): PhoneEntry | null {
  if (!p.model) return null;
  const size = p.storage ? ` (${p.storage})` : "";
  if (p.forParts) return { name: brokenVariantName(`${p.model}${size}`), parent: `${p.model}${size}`, kind: "for_parts", certainty: "settled" };
  if (p.lock === "unlocked") return { name: `${p.model} Unlocked${size}`, parent: p.model, kind: "normal", certainty: "settled" };
  if (p.lock === "locked" && p.carrier) return { name: `${p.model} Locked ${p.carrier}${size}`, parent: `${p.model} Locked${size}`, kind: "normal", certainty: "settled" };
  if (p.lock === "locked") return { name: `${p.model} Locked${size}`, parent: p.model, kind: "normal", certainty: "settled" };
  return { name: `${p.model}${size}`, parent: p.model, kind: "normal", certainty: "vague" };
}

/** An entry that is For Parts never raises a deal alert (an iCloud-locked phone is not a bargain). */
export const neverAlerts = (e: Pick<PhoneEntry, "kind" | "certainty">): boolean => e.kind === "for_parts" || e.certainty === "vague";
