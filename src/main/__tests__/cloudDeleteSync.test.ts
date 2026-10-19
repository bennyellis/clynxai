// L8 (live test): deleting did not stick while cloud sync was on. A FAKE cloud and a throwaway Database only: nothing here can reach the owner's server, their 109 queued deletes, or
// their library.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { ProductSyncService } from "../productSync.js";
import { idsToQueueOnReset, staleQueuedDeletes } from "../cloudDeletes.js";
import { check, run, section } from "./_testkit.js";

function remote(localId: string, id: string, revision = 1) {
  return { id, localId, name: `Product ${localId}`, aiSummary: "", aiSummaryGeneratedAt: null, observedNotes: "", category: "Other", family: null, resalePriceUsd: null, resaleTimeToSell: null, hardCapAtDesiredPrice: false, prioritized: false, lookoutNotes: "", keepThumbnail: false, desiredPriceUsd: null, ebayAvgSoldPriceUsd: null, ebayAvgRunTimeDays: null, ebayAvgShippingUsd: null, ebayCompsSampleSize: null, ebayCompsCheckedAt: null, createdAt: 1, updatedAt: 1, revision };
}

function fakeCloud(serverRows: Array<ReturnType<typeof remote>>, opts: { listOk?: boolean } = {}) {
  const calls = { deleted: [] as string[], listed: 0 };
  const client = {
    isAuthenticated: () => true,
    listProducts: async () => (calls.listed++, opts.listOk === false ? { ok: false, error: "offline" } : { ok: true, data: { products: serverRows } }),
    deleteProduct: async (cloudId: string) => (calls.deleted.push(cloudId), { ok: true }),
    upsertProduct: async () => ({ ok: true, data: { applied: true, product: serverRows[0] } }),
  };
  return { client, calls };
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-l8-"));
  return { store: new Store(path.join(dir, "scout.db")), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup can fail on Windows */ } } };
}

const sync = (store: Store, client: unknown) => new ProductSyncService(store, client as never, () => ({ cloud: { enabled: true } }) as never);
const tick = (svc: ProductSyncService) => (svc as unknown as { runSync(): Promise<void> }).runSync();

run(async () => {
  section("pure helpers");
  check("queued ids the server does not list are stale; no list means keep everything", staleQueuedDeletes(["a", "b", "c"], new Set(["b"])).join() === "a,c" && staleQueuedDeletes(["a"], null).length === 0);
  check("an EMPTY list from the server (reset server, wrong account, glitch) forgets nothing", staleQueuedDeletes(["a", "b"], new Set<string>()).length === 0);
  check("a reset queues what the device holds plus what the server lists, once each", idsToQueueOnReset(["a", "b"], ["b", "c"]).join() === "a,b,c");

  section("Clear all queues the cloud deletes, and the products do not come back");
  {
    const { store, cleanup } = newStore();
    store.addProductStub("a", "Product a");
    store.addProductStub("b", "Product b");
    store.clearAllProducts();
    check("both are queued for deletion on the server", store.listPendingCloudDeletes("product").sort().join() === "a,b", store.listPendingCloudDeletes("product"));
    check("and the local rows are gone", store.getProductById("a") === null && store.getProductById("b") === null);
    const cloud = fakeCloud([remote("a", "cloud-a"), remote("b", "cloud-b")]);
    await tick(sync(store, cloud.client));
    check("the pull does NOT bring them back", store.getProductById("a") === null && store.getProductById("b") === null);
    check("the deletes are sent for the two the server holds", cloud.calls.deleted.sort().join() === "cloud-a,cloud-b", cloud.calls.deleted);
    check("and the queue is empty afterwards", store.listPendingCloudDeletes("product").length === 0);
    cleanup();
  }

  section("a queued delete the server no longer has is forgotten, nothing is sent for it");
  {
    const { store, cleanup } = newStore();
    for (const id of ["gone1", "gone2", "live"]) store.addPendingCloudDelete("product", id);
    const cloud = fakeCloud([remote("live", "cloud-live"), remote("other", "cloud-other")]);
    await tick(sync(store, cloud.client));
    check("only the one the server holds is deleted there", cloud.calls.deleted.join() === "cloud-live", cloud.calls.deleted);
    check("the two it never had are dropped from the queue", store.listPendingCloudDeletes("product").length === 0, store.listPendingCloudDeletes("product"));
    check("a different product on the server is untouched", !cloud.calls.deleted.includes("cloud-other"));
    cleanup();
  }
  {
    const { store, cleanup } = newStore();
    store.addPendingCloudDelete("product", "x");
    const offline = fakeCloud([], { listOk: false });
    await tick(sync(store, offline.client));
    check("when the pull fails nothing is dropped or deleted (no trustworthy list)", store.listPendingCloudDeletes("product").join() === "x" && offline.calls.deleted.length === 0);
    const svc = sync(store, fakeCloud([remote("y", "cloud-y")]).client);
    (svc as unknown as { lastPulledRevision: number }).lastPulledRevision = 5;
    await tick(svc);
    check("an incremental pull is not a complete list, so nothing is dropped either", store.listPendingCloudDeletes("product").join() === "x");
    cleanup();
  }

  section("the owner's pattern: many stale queued ids, one product on the server");
  {
    const { store, cleanup } = newStore();
    for (let i = 0; i < 109; i++) store.addPendingCloudDelete("product", `old-${i}`);
    const cloud = fakeCloud([remote("keep-me", "cloud-keep")]);
    await tick(sync(store, cloud.client));
    check("all 109 stale ids clear and nothing is deleted on the server", store.listPendingCloudDeletes("product").length === 0 && cloud.calls.deleted.length === 0, { left: store.listPendingCloudDeletes("product").length, deleted: cloud.calls.deleted });
    cleanup();
  }
});
