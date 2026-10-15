// Database discovery policy: which listings get a closer look, why one did not, and what a product may be filed under.
//
// Everything here is pure (no AI, no network, no store) so the rules can be tested on their own and ScrapeEngine only has to carry
// them out. See DATABASE_DISCOVERY_REPORT.md for the evidence behind each rule.
import type { ResearchDisposition, ResearchStatus } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------- budgets
// "Save OpenAI credits" (on by default) used to mean: a photo look only for listings the TEXT-ONLY AI had already liked. A listing whose
// title says nothing ("Gaming console works great") cannot be liked from its text, so it never got a look and never reached the
// Database, however good it was. A small, bounded number of extra looks per location visit lets those through without turning the
// credit saving off. Both numbers can be changed in config.json under "discovery".
export const DEFAULT_SPECULATIVE_LOOKS_PER_VISIT = 3;
export const DEFAULT_SPECULATIVE_LOOKS_PER_PASS = 30;
// Fresh market lookups (WatchCount + eBay) for a product the photos identified and the Database has no numbers for yet.
export const DEFAULT_MARKET_LOOKS_PER_VISIT = 2;
export const DEFAULT_MARKET_LOOKS_PER_PASS = 12;
// Below this a flip is not worth a photo look (eBay's cut and shipping eat it).
export const MIN_SPECULATIVE_PRICE_USD = 35;
// Same for a fresh market lookup on a product the photos named.
export const MIN_MARKET_LOOK_PRICE_USD = 35;

export interface DiscoverySettings {
  speculativeLooksPerVisit: number;
  speculativeLooksPerPass: number;
  marketLooksPerVisit: number;
  marketLooksPerPass: number;
}

export function discoverySettings(raw: { speculativeLooksPerLocation?: number; speculativeLooksPerPass?: number; marketLooksPerLocation?: number; marketLooksPerPass?: number } | null | undefined): DiscoverySettings {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    speculativeLooksPerVisit: n(raw?.speculativeLooksPerLocation, DEFAULT_SPECULATIVE_LOOKS_PER_VISIT),
    speculativeLooksPerPass: n(raw?.speculativeLooksPerPass, DEFAULT_SPECULATIVE_LOOKS_PER_PASS),
    marketLooksPerVisit: n(raw?.marketLooksPerLocation, DEFAULT_MARKET_LOOKS_PER_VISIT),
    marketLooksPerPass: n(raw?.marketLooksPerPass, DEFAULT_MARKET_LOOKS_PER_PASS),
  };
}

// ---------------------------------------------------------------------------------------------------------------- vague titles
const FILLER = new Set(
  (
    "a an the and or with for of in on to at by from used new like works working work great good excellent condition obo firm price sale sell selling must go " +
    "pickup pick up only local cash bundle box boxed open original owner clean tested perfect brand lot free shipping delivery no issues any comes asking " +
    "today tomorrow available cheap fast mint barely very nice lightly gently moving my your our this that it is are was has have had just need needs " +
    "please text message dm pm firm negotiable offers offer best now urgent obo read"
  ).split(" ")
);

// Words that name a kind of thing, not a product.
const GENERIC_NOUNS = new Set(
  (
    "console system unit item items stuff things thing misc miscellaneous household electronics electronic game games gaming computer pc laptop phone cellphone " +
    "tablet camera headphones headphone earbuds speaker speakers monitor tv television controller controllers handheld device gadget tool tools toy toys furniture " +
    "clothes clothing shoes dress shirt pants jacket bag bags cables cable charger vacuum machine equipment appliance accessory accessories parts"
  ).split(" ")
);

// Brands and product families that make a title specific on their own.
const BRANDS = new Set(
  (
    "apple iphone ipad ipod macbook imac airpods samsung galaxy sony playstation ps4 ps5 ps3 psp xbox microsoft surface nintendo switch wii gameboy " +
    "dell hp lenovo thinkpad asus acer msi razer alienware logitech corsair nvidia geforce rtx gtx radeon amd intel ryzen canon nikon fujifilm gopro dji " +
    "dyson bose jbl sennheiser beats anker garmin fitbit oculus meta quest valve steam deck lg panasonic toshiba sharp vizio roku amazon echo kindle " +
    "google pixel oneplus motorola nokia huawei xiaomi kitchenaid vitamix instant nespresso keurig shark roomba irobot bissell makita dewalt milwaukee " +
    "ryobi craftsman stihl husqvarna nike jordan adidas yeti traeger weber lego funko pokemon yugioh magic"
  ).split(" ")
);

