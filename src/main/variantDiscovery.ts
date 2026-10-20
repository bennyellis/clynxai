// Finding every version (and every add-on) of a product, from sources, the same way every time. The owner's rules (2026-10-20):
//   * It runs by itself on a first research and keeps going in the background until every candidate has been checked (a persistent queue, not a cap of three that drops the rest).
//   * The FIRST source is what real eBay listings say (the item specifics: storage, colour, edition/model, bundle). Then the web catalogues. The model's memory is only an extra hint and
//     never creates anything on its own, so the same product gives the same list.
//   * A version reported by only ONE source stays a SUGGESTION (shown on the product, not a Database entry) until a second source or a listing confirms it.
//   * Potential add-ons are ALWAYS added, each as its own accessory entry in the Database, found in a source (a page, a seen listing), never from memory alone.
// Pure: names in, decisions out. The network, the Database and the clock are not touched here.
import { isMoreSpecific, identityTokens } from "./variantIdentity.js";
import { isPlausibleProductName } from "./variantFanout.js";
import { kindOfName } from "./productKind.js";
import type { EditionFinding } from "./editionDiscovery.js";
import type { VariantVerdict } from "./variantEvidence.js";

export type CandidateSource = "ebay_specifics" | "catalogue" | "listing" | "memory" | "user";
export type CandidateKind = "variant" | "addon";
export type CandidateStatus = "queued" | "checking" | "added" | "suggestion" | "rejected" | "skipped";

export interface Candidate {
  name: string;
  kind: CandidateKind;
  /** Which kinds of source named it (distinct kinds, not pages). */
  sources: CandidateSource[];
  /** The catalogue's own judgement when it came from one ("confirmed" = official / specialist / two independent sites). */
  support?: "confirmed" | "reported";
  /** Where it was read, shown to the person ("microsoft.com", "eBay listings (31)"). */
  evidence: string[];
}

// ---- eBay item specifics -------------------------------------------------------------------------------------------------------------------------------------------------

export interface AspectDistribution {
  /** "Storage Capacity", "Color", "Model", "Edition", "Bundle Description"... as eBay names the item specific. */
  name: string;
  values: Array<{ value: string; count: number }>;
}

const CAPACITY_ASPECT = /^(?:storage capacity|hard drive capacity|memory capacity|capacity|internal storage|ssd capacity|storage)$/i;
const COLOR_ASPECT = /^(?:colou?r|main colou?r)$/i;
// Only the aspects whose values NAME a version. "Type", "Style", "Bundle Description", "Version" and "Series" hold descriptions of what is in the listing ("Home Console", "Console Only",
// "With 2 Controllers", "NTSC-U/C", "Smartphone"), not versions of the product, so they are not read.
const EDITION_ASPECT = /^(?:edition|special edition|limited edition)$/i;
/** Words that make a value a description of the listing, not a version: what is included, the kind of device, a region, "standard". */
const NOT_A_VERSION = /\b(?:only|with|without|includes?|included|console|smartphone|phone|bar|standard|home|unit|system|body|lens|kit|lot|controllers?|games?|ntsc|pal|region|us|usa|canada|u\/c|used|new|refurbished|open box|genuine|original|authentic|brand|bundle|and|or|plus)\b|[+&/]/i;
/** A listing value that is not a real choice. */
const JUNK_VALUE = /^(?:n\/a|na|none|unbranded|does not apply|not specified|other|multicolou?r|multi-?colou?r|unknown|see description|-)$/i;
/** Share of the counted listings, and a floor, below which a value is noise rather than a real version. */
const MIN_SHARE = 0.01;
const MIN_COUNT = 3;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "").trim();

