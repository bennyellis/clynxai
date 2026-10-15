// Records what an AI decided, with a tiny picture of what it looked at (AI Activity, Activity screen). Fire-and-forget: it never delays or fails the work it describes.
import sharp from "sharp";
import { apiActivity, type AiDecision } from "./apiActivity.js";

const THUMB_PX = 120;

/** A ~120 px JPEG data: URI of an image (a data: URI in), or null when it cannot be made. Small enough to keep dozens in memory. */
export async function makeThumb(dataUri: string | null | undefined, px: number = THUMB_PX): Promise<string | null> {
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(String(dataUri ?? ""));
  if (!m) return null;
  try {
    const out = await sharp(Buffer.from(m[1], "base64"), { failOn: "none" }).rotate().resize(px, px, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: px > THUMB_PX ? 72 : 55 }).toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Records a decision now (no picture), or as soon as the picture's thumbnail is ready. */
export function noteDecision(d: Omit<AiDecision, "ts" | "image"> & { imageDataUri?: string | null }): void {
  const { imageDataUri, ...rest } = d;
  if (!imageDataUri) {
    apiActivity.decision(rest);
    return;
  }
  void makeThumb(imageDataUri)
    .then((image) => apiActivity.decision({ ...rest, image }))
    .catch(() => apiActivity.decision(rest));
}
