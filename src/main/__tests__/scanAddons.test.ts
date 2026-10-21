// Scanner parity S4 and the Series X + controller fixture: the console is valued from its own sales; an extra the Database has a MEASURED premium for counts at most at the low end of it.
import { applyMeasuredPremiums, valueBundle, gateExtrasFromValuation } from "../bundleBreakdown.js";
import { sameAddonLoosely } from "../variantDiscovery.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const main = { name: "Xbox Series X", role: "main" as const, quantity: 1, guessUsd: null, sellability: "moderate" as const };
  const ctrl = { name: "Xbox Wireless Controller", role: "accessory" as const, quantity: 1, guessUsd: null, sellability: "moderate" as const };
  const base = () => valueBundle({ main, mainValueUsd: 505, extras: [{ item: ctrl, unitValueUsd: 32, runTimeDays: 5, estimated: false }] });

  section("without a measurement the valuation is unchanged");
  const v = base();
  const counted = v.lines.find((l) => l.status === "counted")!;
  check("the controller adds its weighted share, and the lot is worth more than the console alone", counted.countedUsd > 0 && v.totalValueUsd > 505, v.lines);
  check("a guess or nothing measured changes nothing", applyMeasuredPremiums(v, [{ name: "Xbox Wireless Controller", basis: "prior", lowUsd: 5 }, { name: "Other", basis: "measured", lowUsd: 1 }], sameAddonLoosely) === v);

  section("with a measured premium only the low end counts");
  const low = Math.max(1, Math.floor(counted.countedUsd / 2));
  const m = applyMeasuredPremiums(v, [{ name: "Xbox Controller", basis: "measured", lowUsd: low }], sameAddonLoosely);
  const after = m.lines.find((l) => l.status === "counted")!;
  check("the controller now counts at the low end, never more than before", after.countedUsd === low && after.countedUsd <= counted.countedUsd, after);
  check("the totals are recomputed from the lines, so nothing is counted twice", m.addedUsd === low && m.totalValueUsd === 505 + low && m.upliftUsd === low);
  check("it says so", /low end of its measured premium/.test(after.note) && /measured premium count at its low end/.test(m.summary));
  check("a measured premium above what the valuation gave cannot raise it", applyMeasuredPremiums(v, [{ name: "Xbox Wireless Controller", basis: "measured", lowUsd: 999 }], sameAddonLoosely).addedUsd === counted.countedUsd);
  check("the gate may count it (it is measured, not an estimate)", gateExtrasFromValuation(m).countedUsd === low);
});
