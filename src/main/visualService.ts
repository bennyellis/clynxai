// Runs the observation-and-research pipeline (identityResearch.ts) in the background for listings whose identity is in doubt, and records what it concluded in AI Activity.
// In "shadow" mode (the default) it only RECORDS: no listing, price, alert or Library entry is changed by it. It is rationed per hour, skipped in Save-credits mode, never waits
// for or blocks a scan, and never throws.
import { noteDecision } from "./aiDecisionLog.js";
import { identifyFromObservation, type IdentityDecision, type Observer, type ThemeClassifier } from "./identityResearch.js";
import { seedNintendoHandhelds } from "./knowledgeSeeds.js";
import type { KnowledgeGraph } from "./knowledgeGraph.js";
import { createResearchLimiter } from "./productKnowledge.js";
import { challengeModelClaim, parseModelClaim, type ChallengeResult } from "./claimChallenge.js";
import type { VerifyDeps } from "./variantEvidence.js";

export type VisualMode = "off" | "shadow";

export interface VisualServiceDeps {
  graph(): KnowledgeGraph;
  web(): VerifyDeps;
  observer(): Observer | null;
  themes?(): ThemeClassifier | undefined;
  mode(): VisualMode;
  usage?(key: string, count?: number): void;
  perHour?: number;
  lowAi?(): boolean;
}

/** One plain line for AI Activity. */
export function describeDecision(d: IdentityDecision): string {
  const parts: string[] = [];
  if (d.family) parts.push(`family: ${d.family.value} (${d.family.kind})`);
  if (d.model) parts.push(`model: ${d.model.value} (${d.model.kind})`);
  else if (d.remainingModels.length) parts.push(`model: undecided between ${d.remainingModels.join(", ")}`);
  if (d.edition) parts.push(`edition: ${d.edition.value} (${d.edition.kind})`);
  return parts.length ? parts.join("; ") : "could not identify";
}

/** What a model-name check found, in one line (also used by the chat tool). */
export function describeChallenge(c: ChallengeResult): string {
  switch (c.verdict) {
    case "exists_official":
      return `"${c.claim}" is listed on an official page.`;
    case "exists_researched":
      return `"${c.claim}" is described by an independent source, not confirmed by the maker.`;
    case "not_in_official_lineup":
      return `"${c.claim}" is NOT in the maker's lineup (${c.officialLineup.slice(0, 6).join(", ")}). Real models it may be: ${c.alternatives.join(", ") || "none found"}. Nothing was assumed.`;
    case "unverified_seller_only":
      return `Only listings or shops call it "${c.claim}"; no official source does. Unverified.`;
    default:
      return `Could not check "${c.claim}": ${c.note}`;
  }
}

/** Records the maker's lineup (found by a check) as knowledge: the models that really exist, with the official page that says so. Creates nothing in the Library. */
export function rememberLineup(graph: KnowledgeGraph, c: ChallengeResult): void {
  if (c.officialLineup.length < 2) return;
  const src = c.sources.find((s) => s.quality === "official");
  if (!src) return;
  const parsed = parseModelClaim(c.claim);
  const maker = graph.upsert({ kind: "manufacturer", name: parsed?.brand[0] ?? parsed?.anchor ?? "Unknown", itemKind: "hardware" });
  for (const name of c.officialLineup) {
    const m = graph.upsert({ kind: "model", name, parentId: maker.id, itemKind: "hardware" });
    graph.addClaim(m.id, { claim: `${name} is listed in the official lineup`, url: src.url, quality: "official", quote: c.officialLineup.join(", ").slice(0, 200) });
  }
}

export function createVisualService(d: VisualServiceDeps) {
  const limiter = createResearchLimiter(d.perHour ?? 6);
  const seen = new Set<string>();
  let seeded: KnowledgeGraph | null = null;
  return {
    /** Fire-and-forget. `key` stops the same listing being researched twice. */
    consider(input: { key: string; title: string; images: string[]; description?: string | null }): void {
      if (d.mode() === "off" || d.lowAi?.() || seen.has(input.key) || input.images.length === 0) return;
      const observer = d.observer();
      if (!observer || !limiter.take()) return;
      seen.add(input.key);
      if (seen.size > 2000) seen.clear();
      void (async () => {
        try {
          const graph = d.graph();
          if (seeded !== graph) {
            seedNintendoHandhelds(graph);
            seeded = graph;
          }
          // A model number in the title is a claim to check against the maker's lineup before anyone relies on it.
          let challenge: ChallengeResult | null = null;
          if (parseModelClaim(input.title)) {
            challenge = await challengeModelClaim(input.title, d.web()).catch(() => null);
            if (challenge) {
              d.usage?.("claim_check");
              rememberLineup(graph, challenge);
              noteDecision({ kind: "model_claim_check", subject: input.title.slice(0, 100), verdict: challenge.verdict.replace(/_/g, " "), thought: describeChallenge(challenge) });
            }
          }
          const decision = await identifyFromObservation({ images: input.images, title: input.title, description: input.description }, { graph, web: d.web(), observer, themes: d.themes?.(), usage: d.usage });
          noteDecision({
            kind: "visual_identity",
            subject: input.title.slice(0, 100),
            verdict: `would conclude: ${describeDecision(decision)}`,
            thought: `Shadow mode: nothing was changed. ${decision.trace.join(" ")} ${challenge && challenge.verdict === "not_in_official_lineup" ? describeChallenge(challenge) : ""} ${decision.uncertainty.length ? `Unknown: ${decision.uncertainty.join(" ")}` : ""} (${decision.stats.visionCalls} photo look(s), ${decision.stats.searches} search(es), ${decision.stats.ms} ms).`.trim(),
            imageDataUri: input.images[0] ?? null,
          });
        } catch (err) {
          noteDecision({ kind: "visual_identity", subject: input.title.slice(0, 100), verdict: "could not check", thought: `${(err as Error).message}.` });
        }
      })();
    },
  };
}
