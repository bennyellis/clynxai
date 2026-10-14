// Signed-update architecture (Phase 7). STAGED: nothing here is wired to a download server or an installer yet; it is the verified core a release process plugs into.
//
//   publisher (offline, holds the private key)   ->  signed manifest  ->  app (holds only the PUBLIC key)
//
// A manifest is { manifest: "<JSON text>", signature: "<base64 Ed25519 over exactly that text>" }. The app refuses an update unless
//   1. the signature verifies against the public key built into the app,
//   2. the manifest is for this platform/channel, is newer than the running version, and is not older than the newest manifest ever seen (no replay of an old signed manifest),
//   3. the downloaded file's size and SHA-512 equal what the signed manifest states (the download itself is untrusted), and
//   4. after installing, the new version proves it starts (markHealthy) - otherwise the app records it as bad and the previous version is kept (rollback).
// Keys are generated with scripts/update-keys.cjs; the private key never enters this repository or the app.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyHost } from "./serverAddress.js";

export interface UpdateFile {
  name: string;
  url: string;
  sha512: string; // hex
  /** Also checked when present (the server records the installer's SHA-256 as well). */
  sha256?: string; // hex
  size: number;
  platform: "win32" | "darwin" | "linux";
  arch: string;
}
export interface UpdateManifest {
  product: "clynx";
  version: string;
  channel: string; // "stable" | "beta"
  publishedAt: string; // ISO time
  files: UpdateFile[];
  notes?: string;
}
export interface SignedManifest {
  manifest: string;
  signature: string;
}

// ---- signature ----------------------------------------------------------------------------------------------------------------------------------------------------
export function signManifest(manifest: UpdateManifest, privateKeyPem: string): SignedManifest {
  const text = JSON.stringify(manifest);
  const signature = crypto.sign(null, Buffer.from(text, "utf-8"), crypto.createPrivateKey(privateKeyPem)).toString("base64");
  return { manifest: text, signature };
}

export type ManifestCheck = { ok: true; manifest: UpdateManifest } | { ok: false; reason: string };

export function verifyManifest(signed: unknown, publicKeyPem: string): ManifestCheck {
  const s = signed as Partial<SignedManifest> | null;
  if (!s || typeof s.manifest !== "string" || typeof s.signature !== "string") return { ok: false, reason: "The update information is malformed." };
  if (s.manifest.length > 256_000) return { ok: false, reason: "The update information is too large." };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(s.manifest, "utf-8"), crypto.createPublicKey(publicKeyPem), Buffer.from(s.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "The update's signature is not valid." };
  let m: UpdateManifest;
  try {
    m = JSON.parse(s.manifest) as UpdateManifest;
  } catch {
    return { ok: false, reason: "The update information is malformed." };
  }
  if (m?.product !== "clynx" || typeof m.version !== "string" || !parseVersion(m.version) || typeof m.channel !== "string" || !Array.isArray(m.files) || Number.isNaN(Date.parse(m.publishedAt))) {
    return { ok: false, reason: "The update information is incomplete." };
  }
  for (const f of m.files) {
    if (typeof f?.name !== "string" || typeof f.url !== "string" || !/^[0-9a-f]{128}$/.test(f.sha512) || (f.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(f.sha256)) || !Number.isInteger(f.size) || f.size <= 0) return { ok: false, reason: "The update information is incomplete." };
  }
  return { ok: true, manifest: m };
}

