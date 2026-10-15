// Clynx doing its own homework on a product it is unsure about: it thinks up the searches a person would type ("meta quest 3 128gb vs 512gb difference"), reads what comes
// back, and writes down what it can PROVE from the sources: the storage options the line really comes in, and the similar-looking models that are different products
// ("Quest 3S"). Everything the decisions rely on is extracted by plain text rules from the pages themselves and must be supported by at least two sources or one
// manufacturer / retailer page. An AI may help word the searches and summarise, but it can never add a fact the pages do not contain. Network, search engine and AI are
// all injected, so every step is tested with a fake web.
import { capacitiesIn, familyKey, phraseRegex, suffixModelsIn, wordsOf, type KnowledgeSource, type ProductKnowledge } from "./knowledgeRegistry.js";
import { classifySource, type VerifyDeps } from "./variantEvidence.js";
import { searchWasUnavailable } from "./webEvidence.js";

export const KNOWLEDGE_TTL_MS = 45 * 24 * 3600_000;

// ---- when is it worth looking? ---------------------------------------------------------------------------------------------------------------------------------
export interface DoubtSignals {
  identityConfidence?: "high" | "medium" | "low" | null;
  resolver?: "resolved" | "ambiguous" | "unresolved" | null;
  reasonCodes?: string[];
  /** Capacities of other Library entries in the same line (a 128GB entry next to a 512GB one). */
  siblingCapacities?: string[];
  nameStatesCapacity?: boolean;
}

/** Why Clynx is not sure, in plain words (empty = it is sure enough; the obvious products never trigger a search). */
export function doubtReasons(s: DoubtSignals): string[] {
  const out: string[] = [];
  if (s.identityConfidence === "low" || s.identityConfidence === "medium") out.push(`the product check was only ${s.identityConfidence} confidence`);
  if (s.resolver === "ambiguous") out.push("more than one Library entry fits the name");
  if (s.resolver === "unresolved") out.push("no Library entry clearly fits the name");
  const codes = new Set(s.reasonCodes ?? []);
  if (codes.has("CAPACITY_NOT_STATED")) out.push("the title does not say which storage size it is");
  if (codes.has("MODEL_NOT_STATED") || codes.has("MULTIPLE_MODELS") || codes.has("MORE_SPECIFIC")) out.push("the title may be a different or more specific model");
  const caps = new Set(s.siblingCapacities ?? []);
  if (caps.size >= 2) out.push(`the line has entries with different storage sizes (${[...caps].join(", ")})`);
  return out;
}

// ---- the searches a person would type --------------------------------------------------------------------------------------------------------------------------
export interface QueryContext {
  reasons?: string[];
  siblingCapacities?: string[];
}

/** Plain-language searches, no operators, no site: filters. Deterministic, so research still works with no AI. */
export function humanQueries(name: string, ctx: QueryContext = {}, max = 4): string[] {
  const fam = familyKey(name);
  if (!fam) return [];
  const caps = capacitiesIn(name);
  const sib = [...new Set(ctx.siblingCapacities ?? [])];
  const out: string[] = [];
  if (caps.length && sib.length) {
    const others = sib.filter((c) => !caps.includes(c));
    if (others.length) out.push(`${fam} ${caps[0]} vs ${others[0]} difference`);
  }
  out.push(caps.length ? `${fam} ${caps[0]} or other storage which one should I buy` : `${fam} storage sizes which one should I buy`);
  out.push(`${fam} all versions and models what is the difference`);
  out.push(`is there a cheaper or pro version of the ${fam}`);
  out.push(`${fam} specs storage options`);
  return [...new Set(out)].slice(0, max);
}

