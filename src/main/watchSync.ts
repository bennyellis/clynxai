// Clynx Cloud Phase 2 — Watch cloud persistence/synchronization.
//
// Purely additive, feature-flagged background mirror. Local SQLite
// (store.ts) remains the SOLE source of truth for the live scan loop —
// watchScheduler.ts, watchMatching.ts, and the scanner's own Watch
// read/write path never import this file or know it exists. This service
// only ever:
//   1. Pulls remote watches changed since the last sync cursor and merges
//      them into local SQLite via Store.upsertWatchFromCloud — but ONLY
//      when the remote row is strictly newer (last-write-wins by
//      updated_at), mirroring the exact same comparison the cloud side
//      independently enforces on its own PUT.
//   2. Propagates any locally-deleted watch up to cloud (batch 2 Fix B —
//      see pushPendingDeletes).
//   3. Pushes local watches whose updated_at is newer than the last sync
//      cursor up to cloud (an upsert — cloud applies the same
//      last-write-wins check again, so a push racing a concurrent pull from
//      another device can never clobber a newer remote edit).
//   4. Pushes newly-created local watch_matches up to cloud, append-only —
//      matches are immutable once created, so no conflict logic is needed,
//      just dedup (the cloud route's ON CONFLICT DO NOTHING makes re-sends
//      safe).
//
// Every step is wrapped so a failure (network, auth-not-ready) can never
// throw into the caller (index.ts's setInterval), exactly like the
// existing heartbeat.
import type { Config, SyncStatus } from "./types.js";
import type { Store, CloudSyncedWatch } from "./store.js";
import { CloudClient, watchToCloud, watchMatchToCloud, type CloudWatch } from "./cloudClient.js";

const SYNC_INTERVAL_MS = 2 * 60_000;
const STARTUP_DELAY_MS = 15_000;

// Batch 2 Fix D — the cloud no longer sends back the 8 desktop-local-only
// operational/scheduler fields (see cloudClient.ts's CloudWatch and
// store.ts's upsertWatchFromCloud/CloudSyncedWatch) — this mapper simply no
// longer reads them off `cw`, since they're not there to read.
function cloudWatchToLocal(cw: CloudWatch): CloudSyncedWatch {
  return {
    id: cw.localId,
    name: cw.name,
    searchPhrase: cw.searchPhrase,
    matchKeywords: cw.matchKeywords,
    linkedProductId: cw.linkedProductId,
    minPriceUsd: cw.minPriceUsd,
    maxPriceUsd: cw.maxPriceUsd,
    minProfitUsd: cw.minProfitUsd,
    minDiscountPercent: cw.minDiscountPercent,
    maxListingAgeMinutes: cw.maxListingAgeMinutes,
    locationMode: cw.locationMode,
    selectedState: cw.selectedState,
    selectedCityOrZip: cw.selectedCityOrZip,
    searchRadiusMiles: cw.searchRadiusMiles,
    // Absent when the cloud server predates these fields — the store then
    // keeps whatever the local row already has.
    platform: cw.platform,
    minSellerRatingPercent: cw.minSellerRatingPercent,
    enabled: cw.enabled,
    createdAt: cw.createdAt,
    updatedAt: cw.updatedAt,
  };
}

