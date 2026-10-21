// The scan decision as ONE ordered pipeline with named stages and reason codes (Beta 30 prerequisite). evaluateListing in scrapeEngine.ts still holds the code of each stage; this file is the
// contract it follows: which stages exist, in what order, which stage a reason code belongs to, and the slots the next features plug into. Two later pieces need those slots without
// reshuffling the code: the Beta 30 identity stage (naming match, then the resolve ladder when deal vs not differs between candidates) and the Beta 31 distance / age / shipping-headroom stages.

export type StageId = "skip_rules" | "distance_zone" | "age_gate" | "cheap_price_test" | "identity" | "value_and_deal" | "shipping_headroom" | "alert";

export interface PipelineStage {
  id: StageId;
  order: number;
  title: string;
  /** false while the stage is a reserved slot (nothing decides here yet). */
  built: boolean;
  release: "existing" | "beta30" | "beta31";
}

export const PIPELINE: ReadonlyArray<PipelineStage> = [
  { id: "skip_rules", order: 1, title: "Skip rules: bulky categories, Facebook shipping program, eBay mentions, blacklist, other states, placeholder prices (unchanged)", built: true, release: "existing" },
  { id: "distance_zone", order: 2, title: "Distance zone from home", built: false, release: "beta31" },
  { id: "age_gate", order: 3, title: "Age gate by zone", built: false, release: "beta31" },
  { id: "cheap_price_test", order: 4, title: "Cheap price test before any photo or AI step", built: true, release: "existing" },
  { id: "identity", order: 5, title: "Identity: alias / naming match, then the resolve ladder only when deal vs not differs between candidates, within a per-listing and per-day budget", built: true, release: "beta30" },
  { id: "value_and_deal", order: 6, title: "Value and deal rule", built: true, release: "existing" },
  { id: "shipping_headroom", order: 7, title: "Shipping headroom for out-of-range listings", built: false, release: "beta31" },
  { id: "alert", order: 8, title: "Alert and reason chips", built: true, release: "existing" },
];

/** The stage each reason code the engine records belongs to. A code with no entry here fails the pipeline test, so a new skip cannot be added without saying where it sits. */
export const CODE_STAGE: Readonly<Record<string, StageId>> = {
  BLACKLISTED: "skip_rules",
  UNSHIPPABLE: "skip_rules",
  OUT_OF_STATE: "skip_rules",
  PLACEHOLDER_PRICE: "skip_rules",
  UNDER_MIN_PRICE: "cheap_price_test",
  OVER_MAX_PRICE: "cheap_price_test",
  NOT_FOCUSED: "skip_rules",
  PHOTO_INELIGIBLE: "identity",
  DAMAGE_UNCERTAIN: "value_and_deal",
  UNDISCLOSED_DAMAGE: "value_and_deal",
  NO_VISIBLE_DAMAGE_DETECTED: "value_and_deal",
  CONDITION_ADJUSTED: "value_and_deal",
  SKIPPED_BEFORE_OPENING: "skip_rules",
};

export function stageOf(code: string): StageId | null {
  return CODE_STAGE[code] ?? null;
}

export const orderOf = (id: StageId): number => PIPELINE.find((s) => s.id === id)?.order ?? 0;
