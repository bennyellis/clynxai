// Phase 1, stage 2: a damaged database is detected, kept for investigation (never deleted) and replaced by a fresh one; a full
// integrity check runs without blocking the app.
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openWithRecovery, prepareDatabase, probeDatabaseFile, quarantineDatabase, requestRecovery, recoveryMarkerPath, runIntegrityCheckInBackground } from "../dbIntegrity.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "clynx-dbint-"));
let n = 0;
const fresh = (name = "scout.db") => path.join(dir, `case${++n}`, name);
function makeDb(p: string, rows = 3000): void {
  rmSync(path.dirname(p), { recursive: true, force: true });
  require("node:fs").mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX t_body ON t(body);");
  const ins = db.prepare("INSERT INTO t (body) VALUES (?)");
  for (let i = 0; i < rows; i++) ins.run(`row ${i} ${"x".repeat(200)} ${i * 7919}`);
  db.close();
}
function scribble(p: string, offset: number, length: number): void {
  const fd = openSync(p, "r+");
  writeSync(fd, Buffer.alloc(length, 0xab), 0, length, offset);
  closeSync(fd);
}
const list = (p: string) => readdirSync(path.dirname(p)).sort();

run(async () => {
  section("probe: only real, readable SQLite files pass the fast check");
  {
    const good = fresh();
    makeDb(good, 10);
    check("a healthy database passes", probeDatabaseFile(good).ok);
    const junk = fresh();
    require("node:fs").mkdirSync(path.dirname(junk), { recursive: true });
    writeFileSync(junk, "this is not a database, it is a text file that is long enough to look plausible");
    const r = probeDatabaseFile(junk);
    check("a text file is rejected with a plain reason", !r.ok && /not a valid database/.test((r as any).reason), r);
    const empty = fresh();
    require("node:fs").mkdirSync(path.dirname(empty), { recursive: true });
    writeFileSync(empty, "");
    check("an empty file is fine (SQLite initialises it)", probeDatabaseFile(empty).ok);
    const damagedHead = fresh();
    makeDb(damagedHead, 10);
    scribble(damagedHead, 0, 16);
    check("a damaged header is rejected", !probeDatabaseFile(damagedHead).ok);
    check("a missing file is reported, not thrown", !probeDatabaseFile(path.join(dir, "nope", "x.db")).ok);
  }

  section("recovery: the damaged database is kept, never deleted, and the original path is freed");
  {
    const p = fresh();
    makeDb(p, 10);
    writeFileSync(`${p}-journal`, "journal bytes");
    const dest = quarantineDatabase(p);
    check("the database moved aside", !existsSync(p) && existsSync(dest) && dest.includes(".corrupt-"));
    check("its journal went with it", existsSync(`${dest}-journal`) && !existsSync(`${p}-journal`));
    check("the data is intact in the kept copy", (() => { const d = new DatabaseSync(dest); const c = (d.prepare("SELECT count(*) AS c FROM t").get() as any).c; d.close(); return c === 10; })());
  }
  {
    const p = fresh();
    makeDb(p, 10);
    check("a healthy database: nothing recovered", prepareDatabase(p).recovered === null && existsSync(p));
    check("no database at all (first run): nothing to recover", prepareDatabase(fresh()).recovered === null);

    const bad = fresh();
    makeDb(bad, 10);
    scribble(bad, 0, 16);
    const prep = prepareDatabase(bad);
    check("a damaged database is moved aside and reported", !!prep.recovered && !existsSync(bad) && !!prep.recovered.damagedCopy && existsSync(prep.recovered.damagedCopy), prep);
    check("the report carries a plain-words reason", !!prep.recovered && prep.recovered.reason.length > 10 && !prep.recovered.requestedByUser);
  }

  section("user-requested recovery (the 'Back up and start fresh' button)");
  {
    const p = fresh();
    makeDb(p, 10);
    requestRecovery(p);
    check("the request is a marker file next to the database", existsSync(recoveryMarkerPath(p)));
    const prep = prepareDatabase(p);
    check("on the next start the healthy-looking database is still moved aside, and the user is told it was their choice", !!prep.recovered?.requestedByUser && !existsSync(p) && !!prep.recovered.damagedCopy && existsSync(prep.recovered.damagedCopy));
    check("the marker is consumed (it only happens once)", !existsSync(recoveryMarkerPath(p)));
    check("a second start opens normally", prepareDatabase(p).recovered === null);
  }

  section("opening: the real Store recovers from a damaged file instead of failing the login");
  {
    const p = fresh();
    require("node:fs").mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, Buffer.concat([Buffer.from("garbage garbage garbage "), Buffer.alloc(8192, 7)]));
    const opened = openWithRecovery(p, () => new Store(p));
    check("a working empty store is returned", opened.store.listProducts().length === 0 && opened.store.countListings() === 0);
    check("and the damaged file was kept", !!opened.recovered?.damagedCopy && existsSync(opened.recovered.damagedCopy) && readFileSync(opened.recovered.damagedCopy).includes("garbage"));
    opened.store.close();

    const q = fresh();
    makeDb(q, 10);
    let calls = 0;
    const second = openWithRecovery(q, () => {
      if (++calls === 1) throw new Error("database disk image is malformed");
      return new Store(q);
    });
    check("when opening itself fails, the file is kept and a fresh store opens", calls === 2 && !!second.recovered?.damagedCopy && /malformed/.test(second.recovered.reason), second.recovered);
    second.store.close();

    const healthy = fresh();
    const ok = openWithRecovery(healthy, () => new Store(healthy));
    check("a normal first run reports nothing", ok.recovered === null);
    ok.store.close();
  }

  section("full integrity check: runs in a separate process and finds damage the quick probe cannot");
  {
    const good = fresh();
    makeDb(good);
    const r = await runIntegrityCheckInBackground(good);
    check("a healthy database reports ok", r.ok && r.detail === "ok", r);

    const bad = fresh();
    makeDb(bad);
    // Header and schema intact (so the quick probe passes) but data pages damaged.
    scribble(bad, 4096 * 6, 4096 * 3);
    check("the quick probe does not see body damage", probeDatabaseFile(bad).ok);
    const rb = await runIntegrityCheckInBackground(bad);
    check("the full check reports it, with details", !rb.ok && rb.detail.length > 0 && rb.detail !== "ok", rb);

    // It must not block this process: a timer keeps firing while the check runs.
    const big = fresh();
    makeDb(big, 20000);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const pending = runIntegrityCheckInBackground(big);
    await pending;
    clearInterval(timer);
    check("the app's own event loop kept running during the check", ticks >= 3, ticks);

    const notDb = fresh();
    require("node:fs").mkdirSync(path.dirname(notDb), { recursive: true });
    writeFileSync(notDb, Buffer.alloc(5000, 65));
    const rn = await runIntegrityCheckInBackground(notDb);
    check("a file that is not a database is reported as damaged", !rn.ok, rn);
  }

  section("the quarantine leaves no stray files and keeps names unique");
  {
    const p = fresh();
    makeDb(p, 5);
    const a = quarantineDatabase(p);
    const again = new DatabaseSync(p);
    again.exec("CREATE TABLE z (a)");
    again.close();
    const b = quarantineDatabase(p);
    check("two recoveries keep two separate copies", a !== b && existsSync(a) && existsSync(b), list(p));
  }

  rmSync(dir, { recursive: true, force: true });
});
