// Database integrity checks and a safe recovery path. A damaged database is never deleted or overwritten: it is moved aside (with its
// journal files) as "<name>.corrupt-<time>" for investigation, and Clynx starts a fresh database.
//
//   prepareDatabase()            fast, before the Store opens: honours a requested recovery, checks the file really is a database,
//                                and that its first pages and schema can be read. Costs milliseconds even on a 500 MB file.
//   runIntegrityCheckInBackground()  a full PRAGMA quick_check in a separate process, so a 500 MB file (seconds on a cold disk) never
//                                freezes the app. Run it a while after startup; a failure becomes a persistent notice.
//   requestRecovery()            marks the database to be moved aside at the next start (it cannot be renamed while open).
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DatabaseRecoveryError } from "./startupErrors.js";

const SQLITE_MAGIC = "SQLite format 3\u0000";
const COMPANIONS = ["-journal", "-wal", "-shm"];

export function recoveryMarkerPath(dbPath: string): string {
  return `${dbPath}.recover-requested`;
}

/** Ask for the database to be moved aside and started fresh the next time Clynx starts. */
export function requestRecovery(dbPath: string): void {
  writeFileSync(recoveryMarkerPath(dbPath), String(Date.now()), "utf-8");
}

/** Cheap checks only: it is a SQLite file, and its header page and schema can be read. Returns a plain-words reason when not. */
export function probeDatabaseFile(dbPath: string): { ok: true } | { ok: false; reason: string } {
  try {
    const size = statSync(dbPath).size;
    if (size === 0) return { ok: true }; // an empty file is a database that was never written to: SQLite initialises it
    const fd = openSync(dbPath, "r");
    try {
      const head = Buffer.alloc(16);
      readSync(fd, head, 0, 16, 0);
      if (head.toString("latin1") !== SQLITE_MAGIC) return { ok: false, reason: "the file is not a valid database (its header is damaged)" };
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return { ok: false, reason: `the file could not be read (${(err as Error).message})` };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `the database could not be opened (${(err as Error).message})` };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Moves a database (and its journal files) aside so it is kept for investigation. Returns where the main file went.
 * Falls back to copy-then-delete if a rename is refused; throws only if the original could not be removed (the caller must not
 * then open a "fresh" database on top of it).
 */
export function quarantineDatabase(dbPath: string): string {
  let dest = `${dbPath}.corrupt-${Date.now()}`;
  for (let i = 2; existsSync(dest); i++) dest = `${dbPath}.corrupt-${Date.now()}-${i}`; // never overwrite an earlier kept copy
  const move = (from: string, to: string) => {
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
      try {
        unlinkSync(from);
      } catch (err) {
        // The original could not be removed (something holds it open), so it is still exactly where it was: drop the redundant copy
        // rather than leave a second 500 MB file behind for every retry, and let the caller report the failure.
        try {
          unlinkSync(to);
        } catch {
          (err as { savedCopy?: string }).savedCopy = to; // could not even remove the copy: say where it is
        }
        throw err;
      }
    }
  };
  move(dbPath, dest);
  for (const suffix of COMPANIONS) {
    const companion = `${dbPath}${suffix}`;
    if (existsSync(companion)) {
      try {
        move(companion, `${dest}${suffix}`);
      } catch {
        /* a journal that cannot be moved is harmless without its database; SQLite ignores a mismatched one */
      }
    }
  }
  return dest;
}

/** quarantineDatabase, but a failure becomes a DatabaseRecoveryError the app can explain to the user (nothing is ever deleted). */
function quarantineOrThrow(dbPath: string): string {
  try {
    return quarantineDatabase(dbPath);
  } catch (err) {
    throw new DatabaseRecoveryError(`The damaged database could not be moved aside: ${(err as Error).message}`, (err as { savedCopy?: string }).savedCopy ?? null, err);
  }
}

export interface DatabasePrep {
  // null: nothing wrong, open normally
  recovered: null | { reason: string; damagedCopy: string | null; requestedByUser: boolean };
}

/** Run before `new Store(dbPath)`. */
export function prepareDatabase(dbPath: string): DatabasePrep {
  const marker = recoveryMarkerPath(dbPath);
  if (existsSync(marker)) {
    const consume = () => {
      try {
        unlinkSync(marker);
      } catch {
        /* a stuck marker only means this happens once more */
      }
    };
    if (existsSync(dbPath)) {
      // The request is only used up once the database has really been moved aside: if that fails (file held open), the marker stays so
      // the next try, after the user fixes the cause, still does what they asked.
      const damagedCopy = quarantineOrThrow(dbPath);
      consume();
      return { recovered: { reason: "you chose to start fresh", damagedCopy, requestedByUser: true } };
    }
    consume();
    return { recovered: null };
  }
  if (!existsSync(dbPath)) return { recovered: null };
  const probe = probeDatabaseFile(dbPath);
  if (probe.ok) return { recovered: null };
  return { recovered: { reason: probe.reason, damagedCopy: quarantineOrThrow(dbPath), requestedByUser: false } };
}

/**
 * Opens a store, recovering once if opening fails because the database is damaged. `open` builds the Store (runs its migrations).
 */
export function openWithRecovery<T>(dbPath: string, open: () => T): { store: T; recovered: DatabasePrep["recovered"] } {
  let recovered = prepareDatabase(dbPath).recovered;
  try {
    return { store: open(), recovered };
  } catch (err) {
    // Opening itself failed (a damaged page the quick probe could not see). Keep the file, start fresh once.
    if (!existsSync(dbPath)) throw err;
    const reason = `the database could not be used (${(err as Error).message})`;
    recovered = { reason, damagedCopy: quarantineOrThrow(dbPath), requestedByUser: false };
    try {
      return { store: open(), recovered };
    } catch (second) {
      // Even a fresh database could not be started (disk full, folder locked): the old one is safe; say what happened.
      throw new DatabaseRecoveryError(`A new database could not be started: ${(second as Error).message}`, recovered.damagedCopy, second);
    }
  }
}

export interface IntegrityResult {
  ok: boolean;
  // "ok", or the first problems SQLite reported, or why the check could not run
  detail: string;
  ms: number;
}

// Runs in a child process (node, or Electron acting as node): a full quick_check on a large file must not block the app.
const CHECK_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync(process.argv[1]);
  db.exec("PRAGMA busy_timeout = 30000"); // the app may be writing at the same moment
  const rows = db.prepare("PRAGMA quick_check(5)").all();
  const lines = rows.map((r) => String(Object.values(r)[0]));
  process.stdout.write(JSON.stringify({ ok: lines.length === 1 && lines[0] === "ok", detail: lines.join("; ") }));
} catch (err) {
  const message = String(err && err.message || err);
  // A busy/locked database is not a damaged one: report it as inconclusive.
  process.stdout.write(JSON.stringify({ ok: /locked|busy/i.test(message), detail: message }));
}
`;

export function runIntegrityCheckInBackground(dbPath: string, timeoutMs = 10 * 60_000): Promise<IntegrityResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: Omit<IntegrityResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(process.execPath, ["-e", CHECK_SCRIPT, dbPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    } catch (err) {
      resolve({ ok: true, detail: `integrity check could not start (${(err as Error).message})`, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      // A check that could not finish says nothing about the database: do not alarm the user.
      done({ ok: true, detail: "integrity check timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", (err) => done({ ok: true, detail: `integrity check could not run (${err.message})` }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        done({ ok: !!parsed.ok, detail: String(parsed.detail ?? "") });
      } catch {
        done({ ok: true, detail: "integrity check gave no answer" });
      }
    });
  });
}
