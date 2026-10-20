// Gathering and checking a product's versions and add-ons (owner decisions 2026-10-20). Two jobs, both injected with their network and their Database so they run offline in tests:
//  1. gatherCandidates: ask the sources in a fixed order (eBay item specifics, then web catalogues, then the model's memory as a hint, then pages for add-ons) and put every name found
//     into the persistent queue as "queued" ("found, not yet checked"). Same input, same list. Nothing is dropped by a cap.
//  2. runQueueTick: take the next few queued names (a throttle, not a limit: the worker comes back every few minutes until the queue is empty), check each against sources, and decide:
//     a version needs more than one voice to become a Database entry (decideVariant), otherwise it stays a SUGGESTION; an add-on found in a source ALWAYS becomes its own accessory entry.
import { addonCandidatesFromPages, decideVariant, findingsToCandidates, isMemoryOnly, memoryHints, mergeCandidates, specificsToCandidates, candidateKey, type AspectDistribution, type Candidate, type PageText } from "./variantDiscovery.js";
import type { EditionFinding } from "./editionDiscovery.js";
import type { StoredCandidate } from "./store.js";
import type { VariantVerdict } from "./variantEvidence.js";

export interface QueueStore {
  upsertCandidates(parentId: string, candidates: Candidate[], now?: number): number;
  nextQueuedCandidates(kind: "variant" | "addon", limit: number, now?: number): StoredCandidate[];
  deferCandidate(parentId: string, kind: "variant" | "addon", key: string, note: string, now?: number): "waiting" | "gave_up";
  countQueuedCandidates(): number;
  setCandidateStatus(parentId: string, kind: "variant" | "addon", key: string, status: StoredCandidate["status"], note: string | null, entryId?: string | null, now?: number): void;
}

export interface GatherDeps {
  store: QueueStore;
  /** eBay's item specifics for a search of the product, or null when eBay is not set up / said nothing. */
  ebaySpecifics(name: string): Promise<{ aspects: AspectDistribution[]; total: number } | null>;
  /** The web catalogues' editions (editionResearch.ts), or null when the web search was blocked. */
  editions(name: string): Promise<EditionFinding[] | null>;
  /** The model's remembered version names: a HINT only (null when the AI is unavailable or Save-credits is on). */
  memory(name: string): Promise<string[] | null>;
  /** Pages that name accessories for this product (maker, catalogue, specialist pages; never a marketplace listing). */
  addonPages(name: string): Promise<PageText[] | null>;
  now?(): number;
  note?(message: string): void;
}

export interface GatherResult {
  /** New names put in the queue, per kind. */
  queued: { variants: number; addons: number };
  /** One plain line per source saying what it gave or why it gave nothing (shown on the product, so a silent skip never looks like "no versions"). */
  sources: string[];
  /** Candidates found only in the model's memory (shown as hints; never created). */
  memoryOnly: string[];
}

/** Asks every source and queues what they name. A source that fails or says nothing is reported, never hidden. */
export async function gatherCandidates(base: { id: string; name: string }, deps: GatherDeps): Promise<GatherResult> {
  const sources: string[] = [];
  const fromSpecifics: Candidate[] = [];
  const fromCatalogue: Candidate[] = [];
  let memory: Candidate[] = [];
  let addons: Candidate[] = [];

  const spec = await deps.ebaySpecifics(base.name).catch(() => null);
  if (spec) {
    fromSpecifics.push(...specificsToCandidates(base.name, spec.aspects, spec.total));
    sources.push(`eBay listings: ${fromSpecifics.length} version${fromSpecifics.length === 1 ? "" : "s"} used by real listings`);
  } else sources.push("eBay listings: no item specifics available (eBay not connected, or no category found)");

  const editions = await deps.editions(base.name).catch(() => null);
  if (editions) {
    fromCatalogue.push(...findingsToCandidates(base.name, editions));
    sources.push(`web catalogues: ${fromCatalogue.length} version${fromCatalogue.length === 1 ? "" : "s"} named`);
  } else sources.push("web catalogues: the web search was blocked or unavailable, so nothing was checked");

  const hints = await deps.memory(base.name).catch(() => null);
  if (hints) {
    memory = memoryHints(base.name, hints);
    sources.push(`the model's memory (a hint only): ${memory.length} name${memory.length === 1 ? "" : "s"}`);
  } else sources.push("the model's memory: not asked (AI unavailable or Save-credits is on)");

  const pages = await deps.addonPages(base.name).catch(() => null);
  if (pages) {
    addons = addonCandidatesFromPages(base.name, pages);
    sources.push(`accessory pages: ${addons.length} add-on${addons.length === 1 ? "" : "s"} named in ${pages.filter((p) => p.sourceClass !== "marketplace").length} page(s)`);
  } else sources.push("accessory pages: the web search was blocked or unavailable, so no add-ons were looked for");

  const merged = mergeCandidates(fromSpecifics, fromCatalogue, memory, addons);
  const now = deps.now?.();
  const variants = merged.filter((c) => c.kind === "variant");
  const addonList = merged.filter((c) => c.kind === "addon");
  const queuedVariants = deps.store.upsertCandidates(base.id, variants, now);
  const queuedAddons = deps.store.upsertCandidates(base.id, addonList, now);
  for (const line of sources) deps.note?.(line);
  return { queued: { variants: queuedVariants, addons: queuedAddons }, sources, memoryOnly: variants.filter(isMemoryOnly).map((c) => c.name) };
}