/** "2 TB" / "2TB" / "2048 GB" -> "2TB"; values that are not a capacity are returned cleaned. */
export function normalizeCapacity(v: string): string {
  const m = /^(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/i.exec(clean(v));
  return m ? `${m[1]}${m[2].toUpperCase()}` : clean(v);
}

/**
 * Versions the real market uses, from eBay's item-specific distributions for a search of the product: one candidate per value of storage / colour / edition-or-model-or-bundle that enough
 * listings share. Deterministic: sorted by how many listings use it, then by name. A value already inside the base name ("X" in "Xbox Series X") is not a version.
 */
export function specificsToCandidates(base: string, aspects: AspectDistribution[], totalListings?: number): Candidate[] {
  const out: Candidate[] = [];
  const baseTokens = new Set(identityTokens(base));
  for (const aspect of aspects) {
    const type = CAPACITY_ASPECT.test(aspect.name) ? "capacity" : COLOR_ASPECT.test(aspect.name) ? "color" : EDITION_ASPECT.test(aspect.name) ? "edition" : null;
    if (!type) continue;
    const total = totalListings ?? aspect.values.reduce((s, v) => s + v.count, 0);
    const aspectSum = aspect.values.reduce((s, v) => s + v.count, 0);
    for (const raw of aspect.values) {
      const value = type === "capacity" ? normalizeCapacity(raw.value) : clean(raw.value);
      if (!value || JUNK_VALUE.test(value) || raw.count < MIN_COUNT || (total > 0 && raw.count / total < MIN_SHARE)) continue;
      if (type !== "capacity" && NOT_A_VERSION.test(value)) continue;
      // the plain colour almost every listing has ("Black") is the product's default look, not a version of it
      if (type === "color" && !/\s/.test(value) && aspectSum > 0 && raw.count / aspectSum >= 0.5) continue;
      // A value that repeats part of the base ("Series S" for "Xbox Series X", "Xbox Series X 1TB") is cut down to the words it ADDS; a different model (one new letter, "S") is not a version.
      const added = value.split(/\s+/).filter((w) => identityTokens(w).some((t) => !baseTokens.has(t)));
      const addedTokens = identityTokens(added.join(" "));
      const sharesBase = identityTokens(value).some((t) => baseTokens.has(t));
      if (addedTokens.length === 0) continue; // already part of the base name
      if (sharesBase && addedTokens.every((t) => t.length === 1)) continue; // "Series S": another model of the line, not a version
      const name = clean(`${base} ${sharesBase ? added.join(" ") : value}`);
      if (!isPlausibleProductName(name) || !isMoreSpecific(name, base)) continue;
      out.push({ name, kind: "variant", sources: ["ebay_specifics"], evidence: [`eBay listings (${raw.count} use ${aspect.name}: ${value})`] });
    }
  }
  return out.sort((a, b) => countOf(b) - countOf(a) || a.name.localeCompare(b.name));
}
const countOf = (c: Candidate) => Number(/\((\d+) use/.exec(c.evidence[0] ?? "")?.[1] ?? 0);

/** Reads eBay's item_summary/search response (fieldgroups=ASPECT_REFINEMENTS) into distributions. Tolerant: anything missing is skipped. */
export function parseAspectRefinements(data: unknown): AspectDistribution[] {
  const dists = (data as { refinement?: { aspectDistributions?: unknown[] } } | null)?.refinement?.aspectDistributions;
  if (!Array.isArray(dists)) return [];
  const out: AspectDistribution[] = [];
  for (const d of dists as Array<{ localizedAspectName?: string; aspectValueDistributions?: Array<{ localizedAspectValue?: string; matchCount?: number }> }>) {
    if (!d?.localizedAspectName || !Array.isArray(d.aspectValueDistributions)) continue;
    const values = d.aspectValueDistributions
      .filter((v) => v?.localizedAspectValue && typeof v.matchCount === "number")
      .map((v) => ({ value: String(v.localizedAspectValue), count: Number(v.matchCount) }));
    if (values.length) out.push({ name: d.localizedAspectName, values });
  }
  return out;
}

// ---- web catalogues ------------------------------------------------------------------------------------------------------------------------------------------------------

/** Editions the web catalogues name (editionResearch.ts): "confirmed" ones are an official / specialist source or two independent sites. */
export function findingsToCandidates(base: string, findings: EditionFinding[]): Candidate[] {
  const out: Candidate[] = [];
  for (const f of findings) {
    const name = clean(f.name);
    if (!isPlausibleProductName(name) || !isMoreSpecific(name, base) || kindOfName(name) !== "hardware") continue;
    out.push({ name, kind: "variant", sources: ["catalogue"], support: f.support, evidence: f.sources.slice(0, 3).map((s) => hostOf(s.url)) });
  }
  return out;
}

/** The model's memory: a hint only. It can add a source to a candidate that is already named elsewhere, but never creates one by itself. */
export function memoryHints(base: string, names: string[]): Candidate[] {
  return names
    .map(clean)
    .filter((n) => isPlausibleProductName(n) && isMoreSpecific(n, base))
    .map((name) => ({ name, kind: "variant" as const, sources: ["memory" as const], evidence: ["the model's memory"] }));
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** One key for "Xbox Series X 2 TB" and "xbox series x 2tb". */
export function candidateKey(name: string): string {
  return identityTokens(name).slice().sort().join(" ");
}

/**
 * Merges candidates from every source into one list: the same version named by several sources becomes one candidate with all of them. Memory-only candidates are KEPT in the list (so they
 * can be shown as "the model remembers this, no source says so") but flagged by having only the "memory" source. Order is deterministic: confirmed catalogue first, then the most sources,
 * then by name, so the same input gives the same list.
 */
export function mergeCandidates(...lists: Candidate[][]): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.kind}:${candidateKey(c.name)}`;
      const have = by.get(key);
      if (!have) {
        by.set(key, { ...c, sources: [...c.sources], evidence: [...c.evidence] });
        continue;
      }
      for (const s of c.sources) if (!have.sources.includes(s)) have.sources.push(s);
      for (const e of c.evidence) if (!have.evidence.includes(e)) have.evidence.push(e);
      if (c.support === "confirmed" || (!have.support && c.support)) have.support = c.support;
      if (c.name.length > have.name.length && identityTokens(c.name).length === identityTokens(have.name).length) have.name = c.name;
    }
  }
  const rank = (c: Candidate) => (c.support === "confirmed" ? 0 : 1);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.sources.length - a.sources.length || a.name.localeCompare(b.name));
}

export const isMemoryOnly = (c: Candidate) => c.sources.every((s) => s === "memory");

// ---- the one-source rule -------------------------------------------------------------------------------------------------------------------------------------------------

export type VariantDecision =
  | { action: "create"; why: string }
  | { action: "suggest"; why: string }
  | { action: "reject"; why: string };

const independentSources = (c: Candidate) => new Set(c.sources.filter((s) => s !== "memory")).size;
const distinctHosts = (v: VariantVerdict) => new Set(v.sources.filter((s) => s.sourceClass !== "marketplace").map((s) => s.host)).size;

/**
 * Whether a checked candidate becomes a Database entry. An entry needs more than one voice:
 *  - the evidence check says "verified" (the maker names it, or two independent non-marketplace sources do), or
 *  - the catalogue marks it "confirmed" and the evidence check supports it, or
 *  - it was named by two different kinds of source (e.g. eBay listings AND a catalogue) and the evidence check supports it, or
 *  - a real listing used the name.
 * A single source (one catalogue page, one retailer, eBay's specifics alone, the model's memory) is a SUGGESTION. A disproven name is rejected.
 */
export function decideVariant(c: Candidate, verdict: VariantVerdict | null): VariantDecision {
  if (verdict?.status === "disproven") return { action: "reject", why: `a source says it is not official: ${verdict.basis}` };
  if (c.sources.includes("listing") || c.sources.includes("user")) return { action: "create", why: "a real listing (or the person) uses this name" };
  if (!verdict || verdict.status === "unverified") {
    // eBay specifics and a confirmed catalogue together are two voices even before the page check is conclusive
    if (c.sources.includes("ebay_specifics") && c.support === "confirmed") return { action: "create", why: "eBay listings and a confirmed catalogue both name it" };
    return { action: "suggest", why: "no source confirms it yet" };
  }
  if (verdict.status === "verified") return { action: "create", why: "the maker or two independent sources name it" };
  // supported = one retailer / reference page names it. Real eBay listings that use the name are a second, independent voice (a different kind of source from a web page), but only when a
  // page states the WHOLE name (an eBay aspect value glued onto the base name is not enough by itself).
  if (c.sources.includes("ebay_specifics") && verdict.sources.some((s) => s.fullMatch && s.sourceClass !== "marketplace")) return { action: "create", why: "eBay listings use the name and a source page states it in full" };
  if (c.support === "confirmed" || independentSources(c) >= 2 || distinctHosts(verdict) >= 2) return { action: "create", why: "supported by the evidence check and a second source" };
  return { action: "suggest", why: "only one source names it, so it stays a suggestion until a second source or a listing confirms it" };
}

// ---- add-ons --------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The kinds of accessory a product's pages name. A closed list: a phrase only becomes an add-on candidate if it ends in one of these. */
const ADDON_NOUNS =
  "(?:Wireless Controller|Controller|Elite Controller|Adaptive Controller|Stereo Headset|Wireless Headset|Headset|Headphones|Storage Expansion Card|Expansion Card|Memory Card|External Hard Drive|Hard Drive|SSD|Charging Station|Charging Stand|Charging Dock|Charging Cable|Play (?:&|and) Charge Kit|Rechargeable Battery Pack|Battery Pack|Rechargeable Battery|Media Remote|Remote Control|Remote|Camera|Kinect Sensor|Keyboard|Mouse|Carrying Case|Case|Stand|Dock|Charger|Power Adapter|AC Adapter|HDMI Cable|Cable|Screen Protector|Grip|Skin|Faceplate|Backplate|Thumbstick|Docking Station|Webcam|Microphone|Steering Wheel|Flight Stick|Fight Stick|Arcade Stick|Stylus|Strap|Sleeve)";
const ADDON_RE = new RegExp(`((?:[A-Z][A-Za-z0-9'’+-]*[ \\t]){0,3})(${ADDON_NOUNS})\\b`, "g");
/** Words that make a phrase a sentence fragment, not an accessory's name. */
const FRAGMENT_START = /^(?:The|This|That|These|Those|With|And|Or|For|Your|Our|A|An|If|When|Includes?|Including|Comes?|Get|Buy|Add|Use|See|New|Free|Best|Top|Why|How|What|Also|Plus|Each|Every)\b/;

/** Navigation, ads, conditions and other platforms: a phrase containing one of these is not an accessory of this product. */
const ADDON_BANNED = /\b(?:cart|shop|shipping|ship|deal|deals|sale|black friday|cyber monday|coupon|offer|checkout|login|sign ?in|cloud gaming|game pass|remote play|windows|pc|mac|android|ios|used|open box|refurbished|renewed|pre-?owned|nintendo|switch|playstation|ps[2-5]|dualsense|dualshock|sony|steam deck|oculus|quest|iphone|ipad|samsung|google|all|new|free|best|top)\b/i;

export interface PageText {
  url: string;
  title?: string;
  text: string;
  /** "manufacturer" | "retailer" | "reference" | "marketplace" | "other" (SourceClass); marketplace pages are not used for add-ons. */
  sourceClass: string;
}

/**
 * Add-on names the pages of a product actually print ("Xbox Wireless Controller", "Seagate Storage Expansion Card"). Nothing comes from memory: a name needs to appear in a page that is not a
 * marketplace listing, at least twice across the pages (or once on a maker page), must end in a known accessory noun, and must not be a fragment of a sentence or the base product itself.
 * Names are kept as the pages print them; sorted by how often they appear, then by name.
 */
export function addonCandidatesFromPages(base: string, pages: PageText[], max = 8): Candidate[] {
  const baseKey = candidateKey(base);
  const anchorWord = (base.toLowerCase().match(/[a-z0-9]+/) ?? [""])[0];
  if (anchorWord.length < 3) return [];
  const anchorRe = new RegExp(`\\b${anchorWord}`, "i");
  const found = new Map<string, { name: string; count: number; hosts: Set<string>; maker: boolean; makerAnchored: boolean }>();
  for (const page of pages) {
    if (page.sourceClass === "marketplace") continue;
    const host = hostOf(page.url);
    for (const m of page.text.matchAll(ADDON_RE)) {
      // sentence words in front ("The", "Shop", "With") are dropped; what is left of the capitalised run is the accessory's brand / line ("Xbox")
      const leadWords = clean(m[1] ?? "").split(" ").filter(Boolean);
      while (leadWords.length > 0 && FRAGMENT_START.test(leadWords[0])) leadWords.shift();
      const name = clean(`${leadWords.join(" ")} ${m[2]}`);
      if (!isPlausibleProductName(name) || candidateKey(name) === baseKey || name.split(" ").length < 2) continue;
      if (kindOfName(name) !== "accessory") continue; // the same "is this an accessory" test the comparable-matching uses
      // marketing copy, navigation, condition words and OTHER platforms' accessories are not this product's add-ons
      if (ADDON_BANNED.test(name)) continue;
      const at = m.index ?? 0;
      const around = page.text.slice(Math.max(0, at - 60), at + m[0].length + 60);
      // it has to belong to THIS product: the name carries the product line ("Xbox Wireless Controller"), or the text right next to it says it is for / compatible with the product
      const inName = anchorRe.test(name);
      const anchored = inName || new RegExp(`\\b(?:for|compatible with|works with|designed for)\\s+(?:the\\s+)?(?:microsoft\\s+|sony\\s+|nintendo\\s+|apple\\s+)?${anchorWord}`, "i").test(around);
      if (!anchored) continue;
      const key = candidateKey(name);
      const have = found.get(key) ?? { name, count: 0, hosts: new Set<string>(), maker: false, makerAnchored: false };
      have.count++;
      have.hosts.add(host);
      if (page.sourceClass === "manufacturer") {
        have.maker = true;
        have.makerAnchored = true; // the maker's own page says it, next to this product (in the name or "for <product>")
      }
      if (name.length > have.name.length) have.name = name;
      found.set(key, have);
    }
  }
  // two mentions are needed even on a maker's page (one mention is a banner, a menu or an ad); with the product line IN the name and the maker saying it, once is enough
  return [...found.values()]
    .filter((f) => f.count >= 2 || (f.maker && f.makerAnchored))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((f) => ({ name: f.name, kind: "addon" as const, sources: ["catalogue" as const], support: f.maker || f.hosts.size >= 2 ? ("confirmed" as const) : ("reported" as const), evidence: [...f.hosts].slice(0, 3) }));
}

/** Words a listing puts IN FRONT of an extra ("Second Wireless Controller", "2 extra controllers", "spare battery"): a quantity or a condition, not part of the add-on's name. */
const LEADING_QUANTITY = /^(?:second|2nd|third|extra|additional|another|spare|bonus|free|original|genuine|official|oem|used|new|\d+x?|two|three|four|a|an|the|one)$/i;

/** Words that describe a KIND of accessory without naming one ("wireless controller", "expansion card"): a name made only of these has no brand or model of its own. */
const GENERIC_ACCESSORY_WORDS = new Set(
  "wireless stereo rechargeable charging battery pack card expansion storage memory external hard drive ssd remote control media carrying power adapter ac hdmi play charge kit screen protector controller controllers headset headphones dock station stand cable charger case camera keyboard mouse grip skin faceplate backplate thumbstick webcam microphone stylus strap sleeve".split(" ")
);
const singular = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") ? w.slice(0, -1) : w);

/**
 * A scanned listing's extra ("Second Wireless Controller") as an add-on candidate for the BASE product. A leading quantity / condition word is dropped; the seller's own brand and model words
 * are KEPT as written (digits inside a name stay: "Elite Series 2 Controller"); the product line is added ONLY when the name is nothing but generic words ("Wireless Controller" -> "Xbox
 * Wireless Controller"); a single generic noun ("controller", "case") is refused, and so is a list ("charger + 2 games"). The listing is its source.
 */
export function addonFromListing(name: string, listingId: string | null, baseName?: string): Candidate | null {
  const raw = clean(name);
  if (!raw || /[+,;&]|\band\b|\bwith\b/i.test(raw)) return null; // a list, not a name
  const words = raw.split(" ");
  while (words.length > 1 && LEADING_QUANTITY.test(words[0])) words.shift();
  if (words.length < 2) return null; // one generic noun is not an accessory's name
  words[words.length - 1] = singular(words[words.length - 1]);
  let n = words.join(" ");
  const anchor = baseName ? (baseName.match(/[A-Za-z0-9]+/) ?? [""])[0] : "";
  const allGeneric = words.every((w) => GENERIC_ACCESSORY_WORDS.has(w.toLowerCase()));
  if (anchor.length >= 3 && allGeneric && !new RegExp(`\\b${anchor}`, "i").test(n)) n =`${anchor} ${n}`;
  n = clean(n);
  if (!isPlausibleProductName(n) || kindOfName(n) !== "accessory" || ADDON_BANNED.test(n)) return null;
  return { name: n, kind: "addon", sources: ["listing"], evidence: [listingId ? `listing ${listingId}` : "a scanned listing"] };
}

const LOOSE_STOP = new Set(["microsoft", "xbox", "official", "genuine", "oem", "the", "for", "new", "a", "an", "of", "with", "and", "wireless"]);
const COLOUR_WORDS = new Set("black white red blue green yellow orange pink purple gray grey silver gold carbon shock robot pulse electric volt".split(" "));
const looseTokens = (name: string, dropColours: boolean) =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LOOSE_STOP.has(t) && !(dropColours && COLOUR_WORDS.has(t)))
    .map(singular);

/** One key for an accessory's name with the brand, "wireless" and plurals set aside (COLOURS STAY: a Pulse Red controller is its own entry): "Xbox Wireless Controller" and "Xbox Wireless Controllers" share it. */
export function addonEntryKey(name: string): string {
  return looseTokens(name, false).sort().join(" ");
}

/**
 * Whether two add-on names are the same accessory said differently. The distinguishing words (Elite, Adaptive, Stereo, a maker like Seagate) must match on both sides; the product line,
 * "wireless", colours and plurals do not matter. So dismissing "Xbox Wireless Controller" also blocks "Xbox Controller" and "Microsoft Xbox Wireless Controller - Carbon Black", but NOT
 * "Xbox Elite Wireless Controller" (a different product).
 */
export function sameAddonLoosely(a: string, b: string): boolean {
  const ka = looseTokens(a, true).sort().join(" ");
  return ka !== "" && ka === looseTokens(b, true).sort().join(" ");
}