export class WatchSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;

  // Batch 2 Fix D — the pull cursor is now a server-assigned integer
  // revision (cloud/src/watches/routes.ts's Fix 3), not a client-clock
  // updated_at timestamp — a timestamp-based cursor could silently miss a
  // late/offline push from another device forever. Kept in-memory only,
  // same reasoning as before: a `since=0` full pull on the first tick after
  // every app restart is cheap for a low-cardinality table like Watches.
  private lastPulledRevision = 0;
  private lastPushedAt = 0;
  // local watch id -> cloud row's own server id, needed for the
  // matches sub-resource and delete routes. Rebuilt from pull/push
  // responses; empty after a restart is fine — a watch not yet in this map
  // just gets its matches pushed on the NEXT tick, once an upsert response
  // has populated it.
  private cloudIdByLocalId = new Map<string, string>();
  // First UI status readout (see index.ts's cloud:getStatus). lastSyncAt
  // marks the end of the most recently COMPLETED tick (see runSyncSafely's
  // .then below), regardless of whether an individual step inside it
  // failed; lastSyncError is reset at the start of each tick (see runSync)
  // and set by whichever step actually hit one, so a fully successful tick
  // clears a prior failure but a partial one still surfaces which step
  // failed most recently.
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
        console.error("[watchSync] sync tick threw unexpectedly:", err);
        this.lastSyncError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.syncing = false;
      });
  }

  private async runSync(): Promise<void> {
    this.lastSyncError = null;
    await this.pull();
    // Batch 2 Fix B — deliberately AFTER pull(): pull() is what populates
    // cloudIdByLocalId for a watch this device never pushed itself (e.g. one
    // pulled down once, then later deleted locally before ever being
    // edited again) — pushPendingDeletes needs that id to issue the DELETE.
    await this.pushPendingDeletes();
    await this.push();
    await this.pushMatches();
  }

  private async pull(): Promise<void> {
    try {
      // Batch 2 Fix B — a watch whose local delete hasn't been confirmed
      // propagated to cloud yet (pushPendingDeletes below is still working
      // on it, or hasn't run yet this tick) must NOT be resurrected by this
      // same pull just because the cloud hasn't seen the delete yet either.
      const pendingDeleteIds = new Set(this.store.listPendingCloudDeletes("watch"));
      const result = await this.cloudClient.listWatches(this.lastPulledRevision);
      if (!result.ok || !result.data) {
        if (result.error) {
          console.warn("[watchSync] pull failed:", result.error);
          this.lastSyncError = result.error;
        }
        return;
      }
      let maxRevision = this.lastPulledRevision;
      for (const remote of result.data.watches) {
        if (remote.id) this.cloudIdByLocalId.set(remote.localId, remote.id);
        if (typeof remote.revision === "number") maxRevision = Math.max(maxRevision, remote.revision);
        if (pendingDeleteIds.has(remote.localId)) continue; // see comment above — pushPendingDeletes owns this id right now

        const local = this.store.getWatchById(remote.localId);
        // Last-write-wins: only overwrite local when remote is strictly
        // newer. A brand-new-to-this-device watch (no local row yet) is
        // always applied.
        if (local && local.updatedAt >= remote.updatedAt) continue;
        this.store.upsertWatchFromCloud(cloudWatchToLocal(remote));
      }
      this.lastPulledRevision = maxRevision;
    } catch (err) {
      console.error("[watchSync] pull threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  // Batch 2 Fix B — drains store.ts's pending_cloud_deletes("watch") table:
  // a watch deleted locally (Store.deleteWatch) but not yet confirmed gone
  // from the cloud mirror. Needs the CLOUD id (not the local id) to issue
  // DELETE /watches/:id — resolved via the same cloudIdByLocalId cache
  // pull()/push() already maintain, so a watch this device never pushed (and
  // whose pull hasn't happened yet either) is simply left pending and
  // retried next tick rather than guessed at. A 404 (already gone from
  // cloud — e.g. another device deleted it first) is treated as success,
  // same idempotent-delete posture as everywhere else in this app.
  private async pushPendingDeletes(): Promise<void> {
    try {
      const pending = this.store.listPendingCloudDeletes("watch");
      for (const localId of pending) {
        const cloudId = this.cloudIdByLocalId.get(localId);
        if (!cloudId) continue; // never synced to cloud (or not resolved yet this session) — retried next tick
        const result = await this.cloudClient.deleteWatch(cloudId);
        if (result.ok || result.status === 404) {
          this.store.removePendingCloudDelete("watch", localId);
          this.cloudIdByLocalId.delete(localId);
        } else if (result.error) {
          console.warn(`[watchSync] pending delete failed for watch ${localId}:`, result.error);
          this.lastSyncError = result.error;
        }
      }
    } catch (err) {
      console.error("[watchSync] pushPendingDeletes threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  // Batch 2 Fix C — corrected push-cursor watermark. Candidates are
  // processed oldest-updated-first; the cursor only ever advances past an
  // item once every earlier item in THIS tick has either succeeded or been
  // reconciled (a tie/remote-newer no-op) — the first hard failure (network
  // error, timeout, unexpected non-2xx) freezes the cursor right there for
  // the rest of the tick, so that item (and everything after it, even if
  // individually retried and successful this same tick) stays a candidate
  // again on the NEXT tick instead of being silently skipped forever. A
  // reconciled no-op is treated the same as success for cursor purposes
  // (and its server row is adopted locally immediately, same as before) —
  // otherwise an item permanently tied with the server would get re-pushed
  // and re-rejected every single tick forever.
  private async push(): Promise<void> {
    try {
      const candidates = this.store
        .listWatches()
        .filter((w) => w.updatedAt > this.lastPushedAt)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      if (candidates.length === 0) return;

      let newCursor = this.lastPushedAt;
      let sawFailure = false;

      for (const watch of candidates) {
        const result = await this.cloudClient.upsertWatch(watchToCloud(watch));
        if (!result.ok || !result.data) {
          if (result.error) {
            console.warn(`[watchSync] push failed for watch ${watch.id}:`, result.error);
            this.lastSyncError = result.error;
          }
          sawFailure = true;
          continue;
        }
        if (result.data.watch?.id) this.cloudIdByLocalId.set(watch.id, result.data.watch.id);
        if (result.data.applied) {
          if (!sawFailure) newCursor = Math.max(newCursor, watch.updatedAt);
        } else if (result.data.watch) {
          // Server had a newer version than what we tried to push — pull it
          // straight down now rather than waiting for the next tick's pull.
          const remote = result.data.watch;
          const local = this.store.getWatchById(remote.localId);
          if (!local || local.updatedAt < remote.updatedAt) {
            this.store.upsertWatchFromCloud(cloudWatchToLocal(remote));
          }
          if (!sawFailure) newCursor = Math.max(newCursor, watch.updatedAt);
        }
      }
      this.lastPushedAt = newCursor;
    } catch (err) {
      console.error("[watchSync] push threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  // No analogous cursor here — matches are append-only and deduped
  // server-side (ON CONFLICT DO NOTHING on (watch_id, local_id)), so
  // resending an already-synced match is harmless and there's nothing for
  // Fix C's watermark logic to apply to.
  private async pushMatches(): Promise<void> {
    try {
      for (const watch of this.store.listWatches()) {
        const cloudWatchId = this.cloudIdByLocalId.get(watch.id);
        if (!cloudWatchId) continue; // watch hasn't synced up yet — its matches go up next tick
        const matches = this.store.listRawWatchMatches(watch.id);
        if (matches.length === 0) continue;
        // Append-only + server-side dedup (ON CONFLICT DO NOTHING on
        // (watch_id, local_id)) makes resending already-synced matches
        // harmless, so no local "already pushed" bookkeeping is needed.
        const result = await this.cloudClient.pushWatchMatches(cloudWatchId, matches.map(watchMatchToCloud));
        if (!result.ok && result.error) {
          console.warn(`[watchSync] pushMatches failed for watch ${watch.id}:`, result.error);
          this.lastSyncError = result.error;
        }
      }
    } catch (err) {
      console.error("[watchSync] pushMatches threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }
}
