// Scheduled safety copies of the Database, with rotation, verification and a safe restore path (Phase 7).
//
//   backups live in <user data folder>/backups/clynx-YYYYMMDD-HHMMSS.db
//   createBackup()     copies the live database with SQLite's online-backup API (incremental, never freezes the app), checks the copy, then renames it into place
//   planRetention()    keeps the newest few copies plus one per week for a month; everything else is deleted - and only files this module named itself
//   requestRestore()   validates a copy and marks it to be restored at the next start; dbIntegrity.prepareDatabase() then moves the current database aside (never deletes it)
//
// A failed or half-written backup never replaces a good one, and nothing here ever deletes the live database.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const BACKUP_NAME = /^clynx-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
export const MIN_BACKUP_INTERVAL_MS = 20 * 3600_000;
export const KEEP_RECENT = 3;
export const KEEP_WEEKLY = 4;
export const MAX_DB_BYTES_FOR_BACKUP = 4 * 1024 ** 3;

export interface BackupInfo {
  file: string; // absolute path
  name: string;
  takenAt: number; // ms since epoch (from the name, local time)
  bytes: number;
}

export function backupDirFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), "backups");
}

export function backupFileName(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `clynx-${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
}

export function listBackups(dir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = BACKUP_NAME.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      out.push({ file, name, takenAt: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), bytes: st.size });
    } catch {
      /* vanished */
    }
  }
  return out.sort((a, b) => b.takenAt - a.takenAt);
}

export function shouldBackup(existing: BackupInfo[], now: number, minIntervalMs = MIN_BACKUP_INTERVAL_MS): boolean {
  return existing.length === 0 || now - existing[0].takenAt >= minIntervalMs;
}

/** Which copies to delete: keep the newest `recent`, plus the newest copy of each earlier calendar week (up to `weekly` such weeks). */
export function planRetention(existing: BackupInfo[], recent = KEEP_RECENT, weekly = KEEP_WEEKLY): BackupInfo[] {
  const sorted = [...existing].sort((a, b) => b.takenAt - a.takenAt);
  const keep = new Set(sorted.slice(0, recent).map((b) => b.file));
  const weekKey = (t: number) => Math.floor((t - Date.UTC(1970, 0, 5)) / (7 * 86400_000)); // weeks starting on Monday
  const covered = new Set(sorted.slice(0, recent).map((b) => weekKey(b.takenAt)));
  let weeklyKept = 0;
  for (const b of sorted.slice(recent)) {
    const w = weekKey(b.takenAt);
    if (covered.has(w) || weeklyKept >= weekly) continue;
    covered.add(w);
    keep.add(b.file);
    weeklyKept++;
  }
  return sorted.filter((b) => !keep.has(b.file));
}

/** A full check of a backup file: it opens, passes SQLite's integrity check, and has tables. */
export function verifyDatabaseFile(file: string): { ok: true; tables: number } | { ok: false; reason: string } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA quick_check(3)").all().map((r) => String(Object.values(r)[0]));
    if (!(rows.length === 1 && rows[0] === "ok")) return { ok: false, reason: `the copy is damaged (${rows.join("; ").slice(0, 200)})` };
    const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    if (tables === 0) return { ok: false, reason: "the copy is empty" };
    return { ok: true, tables };
  } catch (err) {
    return { ok: false, reason: `the copy could not be opened (${(err as Error).message})` };
  } finally {
    try {
      db?.close();
    } catch {
      /* closed */
    }
  }
}

export type BackupOutcome = { ok: true; file: string; bytes: number; deleted: string[] } | { ok: false; skipped: boolean; reason: string };

/**
 * Takes one backup if one is due. `copyTo` writes a consistent copy of the live database to the given path (Store.backupDatabaseAsync).
 * Never throws. `force` ignores the minimum interval (the "Back up now" button).
 */
export async function createBackup(opts: { dbPath: string; copyTo: (dest: string) => Promise<void>; now?: number; force?: boolean; recent?: number; weekly?: number; minFreeFactor?: number }): Promise<BackupOutcome> {
  const now = opts.now ?? Date.now();
  const dir = backupDirFor(opts.dbPath);
  try {
    if (!existsSync(opts.dbPath)) return { ok: false, skipped: true, reason: "There is no database yet." };
    const dbBytes = statSync(opts.dbPath).size;
    if (dbBytes > MAX_DB_BYTES_FOR_BACKUP) return { ok: false, skipped: true, reason: "The database is too large for automatic backups." };
    mkdirSync(dir, { recursive: true });
    const existing = listBackups(dir);
    if (!opts.force && !shouldBackup(existing, now)) return { ok: false, skipped: true, reason: "A recent backup already exists." };
    try {
      const fs = statfsSync(dir);
      if (fs.bavail * fs.bsize < dbBytes * (opts.minFreeFactor ?? 2)) return { ok: false, skipped: true, reason: "Not enough free disk space for a backup." };
    } catch {
      /* free space unknown: go ahead */
    }
    const name = backupFileName(now);
    const final = path.join(dir, name);
    if (existsSync(final)) return { ok: false, skipped: true, reason: "A backup for this second already exists." };
    const tmp = path.join(dir, `${name}.partial`);
    rmSync(tmp, { force: true });
    try {
      await opts.copyTo(tmp);
      const v = verifyDatabaseFile(tmp);
      if (!v.ok) throw new Error(v.reason);
      renameSync(tmp, final);
    } catch (err) {
      rmSync(tmp, { force: true });
      return { ok: false, skipped: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // rotation only ever touches files whose names this module generated
    const deleted: string[] = [];
    for (const old of planRetention(listBackups(dir), opts.recent, opts.weekly)) {
      try {
        unlinkSync(old.file);
        deleted.push(old.name);
      } catch {
        /* keep it; try again next time */
      }
    }
    return { ok: true, file: final, bytes: statSync(final).size, deleted };
  } catch (err) {
    return { ok: false, skipped: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---- restore ------------------------------------------------------------------------------------------------------------------------------------------------------
export function restoreMarkerPath(dbPath: string): string {
  return `${dbPath}.restore-requested`;
}

/** Validates the chosen backup (it must be one of this folder's own backups) and marks it to be restored at the next start. */
export function requestRestore(dbPath: string, backupName: string): { ok: true } | { ok: false; reason: string } {
  const dir = backupDirFor(dbPath);
  if (!BACKUP_NAME.test(backupName)) return { ok: false, reason: "That is not one of Clynx's backups." };
  const file = path.join(dir, backupName);
  if (!existsSync(file)) return { ok: false, reason: "That backup no longer exists." };
  const v = verifyDatabaseFile(file);
  if (!v.ok) return { ok: false, reason: `That backup cannot be used: ${v.reason}.` };
  writeFileSync(restoreMarkerPath(dbPath), JSON.stringify({ backup: backupName, requestedAt: Date.now() }), "utf-8");
  return { ok: true };
}

/**
 * Called at startup before the database is opened. If a restore was requested, moves the current database aside (via `quarantine`, which keeps it) and puts the backup in its
 * place. The marker is only consumed once the copy is in place, so a failure is retried at the next start and the current database is never lost.
 */
export function applyPendingRestore(dbPath: string, quarantine: (dbPath: string) => string): null | { restoredFrom: string; keptCopy: string | null } | { error: string } {
  const marker = restoreMarkerPath(dbPath);
  if (!existsSync(marker)) return null;
  try {
    const raw = JSON.parse(readFileSync(marker, "utf-8")) as { backup?: string };
    const name = String(raw.backup ?? "");
    const file = path.join(backupDirFor(dbPath), name);
    if (!BACKUP_NAME.test(name) || !existsSync(file)) {
      unlinkSync(marker);
      return { error: "The backup chosen for restoring was not found, so nothing was changed." };
    }
    const v = verifyDatabaseFile(file);
    if (!v.ok) {
      unlinkSync(marker);
      return { error: `The backup chosen for restoring cannot be used (${v.reason}), so nothing was changed.` };
    }
    const keptCopy = existsSync(dbPath) ? quarantine(dbPath) : null;
    const staged = `${dbPath}.restoring`;
    copyFileSync(file, staged);
    renameSync(staged, dbPath);
    unlinkSync(marker);
    return { restoredFrom: name, keptCopy };
  } catch (err) {
    return { error: `The restore could not be completed (${err instanceof Error ? err.message : String(err)}); it will be tried again at the next start.` };
  }
}
