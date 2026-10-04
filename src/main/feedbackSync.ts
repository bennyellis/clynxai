// Clynx Cloud Phase 5 — Feed feedback cloud persistence/synchronization.
//
// Purely additive, feature-flagged background mirror — same shape as
// watchSync.ts. Local SQLite (store.ts's `feedback` table) remains the SOLE
// source of truth for the Feed UI; Feed.tsx and every other renderer/screen
// file never import this and don't know it exists. This service only ever:
//   1. Pulls remote feedback changes down and applies them locally via
//      Store.upsertFeedbackFromCloud, but ONLY when the remote row is
//      strictly newer (mirroring the exact comparison the cloud side
//      independently enforces on its own PUT).
//   2. Propagates any locally-cleared feedback row up to cloud (batch 2 Fix
//      B — see pushPendingDeletes).
//   3. Pushes local feedback rows newer than a sync cursor up to cloud — an
//      upsert, same last-write-wins posture as watchSync.ts's push().
//
// Local feedback rows are keyed by the LOCAL listing id (the numeric
// Facebook item id — store.ts's `listings.id` primary key, the same id
// space as Phase 3's `source_listing_id`). Cloud-side, feedback references
// the cloud `listings.id` (a canonical uuid) — so every push/pull here goes
// through a local-id <-> cloud-id resolution step:
//   - Push direction: CloudClient.lookupListing(localId) asks the cloud's
//     GET /listings/lookup for the canonical id, by the same
//     (source, sourceListingId) identity Phase 3's ingest already dedupes
//     on. If a listing hasn't been ingested to cloud yet (a 404, or the
//     lookup fails for any reason), that listing's feedback is simply
//     skipped THIS cycle — no error — it'll naturally succeed once
//     listingIngestSync.ts has pushed it, on some future tick.
//   - Pull direction: the cloud's GET /feedback response already includes
//     `sourceListingId` (joined server-side against its own listings
//     table — see cloud/src/feedback/routes.ts), so no separate reverse
//     lookup is needed there; the local id comes back for free.
// Resolved ids are cached in-memory for the process lifetime (cleared on
// restart, cheaply rebuilt lazily) — same posture as watchSync.ts's
// cloudIdByLocalId map.
//
// Every step is wrapped so a failure (network, not-yet-authenticated) can
// never throw into the caller (index.ts's setInterval), exactly like
// watchSync.ts and listingIngestSync.ts.
import type { Config, FeedbackVerdict, SyncStatus } from "./types.js";
import type { Store } from "./store.js";
import { CloudClient, feedbackToCloud, type CloudFeedback } from "./cloudClient.js";

const SYNC_INTERVAL_MS = 2 * 60_000;
const STARTUP_DELAY_MS = 15_000;

