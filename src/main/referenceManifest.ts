// The labelled REFERENCE and REGRESSION image set. Not a pile of URLs: every image has a product family, an exact model where known, the edition, the page it comes from, the
// resolved file, its licence and attribution (read from the source's own API, never assumed), the features it is expected to show, the angle, how reliable it is, the products it
// is easily confused with, a checksum and a validation status. Images are verified by their BYTES (type, size, decodability), never by file name; unavailable or changed sources
// are recorded as such, not hidden. Reference images (trusted, for production use) and regression images (only for testing recognition) are kept apart. The network is injected.
//
// Nothing here trains a model. It is data Clynx's own pipeline and the evaluation harness (scripts/visual-eval.cjs) use repeatedly.
import { createHash } from "node:crypto";
import sharp from "sharp";

export type ImageRole = "reference" | "regression";
export type Reliability = "manufacturer" | "reference_photo" | "user_photo" | "unverified";
export type ValidationStatus = "pending" | "valid" | "unavailable" | "invalid" | "changed" | "license_rejected";

export interface ManifestImage {
  id: string;
  role: ImageRole;
  family: string;
  /** The exact model when known ("New Nintendo 3DS XL"); null when the picture shows several or none. */
  model: string | null;
  variant: string | null;
  edition: string | null;
  sourcePageUrl: string;
  /** Where the file is fetched from (may redirect). */
  imageUrl: string;
  license: string | null;
  attribution: string | null;
  licenseUrl: string | null;
  /** What the image is expected to show, as the person who supplied it described it; checked against the image when fetched. */
  expectedFeatures: string[];
  /** Expected answers to the family's targeted questions (aspect -> option id), used to score the visual evaluation. */
  expectedAnswers: Record<string, string>;
  cameraAngle: string;
  reliability: Reliability;
  knownLookalikes: string[];
  /** Pictures with more than one product in them cannot be scored as "the" model. */
  multipleProducts?: boolean;
  checksum: string | null;
  width: number | null;
  height: number | null;
  mime: string | null;
  bytes: number | null;
  validation: { status: ValidationStatus; reason?: string; at?: number };
  suppliedBy: string;
}

export interface ManifestDocument {
  id: string;
  family: string;
  url: string;
  purpose: string;
  /** manufacturer | specialist | collector ...: how much to trust it (evidenceKinds.sourceQuality is the live rule). */
  quality: string;
  notes?: string;
}

export interface Manifest {
  version: 1;
  images: ManifestImage[];
  documents: ManifestDocument[];
  /** Coverage the evaluation set is meant to reach, and why it is not there yet. */
  coverageTargets: Array<{ family: string; wantImages: number; note: string }>;
}

export const MIN_SIDE_PX = 200;
export const MAX_BYTES = 20 * 1024 * 1024;
/** Licences images may be stored and used under (with attribution recorded). Anything else is rejected, not stored. */
export const ACCEPTED_LICENSES = /^(?:cc[- ]by(?:[- ]sa)?(?:[- ]\d(?:\.\d)?)?(?:[- ][a-z]{2,3})?|cc0(?:[- ]1\.0)?|public domain|pd[- ].*|cc[- ]zero)$/i;

export function licenseAccepted(short: string | null | undefined): boolean {
  const s = String(short ?? "").trim();
  if (!s) return false;
  // NC / ND licences do not allow use inside a product, whatever else they allow
  if (/(?:^|[- ])n[cd](?:[- ]|$)/i.test(s)) return false;
  return ACCEPTED_LICENSES.test(s);
}

export function sniffMime(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 4 && String.fromCharCode(...b.slice(0, 3)) === "GIF") return "image/gif";
  return null;
}

export const sha256 = (buf: Uint8Array): string => createHash("sha256").update(buf).digest("hex");

export interface Downloaded {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: Buffer;
  error?: string;
}
export interface FetchDeps {
  /** GET with redirects followed. */
  get(url: string): Promise<Downloaded>;
}

export interface Checked {
  status: ValidationStatus;
  reason?: string;
  checksum?: string;
  width?: number;
  height?: number;
  mime?: string;
  bytes?: number;
}

