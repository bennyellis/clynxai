// Beta 13: the attributes of "what is this product" that the older comparable-sale model could not see - optical drive (disc vs all-digital), board design (a GPU's
// partner line: MSI Gaming X Trio vs Ventus), region, carrier lock and manufacturer SKU codes - plus the rule that a gallery must stay consistent in them.
// Each attribute has a materiality class (see MATERIALITY): VALUE attributes make a different entry for pictures and a different comparable sale; COSMETIC ones
// (colour) only matter when the product's own name or an edition ties them to the product. Pure (no I/O), no product list: it reads the words of a name.
import { capacityTokens } from "./compFilter.js";
import { extractVariantAttributes } from "./variantIdentity.js";

export type AttributeKey = "drive" | "boardDesign" | "region" | "lock" | "sku" | "capacity" | "edition";
export type Materiality = "identity" | "value" | "cosmetic" | "listing";

/** Which class each attribute is in (documentation + used by the gallery rule): identity > value > cosmetic > listing-level. */
export const MATERIALITY: Record<string, Materiality> = {
  manufacturer: "identity", family: "identity", model: "identity", generation: "identity", tier: "identity",
  drive: "value", boardDesign: "value", region: "value", lock: "value", sku: "value", capacity: "value", edition: "value",
  colorFinish: "cosmetic", condition: "listing", accessories: "listing", bundle: "listing",
};

export interface IdentityAttributes {
  drive: "disc" | "digital" | null;
  boardDesigns: string[];
  region: "us" | "other" | null;
  regionWords: string[];
  lock: "unlocked" | "carrier" | null;
  skuCodes: string[];
  isGpu: boolean;
}

const DIGITAL = /\b(?:all[- ]?digital|digital(?! (?:code|download|copy|key|camera|watch|display|only game))|no disc(?: drive)?|without (?:a )?disc(?: drive)?|disc[- ]?less)\b/i;
// Console lines that are sold both with and without a disc drive (a small stable fact, not a product list for matching): the PlayStation 5, Xbox Series X and Xbox One S.
const DUAL_DRIVE_LINES = /\b(?:ps ?5|playstation ?5|xbox series x|series x|xbox one s|ps ?4|playstation ?4)\b/i;
const DISC = /\b(disc (?:drive|edition|version)|with (?:a )?disc|blu-?ray|uhd disc|disc[- ]based|standard edition)\b/i;
// Only on graphics-card names: a partner line is a different cooler, shroud and often fan count.
const GPU = /\b(?:rtx|gtx|rx|arc|radeon|geforce)\s?-?\d{3,4}|\bgraphics card\b|\bvideo card\b/i;
const BOARD_LINES: Array<[string, RegExp]> = [
  ["msi-gaming", /\bgaming (?:x|z|trio|slim)\b|\bgaming x trio\b/i],
  ["msi-ventus", /\bventus\b/i], ["msi-armor", /\barmor\b/i], ["msi-suprim", /\bsuprim\b/i],
  ["asus-strix", /\bstrix\b/i], ["asus-tuf", /\btuf\b/i], ["asus-dual", /\bdual\b/i], ["asus-rog", /\brog\b(?!\s*strix)/i],
  ["gigabyte-eagle", /\beagle\b/i], ["gigabyte-aorus", /\baorus\b/i], ["gigabyte-windforce", /\bwindforce\b/i], ["gigabyte-gaming-oc", /\bgaming oc\b/i],
  ["evga-xc", /\bxc3?\b/i], ["evga-ftw", /\bftw3?\b/i], ["evga-kingpin", /\bkingpin\b/i],
  ["xfx-merc", /\bmerc\b/i], ["powercolor-hellhound", /\bhellhound\b/i], ["powercolor-reddevil", /\bred devil\b/i], ["sapphire-nitro", /\bnitro\+?\b/i], ["sapphire-pulse", /\bpulse\b/i],
  ["asrock-taichi", /\btaichi\b/i], ["asrock-phantom", /\bphantom\b/i], ["asrock-challenger", /\bchallenger\b/i], ["asrock-steel", /\bsteel legend\b/i],
  ["zotac-twin", /\btwin edge\b/i], ["zotac-amp", /\bamp(?: extreme)?\b/i], ["pny-xlr8", /\bxlr8\b/i], ["inno3d-ichill", /\bichill\b/i],
  ["nvidia-founders", /\bfounders edition\b/i], ["reference", /\breference (?:design|model)\b|\bblower\b|\bturbo\b/i],
];
// Hyphenated manufacturer codes: HAC-001, CFI-1215A, SM-G991U. A bare number is not read as a SKU.
const SKU = /\b([a-z]{2,5})-(\d{3,5}[a-z]?)\b/gi;
const US_WORDS = new Set(["us", "usa", "ntsc"]);
const OTHER_REGION_WORDS = new Set(["jp", "jpn", "japan", "japanese", "asia", "asian", "pal", "eu", "euro", "european", "uk", "korea", "korean", "australia", "australian", "import"]);
const CARRIERS = /\b(verizon|at&t|att|t-mobile|tmobile|sprint|cricket|metro ?pcs|boost mobile|tracfone|straight talk|carrier[- ]locked|locked to)\b/i;
const UNLOCKED = /\b(?:factory )?unlocked\b/i;

