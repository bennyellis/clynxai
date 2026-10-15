// Beta 13 audit — DIAGNOSTIC probe #3: what the TEXT condition pipeline concludes (offline; vision cannot run without the network) and what the flat multipliers do to money.
import { analyzeCondition } from "../../src/main/conditionParser.js";
import { CONDITION_VALUE_FACTOR, DEFAULT_RESALE_SETTINGS, maxBuyPriceUsd, resaleOutcome } from "../../src/main/resaleMath.js";

const line = (s = "") => console.log(s);
line("== 1. Text -> impact -> flat factor (the only condition input that reaches the Deal Quality Gate today)");
const texts = [
  "iPhone 13 Pro 128GB back glass cracked, screen perfect",
  "iPhone 13 screen is cracked, works",
  "PS5 disc drive not working",
  "Xbox Series X HDMI port damaged, no video",
  "Nintendo Switch minor scratches on screen, works great",
  "MacBook hinge loose and frame bent, works",
  "Water damage, still powers on",
  "Laptop has corrosion on the battery contacts",
  "Phone has a dented frame and a chipped corner",
  "Console missing controller, otherwise perfect",
  "Works perfectly, no damage, not broken",
  "Screen has burn-in and a dead pixel cluster",
  "Joy-Con drift on the left stick",
  "Camera lens scratched and fungus inside",
  "Selling for parts, bad motherboard",
  "Cracked screen protector only, device is mint",
];
for (const t of texts) {
  const a = analyzeCondition(t);
  line(`  [${a.impact.padEnd(5)} x${CONDITION_VALUE_FACTOR[a.impact]}]  ${t}   damage=${JSON.stringify(a.evidence.damage.map((d) => d.phrase))} ignored=${JSON.stringify(a.evidence.ignored)}`);
}

line("\n== 2. Money: what a flat factor does vs a defect-specific repair deduction (ILLUSTRATIVE repair costs are ASSUMPTIONS for the audit, not data)");
const S = DEFAULT_RESALE_SETTINGS;
const rows: Array<[string, number, number, "minor" | "major", number, string]> = [
  // label, working value, ask, text impact, assumed repair cost, note
  ["iPhone 13 Pro, cracked BACK glass", 450, 300, "minor", 40, "cosmetic; screen/function fine"],
  ["iPhone 13 Pro, cracked SCREEN", 450, 300, "minor", 110, "display replacement"],
  ["PS5, disc drive dead", 400, 200, "major", 60, "drive swap; digital sale possible"],
  ["Xbox Series X, HDMI port damaged", 350, 200, "minor", 90, "microsolder or board swap"],
  ["Game Boy shell, cracked case", 60, 30, "minor", 15, "cosmetic"],
  ["Gaming PC, water damage", 900, 350, "minor", 500, "unknown; may be a total loss"],
];
for (const [label, value, ask, impact, repair, note] of rows) {
  const flat = value * CONDITION_VALUE_FACTOR[impact];
  const repairBased = value - repair;
  const p = (v: number) => Math.round(resaleOutcome(v, ask, S.netPercent).profitUsd);
  line(`  ${label.padEnd(36)} value $${value} ask $${ask}  flat x${CONDITION_VALUE_FACTOR[impact]} -> value $${Math.round(flat)} profit $${p(flat)} (max buy $${maxBuyPriceUsd(flat, 0, S)})  |  repair-based (assume $${repair}) -> value $${Math.round(repairBased)} profit $${p(repairBased)} (max buy $${maxBuyPriceUsd(repairBased, 0, S)})  [${note}]`);
}
line(`  settings used: net ${S.netPercent}% of sale kept, min margin ${S.minMarginPercent}%`);
