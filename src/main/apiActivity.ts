// What Clynx's paid and market-research services were actually asked to do, and what came of it (pure registry, in memory, bounded).
//
// Why it exists: an owner reported seeing no OpenAI token use and no eBay searches. Both are easy to explain once you can see them: AI may be going through Clynx Cloud's shared
// key (tokens land on the COMPANY's OpenAI project, not the person's own), Save-credits mode may be skipping calls, a Database value may be answering without a live lookup, or a
// request may be failing quietly. Every request is recorded here with which of those it was, so the Activity screen can say it plainly.
//
// Bounded by design: counters, a ring of the last 100 events and the last 30 failures. No request body, no header, no key or token is ever stored: error text is cut and scrubbed.

export type Provider = "openai" | "ebay" | "watchcount";

/**
 * live_ok / live_failed: a real request left this computer (or went to Clynx Cloud). cached: the answer was reused from a recent identical request. local_db: the Database already
 * had the answer, no lookup. skipped_budget: an allowance or limit stopped it. skipped_unneeded: nothing required it. skipped_disabled: the feature, the key or the sign-in is not there.
 */
export type Outcome = "live_ok" | "live_failed" | "cached" | "local_db" | "skipped_budget" | "skipped_unneeded" | "skipped_disabled";

/** Where a live request went: this computer's own key, Clynx Cloud's shared service, eBay directly with this computer's keys, or a browser page (WatchCount). */
export type Route = "own_key" | "clynx_cloud" | "ebay_direct" | "browser" | "none";

export interface TokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

export interface ApiEvent {
  ts: number;
  provider: Provider;
  /** What it was for: a purpose for OpenAI (chat, photo analysis...), an endpoint category for eBay (browse_search, oauth_token...), sold_comps for WatchCount. */
  kind: string;
  outcome: Outcome;
  route: Route;
  model?: string | null;
  status?: number | null;
  ms?: number | null;
  results?: number | null;
  tokens?: TokenUsage | null;
  /** True when the answer was streamed and the service reported no token counts. */
  tokensNotReported?: boolean;
  costUsdEst?: number | null;
  error?: string | null;
}

/**
 * One decision an AI (or a market check) made, in words: what it looked at, what it concluded and why, with a tiny picture when it looked at one. Bounded: the last 40, a
 * thumbnail of at most ~120 px each, thoughts cut to 400 characters. Never a prompt, a full image, a key, or the person's contact details.
 */
export interface AiDecision {
  ts: number;
  /** photo_analysis, reference_photo_check, thumbnail_check, listing_judgement, comparable_check, product_identity, ... */
  kind: string;
  /** What it was about: a listing title, a product name. */
  subject: string;
  /** The conclusion in a word or two ("match", "not a match", "deal", "not a deal", "unsure"). */
  verdict: string;
  /** Its reasoning, as it gave it. */
  thought: string;
  /** A small data: URI of the image it looked at, when it looked at one. */
  image?: string | null;
  model?: string | null;
  route?: Route;
}

export interface ProviderStats {
  attempted: number; // live requests (ok + failed)
  ok: number;
  failed: number;
  cached: number;
  localDb: number;
  skippedBudget: number;
  skippedUnneeded: number;
  skippedDisabled: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  byRoute: Record<string, number>;
  byKind: Record<string, { ok: number; failed: number; other: number }>;
  tokens: { input: number; output: number; total: number; requestsWithTokens: number; requestsWithoutTokens: number };
  costUsdEst: number;
  costUsdEstComplete: boolean;
  models: Record<string, number>;
  results: { retrieved: number; accepted: number; rejected: number; uncertain: number };
}

export interface ApiSnapshot {
  startedAt: number;
  now: number;
  providers: Record<Provider, ProviderStats>;
  recent: ApiEvent[];
  recentFailures: ApiEvent[];
  /** What the AI looked at and decided lately, newest first (see AiDecision). */
  decisions: AiDecision[];
  /** Which service answers AI and eBay for this session, as set by the app (never a key). */
  source: { ai: string; ebay: string; note: string } | null;
}