export function extractIdentityAttributes(text: string): IdentityAttributes {
  const t = String(text ?? "");
  const digital = DIGITAL.test(t);
  const disc = !digital && DISC.test(t);
  const isGpu = GPU.test(t);
  const boardDesigns = isGpu ? BOARD_LINES.filter(([, re]) => re.test(t)).map(([name]) => name) : [];
  const regionWords = extractVariantAttributes(t).regions;
  const hasOther = regionWords.some((w) => OTHER_REGION_WORDS.has(w));
  const hasUs = regionWords.some((w) => US_WORDS.has(w));
  const skuCodes: string[] = [];
  for (const m of t.matchAll(SKU)) skuCodes.push(`${m[1].toLowerCase()}-${m[2].toLowerCase()}`);
  return {
    drive: digital ? "digital" : disc ? "disc" : null,
    boardDesigns,
    region: hasOther ? "other" : hasUs ? "us" : null,
    regionWords,
    lock: UNLOCKED.test(t) ? "unlocked" : CARRIERS.test(t) ? "carrier" : null,
    skuCodes: [...new Set(skuCodes)],
    isGpu,
  };
}

export type AttributeCode = "DRIVE" | "BOARD_DESIGN" | "BOARD_DESIGN_NOT_STATED" | "REGION" | "LOCK" | "SKU";
export interface AttributeFinding {
  code: AttributeCode;
  verdict: "rejected" | "uncertain";
  text: string;
}

