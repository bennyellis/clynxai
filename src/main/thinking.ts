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
const PRIVATE_SUFFIX = /\.(?:local|lan|internal|intranet|home|corp|localdomain|localhost)$/i;

/** True for a host that is not a public web address: no dot (a bare name), an internal suffix, an IPv6 literal, or an IPv4 address in a private / loopback / link-local / shared (CGNAT, Tailscale) range. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h || h.startsWith("[") || !h.includes(".") || PRIVATE_SUFFIX.test(h) || h === "localhost") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false; // a real name: 10.example.com and 127.example.com are fine
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && Number(m[3]) === 0))) || a >= 224;
}

/** An address that is safe to show and open: http / https only, a public host, with credentials, query string and fragment removed. null when it is not one. */
export function publicPageUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (isPrivateHost(u.hostname)) return null;
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

/** Text that may mention an address: every address in it is cut down to its host (no credentials, path, query or token), and an address that is not public disappears. */
export function scrubUrlsInText(text: string): string {
  return text.replace(/\b(?:https?:\/\/)[^\s)"'<>]+/gi, (u) => {
    const pub = publicPageUrl(u);
    return pub ? hostOf(pub) : "a page";
  });
}

/** The first bytes of the image say what it is: a JPEG, a PNG or a WebP. Anything else is not shown, however it is labelled. */
function looksLikeImage(dataUri: string): boolean {
  const b64 = dataUri.slice(dataUri.indexOf(",") + 1, dataUri.indexOf(",") + 1 + 24);
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
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
    const text = oneLine(scrubUrlsInText(String(item.text ?? "")), MAX_TEXT);
    return text ? { type: "thought", text } : null;
  }
  if (item.type === "page") {
    const url = publicPageUrl(item.url);
    if (!url) return null;
    const title = oneLine(item.title, MAX_TITLE) || hostOf(url);
    const text = oneLine(scrubUrlsInText(String(item.text ?? "")), MAX_TEXT);
    return { type: "page", url, title: oneLine(scrubUrlsInText(title), MAX_TITLE), ...(text ? { text } : {}) };
  }
  if (item.type === "image") {
    const thumb = String(item.thumbnail ?? "");
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(thumb) || thumb.length > THUMB_MAX_CHARS || !looksLikeImage(thumb)) return null;
    const text = oneLine(scrubUrlsInText(String(item.text ?? "")), MAX_TEXT);
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

/** An argument as short text, only if it IS text or a number (an object would print as "[object Object]"); addresses in it are cut to their host. */
const q = (v: unknown, max = 60) => (typeof v === "string" || typeof v === "number" ? oneLine(scrubUrlsInText(String(v)), max) : "");

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
  return { type: "thought", text };
}

/** One plain line for a tool that ANSWERED but did not do the job ("NOT PLACED", "NOT SAVED", "needs your choice", "Not run"), so the narration says what happened and not only what was tried. */
export function thoughtForOutcome(result: string): string | null {
  const r = String(result ?? "").trimStart();
  if (/^NOT PLACED/i.test(r)) return "I could not tell what that was, so I did not file anything.";
  if (/^NOT SAVED/i.test(r)) return "I looked, but could not confirm it from a source, so I saved nothing.";
  if (/^NEEDS THE USER/i.test(r)) return "That could mean two different things, so I am asking you which.";
  if (/^Not run:/i.test(r)) return "That was only a question, so I changed nothing.";
  return null;
}
