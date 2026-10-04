// Clynx Cloud Phase 3 — Listing ingestion downstream mirror.
//
// Purely additive, feature-flagged background push, same shape as
// watchSync.ts. Local SQLite (store.ts) remains the SOLE source of truth
// and this reads from it AFTER listings are already saved there — it never
// touches the live scan loop (scrapeEngine.ts, scraper.ts, scorer.ts never
// import this file or know it exists), never blocks it, and can never throw
// into its caller (index.ts's start()).
//
// Per explicit product scope: EVERY scanned listing is pushed, not just
// scored deals — this preserves future General Discovery value even for
// listings that didn't score as a deal on this device. Cloud-side
// processing this phase is dumb/fast (validate, dedupe, store) — see
// cloud/src/listings/routes.ts; no AI calls happen here or there.
import type { Config, SyncStatus } from "./types.js";
import type { Store } from "./store.js";
import { CloudClient, listingToCloud } from "./cloudClient.js";

const SYNC_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 15_000;
// How many not-yet-synced listings to read from SQLite per tick — the
// backlog naturally drains over multiple ticks if it's ever larger than
// this, rather than one tick trying to push everything at once.
const READ_BATCH_SIZE = 200;

export class ListingIngestSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  // First UI status readout (see index.ts's cloud:getStatus) — same
  // posture as watchSync.ts's own lastSyncAt/lastSyncError.
  private lastSyncAt: number | null = null;
  private lastSyncError: string | null = null;

  constructor(
    private store: Store,
    private cloudClient: CloudClient,
    private getConfig: () => Config
  ) {}

  getStatus(): SyncStatus {
    return { lastAt: this.lastSyncAt, lastError: this.lastSyncError };
  }

  start(): void {
    if (this.timer || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.runSyncSafely();
    }, STARTUP_DELAY_MS);
    this.timer = setInterval(() => this.runSyncSafely(), SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private runSyncSafely(): void {
    if (this.syncing) return; // never overlap two ticks
    if (!this.getConfig().cloud?.enabled) return;
    if (!this.cloudClient.isAuthenticated()) return; // cheap skip, see cloudClient.ts
    this.syncing = true;
    this.runSync()
      .then(() => {
        this.lastSyncAt = Date.now();
      })
      .catch((err) => {
        console.error("[listingIngestSync] sync tick threw unexpectedly:", err);
        this.lastSyncError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.syncing = false;
      });
  }

  private async runSync(): Promise<void> {
    this.lastSyncError = null;
    try {
      const pending = this.store.listUnsyncedListings(READ_BATCH_SIZE);
      if (pending.length === 0) return;

      // ingestListings batches internally at its own (smaller) request-body
      // limit; we still need to know which local ids correspond to which
      // outgoing batch so a failed batch's ids are simply left unmarked
      // (retried next tick) while a succeeded batch's ids get marked synced.
      const CLIENT_BATCH_SIZE = 50;
      const idBatches: string[][] = [];
      for (let i = 0; i < pending.length; i += CLIENT_BATCH_SIZE) {
        idBatches.push(pending.slice(i, i + CLIENT_BATCH_SIZE).map((l) => l.id));
      }

      const cloudListings = pending.map(listingToCloud);
      const batchResults = await this.cloudClient.ingestListings(cloudListings);

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const ids = idBatches[i] ?? [];
        if (!result.ok || !result.data) {
          // Batch 2 Fix E — a network/request-level failure (the WHOLE batch
          // never got a response, or the request itself errored) says
          // nothing about any individual listing's content — left unmarked
          // AND cloud_sync_attempts untouched, so this batch retries
          // indefinitely next tick rather than counting toward giving up.
          if (result.error) {
            console.warn("[listingIngestSync] push failed for a batch:", result.error);
            this.lastSyncError = result.error;
          }
          continue; // left unmarked — retried next tick
        }
        // Only mark ids that didn't come back as a reported failure — a
        // per-item validation failure inside an otherwise-ok batch response
        // (cloud/src/listings/routes.ts's per-index `failures`) means that
        // one specific listing is malformed. Batch 2 Fix E — unlike a
        // network failure above, THIS is content-specific and would fail
        // again identically on every retry, so each rejected listing's own
        // cloud_sync_attempts is bumped (see Store.recordListingCloudSyncFailures)
        // and, once it's been rejected too many times, permanently given up
        // on (cloud_synced_at set to the -1 sentinel) instead of occupying a
        // slot in listUnsyncedListings' backlog forever.
        const failedIndices = new Set(result.data.failures.map((f) => f.index));
        const succeededIds = ids.filter((_, idx) => !failedIndices.has(idx));
        const failedIds = ids.filter((_, idx) => failedIndices.has(idx));
        this.store.markListingsCloudSynced(succeededIds);
        if (failedIds.length) this.store.recordListingCloudSyncFailures(failedIds);
      }
    } catch (err) {
      console.error("[listingIngestSync] push threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }
}
