// Clynx's narrated thinking (AUDITOR proposal section 3, owner-accepted): while a chat turn runs, the window shows short first-person thought lines, the pages Clynx opened and the photos it looked at.
// These are CODE-AUTHORED facts about what really happened (a tool started, a page was read, a photo was attached), never the model's hidden reasoning. They are small by rule: at most
// MAX_THINKING_ITEMS per turn, thumbnails capped at THUMB_MAX_SIDE pixels, addresses stripped of anything personal (credentials, query strings, fragments), nothing stored beyond the chat's own history
// (they live only in the screen's per-turn state). Pure: no I/O.

export type ThinkingType = "thought" | "page" | "image";

export interface ThinkingItem {
  type: ThinkingType;
  /** A thought line, or the note under a page / photo. */
  text?: string;
  /** A page: the address (http / https only, no credentials, no query, no fragment). */
  url?: string;
  /** A page: its title or its domain. */
  title?: string;
  /** A photo: a small data URI (a JPEG / PNG / WebP no larger than THUMB_MAX_CHARS). */
  thumbnail?: string;
}

/** Most items one turn may show. */
export const MAX_THINKING_ITEMS = 20;
/** Longest side of a shown thumbnail, in pixels. */
export const THUMB_MAX_SIDE = 160;
/** A thumbnail longer than this (as a data URI) is dropped, not shown. */
export const THUMB_MAX_CHARS = 45_000;
const MAX_TEXT = 200;
const MAX_TITLE = 120;
const MAX_URL = 300;

const oneLine = (s: unknown, max: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** An address that is safe to show and open: http / https only, with credentials, query string and fragment removed. null when it is not one. */
export function publicPageUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/i.test(u.hostname) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(u.hostname)) return null;
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    const out = u.toString();
    return out.length <= MAX_URL ? out : null;
  } catch {
    return null;
  }
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The item exactly as it may leave the main process, or null when nothing worth showing is left (an empty line, an address that is not public, a photo without a usable thumbnail). */
export function sanitizeThinkingItem(item: ThinkingItem | null | undefined): ThinkingItem | null {
  if (!item) return null;
  if (item.type === "thought") {
    const text = oneLine(item.text, MAX_TEXT);
    return text ? { type: "thought", text } : null;
  }
  if (item.type === "page") {
    const url = publicPageUrl(item.url);
    if (!url) return null;
    const title = oneLine(item.title, MAX_TITLE) || hostOf(url);
    const text = oneLine(item.text, MAX_TEXT);
    return { type: "page", url, title, ...(text ? { text } : {}) };
  }
  if (item.type === "image") {
    const thumb = String(item.thumbnail ?? "");
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(thumb) || thumb.length > THUMB_MAX_CHARS) return null;
    const text = oneLine(item.text, MAX_TEXT);
    return { type: "image", thumbnail: thumb, ...(text ? { text } : {}) };
  }
  return null;
}

/** Counts a turn's items so the cap holds however many places emit. One per turn; throw it away with the turn. */
export class ThinkingBudget {
  private n = 0;
  private lastThought = "";
  private seenPages = new Set<string>();
  /** The sanitised item to send, or null when it is empty, a repeat, or over the cap. */
  admit(item: ThinkingItem | null | undefined): ThinkingItem | null {
    if (this.n >= MAX_THINKING_ITEMS) return null;
    const clean = sanitizeThinkingItem(item);
    if (!clean) return null;
    if (clean.type === "thought") {
      if (clean.text === this.lastThought) return null;
      this.lastThought = clean.text!;
    }
    if (clean.type === "page") {
      if (this.seenPages.has(clean.url!)) return null;
      this.seenPages.add(clean.url!);
    }
    this.n++;
    return clean;
  }
  get count(): number {
    return this.n;
  }
}

const q = (v: unknown, max = 60) => oneLine(v, max);

/** The first-person line for a tool starting, written from the tool and its arguments (never model text). null for a tool that needs no line. */
export function thoughtForTool(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case "research_product":
      return q(args.product) ? `I'm looking into ${q(args.product)}.` : "I'm looking into the product.";
    case "research_variants":
      return q(args.product) ? `I'm checking which versions of ${q(args.product)} really exist.` : "I'm checking which versions really exist.";
    case "web_research":
      return q(args.query) ? `I'm searching the web for "${q(args.query)}".` : "I'm searching the web.";
    case "find_products":
      return "I'm looking through your Library.";
    case "check_model_name":
      return q(args.name) ? `I'm checking whether ${q(args.name)} is a real model.` : "I'm checking whether that is a real model.";
    case "identify_from_photo":
      return "I'm taking a close look at your photo.";
    case "add_reference_photos":
      return q(args.product) ? `I'm finding photos of ${q(args.product)}.` : "I'm finding reference photos.";
    default:
      return null;
  }
}

/** The line after a tool that did not work, kept short and plain (the raw error stays in the log). */
export function thoughtForFailure(name: string): string {
  return name === "web_research" || name === "research_product" || name === "research_variants" ? "That didn't work out just now, so I'll say what I could and couldn't find." : "That step didn't work out.";
}

/** A web-activity line from the search / page readers ("Searched Brave for ...: 5 results", "Could not read example.com") as a thought, trimmed. Reads that opened a page become page items elsewhere. */
export function thoughtFromWebLine(line: string, ok: boolean): ThinkingItem | null {
  const text = oneLine(line, MAX_TEXT);
  if (!text) return null;
  return { type: "thought", text: ok ? text : `${text}` };
}
