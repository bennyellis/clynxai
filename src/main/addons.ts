// Add-ons, first version (P1 of FEATURE_ADDONS_SPEC): the things that can come WITH a base product (a second controller, an expansion card, the original box). The person turns them on
// or off on the Library page and sees what they would add to the estimate.
//
// HONESTY RULES (spec section 7): the numbers here are ROUGH. They come from the same fixed weights the bundle valuation already uses (bundleBreakdown.ts), NOT from sold listings, and
// they say so; add-ons are never summed linearly (diminishing returns, capped by the base value); an add-on that is OFF, dismissed, still only suggested, or has no price adds nothing;
// the base value is never changed, only a range shown next to it. Learning the real premium from sold data is a later phase. Pure: no Database, no clock.
import { ACCESSORY_WEIGHT, EXTRA_WEIGHT, UPLIFT_CAP_OF_FOCAL, UPLIFT_CAP_OF_RAW } from "./bundleBreakdown.js";

export type AddonRole = "expected" | "bonus";
export type AddonStatus = "suggested" | "confirmed" | "dismissed";
export type AddonSource = "seen_in_listing" | "researched_related" | "user_added";
export type AddonCompatibility = "verified" | "plausible" | "unknown";

export interface Addon {
  id: string;
  baseProductId: string;
  /** What it is called ("Second Wireless Controller", "1TB Storage Expansion Card"). */
  name: string;
  /** The add-on's own Database entry, when it has one. */
  addonProductId: string | null;
  role: AddonRole;
  status: AddonStatus;
  source: AddonSource;
  compatibility: AddonCompatibility;
  /** The toggle on the Library page: only an enabled, non-dismissed add-on counts. Suggested ones start OFF. */
  enabled: boolean;
  /** What the add-on sells for on its own, when the person typed it or its own entry has an estimate. null = no price, so it adds nothing. */
  standaloneValueUsd: number | null;
  timesSeen: number;
  exampleListingIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface AddonLine {
  id: string;
  name: string;
  /** What this add-on is credited with before the shared cap (sale-price dollars), or why it counts for nothing. */
  roughAddsUsd: number;
  counted: boolean;
  note: string;
}

export interface AddonEstimate {
  /** A range in sale-price dollars, never one confident number. null when nothing counts. */
  lowUsd: number | null;
  highUsd: number | null;
  lines: AddonLine[];
  /** Always "rough": no sold listings stand behind these numbers yet. */
  confidence: "rough";
  sampleSize: null;
  /** One plain sentence for the page. */
  why: string;
}

const money = (n: number) => `$${Math.round(n)}`;
/** The most add-ons can add to a product with a known value, as a share of that value. */
export const ADDON_HARD_CEILING_OF_BASE = 0.5;

/** Whether an add-on may count towards the estimate: switched on by the person, not dismissed, with a price. */
export function countsTowardsEstimate(a: Pick<Addon, "enabled" | "status" | "standaloneValueUsd">): boolean {
  return a.enabled && a.status !== "dismissed" && a.standaloneValueUsd !== null && a.standaloneValueUsd > 0;
}

/**
 * What the switched-on add-ons would add to the base product's estimate, as a range. An "expected" part (made for the base: a controller) uses the accessory weight, a "bonus" the extra
 * weight (both from bundleBreakdown.ts); the sum flattens out towards a cap tied to the base value (valueBundle's own diminishing-returns formula), so two add-ons are worth less than
 * their sum. The low end is half of that: nothing here is measured, so it is not presented as a point.
 */
export function estimateAddonUplift(baseValueUsd: number | null, addons: Addon[]): AddonEstimate {
  const lines: AddonLine[] = [];
  let raw = 0;
  for (const a of addons) {
    if (a.status === "dismissed") {
      lines.push({ id: a.id, name: a.name, roughAddsUsd: 0, counted: false, note: "dismissed" });
    } else if (!a.enabled) {
      lines.push({ id: a.id, name: a.name, roughAddsUsd: 0, counted: false, note: a.status === "suggested" ? "suggested, switched off" : "switched off" });
    } else if (a.standaloneValueUsd === null || a.standaloneValueUsd <= 0) {
      lines.push({ id: a.id, name: a.name, roughAddsUsd: 0, counted: false, note: "no price yet, so it adds nothing" });
    } else {
      const adds = a.standaloneValueUsd * (a.role === "expected" ? ACCESSORY_WEIGHT : EXTRA_WEIGHT);
      raw += adds;
      lines.push({ id: a.id, name: a.name, roughAddsUsd: adds, counted: true, note: `${a.name} sells for about ${money(a.standaloneValueUsd)} on its own` });
    }
  }
  if (raw <= 0) {
    return { lowUsd: null, highUsd: null, lines, confidence: "rough", sampleSize: null, why: lines.some((l) => !l.counted && l.note !== "dismissed") ? "Switch an add-on on and give it a price to see what it could add." : "No add-ons yet." };
  }
  const base = Math.max(0, baseValueUsd ?? 0);
  // valueBundle's formula: the more pile up, the less each adds, flattening out towards a cap tied to the main item (or half of what they add up to, whichever is more)
  const cap = Math.max(base * UPLIFT_CAP_OF_FOCAL, raw * UPLIFT_CAP_OF_RAW);
  let uplift = cap > 0 ? cap * (1 - Math.exp(-raw / cap)) : 0;
  // A lot of extras on a product with a known value can still only lift it so far: never more than half of what the product is worth on its own (a hard ceiling, because nothing here is
  // measured from sales yet).
  if (base > 0) uplift = Math.min(uplift, base * ADDON_HARD_CEILING_OF_BASE);
  // spread the (smaller) total back over the counted lines so the numbers shown add up to it
  for (const l of lines) if (l.counted) l.roughAddsUsd = (l.roughAddsUsd / raw) * uplift;
  const low = Math.round(uplift * 0.5);
  const high = Math.round(uplift);
  const counted = lines.filter((l) => l.counted).length;
  return {
    lowUsd: low,
    highUsd: high,
    lines,
    confidence: "rough",
    sampleSize: null,
    why: `Rough guess, not measured from sales: ${counted === 1 ? "this add-on" : `these ${counted} add-ons`} might add ${money(low)} to ${money(high)} when sold together${counted > 1 ? " (less than the sum: extras add less and less)" : ""}. It uses fixed weights, not sold listings.`,
  };
}

/** Generic filler a breakdown lists with almost every listing ("cables", "manual", "box"): not suggested as an add-on (spec: ignore filler until seen in several listings). */
export function isNoiseAddon(name: string): boolean {
  const k = addonKey(name);
  return k.length < 3 || /^(?:the )?(?:power |hdmi |usb |charging |ac )?(?:cables?|cords?|adapters?|manuals?|papers?|paperwork|documents?|documentation|box|packaging|original box|stuff|misc|miscellaneous|extras?|accessories|items?|other items?|everything)$/.test(k);
}

/** The key two spellings of the same add-on share ("Second wireless controller" and "second Wireless Controller."). */
export function addonKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
