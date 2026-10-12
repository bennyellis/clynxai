// Phase 1, stage 1: settings and session files are written atomically, the last good copy is kept, and a damaged file is never
// silently replaced by defaults (it is kept aside and the user is told).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { preserveCopy, readJsonFileSafe, writeFileAtomic, writeFileAtomicWithBackup } from "../safeFs.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig, takeConfigLoadNotice } from "../config.js";
import { readSession, writeSession } from "../cloudClient.js";
import { NoticeBoard } from "../appNotices.js";
import { check, run, section } from "./_testkit.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "clynx-safefiles-"));
const file = (n: string) => path.join(dir, n);
const names = () => readdirSync(dir).sort();

run(async () => {
  section("atomic write: no half-written file, no temp files left behind");
  {
    const p = file("a.json");
    writeFileAtomic(p, JSON.stringify({ v: 1 }));
    check("the file holds the new content", JSON.parse(readFileSync(p, "utf-8")).v === 1);
    writeFileAtomic(p, JSON.stringify({ v: 2 }));
    check("replacing an existing file works", JSON.parse(readFileSync(p, "utf-8")).v === 2);
    check("no temporary files remain", names().every((n) => !n.includes(".tmp-")), names());
    // An interrupted write leaves only a temp file; the real file is untouched.
    writeFileSync(`${p}.tmp-999-1`, '{"v": 3, "half');
    check("a leftover temp file from a crash does not affect the real file", JSON.parse(readFileSync(p, "utf-8")).v === 2);
    let threw = false;
    try {
      writeFileAtomic(path.join(dir, "no-such-folder", "x.json"), "{}");
    } catch {
      threw = true;
    }
    check("a failed write throws (it is not swallowed) and leaves the real file alone", threw && JSON.parse(readFileSync(p, "utf-8")).v === 2);
  }

  section("backup: the previous good content is kept as .bak, a bad one is not");
  {
    const p = file("b.json");
    writeFileAtomicWithBackup(p, JSON.stringify({ v: 1 }));
    check("a first write has nothing to back up", !existsSync(`${p}.bak`));
    writeFileAtomicWithBackup(p, JSON.stringify({ v: 2 }));
    check("the second write keeps v1 as the backup", JSON.parse(readFileSync(`${p}.bak`, "utf-8")).v === 1);
    writeFileSync(p, "{ not json");
    writeFileAtomicWithBackup(p, JSON.stringify({ v: 3 }));
    check("a damaged current file does not overwrite the good backup", JSON.parse(readFileSync(`${p}.bak`, "utf-8")).v === 1);
    check("and the new content is written", JSON.parse(readFileSync(p, "utf-8")).v === 3);
    const env = file("c.env");
    writeFileAtomicWithBackup(env, "A=1\n", () => true);
    writeFileAtomicWithBackup(env, "A=2\n", () => true);
    check("non-JSON files (.env) are backed up too", readFileSync(`${env}.bak`, "utf-8") === "A=1\n");
  }

  section("reading: a damaged file is kept aside and the last good copy restored");
  {
    const p = file("d.json");
    check("no file at all: missing", readJsonFileSafe(p).status === "missing");
    writeFileAtomicWithBackup(p, JSON.stringify({ v: 1 }));
    writeFileAtomicWithBackup(p, JSON.stringify({ v: 2 }));
    check("a good file reads normally", readJsonFileSafe<{ v: number }>(p).value?.v === 2);
    writeFileSync(p, '{"v": 3, "trunc'); // a truncated write
    const r = readJsonFileSafe<{ v: number }>(p);
    check("damaged with a backup: restored from the backup", r.status === "restored" && r.value?.v === 1, r);
    check("the damaged original is kept for investigation", !!r.quarantinedTo && existsSync(r.quarantinedTo) && readFileSync(r.quarantinedTo, "utf-8").includes("trunc"));
    check("and the real file is whole again", JSON.parse(readFileSync(p, "utf-8")).v === 1);

    const q = file("e.json");
    writeFileSync(q, "garbage");
    const r2 = readJsonFileSafe(q);
    check("damaged with no backup: reported as damaged (never an exception)", r2.status === "damaged" && r2.value === null, r2);
    check("and the damaged file is still on disk under another name", !!r2.quarantinedTo && readFileSync(r2.quarantinedTo, "utf-8") === "garbage");

    const g = file("f.json");
    writeFileAtomicWithBackup(g, '{"v":1}');
    writeFileAtomicWithBackup(g, '{"v":2}');
    rmSync(g);
    check("the real file deleted but a backup exists: restored", readJsonFileSafe<{ v: number }>(g).status === "restored" && existsSync(g));
    const empty = file("h.json");
    writeFileSync(empty, "");
    check("an empty file counts as damaged", readJsonFileSafe(empty).status === "damaged");
    check("preserveCopy keeps a copy and leaves the original", (() => { const c = preserveCopy(g); return !!c && existsSync(c) && existsSync(g); })());
  }

  section("config.json: a damaged file is never silently replaced by defaults");
  {
    const p = file("config.json");
    check("no config yet: defaults, no notice", (() => { const c = loadConfig(p); return c.minProfitMarginPercent === DEFAULT_CONFIG.minProfitMarginPercent && takeConfigLoadNotice() === null; })());

    const base = loadConfig(p);
    saveConfig(p, { ...base, minProfitMarginPercent: 777 });
    saveConfig(p, { ...base, minProfitMarginPercent: 778 });
    check("a saved setting reads back", loadConfig(p).minProfitMarginPercent === 778);
    check("a normal load leaves no notice", takeConfigLoadNotice() === null);

    // The file is truncated mid-write (what the old non-atomic write could produce).
    writeFileSync(p, readFileSync(p, "utf-8").slice(0, 40));
    const restored = loadConfig(p);
    const n1 = takeConfigLoadNotice();
    check("damaged config with a backup: the last good settings come back (777), not defaults", restored.minProfitMarginPercent === 777, restored.minProfitMarginPercent);
    check("and the user is told it was restored, with the damaged file kept", n1?.kind === "restored" && !!n1.savedCopy && existsSync(n1.savedCopy), n1);

    // No backup: remove it, damage the file.
    rmSync(`${p}.bak`, { force: true });
    writeFileSync(p, "{{{ nonsense");
    const reset = loadConfig(p);
    const n2 = takeConfigLoadNotice();
    check("damaged config with no backup: defaults are used", reset.minProfitMarginPercent === DEFAULT_CONFIG.minProfitMarginPercent);
    check("but the user is told, and the damaged file is kept (not overwritten)", n2?.kind === "reset" && !!n2.savedCopy && readFileSync(n2.savedCopy, "utf-8") === "{{{ nonsense", n2);
    saveConfig(p, reset); // what bootstrapUserSession does next
    check("saving the defaults afterwards does not destroy the kept copy", !!n2?.savedCopy && existsSync(n2.savedCopy));

    // Parses as JSON but is not a settings object.
    writeFileSync(p, "[1,2,3]");
    const odd = loadConfig(p);
    const n3 = takeConfigLoadNotice();
    check("a file that is JSON but not settings: defaults + notice + a preserved copy", odd.minProfitMarginPercent === DEFAULT_CONFIG.minProfitMarginPercent && n3?.kind === "reset" && !!n3.savedCopy && readFileSync(n3.savedCopy, "utf-8") === "[1,2,3]", n3);
  }

  section("cloud-session.json: written atomically; a damaged file falls back to the last good session");
  {
    const p = file("cloud-session.json");
    const s1 = { deviceId: "d1", refreshToken: "r1", userId: "u1", email: "a@b.c", apiUrl: "https://x" };
    writeSession(p, s1);
    writeSession(p, { ...s1, refreshToken: "r2" });
    check("a session reads back", readSession(p).refreshToken === "r2");
    writeFileSync(p, '{"deviceId":"d1","refreshTok');
    const back = readSession(p);
    check("a truncated session file does not log the user out: the previous refresh token is used", back.refreshToken === "r1" && back.userId === "u1", back);
    check("the session writes left no temp files of their own", names().every((n) => !n.includes(".tmp-") || n === "a.json.tmp-999-1"), names());
    writeFileSync(p, "xx");
    rmSync(`${p}.bak`, { force: true });
    check("unrecoverable: reads as signed out, no exception", readSession(p).refreshToken === null);
  }

  section("notice board (used for these warnings)");
  {
    const seen: number[] = [];
    const board = new NoticeBoard((l) => seen.push(l.length));
    board.set({ id: "a", severity: "warning", title: "t", message: "m", action: "dismiss", actionLabel: "ok" });
    board.set({ id: "b", severity: "error", title: "t", message: "m", action: "dismiss", actionLabel: "ok" });
    check("most severe first", board.list()[0].id === "b");
    board.set({ id: "a", severity: "warning", title: "t2", message: "m", action: "dismiss", actionLabel: "ok" });
    check("setting an id again replaces it (one notice per id)", board.list().length === 2 && board.list().find((n) => n.id === "a")?.title === "t2");
    board.clear("b");
    check("clearing removes it and tells listeners", board.list().length === 1 && seen[seen.length - 1] === 1);
    board.clearPrefix("a");
    check("clearPrefix removes the matching ones", board.list().length === 0);
  }

  rmSync(dir, { recursive: true, force: true });
});
