// Phase 3 stage 5: persistent crash diagnostics - entries are appended as JSON lines, an unclean previous run is noticed, the file stays small,
// logging can never throw, and window recovery is rate limited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDiagnosticsLog, createRecoveryLimiter, DIAGNOSTICS_MAX_BYTES } from "../diagnostics.js";
import { check, run, section } from "./_testkit.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-diag-"));
const lines = (file: string) => fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

run(() => {
  section("entries");
  {
    const dir = path.join(root, "a", "logs");
    let t = Date.UTC(2026, 9, 12, 12, 0, 0);
    const log = createDiagnosticsLog(dir, () => (t += 1000));
    log.record("renderer-gone", { reason: "crashed", exitCode: 139 });
    log.record("uncaught-exception", { error: new Error("boom") });
    const e = lines(log.file);
    check("two lines, each valid JSON with a time and a kind", e.length === 2 && e.every((x) => typeof x.at === "string" && typeof x.kind === "string"), e);
    check("details are kept", e[0].reason === "crashed" && e[0].exitCode === 139);
    check("an Error keeps its message and the top of its stack", e[1].error.message === "boom" && /Error: boom/.test(e[1].error.stack));
    log.record("long", { text: "x".repeat(50_000) });
    check("a huge value is clipped", lines(log.file)[2].text.length < 2100);
  }

  section("sessions: an unexpected end is noticed on the next start");
  {
    const dir = path.join(root, "b", "logs");
    const first = createDiagnosticsLog(dir);
    check("a first ever start is not reported as a bad end", first.beginSession({ v: 1 }) === false);
    first.endSession();
    const second = createDiagnosticsLog(dir);
    check("after an orderly end, the next start is clean", second.beginSession() === false);
    // no endSession: the process "died"
    const third = createDiagnosticsLog(dir);
    check("after a run that never ended, the next start reports it", third.beginSession() === true);
    const kinds = lines(third.file).map((x) => x.kind);
    check("and writes it down", kinds.includes("previous-session-ended-unexpectedly"), kinds);
    third.endSession();
    check("session-start / session-end are recorded", kinds.filter((k) => k === "session-start").length === 3 && lines(third.file).some((x) => x.kind === "session-end"));
  }

  section("the file stays small");
  {
    const dir = path.join(root, "c", "logs");
    const log = createDiagnosticsLog(dir);
    const chunk = "y".repeat(1500);
    for (let i = 0; i < 900; i++) log.record("spam", { chunk });
    const size = fs.statSync(log.file).size;
    check("it rotates past 1 MB (current file under the limit, one older copy kept)", size <= DIAGNOSTICS_MAX_BYTES + 5000 && fs.existsSync(log.file + ".old"), size);
    check("the newest entries are in the current file", lines(log.file).length > 0);
  }

  section("logging can never break the app");
  {
    const blocker = path.join(root, "blocked");
    fs.writeFileSync(blocker, "a file, not a folder");
    const log = createDiagnosticsLog(path.join(blocker, "logs"));
    let threw = false;
    try {
      log.record("x", { a: 1 });
      log.beginSession();
      log.endSession();
    } catch {
      threw = true;
    }
    check("an unwritable location is silently ignored", !threw);
    const circular: any = { name: "c" };
    circular.self = circular;
    let threw2 = false;
    try {
      createDiagnosticsLog(path.join(root, "d", "logs")).record("circ", { circular });
    } catch {
      threw2 = true;
    }
    check("a circular value does not throw", !threw2);
  }

  section("window recovery is rate limited");
  {
    let t = 0;
    const lim = createRecoveryLimiter(3, 10 * 60_000, () => t);
    const results = [lim.tryAcquire(), lim.tryAcquire(), lim.tryAcquire(), lim.tryAcquire()];
    check("three recoveries then stop", results.join() === "true,true,true,false", results);
    t = 11 * 60_000;
    check("allowed again after the window has passed", lim.tryAcquire() === true);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
