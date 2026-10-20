// SoldCompsService: asks the providers in order (official -> the owner's imports -> third party), keeps what came back, judges every comp for the product (match.ts), and says plainly what it
// has: how many usable sales, a ROUGH-or-better price summary, and, when there is nothing, WHY (a source that answered "none" is different from a source that was blocked, backlog B3).
// Not wired into Clynx's research: nothing calls this yet.
import { trimmedMean } from "../marketValue.js";
import { matchAll, type CompMatch, type PhotoVerdict, type ProductIdentity } from "./match.js";
import { dayOf, queryKeyOf, type SoldCompsStore } from "./store.js";
import type { ProviderOutcome, SoldComp, SoldCompsProvider, SoldSource } from "./types.js";

export interface ProviderReport {
  provider: SoldSource;
  label: string;
  thirdParty: boolean;
  outcome: ProviderOutcome;
  retrieved: number;
  usable: number;
  cached: boolean;
}

export interface PriceSummary {
  count: number;
  medianUsd: number;
  lowUsd: number;
  highUsd: number;
  trimmedMeanUsd: number | null;
  /** Median of item price plus the shipping the buyer paid, over the comps that state shipping (null when fewer than half do). */
  medianDeliveredUsd: number | null;
  newestSoldAt: number | null;
  oldestSoldAt: number | null;
  /** Share of the used comps that came from a third party. */
  thirdPartyShare: number;
  /** "weak" under 5 usable sales, "fair" under 12, else "good"; a summary never claims more. */
  confidence: "weak" | "fair" | "good";
  note: string;
}

export interface ZeroReason {
  kind: "none" | "blocked" | "all_rejected" | "no_provider" | "error";
  text: string;
}

export interface ResearchResult {
  queryKey: string;
  providers: ProviderReport[];
  matches: CompMatch[];
  usable: SoldComp[];
  summary: PriceSummary | null;
  zero: ZeroReason | null;
}

export interface SoldCompsServiceOptions {
  store: SoldCompsStore;
  /** In the order they are asked. */
  providers: SoldCompsProvider[];
  now?: () => number;
  log?: (line: string) => void;
  photoCheck?: (comp: SoldComp, product: ProductIdentity) => Promise<PhotoVerdict>;
  /** Stop asking further providers once this many usable sales are in hand (default 5). */
  enoughUsable?: number;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarize(usable: SoldComp[], thirdPartySources: Set<SoldSource>): PriceSummary | null {
  const usd = usable.filter((c) => c.currency === "USD");
  if (usd.length === 0) return null;
  const prices = usd.map((c) => c.soldPrice);
  const delivered = usd.filter((c) => c.shippingCost !== null);
  const dates = usd.map((c) => c.soldAt).filter((d): d is number => d !== null);
  const tm = trimmedMean(prices);
  const confidence = usd.length < 5 ? "weak" : usd.length < 12 ? "fair" : "good";
  return {
    count: usd.length,
    medianUsd: round2(median(prices)),
    lowUsd: Math.min(...prices),
    highUsd: Math.max(...prices),
    trimmedMeanUsd: tm.value === null ? null : round2(tm.value),
    medianDeliveredUsd: delivered.length * 2 >= usd.length ? round2(median(delivered.map((c) => c.soldPrice + (c.shippingCost ?? 0)))) : null,
    newestSoldAt: dates.length ? Math.max(...dates) : null,
    oldestSoldAt: dates.length ? Math.min(...dates) : null,
    thirdPartyShare: usd.filter((c) => thirdPartySources.has(c.source)).length / usd.length,
    confidence,
    note:
      confidence === "weak"
        ? `Only ${usd.length} usable sale${usd.length === 1 ? "" : "s"}: treat the price as a rough hint.`
        : `${usd.length} usable sales.${dates.length === 0 ? " Their dates are unknown." : ""}`,
  };
}

export class SoldCompsService {
  constructor(private readonly o: SoldCompsServiceOptions) {}