// ---- versions -----------------------------------------------------------------------------------------------------------------------------------------------------
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** Semantic-version order: numbers first; then a pre-release ("-beta.2") is OLDER than the same number without one, and pre-releases compare part by part (beta.10 > beta.9). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  const ra = /-([0-9A-Za-z.]+)/.exec(a)?.[1];
  const rb = /-([0-9A-Za-z.]+)/.exec(b)?.[1];
  if (!ra && !rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i];
    const q = xb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (np !== nq) return np ? -1 : 1; // numeric parts are older than text parts
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// ---- persistent state (rollback + replay protection) --------------------------------------------------------------------------------------------------------------
export interface InstallerRecord {
  version: string;
  path: string;
  sha512: string;
  size: number;
}
export interface UpdateState {
  /** The installer that put the RUNNING version on this computer, when the updater did (kept so a user-approved return to it is possible without downloading). */
  currentInstaller?: InstallerRecord | null;
  /** The installer of the version before the running one (rollback). */
  previousInstaller?: InstallerRecord | null;
  /** An update that was handed to its installer but the old version is still the one that started: the installer did not finish. */
  lastFailure?: { version: string; at: string; reason: string } | null;
  /** The version that was running before the current one was installed by an update (the target of a way back). */
  previousVersion?: string | null;
  /** An Owner-designated REQUIRED update the server told this app about: the version to reach, the deadline (the server's clock) and how far the server's clock was from this computer's when it said so. */
  required?: { version: string; deadline: string; offsetMs: number } | null;
  lastGoodVersion: string | null; // newest version that started and confirmed healthy
  newestSeenPublishedAt: string | null; // newest manifest time ever accepted (replay protection)
  pending: { version: string; startsSinceInstall: number; installer?: InstallerRecord | null; from?: string | null } | null; // installed but not yet confirmed healthy
  badVersions: string[]; // versions that failed to start; never offered again
}
export const EMPTY_UPDATE_STATE: UpdateState = { required: null, lastGoodVersion: null, newestSeenPublishedAt: null, pending: null, badVersions: [], currentInstaller: null, previousInstaller: null, lastFailure: null };
export const MAX_FAILED_STARTS = 3;

function readInstaller(v: unknown): InstallerRecord | null {
  const r = v as Partial<InstallerRecord> | null;
  return r && typeof r.version === "string" && typeof r.path === "string" && /^[0-9a-f]{128}$/.test(String(r.sha512)) && Number.isInteger(r.size) ? { version: r.version, path: r.path, sha512: r.sha512 as string, size: r.size as number } : null;
}

