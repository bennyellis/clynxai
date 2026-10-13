// Phase 4 veto-only identity safeguard, runtime side: the mode switch, a cached resolver view of the Database, a decision cache, a log, and counters. The decision
// itself is identity/safeguard.ts. Three modes, set only in config.json (`identitySafeguard.mode`), "off" by default:
//   off      nothing is computed, nothing is built, nothing is logged: the app behaves exactly as before.
//   shadow   every match the existing matcher makes is evaluated and written to the log, but NOTHING changes.
//   enforce  a vetoed match is not used for filing, valuation, or adding to a Database entry. Nothing is ever put in its place.
// It fails open: any error, a missing entry, a title it cannot read, all mean "the match stands". It never throws into the scan.
import { buildContext, type ResolverContext } from "./foundationResolver.js";
import { identityTokens } from "./resolver.js";
import { isBrokenVariantName } from "../brokenVariant.js";
import type { EvidenceDoc } from "./credibility.js";
import { evaluateMatch, type SafeguardDecision } from "./safeguard.js";

export type SafeguardMode = "off" | "shadow" | "enforce";

export interface SafeguardSource {
  /** Every Database entry (id and name). */
  entries(): Array<{ id: string; name: string }>;
  /** Listing titles and reference-photo titles: the evidence that tells model markers from seller codes and variant words from wording. */
  evidenceDocs(): EvidenceDoc[];
}

export interface SafeguardStats {
  evaluated: number;
  allow: number;
  unsure: number;
  veto: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  contextBuilds: number;
  contextBuildMs: number;
}

// A word that appears in more entries than this says little about which entry a title is about (a maker, a kind of thing); it is not used to pick candidates.
const COMMON_WORD_ENTRIES = 400;
const CONTEXT_MAX_AGE_MS = 300_000;
// After an entry is added, renamed or removed the view is rebuilt at most this often (a scan that creates many entries must not rebuild a large view each time); until then
// an entry the view does not know is simply "unsure".
const CONTEXT_MIN_REBUILD_MS = 30_000;
const DECISION_CACHE_MAX = 2_000;

export class IdentitySafeguard {
  private mode: SafeguardMode = "off";
  private view: { at: number; entries: Array<{ id: string; name: string }>; ctx: ResolverContext; byId: Map<string, { id: string; name: string }>; postings: Map<string, string[]> } | null = null;
  private decisions = new Map<string, SafeguardDecision>();
  private log: ((record: Record<string, unknown>) => void) | null = null;
  readonly stats: SafeguardStats = { evaluated: 0, allow: 0, unsure: 0, veto: 0, errors: 0, totalMs: 0, maxMs: 0, contextBuilds: 0, contextBuildMs: 0 };

  constructor(private source: SafeguardSource) {}

  setMode(mode: SafeguardMode, log?: ((record: Record<string, unknown>) => void) | null): void {
    this.mode = mode === "shadow" || mode === "enforce" ? mode : "off";
    this.log = log ?? null;
    this.dirty = false;
    if (this.mode === "off") {
      this.view = null;
      this.decisions.clear();
    }
  }

  getMode(): SafeguardMode {
    return this.mode;
  }

  private dirty = false;

  /** Note that entries changed (added, renamed or removed): the view is rebuilt on the next use once it is old enough. */
  invalidate(): void {
    this.dirty = true;
  }

  private context() {
    const now = Date.now();
    if (this.view && now - this.view.at < CONTEXT_MAX_AGE_MS && !(this.dirty && now - this.view.at >= CONTEXT_MIN_REBUILD_MS)) return this.view;
    this.dirty = false;
    const t = performance.now();
    const entries = this.source.entries();
    const ctx = buildContext(entries, this.source.evidenceDocs());
    const postings = new Map<string, string[]>();
    for (const info of ctx.infos()) for (const w of new Set([...info.words, ...(info.host?.words ?? [])])) (postings.get(w) ?? postings.set(w, []).get(w)!).push(info.id);
    this.view = { at: now, entries, ctx, byId: new Map(entries.map((e) => [e.id, e])), postings };
    this.decisions.clear();
    this.stats.contextBuilds++;
    this.stats.contextBuildMs += performance.now() - t;
    return this.view;
  }

  /** The decision for a match, or null when the safeguard is off or could not judge. Never throws. */
  decide(args: { title: string | null; matchedName: string | null; entry: { id: string; name: string }; seller?: string | null; site: string }): SafeguardDecision | null {
    if (this.mode === "off") return null;
    const title = (args.title ?? "").trim();
    const matched = (args.matchedName ?? "").trim() || null;
    if (!title && !matched) return null;
    try {
      const key = `${args.entry.id}\u0001${title}\u0001${matched ?? ""}`;
      const cached = this.decisions.get(key);
      if (cached) return cached;
      const t = performance.now();
      const view = this.context();
      // Only entries that share a distinguishing word with the title, the extracted name or the matched entry can be what the text is about: the resolver reads those,
      // not the whole Database, so the cost stays flat as the library grows.
      const ids = new Set<string>([args.entry.id]);
      for (const text of [title, matched ?? ""]) {
        for (const w of identityTokens(text).words) {
          const list = view.postings.get(w);
          if (list && list.length <= COMMON_WORD_ENTRIES) for (const id of list) ids.add(id);
        }
      }
      const candidates = [...ids].map((id) => view.byId.get(id)).filter((e): e is { id: string; name: string } => !!e);
      const d = evaluateMatch({ title: title || (matched as string), matchedName: matched, entry: args.entry, seller: args.seller ?? null }, candidates, view.ctx, { exempt: (e) => isBrokenVariantName(e.name) });
      const ms = performance.now() - t;
      this.stats.evaluated++;
      this.stats[d.decision]++;
      this.stats.totalMs += ms;
      this.stats.maxMs = Math.max(this.stats.maxMs, ms);
      if (this.decisions.size >= DECISION_CACHE_MAX) this.decisions.delete(this.decisions.keys().next().value as string);
      this.decisions.set(key, d);
      if (this.log && (this.mode === "shadow" || d.decision === "veto")) {
        try {
          this.log({ at: Date.now(), mode: this.mode, site: args.site, decision: d.decision, kind: d.kind, reason: d.reason, against: d.against?.name ?? null, title, matchedName: matched, entry: args.entry.name, ms: Number(ms.toFixed(2)) });
        } catch {
          /* a log that cannot be written never matters to a scan */
        }
      }
      return d;
    } catch {
      this.stats.errors++;
      return null;
    }
  }

  /** True only in "enforce" mode and only for a veto. In "shadow" mode it records the decision and returns false. */
  vetoes(args: { title: string | null; matchedName: string | null; entry: { id: string; name: string } | null; seller?: string | null; site: string }): boolean {
    if (this.mode === "off" || !args.entry) return false;
    const d = this.decide({ ...args, entry: args.entry });
    return this.mode === "enforce" && d?.decision === "veto";
  }
}
