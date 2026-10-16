// Starting knowledge supplied by the Clynx OWNER (in the build instructions), not found by research. Every fact here is marked "owner_asserted": it is the owner's word, shown
// as such, allowed to rule candidates out, and upgraded to "verified" only when an official source is actually read (the source URLs below are where to look). Clynx has not
// read these pages itself. Anything not stated by the owner is not seeded: the research step fills the rest.
import type { KnowledgeGraph } from "./knowledgeGraph.js";
import type { FactSource } from "./evidenceKinds.js";

const NINTENDO_MANUALS = "https://en-americas-support.nintendo.com/app/answers/detail/a_id/16903";
const src = (url: string, quote: string): FactSource => ({ url, quality: "official", quote });

/**
 * The Nintendo 3DS family and the visible differences between the original 3DS XL and the New 3DS XL (owner-supplied): three buttons (SELECT, HOME, START) below the bottom
 * touchscreen versus a single HOME button there with START and SELECT beside the ABXY buttons; and the New model's C Stick and extra shoulder buttons.
 */
export function seedNintendoHandhelds(kg: KnowledgeGraph): { familyId: string; modelIds: Record<string, string> } {
  const maker = kg.upsert({ kind: "manufacturer", name: "Nintendo", itemKind: "hardware" });
  const family = kg.upsert({ kind: "family", name: "Nintendo 3DS family", parentId: maker.id, manufacturer: "Nintendo", itemKind: "hardware", aliases: ["3DS", "Nintendo DS handheld"] });
  kg.setStatusIfUnknown(maker.id, "owner_asserted");
  kg.setStatusIfUnknown(family.id, "owner_asserted");
  const models: Record<string, string> = {};
  for (const [name, aliases] of [
    ["Nintendo 3DS", []],
    ["Nintendo 3DS XL", ["3DS XL", "Nintendo 3DS LL"]],
    ["New Nintendo 3DS", ["New 3DS"]],
    ["New Nintendo 3DS XL", ["New 3DS XL", "New Nintendo 3DS LL"]],
    ["Nintendo 2DS", ["2DS"]],
    ["New Nintendo 2DS XL", ["New 2DS XL", "New Nintendo 2DS LL"]],
  ] as Array<[string, string[]]>) {
    const m = kg.upsert({ kind: "model", name, parentId: family.id, manufacturer: "Nintendo", itemKind: "hardware", aliases });
    models[name] = m.id;
    // not "verified": the owner said it exists; no source has been read
    kg.setStatusIfUnknown(m.id, "owner_asserted");
  }
  const orig = models["Nintendo 3DS XL"];
  const next = models["New Nintendo 3DS XL"];
  const owner = (text: string): { text: string; kind: "owner_asserted"; sources: FactSource[] } => ({ text, kind: "owner_asserted", sources: [src(NINTENDO_MANUALS, "stated by the Clynx owner; official manuals are the source to check")] });
  kg.setCharacteristic(orig, owner("Three separate buttons below the bottom touchscreen: SELECT, HOME, START."));
  kg.setCharacteristic(next, owner("A single HOME button below the bottom touchscreen; START and SELECT sit near the ABXY buttons; has a C Stick and extra shoulder buttons."));
  const common = { familyId: family.id, kind: "owner_asserted" as const, sources: [src(NINTENDO_MANUALS, "owner-supplied description of the 3DS XL vs New 3DS XL layout")] };
  kg.setDiscriminator({
    ...common,
    aspect: "home_button_layout",
    question: "Look at the area directly below the bottom touchscreen. Are there three separate buttons (SELECT, HOME, START) in a row there, or only a single HOME button?",
    options: [
      { id: "three_below_screen", describe: "three buttons SELECT, HOME, START below the bottom screen" },
      { id: "single_home_below_screen", describe: "a single HOME button below the bottom screen" },
    ],
    expected: { [orig]: "three_below_screen", [next]: "single_home_below_screen" },
  });
  kg.setDiscriminator({
    ...common,
    aspect: "c_stick",
    question: "Is there a small nub (the C Stick) on the right side above the ABXY buttons, below the circle pad's mirror position?",
    options: [
      { id: "present", describe: "a small second stick nub is present" },
      { id: "absent", describe: "there is no second stick" },
    ],
    expected: { [orig]: "absent", [next]: "present" },
  });
  return { familyId: family.id, modelIds: models };
}
