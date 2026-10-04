// Clynx Cloud Phase 6 — personal Database/Library (ProductProfile) cloud
// persistence/synchronization.
//
// Purely additive, feature-flagged background mirror — same shape as
// watchSync.ts/feedbackSync.ts. Local SQLite (store.ts's `products` table)
// remains the SOLE source of truth for the Database/Library UI — chat.ts,
// index.ts's runProductLookup, scrapeEngine.ts, and Database.tsx/every other
// renderer file never import this and don't know it exists. This service
// only ever:
//   1. Pulls remote products changed since the last sync cursor and merges
//      them into local SQLite via Store.upsertProductFromCloud — but ONLY
//      when the remote row is strictly newer (last-write-wins by
//      updated_at), mirroring the exact same comparison the cloud side
//      independently enforces on its own PUT.
//   2. Propagates any locally-deleted product up to cloud (batch 2 Fix B —
//      see pushPendingDeletes).
//   3. Pushes local products whose updated_at is newer than the last sync
//      cursor up to cloud (an upsert — cloud applies the same
//      last-write-wins check again, so a push racing a concurrent pull from
//      another device can never clobber a newer remote edit).
//
// Deliberately never syncs imageUrl/familyLogoUrl or the product_images/
// group_thumbnails tables — those are locally-downloaded `data:` URIs/
// binary galleries, out of Phase 6's scope (needs S3-compatible object
// storage that isn't set up yet). See cloudClient.ts's productToCloud.
// A product still mid-research (loading === true) is skipped on push —
// its AI-generated fields aren't settled yet, so there's nothing useful to
// sync until the research pass that created it finishes and calls
// updateProductProfile, which bumps updatedAt and makes it a candidate on
// the next tick.
//
// Every step is wrapped so a failure (network, auth-not-ready) can never
// throw into the caller (index.ts's setInterval), exactly like
// watchSync.ts/feedbackSync.ts.
import type { Config, ProductProfile, SyncStatus } from "./types.js";
import type { Store } from "./store.js";
import { CloudClient, productToCloud, type CloudProduct } from "./cloudClient.js";

const SYNC_INTERVAL_MS = 2 * 60_000;
const STARTUP_DELAY_MS = 15_000;

function cloudProductToLocal(cp: CloudProduct): ProductProfile {
  return {
    id: cp.localId,
    name: cp.name,
    aiSummary: cp.aiSummary ?? "",
    aiSummaryGeneratedAt: cp.aiSummaryGeneratedAt,
    observedNotes: cp.observedNotes ?? "",
    category: cp.category || "Other",
    family: cp.family,
    // Never overwritten from cloud — see store.ts's upsertProductFromCloud,
    // which ignores these two fields on an existing row entirely. Only
    // matters for the shape of a BRAND-NEW-to-this-device product (no local
    // row yet), where there's nothing local to preserve; both simply start
    // null until this device's own research/thumbnail-pick fills them in.
    familyLogoUrl: null,
    imageUrl: null,
    resalePriceUsd: cp.resalePriceUsd,
    resaleTimeToSell: cp.resaleTimeToSell,
    hardCapAtDesiredPrice: cp.hardCapAtDesiredPrice,
    prioritized: cp.prioritized,
    lookoutNotes: cp.lookoutNotes ?? "",
    keepThumbnail: cp.keepThumbnail,
    desiredPriceUsd: cp.desiredPriceUsd,
    ebayAvgSoldPriceUsd: cp.ebayAvgSoldPriceUsd,
    ebayAvgRunTimeDays: cp.ebayAvgRunTimeDays,
    ebayAvgShippingUsd: cp.ebayAvgShippingUsd,
    ebayCompsSampleSize: cp.ebayCompsSampleSize,
    ebayCompsCheckedAt: cp.ebayCompsCheckedAt,
    loading: false,
    createdAt: cp.createdAt,
    updatedAt: cp.updatedAt,
  };
}

