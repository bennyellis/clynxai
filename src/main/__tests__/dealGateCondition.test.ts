// Beta 13 WP7: the Deal Quality Gate with a defect-specific condition range instead of the flat multiplier (audit CV-02, CV-03).
import { assessListingAge } from "../listingAge.js";
import { qualifyListing, type GateInput, type ValueEvidence } from "../dealGate.js";
import { adjustForCondition } from "../conditionAdjust.js";
import { defectsFromText } from "../conditionEvidence.js";
import { check, run, section } from "./_testkit.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };
const fresh = assessListingAge("2 hours ago", 24);
const strong: ValueEvidence = { valueUsd: 450, basis: "sold", sampleSize: 8, ageDays: 2 };
const base: GateInput = { pathway: "database", priceUsd: 300, conditionImpact: "minor", evidence: strong, age: fresh, settings };
const withAdj = (text: string, name: string, price = 300): GateInput => ({
  ...base,
  priceUsd: price,
  conditionAdjust: (clean) => {
    const a = adjustForCondition(clean, defectsFromText(text), { productName: name });
    return { valueUsd: a.valueUsd, deductionUsd: a.deductionUsd, reasons: a.deductionUsd > 0 ? [{ code: "CONDITION_ADJUSTED", severity: "info", text: a.explanation[0] ?? "" }] : [] };
  },
});

run(() => {
  section("a cheap, cosmetic defect no longer sinks a buy the flat factor sank");
  const flat = qualifyListing({ ...base });
  check("flat x0.6 on a $450 iPhone with a cracked back glass: out of reach at $300", flat.status === "pass", flat.status);
  const back = qualifyListing(withAdj("back glass cracked, screen perfect", "iPhone 13 Pro"));
  check("by defect (back glass, ~$55): a negotiation is within reach", back.status === "negotiation" || back.status === "profitable_now", back.status);
  check("the verdict says what the condition cost and the range", back.facts.conditionAdjustmentUsd !== null && (back.facts.conditionAdjustmentUsd ?? 0) < 80 && !!back.facts.conditionRange && back.facts.conditionRange.low < back.facts.conditionRange.likely, back.facts);
  check("and carries the CONDITION_ADJUSTED reason", back.reasons.some((r) => r.code === "CONDITION_ADJUSTED"));

  section("a costly defect is still expensive");
  const screen = qualifyListing(withAdj("screen is cracked", "iPhone 13 Pro", 250));
  const backAt250 = qualifyListing(withAdj("back glass cracked", "iPhone 13 Pro", 250));
  check("a cracked screen leaves less than a cracked back glass", (screen.facts.lotValueUsd ?? 0) < (backAt250.facts.lotValueUsd ?? 0), { s: screen.facts.lotValueUsd, b: backAt250.facts.lotValueUsd });
  const water = qualifyListing({ ...withAdj("Water damage, still powers on", "Gaming PC", 350), evidence: { ...strong, valueUsd: 900 } });
  check("water damage on a $900 PC is NOT a comfortable buy at $350 (the flat 0.6 said +$104)", water.status !== "profitable_now", water.status);

  section("'profitable now' has to hold at the conservative end of the range");
  const risky = qualifyListing({ ...base, priceUsd: 230, conditionAdjust: () => ({ valueUsd: { low: 250, likely: 400, high: 430 }, deductionUsd: 50, reasons: [] }) });
  const sure = qualifyListing({ ...base, priceUsd: 230, conditionAdjust: () => ({ valueUsd: { low: 395, likely: 400, high: 430 }, deductionUsd: 50, reasons: [] }) });
  check("a wide range with a poor low end is not 'profitable now'", risky.status !== "profitable_now", risky.status);
  check("a tight range with the same likely value is", sure.status === "profitable_now", sure.status);

  section("things that must not change");
  const noAdj = qualifyListing({ ...base, conditionAdjust: null });
  check("without an adjustment the flat multiplier decides, exactly as before", noAdj.status === flat.status && noAdj.facts.conditionAdjustmentUsd === undefined);
  check("a for-parts variant is never adjusted twice", qualifyListing({ ...base, broken: true, conditionAdjust: () => ({ valueUsd: { low: 1, likely: 1, high: 1 }, deductionUsd: 449, reasons: [] }) }).facts.conditionAdjustmentUsd === undefined);
  check("no evidence = still no verdict from condition", qualifyListing({ ...base, evidence: null, conditionAdjust: () => ({ valueUsd: { low: 1, likely: 1, high: 1 }, deductionUsd: 1, reasons: [] }) }).status === "worth_a_look");
});
