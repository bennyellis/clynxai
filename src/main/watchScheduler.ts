// Per explicit instruction — a real due/overdue queue that proactively
// searches for Facebook Watches, not just relying on whatever the passive path
// (scrapeEngine.ts's evaluateListing) happens to stumble across. A single
// instance owns this, instantiated once in index.ts — NOT a per-engine
// method — since Watches are global (same posture as config.searchItems)
// and picking "which account is currently available" needs visibility
// across every account's engine, which only index.ts's engines Map has.
//
// Each Watch says how often it wants to be checked (its own interval) and which
// of the user's Facebook accounts it may use. When a check is due, an account
// from that set that is logged in does it — and if that account is in the middle
// of a scan, the Watch takes the browser over from the scanner for the length of
// the check (see ScrapeEngine.runWatchCheck).
import type { ScrapeEngine } from "./scrapeEngine.js";
import type { Store } from "./store.js";
import type { Config, Watch } from "./types.js";

// Poll cadence for the scheduler's own due-queue check — cheap (one indexed
// SQLite query), so this can run often without cost; it's the ACTUAL check
// cadence per watch (its own interval) that's conservative on request volume.
const POLL_INTERVAL_MS = 45_000;
// Natural-looking spread on top of a Watch's interval, so several Watches (or
// several app restarts) don't all hit Facebook on the same beat.
const INTERVAL_JITTER_FRACTION = 0.1;
// A check that couldn't complete (location didn't resolve, Facebook hiccup, no
// account logged in) is retried sooner than a full interval, but never so soon
// that it spins.
const RETRY_AFTER_FAILURE_MIN = 5;

export interface WatchSchedulerOptions {
  store: Store;
  getConfig: () => Config;
  getEngines: () => Map<string, ScrapeEngine>;
  onLog: (message: string, level?: "info" | "warn" | "error") => void;
  // Called after every check, so the Watch screen can show what it just found/remembered.
  onChecked?: () => void;
  // True while a Watch is actually searching (its check is running), false the moment it finishes and the Watch goes
  // back to waiting for its next interval. Drives the sidebar eye: awake while searching, asleep in between.
  onSearchingChange?: (searching: boolean) => void;
}

export class WatchScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Guards against a tick overlapping the previous one if a single check
  // ever takes longer than POLL_INTERVAL_MS (a slow Facebook page load,
  // etc.) — "process one at a time, fully awaited, before considering the next".
  private busy = false;
  // Where each Watch's rotation across its accounts is up to.
  private accountCursor = new Map<string, number>();
  // Watches already reported as having no usable account, so that isn't repeated every retry.
  private reportedNoAccount = new Set<string>();

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
    // Watch's own on/off switch ("Pause All"), checked fresh every tick rather than cached.
    if (config.watch.globallyPaused) return;

    const due = this.opts.store.getDueWatch(Date.now());
    if (!due) return;

    this.busy = true;
    this.opts.onSearchingChange?.(true);
    try {
      await this.checkWatch(due);
      this.opts.onChecked?.();
    } finally {
      this.busy = false;
      this.opts.onSearchingChange?.(false);
    }
  }

  private async checkWatch(watch: Watch): Promise<void> {
    const engine = this.pickEngine(watch);
    if (!engine) {
      // No account this Watch may use is logged in right now. Retry soon rather
      // than leaving it stuck at a due-forever next_check_at once one is.
      if (!this.reportedNoAccount.has(watch.id)) {
        this.reportedNoAccount.add(watch.id);
        this.opts.onLog(`Watch "${watch.name}": none of its Facebook accounts are logged in, so it can't check yet — it will keep trying.`, "warn");
      }
      this.opts.store.scheduleNextWatchCheck(watch.id, Date.now() + Math.min(RETRY_AFTER_FAILURE_MIN, watch.checkIntervalMinutes) * 60_000);
      return;
    }
    this.reportedNoAccount.delete(watch.id);

    const result = await engine.runWatchCheck(watch).catch((err) => ({ evaluated: 0, error: (err as Error).message }));
    this.opts.store.scheduleNextWatchCheck(watch.id, Date.now() + this.nextDelayMs(watch, !!result.error));
    if (result.error) {
      this.opts.onLog(`Watch "${watch.name}": active check couldn't complete — ${result.error}`, "warn");
    }
  }

  /** How long until this Watch's next check: its own interval (with a little spread), or a short retry after a failure. */
  nextDelayMs(watch: Watch, failed: boolean): number {
    const intervalMs = Math.max(1, watch.checkIntervalMinutes) * 60_000;
    if (failed) return Math.min(RETRY_AFTER_FAILURE_MIN * 60_000, intervalMs);
    const jitter = (Math.random() * 2 - 1) * INTERVAL_JITTER_FRACTION * intervalMs;
    return Math.max(60_000, intervalMs + jitter);
  }

  /**
   * The accounts this Watch may use that look usable right now: the ones it was given
   * (any enabled account, when it wasn't given any), minus any known not to be logged
   * in. Exposed for tests.
   */
  eligibleAccountIds(watch: Watch): string[] {
    const engines = this.opts.getEngines();
    const accounts = this.opts.getConfig().accounts;
    const wanted = watch.accountIds.length
      ? watch.accountIds
      : (accounts.some((a) => a.enabled) ? accounts.filter((a) => a.enabled) : accounts).map((a) => a.id);
    return wanted.filter((id) => {
      const engine = engines.get(id);
      // `loggedIn` is null until the browser has been opened once; that isn't "no".
      return !!engine && engine.getStatus().loggedIn !== false;
    });
  }

  // Round-robins across the Watch's usable accounts, one account per check. Every
  // account already has an engine regardless of whether its own Scanner loop is
  // running; runWatchCheck's own ensureBrowser()/isLoggedIn() handle the rest.
  private pickEngine(watch: Watch): ScrapeEngine | null {
    const ids = this.eligibleAccountIds(watch);
    if (!ids.length) return null;
    const next = ((this.accountCursor.get(watch.id) ?? -1) + 1) % ids.length;
    this.accountCursor.set(watch.id, next);
    return this.opts.getEngines().get(ids[next]) ?? null;
  }
}
