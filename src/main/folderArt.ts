// Library folder pictures. Three honest sources, always recorded as such:
//   ai_generated   a picture generated from the folder's WHOLE path ("Video Games & Consoles > Nintendo > Consoles" = Nintendo console hardware). Decorative only.
//   auto           a photo of one of the folder's own products, chosen only when it is the right KIND of product for the folder (hardware for a console folder, never a game).
//   placeholder    nothing suitable yet; the Library draws its own placeholder.
// and two the person decides (user_upload, user_selected), which automation never replaces.
//
// A folder picture lives in folder_meta, a table of its own. It is never written to product_images, so it can never be filed as a product's reference photo, shown to the
// photo checker, or used as a label for what a real product looks like. This file does no database or network work itself: both are passed in.
import sharp from "sharp";
import { folderMeaning, type FolderMeaning, type FolderWants } from "./folderKeys.js";
import { kindOfName } from "./productKind.js";

export const FOLDER_IMAGE_MAX_CHARS = 2_000_000;
export const FOLDER_IMAGE_PX = 512;
/** An ESTIMATE for one square image from the image model (the real price depends on the model and size); recorded as such, never presented as an invoice. */
export const IMAGE_COST_ESTIMATE_USD = 0.04;
const DATA_URI = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

function magicOk(kind: string, b64: string): boolean {
  let head: Buffer;
  try {
    head = Buffer.from(b64.slice(0, 24), "base64");
  } catch {
    return false;
  }
  if (kind === "png") return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (kind === "jpeg" || kind === "jpg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (kind === "webp") return head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
  return false;
}

/** Cheap synchronous check of a picture someone gives for a folder: a real png / jpeg / webp (by its first bytes, not its name) and not huge. */
export function checkFolderImage(dataUri: unknown): { ok: true } | { ok: false; error: string } {
  const text = typeof dataUri === "string" ? dataUri : "";
  const m = DATA_URI.exec(text);
  if (!m) return { ok: false, error: "A folder picture must be a png, jpeg or webp image." };
  if (!magicOk(m[1], m[2])) return { ok: false, error: "That file is not really that kind of picture." };
  if (text.length > FOLDER_IMAGE_MAX_CHARS) return { ok: false, error: "That picture is too large for a folder thumbnail." };
  return { ok: true };
}

/**
 * Makes any accepted picture a square, 512 px jpeg: what the Library stores. Rejects pictures that cannot be decoded or are tiny. Strips metadata (location data) on the way.
 */
export async function normalizeFolderImage(dataUri: string): Promise<{ ok: true; dataUri: string } | { ok: false; error: string }> {
  const m = DATA_URI.exec(dataUri);
  if (!m || !magicOk(m[1], m[2])) return { ok: false, error: "A folder picture must be a png, jpeg or webp image." };
  try {
    const input = Buffer.from(m[2], "base64");
    if (input.length > 25 * 1024 * 1024) return { ok: false, error: "That picture is too large." };
    const meta = await sharp(input, { failOn: "error" }).metadata();
    if (!meta.width || !meta.height || meta.width < 48 || meta.height < 48) return { ok: false, error: "That picture is too small to be a thumbnail (at least 48 pixels)." };
    const out = await sharp(input).rotate().resize(FOLDER_IMAGE_PX, FOLDER_IMAGE_PX, { fit: "cover", position: "centre" }).jpeg({ quality: 86 }).toBuffer();
    return { ok: true, dataUri: `data:image/jpeg;base64,${out.toString("base64")}` };
  } catch (err) {
    return { ok: false, error: `That picture could not be read (${(err as Error).message.slice(0, 80)}).` };
  }
}

/** The prompt for a folder's picture, from its whole path. The last folder name says what to show; the ones before it say whose. */
export function folderPrompt(category: string, segments: string[]): string {
  const meaning = folderMeaning(category, segments);
  const path = [category, ...segments].join(" > ");
  return [
    `A clean, recognizable illustration for a Library folder named "${path}" in a reseller's product catalogue.`,
    `Show: ${meaning.subject}.`,
    `Do not show: ${meaning.avoid}.`,
    "One clear centred subject (or a tidy group of two or three of the same kind of thing) on a simple soft background, strong silhouette, readable when shrunk to a small square thumbnail.",
    "Illustration style, not a photograph of a real listing. Absolutely no text, letters, numbers, logos, watermarks or brand marks.",
  ].join(" ");
}

export interface MemberCandidate {
  productId: string;
  name: string;
  imageUrl: string | null;
  /** The person kept this thumbnail on purpose. */
  kept?: boolean;
}

/**
 * A member product's own photo for the folder, only when the product is the right KIND for what the folder holds (a console folder takes a console, never a game or an
 * accessory). Returns null when nothing fits, so the folder shows a placeholder rather than a misleading picture.
 */
export function pickMemberImage(members: MemberCandidate[], wants: FolderWants): MemberCandidate | null {
  const usable = members.filter((m) => !!m.imageUrl && /^data:image\//.test(m.imageUrl));
  const kindOk = (m: MemberCandidate) => {
    const k = kindOfName(m.name);
    if (wants === "hardware") return k === "hardware";
    if (wants === "games") return k === "game";
    if (wants === "accessories") return k === "accessory";
    return true;
  };
  const fit = usable.filter(kindOk);
  if (!fit.length) return null;
  // a thumbnail the person kept on purpose first, then the first (the list is newest-first, so recent research wins)
  return fit.find((m) => m.kept) ?? fit[0];
}

export interface GenerationLimits {
  /** Pictures generated per day (default 3). */
  perDay: number;
  /** Pictures generated per day across every folder when the person asked (default 10). */
  perDayManual: number;
}
export const DEFAULT_LIMITS: GenerationLimits = { perDay: 3, perDayManual: 10 };

export interface ImageGenerator {
  /** The raw image the model drew (base64 data uri) and what it cost (an estimate), or null when generation is unavailable. */
  draw(prompt: string): Promise<{ dataUri: string; costUsd: number } | null>;
}

export type GenerateOutcome =
  | { ok: true; dataUri: string; prompt: string; costUsd: number }
  | { ok: false; reason: string };

/** One generation, with the limits applied by the caller's counters. Never throws. */
export async function generateFolderPicture(category: string, segments: string[], gen: ImageGenerator): Promise<GenerateOutcome> {
  const prompt = folderPrompt(category, segments);
  let drawn: { dataUri: string; costUsd: number } | null = null;
  try {
    drawn = await gen.draw(prompt);
  } catch (err) {
    return { ok: false, reason: `the image service failed: ${(err as Error).message.slice(0, 120)}` };
  }
  if (!drawn) return { ok: false, reason: "image generation is not available right now" };
  const normalized = await normalizeFolderImage(drawn.dataUri);
  if (!normalized.ok) return { ok: false, reason: normalized.error };
  return { ok: true, dataUri: normalized.dataUri, prompt, costUsd: drawn.costUsd };
}

export type { FolderMeaning };
