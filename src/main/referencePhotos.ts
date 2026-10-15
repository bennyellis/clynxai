// Finding more reference photos for one Database product and saving them, with the numbers reported as they really are. This is the engine behind both the
// automatic top-up after research and the chat's add_reference_photos tool. The search itself (webResearch.ts findReferencePhotos: Wikipedia, image search, eBay
// listings, each candidate downloaded, de-duplicated by picture and vision-checked against the product) is passed in, so this part is testable on its own.
//
// Rules it keeps: only the named product is touched; a thumbnail the user chose (keepThumbnail) is never replaced, and an existing thumbnail is only replaced when the
// caller asks and none was chosen; the gallery never grows past its limit (and never pushes out an existing photo); "added" is the number of photos actually saved.
import type { ProductImage, ProductProfile } from "./types.js";
import { queryFromSearchUrl } from "./searchLinks.js";

export interface ReferencePhotoStore {
  getProductById(id: string): ProductProfile | null;
  listProductImages(id: string): ProductImage[];
  addProductImage(productId: string, imageData: string, sourceTitle: string | null, kind?: "normal" | "poor_condition"): ProductImage;
  editProductProfile(id: string, patch: { imageUrl: string }): unknown;
  touchProduct(id: string): void;
}

export interface PhotoFinder {
  (name: string, opts: { want: number; existingImages: string[]; extraQueries?: string[]; realWorld?: boolean }): Promise<{ photos: Array<{ imageData: string; label: string }>; examined: number }>;
}

export interface TopUpResult {
  /** Photos the product had (every kind) before. */
  before: number;
  /** How many were asked for. */
  requested: number;
  /** Photos actually saved. */
  added: number;
  /** Candidates that were downloaded and checked. */
  examined: number;
  /** The most photos a product may hold. */
  limit: number;
  /** Nothing was searched because the gallery has no room. */
  atLimit: boolean;
  /** The product's thumbnail was left as it was. */
  thumbnailKept: boolean;
  /** The product's own thumbnail was set from the first photo (it had none). */
  thumbnailSet: boolean;
  error?: string;
}

