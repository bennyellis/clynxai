// Electron hardening helpers (Phase 7). Pure functions so the rules can be unit-tested without Electron.
//
// The renderer only ever shows the app's own bundled pages (or the vite dev server in development). It must never navigate elsewhere, open windows of its own, receive browser
// permissions, or have its IPC calls honoured when they come from any other page or frame.
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface AppOrigin {
  /** Dev server URL (ELECTRON_RENDERER_URL) when running unpackaged, else null. */
  devUrl: string | null;
  /** Absolute path of the folder holding the bundled renderer (out/renderer). */
  rendererDir: string;
}

/** True when `url` is a page of the app itself: a file inside the bundled renderer folder, or the dev server's origin. */
export function isAppUrl(url: string, origin: AppOrigin): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (origin.devUrl) {
    try {
      if (u.origin === new URL(origin.devUrl).origin) return true;
    } catch {
      /* fall through to the file check */
    }
  }
  if (u.protocol !== "file:") return false;
  try {
    const file = path.resolve(fileURLToPath(u));
    const dir = path.resolve(origin.rendererDir);
    const rel = path.relative(dir, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** A link the renderer asks the system browser to open (window.open / target=_blank): http(s) only, no embedded credentials, never a local file or custom protocol. */
export function externalLinkTarget(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u.toString();
}

/** IPC calls are honoured only from the app's own page in the top frame. */
export function isTrustedIpcSender(frame: { url: string; parent?: unknown } | null | undefined, origin: AppOrigin): boolean {
  if (!frame) return false;
  if (frame.parent) return false; // a sub-frame (nothing in the app uses iframes)
  return isAppUrl(frame.url, origin);
}

/** Permission requests (camera, microphone, geolocation, notifications, clipboard-read ...) from the renderer: always refused. */
export const ALLOWED_PERMISSIONS: readonly string[] = [];

/** The Content-Security-Policy the renderer page must carry. */
export const REQUIRED_CSP_DIRECTIVES = ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"];
