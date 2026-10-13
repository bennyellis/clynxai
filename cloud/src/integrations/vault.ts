import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Encryption of stored credentials. AES-256-GCM with a key that exists ONLY in the server's environment (CREDENTIALS_ENCRYPTION_KEY, 32 random bytes as base64 or hex).
// Nothing is ever stored in plain text: without a key the vault refuses to save. A second, previous key (CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) lets stored values still be read
// while they are re-encrypted after the main key is rotated. Each value carries the id of the key that sealed it and a fresh random nonce.
//   stored form: v1.<keyId>.<nonce b64url>.<tag b64url>.<ciphertext b64url>

export class VaultError extends Error {
  constructor(public code: "not_configured" | "unreadable", message: string) {
    super(message);
  }
}

interface KeyRing {
  current: { id: string; key: Buffer } | null;
  previous: { id: string; key: Buffer } | null;
}
let ring: KeyRing | null = null;

function parseKey(raw: string | undefined | null): { id: string; key: Buffer } | null {
  if (!raw) return null;
  const t = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) key = Buffer.from(t, "hex");
  else {
    const b = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) key = b;
  }
  if (!key) return null;
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

function getRing(): KeyRing {
  ring ??= { current: parseKey(process.env.CREDENTIALS_ENCRYPTION_KEY), previous: parseKey(process.env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) };
  return ring;
}

/** Test and tooling hook: replaces the keys in use. */
export function configureVault(current: string | null, previous: string | null = null): void {
  ring = { current: parseKey(current), previous: parseKey(previous) };
}

export const vaultConfigured = (): boolean => getRing().current !== null;
export const currentKeyId = (): string | null => getRing().current?.id ?? null;

export function seal(plain: string): { value: string; keyId: string } {
  const k = getRing().current;
  if (!k) throw new VaultError("not_configured", "CREDENTIALS_ENCRYPTION_KEY is not set on the server, so credentials cannot be stored.");
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, nonce);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  const b = (x: Buffer) => x.toString("base64url");
  return { value: `v1.${k.id}.${b(nonce)}.${b(tag)}.${b(ct)}`, keyId: k.id };
}

export function open(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") throw new VaultError("unreadable", "The stored credential is in an unknown format.");
  const r = getRing();
  const key = [r.current, r.previous].find((k) => k && k.id === parts[1]);
  if (!key) throw new VaultError("unreadable", "The stored credential was sealed with an encryption key this server does not have.");
  try {
    const d = createDecipheriv("aes-256-gcm", key.key, Buffer.from(parts[2], "base64url"));
    d.setAuthTag(Buffer.from(parts[3], "base64url"));
    return Buffer.concat([d.update(Buffer.from(parts[4], "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new VaultError("unreadable", "The stored credential could not be decrypted (damaged, or the key is wrong).");
  }
}