  async research(product: ProductIdentity, query?: { title?: string; categoryId?: string | null; aspects?: Record<string, string> }): Promise<ResearchResult> {
    const now = (this.o.now ?? Date.now)();
    const log = this.o.log ?? (() => {});
    const title = (query?.title ?? product.query ?? product.name).trim();
    const gtin = product.gtin ?? null;
    const epid = product.epid ?? null;
    const queryKey = queryKeyOf(title, gtin, epid);
    const day = dayOf(now);
    const enough = this.o.enoughUsable ?? 5;
    const reports: ProviderReport[] = [];
    const seen = new Map<string, SoldComp>();
    const matchById = new Map<string, CompMatch>();

    for (const provider of this.o.providers) {
      let comps: SoldComp[] = [];
      let outcome: ProviderOutcome;
      let cached = false;
      const hit = this.o.store.cachedLookup(queryKey, day, provider.id);
      if (hit) {
        comps = this.o.store.getComps(hit.compIds);
        outcome = hit.outcomeKind === "ok" ? { kind: "ok", detail: "answered earlier today" } : { kind: "none", detail: hit.detail };
        cached = true;
      } else {
        const res = await provider.search({ title, gtin, epid, categoryId: query?.categoryId ?? null, aspects: query?.aspects });
        comps = res.comps;
        outcome = res.outcome;
        if (comps.length > 0) this.o.store.upsertComps(comps);
        this.o.store.recordLookup({ queryKey, day, provider: provider.id, outcomeKind: outcome.kind, detail: "detail" in outcome && outcome.detail ? outcome.detail : "", compIds: comps.map((c) => c.id), at: now });
      }
      log(`sold comps: ${provider.label} -> ${outcome.kind}${"detail" in outcome && outcome.detail ? ` (${outcome.detail})` : ""}, ${comps.length} sales${cached ? " [cached]" : ""}`);
      const fresh = comps.filter((c) => !seen.has(c.id));
      for (const c of fresh) seen.set(c.id, c);
      const matches = await matchAll(product, fresh, this.o.photoCheck);
      for (const m of matches) {
        matchById.set(m.compId, m);
        this.o.store.saveMatch({ compId: m.compId, productId: m.productId, identityVerdict: m.verdict, reason: m.reason, photoCheck: m.photoCheck, accepted: m.accepted, judgedAt: now });
      }
      reports.push({ provider: provider.id, label: provider.label, thirdParty: provider.thirdParty, outcome, retrieved: comps.length, usable: matches.filter((m) => m.accepted).length, cached });
      if ([...matchById.values()].filter((m) => m.accepted).length >= enough) break;
    }

    const matches = [...matchById.values()];
    const usable = matches.filter((m) => m.accepted).map((m) => seen.get(m.compId)!).filter(Boolean);
    const thirdParty = new Set(this.o.providers.filter((p) => p.thirdParty).map((p) => p.id));
    const summary = summarize(usable, thirdParty);
    const result: ResearchResult = { queryKey, providers: reports, matches, usable, summary, zero: summary ? null : zeroReason(reports, matches) };
    if (result.zero) log(`sold comps: NO usable sales for "${title}": ${result.zero.text}`);
    return result;
  }
}

/** Why nothing is usable, in one honest sentence: never a bare zero. */
export function zeroReason(reports: ProviderReport[], matches: CompMatch[]): ZeroReason {
  if (reports.length === 0) return { kind: "no_provider", text: "No sold-price source is configured." };
  const retrieved = matches.length;
  if (retrieved > 0) {
    const counts: Record<string, number> = {};
    for (const m of matches) for (const r of m.reason.split("; ")) counts[r.split(":")[0]] = (counts[r.split(":")[0]] ?? 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ");
    const uncertain = matches.filter((m) => m.verdict === "uncertain").length;
    return { kind: "all_rejected", text: `${retrieved} sold listings came back but none could price this product (${uncertain} uncertain, ${retrieved - uncertain} rejected${top ? `; most common: ${top}` : ""}).` };
  }
  const blocked = reports.filter((r) => r.outcome.kind === "blocked");
  const errored = reports.filter((r) => r.outcome.kind === "error");
  const unavailable = reports.filter((r) => r.outcome.kind === "disabled" || r.outcome.kind === "not_configured");
  const answeredNone = reports.filter((r) => r.outcome.kind === "none");
  const d = (r: ProviderReport) => `${r.label}: ${"detail" in r.outcome && r.outcome.detail ? r.outcome.detail : r.outcome.kind}`;
  if (blocked.length > 0) return { kind: "blocked", text: `No sales were read, and that says nothing about the market: ${blocked.map(d).join("; ")}.` };
  if (answeredNone.length > 0 && errored.length === 0) return { kind: "none", text: `The sources answered and found no sold items: ${answeredNone.map(d).join("; ")}${unavailable.length ? `. Not available: ${unavailable.map(d).join("; ")}` : ""}.` };
  if (errored.length > 0) return { kind: "error", text: `A source failed: ${errored.map(d).join("; ")}.` };
  return { kind: "no_provider", text: `No source could be asked: ${unavailable.map(d).join("; ")}.` };
}
