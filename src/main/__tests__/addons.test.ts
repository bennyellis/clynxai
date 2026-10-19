// Add-ons, first version (FEATURE_ADDONS_SPEC P1): additive tables, toggles that only change what the page shows, suggestions that start OFF and never come back once dismissed, and numbers
// that are ROUGH, ranged, never summed. A throwaway Database only; no scanner, no server, no alert.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { addonKey, estimateAddonUplift, isNoiseAddon, type Addon } from "../addons.js";
import { check, run, section } from "./_testkit.js";

const addon = (over: Partial<Addon>): Addon => ({ id: "a", baseProductId: "base", name: "Second controller", addonProductId: null, role: "bonus", status: "confirmed", source: "user_added", compatibility: "unknown", enabled: true, standaloneValueUsd: 100, timesSeen: 0, exampleListingIds: [], firstSeenAt: 1, lastSeenAt: 1, ...over });

run(async () => {
  section("the estimate is ROUGH, a range, and not linear");
  const one = estimateAddonUplift(400, [addon({ standaloneValueUsd: 100 })]);
  check("one bonus add-on worth $100 alone adds LESS than $100", one.highUsd !== null && one.highUsd < 100 && one.highUsd > 0, one);
  check("it is a range, not a point", one.lowUsd !== null && one.highUsd !== null && one.lowUsd < one.highUsd);
  check("it is labelled rough, with no sample size", one.confidence === "rough" && one.sampleSize === null && /not measured/i.test(one.why) && /fixed weights/i.test(one.why), one.why);
  const expected = estimateAddonUplift(400, [addon({ role: "expected" })]);
  check("a part made for the product counts for more than a bonus extra", expected.highUsd! > one.highUsd!);
  const two = estimateAddonUplift(400, [addon({ id: "a" }), addon({ id: "b", name: "Storage card", standaloneValueUsd: 150 })]);
  const sumAlone = estimateAddonUplift(400, [addon({ id: "a" })]).highUsd! + estimateAddonUplift(400, [addon({ id: "b", standaloneValueUsd: 150 })]).highUsd!;
  check("two add-ons are worth less than the sum of each alone (diminishing returns)", two.highUsd! < sumAlone, { two: two.highUsd, sumAlone });
  const many = estimateAddonUplift(400, Array.from({ length: 12 }, (_, i) => addon({ id: `x${i}`, name: `Thing ${i}`, standaloneValueUsd: 300 })));
  check("however many are switched on, the total is held down by a cap tied to the base value", many.highUsd! <= 400 * 0.5, many.highUsd);
  check("the lines add up to the shown top of the range", Math.abs(two.lines.filter((l) => l.counted).reduce((s, l) => s + l.roughAddsUsd, 0) - two.highUsd!) <= 1);

  section("what does not count");
  check("a switched-off add-on adds nothing", estimateAddonUplift(400, [addon({ enabled: false })]).highUsd === null);
  check("a suggested one that is off says so", estimateAddonUplift(400, [addon({ enabled: false, status: "suggested" })]).lines[0].note === "suggested, switched off");
  check("a dismissed one adds nothing even if it was left on", estimateAddonUplift(400, [addon({ status: "dismissed" })]).highUsd === null);
  const noPrice = estimateAddonUplift(400, [addon({ standaloneValueUsd: null })]);
  check("an add-on with no price adds nothing and says why", noPrice.highUsd === null && /no price/.test(noPrice.lines[0].note));
  check("with no base value there is no ceiling to cap against, so no range is shown (and it says why)", estimateAddonUplift(null, [addon({})]).highUsd === null && estimateAddonUplift(0, [addon({ standaloneValueUsd: 5000 })]).highUsd === null && /no estimated value/.test(estimateAddonUplift(null, [addon({})]).why));
  const inf = estimateAddonUplift(400, [addon({ standaloneValueUsd: Infinity }), addon({ id: "n", standaloneValueUsd: NaN })]);
  check("an infinite or NaN price adds nothing (never '$NaN')", inf.highUsd === null && !/NaN|Infinity/.test(inf.why) && inf.lines.every((l) => !l.counted));
  check("a USB-C cable is filler like any other cable", isNoiseAddon("USB-C cable") && isNoiseAddon("Type C charging cable"));

  section("noise and names");
  check("generic filler is not suggested", ["cables", "Manual", "power cable", "HDMI cable", "box", "original box", "accessories"].every(isNoiseAddon));
  check("real add-ons are", !isNoiseAddon("1TB Storage Expansion Card") && !isNoiseAddon("Second Wireless Controller") && !isNoiseAddon("charging dock"));
  check("two spellings of one add-on share a key", addonKey("Second wireless controller") === addonKey("  second Wireless Controller. "));

  section("the Database: suggestions start off, dismissed never returns, the base value is untouched");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-addons-"));
  const store = new Store(path.join(dir, "scout.db"));
  const baseId = store.addProductStub("base", "Xbox Series X Galaxy Edition");
  const seen = store.noteAddonSeen(baseId, "Second Wireless Controller", "L1")!;
  check("an add-on seen in a listing is created as a SUGGESTION, switched off, counted once", seen.status === "suggested" && seen.enabled === false && seen.timesSeen === 1 && seen.source === "seen_in_listing" && seen.exampleListingIds[0] === "L1", seen);
  const again = store.noteAddonSeen(baseId, "second wireless controller", "L2")!;
  check("seeing it again counts it, does not duplicate it, and keeps the listings as examples", again.id === seen.id && again.timesSeen === 2 && again.exampleListingIds.length === 2 && store.listAddons(baseId).length === 1);
  check("it still starts off after being seen twice", store.getAddon(seen.id)!.enabled === false);
  check("switching it on counts as confirming it", store.setAddonEnabled(seen.id, true) && store.getAddon(seen.id)!.enabled && store.getAddon(seen.id)!.status === "confirmed");
  check("switching it off again leaves it confirmed", store.setAddonEnabled(seen.id, false) && !store.getAddon(seen.id)!.enabled && store.getAddon(seen.id)!.status === "confirmed");

  store.setAddonStatus(seen.id, "dismissed");
  check("a dismissed add-on is switched off", store.getAddon(seen.id)!.status === "dismissed" && !store.getAddon(seen.id)!.enabled);
  const afterDismiss = store.noteAddonSeen(baseId, "Second Wireless Controller", "L3")!;
  check("a dismissed add-on never comes back from a listing, and nothing is counted", afterDismiss.status === "dismissed" && afterDismiss.timesSeen === 2 && store.listAddons(baseId).length === 1);
  check("a dismissed add-on cannot be switched on", store.setAddonEnabled(seen.id, true) === false && !store.getAddon(seen.id)!.enabled);

  const manual = store.addAddon(baseId, { name: "1TB Expansion Card", role: "bonus", standaloneValueUsd: 150, enabled: true })!;
  check("an add-on the person adds is confirmed straight away, with its price", manual.status === "confirmed" && manual.source === "user_added" && manual.enabled && manual.standaloneValueUsd === 150);
  const revived = store.addAddon(baseId, { name: "Second wireless controller", standaloneValueUsd: 60, enabled: false })!;
  check("asking for a dismissed name again by hand brings it back confirmed (their choice)", revived.id === seen.id && revived.status === "confirmed" && revived.standaloneValueUsd === 60);
  check("a price can be changed, and cleared", store.setAddonDetails(manual.id, { standaloneValueUsd: 175 }) && store.getAddon(manual.id)!.standaloneValueUsd === 175 && store.setAddonDetails(manual.id, { standaloneValueUsd: null }) && store.getAddon(manual.id)!.standaloneValueUsd === null);
  check("a nonsense price is ignored", store.setAddonDetails(manual.id, { standaloneValueUsd: -5 }) && store.getAddon(manual.id)!.standaloneValueUsd === null);
  check("no add-on for a product that does not exist", store.addAddon("nope", { name: "x thing" }) === null && store.noteAddonSeen("nope", "x thing", null) === null);
  check("an empty or symbol-only name is refused", store.addAddon(baseId, { name: "  " }) === null && store.addAddon(baseId, { name: "!!!" }) === null);

  const before = store.getProductById(baseId)!;
  store.setAddonEnabled(manual.id, true);
  store.setAddonEnabled(manual.id, false);
  const after = store.getProductById(baseId)!;
  check("toggling never changes the base product's stored value or summary", before.ebayEstimatedValueUsd === after.ebayEstimatedValueUsd && before.ebayAvgSoldPriceUsd === after.ebayAvgSoldPriceUsd && before.aiSummary === after.aiSummary);

  store.removeAddon(manual.id);
  check("an add-on can be removed", store.getAddon(manual.id) === null);
  const other = store.addProductStub("other", "PlayStation 5");
  store.addAddon(other, { name: "DualSense controller", standaloneValueUsd: 50 });
  store.deleteProduct(baseId);
  check("deleting a product deletes its add-ons and leaves other products' alone", store.listAddons(baseId).length === 0 && store.listAddons(other).length === 1);
  store.clearAllProducts();
  check("clearing the Database clears add-ons too", store.listAddons(other).length === 0);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