export interface TickDeps {
  store: QueueStore;
  /** The base product a queued name belongs to (null when it was deleted: the name is skipped). */
  parentOf(parentId: string): { id: string; name: string } | null;
  /** The evidence check for one version (sources), as the typed-phrase path uses. */
  verify(name: string, parent: { id: string; name: string }): Promise<VariantVerdict>;
  /** Files a confirmed version as its own product under the base and starts its research; returns the new entry's id (null if the name already existed). */
  createVariant(name: string, parent: { id: string; name: string }, verdict: VariantVerdict): Promise<string | null>;
  /** Keeps what a one-source version found as a suggestion on the base product. */
  rememberSuggestion(parent: { id: string; name: string }, verdict: VariantVerdict): void;
  /** Files an add-on found in a source as its own accessory entry (categorized by the Library's own logic), links it to the base, and starts its research. Returns the entry id. */
  createAddonEntry(name: string, parent: { id: string; name: string }, evidence: string[], source: StoredCandidate["sources"]): Promise<string | null>;
  /** The AI is paused / unavailable: stop and leave the rest queued. */
  paused(): boolean;
  /** How many more names may be checked TODAY (the daily ceiling for background work). Undefined = no ceiling. */
  remainingToday?(): number;
  sleep(ms: number): Promise<void>;
  now?(): number;
  note?(parentId: string, message: string): void;
}

export interface TickResult {
  added: string[];
  suggested: string[];
  rejected: string[];
  addonsAdded: string[];
  /** Still queued (the throttle, or a pause, left them for the next tick). */
  deferred: number;
  stopped: string | null;
}

/** Throttle per tick: a few versions and a few add-ons, then come back. The queue itself has no cap. */
export const TICK_VARIANTS = 3;
export const TICK_ADDONS = 3;
export const TICK_GAP_MS = 1500;

const toCandidate = (c: StoredCandidate): Candidate => ({ name: c.name, kind: c.kind, sources: c.sources, support: c.support ?? undefined, evidence: c.evidence });

/** One pass of the worker: check the next queued versions and add-ons. Safe to call again and again; it never does more than the throttle. */
export async function runQueueTick(deps: TickDeps, opts: { variants?: number; addons?: number; gapMs?: number } = {}): Promise<TickResult> {
  const result: TickResult = { added: [], suggested: [], rejected: [], addonsAdded: [], deferred: 0, stopped: null };
  const gap = opts.gapMs ?? TICK_GAP_MS;
  // A daily ceiling: the queue refills all day while the scanner meets new products, and every name is a web check and often a full research. Past the ceiling nothing more is checked until tomorrow.
  const allowance = deps.remainingToday ? Math.max(0, deps.remainingToday()) : Infinity;
  if (allowance <= 0) {
    result.stopped = "today's limit for background versions and add-ons is used";
    result.deferred = deps.store.countQueuedCandidates();
    return result;
  }
  const todo = [...deps.store.nextQueuedCandidates("variant", opts.variants ?? TICK_VARIANTS, deps.now?.()), ...deps.store.nextQueuedCandidates("addon", opts.addons ?? TICK_ADDONS, deps.now?.())].slice(0, allowance);
  let first = true;
  for (const q of todo) {
    if (deps.paused()) {
      result.stopped = "the AI is paused";
      result.deferred += todo.length - todo.indexOf(q);
      break;
    }
    if (!first && gap > 0) await deps.sleep(gap);
    first = false;
    const parent = deps.parentOf(q.parentId);
    if (!parent) {
      deps.store.setCandidateStatus(q.parentId, q.kind, q.key, "skipped", "the base product no longer exists", null, deps.now?.());
      continue;
    }
    try {
      if (q.kind === "addon") {
        // an add-on found in a source is ALWAYS added, as its own entry (owner decision); the source is its evidence
        const id = await deps.createAddonEntry(q.name, parent, q.evidence, q.sources);
        deps.store.setCandidateStatus(q.parentId, "addon", q.key, id ? "added" : "skipped", id ? `added as its own entry (${q.evidence.join(", ") || "a source"})` : "already in the Database", id, deps.now?.());
        if (id) {
          result.addonsAdded.push(q.name);
          deps.note?.(q.parentId, `Add-on "${q.name}" added as its own entry.`);
        }
        continue;
      }
      const verdict = await deps.verify(q.name, parent);
      const decision = decideVariant(toCandidate(q), verdict);
      if (decision.action === "create") {
        const id = await deps.createVariant(q.name, parent, verdict);
        deps.store.setCandidateStatus(q.parentId, "variant", q.key, id ? "added" : "skipped", id ? decision.why : "already in the Database", id, deps.now?.());
        if (id) result.added.push(q.name);
      } else if (decision.action === "suggest") {
        deps.rememberSuggestion(parent, verdict);
        deps.store.setCandidateStatus(q.parentId, "variant", q.key, "suggestion", decision.why, null, deps.now?.());
        result.suggested.push(q.name);
      } else {
        deps.store.setCandidateStatus(q.parentId, "variant", q.key, "rejected", decision.why, null, deps.now?.());
        result.rejected.push(q.name);
      }
    } catch (e) {
      // A failed check goes to the BACK of the line with a growing wait (a name that always fails must never hold up the good ones behind it), and is set aside with a visible
      // note after four tries. The reason is kept (short), not the raw error.
      const why = String((e as Error)?.message ?? "unknown error").replace(/\s+/g, " ").slice(0, 80);
      const outcome = deps.store.deferCandidate(q.parentId, q.kind, q.key, why, deps.now?.());
      deps.note?.(q.parentId, outcome === "gave_up" ? `I could not check "${q.name}" after several tries, so I set it aside.` : `Could not check "${q.name}" just now; I will try it again later.`);
      result.deferred++;
    }
  }
  result.deferred = Math.max(result.deferred, deps.store.countQueuedCandidates());
  return result;
}

export { candidateKey };
