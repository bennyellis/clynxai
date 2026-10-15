// Beta 13: the ONE way a picture becomes part of a product's gallery. Before this, store.addProductImage was called from 13 places and only four asked whether the picture
// belonged (audit ID-01). Every writer now describes what it knows (the text that came with the picture, whether a picture check ran and what it said, who proposed it)
// and this decides: trusted (may be used as "what it looks like"), user (the person put it there), unverified (kept, not used as a reference), quarantined (something
// contradicts it: kept, dimmed, in the review queue, not used), rejected (not stored) or duplicate. Rules, in order:
//   1. a person's own photo is always kept ('user'); a contradiction is only a warning;
//   2. the words that came with the picture can say it is a different product, a game, an accessory: that is final, whatever a picture check said;
//   3. a gallery stays consistent in drive version, card design, region, lock, model code, capacity and edition (galleryConflict);
//   4. a picture check says yes => trusted; no => rejected/quarantined; cannot_tell => unverified;
//   5. with no picture check: an exact title => trusted; a title that confirms the core identity without leaving a colour/edition open => trusted;
//      anything else => unverified; no words at all => not stored (an image-search result nobody vouched for).
// A picture can confirm or contradict an identity that words propose. It never names a product.
import { createHash } from "node:crypto";
import { classifyComparable } from "./compIdentity.js";
import { galleryConflict } from "./identityModel.js";
import { judgeCandidateByText } from "./photoIdentity.js";
import type { Beta13Mode } from "./beta13.js";
import type { ImageStatus, ProductImage, ProductProfile } from "./types.js";

export interface FileImageEvidence {
  sourceKind: "listing" | "ebay" | "web" | "wikipedia" | "stock" | "user" | "moved";
  /** The words that came with the picture (a listing / eBay title, a Wikipedia article title), or null. */
  title: string | null;
  url?: string | null;
  /** Which code path proposed it ("scanner", "reference-search", "free-search", "gallery-audit", "feedback", "manual", ...). */
  proposer: string;
  /** What a picture check said: null = none was run. */
  picture?: { verdict: "yes" | "no" | "cannot_tell"; reason?: string | null } | null;
  userAuthored?: boolean;
  kind?: "normal" | "poor_condition";
  /** Store it as 'unverified' even with no words at all (a deliberately searched damaged example). */
  allowUntitled?: boolean;
  /** The picture is already in the Library (a move): a contradiction quarantines it instead of refusing it. */
  existingImage?: boolean;
}

export type FilingOutcome = "trusted" | "user" | "unverified" | "quarantined" | "rejected" | "duplicate";
export interface FilingDecision {
  outcome: FilingOutcome;
  reasons: string[];
}

export function decideFiling(productName: string, evidence: FileImageEvidence, referenceTitles: string[]): FilingDecision {
  const text = judgeCandidateByText(productName, evidence.title);
  if (evidence.userAuthored) {
    return { outcome: "user", reasons: text.status === "mismatch" ? [`you added it; note the title says otherwise: ${text.reasons[0] ?? ""}`] : [] };
  }
  const contradict = (reasons: string[]): FilingDecision => ({ outcome: evidence.existingImage ? "quarantined" : "rejected", reasons });
  if (text.status === "mismatch") return contradict(text.reasons);
  const conflict = evidence.title ? galleryConflict(referenceTitles, evidence.title) : null;
  if (conflict) return { outcome: "quarantined", reasons: [conflict] };
  const pic = evidence.picture;
  if (pic?.verdict === "no") return contradict(["the picture does not show this product" + (pic.reason ? `: ${pic.reason}` : "")]);
  if (pic?.verdict === "yes") return { outcome: "trusted", reasons: [] };
  if (pic?.verdict === "cannot_tell") return { outcome: "unverified", reasons: ["the picture could not settle it" + (pic.reason ? `: ${pic.reason}` : "")] };
  // no picture check ran
  if (text.status === "match") return { outcome: "trusted", reasons: [] };
  if (!evidence.title) return evidence.allowUntitled || evidence.existingImage ? { outcome: "unverified", reasons: ["no words came with it and no picture check ran"] } : { outcome: "rejected", reasons: ["no words came with it and no picture check ran"] };
  if (text.strength === "compatible") {
    const open = classifyComparable({ name: productName }, evidence.title).reasons.filter((r) => r.code === "COLOR_NOT_STATED" || r.code === "EDITION_NOT_STATED");
    if (!open.length) return { outcome: "trusted", reasons: [] };
    return { outcome: "unverified", reasons: [`the title leaves the ${open.map((r) => r.code === "COLOR_NOT_STATED" ? "colour" : "edition").join(" and ")} open and no picture check ran`] };
  }
  return { outcome: "unverified", reasons: text.reasons.length ? text.reasons : ["the title does not confirm it"] };
}

