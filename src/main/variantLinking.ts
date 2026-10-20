// A verified edition belongs under its base product, and carries the name the evidence gives it. Live test: "Xbox Series X Galaxy Edition" was verified from microsoft.com / xbox.com
// ("XBOX Series X 2TB Galaxy Black Special Edition") but kept the typed words, had no parent, and the plain "Xbox Series X" entry created afterwards was not connected to it.
// Pure: the Database rows are passed in; nothing here writes.
import { nameScore } from "./variantEvidence.js";
import { findParentCandidate, identityTokens } from "./variantIdentity.js";
import { isPlausibleProductName } from "./variantFanout.js";

/** The evidence's own name for the product when it is a clean, short title that names every word of the claim ("Xbox Series X Galaxy" -> "Xbox Series X 2TB Galaxy Black Special Edition"). */
export function cleanOfficialName(name: string | undefined | null, claim: string): string | null {
  if (!name) return null;
  let cleaned = name.replace(/\s+/g, " ").replace(/^[\W_]+|[\W_]+$/g, "").trim();
  // A page title carries its site on the end ("... | xbox.com", "... - Wikipedia", "... - Microsoft Store"): the site is not part of the name.
  const siteTail = /^(.{6,}?)\s+[|–—-]\s+([^|–—]{2,40})$/.exec(cleaned);
  if (siteTail && /\.(?:com|net|org|co|io|us|uk|ca|de)\b|wikipedia|store|shop|official|support|reddit|youtube|amazon|ebay|walmart|best ?buy|target|news|forum|wiki|catalog|database/i.test(siteTail[2])) cleaned = siteTail[1].trim();
  if (cleaned.length < claim.length - 2 || cleaned.length > 90 || /[<>{}\[\]]/.test(cleaned)) return null;
  // Words that make it a PAGE about the product ("... review", "... specs", "gallery image 3 of 5", "... box art"), not the product's name.
  if (/\b(?:reviews?|specs?|specifications|photos?|screenshots?|gallery|box art|unboxing|release date|price|prices|vs\.?|versus|how to|guide|faq)\b/i.test(cleaned) && !/\b(?:reviews?|specs?|specifications|photos?|screenshots?|gallery|box art|unboxing|release date|price|prices|vs\.?|versus|how to|guide|faq)\b/i.test(claim)) return null;
  // A picture caption or a page fragment is not a product name ("Back panel of XBOX Series X 2TB Galaxy Black Special Edition" was adopted in the Beta 27 live test): a name must open with the
  // same word the typed name opens with (the brand or product line), and must not describe a photo or a part of the product. A maker's name in front is the normal case ("Microsoft Xbox Series X",
  // "Apple iPhone 15 Pro Max", "Valve Steam Deck OLED"): it counts when the words after it open the way the typed name does, in either direction.
  const firstWord = (s: string) => (s.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const MAKER_PREFIX = /^(?:microsoft|apple|valve|sony|samsung|nintendo|google|lenovo|asus|dell|hp|logitech|razer|bose|jbl|dyson|kitchenaid|dewalt|canon|nikon|gopro|fitbit|garmin|meta|oculus|amazon|steelseries|corsair|nvidia|amd|intel)\s+/i;
  const afterMaker = (s: string) => s.replace(MAKER_PREFIX, "");
  const sameOpening = firstWord(cleaned) === firstWord(claim) || firstWord(afterMaker(cleaned)) === firstWord(claim) || firstWord(cleaned) === firstWord(afterMaker(claim)) || firstWord(afterMaker(cleaned)) === firstWord(afterMaker(claim));
  if (!firstWord(cleaned) || !sameOpening) return null;
  if (/\b(?:photo|image|picture|screenshot|view|pic)\s+of\b|\b(?:back|front|side|top|bottom|rear|inside|close-?up)\s+(?:panel|view|side|shot|of)\b|\bsee\s+(?:more|all)\b|\bclick\b|\bshop\b|\bbuy\b/i.test(cleaned)) return null;
  if (!isPlausibleProductName(cleaned)) return null; // unbalanced brackets, a dangling connector: a text fragment, not a name
  const have = new Set(identityTokens(cleaned));
  // It has to read like a product name (not a caption or a button) and hold every word of the claim.
  return nameScore(cleaned, claim) >= 0 && identityTokens(claim).every((t) => have.has(t)) ? cleaned : null;
}

/**
 * The name to adopt for a product whose evidence found an official one, or null to keep the current name: the product's name is not locked by the person, the official name is a clean
 * title that holds every word the current name has, it is not already another product's name, and it actually differs.
 */
export function adoptOfficialName(current: string, officialName: string | undefined | null, nameLocked: boolean, nameTaken: (name: string) => boolean): string | null {
  if (nameLocked) return null;
  const cleaned = cleanOfficialName(officialName, current);
  if (!cleaned || cleaned.toLowerCase() === current.trim().toLowerCase()) return null;
  return nameTaken(cleaned) ? null : cleaned;
}

export interface LinkRow {
  id: string;
  name: string;
  parentId: string | null;
  /** The evidence status kept on the product: "verified", "supported", ... or null. */
  evidenceStatus: string | null;
}

/**
 * Which products should be linked under which base: a product with confirmed evidence (verified or supported) and no parent, whose words contain a less specific product's words
 * (findParentCandidate also refuses accessories, other tiers, and anything contradicting a color or capacity). Run after any research finishes, so a plain "Xbox Series X" created
 * AFTER the edition still picks it up.
 */
export function planParentLinks(rows: LinkRow[]): Array<{ childId: string; parentId: string }> {
  const plan: Array<{ childId: string; parentId: string }> = [];
  for (const child of rows) {
    if (child.parentId) continue;
    if (child.evidenceStatus !== "verified" && child.evidenceStatus !== "supported") continue;
    const parent = findParentCandidate(
      child.name,
      rows.filter((r) => r.id !== child.id && r.parentId !== child.id)
    );
    if (parent) plan.push({ childId: child.id, parentId: parent.id });
  }
  return plan;
}
