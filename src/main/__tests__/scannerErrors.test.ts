// Phase 1, stage 5: a scanner that keeps failing says why in plain words, backs off instead of hammering, and clears the message once
// it works again. System alerts reach the phone only when there is somewhere to send them.
import { explainScannerError, failureBackoffMs, FAILING_CYCLES_BEFORE_NOTICE } from "../scannerErrors.js";
import { sendSystemAlert } from "../notify.js";
import { NoticeBoard } from "../appNotices.js";
import { check, run, section } from "./_testkit.js";
import { baseConfig, installFetchStub, makeEngine, ntfy, resetNetwork } from "./_fixtures.js";

run(async () => {
  section("raw errors become plain words");
  {
    const cases: Array<[string, string, string]> = [
      ["browserType.launchPersistentContext: Executable doesn't exist at C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium-1129\\chrome-win\\chrome.exe\n╔═ Looks like Playwright was just installed ═╗\n║ Please run: npx playwright install", "chrome-missing", "Chrome"],
      ["page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.facebook.com/marketplace/", "network", "connection"],
      ["page.goto: net::ERR_NAME_NOT_RESOLVED", "network", "connection"],
      ["Target page, context or browser has been closed", "browser-closed", "Chrome window"],
      ["page.waitForSelector: Timeout 30000ms exceeded.", "timeout", "too long"],
      ["Failed to launch: Error: The profile appears to be in use by another Chromium process (ProcessSingleton)", "profile-locked", "leftover"],
      ["TypeError: Cannot read properties of undefined (reading 'foo')", "unknown", "Try again"],
    ];
    for (const [raw, kind, mustSay] of cases) {
      const e = explainScannerError(raw);
      check(`${kind}: ${raw.slice(0, 50).replace(/\n/g, " ")}...`, e.kind === kind && e.message.includes(mustSay) && e.title.length > 5, e);
      check(`  its words carry no jargon (${kind})`, !/Playwright|selector|TypeError|stack|ProcessSingleton|net::|undefined/.test(e.title + (kind === "unknown" ? "" : e.message)), e);
    }
    check("an empty error still explains itself", explainScannerError("").kind === "unknown");
  }

  section("retries back off instead of hammering");
  {
    check("no failures, no extra wait", failureBackoffMs(0) === 0);
    check("30 s, 1 min, 2 min, 4 min, 8 min", [1, 2, 3, 4, 5].map(failureBackoffMs).join() === [30e3, 60e3, 120e3, 240e3, 480e3].join());
    check("capped at 10 minutes", failureBackoffMs(6) === 600_000 && failureBackoffMs(500) === 600_000);
  }

  section("the scan loop: silent for the first blips, a notice at 3 in a row, the same notice only once, cleared by one good cycle");
  {
    const events: Array<{ kind: string; failures: number } | null> = [];
    const config = baseConfig({ pollIntervalMinutesMin: 0, pollIntervalMinutesMax: 0 });
    const { engine, logs } = makeEngine({ config, extra: { onCycleFailing: (i: any) => void events.push(i ? { kind: i.kind, failures: i.failures } : null) } });
    const e = engine as any;
    const waits: number[] = [];
    e.sleep = async (ms: number) => void waits.push(ms);
    const outcomes = ["net::ERR_INTERNET_DISCONNECTED", "net::ERR_INTERNET_DISCONNECTED", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_INTERNET_DISCONNECTED", "OK", "Target page, context or browser has been closed"];
    let call = 0;
    e.runOnce = async () => {
      const outcome = outcomes[call++];
      if (call >= outcomes.length) e.stopRequested = true;
      if (outcome !== "OK") throw new Error(outcome);
    };
    e.stopRequested = false;
    await e.loop();

    check(`nothing is raised before ${FAILING_CYCLES_BEFORE_NOTICE} failures in a row`, !(events[0] === null) && events.length >= 1 && events[0]?.failures === FAILING_CYCLES_BEFORE_NOTICE, events);
    check("the third failure raises one notice, in plain words (network)", events[0]?.kind === "network", events);
    check("a 4th failure with the same cause does not raise it again", events.filter((x) => x && x.kind === "network").length === 1, events);
    check("one good cycle withdraws the notice", events[1] === null, events);
    check("a later single failure (after recovery) is not announced", events.length === 2, events);
    check("waits grew after each failure even though 'wait between passes' is 0", waits.length >= 4 && waits[0] === 30_000 && waits[1] === 60_000 && waits[2] === 120_000 && waits[3] === 240_000, waits);
    check("the Activity log says the retry is coming", logs.some((l) => /Cycle failed\. Trying again in ~0\.5 min/.test(l.message)), logs.map((l) => l.message));
    check("a good cycle adds no wait when none is configured", waits.length === 4, waits);
  }
  {
    const events: unknown[] = [];
    const { engine } = makeEngine({ config: baseConfig({ pollIntervalMinutesMin: 1, pollIntervalMinutesMax: 1 }), extra: { onCycleFailing: (i: unknown) => void events.push(i) } });
    const e = engine as any;
    const waits: number[] = [];
    e.sleep = async (ms: number) => void waits.push(ms);
    let n = 0;
    e.runOnce = async () => {
      if (++n >= 2) e.stopRequested = true;
    };
    e.stopRequested = false;
    await e.loop();
    check("healthy cycles keep the configured pause and raise nothing", events.length === 0 && waits.every((w) => w === 60_000), { events, waits });
  }

  section("a stalled scanner reaches the phone, but only when there is a topic");
  {
    installFetchStub();
    resetNetwork();
    const sent = await sendSystemAlert({ ntfy: { server: "https://ntfy.sh", topic: "my-topic" } } as any, "Clynx: Facebook logged Account 1 out", "Open Facebook and log in again.");
    check("with a topic the push goes out", sent === true && ntfy.length === 1 && /my-topic$/.test(ntfy[0].url), ntfy);
    check("it carries the title and message", ntfy[0].title.includes("logged Account 1 out") && ntfy[0].message.includes("log in again"), ntfy[0]);
    resetNetwork();
    const none = await sendSystemAlert({ ntfy: { server: "https://ntfy.sh", topic: "" } } as any, "t", "m");
    check("with no topic nothing is sent and nothing throws", none === false && ntfy.length === 0);
  }

  section("notice board behaviour for these problems");
  {
    const changes: number[] = [];
    const board = new NoticeBoard((l) => changes.push(l.length));
    board.set({ id: "fb-session:a1", severity: "error", title: "Facebook logged Account 1 out", message: "m", action: "open-facebook-login", actionLabel: "Open Facebook", accountId: "a1" });
    board.set({ id: "scan-failing:a1", severity: "error", title: "Clynx can't reach Facebook", message: "m", action: "retry-scanner", actionLabel: "Try again", accountId: "a1" });
    board.set({ id: "config-damaged", severity: "warning", title: "settings restored", message: "m", action: "dismiss", actionLabel: "Got it" });
    check("errors list before warnings", board.list().map((n) => n.id).join() === "fb-session:a1,scan-failing:a1,config-damaged");
    board.clear("fb-session:a1");
    check("fixing one problem removes only its notice", board.list().length === 2 && !board.has("fb-session:a1") && board.has("scan-failing:a1"));
    board.set({ id: "scan-failing:a1", severity: "error", title: "updated", message: "m", action: "retry-scanner", actionLabel: "Try again", accountId: "a1" });
    check("re-raising the same problem keeps its original time (no flicker/reorder)", board.list().filter((n) => n.id === "scan-failing:a1").length === 1);
    board.clearAll();
    check("a new user session starts with no notices", board.list().length === 0);
  }
});
