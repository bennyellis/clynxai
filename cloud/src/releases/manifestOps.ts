import { config } from "../config.js";
import { query } from "../db/client.js";
import { verifySigned } from "../updates/manifest.js";
import { hashStored } from "./storage.js";

// The two steps of publishing an automatic update, shared by the website console (admin/routes.ts) and the server-side release tool (scripts/release.ts):
//   1. manifestTemplate(): the UNSIGNED manifest for a stored installer (SHA-256, SHA-512, size, a relative download address). Signed OFFLINE by the holder of the update private key.
//   2. attachSignedManifest(): checks the signed result against the PUBLIC key AND against the stored file before keeping it.
// Neither step publishes anything: a release becomes visible only when an administrator approves and publishes it.

export const manifestUrl = (id: string) => `/releases/${id}/download`;

interface ReleaseRow {
  id: string;
  version: string;
  channel: string;
  status: string;
  platform: string;
  notes: string;
  file_name: string | null;
  storage_key: string | null;
  size_bytes: string | null;
  sha256: string | null;
}

export async function releaseById(id: string): Promise<ReleaseRow | null> {
  const r = await query<ReleaseRow>("SELECT id, version, channel, status, platform, notes, file_name, storage_key, size_bytes, sha256 FROM releases WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

export type OpResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; message: string };
const fail = (status: number, error: string, message: string): { ok: false; status: number; error: string; message: string } => ({ ok: false, status, error, message });

export async function manifestTemplate(releaseId: string): Promise<OpResult<{ manifest: Record<string, unknown>; configured: boolean }>> {
  const rel = await releaseById(releaseId);
  if (!rel) return fail(404, "not_found", "Not found");
  if (!rel.storage_key || !rel.file_name) return fail(409, "no_file", "Upload the installer first");
  const sha512 = await hashStored(rel.storage_key, "sha512");
  if (!sha512) return fail(409, "file_missing", "The stored file is missing");
  const [platform, arch] = rel.platform.split("-");
  const manifest = {
    product: "clynx",
    version: rel.version,
    channel: rel.channel,
    publishedAt: new Date().toISOString(),
    files: [{ name: rel.file_name, url: manifestUrl(rel.id), sha512, sha256: rel.sha256, size: Number(rel.size_bytes), platform, arch: arch ?? "x64" }],
    notes: rel.notes.slice(0, 2000),
  };
  return { ok: true, manifest, configured: !!config.web.updatePublicKey };
}

export async function attachSignedManifest(releaseId: string, signed: unknown, byUserId: string | null): Promise<OpResult<{ willBeOffered: boolean; version: string; channel: string }>> {
  if (!config.web.updatePublicKey) return fail(409, "updates_not_configured", "This server has no update public key (UPDATE_PUBLIC_KEY / UPDATE_PUBLIC_KEY_FILE), so it cannot check or serve signed updates.");
  const rel = await releaseById(releaseId);
  if (!rel) return fail(404, "not_found", "Not found");
  if (rel.status === "withdrawn") return fail(409, "withdrawn", "A withdrawn release cannot carry an update");
  if (!rel.storage_key) return fail(409, "no_file", "Upload the installer first");
  const checked = verifySigned(signed, config.web.updatePublicKey);
  if (!checked.ok) return fail(422, "manifest_rejected", checked.reason);
  const m = checked.manifest;
  const sha512 = await hashStored(rel.storage_key, "sha512");
  const [platform, arch] = rel.platform.split("-");
  const f = m.files[0];
  const problems: string[] = [];
  if (m.version !== rel.version) problems.push("the version does not match this release");
  if (m.channel !== rel.channel) problems.push("the channel does not match this release");
  if (m.files.length !== 1 || f.platform !== platform || f.arch !== (arch ?? "x64")) problems.push("the file entry is not for this release's platform");
  if (f.sha512 !== sha512) problems.push("the installer checksum (SHA-512) does not match the file stored on this server");
  if (f.size !== Number(rel.size_bytes)) problems.push("the installer size does not match");
  if (f.sha256 !== undefined && f.sha256 !== rel.sha256) problems.push("the installer checksum (SHA-256) does not match the file stored on this server");
  if (f.url !== manifestUrl(rel.id)) problems.push("the download address must be " + manifestUrl(rel.id));
  if (problems.length) return fail(422, "manifest_mismatch", "The signed manifest does not describe this release: " + problems.join("; ") + ".");
  const body = signed as { manifest: string; signature: string };
  await query("UPDATE releases SET sha512 = $1, update_manifest = $2, update_manifest_at = now(), update_manifest_by = $3 WHERE id = $4", [sha512, JSON.stringify({ manifest: body.manifest, signature: body.signature }), byUserId, rel.id]);
  return { ok: true, willBeOffered: rel.status === "published", version: rel.version, channel: rel.channel };
}