const CAPACITY = /^\d+(\.\d+)?(gb|tb|mb|inch|in|oz|lb|lbs|ft|mm|cm|w|v|hz|k|mah|x)$/i;

/** True when nothing in the title tells one product from another ("Gaming console works great", "Selling my stuff", "Marcus"). */
export function titleIsVague(title: string): boolean {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w));
  if (meaningful.length === 0) return true;
  if (meaningful.some((w) => BRANDS.has(w))) return false;
  // a model-style token: letters and digits together ("v8", "wh-1000xm4", "t7"), not a plain capacity ("128gb")
  const hasModel = meaningful.some((w) => /[a-z]/.test(w) && /\d/.test(w) && !CAPACITY.test(w));
  if (hasModel) return false;
  return meaningful.every((w) => GENERIC_NOUNS.has(w) || w.length < 3) || meaningful.length <= 2;
}

// ---------------------------------------------------------------------------------------------------------------- the photo-look plan
export type LookPriority = 0 | 1 | 2 | 3;

export interface LookPlanInput {
  lowAiMode: boolean;
  photosEnabled: boolean;
  hasPhotos: boolean;
  // Whether any AI path to a photo look exists right now (a key, a signed-in session, and no limit reached).
  aiAvailable: boolean;
  title: string;
  price: number;
  // What the text read said.
  isDeal: boolean;
  matchedItem: string | null;
  confidence: "low" | "medium" | "high";
  category: string;
  judgeUnavailable: boolean;
  // A price that is not a multiple of 5 on a title that names nothing tracked or known. Never a reason to skip a listing; it only puts a
  // speculative look behind the others (priority 3).
  unremarkablePrice?: boolean;
  // Reasons that already justified a photo look before this change.
  greenFlag: boolean;
  watchCandidate: boolean;
  hiddenGem: boolean;
  // Budgets still available at this moment.
  speculativeLeftVisit: number;
  speculativeLeftPass: number;
}

export interface LookPlan {
  vision: boolean;
  // 0 a deal / near-match / hidden gem (cost is justified), 1 a Watch candidate, 2 a speculative look, 3 everything else (AI saving off).
  priority: LookPriority;
  speculative: boolean;
  // Why there is no photo look (undefined when there is one).
  skip?: ResearchDisposition;
  // Why a speculative look was chosen, for the Activity log.
  why?: string;
}

/**
 * Decides whether a listing earns a photo look. The first four reasons are the ones that always did; the speculative look is new:
 * a listing the text could not settle (vague title, unsure or unavailable AI read) is looked at within a small budget instead of
 * being dropped without anyone ever having seen what it is.
 */
export function planPhotoLook(i: LookPlanInput): LookPlan {
  if (!i.photosEnabled) return { vision: false, priority: 3, speculative: false, skip: { status: "unresearched", code: "PHOTOS_OFF", reason: "Photo analysis is turned off in Config, so only the title was read." } };
  if (!i.hasPhotos) return { vision: false, priority: 3, speculative: false, skip: { status: "insufficient_evidence", code: "NO_PHOTOS", reason: "The listing has no photos to look at, so only the title was read." } };
  const required = i.isDeal || i.greenFlag || i.hiddenGem;
  if (required) return aiGate(i, { vision: true, priority: 0, speculative: false });
  if (i.watchCandidate) return aiGate(i, { vision: true, priority: 1, speculative: false });
  // AI saving off: every listing with photos gets its look, as it always did.
  if (!i.lowAiMode) return aiGate(i, { vision: true, priority: 3, speculative: false });

  // AI saving on, and the text read did not flag it. Is this a listing the text could not settle?
  const matchedByKeyword = i.matchedItem !== null && i.confidence === "high" && !i.judgeUnavailable;
  const vague = titleIsVague(i.title);
  const unsure = i.judgeUnavailable || i.confidence === "low" || (vague && i.category.trim() === "");
  if (matchedByKeyword || !unsure) return { vision: false, priority: 3, speculative: false };
  if (i.price < MIN_SPECULATIVE_PRICE_USD) {
    return { vision: false, priority: 3, speculative: false, skip: { status: "unresearched", code: "LOW_PRICE", reason: `The title does not say what it is, and at $${i.price} a flip would not be worth a photo look.` } };
  }
  if (i.speculativeLeftVisit <= 0 || i.speculativeLeftPass <= 0) {
    return {
      vision: false,
      priority: 3,
      speculative: false,
      skip: {
        status: "unresearched",
        code: "LOOK_BUDGET",
        reason: `The title does not say what it is, and this ${i.speculativeLeftVisit <= 0 ? "location's" : "pass's"} allowance of extra photo looks was already used (a setting that saves your OpenAI credits).`,
      },
    };
  }
  const why = i.judgeUnavailable ? "the AI read of its text was unavailable" : vague ? "its title does not say what it is" : "the AI read of its text was unsure";
  return aiGate(i, { vision: true, priority: i.unremarkablePrice ? 3 : 2, speculative: true, why });
}

