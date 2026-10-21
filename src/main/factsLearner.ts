// Model facts learned from eBay item specifics (Phase 1.1): which colours, capacities and editions real listings of a product line actually use, with how many listings said so and where it came
// from. This only RECORDS what the market uses; whether a detail belongs in a name is decided later from sold prices (namingEngine.judgeAttribute). Pure: aspect distributions in, facts out.
import type { AspectDistribution } from "./variantDiscovery.js";
import { normalizeCapacity } from "./variantDiscovery.js";

export type LearnedAttribute = "colour" | "capacity" | "edition";
export interface LearnedFact {
  attribute: LearnedAttribute;
  value: string;
  /** listings that used this value */
  count: number;
}

const CAPACITY_ASPECT = /^(?:storage capacity|hard drive capacity|memory capacity|capacity|internal storage|ssd capacity|storage)$/i;
const COLOR_ASPECT = /^(?:colou?r|main colou?r)$/i;
const EDITION_ASPECT = /^(?:edition|special edition|limited edition)$/i;
const JUNK_VALUE = /^(?:n\/a|na|none|unbranded|does not apply|not specified|other|multicolou?r|multi-?colou?r|unknown|see description|-)$/i;
const MIN_COUNT = 3;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "").trim();
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** What the listings' own item specifics say a line comes in. Values used by fewer than a few listings are noise; "Other", "N/A" and the like are not facts. */
export function learnFromAspects(aspects: ReadonlyArray<AspectDistribution>): LearnedFact[] {
  const out = new Map<string, LearnedFact>();
  for (const aspect of aspects) {
    const attribute: LearnedAttribute | null = CAPACITY_ASPECT.test(aspect.name) ? "capacity" : COLOR_ASPECT.test(aspect.name) ? "colour" : EDITION_ASPECT.test(aspect.name) ? "edition" : null;
    if (!attribute) continue;
    for (const v of aspect.values) {
      const raw = clean(v.value);
      if (!raw || JUNK_VALUE.test(raw) || v.count < MIN_COUNT) continue;
      const value = attribute === "capacity" ? normalizeCapacity(raw) : attribute === "colour" ? titleCase(raw) : raw;
      const key = `${attribute}|${value.toLowerCase()}`;
      const prev = out.get(key);
      out.set(key, { attribute, value, count: (prev?.count ?? 0) + v.count });
    }
  }
  return [...out.values()].sort((a, b) => a.attribute.localeCompare(b.attribute) || b.count - a.count || a.value.localeCompare(b.value));
}
