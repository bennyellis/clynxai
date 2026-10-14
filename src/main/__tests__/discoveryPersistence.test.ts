// Database discovery: photo analysis and research statuses survive repeated saves, an app restart, the cloud-sync cycle, and an upgrade from a
// database that has never heard of them; nothing already in the database changes. Uses REAL SQLite files (no fakes for the store).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { listingToCloud } from "../cloudClient.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-persist-"));
const flaw = { photoNumber: 1, description: "scuffed corner", boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: "low" as const };

run(() => {
  section("repeated saves");
  const file = path.join(dir, "a.db");
  let store = new Store(file);
  store.saveScored(scoredListing("Gaming console", 100, { isDeal: false, research: { status: "unresearched", code: "PHOTOS_QUEUED", reason: "Waiting for a look at its photos." } }, { id: "p1" }));
  store.updatePhotoAnalysis("p1", "A black Xbox Series S.", [flaw]);
  for (let i = 0; i < 5; i++) store.saveScored(scoredListing("Gaming console", 100, { isDeal: i % 2 === 0 }, { id: "p1" }));
  let r = store.getById("p1")!;
  check("five re-saves with no research given keep the last status", r.researchStatus === "unresearched" && r.researchCode === "PHOTOS_QUEUED", [r.researchStatus, r.researchCode]);
  check("and keep the photo analysis, its time and the flaws", r.photoAnalysis === "A black Xbox Series S." && r.photoAnalysisCheckedAt !== null && r.photoFlaws.length === 1, r.photoAnalysis);
  store.saveScored(scoredListing("Gaming console", 100, { isDeal: true, research: { status: "researched", code: "DEAL", reason: "About $90 profit." } }, { id: "p1" }));
  r = store.getById("p1")!;
  check("a save that does say replaces the status, whole (status, code and reason together)", r.researchStatus === "researched" && r.researchCode === "DEAL" && r.researchReason === "About $90 profit.", r);
  store.saveScored(scoredListing("Gaming console", 100, { isDeal: true }, { id: "p1" }));
  store.setResearch("p1", { status: "insufficient_evidence", code: "RESEARCH_FAILED", reason: "stopped" });
  store.saveScored(scoredListing("Gaming console", 100, { isDeal: true }, { id: "p1" }));
  r = store.getById("p1")!;
  check("setResearch changes the status only, and a later plain save does not undo it", r.researchStatus === "insufficient_evidence" && r.researchCode === "RESEARCH_FAILED" && r.photoAnalysis === "A black Xbox Series S." && r.isDeal === true, r);
  check("notified and first-seen still behave as before", (() => { store.markNotified("p1"); const a = store.getById("p1")!; store.saveScored(scoredListing("Gaming console", 100, {}, { id: "p1" })); const b = store.getById("p1")!; return b.notified === true && b.firstSeenAt === a.firstSeenAt; })());

  section("restart");
  store.close();
  store = new Store(file);
  r = store.getById("p1")!;
  check("after closing and reopening the database, the status and the analysis are still there", r.researchCode === "RESEARCH_FAILED" && r.photoAnalysis === "A black Xbox Series S." && r.photoFlaws.length === 1, r);
  store.saveScored(scoredListing("Gaming console", 100, {}, { id: "p1" }));
  check("and a save after the restart still keeps them", store.getById("p1")!.photoAnalysis === "A black Xbox Series S." && store.getById("p1")!.researchCode === "RESEARCH_FAILED");

  section("cloud sync cycle");
  {
    const before = store.listUnsyncedListings(50).filter((l) => l.id === "p1");
    check("a listing is pushed with its row intact (the push query returns the status and the analysis)", before.length === 1 && before[0].researchCode === "RESEARCH_FAILED" && before[0].photoAnalysis !== null, before[0]);
    const wire = listingToCloud(before[0]) as unknown as Record<string, unknown>;
    check("the cloud payload does not carry the local-only research fields (so nothing about them can be rejected or leak)", !("researchStatus" in wire) && !("photoAnalysis" in wire) && wire.sourceListingId === "p1", Object.keys(wire));
    store.markListingsCloudSynced(["p1"]);
    check("marking it synced leaves status and analysis alone", store.getById("p1")!.researchCode === "RESEARCH_FAILED" && store.getById("p1")!.photoAnalysis !== null);
    check("and it is no longer waiting to be pushed", store.listUnsyncedListings(50).every((l) => l.id !== "p1"));
    store.saveScored(scoredListing("Gaming console", 100, { research: { status: "researched", code: "DEAL", reason: "again" } }, { id: "p1" }));
    const again = store.listUnsyncedListings(50).find((l) => l.id === "p1");
    check("a later change makes it be pushed again (as every re-save always did), still with status and analysis", !!again && again.researchCode === "DEAL" && again.photoAnalysis !== null, again);
    store.recordListingCloudSyncFailures(["p1"]);
    check("a rejected push only counts attempts; it does not touch status or analysis", store.getById("p1")!.researchCode === "DEAL" && store.getById("p1")!.photoAnalysis !== null);
  }

  section("a research job that died with the app");
  {
    store.saveScored(scoredListing("Waiting", 120, { research: { status: "unresearched", code: "PHOTOS_QUEUED", reason: "Waiting for a look at its photos." } }, { id: "q1" }));
    store.saveScored(scoredListing("Skipped for budget", 120, { research: { status: "unresearched", code: "LOOK_BUDGET", reason: "allowance used" } }, { id: "q2" }));
    store.saveScored(scoredListing("Done", 120, { research: { status: "researched", code: "DEAL", reason: "ok" } }, { id: "q3" }));
    store.close();
    store = new Store(file);
    const q1 = store.getById("q1")!;
    check("on the next start, 'waiting for its photos' becomes 'interrupted, not enough evidence' (not a verdict)", q1.researchStatus === "insufficient_evidence" && q1.researchCode === "INTERRUPTED" && /not a verdict/.test(q1.researchReason ?? ""), q1);
    check("no other status is touched by that sweep", store.getById("q2")!.researchCode === "LOOK_BUDGET" && store.getById("q3")!.researchCode === "DEAL" && store.getById("p1")!.researchCode === "DEAL");
  }

  section("upgrade from a database that has no research columns: everything already in it is unchanged");
  {
    const old = path.join(dir, "old.db");
    const seed = new Store(old);
    seed.saveScored(scoredListing("Old Xbox", 150, { isDeal: true, estimatedValueRange: "200-300" }, { id: "o1", listingAge: "a week ago" }));
    seed.saveScored(scoredListing("Old Switch", 90, { isDeal: false }, { id: "o2" }));
    seed.addProductStub("prod-1", "Xbox Series S");
    seed.close();
    const raw = new DatabaseSync(old);
    for (const col of ["research_status", "research_code", "research_reason"]) raw.exec(`ALTER TABLE listings DROP COLUMN ${col}`);
    const snapshot = () => JSON.stringify({ listings: raw.prepare("SELECT id, title, price, is_deal, reasoning, notified, first_seen_at, photo_analysis FROM listings ORDER BY id").all(), products: raw.prepare("SELECT id, name FROM products ORDER BY id").all() });
    const beforeRows = snapshot();
    check("(setup) the old database really lacks the columns", !(raw.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).some((c) => c.name === "research_status"));
    raw.close();
    const migrated = new Store(old);
    const check2 = new DatabaseSync(old, { readOnly: true });
    const cols = (check2.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).map((c) => c.name);
    const afterRows = JSON.stringify({ listings: check2.prepare("SELECT id, title, price, is_deal, reasoning, notified, first_seen_at, photo_analysis FROM listings ORDER BY id").all(), products: check2.prepare("SELECT id, name FROM products ORDER BY id").all() });
    check2.close();
    check("opening it adds the three columns", ["research_status", "research_code", "research_reason"].every((c) => cols.includes(c)), cols);
    check("and changes no listing and no product", beforeRows === afterRows);
    const o = migrated.getById("o1")!;
    check("old listings read back with no status (the Feed shows them as it always did)", o.researchStatus === null && o.researchCode === null && o.isDeal === true && o.estimatedValueRange === "200-300", o);
    migrated.saveScored(scoredListing("Old Xbox", 150, { isDeal: true, research: { status: "researched", code: "DEAL", reason: "x" } }, { id: "o1" }));
    check("and they can be given a status", migrated.getById("o1")!.researchCode === "DEAL");
    migrated.close();
  }
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
