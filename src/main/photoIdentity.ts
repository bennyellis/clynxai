// Beta 12 — ONE product-identity gate for every image that may be filed under a Database product, built on the comparable-sale identity model (compIdentity.ts) so reference photos,
// Search For variants and comparable sales cannot disagree about what a product is. Pure (no I/O).
//
// Why: Clynx accepted a photo of "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition" (an Xbox video game) for the Xbox Series X Galaxy Black Edition console. The shared word
// "Galaxy" and the platform name satisfied a bag-of-words check, and the vision prompt even allowed "cover art". A candidate now ends in exactly one of three states:
//   match         the evidence says it is this product (an exact title match, or a vision check that said yes);
//   mismatch      the evidence contradicts it (a game or accessory for the product, another model / generation / tier / edition / color / capacity): rejected without any AI call;
//   insufficient  nothing says either way (an image search result has no title): it needs the vision check, and WITHOUT one it is not filed. Insufficient never becomes a match.
import { classifyComparable, type CompJudgement } from "./compIdentity.js";
import { accessorySignal, kindOfName, mediaSignal } from "./productKind.js";

export { kindOfName, mediaSignal, type ItemKind } from "./productKind.js";

export type IdentityStatus = "match" | "mismatch" | "insufficient";

export interface IdentityVerdict {
  status: IdentityStatus;
  /** Where the verdict came from. */
  basis: "title" | "vision" | "none";
  reasons: string[];
  /** How completely the title confirmed the product when the verdict came from a title: "exact", "compatible" (nothing contradicts, an unstated attribute barely moves the price), "uncertain" or "none" (no title). */
  strength: "exact" | "compatible" | "uncertain" | "none";
}

function reasonsOf(j: CompJudgement): string[] {
  return j.reasons.map((r) => `${r.code.toLowerCase().replace(/_/g, " ")}: ${r.text}`);
}

// Reasons that mean "this is a different thing", as opposed to "the title just doesn't say".
const HARD = new Set(["MODEL_NUMBER", "MODEL_LETTER", "GENERATION", "TIER", "CAPACITY", "COLOR", "EDITION", "ACCESSORY", "LOT_OR_BUNDLE", "NOT_WORKING", "MEDIA"]);

/**
 * The verdict from TEXT alone: the product's name against the words that came with the image (an eBay listing's title, a Wikipedia article's title).
 * With no text there is nothing to judge: insufficient.
 */
export function judgeCandidateByText(productName: string, candidateText: string | null | undefined): IdentityVerdict {
  const text = String(candidateText ?? "").trim();
  if (!text) return { status: "insufficient", basis: "none", reasons: ["the image came with no title to check"], strength: "none" };
  const productKind = kindOfName(productName);
  const media = mediaSignal(text);
  if (media && productKind !== "game") return { status: "mismatch", basis: "title", reasons: [`media: the title reads as a game or software for a platform ("${media}"), not the product`], strength: "none" };
  // The title is ABOUT an accessory (its head names a controller, a case...) and the product is not one.
  const acc = accessorySignal(text);
  if (acc && productKind === "hardware") return { status: "mismatch", basis: "title", reasons: [`accessory: the title is about a "${acc}", something for the product, not the product`], strength: "none" };
  const j = classifyComparable({ name: productName }, text);
  const hard = j.reasons.filter((r) => HARD.has(r.code));
  if (j.verdict === "rejected" && hard.length) return { status: "mismatch", basis: "title", reasons: reasonsOf({ verdict: j.verdict, reasons: hard }), strength: "none" };
  if (j.verdict === "exact") return { status: "match", basis: "title", reasons: [], strength: "exact" };
  // compatible / uncertain: the title does not contradict, but does not confirm every attribute the product states (an unstated color or edition is not the same product's photo)
  return { status: "insufficient", basis: "title", reasons: reasonsOf(j), strength: j.verdict === "compatible" ? "compatible" : "uncertain" };
}

/**
 * Folds a vision verdict into a text verdict. A mismatch from the text stands whatever the picture says (deterministic rejection); a text match needs no picture; an insufficient
 * one is decided by the picture, and a vision error (no key, a timeout, an unreadable answer) leaves it insufficient: it is NOT filed.
 */
export function withVision(text: IdentityVerdict, vision: { matches: boolean; error: string | null } | null): IdentityVerdict {
  if (text.status !== "insufficient") return text;
  if (!vision || vision.error) return { status: "insufficient", basis: text.basis, strength: text.strength, reasons: [...text.reasons, vision?.error ? `the picture could not be checked (${vision.error.slice(0, 80)})` : "no picture check was available"] };
  return vision.matches ? { status: "match", basis: "vision", strength: text.strength, reasons: text.reasons } : { status: "mismatch", basis: "vision", strength: text.strength, reasons: [...text.reasons, "the picture does not show this product"] };
}

/** Does the text alone already decide (so no vision call is worth paying for)? */
export function needsPicture(v: IdentityVerdict): boolean {
  return v.status === "insufficient";
}

/**
 * What to tell a vision model about the kind of thing the product is, so a game box, a poster, a figure or an accessory that only shares a word cannot pass for a console.
 */
export function visionKindHint(productName: string): string {
  const kind = kindOfName(productName);
  if (kind === "game") return "";
  if (kind === "accessory") return " The product is an accessory; reject the main device it goes with unless that is what the name says, and reject video games or software that merely name the platform.";
  return " The product is a physical hardware device. Reject video games, game cases or covers, discs, software, DLC, soundtracks, posters, books, trading cards, toys or figures, apparel and other merchandise, and any image of a different product, even when its title or cover shares a word with the product name or names the same platform (a game titled with the word in the name, or marked 'Xbox Series X', is a game, not the console).";
}

/** A listing's photo may be filed under an existing Database product only when nothing about the listing contradicts that product. */
export function listingMayFeedProduct(productName: string, listingTitle: string): boolean {
  return judgeCandidateByText(productName, listingTitle).status !== "mismatch";
}

/** Without a picture check (Save-credits mode) only a title that confirms the product - exactly, or with nothing contradicting and the core identity confirmed - may file an image. */
export function fileableWithoutPicture(v: IdentityVerdict): boolean {
  return v.status === "match" || (v.status === "insufficient" && v.strength === "compatible");
}

/** The title carried by a candidate's label ("eBay listing photo — <title>", "eBay listing: <title>"), or null for a label that only says where it came from. */
export function titleFromLabel(label: string): string | null {
  const m = /^eBay listing(?: photo)?\s*(?:—|-|:)\s*(.+)$/i.exec(label.trim());
  return m ? m[1].trim() : null;
}