export class FeedbackSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;

  // Batch 2 Fix D — a server-assigned integer revision cursor (see
  // watchSync.ts's own lastPulledRevision for the full reasoning), not a
  // client-clock updated_at timestamp.
  private lastPulledRevision = 0;
  private lastPushedAt = 0;
  // local listing id -> cloud canonical listing id. Populated lazily via
  // lookupListing as feedback rows need pushing; empty after a restart just
  // means the first tick re-resolves anything it needs, same as
  // watchSync.ts's cloudIdByLocalId.
  private cloudListingIdByLocalId = new Map<string, string>();
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
        console.error("[feedbackSync] sync tick threw unexpectedly:", err);
        this.lastSyncError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.syncing = false;
      });
  }

  private async runSync(): Promise<void> {
    this.lastSyncError = null;
    await this.pull();
    // Batch 2 Fix B — after pull() so a listing this device never pushed
    // feedback for itself (only ever pulled down) still has its cloud id
    // resolvable via cloudListingIdByLocalId before we try to delete it.
    await this.pushPendingDeletes();
    await this.push();
  }

  private async resolveCloudListingId(localListingId: string): Promise<string | null> {
    const cached = this.cloudListingIdByLocalId.get(localListingId);
    if (cached) return cached;
    const result = await this.cloudClient.lookupListing(localListingId);
    if (!result.ok || !result.data?.id) return null; // not ingested yet — try again next cycle
    this.cloudListingIdByLocalId.set(localListingId, result.data.id);
    return result.data.id;
  }

  private async pull(): Promise<void> {
    try {
      // Batch 2 Fix B — see watchSync.ts's pull() for the full reasoning: a
      // feedback row whose local clear hasn't been confirmed propagated to
      // cloud yet must not be resurrected by this same pull.
      const pendingDeleteIds = new Set(this.store.listPendingCloudDeletes("feedback"));
      const result = await this.cloudClient.listFeedback(this.lastPulledRevision);
      if (!result.ok || !result.data) {
        if (result.error) {
          console.warn("[feedbackSync] pull failed:", result.error);
          this.lastSyncError = result.error;
        }
        return;
      }
      let maxRevision = this.lastPulledRevision;
      for (const remote of result.data.feedback) {
        if (typeof remote.revision === "number") maxRevision = Math.max(maxRevision, remote.revision);
        if (!remote.sourceListingId) continue; // shouldn't happen — the cloud join always sets it
        this.cloudListingIdByLocalId.set(remote.sourceListingId, remote.listingId);
        if (pendingDeleteIds.has(remote.sourceListingId)) continue; // see comment above

        const local = this.store.getFeedbackRaw(remote.sourceListingId);
        // Last-write-wins: only overwrite local when remote is strictly
        // newer. A brand-new-to-this-device feedback row is always applied
        // (upsertFeedbackFromCloud itself is a no-op if this device has
        // never seen the listing locally).
        if (local && local.updatedAt >= remote.updatedAt) continue;
        this.store.upsertFeedbackFromCloud(remote.sourceListingId, remote.verdict as FeedbackVerdict, remote.note, remote.updatedAt);
      }
      this.lastPulledRevision = maxRevision;
    } catch (err) {
      console.error("[feedbackSync] pull threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  // Batch 2 Fix B — drains store.ts's pending_cloud_deletes("feedback")
  // table: a feedback row cleared locally (Store.clearFeedback) but not yet
  // confirmed gone from the cloud mirror. Resolves the local listing id to
  // its cloud listing id the same way push() does, so a listing that was
  // never ingested to cloud (feedback for it never pushed either) is simply
  // left pending and retried next tick rather than guessed at. A 404
  // (already gone from cloud) is treated as success, same idempotent-delete
  // posture as everywhere else in this app.
  private async pushPendingDeletes(): Promise<void> {
    try {
      const pending = this.store.listPendingCloudDeletes("feedback");
      for (const localListingId of pending) {
        const cloudListingId = await this.resolveCloudListingId(localListingId);
        if (!cloudListingId) continue; // listing not ingested to cloud yet — retried next tick
        const result = await this.cloudClient.deleteFeedback(cloudListingId);
        if (result.ok || result.status === 404) {
          this.store.removePendingCloudDelete("feedback", localListingId);
        } else if (result.error) {
          console.warn(`[feedbackSync] pending delete failed for listing ${localListingId}:`, result.error);
          this.lastSyncError = result.error;
        }
      }
    } catch (err) {
      console.error("[feedbackSync] pushPendingDeletes threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  // Batch 2 Fix C — corrected push-cursor watermark, identical pattern to
  // watchSync.ts's push() (see its own comment for the full reasoning):
  // oldest-updated-first, the cursor only advances past an item once every
  // earlier item in this tick has succeeded or been reconciled, and the
  // first hard failure freezes it there for the rest of the tick so that
  // item is retried next tick instead of silently skipped forever.
  private async push(): Promise<void> {
    try {
      const candidates = this.store
        .listFeedbackRaw()
        .filter((f) => f.updatedAt > this.lastPushedAt)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      if (candidates.length === 0) return;

      let newCursor = this.lastPushedAt;
      let sawFailure = false;

      for (const fb of candidates) {
        const cloudListingId = await this.resolveCloudListingId(fb.listingId);
        if (!cloudListingId) {
          // Not ingested to cloud yet — this is not a hard failure of the
          // push itself, just a dependency that hasn't landed; leave it as
          // a candidate again next tick without freezing the cursor for
          // items after it (there's nothing this tick could have done).
          continue;
        }

        const result = await this.cloudClient.upsertFeedback(cloudListingId, feedbackToCloud(fb));
        if (!result.ok || !result.data) {
          if (result.error) {
            console.warn(`[feedbackSync] push failed for listing ${fb.listingId}:`, result.error);
            this.lastSyncError = result.error;
          }
          sawFailure = true;
          continue;
        }
        if (result.data.applied) {
          if (!sawFailure) newCursor = Math.max(newCursor, fb.updatedAt);
        } else if (result.data.feedback) {
          // Server had a newer version than what we tried to push — pull it
          // straight down now rather than waiting for the next tick's pull.
          const remote: CloudFeedback = result.data.feedback;
          const local = this.store.getFeedbackRaw(fb.listingId);
          if (!local || local.updatedAt < remote.updatedAt) {
            this.store.upsertFeedbackFromCloud(fb.listingId, remote.verdict, remote.note, remote.updatedAt);
          }
          if (!sawFailure) newCursor = Math.max(newCursor, fb.updatedAt);
        }
      }
      this.lastPushedAt = newCursor;
    } catch (err) {
      console.error("[feedbackSync] push threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }
}
