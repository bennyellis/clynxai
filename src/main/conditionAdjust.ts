// Beta 13: what a condition is worth, per DEFECT, with a range - instead of "minor = x0.6, major = x0.25" for everything. For each defect the value lost is the repair cost
// where one is known for that kind of product, otherwise a share of the value; the total is capped; the answer is a low / likely / high range that widens when the
// evidence is thin; and it is never applied twice for the same defect (conditionEvidence.mergeCondition counts one defect once).
// THE NUMBERS BELOW ARE ASSUMPTIONS, not measurements: seed values meant to be edited (config.conditionAdjustments) and replaced by defect-matched sold comps when
// enough exist (>= MIN_MATCHED_COMPS). They are shown to the person as assumptions. Pure (no I/O).
import type { DefectClass, DefectEvidence } from "./conditionEvidence.js";

export type ProductClass = "phone" | "console" | "laptop" | "gpu" | "default";
export const MIN_MATCHED_COMPS = 3;
export const MAX_TOTAL_SHARE = 0.75; // never deduct more than this share of the clean value (parts-only value is the floor)

export function productClassOf(name: string): ProductClass {
  const n = name.toLowerCase();
  if (/\b(iphone|galaxy s|galaxy z|pixel \d|smartphone|phone)\b/.test(n)) return "phone";
  if (/\b(xbox|playstation|ps[2-5]|nintendo|switch|steam deck|console|rog ally)\b/.test(n)) return "console";
  if (/\b(macbook|laptop|notebook|chromebook|thinkpad)\b/.test(n)) return "laptop";
  if (/\b(rtx|gtx|radeon|geforce|graphics card|gpu)\b/.test(n)) return "gpu";
  return "default";
}

/** Share of the clean value lost when no repair cost is known. */
export const DEFAULT_SHARE: Record<DefectClass, number> = {
  cracked_screen: 0.25, cracked_back_glass: 0.08, damaged_frame: 0.12, scratches: 0.03, dents: 0.05, broken_display: 0.35, missing_parts: 0.08, damaged_ports: 0.2,
  bent_hardware: 0.25, hinge_damage: 0.25, corrosion: 0.2, broken_housing: 0.12, liquid_damage: 0.5, nonvisual_fault: 0.7, other: 0.1,
};

/** Typical repair cost (USD) per defect and kind of product, where there is one worth using. ASSUMPTIONS. */
export const REPAIR_USD: Partial<Record<ProductClass, Partial<Record<DefectClass, number>>>> = {
  phone: { cracked_screen: 110, cracked_back_glass: 40, damaged_ports: 70, broken_display: 130 },
  console: { damaged_ports: 90, nonvisual_fault: 90 },
  laptop: { cracked_screen: 150, hinge_damage: 120, broken_display: 180, damaged_ports: 80 },
  gpu: {},
};

export type Overrides = { share?: Partial<Record<DefectClass, number>>; repairUsd?: Partial<Record<ProductClass, Partial<Record<DefectClass, number>>>> };

export interface ConditionAdjustment {
  /** Value of the item as it is, clean value minus the deductions. */
  valueUsd: { low: number; likely: number; high: number };
  /** What was deducted from the clean value (likely case). */
  deductionUsd: number;
  perDefect: Array<{ cls: DefectClass; area: string | null; deductionUsd: number; basis: "repair cost" | "share of value" | "matched sold listings"; confidence: string }>;
  /** 0..1: how sure the adjustment is (thin or photo-only evidence is lower). */
  confidence: number;
  explanation: string[];
  /** The old flat multiplier for the same text, for comparison in the shadow display. */
  legacyFactor: number;
}

function oneDeduction(d: DefectEvidence, base: number, cls: ProductClass, o: Overrides, matchedMedian: Partial<Record<DefectClass, number>> | undefined): { usd: number; basis: ConditionAdjustment["perDefect"][number]["basis"] } {
  if (matchedMedian?.[d.cls] != null) return { usd: Math.max(0, base - matchedMedian[d.cls]!), basis: "matched sold listings" };
  const repair = o.repairUsd?.[cls]?.[d.cls] ?? REPAIR_USD[cls]?.[d.cls];
  if (repair != null) return { usd: Math.min(base * MAX_TOTAL_SHARE, repair + base * 0.03), basis: "repair cost" };
  return { usd: base * (o.share?.[d.cls] ?? DEFAULT_SHARE[d.cls]), basis: "share of value" };
}

/**
 * baseValueUsd = what a CLEAN one sells for. `matchedSoldMedians` = the median sold price of listings that had that same defect (when >= MIN_MATCHED_COMPS exist), per class.
 * Cosmetic wear at low confidence counts for nothing (it is what a used item looks like); anything functional, or cosmetic at higher confidence, counts.
 */
export function adjustForCondition(baseValueUsd: number, defects: DefectEvidence[], opts: { productName?: string; overrides?: Overrides; matchedSoldMedians?: Partial<Record<DefectClass, number>>; photoCount?: number; legacyFactor?: number } = {}): ConditionAdjustment {
  const cls = productClassOf(opts.productName ?? "");
  const o = opts.overrides ?? {};
  const base = Math.max(0, baseValueUsd);
  const perDefect: ConditionAdjustment["perDefect"] = [];
  let likely = 0;
  let low = 0;
  let high = 0;
  const explanation: string[] = [];
  for (const d of defects) {
    if (d.severity === "cosmetic" && d.confidence === "low") continue; // normal wear
    const { usd, basis } = oneDeduction(d, base, cls, o, opts.matchedSoldMedians);
    // confidence scales the likely deduction and the width of the range
    const conf = d.confidence === "high" ? 1 : d.confidence === "medium" ? 0.75 : 0.5;
    const l = usd * conf;
    likely += l;
    low += basis === "matched sold listings" ? l * 0.8 : l * (d.confidence === "low" ? 0 : 0.6);
    high += basis === "matched sold listings" ? l * 1.2 : l * (d.confidence === "high" ? 1.5 : 2);
    perDefect.push({ cls: d.cls, area: d.area, deductionUsd: Math.round(l), basis, confidence: d.confidence });
    explanation.push(`${d.cls.replace(/_/g, " ")}${d.area ? ` (${d.area})` : ""}: about -$${Math.round(l)} (${basis}; ${d.source === "text+vision" ? "seller and photos agree" : d.source === "vision" ? "from the photos" : "from the listing text"})`);
  }
  const cap = base * MAX_TOTAL_SHARE;
  likely = Math.min(likely, cap);
  low = Math.min(low, likely);
  high = Math.min(Math.max(high, likely), cap);
  const confidences = perDefect.map((p) => (p.confidence === "high" ? 1 : p.confidence === "medium" ? 0.7 : 0.4));
  const confidence = perDefect.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : (opts.photoCount ?? 0) > 0 ? 0.6 : 0.3;
  const round = (n: number) => Math.round(n);
  return {
    valueUsd: { low: round(base - high), likely: round(base - likely), high: round(base - low) },
    deductionUsd: round(likely),
    perDefect,
    confidence: Math.round(confidence * 100) / 100,
    explanation: explanation.length ? [...explanation, "These repair costs and shares are assumptions, not measurements."] : [],
    legacyFactor: opts.legacyFactor ?? 1,
  };
}
