// Condition judged against what the item NORMALLY looks like. Two things help a model see damage: general knowledge of how damage looks (cracks, dents, missing material), and the
// product's own undamaged shape ("a rounded corner, a flat back with three lenses"). The second comes from Clynx's product knowledge and is only passed on when it is established
// (researched, verified or owner-asserted): an inference is not a standard to measure damage by. Pure.
import type { KnowledgeGraph } from "./knowledgeGraph.js";
import { canEliminate } from "./evidenceKinds.js";

/** What undamaged examples of this product are described as, or null when nothing established is known. */
export function normalReferenceText(graph: KnowledgeGraph, productName: string): string | null {
  const entities = graph.find(productName, ["model", "variant", "edition", "family"]);
  const lines: string[] = [];
  for (const e of entities) {
    for (const ch of e.characteristics) if (canEliminate(ch.kind)) lines.push(ch.text);
    // the family's own discriminating descriptions are statements about how the units are built
    if (e.kind === "model" && e.parentId) for (const d of graph.discriminators(e.parentId)) {
      const opt = d.options.find((o) => o.id === d.expected[e.id]);
      if (opt && canEliminate(d.kind)) lines.push(`${d.aspect.replace(/_/g, " ")}: ${opt.describe}`);
    }
  }
  const unique = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
  return unique.length ? unique.slice(0, 6).join(" ") : null;
}

/** The extra instruction for the condition look, given the normal appearance (empty when there is none). */
export function conditionReferenceBlock(reference: string | null): string {
  if (!reference) return "";
  return `\nWhat an undamaged example of this product normally looks like: ${reference} Compare the photos with that. A shape that departs from it (a corner that looks chipped, cut off or crushed, a frame that is bent, a button or part that is missing, a seam that has opened) may be damage even where no crack lines are visible. Say which part of the item is affected.`;
}

/** The rules that keep reflections and normal features from being reported as damage. */
export const NOT_DAMAGE_RULES = `Do NOT report as damage: glare or reflections (a bright streak that moves with the light or fades toward the edges), a screen protector's edge or a case, shadows, perspective or lens distortion, decorative patterns and printed artwork, normal seams, ports and vents, camera compression or moire. If you cannot tell a reflection from a crack, report it with "low" confidence and say it might be a reflection: it is then treated as "possible damage", never as damage.`;