/** AI-proposed searches are accepted only when they look like something a person types and are about this product. */
export function acceptQueries(raw: unknown, name: string, max = 5): string[] {
  if (!Array.isArray(raw)) return [];
  const famWords = wordsOf(familyKey(name));
  const out: string[] = [];
  for (const q of raw) {
    const t = String(q ?? "").replace(/\s+/g, " ").trim();
    if (t.length < 8 || t.length > 100) continue;
    if (/[:"]|https?:|site\b|inurl|filetype/i.test(t)) continue;
    const w = wordsOf(t);
    if (!famWords.some((f) => w.includes(f))) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ---- reading what came back ------------------------------------------------------------------------------------------------------------------------------------
export interface KnowledgePage {
  url: string;
  title: string;
  text: string;
  sourceClass: string;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|\s\|\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 6 && s.length < 600);
}

const NOT_STORAGE = /\b(?:ram|memory|lpddr\d?x?|vram|mah|hz)\b/i;
const sizeGb = (c: string): number => (c.endsWith("tb") ? Number(c.slice(0, -2)) * 1024 : Number(c.slice(0, -2)));

/** Storage sizes in one sentence: not RAM, not under 16GB. */
function storageIn(sentence: string): string[] {
  const out: string[] = [];
  for (const m of sentence.toLowerCase().matchAll(/\b(\d{1,4})\s?(gb|tb)\b/g)) {
    const around = sentence.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + m[0].length + 14);
    if (NOT_STORAGE.test(around)) continue;
    const c = `${m[1]}${m[2]}`;
    if (sizeGb(c) >= 16) out.push(c);
  }
  return out;
}

export interface Extracted {
  capacities: string[];
  distinctModels: ProductKnowledge["distinctModels"];
  differences: string[];
}

/** The line's name as a person would say it, with and without the brand ("meta quest 3" / "quest 3"). */
function familyForms(fam: string): string[] {
  const w = fam.split(" ").filter(Boolean);
  const forms = [fam];
  if (w.length >= 3) forms.push(w.slice(1).join(" "));
  return forms;
}

/** Plain-text extraction. A fact needs two different sources, or one manufacturer / retailer page. */
export function extractKnowledge(name: string, pages: KnowledgePage[]): Extracted {
  const fam = familyKey(name);
  const forms = familyForms(fam);
  const formRes = forms.map((f) => phraseRegex(f));
  const own = wordsOf(name).join(" ");
  const trusted = (cls: string) => cls === "manufacturer" || cls === "retailer";

  const capVotes = new Map<string, { urls: Set<string>; trusted: boolean }>();
  const modelVotes = new Map<string, { urls: Set<string>; trusted: boolean; evidence: string; url: string }>();
  const diffs: string[] = [];

  for (const page of pages) {
    for (const s of sentences(page.text)) {
      const lower = s.toLowerCase();
      const found = new Set<string>();
      // a model found through the shorter form ("quest 3s") is recorded under the full line name ("meta quest 3s")
      for (const f of forms) for (const m of suffixModelsIn(f, lower)) found.add(`${fam}${m.slice(f.length)}`);
      // "Series S" next to "Series X": a lettered line is swapped letter for letter
      const last = fam.split(" ").pop() ?? "";
      if (/^[a-z]$/.test(last)) for (const m of suffixModelsIn(fam.split(" ").slice(0, -1).join(" "), lower)) found.add(m);
      const related = found.size > 0 || formRes.some((re) => re.test(lower));
      if (!related) continue;
      // storage sizes are counted for the line only from sentences about the line itself, never from one about a look-alike model
      for (const c of found.size === 0 ? storageIn(s) : []) {
        const v = capVotes.get(c) ?? { urls: new Set<string>(), trusted: false };
        v.urls.add(page.url);
        v.trusted ||= trusted(page.sourceClass);
        capVotes.set(c, v);
      }
      for (const m of found) {
        if (own.includes(m) || m === fam) continue;
        const v = modelVotes.get(m) ?? { urls: new Set<string>(), trusted: false, evidence: s.slice(0, 160), url: page.url };
        v.urls.add(page.url);
        v.trusted ||= trusted(page.sourceClass);
        modelVotes.set(m, v);
      }
      if ((new Set(storageIn(s)).size >= 2 || found.size > 0) && diffs.length < 4 && !diffs.includes(s.slice(0, 220))) diffs.push(s.slice(0, 220));
    }
  }
  const ok = (v: { urls: Set<string>; trusted: boolean }) => v.trusted || v.urls.size >= 2;
  return {
    capacities: [...capVotes].filter(([, v]) => ok(v)).map(([c]) => c).sort((a, b) => sizeGb(a) - sizeGb(b)),
    distinctModels: [...modelVotes].filter(([, v]) => ok(v)).map(([m, v]) => ({ name: m, evidence: v.evidence, sourceUrl: v.url })),
    differences: diffs,
  };
}

/** AI-supplied facts survive only when the pages say them. */
export function keepSupported(name: string, ai: { capacities?: unknown; distinctModels?: unknown } | null, pages: KnowledgePage[], base: Extracted): Extracted {
  if (!ai) return base;
  const all = pages.map((p) => p.text).join("\n").toLowerCase();
  const fam = familyKey(name);
  const famWords = fam.split(" ");
  const capacities = new Set(base.capacities);
  for (const c of Array.isArray(ai.capacities) ? ai.capacities : []) {
    const norm = capacitiesIn(String(c))[0];
    if (norm && sizeGb(norm) >= 16 && new RegExp(`\\b${norm.slice(0, -2)}\\s?${norm.slice(-2)}\\b`).test(all) && pages.some((p) => storageIn(p.text).includes(norm))) capacities.add(norm);
  }
  const models = [...base.distinctModels];
  for (const m of Array.isArray(ai.distinctModels) ? ai.distinctModels : []) {
    const nm = wordsOf(String(m)).join(" ");
    if (!nm || nm.length > 60 || nm === fam || models.some((x) => x.name === nm)) continue;
    const shared = wordsOf(nm).filter((w) => famWords.includes(w)).length;
    // the same line (most of its words) and a page really says it
    if (shared >= Math.max(1, Math.ceil(famWords.length / 2)) && wordsOf(nm).length <= famWords.length + 2 && phraseRegex(nm).test(all)) {
      const at = pages.find((p) => phraseRegex(nm).test(p.text.toLowerCase()));
      models.push({ name: nm, evidence: sentences(at?.text ?? "").find((s) => phraseRegex(nm).test(s.toLowerCase()))?.slice(0, 160) ?? "", sourceUrl: at?.url ?? "" });
    }
  }
  return { ...base, capacities: [...capacities].sort((a, b) => sizeGb(a) - sizeGb(b)), distinctModels: models.filter((m) => !wordsOf(name).join(" ").includes(m.name)) };
}

// ---- the whole research ------------------------------------------------------------------------------------------------------------------------------------------
export interface KnowledgeAi {
  queries?(name: string, ctx: QueryContext): Promise<string[] | null>;
  facts?(name: string, pages: Array<{ url: string; title: string; excerpt: string }>): Promise<{ capacities?: unknown; distinctModels?: unknown; summary?: string } | null>;
}

export interface ResearchOptions {
  ai?: KnowledgeAi;
  context?: QueryContext;
  maxQueries?: number;
  maxPages?: number;
  now?: number;
  brandHints?: string[];
}

export type ResearchOutcome = { ok: true; knowledge: ProductKnowledge } | { ok: false; reason: string; searchUnavailable?: boolean };

const CLASS_RANK: Record<string, number> = { manufacturer: 0, retailer: 1, reference: 2, other: 3, marketplace: 4 };

export async function researchProductKnowledge(name: string, deps: VerifyDeps, opts: ResearchOptions = {}): Promise<ResearchOutcome> {
  const fam = familyKey(name);
  if (!fam) return { ok: false, reason: "there is no product name to research" };
  deps.reset?.();
  const maxQueries = opts.maxQueries ?? 4;
  let queries = humanQueries(name, opts.context, maxQueries);
  if (opts.ai?.queries) {
    const proposed = acceptQueries(await opts.ai.queries(name, opts.context ?? {}).catch(() => null), name, 3);
    // the person-like AI searches go first; the fixed ones fill up to the limit
    queries = [...new Set([...proposed, ...queries])].slice(0, maxQueries);
  }
  const pages: KnowledgePage[] = [];
  const seen = new Set<string>();
  const hint = { tokens: fam.split(" ") };
  for (const q of queries) {
    let hits: Array<{ title: string; url: string; snippet: string }> = [];
    try {
      hits = await deps.search(q, 6);
    } catch {
      continue;
    }
    const ranked = hits
      .map((h) => ({ h, cls: classifySource(h.url, name, opts.brandHints ?? []) as string }))
      .sort((a, b) => (CLASS_RANK[a.cls] ?? 3) - (CLASS_RANK[b.cls] ?? 3));
    for (const { h, cls } of ranked) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      pages.push({ url: h.url, title: h.title, text: h.snippet, sourceClass: cls });
    }
  }
  // The most useful few (the maker's, then retailers', then references) are read in full; the rest are judged by their snippet.
  const toRead = [...pages].sort((x, y) => (CLASS_RANK[x.sourceClass] ?? 3) - (CLASS_RANK[y.sourceClass] ?? 3)).slice(0, opts.maxPages ?? 4);
  await Promise.all(
    toRead.map(async (p) => {
      const text = await deps.fetchText(p.url, hint).catch(() => null);
      if (text && text.length > p.text.length) p.text = text.slice(0, 40_000);
    })
  );
  const trace = deps.trace?.();
  if (pages.length === 0) {
    const unavailable = !!trace && searchWasUnavailable(trace);
    return { ok: false, reason: unavailable ? "the web search was blocked or unreachable, so nothing could be checked" : "the searches found nothing about it", searchUnavailable: unavailable || undefined };
  }
  let extracted = extractKnowledge(name, pages);
  let summary = "";
  if (opts.ai?.facts) {
    const forAi = pages
      .map((p) => ({ url: p.url, title: p.title, excerpt: sentences(p.text).filter((s) => familyForms(fam).some((f) => phraseRegex(f).test(s.toLowerCase()))).slice(0, 8).join(" ").slice(0, 1500) }))
      .filter((p) => p.excerpt)
      .slice(0, 6);
    if (forAi.length) {
      const facts = await opts.ai.facts(name, forAi).catch(() => null);
      extracted = keepSupported(name, facts, pages, extracted);
      summary = typeof facts?.summary === "string" ? facts.summary.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    }
  }
  if (!summary) summary = extracted.differences.slice(0, 2).join(" ");
  const sources: KnowledgeSource[] = pages
    .filter((p) => p.text)
    .sort((a, b) => (CLASS_RANK[a.sourceClass] ?? 3) - (CLASS_RANK[b.sourceClass] ?? 3))
    .slice(0, 6)
    .map((p) => ({ url: p.url, title: p.title.slice(0, 120), sourceClass: p.sourceClass }));
  const backends = [...new Set((trace?.searches ?? []).filter((s) => s.outcome === "ok").map((s) => s.backend))];
  return {
    ok: true,
    knowledge: { key: fam, name, capacities: extracted.capacities, distinctModels: extracted.distinctModels, differences: extracted.differences, summary, sources, queries, backends, researchedAt: opts.now ?? Date.now() },
  };
}

// ---- remembered, rationed, never repeated at once ----------------------------------------------------------------------------------------------------
export interface KnowledgeStore {
  getKnowledge(key: string): ProductKnowledge | null;
  saveKnowledge(k: ProductKnowledge): void;
}

export interface EnsureOptions extends ResearchOptions {
  force?: boolean;
  ttlMs?: number;
}

const inFlight = new Map<string, Promise<ResearchOutcome | { ok: true; knowledge: ProductKnowledge; cached: true }>>();
/** At most this many fresh researches per hour, so a busy scan cannot spend the search allowance on lookups. */
export function createResearchLimiter(perHour: number, now: () => number = () => Date.now()) {
  let stamps: number[] = [];
  return {
    take(): boolean {
      const t = now();
      stamps = stamps.filter((s) => t - s < 3600_000);
      if (stamps.length >= perHour) return false;
      stamps.push(t);
      return true;
    },
  };
}

export async function ensureKnowledge(
  name: string,
  store: KnowledgeStore,
  deps: VerifyDeps,
  opts: EnsureOptions & { limiter?: { take(): boolean } } = {}
): Promise<ResearchOutcome | { ok: true; knowledge: ProductKnowledge; cached: true }> {
  const key = familyKey(name);
  if (!key) return { ok: false, reason: "there is no product name to research" };
  const now = opts.now ?? Date.now();
  const cached = store.getKnowledge(key);
  if (cached && !opts.force && now - cached.researchedAt < (opts.ttlMs ?? KNOWLEDGE_TTL_MS)) return { ok: true, knowledge: cached, cached: true };
  const running = inFlight.get(key);
  if (running) return running;
  if (opts.limiter && !opts.limiter.take()) return { ok: false, reason: "the hourly allowance for product research is used up; it will be tried again later" };
  const job = researchProductKnowledge(name, deps, opts)
    .then((r) => {
      // Something is only remembered when there is something to remember; a failed search is never cached as "nothing to know".
      if (r.ok && (r.knowledge.capacities.length || r.knowledge.distinctModels.length || r.knowledge.sources.length)) store.saveKnowledge(r.knowledge);
      return r;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/** One line for the chat / the log. */
export function describeKnowledge(k: ProductKnowledge): string {
  const parts: string[] = [];
  if (k.capacities.length) parts.push(`comes in ${k.capacities.join(", ")}`);
  if (k.distinctModels.length) parts.push(`not the same as ${k.distinctModels.map((m) => m.name).join(", ")}`);
  return parts.length ? `${k.name}: ${parts.join("; ")} (from ${k.sources.length} source${k.sources.length === 1 ? "" : "s"}).` : `${k.name}: the sources did not show different storage sizes or look-alike models.`;
}
