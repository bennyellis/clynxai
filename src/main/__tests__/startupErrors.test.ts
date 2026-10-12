// Phase 2, item 6: when opening the user's data fails (a damaged database that cannot be moved aside, a full disk, a locked folder) the
// user gets a visible, actionable problem, and the damaged database is never lost.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openWithRecovery, prepareDatabase, requestRecovery } from "../dbIntegrity.js";
import { DatabaseRecoveryError, describeStartupFailure } from "../startupErrors.js";
import { check, run, section } from "./_testkit.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "clynx-startup-"));
let n = 0;
const fresh = () => {
  const p = path.join(dir, `case${++n}`, "scout.db");
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
};
const errno = (code: string, msg = "boom") => Object.assign(new Error(msg), { code });

run(async () => {
  section("the words the user sees");
  {
    const locked = describeStartupFailure(new DatabaseRecoveryError("The damaged database could not be moved aside: EBUSY", "C:\\x\\scout.db.corrupt-1", errno("EBUSY")), "C:\\data\\user1");
    check("a damaged database that cannot be moved: says so, says nothing was deleted, names the kept copy and offers the folder", locked.kind === "database-locked" && /couldn't move it aside/.test(locked.title) && /Nothing was deleted/.test(locked.message) && /scout\.db\.corrupt-1/.test(locked.message) && locked.folder === "C:\\data\\user1", locked);
    check("it tells the user what to try (close other programs, restart, Try again)", /antivirus|backup/.test(locked.message) && /Try again/.test(locked.message));
    const full = describeStartupFailure(errno("ENOSPC", "ENOSPC: no space left on device, write"), "D:\\data");
    check("a full disk is explained as a full disk", full.kind === "disk-full" && /no free space/.test(full.message) && /Try again/.test(full.message), full);
    const perm = describeStartupFailure(errno("EPERM", "EPERM: operation not permitted, open 'C:\\x'"), null);
    check("a permission error is explained without the raw path text", perm.kind === "permission" && !/EPERM|operation not permitted/.test(perm.message) && perm.folder === null, perm);
    const odd = describeStartupFailure(new Error("Something odd\n    at foo (bar.js:1:1)\n    at baz"), "C:\\data");
    check("anything else: one line of detail, never a stack trace", odd.kind === "unknown" && /Something odd/.test(odd.message) && !/at foo|bar\.js/.test(odd.message), odd);
    check("a non-Error is handled", describeStartupFailure("plain string", null).kind === "unknown");
  }

  section("a locked damaged database: a typed error, and the file is still there and still intact");
  {
    const p = fresh();
    const db = new DatabaseSync(p); // SQLite keeps the file open without sharing delete/rename on Windows (a stand-in for antivirus or a second Clynx)
    db.exec("CREATE TABLE precious (x TEXT); INSERT INTO precious VALUES ('keep me');");
    requestRecovery(p);
    let err: unknown = null;
    try {
      prepareDatabase(p);
    } catch (e) {
      err = e;
    }
    if (process.platform === "win32") {
      check("moving a locked database aside fails with a DatabaseRecoveryError (not a raw EBUSY)", err instanceof DatabaseRecoveryError, String(err));
      const problem = describeStartupFailure(err, path.dirname(p));
      check("which describes itself in plain words", problem.kind === "database-locked" && /Nothing was deleted/.test(problem.message), problem);
    } else {
      check("(non-Windows: a rename of an open file succeeds; locked-file case not applicable)", true);
    }
    db.close();
    check("the original database is still there", existsSync(p) || Object.keys(readdirSafe(path.dirname(p))).some((f) => f.startsWith("scout.db.corrupt-")));
    const source = existsSync(p) ? p : path.join(path.dirname(p), readdirSafe(path.dirname(p)).find((f) => f.startsWith("scout.db.corrupt-") && !f.endsWith("-journal"))!);
    const again = new DatabaseSync(source);
    check("and its data is intact", (again.prepare("SELECT x FROM precious").get() as any).x === "keep me");
    again.close();
  }

  section("a fresh database that cannot be started after the old one was moved aside");
  {
    const p = fresh();
    writeFileSync(p, Buffer.concat([Buffer.from("not sqlite at all, long enough to look like a file "), Buffer.alloc(4096, 1)]));
    let calls = 0;
    let err: unknown = null;
    try {
      openWithRecovery(p, () => {
        calls++;
        throw errno("ENOSPC", "ENOSPC: no space left on device");
      });
    } catch (e) {
      err = e;
    }
    check("the disk-full error reaches the app as it is (and is explained below)", (err as NodeJS.ErrnoException | null)?.code === "ENOSPC", String(err));
    const kept = readdirSafe(path.dirname(p)).filter((f) => f.startsWith("scout.db.corrupt-"));
    check("the damaged file was moved aside and kept (not deleted) even though nothing new could start", kept.length === 1 && readFileSync(path.join(path.dirname(p), kept[0]), "utf-8").startsWith("not sqlite"), kept);
    check("the user is told it is a full disk", describeStartupFailure(err, path.dirname(p)).kind === "disk-full");
    check("the open was tried at most twice (no loop)", calls <= 2, calls);
  }

  section("a database that passes the quick check but cannot be used, with no room for a replacement");
  {
    const p = fresh();
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE precious (x TEXT); INSERT INTO precious VALUES ('keep me');");
    db.close();
    let calls = 0;
    let err: unknown = null;
    try {
      openWithRecovery(p, () => {
        calls++;
        throw errno(calls === 1 ? "SQLITE" : "ENOSPC", calls === 1 ? "database disk image is malformed" : "ENOSPC: no space left on device");
      });
    } catch (e) {
      err = e;
    }
    check("the second failure is wrapped in a DatabaseRecoveryError that names the kept copy", err instanceof DatabaseRecoveryError && !!err.damagedCopy && existsSync(err.damagedCopy), String(err));
    check("it is explained as a full disk, with the folder", (() => { const d = describeStartupFailure(err, path.dirname(p)); return d.kind === "disk-full" && d.folder === path.dirname(p); })());
    const kept = (err as DatabaseRecoveryError).damagedCopy!;
    const again = new DatabaseSync(kept);
    check("the kept database still has its data", (again.prepare("SELECT x FROM precious").get() as any).x === "keep me");
    again.close();
  }

  rmSync(dir, { recursive: true, force: true });
});

function readdirSafe(d: string): string[] {
  try {
    return require("node:fs").readdirSync(d);
  } catch {
    return [];
  }
}
