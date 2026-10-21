// Phase 5 end to end on a throwaway Database: imported sales -> premium for an add-on -> the estimate shown on the base product (measured, low end for scoring), and the guess when sales are few.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { estimateAddonUplift } from "../addons.js";
import { parseSoldImport } from "../soldComps/manualImport.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-premium-"));
  const store = new Store(path.join(dir, "scout.db"));
  const base = store.addProductStub("b", "Zorblax Console 3000");
  store.updateProductEbayComps(base, { avgSoldPriceUsd: 505, avgRunTimeDays: 3, avgShippingUsd: 0, sampleSize: 8, activeMedianUsd: 520, activeSampleSize: 6, estimatedValueUsd: 505, estimateBasis: "sold", identity: "exact" });
  const addon = store.addAddon(base, { name: "Zorblax Wireless Controller", role: "expected", standaloneValueUsd: 32, enabled: true });
  check("the add-on exists and counts", !!addon && addon.enabled);

  section("few sales: a labelled guess");
  const guess = store.listAddons(base, { withPremium: true })[0];
  check("with no sold pairs the premium is a prior and says it is a guess", guess.premium?.basis === "prior" && guess.premium.guess === true);
  const est0 = estimateAddonUplift(505, store.listAddons(base, { withPremium: true }));
  check("the estimate stays 'rough'", est0.confidence === "rough" && est0.sampleSize === null);

  section("enough pairs: measured");
  const lines = [
    ...[480, 495, 505, 510, 520, 530].map((p, i) => `Zorblax Console 3000 console only ${i} $${p}.00`),
    ...[500, 515, 525, 535, 545, 550].map((p, i) => `Zorblax Console 3000 with wireless controller ${i} $${p}.00`),
    "Zorblax Console 3000 with controller and 3 games and headset $700.00",
    "Other Thing 9000 with wireless controller $90.00",
  ];
  store.soldComps().upsertComps(parseSoldImport(lines.join("\n")).comps);
  const m = store.listAddons(base, { withPremium: true })[0];
  check("measured from the pairs: about the gap between the medians, under what it sells for alone", m.premium?.basis === "measured" && m.premium.midUsd === 23 && m.premium.midUsd <= 32 && m.premium.sampleWith === 6 && m.premium.sampleWithout === 6, m.premium);
  check("the lot with other extras and the other product's sale were not used", m.premium?.sampleWith === 6);
  const est = estimateAddonUplift(505, store.listAddons(base, { withPremium: true }));
  check("the estimate is 'measured', with the sample, and the low end is what scoring may use", est.confidence === "measured" && est.sampleSize === 6 && est.lowUsd !== null && est.highUsd === 23 && est.lowUsd < est.highUsd && /Measured from sold pairs/.test(est.why), est);
  check("switching the add-on off removes it from the estimate", (() => { const off = store.listAddons(base, { withPremium: true }).map((a) => ({ ...a, enabled: false })); return estimateAddonUplift(505, off).lowUsd === null; })());
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