export async function topUpReferencePhotos(opts: {
  store: ReferencePhotoStore;
  id: string;
  name: string;
  /** How many MORE photos are wanted. */
  want: number;
  /** The most photos (of every kind) the product may hold; saving never pushes an existing one out. */
  limit: number;
  find: PhotoFinder;
  /** Make the best new photo the thumbnail even when one exists (only for a brand-new product); never overrides a thumbnail the user chose. */
  replaceThumbnail?: boolean;
  extraQueries?: string[];
  realWorld?: boolean;
}): Promise<TopUpResult> {
  const { store, id, name, limit } = opts;
  const all = store.listProductImages(id);
  const before = all.length;
  const normal = all.filter((i) => i.kind === "normal");
  const capacity = Math.max(0, limit - before);
  const toAdd = Math.min(Math.max(0, Math.floor(opts.want)), capacity);
  const result: TopUpResult = { before, requested: opts.want, added: 0, examined: 0, limit, atLimit: toAdd <= 0, thumbnailKept: true, thumbnailSet: false };
  if (toAdd <= 0) return result;
  let best: string | null = null;
  try {
    const found = await opts.find(name, { want: toAdd, existingImages: normal.map((i) => i.imageData), extraQueries: opts.extraQueries, realWorld: opts.realWorld });
    result.examined = found.examined;
    for (const photo of found.photos.slice(0, toAdd)) {
      // re-check the room each time: another save may have used it
      if (store.listProductImages(id).length >= limit) break;
      store.addProductImage(id, photo.imageData, photo.label);
      result.added++;
      best ??= photo.imageData;
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  const current = store.getProductById(id);
  if (current && !current.keepThumbnail) {
    if (best && (opts.replaceThumbnail || !current.imageUrl)) {
      store.editProductProfile(id, { imageUrl: best });
      result.thumbnailSet = true;
    } else if (!current.imageUrl && normal[0]) {
      store.editProductProfile(id, { imageUrl: normal[0].imageData });
      result.thumbnailSet = true;
    }
  }
  result.thumbnailKept = !result.thumbnailSet;
  if (result.added > 0) store.touchProduct(id);
  return result;
}

/** One plain-language line for the user (and for the model to relay), built only from what happened. */
export function describePhotoResult(name: string, r: TopUpResult, lowAiMode: boolean): string {
  if (r.atLimit) return `"${name}" already has ${r.before} photos, the most a product can hold (${r.limit}), so I saved none. Remove some in its Photos gallery to make room.`;
  if (r.error && r.added === 0) return `I could not save any photos for "${name}": the image search failed (${r.error}). Nothing was changed.`;
  if (r.added === 0) {
    return `I searched for photos of "${name}" and checked ${r.examined} candidate${r.examined === 1 ? "" : "s"}, but none was verified as this exact product and new (not already in its gallery), so I saved none.${lowAiMode ? " Save-credits mode is on, which limits this to Wikipedia and eBay listing photos; turning it off lets Clynx also check web image results." : ""}`;
  }
  const short = r.added < r.requested ? ` (you asked for ${r.requested}; that is all that passed the checks)` : "";
  return `Saved ${r.added} new reference photo${r.added === 1 ? "" : "s"} to "${name}"${short}, from ${r.examined} checked. ${r.thumbnailSet ? "Its thumbnail was set from the best one. " : "Its thumbnail was not changed. "}The gallery now has ${r.before + r.added} of ${r.limit}.${lowAiMode ? " (Save-credits mode: only Wikipedia and eBay photos were used.)" : ""}`;
}

export interface AddPhotosToolDeps {
  store: ReferencePhotoStore & { findMatchingProduct(name: string): ProductProfile | null };
  find: PhotoFinder;
  /** Product ids that already have a photo search running. */
  inFlight: Set<string>;
  limit: number;
  lowAiMode: boolean;
  /** Called with the product after a search that saved photos (refresh the screen, start the photo analysis). */
  onSaved?(product: ProductProfile, added: number): void;
  onUpdated?(product: ProductProfile): void;
  timeoutMs?: number;
}

/**
 * The chat's add_reference_photos tool: finds and saves more photos for ONE product (the named one, else the product the user has open), searching official shots and
 * real-world photos together, and returns what actually happened, for the model to relay. Never replaces a thumbnail the user chose; never exceeds the gallery limit.
 */
export async function runAddReferencePhotos(args: Record<string, unknown>, userMessage: string | undefined, currentProductId: string | undefined, deps: AddPhotosToolDeps): Promise<string> {
  const { store } = deps;
  const named = String(args.product ?? "").trim();
  const target = (named ? store.findMatchingProduct(named) : null) ?? (currentProductId ? store.getProductById(currentProductId) : null);
  if (!target) {
    return named
      ? `Failed: there is no product called "${named}" in the Database, so there is nothing to add photos to. Offer to research it first.`
      : "Failed: no product is open and none was named. Say that, and name the product you would add photos to.";
  }
  if (deps.inFlight.has(target.id)) return `A photo search for "${target.name}" is already running. Tell the user it is in progress and that the new photos will appear on the product's page when it finishes; do not start another.`;
  const want = Math.min(12, Math.max(1, Math.round(Number(args.count) || 8)));
  const linkQueries = [String(args.url ?? ""), ...(userMessage?.match(/https?:\/\/\S+/g) ?? [])].map((u) => queryFromSearchUrl(u.replace(/[.,;:!?]+$/, ""))).filter((q): q is string => !!q);
  const queries = [...new Set([String(args.searchPhrase ?? "").trim(), ...linkQueries].filter(Boolean))].slice(0, 2);
  deps.inFlight.add(target.id);
  try {
    const r = await Promise.race([
      topUpReferencePhotos({ store, id: target.id, name: target.name, want, limit: deps.limit, find: deps.find, extraQueries: queries, realWorld: true }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deps.timeoutMs ?? 170_000)),
    ]);
    if (!r) return `The photo search for "${target.name}" is taking longer than expected and was cut off; any photos saved so far are on its page. Say that plainly; do not claim a number.`;
    const updated = store.getProductById(target.id);
    if (updated) {
      if (r.added > 0) deps.onSaved?.(updated, r.added);
      deps.onUpdated?.(updated);
    }
    return describePhotoResult(target.name, r, deps.lowAiMode);
  } finally {
    deps.inFlight.delete(target.id);
  }
}
