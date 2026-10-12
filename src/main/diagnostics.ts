// Persistent crash / stability diagnostics. Anything that goes wrong inside Clynx's processes (the window's renderer dying, the GPU or a helper process
// exiting, the main process throwing, the window freezing, the app not shutting down cleanly last time) is appended as one JSON line to
// <data folder>/logs/diagnostics.log, so a problem that happened while nobody was watching can still be looked at afterwards. Nothing here changes
// what the app does; it only writes down what happened. The file is kept small (one older copy is kept when it passes 1 MB).
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DIAGNOSTICS_MAX_BYTES = 1_000_000;

export interface DiagnosticsLog {
  readonly file: string;
  /** Appends one entry. Never throws: diagnostics must not be able to break the app. */
  record(kind: string, details?: Record<string, unknown>): void;
  /** Marks this run as started; if the previous run never marked itself finished, records that. Returns whether the last run ended badly. */
  beginSession(info?: Record<string, unknown>): boolean;
  /** Marks this run as finished cleanly. */
  endSession(): void;
}

function clip(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 8).join("\n") };
  if (typeof value === "string") return value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  if (value && typeof value === "object" && depth < 3) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clip(v, depth + 1);
    return out;
  }
  return value;
}

export function createDiagnosticsLog(dir: string, now: () => number = Date.now): DiagnosticsLog {
  const file = path.join(dir, "diagnostics.log");
  const marker = path.join(dir, "session-running");
  const record = (kind: string, details: Record<string, unknown> = {}): void => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > DIAGNOSTICS_MAX_BYTES) renameSync(file, file + ".old");
      } catch {
        // no file yet
      }
      appendFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), kind, ...(clip(details) as object) }) + "\n", "utf-8");
    } catch {
      // never let logging break anything
    }
  };
  return {
    file,
    record,
    beginSession(info = {}) {
      let badEnd = false;
      try {
        badEnd = existsSync(marker);
        mkdirSync(dir, { recursive: true });
        if (badEnd) record("previous-session-ended-unexpectedly", { note: "the app was closed without shutting down (crash, power loss, killed from Task Manager)" });
        writeFileSync(marker, String(now()), "utf-8");
      } catch {
        // ignore
      }
      record("session-start", info);
      return badEnd;
    },
    endSession() {
      try {
        if (existsSync(marker)) unlinkSync(marker);
      } catch {
        // ignore
      }
      record("session-end");
    },
  };
}

/** Allows at most `max` automatic recoveries in any `windowMs` span, so a window that keeps crashing is not reloaded forever. */
export function createRecoveryLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const times: number[] = [];
  return {
    tryAcquire(): boolean {
      const t = now();
      while (times.length && t - times[0] > windowMs) times.shift();
      if (times.length >= max) return false;
      times.push(t);
      return true;
    },
  };
}
