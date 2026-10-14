import { createPublicKey, verify } from "node:crypto";

// Server-side checks of a signed update manifest. The server holds only the PUBLIC key: it can tell whether a manifest is genuine, but it can never create one.
// (The desktop app repeats every check itself and trusts nothing the server says: see src/main/updateVerifier.ts in the app.)

export interface ManifestFile {
  name: string;
  url: string;
  sha512: string;
  sha256?: string;
  size: number;
  platform: string;
  arch: string;
}
export interface Manifest {
  product: "clynx";
  version: string;
  channel: string;
  publishedAt: string;
  files: ManifestFile[];
  notes?: string;
}

export const parseVersion = (v: string): [number, number, number] | null => {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Compares by number, then (like semver) a pre-release is older than the same number without one; pre-releases compare by their dotted parts. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  const ra = /-(.+)$/.exec(a)?.[1];
  const rb = /-(.+)$/.exec(b)?.[1];
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
    } else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export type Checked = { ok: true; manifest: Manifest } | { ok: false; reason: string };

export function verifySigned(signed: unknown, publicKeyPem: string): Checked {
  const s = signed as { manifest?: unknown; signature?: unknown } | null;
  if (!s || typeof s.manifest !== "string" || typeof s.signature !== "string") return { ok: false, reason: "Send { manifest, signature }: the manifest as the exact text that was signed." };
  if (s.manifest.length > 256_000) return { ok: false, reason: "The manifest is too large." };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(s.manifest, "utf-8"), createPublicKey(publicKeyPem), Buffer.from(s.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "The signature does not verify against the update public key this server is configured with." };
  let m: Manifest;
  try {
    m = JSON.parse(s.manifest) as Manifest;
  } catch {
    return { ok: false, reason: "The manifest is not valid JSON." };
  }
  if (m?.product !== "clynx" || typeof m.version !== "string" || !parseVersion(m.version) || typeof m.channel !== "string" || !Array.isArray(m.files) || m.files.length === 0 || Number.isNaN(Date.parse(m.publishedAt))) {
    return { ok: false, reason: "The manifest is incomplete." };
  }
  for (const f of m.files) {
    if (typeof f?.name !== "string" || typeof f.url !== "string" || !/^[0-9a-f]{128}$/.test(f.sha512) || (f.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(f.sha256)) || !Number.isInteger(f.size) || f.size <= 0) return { ok: false, reason: "A file entry in the manifest is incomplete." };
  }
  return { ok: true, manifest: m };
}
