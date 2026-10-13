// Optional protection for the API keys saved in .env (OpenAI, eBay). By default those stay plain text, exactly as older versions wrote them; nothing here runs unless the person
// turns "Protect my saved keys" on. Protecting rewrites ONLY the three key lines, after a full copy of the file is kept next to it, and every key is read back and compared before
// the file is replaced. Turning it off restores plain text the same way. A key that cannot be decrypted (the folder was copied to another computer or Windows account) reads as
// "no key saved", which means entering it again, never a crash. Pure functions: the cipher is passed in (see secretStore.ts, which wraps Electron's safeStorage).
export const SECRET_ENV_VARS = ["OPENAI_API_KEY", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"] as const;
const MARK = "enc:v1:";

export const isProtectedValue = (v: string): boolean => v.startsWith(MARK);

interface Line {
  raw: string;
  name: string | null;
  value: string;
}

function splitLines(text: string): Line[] {
  return text.split(/\r?\n/).map((raw) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) return { raw, name: null, value: "" };
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    return { raw, name: m[1], value };
  });
}

const isSecret = (name: string | null): boolean => name !== null && (SECRET_ENV_VARS as readonly string[]).includes(name);

export interface EnvKeyState {
  /** Secret lines holding a plain-text value. */
  plain: number;
  /** Secret lines holding a protected value. */
  protectedCount: number;
}

export function envKeyState(text: string): EnvKeyState {
  let plain = 0;
  let protectedCount = 0;
  for (const l of splitLines(text)) {
    if (!isSecret(l.name) || !l.value) continue;
    if (isProtectedValue(l.value)) protectedCount++;
    else plain++;
  }
  return { plain, protectedCount };
}

/** The usable (plain) value of each secret in the file; protected ones are decrypted with `reveal`, and are left out when they cannot be. */
export function readEnvSecrets(text: string, reveal: (stored: string) => string | null): { values: Record<string, string>; unreadable: string[] } {
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const l of splitLines(text)) {
    if (!isSecret(l.name) || !l.value) continue;
    if (!isProtectedValue(l.value)) {
      values[l.name as string] = l.value;
      continue;
    }
    const plain = reveal(l.value);
    if (plain) values[l.name as string] = plain;
    else unreadable.push(l.name as string);
  }
  return { values, unreadable };
}

export type RewriteResult = { ok: true; text: string; changed: number } | { ok: false; error: string };

/** Replaces each plain secret value with `protect(value)`. Fails (changing nothing) when a value did not come back protected or does not read back identical. */
export function protectEnvText(text: string, protect: (plain: string) => string, reveal: (stored: string) => string | null): RewriteResult {
  let changed = 0;
  const out: string[] = [];
  for (const l of splitLines(text)) {
    if (!isSecret(l.name) || !l.value || isProtectedValue(l.value)) {
      out.push(l.raw);
      continue;
    }
    const stored = protect(l.value);
    if (!isProtectedValue(stored)) return { ok: false, error: "This computer cannot protect the keys right now, so they were left as they were." };
    if (reveal(stored) !== l.value) return { ok: false, error: "The protected copy did not read back correctly, so the keys were left as they were." };
    out.push(`${l.name}=${stored}`);
    changed++;
  }
  return { ok: true, text: out.join("\n"), changed };
}

/** The reverse: every protected secret becomes plain text again. Fails (changing nothing) if any cannot be decrypted. */
export function unprotectEnvText(text: string, reveal: (stored: string) => string | null): RewriteResult {
  let changed = 0;
  const out: string[] = [];
  for (const l of splitLines(text)) {
    if (!isSecret(l.name) || !l.value || !isProtectedValue(l.value)) {
      out.push(l.raw);
      continue;
    }
    const plain = reveal(l.value);
    if (!plain) return { ok: false, error: "One of the protected keys cannot be read on this computer, so nothing was changed." };
    out.push(`${l.name}=${plain}`);
    changed++;
  }
  return { ok: true, text: out.join("\n"), changed };
}