export function readUpdateState(file: string): UpdateState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      lastGoodVersion: typeof raw.lastGoodVersion === "string" ? raw.lastGoodVersion : null,
      newestSeenPublishedAt: typeof raw.newestSeenPublishedAt === "string" ? raw.newestSeenPublishedAt : null,
      pending: raw.pending && typeof raw.pending.version === "string" ? { version: raw.pending.version, startsSinceInstall: Number(raw.pending.startsSinceInstall) || 0, installer: readInstaller(raw.pending.installer), from: typeof raw.pending.from === "string" ? raw.pending.from : null } : null,
      badVersions: Array.isArray(raw.badVersions) ? raw.badVersions.filter((x: unknown) => typeof x === "string") : [],
      required: raw.required && typeof raw.required.version === "string" && typeof raw.required.deadline === "string" && !Number.isNaN(Date.parse(raw.required.deadline)) ? { version: raw.required.version, deadline: raw.required.deadline, offsetMs: Number(raw.required.offsetMs) || 0 } : null,
      currentInstaller: readInstaller(raw.currentInstaller),
      previousInstaller: readInstaller(raw.previousInstaller),
      previousVersion: typeof raw.previousVersion === "string" ? raw.previousVersion : null,
      lastFailure: raw.lastFailure && typeof raw.lastFailure.version === "string" ? { version: raw.lastFailure.version, at: String(raw.lastFailure.at ?? ""), reason: String(raw.lastFailure.reason ?? "") } : null,
    };
  } catch {
    return { ...EMPTY_UPDATE_STATE, badVersions: [] };
  }
}
export function writeUpdateState(file: string, state: UpdateState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export interface OfferCheck {
  offer: boolean;
  reason?: string;
  file?: UpdateFile;
}

/** Decides whether a verified manifest is an update this computer should be offered. */
export function evaluateOffer(m: UpdateManifest, ctx: { currentVersion: string; channel: string; platform: string; arch: string; state: UpdateState }): OfferCheck {
  if (m.channel !== ctx.channel) return { offer: false, reason: "That update is for a different channel." };
  if (compareVersions(m.version, ctx.currentVersion) <= 0) return { offer: false, reason: "Already up to date." };
  if (ctx.state.badVersions.includes(m.version)) return { offer: false, reason: "That version failed to start here before and is not offered again." };
  if (ctx.state.newestSeenPublishedAt && Date.parse(m.publishedAt) < Date.parse(ctx.state.newestSeenPublishedAt)) return { offer: false, reason: "That update information is older than one already seen." };
  const file = m.files.find((f) => f.platform === ctx.platform && f.arch === ctx.arch);
  if (!file) return { offer: false, reason: "No build for this computer." };
  return { offer: true, file };
}

/** Remember that a manifest was accepted (call after evaluateOffer says yes). */
export function recordAccepted(state: UpdateState, m: UpdateManifest): UpdateState {
  const newest = state.newestSeenPublishedAt && Date.parse(state.newestSeenPublishedAt) > Date.parse(m.publishedAt) ? state.newestSeenPublishedAt : m.publishedAt;
  return { ...state, newestSeenPublishedAt: newest };
}

/** Call once at every app start. Returns what should happen about a freshly installed version. */
export function onAppStart(state: UpdateState, runningVersion: string): { state: UpdateState; action: "none" | "rollback" } {
  const p = state.pending;
  if (!p || p.version !== runningVersion) {
    // not running the pending version: either the installer never finished (the old version is still here: remember that, so the person is told), or it was rolled back
    if (p && p.version !== runningVersion && p.from === runningVersion) {
      return { state: { ...state, pending: null, lastFailure: { version: p.version, at: new Date().toISOString(), reason: "The installer did not finish, so Clynx is still on the version you had." } }, action: "none" };
    }
    return { state: p && p.version !== runningVersion ? { ...state, pending: null } : state, action: "none" };
  }
  const starts = p.startsSinceInstall + 1;
  if (starts > MAX_FAILED_STARTS) {
    return { state: { ...state, pending: null, badVersions: [...new Set([...state.badVersions, runningVersion])] }, action: "rollback" };
  }
  return { state: { ...state, pending: { ...p, startsSinceInstall: starts } }, action: "none" };
}
/** Call once the running version has shown it works (window loaded, database opened, a few minutes alive). The installer that brought it here becomes the one kept for it; the one before is kept as the way back. */
export function markHealthy(state: UpdateState, runningVersion: string): UpdateState {
  const p = state.pending;
  if (p && p.version === runningVersion) {
    return { ...state, lastGoodVersion: runningVersion, pending: null, previousInstaller: state.currentInstaller ?? null, currentInstaller: p.installer ?? null, previousVersion: p.from ?? state.previousVersion ?? null };
  }
  return { ...state, lastGoodVersion: runningVersion };
}
/** Call when an update has been handed to the installer. `from` is the version being left. */
export function markInstalled(state: UpdateState, version: string, installer?: InstallerRecord | null, from?: string | null): UpdateState {
  return { ...state, lastFailure: null, pending: { version, startsSinceInstall: 0, installer: installer ?? null, from: from ?? null } };
}

// ---- download (untrusted) -> verified file -----------------------------------------------------------------------------------------------------------------------
/** Gets the installer's bytes. With `range`, asks for the rest of the file from that byte on; the answer says whether the server really sent only the rest (`resumed`), otherwise it is the whole file. */
export type Download = (url: string, range?: { start: number }) => Promise<AsyncIterable<Uint8Array> | { body: AsyncIterable<Uint8Array>; resumed: boolean }>;

/** Plain http is acceptable for the download ONLY on a network the person controls (this computer or a private address): the file is not trusted until its signed checksums match anyway. */
export function isLocalNetworkUrl(url: string): boolean {
  try {
    return classifyHost(new URL(url).hostname) !== "internet";
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  maxBytes?: number;
  /** Allow http:// for a download from this computer / a private network address (a home server). Never for an internet address. */
  allowLocalNetworkHttp?: boolean;
  onProgress?: (received: number, total: number) => void;
  /** Continue from a kept partial file (an earlier download that was cut off) instead of starting again. The whole file is still verified against the signed checksums at the end. */
  resume?: boolean;
}

/** Hashes what an earlier, cut-off download already wrote, so the rest can be appended and the final checksum still covers every byte. */
async function hashExisting(file: string, hashes: crypto.Hash[]): Promise<number> {
  let n = 0;
  for await (const chunk of fs.createReadStream(file)) {
    n += (chunk as Buffer).length;
    for (const h of hashes) h.update(chunk as Buffer);
  }
  return n;
}

export async function downloadAndVerify(file: UpdateFile, stagingDir: string, download: Download, opts: DownloadOptions | number = {}): Promise<{ ok: true; path: string } | { ok: false; reason: string; resumable?: boolean }> {
  const o: DownloadOptions = typeof opts === "number" ? { maxBytes: opts } : opts;
  const maxBytes = o.maxBytes ?? 600 * 1024 * 1024;
  if (file.size > maxBytes) return { ok: false, reason: "The update is larger than allowed." };
  const httpsOk = /^https:\/\//i.test(file.url);
  if (!httpsOk && !(o.allowLocalNetworkHttp && /^http:\/\//i.test(file.url) && isLocalNetworkUrl(file.url))) return { ok: false, reason: "Updates are only downloaded over https." };
  const safeName = path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_");
  fs.mkdirSync(stagingDir, { recursive: true });
  const partial = path.join(stagingDir, `${safeName}.part`);
  const final = path.join(stagingDir, safeName);
  let hash = crypto.createHash("sha512");
  let hash256 = crypto.createHash("sha256");
  let received = 0;
  // an earlier download that was cut off left its bytes behind: pick up from there (only when asked to, and only if what is there is plausible)
  let start = 0;
  if (o.resume && fs.existsSync(partial)) {
    const have = fs.statSync(partial).size;
    if (have > 0 && have <= file.size) start = have;
    else fs.rmSync(partial, { force: true });
  }
  let out: fs.WriteStream | null = null;
  let streamError: Error | null = null;
  let verificationFailed = false; // a download that arrived whole but is WRONG is thrown away; one that was merely cut off is kept for resuming
  try {
    if (start > 0) {
      received = await hashExisting(partial, [hash, hash256]);
      if (received !== start) throw new Error("The kept part of the download could not be read.");
    }
    let body: AsyncIterable<Uint8Array> | null = null;
    if (start < file.size) {
      const got = await download(file.url, start > 0 ? { start } : undefined);
      const resumed = start > 0 && !(Symbol.asyncIterator in (got as object)) && (got as { resumed: boolean }).resumed === true;
      body = Symbol.asyncIterator in (got as object) ? (got as AsyncIterable<Uint8Array>) : (got as { body: AsyncIterable<Uint8Array> }).body;
      if (start > 0 && !resumed) {
        // the server sent the whole file again (it does not support resuming): start over
        hash = crypto.createHash("sha512");
        hash256 = crypto.createHash("sha256");
        received = 0;
        start = 0;
      }
    }
    out = fs.createWriteStream(partial, { flags: start > 0 ? "a" : "w" });
    out.on("error", (e) => {
      streamError = e; // surfaced below; without a listener a late open/write error would crash the app
    });
    if (body) {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > file.size || received > maxBytes) {
          verificationFailed = true;
          throw new Error("The download is larger than the update says it is.");
        }
        hash.update(chunk);
        hash256.update(chunk);
        o.onProgress?.(received, file.size);
        if (streamError) throw streamError;
        if (!out.write(chunk)) await new Promise<void>((r) => out!.once("drain", r));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out!.once("error", reject);
      out!.end(() => resolve());
    });
    if (streamError) throw streamError;
    if (received !== file.size) throw new Error("The download is incomplete.");
    if (hash.digest("hex") !== file.sha512) {
      verificationFailed = true;
      throw new Error("The download does not match the signed update (checksum).");
    }
    if (file.sha256 && hash256.digest("hex") !== file.sha256) {
      verificationFailed = true;
      throw new Error("The download does not match the signed update (SHA-256).");
    }
    fs.renameSync(partial, final);
    return { ok: true, path: final };
  } catch (err) {
    if (out) {
      await new Promise<void>((resolve) => {
        out!.once("close", () => resolve());
        out!.destroy();
      });
    }
    const keep = !verificationFailed && !streamError && o.resume === true && fs.existsSync(partial) && fs.statSync(partial).size > 0 && fs.statSync(partial).size < file.size;
    if (!keep) {
      try {
        fs.rmSync(partial, { force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err), resumable: keep };
  }
}