/** What a downloaded file really is. Content type and file name are NOT trusted: the bytes decide. */
export async function checkImageBytes(body: Buffer | undefined, declaredType?: string): Promise<Checked> {
  if (!body || body.length === 0) return { status: "invalid", reason: "empty response" };
  if (body.length > MAX_BYTES) return { status: "invalid", reason: "file is larger than 20 MB" };
  const mime = sniffMime(body);
  if (!mime) return { status: "invalid", reason: `not an image (the response was ${declaredType || "unknown type"}; it starts like ${JSON.stringify(body.subarray(0, 12).toString("latin1").replace(/[^\x20-\x7e]/g, "?"))})` };
  try {
    const meta = await sharp(body, { failOn: "error" }).metadata();
    if (!meta.width || !meta.height) return { status: "invalid", reason: "the image could not be decoded" };
    if (Math.min(meta.width, meta.height) < MIN_SIDE_PX) return { status: "invalid", reason: `too small to recognise details (${meta.width}x${meta.height}, at least ${MIN_SIDE_PX} px on the short side)`, width: meta.width, height: meta.height, mime };
    return { status: "valid", checksum: sha256(body), width: meta.width, height: meta.height, mime, bytes: body.length };
  } catch (err) {
    return { status: "invalid", reason: `the image is damaged (${(err as Error).message.slice(0, 80)})`, mime };
  }
}

// ---- Wikimedia Commons metadata (licence and attribution come from the source's own API) -----------------------------------------------------------------
export interface CommonsInfo {
  title: string;
  descriptionUrl: string | null;
  imageUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  artist: string | null;
  credit: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  sha1: string | null;
}

const stripTags = (s: string | undefined) => (s ? s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : null);

export function parseCommonsInfo(json: unknown): CommonsInfo | null {
  const pages = (json as { query?: { pages?: Record<string, any> } })?.query?.pages;
  const page = pages ? Object.values(pages)[0] : null;
  const info = page?.imageinfo?.[0];
  if (!page || !info || page.missing !== undefined) return null;
  const ext = info.extmetadata ?? {};
  return {
    title: String(page.title ?? ""),
    descriptionUrl: info.descriptionurl ?? null,
    imageUrl: info.url ?? null,
    license: stripTags(ext.LicenseShortName?.value),
    licenseUrl: stripTags(ext.LicenseUrl?.value),
    artist: stripTags(ext.Artist?.value),
    credit: stripTags(ext.Credit?.value),
    mime: info.mime ?? null,
    width: info.width ?? null,
    height: info.height ?? null,
    sha1: info.sha1 ?? null,
  };
}

export const commonsApiUrl = (fileName: string): string =>
  `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent("File:" + fileName.replace(/^File:/, ""))}&prop=imageinfo&iiprop=url%7Cmime%7Csize%7Csha1%7Cextmetadata&format=json`;

