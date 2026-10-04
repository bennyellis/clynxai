// Lightweight in-process instrumentation for the scraping pipeline — added
// per explicit instruction to measure where time is actually going before
// changing anything else, and to make an eventual before/after comparison
// possible (see resetMetrics). Deliberately NOT a general-purpose metrics
// library: just enough to answer "how long does each pipeline stage take"
// and "how many of X happened per second" for this one app, kept in plain
// memory (no persistence, no external dependency) since it only needs to
// answer questions about the CURRENT run.

// --- Stage timing (navigation, extraction, scoring, vision, ...) ---------

interface StageAccumulator {
  count: number;
  totalMs: number;
  errors: number;
  // A capped rolling sample of recent durations, used only for percentile
  // estimates — not the full history (unbounded growth over a long-running
  // scan would itself become a memory/CPU cost, which defeats the point of
  // measuring overhead cheaply). 500 samples is far more than enough for a
  // stable p50/p95 on a single-digit-stage-count pipeline like this one.
  recent: number[];
}

const STAGE_SAMPLE_CAP = 500;
const stages = new Map<string, StageAccumulator>();

function stageFor(name: string): StageAccumulator {
  let s = stages.get(name);
  if (!s) {
    s = { count: 0, totalMs: 0, errors: 0, recent: [] };
    stages.set(name, s);
  }
  return s;
}

export function recordStage(name: string, durationMs: number, ok: boolean): void {
  const s = stageFor(name);
  s.count++;
  s.totalMs += durationMs;
  if (!ok) s.errors++;
  s.recent.push(durationMs);
  if (s.recent.length > STAGE_SAMPLE_CAP) s.recent.shift();
}

// Wraps an async operation, timing it regardless of success/failure and
// re-throwing whatever the wrapped function threw — this is meant to be a
// transparent pass-through, not an error-handling layer of its own.
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordStage(name, Date.now() - start, true);
    return result;
  } catch (err) {
    recordStage(name, Date.now() - start, false);
    throw err;
  }
}

// Same as timed() but for the several genuinely-synchronous stages in this
// pipeline (the SQLite dedup lookup, the in-memory cache check) — awaiting a
// sync call would work fine too, but this keeps the call sites honest about
// which stages are actually synchronous.
export function timedSync<T>(name: string, fn: () => T): T {
  const start = Date.now();
  try {
    const result = fn();
    recordStage(name, Date.now() - start, true);
    return result;
  } catch (err) {
    recordStage(name, Date.now() - start, false);
    throw err;
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export interface StageStats {
  stage: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  errors: number;
  perSec: number;
}

// --- Event counters (discovered, duplicate, cache hit, ...) --------------
// A rolling 60-second window rather than a lifetime average, so "X/sec"
// actually reflects CURRENT activity — a scan that ran hard for an hour and
// has been idle for the last five minutes should read close to zero, not a
// stale hour-old average.

const EVENT_WINDOW_MS = 60_000;

class RollingCounter {
  private timestamps: number[] = [];
  total = 0;

  add(): void {
    this.total++;
    this.timestamps.push(Date.now());
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - EVENT_WINDOW_MS;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }

  ratePerSec(): number {
    this.prune();
    return this.timestamps.length / (EVENT_WINDOW_MS / 1000);
  }
}

const globalCounters = new Map<string, RollingCounter>();
// Per-account breakdown for the same event names — kept as a SEPARATE map
// (not nested inside globalCounters) so "global" always means "every
// account combined," never accidentally double-counted.
const perAccountCounters = new Map<string, Map<string, RollingCounter>>();

function counterFor(map: Map<string, RollingCounter>, name: string): RollingCounter {
  let c = map.get(name);
  if (!c) {
    c = new RollingCounter();
    map.set(name, c);
  }
  return c;
}

export function recordEvent(name: string, accountId?: string): void {
  counterFor(globalCounters, name).add();
  if (accountId) {
    let acctMap = perAccountCounters.get(accountId);
    if (!acctMap) {
      acctMap = new Map();
      perAccountCounters.set(accountId, acctMap);
    }
    counterFor(acctMap, name).add();
  }
}

export function recordEventBulk(name: string, count: number, accountId?: string): void {
  for (let i = 0; i < count; i++) recordEvent(name, accountId);
}

export interface EventStats {
  name: string;
  total: number;
  perSec: number;
}

// --- Gauges (vision queue depth, ...) — instantaneous values, not rates --

const gauges = new Map<string, number>();

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function getGauge(name: string): number {
  return gauges.get(name) ?? 0;
}

// --- Snapshot for IPC / Activity's metrics panel --------------------------

export interface MetricsSnapshot {
  windowStartedAt: number;
  now: number;
  stages: StageStats[];
  events: EventStats[];
  perAccountEvents: Record<string, EventStats[]>;
  gauges: Record<string, number>;
}

let windowStartedAt = Date.now();

export function getMetricsSnapshot(): MetricsSnapshot {
  const stageStats: StageStats[] = Array.from(stages.entries()).map(([stage, s]) => {
    const sorted = [...s.recent].sort((a, b) => a - b);
    const elapsedSec = Math.max(1, (Date.now() - windowStartedAt) / 1000);
    return {
      stage,
      count: s.count,
      avgMs: s.count ? s.totalMs / s.count : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      errors: s.errors,
      perSec: s.count / elapsedSec,
    };
  });
  // Busiest stage first — purely for readability when this gets logged or
  // rendered as a table, no functional meaning.
  stageStats.sort((a, b) => b.count * b.avgMs - a.count * a.avgMs);
  return {
    windowStartedAt,
    now: Date.now(),
    stages: stageStats,
    events: Array.from(globalCounters.entries()).map(([name, c]) => ({ name, total: c.total, perSec: c.ratePerSec() })),
    perAccountEvents: Object.fromEntries(
      Array.from(perAccountCounters.entries()).map(([accountId, map]) => [
        accountId,
        Array.from(map.entries()).map(([name, c]) => ({ name, total: c.total, perSec: c.ratePerSec() })),
      ])
    ),
    gauges: Object.fromEntries(gauges.entries()),
  };
}

// Clears every counter/stage/gauge and restarts the measurement window —
// per explicit instruction, this is what makes an actual before/after
// benchmark possible: reset, run a scan for N minutes under configuration
// A, snapshot; reset again, run under configuration B, snapshot; compare.
export function resetMetrics(): void {
  stages.clear();
  globalCounters.clear();
  perAccountCounters.clear();
  gauges.clear();
  windowStartedAt = Date.now();
}
