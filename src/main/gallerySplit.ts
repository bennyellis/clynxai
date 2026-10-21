// Mixed galleries (scanner parity S2, for entries that already exist): a console's gallery holding photos whose own titles say they are a GAME ("Titanfall 2 - Xbox One - Brand New") is two products in one
// folder. This finds those photos, groups them by game, and names each group; the Review action then moves them to their own entry in the platform's Games folder (backup first, undo in
// Recent changes). Pure: titles in, proposals out. Nothing is moved here.
import { gameFamilyPath, isGamePlatform } from "./mixedListing.js";
import { kindOfName } from "./productKind.js";

export interface GalleryImage {
  id: string;
  sourceTitle: string | null;
}
export interface GalleryProduct {
  id: string;
  name: string;
  family: string | null;
  images: GalleryImage[];
}
export interface SplitProposal {
  productId: string;
  productName: string;
  /** The game's name, from its photos' titles. */
  name: string;
  imageIds: string[];
  /** Where the new entry would be filed ("Xbox > Games"). */
  family: string | null;
  why: string;
}

const PLATFORM_WORDS = /\b(?:for\s+)?(?:microsoft\s+|sony\s+)?(?:xbox(?:\s*(?:series\s*[xs](?:\s*[|/&]\s*[xs])?|one(?:\s*[xs])?|360))?|playstation\s*[1-5]?|ps\s?[1-5]|nintendo\s+(?:switch\s*2?|3ds|ds|wii(?:\s*u)?|64|gamecube)|switch\s*2?|wii(?:\s*u)?|3ds|series\s*[xs])\b/gi;
const CONDITION = /\b(?:brand new|new|sealed|factory sealed|used|pre-?owned|like new|mint|complete(?: in box)?|cib|tested|working|free shipping|fast shipping|ntsc|pal|physical|disc|case|manual|video game|game|games)\b/gi;

/** "Titanfall 2 - Xbox One - Brand New" -> "Titanfall 2"; null when no game name is left. */
export function gameNameFromTitle(title: string): string | null {
  const segments = String(title ?? "").replace(/\([^)]*\)/g, " ").split(/\s[-–—|/]\s|\s{2,}|,/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segments) {
    const t = seg.replace(/\bfor\s+(?:the\s+)?[A-Za-z0-9 ]*$/i, "").replace(PLATFORM_WORDS, " ").replace(CONDITION, " ").replace(/\s+/g, " ").trim();
    if (t.length < 3 || !/[a-z]/i.test(t)) continue;
    return t;
  }
  return null;
}

const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The splits worth proposing for one console entry. Needs at least one photo whose title is a game; a game with a single photo is still proposed (it is the same mix). */
export function proposeSplits(product: GalleryProduct): SplitProposal[] {
  if (!isGamePlatform(`${product.family ?? ""} ${product.name}`) || kindOfName(product.name) !== "hardware") return [];
  const groups = new Map<string, { name: string; ids: string[]; titles: string[] }>();
  for (const img of product.images) {
    const title = img.sourceTitle ?? "";
    if (!title || kindOfName(title) !== "game") continue;
    const name = gameNameFromTitle(title);
    if (!name || keyOf(name) === keyOf(product.name)) continue;
    const k = keyOf(name);
    const g = groups.get(k) ?? { name, ids: [], titles: [] };
    g.ids.push(img.id);
    g.titles.push(title);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({
    productId: product.id,
    productName: product.name,
    name: g.name,
    imageIds: g.ids,
    family: gameFamilyPath(product.family),
    why: `${g.ids.length} photo${g.ids.length === 1 ? "" : "s"} in "${product.name}" ${g.ids.length === 1 ? "is" : "are"} titled as a game ("${g.titles[0].slice(0, 80)}").`,
  }));
}
