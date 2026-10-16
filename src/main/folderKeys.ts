// Identity and meaning of the Library's AUTOMATIC folders. They are not rows: a product's category + family path ("Video Games & Consoles" + "Nintendo > Consoles") is
// split into folders at display time. A folder's identity is therefore that full path, in the words the automation wrote. A rename or a thumbnail the person chooses is stored
// against that path (folder_meta), so it survives restarts and research refreshes, and new products arriving on the same path land in the renamed folder. Pure.

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The canonical path of an automatic folder: category first, then its family segments. */
export function autoPath(category: string, segments: string[]): string {
  return [category, ...segments].map(clean).filter(Boolean).join(" > ");
}
/** The storage id of an automatic folder's settings (case-insensitive, like the thumbnails that already existed). */
export function autoFolderId(category: string, segments: string[]): string {
  return `auto:${autoPath(category, segments).toLowerCase()}`;
}
export function splitPath(path: string): string[] {
  return path.split(">").map(clean).filter(Boolean);
}
/** [category, ...segments] from an autoFolderId-style path (any case). */
export function partsOfPath(path: string): { category: string; segments: string[] } {
  const [category = "", ...segments] = splitPath(path);
  return { category, segments };
}

export type FolderWants = "hardware" | "games" | "accessories" | "any";
export interface FolderMeaning {
  /** What a picture of this folder must show, in words. */
  subject: string;
  wants: FolderWants;
  /** What it must not show. */
  avoid: string;
}

const HARDWARE = /\b(consoles?|systems?|hardware|handhelds?|graphics cards?|gpus?|phones?|smartphones?|laptops?|tablets?|cameras?|headsets?|drones?|watches)\b/i;
const GAMES = /\b(games?|software|discs?|cartridges?|titles?)\b/i;
const ACCESSORIES = /\b(accessor(?:y|ies)|controllers?|peripherals?|cases?|chargers?|cables?|docks?|stands?|straps?)\b/i;

/**
 * What a folder IS, from its whole path: the last segment says the kind of thing, the segments before it say whose ("Video Games & Consoles > Nintendo > Consoles" is Nintendo
 * console hardware, not Nintendo games). Used to write the thumbnail prompt and to choose a member photo that fits the folder.
 */
export function folderMeaning(category: string, segments: string[]): FolderMeaning {
  const last = segments[segments.length - 1] ?? category;
  const context = segments.slice(0, -1).join(" ");
  const who = clean(context) || (segments.length ? "" : "");
  if (segments.length && GAMES.test(last)) return { wants: "games", subject: `${who ? who + " " : ""}video game software: a few game cases or boxes`.trim(), avoid: "consoles, handheld systems, controllers or any hardware as the main subject" };
  if (segments.length && ACCESSORIES.test(last)) return { wants: "accessories", subject: `${who ? who + " " : ""}${last.toLowerCase()}: the accessory products themselves`.trim(), avoid: "game cases, game artwork and complete consoles as the main subject" };
  if (HARDWARE.test(last) || (!segments.length && HARDWARE.test(category))) {
    return { wants: "hardware", subject: `${who ? who + " " : ""}${last.toLowerCase().replace(/consoles?$/, "console").replace(/systems?$/, "system")} hardware: the actual device units themselves`.replace(/\s+/g, " ").trim(), avoid: "game cases, discs, cartridges, game artwork, loose controllers and accessories as the main subject" };
  }
  return { wants: "any", subject: `${[...segments].join(" ") || category}`.trim() || category, avoid: "unrelated products" };
}

/** A folder label a person typed: no ">" (it is the path separator), no control characters, at most 60 characters. */
export function cleanFolderLabel(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = clean(String(raw ?? ""));
  if (!name) return { ok: false, error: "A folder name is needed." };
  if (name.length > 60) return { ok: false, error: "Folder names can be at most 60 characters." };
  if (/[>\/\\\u0000-\u001f]/.test(name)) return { ok: false, error: 'A folder name cannot contain ">", "/", "\\" or control characters.' };
  return { ok: true, name };
}

export type ThumbSource = "ai_generated" | "auto" | "user_upload" | "user_selected" | "placeholder";
export const THUMB_SOURCES: ThumbSource[] = ["ai_generated", "auto", "user_upload", "user_selected", "placeholder"];
/** A source the person decided. These are never replaced by automation. */
export const isUserThumb = (s: string | null | undefined): boolean => s === "user_upload" || s === "user_selected";

export interface FolderMetaRecord {
  id: string;
  displayName: string | null;
  thumbData: string | null;
  thumbSource: ThumbSource | null;
  /** The person chose or asked for this thumbnail (a generated one they requested counts): automation never replaces it. */
  thumbLocked: boolean;
  thumbMeta: Record<string, unknown> | null;
  updatedAt: number;
}
