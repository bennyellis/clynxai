// Stage 3: the gate's verdict is persisted with the listing so the Feed, Dashboard and notifications agree (decision 9).
// Uses a REAL SQLite store (in memory), including a migration from a database created before these columns existed.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { toGateSnapshot, qualifyListing, userEvidence } from "../dealGate.js";
import { assessListingAge } from "../listingAge.js";
import { check, run, section } from "./_testkit.js";
import { detail, scoredListing } from "./_fixtures.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };

function negotiationVerdict() {
  return qualifyListing({ pathway: "search", priceUsd: 450, conditionImpact: "none", evidence: { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 2 }, age: assessListingAge("2 hours ago", 24), settings });
}

run(() => {
  section("a verdict survives a save/read round trip");
  const store = new Store(":memory:");
  const verdict = negotiationVerdict();
  const scored = scoredListing("Xbox Series S", 450, { gate: toGateSnapshot(verdict), isDeal: true }, { id: "g1", listingAge: "4 days ago" });
  store.saveScored(scored);
  const rec = store.getById("g1");
  check("the record comes back with the final status", rec?.dealStatus === "negotiation", rec && rec.dealStatus);
  check("with the required discount and the price to offer", rec?.requiredDiscountPercent === 11 && rec?.targetPriceUsd === 400, rec && { d: rec.requiredDiscountPercent, t: rec.targetPriceUsd });
  check("with confidence, stars, headline and the reasons", rec?.gateConfidence === "high" && (rec?.gateStars ?? 9) <= 3 && /Offer ~\$400/.test(rec?.gateHeadline ?? "") && (rec?.gateReasons.length ?? 0) >= 1 && rec?.gateReasons[0].code === "NEEDS_DISCOUNT", rec);
  check("the parsed age is stored (4 days = 96h)", rec?.listingAgeHours === 96, rec && rec.listingAgeHours);
  check("it is listed by listRecent with the same fields (what the Feed reads)", store.listRecent(10, 0).some((r) => r.id === "g1" && r.dealStatus === "negotiation"));

  section("a listing that was never gated reads back as null (the UI falls back to isDeal, exactly as before)");
  store.saveScored(scoredListing("Some other thing", 100, {}, { id: "g2", listingAge: "whenever" }));
  const legacy = store.getById("g2");
  check("no status, no reasons, no stars", legacy?.dealStatus === null && legacy.gateReasons.length === 0 && legacy.gateStars === null && legacy.gateHeadline === null && legacy.requiredDiscountPercent === null, legacy);
  check("an age that cannot be read is stored as unknown (null), not as 0 or fresh", legacy?.listingAgeHours === null, legacy && legacy.listingAgeHours);
  store.saveScored(scoredListing("No age at all", 100, {}, { id: "g3", listingAge: null }));
  check("a missing age is also null", store.getById("g3")?.listingAgeHours === null);

  section("re-saving replaces the verdict (the final save wins) and keeps what must survive");
  store.markNotified("g1");
  const worth = qualifyListing({ pathway: "general", priceUsd: 300, conditionImpact: "none", evidence: null, aiFlagged: true, age: assessListingAge("2 hours ago", 24), settings });
  store.saveScored(scoredListing("Xbox Series S", 450, { gate: toGateSnapshot(worth), isDeal: false }, { id: "g1", listingAge: "4 days ago" }));
  const again = store.getById("g1");
  check("the later verdict replaced the earlier one", again?.dealStatus === "worth_a_look" && again.requiredDiscountPercent === null && again.targetPriceUsd === null && again.gateStars === null, again);
  check("whether it was already notified is not lost on re-save", again?.notified === true);
  check("first_seen_at is not reset", typeof again?.firstSeenAt === "number" && again.firstSeenAt === rec?.firstSeenAt);

  section("every status round-trips");
  for (const [i, status] of (["profitable_now", "negotiation", "worth_a_look", "pass"] as const).entries()) {
    store.saveScored(scoredListing("Item " + status, 100, { gate: { status, confidence: "low", stars: null, headline: status, reasons: [], requiredDiscountPercent: null, targetPriceUsd: null } }, { id: `s${i}` }));
    check(`status ${status}`, store.getById(`s${i}`)?.dealStatus === status);
  }

  section("evidence for the gate comes from the Database (D8): basis, sample size and age");
  const pid = store.addProductStub("p1", "Xbox Series S");
  store.updateProductEbayComps(pid, { avgSoldPriceUsd: 580, avgRunTimeDays: 3, avgShippingUsd: 20, sampleSize: 6, activeMedianUsd: 620, activeSampleSize: 9, estimatedValueUsd: 600, estimateBasis: "blend" });
  const signals = store.getProductSignals("Xbox Series S", "Xbox Series S 512GB");
  check("signals carry the value, the number of sales, when it was checked and what it rests on", !!signals && signals.valueUsd === 600 && signals.compSample === 6 && signals.basis === "blend" && typeof signals.checkedAt === "number", signals);

  section("migration: a database from before these columns opens, gains them, and keeps working");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clynx-store-")), "old.db");
  // A database as it was before this change: a real one with the new columns removed again.
  const seed = new Store(file);
  seed.saveScored(scoredListing("Old Xbox", 150, { isDeal: true }, { id: "old1", listingAge: "a week ago" }));
  seed.close();
  const old = new DatabaseSync(file);
  for (const col of ["deal_status", "gate_confidence", "gate_stars", "gate_headline", "gate_reasons", "required_discount_percent", "target_price_usd", "listing_age_hours"]) old.exec(`ALTER TABLE listings DROP COLUMN ${col}`);
  const cols = (old.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>).map((c) => c.name);
  check("(setup) the old database really lacks the new columns", !cols.includes("deal_status") && !cols.includes("listing_age_hours"), cols);
  old.close();
  const migrated = new Store(file);
  const o = migrated.getById("old1");
  check("the old row is still there and still reads as a deal with no verdict (legacy fallback)", o?.isDeal === true && o.dealStatus === null && o.gateReasons.length === 0, o);
  migrated.saveScored(scoredListing("New", 100, { gate: { status: "pass", confidence: "high", stars: null, headline: "x", reasons: [], requiredDiscountPercent: null, targetPriceUsd: null } }, { id: "new1" }));
  check("and new verdicts can be saved into it", migrated.getById("new1")?.dealStatus === "pass");
  migrated.close();
  store.close();
  void detail;
  void userEvidence;
});