export class ProductSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;

  // Batch 2 Fix D — a server-assigned integer revision cursor (see
  // watchSync.ts's own lastPulledRevision for the full reasoning), not a
  // client-clock updated_at timestamp.
  private lastPulledRevision = 0;
  private lastPushedAt = 0;
  // local product id -> cloud row's own server id, needed for the delete
  // route. Rebuilt from pull/push responses; empty after a restart is fine.
  private cloudIdByLocalId = new Map<string, string>();
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
        console.error("[productSync] sync tick threw unexpectedly:", err);
        this.lastSyncError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.syncing = false;
      });
  }

  private async runSync(): Promise<void> {
    this.lastSyncError = null;
    await this.pull();
    // Batch 2 Fix B — after pull() so a product this device never pushed
    // itself (only ever pulled down) still has its cloud id resolvable via
    // cloudIdByLocalId before we try to delete it.
    await this.pushPendingDeletes();
    await this.push();
  }

  private async pull(): Promise<void> {
    try {
      // Batch 2 Fix B — see watchSync.ts's pull() for the full reasoning: a
      // product whose local delete hasn't been confirmed propagated to
      // cloud yet must not be resurrected by this same pull.
      const pendingDeleteIds = new Set(this.store.listPendingCloudDeletes("product"));
      const result = await this.cloudClient.listProducts(this.lastPulledRevision);
      if (!result.ok || !result.data) {
        if (result.error) {
          console.warn("[productSync] pull failed:", result.error);
          this.lastSyncError = result.error;
        }
        return;
      }
      let maxRevision = this.lastPulledRevision;
      for (const remote of result.data.products) {
        if (remote.id) this.cloudIdByLocalId.set(remote.localId, remote.id);
        if (typeof remote.revision === "number") maxRevision = Math.max(maxRevision, remote.revision);
        if (pendingDeleteIds.has(remote.localId)) continue; // see comment above

        const local = this.store.getProductById(remote.localId);
        // Last-write-wins: only overwrite local when remote is strictly
        // newer. A brand-new-to-this-device product (no local row yet) is
        // always applied. A product still loading locally (this device's own
        // in-flight research) is never clobbered by a remote pull — its
        // final write will naturally win on a later tick once research
        // finishes and bumps updatedAt past whatever's remote right now.
        if (local && (local.loading || local.updatedAt >= remote.updatedAt)) continue;
        this.store.upsertProductFromCloud(cloudProductToLocal(remote));
      }
      this.lastPulledRevision = maxRevision;
    } catch (err) {
      console.error("[productSync] pull threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  // Batch 2 Fix B — drains store.ts's pending_cloud_deletes("product")
  // table: a product deleted locally (Store.deleteProduct) but not yet
  // confirmed gone from the cloud mirror. Needs the CLOUD id (not the local
  // id) to issue DELETE /products/:id — resolved via the same
  // cloudIdByLocalId cache pull()/push() already maintain, so a product this
  // device never pushed is simply left pending and retried next tick rather
  // than guessed at. A 404 (already gone from cloud) is treated as success,
  // same idempotent-delete posture as everywhere else in this app.
  private async pushPendingDeletes(): Promise<void> {
    try {
      const pending = this.store.listPendingCloudDeletes("product");
      for (const localId of pending) {
        const cloudId = this.cloudIdByLocalId.get(localId);
        if (!cloudId) continue; // never synced to cloud (or not resolved yet this session) — retried next tick
        const result = await this.cloudClient.deleteProduct(cloudId);
        if (result.ok || result.status === 404) {
          this.store.removePendingCloudDelete("product", localId);
          this.cloudIdByLocalId.delete(localId);
        } else if (result.error) {
          console.warn(`[productSync] pending delete failed for product ${localId}:`, result.error);
          this.lastSyncError = result.error;
        }
      }
    } catch (err) {
      console.error("[productSync] pushPendingDeletes threw unexpectedly:", err);
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
        .listProducts()
        .filter((p) => p.updatedAt > this.lastPushedAt && !p.loading)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      if (candidates.length === 0) return;

      let newCursor = this.lastPushedAt;
      let sawFailure = false;

      for (const product of candidates) {
        const result = await this.cloudClient.upsertProduct(productToCloud(product));
        if (!result.ok || !result.data) {
          if (result.error) {
            console.warn(`[productSync] push failed for product ${product.id}:`, result.error);
            this.lastSyncError = result.error;
          }
          sawFailure = true;
          continue;
        }
        if (result.data.product?.id) this.cloudIdByLocalId.set(product.id, result.data.product.id);
        if (result.data.applied) {
          if (!sawFailure) newCursor = Math.max(newCursor, product.updatedAt);
        } else if (result.data.product) {
          // Server had a newer version than what we tried to push — pull it
          // straight down now rather than waiting for the next tick's pull.
          const remote = result.data.product;
          const local = this.store.getProductById(remote.localId);
          if (!local || (!local.loading && local.updatedAt < remote.updatedAt)) {
            this.store.upsertProductFromCloud(cloudProductToLocal(remote));
          }
          if (!sawFailure) newCursor = Math.max(newCursor, product.updatedAt);
        }
      }
      this.lastPushedAt = newCursor;
    } catch (err) {
      console.error("[productSync] push threw unexpectedly:", err);
      this.lastSyncError = err instanceof Error ? err.message : String(err);
    }
  }
}
