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

export interface UpdateFile {
  name: string;
  url: string;
  sha512: string; // hex
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
    if (typeof f?.name !== "string" || typeof f.url !== "string" || !/^[0-9a-f]{128}$/.test(f.sha512) || !Number.isInteger(f.size) || f.size <= 0) return { ok: false, reason: "The update information is incomplete." };
  }
  return { ok: true, manifest: m };
}

// ---- versions -----------------------------------------------------------------------------------------------------------------------------------------------------
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// ---- persistent state (rollback + replay protection) --------------------------------------------------------------------------------------------------------------
export interface UpdateState {
  lastGoodVersion: string | null; // newest version that started and confirmed healthy
  newestSeenPublishedAt: string | null; // newest manifest time ever accepted (replay protection)
  pending: { version: string; startsSinceInstall: number } | null; // installed but not yet confirmed healthy
  badVersions: string[]; // versions that failed to start; never offered again
}
export const EMPTY_UPDATE_STATE: UpdateState = { lastGoodVersion: null, newestSeenPublishedAt: null, pending: null, badVersions: [] };
export const MAX_FAILED_STARTS = 3;

export function readUpdateState(file: string): UpdateState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      lastGoodVersion: typeof raw.lastGoodVersion === "string" ? raw.lastGoodVersion : null,
      newestSeenPublishedAt: typeof raw.newestSeenPublishedAt === "string" ? raw.newestSeenPublishedAt : null,
      pending: raw.pending && typeof raw.pending.version === "string" ? { version: raw.pending.version, startsSinceInstall: Number(raw.pending.startsSinceInstall) || 0 } : null,
      badVersions: Array.isArray(raw.badVersions) ? raw.badVersions.filter((x: unknown) => typeof x === "string") : [],
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
    // not running the pending version (it was rolled back, or never installed): drop the pending marker
    return { state: p && p.version !== runningVersion ? { ...state, pending: null } : state, action: "none" };
  }
  const starts = p.startsSinceInstall + 1;
  if (starts > MAX_FAILED_STARTS) {
    return { state: { ...state, pending: null, badVersions: [...new Set([...state.badVersions, runningVersion])] }, action: "rollback" };
  }
  return { state: { ...state, pending: { version: p.version, startsSinceInstall: starts } }, action: "none" };
}
/** Call once the running version has shown it works (window loaded, database opened, a few minutes alive). */
export function markHealthy(state: UpdateState, runningVersion: string): UpdateState {
  return { ...state, lastGoodVersion: runningVersion, pending: state.pending?.version === runningVersion ? null : state.pending };
}
/** Call when an update has been handed to the installer. */
export function markInstalled(state: UpdateState, version: string): UpdateState {
  return { ...state, pending: { version, startsSinceInstall: 0 } };
}

// ---- download (untrusted) -> verified file -----------------------------------------------------------------------------------------------------------------------
export type Download = (url: string) => Promise<AsyncIterable<Uint8Array>>;

export async function downloadAndVerify(file: UpdateFile, stagingDir: string, download: Download, maxBytes = 600 * 1024 * 1024): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (file.size > maxBytes) return { ok: false, reason: "The update is larger than allowed." };
  if (!/^https:\/\//i.test(file.url)) return { ok: false, reason: "Updates are only downloaded over https." };
  const safeName = path.basename(file.name).replace(/[^A-Za-z0-9._-]/g, "_");
  fs.mkdirSync(stagingDir, { recursive: true });
  const partial = path.join(stagingDir, `${safeName}.part`);
  const final = path.join(stagingDir, safeName);
  const hash = crypto.createHash("sha512");
  let received = 0;
  const out = fs.createWriteStream(partial);
  let streamError: Error | null = null;
  out.on("error", (e) => {
    streamError = e; // surfaced below; without a listener a late open/write error would crash the app
  });
  try {
    for await (const chunk of await download(file.url)) {
      received += chunk.byteLength;
      if (received > file.size || received > maxBytes) throw new Error("The download is larger than the update says it is.");
      hash.update(chunk);
      if (streamError) throw streamError;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
    if (streamError) throw streamError;
    if (received !== file.size) throw new Error("The download is incomplete.");
    if (hash.digest("hex") !== file.sha512) throw new Error("The download does not match the signed update (checksum).");
    fs.renameSync(partial, final);
    return { ok: true, path: final };
  } catch (err) {
    await new Promise<void>((resolve) => {
      out.once("close", () => resolve());
      out.destroy();
    });
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
