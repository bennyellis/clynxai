// Phase 7: scheduled database backups - a verified copy is made without touching the live file, old copies rotate, failures leave nothing half-written,
// and a restore moves the current database aside (kept) before putting the chosen backup in place.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { applyPendingRestore, backupDirFor, backupFileName, createBackup, listBackups, planRetention, requestRestore, restoreMarkerPath, shouldBackup, verifyDatabaseFile, type BackupInfo } from "../dbBackups.js";
import { prepareDatabase, quarantineDatabase } from "../dbIntegrity.js";
import { check, run, section } from "./_testkit.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-backup-"));
const newDb = (name: string, rows: number) => {
  const p = path.join(root, name, "scout.db");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)");
  const ins = db.prepare("INSERT INTO products (name) VALUES (?)");
  for (let i = 0; i < rows; i++) ins.run(`product ${i}`);
  return { path: p, db };
};
const copier = (db: DatabaseSync) => (dest: string) => sqliteBackup(db, dest, { rate: 50 }).then(() => undefined);
const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h, 0, 0).getTime();
const info = (t: number): BackupInfo => ({ file: `/b/${backupFileName(t)}`, name: backupFileName(t), takenAt: t, bytes: 1 });

run(async () => {
  section("names and schedule");
  {
    const t = at(2026, 10, 12, 9);
    check("file names are sortable timestamps and parse back", listBackups(path.join(root, "none")).length === 0 && /^clynx-20261012-090000\.db$/.test(backupFileName(t)));
    check("a backup is due when there is none, or the newest is over 20 hours old", shouldBackup([], t) && shouldBackup([info(t - 21 * 3600_000)], t) && !shouldBackup([info(t - 3600_000)], t));
  }

  section("creating a backup");
  {
    const { path: dbPath, db } = newDb("a", 500);
    const before = fs.readFileSync(dbPath);
    const t = at(2026, 10, 12, 9);
    const r = await createBackup({ dbPath, copyTo: copier(db), now: t });
    check("a backup is created, verified and named by time", r.ok && path.basename(r.file) === backupFileName(t), r);
    if (r.ok) {
      const v = verifyDatabaseFile(r.file);
      const copy = new DatabaseSync(r.file, { readOnly: true });
      const n = (copy.prepare("SELECT count(*) AS n FROM products").get() as { n: number }).n;
      copy.close();
      check("the copy holds every row", v.ok && n === 500, { v, n });
    }
    check("the live database file is not modified by a backup", fs.readFileSync(dbPath).equals(before));
    check("no partial file is left behind", fs.readdirSync(backupDirFor(dbPath)).every((f) => !f.endsWith(".partial")));
    const again = await createBackup({ dbPath, copyTo: copier(db), now: t + 3600_000 });
    check("a second backup within a day is skipped", !again.ok && again.skipped, again);
    const forced = await createBackup({ dbPath, copyTo: copier(db), now: t + 3600_000, force: true });
    check("'Back up now' ignores the interval", forced.ok === true, forced);
    db.close();
  }

  section("failures leave nothing half-written");
  {
    const { path: dbPath, db } = newDb("b", 50);
    const r1 = await createBackup({ dbPath, copyTo: async () => { throw new Error("disk full"); }, now: at(2026, 10, 12) });
    check("a failing copy is reported, not thrown", !r1.ok && !r1.skipped && /disk full/.test(r1.reason), r1);
    const r2 = await createBackup({ dbPath, copyTo: async (dest) => fs.writeFileSync(dest, "this is not a database at all, just text".repeat(50)), now: at(2026, 10, 12) });
    check("a damaged copy is rejected and never becomes a backup", !r2.ok && listBackups(backupDirFor(dbPath)).length === 0 && fs.readdirSync(backupDirFor(dbPath)).length === 0, r2);
    const missing = await createBackup({ dbPath: path.join(root, "nowhere", "scout.db"), copyTo: async () => undefined });
    check("no database yet is a quiet skip", !missing.ok && missing.skipped);
    db.close();
  }

  section("rotation");
  {
    const day = 86400_000;
    const base = at(2026, 10, 12);
    const many = Array.from({ length: 30 }, (_, i) => info(base - i * day)); // 30 daily copies
    const doomed = new Set(planRetention(many).map((b) => b.name));
    const kept = many.filter((b) => !doomed.has(b.name));
    check("the newest 3 are always kept", [0, 1, 2].every((i) => !doomed.has(many[i].name)));
    check("at most 3 recent + 4 weekly copies are kept", kept.length <= 7 && kept.length >= 5, kept.length);
    check("kept older copies are in different weeks", new Set(kept.slice(3).map((b) => Math.floor(b.takenAt / (7 * day)))).size === kept.slice(3).length);
    check("nothing is deleted when there are few copies", planRetention(many.slice(0, 3)).length === 0 && planRetention([]).length === 0);

    const { path: dbPath, db } = newDb("c", 10);
    for (let i = 0; i < 12; i++) {
      await createBackup({ dbPath, copyTo: copier(db), now: base - (11 - i) * day });
    }
    const left = listBackups(backupDirFor(dbPath));
    check("real rotation leaves a bounded set, newest first, and only this module's files", left.length <= 7 && left[0].takenAt === base, left.map((b) => b.name));
    fs.writeFileSync(path.join(backupDirFor(dbPath), "my-notes.txt"), "keep me");
    await createBackup({ dbPath, copyTo: copier(db), now: base + day * 3 });
    check("files that are not backups are never deleted", fs.existsSync(path.join(backupDirFor(dbPath), "my-notes.txt")));
    db.close();
  }

  section("restore");
  {
    const { path: dbPath, db } = newDb("d", 100);
    const t = at(2026, 10, 12, 8);
    const made = await createBackup({ dbPath, copyTo: copier(db), now: t });
    const backupName = made.ok ? path.basename(made.file) : "";
    // the database changes after the backup
    db.exec("DELETE FROM products WHERE id > 40");
    db.close();
    check("requesting a restore of a made-up name or path is refused", !requestRestore(dbPath, "../../scout.db").ok && !requestRestore(dbPath, "clynx-20200101-000000.db").ok && !requestRestore(dbPath, "evil.db").ok);
    const req = requestRestore(dbPath, backupName);
    check("a valid backup can be requested", req.ok && fs.existsSync(restoreMarkerPath(dbPath)), req);
    const r = applyPendingRestore(dbPath, quarantineDatabase);
    check("at the next start the backup is put in place", !!r && "restoredFrom" in r && r.restoredFrom === backupName, r);
    check("the database from before the restore is kept, not deleted", !!r && "keptCopy" in r && !!r.keptCopy && fs.existsSync(r.keptCopy));
    const restored = new DatabaseSync(dbPath, { readOnly: true });
    const n = (restored.prepare("SELECT count(*) AS n FROM products").get() as { n: number }).n;
    restored.close();
    check("the restored database has the backed-up rows", n === 100, n);
    check("the request is used up", !fs.existsSync(restoreMarkerPath(dbPath)) && applyPendingRestore(dbPath, quarantineDatabase) === null);
    check("the normal startup check accepts the restored database", prepareDatabase(dbPath).recovered === null);

    // a backup that vanished or went bad between the request and the restart changes nothing
    const { path: p2, db: db2 } = newDb("e", 5);
    const m2 = await createBackup({ dbPath: p2, copyTo: copier(db2), now: t });
    db2.close();
    if (m2.ok) {
      requestRestore(p2, path.basename(m2.file));
      fs.writeFileSync(m2.file, "garbage".repeat(500));
      const bad = applyPendingRestore(p2, quarantineDatabase);
      check("a backup that went bad before the restart is not used and the live database is untouched", !!bad && "error" in bad && fs.existsSync(p2) && verifyDatabaseFile(p2).ok, bad);
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
});