function aiGate(i: LookPlanInput, plan: LookPlan): LookPlan {
  if (i.aiAvailable) return plan;
  return {
    vision: false,
    priority: plan.priority,
    speculative: false,
    skip: { status: "insufficient_evidence", code: "AI_UNAVAILABLE", reason: "The AI service is unavailable right now (no key, a daily limit, or no connection), so the photos could not be looked at. This is not a rejection." },
  };
}

// ---------------------------------------------------------------------------------------------------------------- filing names
export type NameVerdict = { ok: true; name: string; changed: boolean } | { ok: false; code: string; reason: string };

const NECESSITY = /\b(ac adapter|a\/c adapter|power adapter|power supply|power cord|power cable|charging cable|charger|usb cable|hdmi cable|screen protector|tempered glass|carrying case|phone case|sensor bar|lanyard)\b/i;
// A parenthetical is dropped from a name only when it is plainly about the photo, the bundle, the quantity or the condition. A detail that tells
// products apart ("top-freezer style", "Black", "Limited Edition", "For Parts / Broken", "Jet Black with gold logo") stays.
const VIEW_PAREN = /\b(front|back|rear|side|top|bottom|three[- ]quarter|angled?)\s+(view|shot|photo|angle|side)\b|\b(close[- ]?up|closeup|photo|picture|image|pictured|shown)\b/i;
const BUNDLE_PAREN = /\b(bundle|includes?|including|comes with|plus)\b|\bw\/|\bwith\s+(?:a |an |the |two |three |four |\d+ )?(?:extra |spare |wireless |original )*(?:controllers?|games?|accessor(?:y|ies)|cables?|charger|dock|headset|remote|case|bag|kinect|stand|box)\b/i;
const QUANTITY_PAREN = /^\s*(?:pair|set|lot|pack|(?:set of )?\d+|x\d+|\d+\s*(?:pack|pcs|pieces))\s*$/i;
const CONDITION_PAREN = /^\s*(?:used|new|open(?:ed)? box|like new|good|great|excellent|mint|sealed|works|working|for sale|obo)(?:[ ,/-]+(?:used|new|condition|works|working|good|great|excellent))*\s*$/i;
const isAside = (inner: string) => VIEW_PAREN.test(inner) || BUNDLE_PAREN.test(inner) || QUANTITY_PAREN.test(inner) || CONDITION_PAREN.test(inner);
const GENERIC_SINGLE = new Set(
  "phone console controller laptop tablet headphones headphone camera game games tv computer iphone ipad xbox playstation nintendo android samsung apple sony microsoft speaker monitor watch".split(" ")
);

/** Cuts a name at the first ", " or " - " that is not inside parentheses ("Tarantula fursuit (head, 4 legs) - handmade" keeps its parentheses whole). */
function cutTopLevelClause(name: string): string {
  let depth = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === "," && name[i + 1] === " ") return name.slice(0, i).trim();
      if ((c === "-" || c === "–") && name[i - 1] === " " && name[i + 1] === " ") return name.slice(0, i).trim();
    }
  }
  return name;
}

