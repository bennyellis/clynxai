// Encrypts long-lived secrets (the Clynx Cloud refresh token) before they are written to disk. The real cipher is Electron's safeStorage (Windows DPAPI, macOS Keychain,
// Linux libsecret), installed once at startup with setSecretCodec; this module has no Electron import so it can be tested and bundled anywhere.
//
//   stored value = "enc:v1:<base64 ciphertext>"   when a codec is installed and available
//                = the plain text                 otherwise (and for files written by older versions)
//
// A plain value found on read is still accepted (older install); it is rewritten encrypted the next time the owner saves. A ciphertext that cannot be decrypted (the file was
// copied to another computer or Windows account) reads as "no secret", which simply means the user signs in again.
export interface SecretCodec {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

const PREFIX = "enc:v1:";
let codec: SecretCodec | null = null;

export function setSecretCodec(next: SecretCodec | null): void {
  codec = next;
}

export function isProtectedSecret(stored: unknown): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

export function protectSecret(plain: string): string {
  try {
    if (codec?.available()) return PREFIX + codec.encrypt(plain).toString("base64");
  } catch (err) {
    console.error("[secretStore] encryption failed, storing without it:", err instanceof Error ? err.message : err);
  }
  return plain;
}

export function revealSecret(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    if (!codec?.available()) return null;
    return codec.decrypt(Buffer.from(stored.slice(PREFIX.length), "base64"));
  } catch {
    return null;
  }
}
