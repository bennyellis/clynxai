// Phase 5: the add-on premium measured from sold pairs, with the owner's market numbers as the first fixture (console alone about $480-530, with a controller about $500-550+, a controller alone about $30+).
import { measurePremium, splitByInclusion, MIN_SALES_PER_SIDE } from "../addonPremium.js";
import { check, run, section } from "./_testkit.js";

run(async () => {
  const alone = [480, 495, 505, 510, 520, 530];
  const withController = [500, 515, 525, 535, 545, 550];
  section("measured from sold pairs");
  const m = measurePremium({ withUsd: withController, withoutUsd: alone, standaloneUsd: 32, baseUsd: 505 });
  check("the premium is the median with minus the median without, kept under what the controller sells for alone", m.basis === "measured" && m.guess === false && m.midUsd === 23 && m.midUsd! <= 32, m);
  check("deal scoring gets the LOW end, which is under the middle", m.lowUsd !== null && m.midUsd !== null && m.lowUsd < m.midUsd && m.lowUsd >= 0, m);
  check("the note says it was measured, with the samples", /Measured from sold pairs/.test(m.note) && m.sampleWith === 6 && m.sampleWithout === 6);
  const huge = measurePremium({ withUsd: [900, 910, 920, 930, 940], withoutUsd: [500, 505, 510, 515, 520], standaloneUsd: 30, baseUsd: 505 });
  check("a big gap is still never more than the add-on sells for alone", huge.midUsd === 30 && /kept to \$30/.test(huge.note), huge);
  const cap = measurePremium({ withUsd: [900, 910, 920, 930, 940], withoutUsd: [500, 505, 510, 515, 520], standaloneUsd: null, baseUsd: 505 });
  check("and never more than half of the base", cap.midUsd === Math.round(505 * 0.5), cap);
  const none = measurePremium({ withUsd: [480, 490, 500, 510, 520], withoutUsd: [500, 505, 510, 515, 520], standaloneUsd: 30, baseUsd: 505 });
  check("when sales with it did not sell for more, it adds nothing", none.midUsd === 0 && none.lowUsd === 0 && /did not sell for more/.test(none.note), none);
  const noisy = measurePremium({ withUsd: [300, 700, 450, 650, 500, 600], withoutUsd: [310, 690, 460, 640, 505, 590], standaloneUsd: 40, baseUsd: 505 });
  check("when the two groups overlap, the low end is about nothing", noisy.lowUsd === 0, noisy);

  section("too few sales: a cautious prior that says it is a guess");
  const few = measurePremium({ withUsd: [520, 530], withoutUsd: [500, 505, 510], standaloneUsd: 32, baseUsd: 505, role: "expected" });
  check("labelled a guess, not measured, and the low end is half", few.basis === "prior" && few.guess && few.lowUsd === Math.round((few.midUsd ?? 0) * 0.5) && /A guess, not measured/.test(few.note) && new RegExp(`${MIN_SALES_PER_SIDE} of each`).test(few.note), few);
  check("no sales and no price on its own: nothing is claimed", measurePremium({ withUsd: [], withoutUsd: [], standaloneUsd: null, baseUsd: 505 }).basis === "none");
  check("the prior is also under the ceiling", measurePremium({ withUsd: [], withoutUsd: [], standaloneUsd: 400, baseUsd: 505, role: "expected" }).midUsd! <= 252);

  section("pairs from sale titles");
  const sales = [
    { title: "Microsoft Xbox Series X 1TB console with controller", p: 1 }, { title: "Xbox Series X 1TB + wireless controller", p: 2 }, { title: "Xbox Series X 1TB console only", p: 3 },
    { title: "Xbox Series X 1TB console no controller", p: 4 }, { title: "Xbox Series X 1TB Carbon Black", p: 5 }, { title: "Xbox Series X 1TB with 3 games and headset", p: 6 },
  ];
  const sp = splitByInclusion(sales, ["controller"]);
  check("'with' and '+' mention it; 'only', 'no controller' and a plain title are the console alone; a lot with other extras is left out", sp.withIt.map((s) => s.p).join() === "1,2" && sp.withoutIt.map((s) => s.p).join() === "3,4,5", sp);
});
