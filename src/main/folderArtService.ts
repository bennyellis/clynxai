// Keeps every automatic Library folder's picture sensible without costing much: a generated decorative picture where the image service is available and the daily limit
// allows, otherwise a fitting photo of one of the folder's own products, otherwise nothing (the Library draws its own placeholder). A picture the person chose is never touched.
// A folder is generated at most once automatically (a failed or declined attempt is remembered for a week), and never because the Library was opened.
import { autoFolderId, autoPath, isUserThumb, partsOfPath, splitPath, folderMeaning } from "./folderKeys.js";
import { DEFAULT_LIMITS, IMAGE_COST_ESTIMATE_USD, generateFolderPicture, pickMemberImage, type GenerationLimits, type ImageGenerator } from "./folderArt.js";
import type { LibraryOps } from "./libraryOps.js";
import type { Store } from "./store.js";
import { noteDecision } from "./aiDecisionLog.js";

export interface FolderArtDeps {
  store: Store;
  ops(): LibraryOps;
  generator(): ImageGenerator | null;
  /** Automatic generation switched on (and the AI not in Save-credits mode). A person's own request ignores this. */
  autoGenerate(): boolean;
  limits(): GenerationLimits;
  /** Called when a folder's picture changed. */
  changed?(): void;
}

const RETRY_AFTER_MS = 7 * 24 * 3600_000;

export interface FolderToRefresh {
  category: string;
  segments: string[];
}

/** Every automatic folder that exists (each family path and every level above it), below the category. */
export function listAutoFolders(placements: Array<{ category: string; family: string | null }>): FolderToRefresh[] {
  const seen = new Map<string, FolderToRefresh>();
  for (const p of placements) {
    const segs = splitPath(p.family ?? "");
    for (let len = 1; len <= segs.length; len++) {
      const part = segs.slice(0, len);
      seen.set(autoFolderId(p.category, part), { category: p.category, segments: part });
    }
  }
  return [...seen.values()];
}

export function createFolderArtService(d: FolderArtDeps) {
  let running = false;

  /** One generation for one folder. `byRequest`: a person asked, so the day's automatic limit does not apply (a higher manual one does) and the result is protected. */
  async function generate(key: string, byRequest: boolean): Promise<{ ok: boolean; message: string; costUsd?: number }> {
    const { category, segments } = partsOfPath(key);
    if (!category || segments.length === 0) return { ok: false, message: "Pick a folder inside a category." };
    const id = autoFolderId(category, segments);
    const cur = d.store.getFolderMeta(id);
    if (!byRequest && cur?.thumbLocked) return { ok: false, message: "That folder's picture was chosen by the person." };
    const gen = d.generator();
    if (!gen) return { ok: false, message: "Image generation is not available (no AI access, or Save OpenAI credits mode is on)." };
    const limits = d.limits();
    const used = d.store.usageToday("folder_art").count;
    if (used >= (byRequest ? limits.perDayManual : limits.perDay)) return { ok: false, message: `Today's limit of ${byRequest ? limits.perDayManual : limits.perDay} generated pictures is used up.` };
    const out = await generateFolderPicture(category, segments, gen);
    if (!out.ok) {
      d.store.setFolderMeta(id, { thumbMeta: { ...(cur?.thumbMeta ?? {}), generationTriedAt: Date.now(), generationFailed: out.reason } });
      return { ok: false, message: `Could not make a picture: ${out.reason}.` };
    }
    d.store.addUsage("folder_art", 1, out.costUsd);
    const rec = d.ops().run({ op: "recordFolderThumbnail", key: autoPath(category, segments), imageData: out.dataUri, source: "ai_generated", byRequest, meta: { prompt: out.prompt, estimatedCostUsd: out.costUsd, costIsEstimate: true, generationTriedAt: Date.now() } }, { actor: byRequest ? "ui" : "system" });
    if (!rec.ok) return { ok: false, message: rec.error ?? rec.summary };
    noteDecision({ kind: "folder_art", subject: autoPath(category, segments), verdict: "made a decorative picture", thought: `Generated from the folder path (${folderMeaning(category, segments).subject}). Estimated cost $${out.costUsd.toFixed(2)}. Decorative only: never used as a photo of a product.` });
    d.changed?.();
    return { ok: true, message: `Made a new picture for "${segments[segments.length - 1]}" (about $${out.costUsd.toFixed(2)}).`, costUsd: out.costUsd };
  }

  /** Looks at every automatic folder once and gives the ones with no picture a sensible one. Quiet and cheap; safe to call often. */
  async function refresh(): Promise<{ generated: number; picked: number }> {
    if (running) return { generated: 0, picked: 0 };
    running = true;
    let generated = 0;
    let picked = 0;
    try {
      const folders = listAutoFolders(d.store.listAutoFolderPlacements());
      const products = d.store.listProductIndex();
      for (const f of folders) {
        // a top-level family folder shows the brand's logo; generating artwork for it would only spend credits
        if (f.segments.length < 2) continue;
        const id = autoFolderId(f.category, f.segments);
        const meta = d.store.getFolderMeta(id);
        if (meta?.thumbLocked || isUserThumb(meta?.thumbSource)) continue;
        const key = autoPath(f.category, f.segments);
        const hasPicture = !!meta?.thumbData && (meta.thumbSource === "ai_generated" || meta.thumbSource === "auto");
        const triedRecently = Date.now() - Number((meta?.thumbMeta as { generationTriedAt?: number } | null)?.generationTriedAt ?? 0) < RETRY_AFTER_MS;
        if (meta?.thumbSource === "ai_generated" && hasPicture) continue; // made once; not remade by looking again
        if (d.autoGenerate() && !triedRecently) {
          const r = await generate(key, false);
          if (r.ok) {
            generated++;
            continue;
          }
        }
        if (hasPicture) continue; // an auto picture is already there
        // a fitting photo of one of its own products
        const meaning = folderMeaning(f.category, f.segments);
        const members = products
          .filter((p) => {
            const have = splitPath(p.family ?? "").map((x) => x.toLowerCase());
            return f.segments.every((s, i) => have[i] === s.toLowerCase());
          })
          .map((p) => d.store.getProductById(p.id))
          .filter((p): p is NonNullable<typeof p> => !!p && (p.category || "Other").toLowerCase() === f.category.toLowerCase())
          .map((p) => ({ productId: p.id, name: p.name, imageUrl: p.imageUrl, kept: p.keepThumbnail }));
        const pick = pickMemberImage(members, meaning.wants);
        if (pick?.imageUrl) {
          const rec = d.ops().run({ op: "recordFolderThumbnail", key, imageData: pick.imageUrl, source: "auto", meta: { productId: pick.productId, productName: pick.name, rule: `the folder holds ${meaning.wants}` } }, { actor: "system" });
          if (rec.ok) picked++;
        }
      }
    } finally {
      running = false;
    }
    if (generated || picked) d.changed?.();
    return { generated, picked };
  }

  return { generate, refresh };
}

export { DEFAULT_LIMITS, IMAGE_COST_ESTIMATE_USD };
