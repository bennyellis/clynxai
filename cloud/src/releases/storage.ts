import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { config } from "../config.js";

// Installer storage. Today a local folder (RELEASES_DIR); the functions below are the whole boundary, so an object store (S3, R2...) can replace them without touching the routes.
// The server computes the SHA-256 of what it actually stored; a checksum is never taken on trust.

const root = () => path.resolve(config.web.releasesDir);

export function safeFileName(name: string): string {
  const base = path.basename(String(name || "installer.exe")).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return base && base !== "." && base !== ".." ? base : "installer.exe";
}

function resolveKey(key: string): string {
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error("bad storage key");
  return full;
}

export class TooLargeError extends Error {}

export async function saveStream(releaseId: string, fileName: string, input: Readable, maxBytes: number): Promise<{ key: string; sha256: string; size: number }> {
  const name = safeFileName(fileName);
  const key = `${releaseId}/${name}`;
  const dest = resolveKey(key);
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const hash = createHash("sha256");
  let size = 0;
  const out = createWriteStream(tmp);
  const failed = new Promise<never>((_, reject) => out.once("error", reject));
  failed.catch(() => undefined);
  // Read the request by hand rather than with pipeline(): on a refusal the request stream must NOT be destroyed, or the HTTP answer (413) could never be sent on that connection.
  const it = (input as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([it.next(), failed]);
      if (next.done) break;
      const chunk = next.value as Buffer;
      size += chunk.length;
      if (size > maxBytes) throw new TooLargeError("file too large");
      hash.update(chunk);
      if (!out.write(chunk)) await Promise.race([new Promise<void>((r) => out.once("drain", () => r())), failed]);
    }
    if (size === 0) throw new Error("empty file");
    await Promise.race([new Promise<void>((r) => out.end(() => r())), failed]);
    renameSync(tmp, dest);
    return { key, sha256: hash.digest("hex"), size };
  } catch (err) {
    await new Promise<void>((r) => {
      out.once("close", () => r());
      out.destroy();
    });
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function openRead(key: string): { stream: Readable; size: number } | null {
  const full = resolveKey(key);
  if (!existsSync(full)) return null;
  return { stream: createReadStream(full), size: statSync(full).size };
}

export async function hashStored(key: string, algorithm: "sha256" | "sha512" = "sha256"): Promise<string | null> {
  const full = resolveKey(key);
  if (!existsSync(full)) return null;
  const h = createHash(algorithm);
  await pipeline(createReadStream(full), h);
  return h.digest("hex");
}

export function removeStored(key: string): void {
  rmSync(resolveKey(key), { force: true });
}
