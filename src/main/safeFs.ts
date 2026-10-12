// Safe file persistence for the small settings files (config.json, cloud-session.json, app-settings.json, .env).
//
//  - writes go to a temporary file in the same folder, are flushed to disk, then replace the real file in one step, so a crash or
//    power loss leaves either the old file or the new one, never half of one;
//  - before replacing a file that currently holds valid data, that data is kept as "<file>.bak" (the last known-good copy);
//  - reading a JSON file that is damaged never loses it: the damaged file is moved aside as "<file>.corrupt-<time>" for
//    investigation, the last known-good copy is restored when there is one, and the caller is told what happened.
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Replaces `filePath` with `data` atomically (temp file in the same folder, flushed, then renamed over the target). */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data, 0, "utf-8");
    try {
      fsyncSync(fd);
    } catch {
      // some file systems cannot flush; the rename below is still atomic
    }
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
  closeSync(fd);
  // On Windows the target can be briefly locked by an indexer or antivirus scan: retry a few times.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      sleepSync(25 * (attempt + 1));
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* nothing to clean */
  }
  throw lastErr;
}

/**
 * Atomic write that also keeps the previous contents as "<file>.bak" when they were valid. `validate` defaults to "parses as JSON";
 * pass `() => true` for files that are not JSON (.env).
 */
export function writeFileAtomicWithBackup(filePath: string, data: string, validate: (text: string) => boolean = isValidJson): void {
  if (existsSync(filePath)) {
    try {
      const previous = readFileSync(filePath, "utf-8");
      if (previous.trim() && validate(previous) && previous !== data) writeFileAtomic(`${filePath}.bak`, previous);
    } catch {
      // an unreadable previous file is simply not backed up; the new write below still goes ahead
    }
  }
  writeFileAtomic(filePath, data);
}

export type JsonReadStatus =
  | "missing" // no file (and no backup): a first run
  | "ok" // read normally
  | "restored" // the file was damaged (or gone); the last known-good copy was restored
  | "damaged"; // the file was damaged and no good copy exists; the caller starts from defaults

export interface JsonReadResult<T = unknown> {
  status: JsonReadStatus;
  value: T | null;
  // Where the damaged original now lives (status restored/damaged), kept for investigation.
  quarantinedTo: string | null;
}

/**
 * Reads a JSON file without ever losing it. See the header comment. Never throws.
 */
export function readJsonFileSafe<T = unknown>(filePath: string): JsonReadResult<T> {
  const bak = `${filePath}.bak`;
  const tryParse = (p: string): { ok: true; value: T } | { ok: false } => {
    try {
      const text = readFileSync(p, "utf-8");
      if (!text.trim()) return { ok: false };
      return { ok: true, value: JSON.parse(text) as T };
    } catch {
      return { ok: false };
    }
  };

  if (!existsSync(filePath)) {
    // The main file is gone but a good copy exists (it was deleted, or lost in a crash): bring it back.
    if (existsSync(bak)) {
      const good = tryParse(bak);
      if (good.ok) {
        try {
          copyFileSync(bak, filePath);
        } catch {
          /* the value is still returned */
        }
        return { status: "restored", value: good.value, quarantinedTo: null };
      }
    }
    return { status: "missing", value: null, quarantinedTo: null };
  }

  const main = tryParse(filePath);
  if (main.ok) return { status: "ok", value: main.value, quarantinedTo: null };

  // Damaged: move it aside first, so nothing can overwrite it.
  let quarantinedTo: string | null = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, quarantinedTo);
  } catch {
    try {
      copyFileSync(filePath, quarantinedTo);
    } catch {
      quarantinedTo = null;
    }
  }
  if (existsSync(bak)) {
    const good = tryParse(bak);
    if (good.ok) {
      try {
        copyFileSync(bak, filePath);
      } catch {
        /* the value is still returned */
      }
      return { status: "restored", value: good.value, quarantinedTo };
    }
  }
  return { status: "damaged", value: null, quarantinedTo };
}

/** Copies a file that could not be used (but is not necessarily unreadable) aside for investigation. Returns the copy's path. */
export function preserveCopy(filePath: string, label = "unreadable"): string | null {
  try {
    const dest = `${filePath}.${label}-${Date.now()}`;
    copyFileSync(filePath, dest);
    return dest;
  } catch {
    return null;
  }
}
