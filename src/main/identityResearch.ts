// The reasoning pipeline for a listing whose identity is not obvious. It follows the way a knowledgeable reseller works, and every step is explicit and recorded:
//   1 look at the photos with no name in mind          7 ask the photos the questions that tell the candidates apart
//   2 write down what is seen                          8 rule out candidates that a photographed, established feature contradicts
//   3 propose candidates (the maker's families)        9 settle on the most specific identity that is SUPPORTED, no more
//   4 research the family (models, editions)          10 (condition is judged separately, see conditionEvidence.ts)
//   5 find relevant generations, models, editions     11 (comparables are matched afterwards, see compIdentity.ts)
//   6 learn what tells them apart                     12 save what was learned as source-backed knowledge (the graph), never as Library products
// The seller's title is a CLAIM: it can suggest where to look but never decides, and never reaches the observation step. Several plausible candidates stay several; the
// decision then says what is unknown. All dependencies (the eyes, the web, the knowledge store) are injected, so every branch is tested without a model or a network.
import { canEliminate, type EvidenceKind, type Fact, type FactSource } from "./evidenceKinds.js";
import { extractEditions, matchEditions, type EditionHit, type EditionMatch, type EditionPage } from "./editionDiscovery.js";
import type { KnowledgeGraph, KgEntity } from "./knowledgeGraph.js";
import { kindOfName } from "./productKind.js";
import { sourceQuality } from "./evidenceKinds.js";
import type { VerifyDeps } from "./variantEvidence.js";
import { eliminate, observationQueries, type Elimination, type Observation, type Question } from "./visualProfile.js";

export interface Observer {
  /** Pass 1: describe the photos (no seller words are ever passed). */
  observe(images: string[]): Promise<Observation | null>;
  /** Pass 2: answer the given questions about the photos. */
  answer(images: string[], questions: Question[]): Promise<Record<string, { option: string; note: string }> | null>;
}

export interface ThemeClassifier {
  /** Sort capitalised terms from sources into franchises and characters. Anything it names must appear in `terms`; the pipeline checks. */
  classify(editionName: string, terms: string[], quotes: string[]): Promise<Array<{ term: string; kind: "franchise" | "character"; franchise?: string }> | null>;
}

export interface IdentityDeps {
  graph: KnowledgeGraph;
  web: VerifyDeps;
  observer: Observer;
  themes?: ThemeClassifier;
  /** Counters for cost control (search, vision, cache hits). */
  usage?: (key: string, count?: number) => void;
  now?: () => number;
}

export interface IdentityOptions {
  maxSearches?: number;
  maxPages?: number;
}