export function commonsFileName(pageUrl: string): string | null {
  const m = /\/wiki\/File:([^?#]+)/.exec(pageUrl);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Image files in a Commons category: candidates for the owner to review (never added as trusted automatically). */
export function parseCategoryMembers(json: unknown): string[] {
  const members = (json as { query?: { categorymembers?: Array<{ title?: string }> } })?.query?.categorymembers ?? [];
  return members.map((m) => String(m.title ?? "")).filter((t) => /^File:.+\.(?:jpe?g|png|webp)$/i.test(t)).map((t) => t.replace(/^File:/, ""));
}

// ---- one image, end to end -----------------------------------------------------------------------------------------------------------------------------------
export interface FetchedReference {
  entry: ManifestImage;
  /** The bytes, only when the image is valid and its licence accepted (the caller writes them to the cache). */
  body?: Buffer;
}

/** Resolves the licence, downloads, verifies. A source that is unavailable, changed, mislabelled or badly licensed is recorded as such. Never throws. */
export async function fetchReference(entry: ManifestImage, deps: FetchDeps, now: () => number = () => Date.now()): Promise<FetchedReference> {
  const out: ManifestImage = { ...entry, validation: { status: "pending" } };
  const stamp = (status: ValidationStatus, reason?: string) => ({ status, ...(reason ? { reason } : {}), at: now() });
  try {
    const file = commonsFileName(entry.sourcePageUrl);
    if (file) {
      const meta = await deps.get(commonsApiUrl(file));
      const info = meta.ok && meta.body ? parseCommonsInfo(JSON.parse(meta.body.toString("utf8"))) : null;
      if (!info) return { entry: { ...out, validation: stamp("unavailable", `the source page's metadata could not be read (HTTP ${meta.status}${meta.error ? ", " + meta.error : ""})`) } };
      out.license = info.license;
      out.licenseUrl = info.licenseUrl;
      out.attribution = [info.artist, info.credit].filter(Boolean).join(" - ") || null;
      if (!licenseAccepted(info.license)) return { entry: { ...out, validation: stamp("license_rejected", `licence "${info.license ?? "unknown"}" does not allow use here; the image was not stored`) } };
      if (!out.attribution) return { entry: { ...out, validation: stamp("license_rejected", "the author or credit could not be read, so attribution cannot be recorded; the image was not stored") } };
    } else if (!out.license) {
      return { entry: { ...out, validation: stamp("license_rejected", "no licence information for this source; add it to the manifest before the image can be used") } };
    }
    const res = await deps.get(entry.imageUrl);
    if (!res.ok) return { entry: { ...out, validation: stamp("unavailable", `could not download (HTTP ${res.status}${res.error ? ", " + res.error : ""})`) } };
    const checked = await checkImageBytes(res.body, res.contentType);
    out.width = checked.width ?? null;
    out.height = checked.height ?? null;
    out.mime = checked.mime ?? null;
    out.bytes = checked.bytes ?? null;
    if (checked.status !== "valid") return { entry: { ...out, validation: stamp(checked.status, checked.reason) } };
    if (entry.checksum && entry.checksum !== checked.checksum) {
      // the page now serves a different picture than the one that was reviewed
      return { entry: { ...out, checksum: checked.checksum ?? null, validation: stamp("changed", "the file at this address is not the one that was reviewed earlier (checksum differs); review it again") } };
    }
    return { entry: { ...out, checksum: checked.checksum ?? null, validation: stamp("valid") }, body: res.body };
  } catch (err) {
    return { entry: { ...out, validation: stamp("unavailable", (err as Error).message.slice(0, 120)) } };
  }
}

/** Structural problems in a manifest file (so a typo cannot silently drop images from an evaluation). */
export function validateManifest(m: unknown): string[] {
  const problems: string[] = [];
  const man = m as Manifest;
  if (!man || man.version !== 1 || !Array.isArray(man.images) || !Array.isArray(man.documents)) return ["the manifest must have version 1, images and documents"];
  const ids = new Set<string>();
  for (const i of man.images) {
    if (!i.id) problems.push("an image has no id");
    else if (ids.has(i.id)) problems.push(`duplicate image id ${i.id}`);
    ids.add(i.id);
    for (const k of ["family", "sourcePageUrl", "imageUrl", "cameraAngle", "suppliedBy"] as const) if (!i[k]) problems.push(`${i.id}: missing ${k}`);
    if (i.role !== "reference" && i.role !== "regression") problems.push(`${i.id}: role must be reference or regression`);
    if (!Array.isArray(i.expectedFeatures) || i.expectedFeatures.length === 0) problems.push(`${i.id}: expectedFeatures is empty`);
    if (!/^https:\/\//.test(i.imageUrl ?? "")) problems.push(`${i.id}: imageUrl must be https`);
  }
  return problems;
}

/** A reference image may be used by Clynx in production only when it is valid, was reviewed, and its role is "reference". Regression images never are. */
export function usableAsReference(i: ManifestImage): boolean {
  return i.role === "reference" && i.validation.status === "valid" && !!i.checksum && !!i.license && !!i.attribution && i.reliability !== "unverified";
}
