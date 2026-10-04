// Per explicit instruction — a real due/overdue queue that proactively
// searches for Watches, not just relying on whatever the passive path
// (scrapeEngine.ts's evaluateListing) happens to stumble across. A single
// instance owns this, instantiated once in index.ts — NOT a per-engine
// method — since Watches are global (same posture as config.searchItems)
// and picking "which account is currently available" needs visibility
// across every account's engine, which only index.ts's engines Map has.
import type { ScrapeEngine } from "./scrapeEngine.js";
import type { Store } from "./store.js";
import type { Config, Watch } from "./types.js";
import { matchSearchItem } from "./scorer.js";

// Poll cadence for the scheduler's own due-queue check — cheap (one indexed
// SQLite query), so this can run often without cost; it's the ACTUAL check
// cadence per watch (below) that's conservative on request volume.
const POLL_INTERVAL_MS = 45_000;

// Per explicit instruction — "conservative on request volume... a real due/
// overdue queue, not blind per-watch polling," biased by existing coverage:
// a watch whose own search phrase already overlaps an active SearchItem is
// already getting real scan cycles "for free" via the passive path (every
// account's normal runCycle evaluates against it constantly) — checked only
// as an infrequent backstop. A watch with no such overlap has NO other
// coverage when the Scanner is stopped (the whole point of "Scanner OFF +
// Watch ON must work") — checked meaningfully more often, since the active
// scheduler is its ONLY way of ever seeing anything.
const OVERLAP_BACKSTOP_CADENCE_MIN = 25;
const SOLE_COVERAGE_CADENCE_MIN = 10;
const CADENCE_JITTER_MIN = 3;
// A location-resolution failure (city not found, dialog didn't respond)
// shouldn't spin the due-queue on this same watch every 45s until the next
// poll after a full cadence either — short enough to recover from a
// transient Facebook hiccup, long enough not to hammer it.
const RETRY_AFTER_FAILURE_MIN = 5;
// State/country-mode watches (active checking not yet implemented — see
// scrapeEngine.ts's runWatchCheck doc comment) would otherwise come back
// due on every single poll tick forever; parked far out instead so the
// due-queue query keeps surfacing genuinely actionable watches. Still get
// full passive-path coverage in the meantime — this only defers the
// ACTIVE, radius-precise check.
const UNSUPPORTED_LOCATION_RECHECK_MIN = 60;

export interface WatchSchedulerOptions {
  store: Store;
  getConfig: () => Config;
  getEngines: () => Map<string, ScrapeEngine>;
  onLog: (message: string, level?: "info" | "warn" | "error") => void;
}

export class WatchScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Guards against a tick overlapping the previous one if a single check
  // ever takes longer than POLL_INTERVAL_MS (a slow Facebook page load,
  // etc.) — the plan's own "process one at a time, fully awaited, before
  // considering the next" requirement.
  private busy = false;
  private accountCursor = 0;

  constructor(private opts: WatchSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.opts.onLog(`Watch scheduler error: ${(err as Error).message}`, "error"));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const config = this.opts.getConfig();
    // The one genuinely new switch per the plan (§3) — Scanner and Watch
    // already have independent on/off states structurally (every account's
    // ScrapeEngine exists regardless of whether its own loop is running);
    // this is Watch's own equivalent of that switch, checked fresh every
    // tick rather than cached.
    if (config.watch.globallyPaused) return;

    const due = this.opts.store.getDueWatch(Date.now());
    if (!due) return;

    this.busy = true;
    try {
      await this.checkWatch(due, config);
    } finally {
      this.busy = false;
    }
  }

  private async checkWatch(watch: Watch, config: Config): Promise<void> {
    if (watch.locationMode !== "city") {
      this.opts.store.scheduleNextWatchCheck(watch.id, Date.now() + UNSUPPORTED_LOCATION_RECHECK_MIN * 60_000);
      return;
    }

    const engine = this.pickEngine();
    if (!engine) {
      // No configured account at all — nothing to search with. Retry soon
      // rather than leaving this watch stuck at a due-forever next_check_at
      // once an account eventually gets added.
      this.opts.store.scheduleNextWatchCheck(watch.id, Date.now() + RETRY_AFTER_FAILURE_MIN * 60_000);
      return;
    }

    const result = await engine.runWatchCheck(watch).catch((err) => ({ evaluated: 0, error: (err as Error).message }));
    const nextCheckAt = Date.now() + this.cadenceMinutesFor(watch, config, !!result.error) * 60_000;
    this.opts.store.scheduleNextWatchCheck(watch.id, nextCheckAt);
    if (result.error) {
      this.opts.onLog(`Watch "${watch.name}": active check couldn't complete — ${result.error}`, "warn");
    }
  }

  private cadenceMinutesFor(watch: Watch, config: Config, failed: boolean): number {
    if (failed) return RETRY_AFTER_FAILURE_MIN;
    // Reuses the exact same keyword-overlap matching a listing title would
    // be checked against (see scorer.ts) — the watch's own search phrase
    // stands in for "a listing that would obviously match," which is
    // exactly what determines whether the passive path already covers it.
    const overlapsActiveSearchItem = matchSearchItem(watch.searchPhrase, config.searchItems) !== null;
    const baseMinutes = overlapsActiveSearchItem ? OVERLAP_BACKSTOP_CADENCE_MIN : SOLE_COVERAGE_CADENCE_MIN;
    const jitter = (Math.random() * 2 - 1) * CADENCE_JITTER_MIN;
    return Math.max(1, baseMinutes + jitter);
  }

  // Round-robins across every configured account's engine — every account
  // already has one instantiated regardless of whether its own Scanner loop
  // is running (index.ts's ensureEngineFor is called for every account at
  // startup, independent of start()/stop()), so this needs no "is it
  // running/logged in" filter here; runWatchCheck's own ensureBrowser()/
  // isLoggedIn() handle that per-attempt, same as searchForItemNow does.
  private pickEngine(): ScrapeEngine | null {
    const engines = [...this.opts.getEngines().values()];
    if (!engines.length) return null;
    this.accountCursor = (this.accountCursor + 1) % engines.length;
    return engines[this.accountCursor];
  }
}