export interface IdentityDecision {
  family: Fact | null;
  model: Fact | null;
  edition: Fact | null;
  /** Models that remain possible when the photos could not settle it. */
  remainingModels: string[];
  eliminated: Array<Elimination & { candidate: string }>;
  editionMatches: EditionMatch[];
  /** Everything Clynx does NOT know or could not establish, in plain words. */
  uncertainty: string[];
  /** Photos cannot show whether a unit is a genuine factory edition or an aftermarket one; that is never claimed. */
  authenticity: "unverified";
  observation: Observation | null;
  queries: string[];
  sources: FactSource[];
  stats: { searches: number; visionCalls: number; cacheHits: number; ms: number };
  trace: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether a knowledge entry may be attached to a title of this kind: a hardware entry never takes a game, nor a game a console. */
export function entityAcceptsTitle(e: Pick<KgEntity, "itemKind">, title: string): boolean {
  const k = kindOfName(title);
  if (!e.itemKind || e.itemKind === "other") return true;
  if (e.itemKind === "hardware") return k === "hardware";
  if (e.itemKind === "game") return k === "game";
  if (e.itemKind === "accessory") return k === "accessory";
  return true;
}

function pickFamilies(deps: IdentityDeps, obs: Observation, title: string): KgEntity[] {
  // every hardware family of a maker that is visible on the item or named in the title (the title only suggests where to look; it decides nothing)
  const makers: KgEntity[] = [];
  const add = (list: KgEntity[]) => list.forEach((m) => !makers.some((x) => x.id === m.id) && makers.push(m));
  if (obs.brandVisible) add(deps.graph.find(obs.brandVisible, ["manufacturer"]));
  for (const w of norm(title).split(" ")) if (w.length >= 3) add(deps.graph.find(w, ["manufacturer"]));
  return makers.flatMap((m) => deps.graph.children(m.id, ["family"])).filter((f) => f.itemKind === "hardware" || f.itemKind === null);
}

export async function identifyFromObservation(input: { images: string[]; title?: string; description?: string | null }, deps: IdentityDeps, opts: IdentityOptions = {}): Promise<IdentityDecision> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const trace: string[] = [];
  const stats = { searches: 0, visionCalls: 0, cacheHits: 0, ms: 0 };
  const countingWeb: VerifyDeps = {
    ...deps.web,
    search: async (q, n) => {
      stats.searches++;
      deps.usage?.("web_search");
      return deps.web.search(q, n);
    },
  };
  const out: IdentityDecision = { family: null, model: null, edition: null, remainingModels: [], eliminated: [], editionMatches: [], uncertainty: [], authenticity: "unverified", observation: null, queries: [], sources: [], stats, trace };
  const done = () => {
    stats.ms = now() - started;
    return out;
  };
  const note = (line: string) => trace.push(line);

  // 1-2: observe, with no seller words
  stats.visionCalls++;
  deps.usage?.("vision_call");
  const obs = await deps.observer.observe(input.images).catch(() => null);
  if (!obs) {
    out.uncertainty.push("The photos could not be read, so nothing was identified from them.");
    return done();
  }
  out.observation = obs;
  note(`Saw: ${obs.objectKind}${obs.brandVisible ? `, brand text "${obs.brandVisible}"` : ""}${obs.colors.length ? `, ${obs.colors.join("/")}` : ""}${obs.artwork.length ? `, artwork: ${obs.artwork.join("; ")}` : ""}.`);
  for (const l of obs.limits) out.uncertainty.push(`Photo limit: ${l}.`);

  // 3: candidate families (the title suggests, the knowledge base and the maker's name decide)
  const families = pickFamilies(deps, obs, input.title ?? "");
  if (families.length === 0) {
    out.uncertainty.push("No product family in the knowledge base matches what is visible; it needs research before a model can be named.");
    note("No known family matched the visible brand or the title's maker.");
    return done();
  }
  const family = families[0];
  if (families.length > 1) out.uncertainty.push(`Several product families could fit: ${families.map((f) => f.name).join(", ")}.`);
  out.family = { value: family.name, kind: family.status === "unknown" ? "inferred" : family.status, sources: [] };
  stats.cacheHits++;
  deps.usage?.("knowledge_cache_hit");
  note(`Family candidate from the knowledge base: ${family.name} (${family.status}).`);