/** What `title` says about the new attributes that contradicts (or leaves open) what `reference` (a product's name) states. Missing information is uncertainty at most. */
export function attributeFindings(reference: string, title: string): AttributeFinding[] {
  const ref = extractIdentityAttributes(reference);
  const got = extractIdentityAttributes(title);
  const out: AttributeFinding[] = [];

  // optical drive: a digital-only console is a different product from the disc model. An entry that says nothing is the standard (disc) model ONLY for the lines that
  // ship in both versions (DUAL_DRIVE_LINES): the Series S is digital-only by design, so its "Digital Edition" titles are not a contradiction.
  if (got.drive === "digital" && ref.drive !== "digital" && (ref.drive === "disc" || DUAL_DRIVE_LINES.test(reference))) out.push({ code: "DRIVE", verdict: "rejected", text: "the title is the all-digital (no disc drive) version" });
  else if (got.drive === "disc" && ref.drive === "digital") out.push({ code: "DRIVE", verdict: "rejected", text: "the title has a disc drive and the product is the all-digital version" });

  // board design: only graphics cards
  if (ref.isGpu || got.isGpu) {
    if (ref.boardDesigns.length && got.boardDesigns.length && !ref.boardDesigns.some((d) => got.boardDesigns.includes(d))) {
      out.push({ code: "BOARD_DESIGN", verdict: "rejected", text: `a different card design (${got.boardDesigns.join("/")} instead of ${ref.boardDesigns.join("/")})` });
    } else if (ref.boardDesigns.length && !got.boardDesigns.length) {
      out.push({ code: "BOARD_DESIGN_NOT_STATED", verdict: "uncertain", text: `the title does not say which card design it is (the product is ${ref.boardDesigns.join("/")})` });
    }
  }

  // region: an entry that states none is the US model
  if (got.region === "other" && ref.region !== "other") out.push({ code: "REGION", verdict: "rejected", text: `a different region model (${got.regionWords.join("/")})` });
  else if (ref.region === "other" && got.region !== "other") out.push({ code: "REGION", verdict: "rejected", text: "the product is a non-US model and the title is not" });

  // carrier lock
  if (ref.lock === "unlocked" && got.lock === "carrier") out.push({ code: "LOCK", verdict: "rejected", text: "the title is carrier-locked and the product is unlocked" });
  else if (ref.lock === "carrier" && got.lock === "unlocked") out.push({ code: "LOCK", verdict: "rejected", text: "the title is unlocked and the product is carrier-locked" });
  else if (ref.lock === null && got.lock === "carrier") out.push({ code: "LOCK", verdict: "uncertain", text: "the title is carrier-locked (worth less than an unlocked one)" });

  // manufacturer codes: same prefix, different number = a different hardware model
  for (const r of ref.skuCodes) {
    const prefix = r.split("-")[0];
    const sameFamily = got.skuCodes.filter((g) => g.startsWith(prefix + "-"));
    if (sameFamily.length && !sameFamily.includes(r)) out.push({ code: "SKU", verdict: "rejected", text: `model code ${sameFamily.join("/")} instead of ${r}` });
  }
  return out;
}

/**
 * A gallery must stay consistent in the VALUE attributes. `existingTitles` are the source titles of photos already trusted in the entry; `candidateTitle` is the new
 * photo's. Returns a reason when the candidate states a value for an attribute that every existing photo states differently ("the photos here are the Ventus card,
 * this one is the Gaming X Trio"). Nothing existing, or nothing stated on one side = no conflict.
 */
export function galleryConflict(existingTitles: string[], candidateTitle: string): string | null {
  if (!candidateTitle.trim()) return null;
  const cand = extractIdentityAttributes(candidateTitle);
  const candCaps = capacityTokens(candidateTitle);
  const candEd = extractVariantAttributes(candidateTitle).editionTerms;
  const have = existingTitles.filter((t) => t && t.trim());
  if (!have.length) return null;
  const attrs = have.map((t) => ({ a: extractIdentityAttributes(t), caps: capacityTokens(t), ed: extractVariantAttributes(t).editionTerms }));
  const allDiffer = <T,>(stated: (x: (typeof attrs)[number]) => T[], mine: T[]): boolean => {
    if (!mine.length) return false;
    const there = attrs.map(stated).filter((s) => s.length > 0);
    return there.length > 0 && there.every((s) => !s.some((v) => mine.includes(v)));
  };
  if (allDiffer((x) => (x.a.drive ? [x.a.drive] : []), cand.drive ? [cand.drive] : [])) return "a different drive version (disc vs all-digital) than the photos already here";
  if (allDiffer((x) => x.a.boardDesigns, cand.boardDesigns)) return `a different card design (${cand.boardDesigns.join("/")}) than the photos already here`;
  if (allDiffer((x) => (x.a.region ? [x.a.region] : []), cand.region ? [cand.region] : [])) return "a different region model than the photos already here";
  if (allDiffer((x) => (x.a.lock ? [x.a.lock] : []), cand.lock ? [cand.lock] : [])) return "a different lock state than the photos already here";
  if (allDiffer((x) => x.a.skuCodes, cand.skuCodes)) return `a different model code (${cand.skuCodes.join("/")}) than the photos already here`;
  if (allDiffer((x) => x.caps, candCaps)) return `a different capacity (${candCaps.join("/")}) than the photos already here`;
  if (allDiffer((x) => x.ed, candEd)) return `a different edition (${candEd.join("/")}) than the photos already here`;
  return null;
}
