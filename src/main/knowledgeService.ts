// Glue for product research: owns the "when" (only when Clynx is unsure, rationed per hour, never twice at once), tells the comparable-sale check what was learned, and writes
// every research and every shadow finding to AI Activity. The research itself is productKnowledge.ts; the web is webResearch.ts / searchApis.ts.
import { capacitiesIn, familyKey, setKnowledgeProvider, type KnowledgeMode, type ProductKnowledge } from "./knowledgeRegistry.js";
import { createResearchLimiter, describeKnowledge, doubtReasons, ensureKnowledge, type DoubtSignals, type KnowledgeAi, type KnowledgeStore, type ResearchOutcome } from "./productKnowledge.js";
import type { VerifyDeps } from "./variantEvidence.js";
import { noteDecision } from "./aiDecisionLog.js";
import { researchEditions, type EditionResearch } from "./editionResearch.js";
import type { KnowledgeGraph } from "./knowledgeGraph.js";

export interface KnowledgeServiceDeps {
  store: KnowledgeStore & { listSiblingNames?(name: string): string[] };
  mode(): KnowledgeMode;
  web(): VerifyDeps;
  ai?(): KnowledgeAi | undefined;
  /** The knowledge graph editions are remembered in (optional). */
  graph?(): KnowledgeGraph;
  /** Researches per hour. */
  perHour?: number;
  log?(message: string, productName: string): void;
  /** Counters for cost control: research_run, knowledge_cache_hit. */
  usage?(key: string, count?: number): void;
}

export interface KnowledgeService {
  install(): void;
  /** Called when a check was not sure about a product: researches it in the background when that is worth doing. Never throws, never waits. */
  consider(name: string, signals: DoubtSignals): void;
  /** Researches now (the chat's tool, or a person pressing the button) and returns the outcome. */
  research(name: string, force?: boolean): Promise<ResearchOutcome | { ok: true; knowledge: ProductKnowledge; cached: true }>;
  cached(name: string): ProductKnowledge | null;
  /** The chat's "research all the special editions of X" (or one named edition): searches, reads, remembers what it found as knowledge (never as Library products). */
  researchEditions(name: string, hint?: string | null): Promise<EditionResearch>;
}

export function createKnowledgeService(d: KnowledgeServiceDeps): KnowledgeService {
  const limiter = createResearchLimiter(d.perHour ?? 4);
  // The comparable check asks for knowledge for every title it judges: a short in-memory copy keeps that off the database.
  const memo = new Map<string, { k: ProductKnowledge | null; at: number }>();
  const lookup = (name: string): ProductKnowledge | null => {
    const key = familyKey(name);
    if (!key) return null;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.k;
    const k = d.store.getKnowledge(key);
    memo.set(key, { k, at: Date.now() });
    return k;
  };
  const reportedShadow = new Set<string>();
  // A product whose research failed is not retried for a while (a blocked search engine would otherwise be asked again for every listing).
  const failedAt = new Map<string, number>();

  async function run(name: string, signals: DoubtSignals | null, force: boolean) {
    const reasons = signals ? doubtReasons(signals) : ["you asked"];
    const outcome = await ensureKnowledge(name, d.store, d.web(), { ai: d.ai?.(), force, limiter: signals ? limiter : undefined, context: { reasons, siblingCapacities: signals?.siblingCapacities } });
    memo.delete(familyKey(name));
    if (outcome.ok) d.usage?.("cached" in outcome ? "knowledge_cache_hit" : "research_run");
    if (!outcome.ok) failedAt.set(familyKey(name), Date.now());
    if (outcome.ok && !("cached" in outcome)) {
      noteDecision({ kind: "web_knowledge", subject: name, verdict: outcome.knowledge.distinctModels.length || outcome.knowledge.capacities.length ? "learned something" : "nothing new found", thought: `${describeKnowledge(outcome.knowledge)} Searched: ${outcome.knowledge.queries.join(" | ")}. Via ${outcome.knowledge.backends.join(", ") || "no search engine answered"}. Why: ${reasons.join("; ")}.` });
      d.log?.(`Researched "${name}" on the web because ${reasons.join("; ")}. ${describeKnowledge(outcome.knowledge)}`, name);
    } else if (!outcome.ok) {
      noteDecision({ kind: "web_knowledge", subject: name, verdict: "could not check", thought: `${outcome.reason}.` });
    }
    return outcome;
  }

  return {
    install() {
      setKnowledgeProvider({
        mode: d.mode,
        lookup,
        shadow: ({ name, title, findings }) => {
          const key = `${familyKey(name)}|${title.toLowerCase().slice(0, 80)}`;
          if (reportedShadow.has(key) || reportedShadow.size > 500) return;
          reportedShadow.add(key);
          noteDecision({ kind: "web_knowledge", subject: title.slice(0, 100), verdict: `would reject: ${findings[0].code.toLowerCase().replace(/_/g, " ")}`, thought: `Compared with "${name}": ${findings[0].text}. Shadow mode: nothing was changed.` });
        },
      });
    },
    consider(name, signals) {
      if (d.mode() === "off") return;
      const sib = d.store.listSiblingNames?.(name) ?? [];
      const merged: DoubtSignals = { ...signals, siblingCapacities: [...new Set([...(signals.siblingCapacities ?? []), ...sib.flatMap((n) => capacitiesIn(n))])] };
      if (doubtReasons(merged).length === 0) return;
      if (Date.now() - (failedAt.get(familyKey(name)) ?? 0) < 30 * 60_000) return;
      void run(name, merged, false).catch(() => undefined);
    },
    research: (name, force) => run(name, null, !!force),
    async researchEditions(name, hint) {
      const r = await researchEditions(name, d.web(), { hint });
      d.usage?.("edition_research");
      // remembered as knowledge: the editions under the product's entry, each with the sources that name it
      const graph = d.graph?.();
      if (graph && r.findings.length) {
        try {
          const parent = graph.find(name, ["model", "family"])[0] ?? graph.upsert({ kind: "model", name, itemKind: "hardware" });
          for (const f of r.findings) {
            const e = graph.upsert({ kind: "edition", name: f.name, parentId: parent.id, itemKind: parent.itemKind ?? "hardware" });
            for (const s of f.sources) graph.addClaim(e.id, { claim: `${f.name} exists for ${name}`, url: s.url, quality: s.quality, quote: s.quote });
          }
        } catch {
          /* remembering is best effort */
        }
      }
      noteDecision({ kind: "web_knowledge", subject: `${name} editions`, verdict: r.findings.length ? `found ${r.findings.length} edition name(s)` : r.blocked ? "search blocked" : "none found", thought: `${r.searches.length} search(es); read ${r.pagesRead.length} page(s)${r.hint ? `; asked about "${r.hint.text}": ${r.hint.matches.length ? "named by the sources" : "not named in what was read"}` : ""}.` });
      return r;
    },
    cached: lookup,
  };
}