  // 4-6: models and what tells them apart (from the knowledge base; this is where research results are reused)
  const models = deps.graph.children(family.id, ["model"]);
  const discriminators = deps.graph.discriminators(family.id);
  if (models.length === 0 || discriminators.length === 0) {
    out.uncertainty.push(`There is no established way yet to tell ${family.name} models apart from photos.`);
    note("No models or discriminating features known for this family.");
  } else {
    // 7: ask the photos only what separates the candidates
    const questions: Question[] = discriminators.map((d) => ({ aspect: d.aspect, question: d.question, options: d.options }));
    stats.visionCalls++;
    deps.usage?.("vision_call");
    const answers = await deps.observer.answer(input.images, questions).catch(() => null);
    if (!answers) {
      out.uncertainty.push("The follow-up look at the controls and layout could not be completed.");
      out.remainingModels = models.map((m) => m.name);
    } else {
      note(`Asked the photos: ${questions.map((q) => `${q.aspect}=${answers[q.aspect]?.option ?? "?"}`).join(", ")}.`);
      // 8: rule out
      const { remaining, eliminated } = eliminate(models.map((m) => m.id), discriminators, answers);
      const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
      out.eliminated = eliminated.map((e) => ({ ...e, candidate: nameOf(e.candidateId) }));
      for (const e of out.eliminated) note(`Ruled out ${e.candidate}: the photos show ${e.saw} (it would show ${e.expected}) [${e.aspect}].`);
      const hidden = discriminators.filter((d) => !answers[d.aspect] || answers[d.aspect].option === "not_visible").map((d) => d.aspect);
      if (hidden.length) out.uncertainty.push(`Not visible in the photos: ${hidden.join(", ")}.`);
      const weak = discriminators.filter((d) => !canEliminate(d.kind)).map((d) => d.aspect);
      if (weak.length) out.uncertainty.push(`These distinguishing features are only inferred, so they were not used to rule anything out: ${weak.join(", ")}.`);
      if (remaining.length === 1) {
        const m = models.find((x) => x.id === remaining[0])!;
        // an inference from photographed features and an established description, not a label read off the unit
        out.model = { value: m.name, kind: "inferred", sources: discriminators.flatMap((d) => d.sources).slice(0, 4) };
        note(`Most specific supported model: ${m.name}.`);
      } else if (remaining.length === 0) {
        out.uncertainty.push("The photos contradict every known model in this family (an unknown model, an aftermarket body, or photos of different items).");
      } else {
        out.remainingModels = remaining.map(nameOf);
        out.uncertainty.push(`The photos do not settle which of these it is: ${out.remainingModels.join(", ")}.`);
      }
    }
  }

  // 4-5 (editions): only when the item shows something beyond a standard look (distinct artwork)
  if (obs.artwork.length > 0) {
    const names = [out.model?.value ?? "", ...out.remainingModels, family.name].filter(Boolean);
    const queries = observationQueries(obs, { candidates: names.slice(0, 2), max: Math.max(1, opts.maxSearches ?? 3) });
    out.queries = queries;
    const pages: EditionPage[] = [];
    for (const q of queries) {
      const hits = await countingWeb.search(q, 8).catch(() => []);
      for (const h of hits) if (!pages.some((p) => p.url === h.url)) pages.push({ url: h.url, title: h.title, text: `${h.title}. ${h.snippet}` });
    }
    const q0 = names[0] ?? "";
    const rank = (u: string) => ({ official: 0, specialist: 1, collector: 2, retailer: 3, other: 4, marketplace: 5 }[sourceQuality(u, q0)]);
    const read = [...pages].sort((a, b) => rank(a.url) - rank(b.url)).slice(0, opts.maxPages ?? 4);
    await Promise.all(
      read.map(async (p) => {
        const text = await deps.web.fetchText(p.url, { tokens: q0.toLowerCase().split(" ") }).catch(() => null);
        if (text && text.length > p.text.length) p.text = text.slice(0, 40_000);
      })
    );
    const editions = extractEditions(names, pages);
    note(`Searched ${stats.searches} time(s); found ${editions.length} edition name(s) in the sources.`);
    // 12: remember them as KNOWLEDGE (never as Library products)
    const parent = (out.model ? models.find((m) => m.name === out.model!.value) : null) ?? family;
    await rememberEditions(deps, parent, editions, names);
    const matches = matchEditions(obs, editions);
    out.editionMatches = matches;
    const best = matches[0];
    const bestHit = best ? editions.find((e) => e.name === best.edition) : undefined;
    if (best && bestHit && best.strength === "likely") {
      const sources: FactSource[] = bestHit.quotes.map((q) => ({ url: q.url, quality: q.quality, quote: q.text }));
      out.edition = { value: best.edition, kind: "researched", sources };
      out.sources.push(...sources);
      out.uncertainty.push(`The shell resembles the ${best.edition} (matching: ${best.matched.join(", ")}), but a photo cannot show whether it is a factory edition or an aftermarket shell.`);
      note(`Edition candidate: ${best.edition} (resemblance matches ${best.matched.join(", ")}).`);
      // the sources tie the edition to a specific model: when exactly one of the models still possible is named with it, that settles the model
      if (!out.model) {
        const possible = out.remainingModels.length ? out.remainingModels : models.map((m) => m.name);
        const tied = possible.filter((mname) => bestHit.models.some((x) => x.toLowerCase() === mname.toLowerCase()));
        if (tied.length === 1) {
          out.model = { value: tied[0], kind: "researched", sources };
          out.remainingModels = [];
          out.uncertainty = out.uncertainty.filter((u) => !u.startsWith("The photos do not settle which of these"));
          note(`The ${best.edition} is only documented for ${tied[0]}, so the model follows from the edition.`);
        }
      }
    } else if (best && best.strength === "possible") {
      out.uncertainty.push(`It may be the ${best.edition} (only partly matching: ${best.matched.join(", ")}); not enough to name it.`);
    } else if (editions.length) {
      out.uncertainty.push(`Editions exist for this line (${editions.slice(0, 4).map((e) => e.name).join(", ")}), but nothing in the photos matches how sources describe them.`);
    } else {
      out.uncertainty.push("No special edition matching this artwork could be found in sources; it may be custom or aftermarket.");
    }
  }
  return done();
}

