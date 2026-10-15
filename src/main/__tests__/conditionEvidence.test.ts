// Beta 13 WP7: structured condition evidence, the merge rule, and the defect-specific adjustment (audit CV-01..CV-05). The text table is the one from condition-probe.
import { defectsFromText, defectsFromVision, mergeCondition, type DefectEvidence } from "../conditionEvidence.js";
import { adjustForCondition, productClassOf } from "../conditionAdjust.js";
import { CONDITION_VALUE_FACTOR, resaleOutcome } from "../resaleMath.js";
import { check, run, section } from "./_testkit.js";

const classes = (t: string) => defectsFromText(t).map((d) => d.cls);

run(() => {
  section("the lexicon: damage the old parser missed is now evidence");
  check("minor scratches on the screen are recorded, as low-confidence cosmetic wear", (() => { const d = defectsFromText("Nintendo Switch minor scratches on screen, works great"); return d.length === 1 && d[0].cls === "scratches" && d[0].confidence === "low" && d[0].severity === "cosmetic"; })());
  check("hinge loose and frame bent", classes("MacBook hinge loose and frame bent, works").includes("hinge_damage") && classes("MacBook hinge loose and frame bent, works").includes("damaged_frame"));
  check("corrosion on battery contacts", classes("Laptop has corrosion on the battery contacts").includes("corrosion"));
  check("dented frame and chipped corner", classes("Phone has a dented frame and a chipped corner").includes("damaged_frame"));
  check("Joy-Con drift is a fault only testing shows", classes("Joy-Con drift on the left stick").includes("nonvisual_fault"));
  check("lens fungus", classes("Camera lens scratched and fungus inside").includes("other") && classes("Camera lens scratched and fungus inside").includes("scratches"));
  check("water damage is its own class, not a 'minor' dent", classes("Water damage, still powers on").includes("liquid_damage"));
  check("burn-in and dead pixels are display faults", classes("Screen has burn-in and a dead pixel cluster").includes("broken_display"));
  check("a cracked BACK glass is not also a cracked screen", (() => { const c = classes("iPhone 13 Pro 128GB back glass cracked, screen perfect"); return c.includes("cracked_back_glass") && !c.includes("cracked_screen"); })());
  check("a cracked screen is a cracked screen", classes("iPhone 13 screen is cracked, works").includes("cracked_screen"));
  check("HDMI port damaged", classes("Xbox Series X HDMI port damaged, no video").includes("damaged_ports"));
  check("disc drive not working", classes("PS5 disc drive not working").includes("nonvisual_fault") || classes("PS5 disc drive not working").includes("damaged_ports"));
  check("missing controller", classes("Console missing controller, otherwise perfect").includes("missing_parts"));
  check("selling for parts / bad motherboard", classes("Selling for parts, bad motherboard").includes("nonvisual_fault"));
  section("negation and accessories still work");
  check("'works perfectly, no damage, not broken' finds nothing", defectsFromText("Works perfectly, no damage, not broken").length === 0);
  check("'no cracks or scratches' finds nothing", defectsFromText("Mint, no cracks or scratches").length === 0);
  check("a cracked screen PROTECTOR is not the device", defectsFromText("Cracked screen protector only, device is mint").length === 0);

  section("the merge rule: one defect counted once; contradictions flagged");
  const text = defectsFromText("iPhone screen is cracked");
  const vShowsCrack = defectsFromVision([{ class: "cracked_screen", description: "crack across the screen", confidence: "high", severity: "functional", photoNumber: 2 }]);
  const both = mergeCondition(text, vShowsCrack, { shown: ["screen"], noVisibleDamage: false }, 4);
  check("text + photo agree = ONE defect, high confidence, no flag", both.defects.length === 1 && both.defects[0].source === "text+vision" && both.flags.length === 0, both);
  const hidden = mergeCondition([], vShowsCrack, { shown: ["screen"], noVisibleDamage: false }, 4);
  check("a damage only the photos show is flagged UNDISCLOSED_DAMAGE", hidden.defects.length === 1 && hidden.flags[0]?.flag === "UNDISCLOSED_DAMAGE");
  const unseen = mergeCondition(defectsFromText("cracked screen"), [], { shown: ["screen", "back"], noVisibleDamage: true }, 5);
  check("the seller reports it, the photos do not show it: the report STAYS and it is noted", unseen.defects.length === 1 && unseen.defects[0].cls === "cracked_screen" && unseen.flags.some((f) => f.flag === "SELLER_REPORT_NOT_VISIBLE"), unseen);
  const fuzzy = mergeCondition([], defectsFromVision([{ class: "scratches", description: "maybe a scratch", confidence: "low", severity: "cosmetic" }]), null, 3);
  check("a low-confidence cosmetic mark is DAMAGE_UNCERTAIN/ignorable, never an accusation", !fuzzy.flags.some((f) => f.flag === "UNDISCLOSED_DAMAGE"));
  const clean = mergeCondition([], [], { shown: ["screen", "back", "body"], noVisibleDamage: true }, 6);
  check("nothing found and the model said so => 'No visible damage detected', never 'mint verified'", clean.statements[0].startsWith("No visible damage detected in 6 photos") && !/mint|verified/i.test(clean.statements.join(" ")));
  const unknownCond = mergeCondition([], [], null, 4);
  check("ambiguous photos => 'could not be judged', not 'clean'", /could not be judged/.test(unknownCond.statements[0]) && unknownCond.flags[0].flag === "DAMAGE_UNCERTAIN");
  check("a picture never asserts a fault only testing can show", defectsFromVision([{ class: "nonvisual_fault", description: "does not power on", confidence: "high" }]).length === 0);
  check("an unknown class from the model becomes 'other' (not dropped, not trusted)", defectsFromVision([{ class: "made_up", description: "weird" }])[0].cls === "other");

  section("the adjustment: per defect, with a range, no double count");
  const S = { netPercent: 84 };
  const profit = (value: number, ask: number) => Math.round(resaleOutcome(value, ask, S.netPercent).profitUsd);
  const backGlass = adjustForCondition(450, defectsFromText("back glass cracked, screen perfect"), { productName: "iPhone 13 Pro" });
  const screen = adjustForCondition(450, defectsFromText("screen cracked"), { productName: "iPhone 13 Pro" });
  check("cracked back glass costs much less than a cracked screen", backGlass.deductionUsd < screen.deductionUsd && backGlass.deductionUsd < 80, { b: backGlass.deductionUsd, s: screen.deductionUsd });
  check("the flat x0.6 would have thrown away a profitable buy the defect-based value keeps (ask $300)", profit(450 * CONDITION_VALUE_FACTOR.minor, 300) < 0 && profit(backGlass.valueUsd.likely, 300) > 0, { flat: profit(450 * 0.6, 300), per: profit(backGlass.valueUsd.likely, 300) });
  check("water damage deducts far more than a cosmetic wear mark", adjustForCondition(900, defectsFromText("Water damage, still powers on"), { productName: "Gaming PC" }).deductionUsd >= 400 && adjustForCondition(900, defectsFromText("minor scratches"), {}).deductionUsd === 0);
  check("the range brackets the likely value and the total is capped at 75%", (() => { const a = adjustForCondition(400, defectsFromText("for parts, water damage, cracked screen, bad motherboard"), { productName: "PS5" }); return a.valueUsd.low <= a.valueUsd.likely && a.valueUsd.likely <= a.valueUsd.high && a.valueUsd.likely >= 400 * 0.25 - 1; })());
  check("text + vision of the same defect deduct once", (() => { const t = defectsFromText("cracked screen"); const v = defectsFromVision([{ class: "cracked_screen", description: "crack", confidence: "high", severity: "functional" }]); const merged = mergeCondition(t, v, null, 3).defects; return adjustForCondition(450, merged, { productName: "iPhone" }).deductionUsd === adjustForCondition(450, t, { productName: "iPhone" }).deductionUsd; })());
  check("thin (low-confidence photo-only) evidence widens the range", (() => { const lowC = adjustForCondition(450, defectsFromVision([{ class: "cracked_screen", description: "maybe", confidence: "low", severity: "functional" }]), { productName: "iPhone" }); const hi = adjustForCondition(450, defectsFromVision([{ class: "cracked_screen", description: "yes", confidence: "high", severity: "functional" }]), { productName: "iPhone" }); return lowC.valueUsd.high - lowC.valueUsd.low > hi.valueUsd.high - hi.valueUsd.low - 1 && lowC.confidence < hi.confidence; })());
  check("matched sold listings win over the table", adjustForCondition(450, defectsFromText("screen cracked"), { productName: "iPhone", matchedSoldMedians: { cracked_screen: 330 } }).perDefect[0].basis === "matched sold listings");
  check("an editable override changes the number", adjustForCondition(450, defectsFromText("screen cracked"), { productName: "iPhone", overrides: { repairUsd: { phone: { cracked_screen: 200 } } } }).deductionUsd > screen.deductionUsd);
  check("the explanation states the numbers are assumptions", adjustForCondition(450, defectsFromText("screen cracked"), { productName: "iPhone" }).explanation.some((e) => /assumption/i.test(e)));
  check("product classes", productClassOf("iPhone 13") === "phone" && productClassOf("Xbox Series X") === "console" && productClassOf("MSI RTX 2070 SUPER") === "gpu" && productClassOf("Dyson V7") === "default");
});