export interface FileImageStore {
  getProductById(id: string): ProductProfile | null;
  addProductImage(productId: string, imageData: string, sourceTitle: string | null, kind?: "normal" | "poor_condition", extra?: { status?: ImageStatus; sourceKind?: string | null; sourceUrl?: string | null; contentHash?: string | null; verdictJson?: string | null }): ProductImage;
  listReferenceTitles?(productId: string): string[];
  findImageByHash?(productId: string, hash: string): ProductImage | null;
  addReviewItem?(item: { kind: "image" | "product" | "merge"; subjectId: string; reasons: string[]; evidence: Record<string, unknown> }): string;
}

export interface FileImageResult {
  outcome: FilingOutcome;
  reasons: string[];
  image: ProductImage | null;
}

export function contentHashOf(imageData: string): string {
  return createHash("sha1").update(imageData).digest("hex");
}

let record: ((d: { kind: string; subject: string; verdict: string; thought: string; imageDataUri?: string | null }) => void) | null = null;
/** index.ts hands in aiDecisionLog.noteDecision so this module stays free of sharp/Electron imports (tests, scripts). */
export function setFilingRecorder(fn: typeof record): void {
  record = fn;
}

export function fileImage(store: FileImageStore, productId: string, imageData: string, evidence: FileImageEvidence, opts: { mode: Beta13Mode } = { mode: "enforce" }): FileImageResult {
  const product = store.getProductById(productId);
  const kind = evidence.kind ?? "normal";
  const hash = contentHashOf(imageData);
  const dupe = store.findImageByHash?.(productId, hash) ?? null;
  if (dupe) return { outcome: "duplicate", reasons: ["already in this gallery"], image: dupe };
  const extra = { sourceKind: evidence.sourceKind, sourceUrl: evidence.url ?? null, contentHash: hash };
  if (!product || opts.mode === "off") {
    const image = store.addProductImage(productId, imageData, evidence.title, kind, { ...extra, status: evidence.userAuthored ? "user" : "legacy" });
    return { outcome: evidence.userAuthored ? "user" : "unverified", reasons: [], image };
  }
  const decision = decideFiling(product.name, evidence, store.listReferenceTitles?.(productId) ?? []);
  record?.({ kind: "identity_gate", subject: `${evidence.title ?? "(no title)"} -> ${product.name}`, verdict: `${opts.mode === "shadow" ? "would be " : ""}${decision.outcome}`, thought: `${evidence.proposer}: ${decision.reasons.join("; ") || "title and picture agree"}`, imageDataUri: kind === "normal" ? imageData : null });
  if (opts.mode === "shadow") {
    // record only: store the way it always was
    const image = store.addProductImage(productId, imageData, evidence.title, kind, { ...extra, status: evidence.userAuthored ? "user" : "legacy" });
    return { outcome: decision.outcome, reasons: decision.reasons, image };
  }
  if (decision.outcome === "rejected") return { outcome: "rejected", reasons: decision.reasons, image: null };
  const status: ImageStatus = decision.outcome === "trusted" ? "trusted" : decision.outcome === "user" ? "user" : decision.outcome === "quarantined" ? "quarantined" : "unverified";
  const image = store.addProductImage(productId, imageData, evidence.title, kind, { ...extra, status, verdictJson: JSON.stringify({ outcome: decision.outcome, reasons: decision.reasons, proposer: evidence.proposer, picture: evidence.picture ?? null }) });
  if (decision.outcome === "quarantined") {
    store.addReviewItem?.({ kind: "image", subjectId: image.id, reasons: decision.reasons, evidence: { productId, productName: product.name, sourceTitle: evidence.title, proposer: evidence.proposer } });
  }
  return { outcome: decision.outcome, reasons: decision.reasons, image };
}