/** Writes discovered editions into the knowledge graph (kind: edition), with their sources, and links themes to franchises and characters. Creates no Library products. */
async function rememberEditions(deps: IdentityDeps, parent: KgEntity, hits: EditionHit[], familyNames: string[]): Promise<void> {
  for (const h of hits) {
    const e = deps.graph.upsert({ kind: "edition", name: h.name, parentId: parent.id, manufacturer: parent.manufacturer, itemKind: parent.itemKind ?? "hardware" });
    for (const q of h.quotes) deps.graph.addClaim(e.id, { claim: `${h.name} exists for ${familyNames[0] ?? parent.name}`, url: q.url, quality: q.quality, quote: q.text });
    let classified: Array<{ term: string; kind: "franchise" | "character"; franchise?: string }> | null = null;
    if (deps.themes && h.themeTerms.length) classified = await deps.themes.classify(h.name, h.themeTerms, h.quotes.map((q) => q.text)).catch(() => null);
    const valid = (classified ?? []).filter((c) => h.themeTerms.includes(c.term));
    if (valid.length) {
      for (const c of valid.filter((x) => x.kind === "franchise")) {
        const fr = deps.graph.upsert({ kind: "franchise", name: c.term, itemKind: "other" });
        deps.graph.relate(e.id, fr.id, "themed_on", h.sourceUrls[0]);
      }
      for (const c of valid.filter((x) => x.kind === "character")) {
        const ch = deps.graph.upsert({ kind: "character", name: c.term, itemKind: "other" });
        const fr = c.franchise && h.themeTerms.includes(c.franchise) ? deps.graph.upsert({ kind: "franchise", name: c.franchise, itemKind: "other" }) : null;
        if (fr) deps.graph.relate(fr.id, ch.id, "features", h.sourceUrls[0]);
        deps.graph.relate(e.id, ch.id, "themed_on", h.sourceUrls[0]);
      }
    } else if (h.themeTerms.length) {
      deps.graph.setCharacteristic(e.id, { text: `Themed on (terms from sources, not yet classified): ${h.themeTerms.join(", ")}`, kind: "researched", sources: h.quotes.map((q) => ({ url: q.url, quality: q.quality, quote: q.text })) });
    }
  }
}

export type { Fact, EvidenceKind };
