// Related products found while researching one product ("it comes in other versions"). The model suggests names from memory; one typed phrase used to turn into ~120 AI calls and ten or
// more products, four of them saved with error text. Now a suggestion is only a CANDIDATE: it becomes a product only after the evidence check confirms it (verified or supported by sources),
// at most a few per typed phrase, started a moment apart and two at a time, and the whole run stops the moment the AI is paused. An unconfirmed candidate is kept as a claim on the base
// product (so the next question starts from it) and is never filed as a product, never called fake. Pure: the Database, the evidence check and the clock are passed in.
import type { VariantVerdict } from "./variantEvidence.js";

/** Candidates examined per typed phrase (each one costs an evidence check, a search ladder). */
export const FANOUT_CAP_PER_PHRASE = 3;
/** Least time between the starts of two candidates. */
export const FANOUT_GAP_MS = 1500;
/** Candidates being checked / researched at the same time. */
export const FANOUT_CONCURRENCY = 2;

export interface FanoutDeps {
  /** True when the Database already has a product with this name. */
  alreadyTracked(name: string): boolean;
  /** The evidence check for one candidate (sources), as the typed-phrase path uses. */
  verify(name: string): Promise<VariantVerdict>;
  /** Files the confirmed variant under its base product and starts its research. */
  create(name: string, verdict: VariantVerdict): Promise<void>;
  /** Keeps an unconfirmed claim on the base product. */
  rememberClaim(verdict: VariantVerdict): void;
  /** The AI is paused or unavailable: stop everything. */
  paused(): boolean;
  sleep(ms: number): Promise<void>;
  now?(): number;
  note?(message: string): void;
}

export interface FanoutResult {
  created: string[];
  unverified: string[];
  skipped: string[];
  /** Why the run stopped early, if it did. */
  stopped: string | null;
}

/**
 * Whether a model-suggested name reads like a product name and not a text fragment (Beta 28 live test: "Xbox (modern Console & common Bundle" was filed as a product). Brackets must be
 * balanced, it must not end on a connector or open a bracket, and it must be a sensible length with no markup.
 */
export function isPlausibleProductName(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < 3 || n.length > 110) return false;
  if (/[<>{}\\|]/.test(n) || /https?:/i.test(n)) return false;
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"]];
  for (const [open, close] of pairs) if (n.split(open).length !== n.split(close).length) return false;
  if (/[&+,/:;-]\s*$/.test(n) || /\b(?:and|or|with|for|the|of|a|an)\s*$/i.test(n)) return false;
  if (/^[\W_]/.test(n)) return false;
  return /[a-z]/i.test(n);
}

export function isConfirmed(v: VariantVerdict): boolean {
  return v.status === "verified" || v.status === "supported";
}

export async function runVariantFanout(
  candidates: string[],
  deps: FanoutDeps,
  opts: { cap?: number; gapMs?: number; concurrency?: number } = {}
): Promise<FanoutResult> {
  const cap = opts.cap ?? FANOUT_CAP_PER_PHRASE;
  const gap = opts.gapMs ?? FANOUT_GAP_MS;
  const concurrency = Math.max(1, opts.concurrency ?? FANOUT_CONCURRENCY);
  const now = deps.now ?? (() => Date.now());
  const result: FanoutResult = { created: [], unverified: [], skipped: [], stopped: null };

  // distinct, non-empty, not already in the Database
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const raw of candidates) {
    const name = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    if (!isPlausibleProductName(name)) {
      result.skipped.push(name);
      deps.note?.(`not filed: "${name}" reads like a text fragment, not a product name`);
    } else if (deps.alreadyTracked(name)) result.skipped.push(name);
    else queue.push(name);
  }
  if (queue.length > cap) {
    result.skipped.push(...queue.slice(cap));
    queue.length = cap;
  }

  let next = 0;
  let lastStart = 0;
  const worker = async (): Promise<void> => {
    while (!result.stopped && next < queue.length) {
      const name = queue[next++];
      if (deps.paused()) {
        result.stopped = "the AI is paused";
        result.skipped.push(name);
        return;
      }
      const wait = lastStart + gap - now();
      lastStart = Math.max(now(), lastStart + gap); // reserve this start before waiting so two workers never start together
      if (wait > 0) await deps.sleep(wait);
      try {
        const verdict = await deps.verify(name);
        if (isConfirmed(verdict)) {
          await deps.create(name, verdict);
          result.created.push(name);
        } else {
          deps.rememberClaim(verdict);
          result.unverified.push(name);
        }
      } catch (err) {
        result.skipped.push(name);
        deps.note?.(`I could not check "${name}" (${(err as Error).message}); left it out.`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}
