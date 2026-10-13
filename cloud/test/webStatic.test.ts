import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { PAGE_CSP } from "../src/web/static.js";

// Serving the built website from the API server: correct headers, single-page fallback, no path escapes, and the API is never shadowed by a page.
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-site-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.mkdirSync(path.join(dir, "features"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Shell</title><div id=root></div>");
  fs.writeFileSync(path.join(dir, "features", "index.html"), "<!doctype html><title>Features prerendered</title>");
  fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('app')");
  fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  fs.writeFileSync(path.resolve(dir, "..", "clynx-outside-secret.txt"), "TOP SECRET");
  config.web.websiteDir = dir;
  app = buildApp({ billing: null });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await closePool();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.resolve(dir, "..", "clynx-outside-secret.txt"), { force: true });
});

describe("pages", () => {
  it("serves the app shell at / with a strict Content-Security-Policy and no caching", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toBe(PAGE_CSP);
    expect(PAGE_CSP).toMatch(/script-src 'self'/);
    expect(PAGE_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(PAGE_CSP).toMatch(/frame-ancestors 'none'/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("falls back to the shell for client-side routes and uses a pre-rendered page where one exists", async () => {
    expect((await app.inject({ method: "GET", url: "/pricing" })).body).toContain("<title>Shell</title>");
    expect((await app.inject({ method: "GET", url: "/account/billing" })).body).toContain("<title>Shell</title>");
    expect((await app.inject({ method: "GET", url: "/features" })).body).toContain("Features prerendered");
  });

  it("serves hashed assets as immutable and other files briefly", async () => {
    const js = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.headers["cache-control"]).toMatch(/immutable/);
    expect((await app.inject({ method: "GET", url: "/favicon.svg" })).headers["content-type"]).toBe("image/svg+xml");
  });

  it("a missing file is a real 404 (not the shell)", async () => {
    expect((await app.inject({ method: "GET", url: "/assets/nope.js" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/nope.png" })).statusCode).toBe(404);
  });
});

describe("safety", () => {
  it("cannot read files outside the website folder", async () => {
    for (const url of ["/..%2Fclynx-outside-secret.txt", "/%2e%2e/clynx-outside-secret.txt", "/assets/..%2f..%2fclynx-outside-secret.txt", "/..\\clynx-outside-secret.txt", "/%2e%2e%5cclynx-outside-secret.txt"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, url).not.toContain("TOP SECRET");
    }
    expect((await app.inject({ method: "GET", url: "/%E0%A4%A" })).statusCode).toBe(400);
  });

  it("never answers an API path with a page", async () => {
    for (const url of ["/auth/nothing", "/web/nothing", "/admin/nothing", "/billing/nothing", "/releases/nothing", "/plans/nothing", "/dev/nothing"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toMatch(/json/);
    }
  });

  it("unknown POSTs are JSON 404s, and the API keeps its own strict policy", async () => {
    const post = await app.inject({ method: "POST", url: "/nothing-here", payload: {} });
    expect(post.statusCode).toBe(404);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(health.headers["cache-control"]).toBe("no-store");
  });
});
