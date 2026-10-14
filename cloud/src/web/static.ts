import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config.js";

// Serves the built website (website/dist) from the same server as the API, so the site and the API share one origin: session cookies work without CORS, and the Content-Security-Policy
// can be strict. Files are looked up inside the website folder only (no path escapes). Single-page-app routes fall back to index.html.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".otf": "font/otf", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json",
};

/** The policy the website's pages are served with: only this origin's scripts and styles, no framing, no plugins, forms only to this site. */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

const API_PREFIXES = ["/auth/", "/web/", "/admin/", "/billing/", "/devices", "/me", "/releases", "/support/requests", "/health", "/metrics", "/ai/", "/watches", "/listings", "/feedback", "/products", "/entitlements", "/search-planner", "/plans", "/ebay", "/dev/", "/updates", "/server/"];

export function websiteRoot(): string {
  return path.resolve(config.web.websiteDir);
}

function inside(root: string, p: string): string | null {
  const full = path.resolve(root, "." + path.sep + p);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

export function registerWebsite(app: FastifyInstance): boolean {
  const root = websiteRoot();
  if (!existsSync(path.join(root, "index.html"))) return false;

  const sendFile = (reply: FastifyReply, file: string, cacheControl: string, status = 200) => {
    const body = readFileSync(file);
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    reply.header("Content-Type", type);
    reply.header("Cache-Control", cacheControl);
    reply.header("ETag", `"${createHash("sha1").update(body).digest("hex").slice(0, 20)}"`);
    if (type.startsWith("text/html")) reply.header("Content-Security-Policy", PAGE_CSP);
    return reply.code(status).send(body);
  };

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") return reply.code(404).send({ error: "Not found" });
    const urlPath = decodeURIComponentSafe(request.url.split("?")[0]);
    if (urlPath === null) return reply.code(400).send({ error: "Bad request" });
    if (API_PREFIXES.some((p) => urlPath === p.replace(/\/$/, "") || urlPath.startsWith(p))) return reply.code(404).send({ error: "Not found" });

    // a real file (js, css, images, fonts)
    const rel = urlPath.replace(/^\/+/, "");
    const candidate = rel ? inside(root, rel) : null;
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
      const hashed = /^assets\//.test(rel);
      return sendFile(reply, candidate, hashed ? "public, max-age=31536000, immutable" : "public, max-age=300");
    }
    if (path.extname(urlPath)) return reply.code(404).send({ error: "Not found" });

    // a page: a pre-rendered route folder, else the app shell (the router shows the right page, or its own not-found page)
    const pre = rel ? inside(root, path.join(rel, "index.html")) : null;
    if (pre && existsSync(pre)) return sendFile(reply, pre, "no-cache");
    return sendFile(reply, path.join(root, "index.html"), "no-cache");
  });

  // "/" itself
  app.get("/", (_request, reply) => sendFile(reply, path.join(root, "index.html"), "no-cache"));
  app.get("/robots.txt", (_request, reply) => {
    const f = path.join(root, "robots.txt");
    return existsSync(f) ? sendFile(reply, f, "public, max-age=3600") : reply.code(404).send({ error: "Not found" });
  });
  return true;
}

function decodeURIComponentSafe(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