/**
 * What a product may be filed under. The AI is told to name products canonically, but it has filed "iPhone (front view)", "Power
 * Adapter" and a whole bundle sentence as Database entries. Those become duplicates and poison valuations, so a name is cleaned of
 * view/bundle/condition wording, and refused when it names an accessory, is only a brand or a kind of thing, or is still a sentence.
 */
export function cleanFilingName(raw: string): NameVerdict {
  let name = String(raw ?? "")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return { ok: false, code: "NAME_EMPTY", reason: "The name is empty." };
  const original = name;
  // parenthetical wording about the photo, the bundle or the condition is not part of the product's name
  name = name.replace(/\s*\(([^)]*)\)/g, (m, inner: string) => (isAside(inner) ? "" : m)).replace(/\s+/g, " ").trim();
  // a trailing "- ..." or ", ..." clause (outside any parentheses) is the seller's wording
  name = cutTopLevelClause(name);
  if (NECESSITY.test(name)) return { ok: false, code: "NAME_ACCESSORY", reason: `"${original}" is a cable, charger, adapter or protector that comes with another product, not a product of its own.` };
  // ("Bundle" on its own is not refused: "Xbox Series S Fortnite Bundle" is a real retail product. A sentence about what comes with it is.)
  if (/\b(includes?|including|comes with)\b/i.test(name) || name.split(/\s+/).length > 14) return { ok: false, code: "NAME_NOT_CANONICAL", reason: `"${original}" reads like a description of a listing, not the name of one product.` };
  const words = name.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (name.length < 3 || (words.length === 1 && (GENERIC_SINGLE.has(words[0]) || GENERIC_NOUNS.has(words[0])))) {
    return { ok: false, code: "NAME_TOO_GENERIC", reason: `"${original}" only names a kind of thing, not which product it is.` };
  }
  return { ok: true, name, changed: name !== original };
}

// ---------------------------------------------------------------------------------------------------------------- wording of a disposition
export function disposition(status: ResearchStatus, code: string, reason: string): ResearchDisposition {
  return { status, code, reason };
}

const STATUS_WORDS: Record<ResearchStatus, string> = {
  unresearched: "not researched",
  insufficient_evidence: "not enough evidence",
  rejected: "rejected",
  confirmed_unprofitable: "unprofitable (confirmed)",
  researched: "researched",
};

/** "not researched [LOOK_BUDGET]: ...": the same wording everywhere, so skips can be searched and counted. */
export function dispositionText(d: ResearchDisposition): string {
  return `${STATUS_WORDS[d.status]} [${d.code}]: ${d.reason}`;
}

/** A line for the Activity log about one listing. */
export function describeDisposition(title: string, d: ResearchDisposition): string {
  return `${title} — ${dispositionText(d)}`;
}

/** The few words the Feed shows next to a listing that is not a deal. */
export function shortLabel(status: ResearchStatus | null): string | null {
  switch (status) {
    case "unresearched":
      return "Not researched";
    case "insufficient_evidence":
      return "Not enough evidence";
    case "rejected":
      return "Rejected";
    case "confirmed_unprofitable":
      return "Not profitable";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------- validating a dismissal
// A listing of a product the Database knows nothing about is judged by a text-only AI answering from memory. "Not a deal" from that is a guess. For a listing with credible upside
// (a specific product, a price worth a market lookup) the guess is checked against real numbers, within the same bounded market-lookup allowance the photo-first finds use.
export const MIN_VALIDATE_DISMISSED_PRICE_USD = 75;

export interface DismissalInput {
  price: number;
  title: string;
  matchedItem: string | null;
  isDeal: boolean;
  judgeUnavailable: boolean;
  offTopic: boolean;
  /** Market lookups left for this location visit and this pass. */
  lookLeftVisit: number;
  lookLeftPass: number;
  hasChecker: boolean;
}

export function shouldValidateDismissal(i: DismissalInput): boolean {
  if (!i.hasChecker || i.isDeal || i.matchedItem !== null || i.judgeUnavailable || i.offTopic) return false;
  if (i.price < MIN_VALIDATE_DISMISSED_PRICE_USD) return false;
  if (i.lookLeftVisit <= 0 || i.lookLeftPass <= 0) return false;
  return !titleIsVague(i.title);
}
