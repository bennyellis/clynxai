import type { ChatAttachment } from "../../../main/chat.js";

// Beta 13: ONE way for every chat to take pictures. Up to four, checked by what the file really is (its first bytes, not its name), re-drawn smaller (a phone photo of 8 MB
// becomes a few hundred KB, which also removes its EXIF / GPS data), and kept inside one request budget so the shared Clynx Cloud route (10 MiB body limit) is never hit.
// The pure parts (sniffing, sizing, budget, the history note) are testable without a browser; prepareImages needs one.

export const MAX_IMAGES = 4;
/** Total characters of all pictures' data URIs in one message (about 4.5 MB of image bytes), well under the cloud body limit with the conversation on top. */
export const MAX_REQUEST_CHARS = 6_000_000;
export const MAX_SIDE_PX = 1568;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export type ImageKind = "jpeg" | "png" | "gif" | "webp";

/** What a file really is, from its first bytes; null for anything else (an svg, a heic, a renamed document). */
export function sniffImageType(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

/** The size to draw at: the longest side at most `max`, never enlarged, proportions kept. */
export function scaledSize(width: number, height: number, max = MAX_SIDE_PX): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 };
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export function totalChars(list: ChatAttachment[]): number {
  return list.reduce((n, a) => n + a.dataUri.length, 0);
}
export function fitsBudget(existing: ChatAttachment[], dataUri: string): boolean {
  return totalChars(existing) + dataUri.length <= MAX_REQUEST_CHARS;
}

/** What the conversation history keeps of the pictures (their pixels are not re-sent on later turns): so "the photo" still means something in a follow-up. */
export function attachmentHistoryNote(names: string[]): string {
  if (!names.length) return "";
  return `[attached ${names.length} photo${names.length === 1 ? "" : "s"}: ${names.map((n) => n.slice(0, 40)).join(", ")}]`;
}

export interface PrepareResult {
  added: ChatAttachment[];
  /** Plain sentences for the person: every file that could not be used is named with its reason. */
  problems: string[];
}

async function draw(file: File, quality: number, maxSide: number): Promise<string | null> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height, maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff"; // transparent pngs become white, not black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    bitmap.close();
  }
}

export async function prepareImages(files: File[], existing: ChatAttachment[]): Promise<PrepareResult> {
  const added: ChatAttachment[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const name = file.name || "photo";
    if (existing.length + added.length >= MAX_IMAGES) { problems.push(`"${name}" was not added: up to ${MAX_IMAGES} photos fit in one message.`); continue; }
    if (file.size > MAX_SOURCE_BYTES) { problems.push(`"${name}" is too large to read (over ${MAX_SOURCE_BYTES / 1024 / 1024} MB).`); continue; }
    let kind: ImageKind | null = null;
    try {
      kind = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    } catch {
      kind = null;
    }
    if (!kind) { problems.push(`"${name}" is not a picture Clynx can read (png, jpeg, webp or gif).`); continue; }
    try {
      let uri = await draw(file, 0.85, MAX_SIDE_PX);
      if (uri && !fitsBudget([...existing, ...added], uri)) uri = await draw(file, 0.7, 1100);
      if (!uri) { problems.push(`"${name}" could not be read.`); continue; }
      if (!fitsBudget([...existing, ...added], uri)) { problems.push(`"${name}" was not added: the photos together are too large to send.`); continue; }
      added.push({ dataUri: uri, name });
    } catch {
      problems.push(`"${name}" could not be read.`);
    }
  }
  return { added, problems };
}