const MAX_EVENTS = 100;
const MAX_FAILURES = 30;
const MAX_DECISIONS = 40;
const MAX_THOUGHT = 400;
const MAX_IMAGE_CHARS = 24_000;
const MAX_KINDS = 40;
const MAX_ERROR = 200;

/** USD per 1M tokens (input, output). An ESTIMATE from public list prices; cached-input discounts and reasoning tokens billed as output are not modelled. Unknown models give no estimate. */
export const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-5-mini": { input: 0.25, output: 2.0 },
};

export function estimateCostUsd(model: string | null | undefined, t: TokenUsage | null | undefined): number | null {
  if (!model || !t) return null;
  const p = PRICE_PER_MILLION[model];
  if (!p || t.input === null || t.output === null) return null;
  return (t.input * p.input + t.output * p.output) / 1_000_000;
}

/** Removes anything that looks like a credential from text that may be shown or stored. */
export function scrub(text: unknown, max: number = MAX_ERROR): string {
  let s = String(text ?? "");
  s = s.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[key]");
  s = s.replace(/enc:v1:[A-Za-z0-9+/=*._-]*/g, "[protected key]");
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]");
  s = s.replace(/("?(?:access_token|refresh_token|api[_-]?key|authorization|client_secret|password)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, "$1[redacted]");
  s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function emptyStats(): ProviderStats {
  return {
    attempted: 0, ok: 0, failed: 0, cached: 0, localDb: 0, skippedBudget: 0, skippedUnneeded: 0, skippedDisabled: 0,
    lastSuccessAt: null, lastFailureAt: null, byRoute: {}, byKind: {},
    tokens: { input: 0, output: 0, total: 0, requestsWithTokens: 0, requestsWithoutTokens: 0 },
    costUsdEst: 0, costUsdEstComplete: true, models: {},
    results: { retrieved: 0, accepted: 0, rejected: 0, uncertain: 0 },
  };
}

export class ApiActivity {
  private startedAt = Date.now();
  private stats: Record<Provider, ProviderStats> = { openai: emptyStats(), ebay: emptyStats(), watchcount: emptyStats() };
  private events: ApiEvent[] = [];
  private failures: ApiEvent[] = [];
  private decisionLog: AiDecision[] = [];
  private source: ApiSnapshot["source"] = null;

  reset(): void {
    this.startedAt = Date.now();
    this.stats = { openai: emptyStats(), ebay: emptyStats(), watchcount: emptyStats() };
    this.events = [];
    this.failures = [];
    this.decisionLog = [];
  }

  /** Records what an AI decided and why. Text is scrubbed and cut; an oversized picture is dropped rather than stored. */
  decision(d: Omit<AiDecision, "ts"> & { ts?: number }): void {
    const image = d.image && d.image.startsWith("data:image/") && d.image.length <= MAX_IMAGE_CHARS ? d.image : null;
    const clean = (t: string, n: number) => scrub(t, n);
    this.decisionLog.push({ ...d, ts: d.ts ?? Date.now(), subject: clean(d.subject, 140), verdict: clean(d.verdict, 40), thought: scrub(d.thought, MAX_THOUGHT), image });
    if (this.decisionLog.length > MAX_DECISIONS) this.decisionLog.splice(0, this.decisionLog.length - MAX_DECISIONS);
  }

  setSource(source: ApiSnapshot["source"]): void {
    this.source = source;
  }

  /** Records one request (or one decision not to make one). `quiet` updates the counters only, for high-volume non-events (a token reused, a deterministic skip). */
  record(e: Omit<ApiEvent, "ts"> & { ts?: number }, opts: { quiet?: boolean } = {}): ApiEvent {
    const ev: ApiEvent = { ...e, ts: e.ts ?? Date.now(), error: e.error ? scrub(e.error) : e.error ?? null };
    const s = this.stats[ev.provider];
    const kind = this.kindKey(s, ev.kind);
    s.byKind[kind] ??= { ok: 0, failed: 0, other: 0 };
    switch (ev.outcome) {
      case "live_ok":
        s.attempted++; s.ok++; s.lastSuccessAt = ev.ts; s.byKind[kind].ok++;
        break;
      case "live_failed":
        s.attempted++; s.failed++; s.lastFailureAt = ev.ts; s.byKind[kind].failed++;
        break;
      case "cached": s.cached++; s.byKind[kind].other++; break;
      case "local_db": s.localDb++; s.byKind[kind].other++; break;
      case "skipped_budget": s.skippedBudget++; s.byKind[kind].other++; break;
      case "skipped_unneeded": s.skippedUnneeded++; s.byKind[kind].other++; break;
      case "skipped_disabled": s.skippedDisabled++; s.byKind[kind].other++; break;
    }
    if (ev.outcome === "live_ok" || ev.outcome === "live_failed") {
      s.byRoute[ev.route] = (s.byRoute[ev.route] ?? 0) + 1;
      if (ev.model) s.models[ev.model] = (s.models[ev.model] ?? 0) + 1;
    }
    if (ev.outcome === "live_ok" && ev.provider === "openai") {
      if (ev.tokens && ev.tokens.total !== null) {
        s.tokens.input += ev.tokens.input ?? 0;
        s.tokens.output += ev.tokens.output ?? 0;
        s.tokens.total += ev.tokens.total;
        s.tokens.requestsWithTokens++;
        const cost = estimateCostUsd(ev.model, ev.tokens);
        ev.costUsdEst = cost;
        if (cost === null) s.costUsdEstComplete = false;
        else s.costUsdEst += cost;
      } else {
        s.tokens.requestsWithoutTokens++;
        s.costUsdEstComplete = false;
      }
    }
    if (!opts.quiet) {
      this.events.push(ev);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      if (ev.outcome === "live_failed") {
        this.failures.push(ev);
        if (this.failures.length > MAX_FAILURES) this.failures.splice(0, this.failures.length - MAX_FAILURES);
      }
    }
    return ev;
  }

  /** How many results a search retrieved, and how many the product-identity check accepted / rejected / was unsure about. */
  identity(provider: Provider, c: { retrieved: number; accepted: number; rejected: number; uncertain: number }): void {
    const r = this.stats[provider].results;
    r.retrieved += c.retrieved; r.accepted += c.accepted; r.rejected += c.rejected; r.uncertain += c.uncertain;
  }

  snapshot(): ApiSnapshot {
    const copy = (s: ProviderStats): ProviderStats => JSON.parse(JSON.stringify(s));
    return {
      startedAt: this.startedAt,
      now: Date.now(),
      providers: { openai: copy(this.stats.openai), ebay: copy(this.stats.ebay), watchcount: copy(this.stats.watchcount) },
      recent: [...this.events].reverse(),
      recentFailures: [...this.failures].reverse(),
      decisions: [...this.decisionLog].reverse(),
      source: this.source,
    };
  }

  private kindKey(s: ProviderStats, kind: string): string {
    if (s.byKind[kind] || Object.keys(s.byKind).length < MAX_KINDS) return kind;
    return "other";
  }
}

/** The process-wide registry. */
export const apiActivity = new ApiActivity();

/** Which part of the app asked, from the call stack: the first file outside the API clients. Never throws. */
export function purposeFromStack(stack: string | undefined): string {
  const frames = String(stack ?? "").split("\n").slice(1);
  for (const f of frames) {
    const m = /[\\/]([A-Za-z0-9_]+)\.(?:ts|js|cjs|mjs)/.exec(f);
    if (!m) continue;
    const file = m[1];
    if (file === "openai" || file === "apiActivity") continue;
    return PURPOSE_BY_FILE[file] ?? file;
  }
  return "other";
}

const PURPOSE_BY_FILE: Record<string, string> = {
  chat: "chat",
  vision: "photo analysis / image checks",
  scorer: "listing judgement (text)",
  products: "product research",
  productIdentity: "product identity",
  watchcount: "market research (comps)",
  webResearch: "web research",
  bundleBreakdown: "bundle valuation",
  compPhotoCheck: "comparable photo check",
  locationDiscovery: "location lookup",
  index: "app",
};
