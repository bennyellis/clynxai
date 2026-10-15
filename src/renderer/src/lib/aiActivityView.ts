// Words and numbers for the AI Activity section (pure; no React, no IPC). Takes the registry snapshot main/apiActivity.ts produces.
import type { AiDecision, ApiEvent, Outcome, ProviderStats, Provider } from "../../../main/apiActivity.js";

export const PROVIDER_LABEL: Record<Provider, string> = { openai: "OpenAI", ebay: "eBay (asking prices)", watchcount: "WatchCount (sold prices)" };

export function outcomeLabel(o: Outcome): string {
  switch (o) {
    case "live_ok": return "Live request: worked";
    case "live_failed": return "Live request: failed";
    case "cached": return "Reused a recent answer";
    case "local_db": return "Answered from the Database (no lookup)";
    case "skipped_budget": return "Skipped: allowance or limit";
    case "skipped_unneeded": return "Skipped: not needed";
    case "skipped_disabled": return "Skipped: turned off or no access";
  }
}

export function outcomeTone(o: Outcome): "good" | "bad" | "neutral" | "warn" {
  return o === "live_ok" ? "good" : o === "live_failed" ? "bad" : o === "skipped_budget" || o === "skipped_disabled" ? "warn" : "neutral";
}

export function routeLabel(r: string | undefined): string {
  switch (r) {
    case "own_key": return "your own key";
    case "clynx_cloud": return "Clynx Cloud";
    case "ebay_direct": return "eBay (this computer's keys)";
    case "browser": return "browser page";
    default: return "—";
  }
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatCost(usd: number, complete: boolean): string {
  const v = usd < 0.01 && usd > 0 ? "< $0.01" : `$${usd.toFixed(2)}`;
  return complete ? `~${v}` : `at least ~${v}`;
}

export function ago(ts: number | null, now: number): string {
  if (ts === null) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** What a failure most likely means and what to do, from its status and text. Null when nothing specific is known. */
export function failureHint(e: Pick<ApiEvent, "provider" | "status" | "error">): string | null {
  const text = `${e.error ?? ""}`.toLowerCase();
  if (/insufficient_quota|credits are used up/.test(text)) return "The OpenAI account has no credit left. Add credit, or switch to Clynx Cloud's shared AI.";
  if (e.status === 401 || /unauthorized|invalid.*key|incorrect api key|token request failed: 4/.test(text)) return e.provider === "ebay" ? "eBay rejected the keys. Check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET (production keys, not sandbox)." : "OpenAI rejected the key. Check the key saved on this computer, or sign in to Clynx Cloud.";
  if (e.status === 403) return "The key is valid but not allowed to do this (wrong project, model not enabled, or a missing eBay permission).";
  if (e.status === 429) return e.provider === "ebay" ? "eBay's rate limit was reached. It clears by itself; fewer lookups will avoid it." : "A rate limit was reached. It clears by itself.";
  if (/timed out|timeout|aborted/.test(text)) return "The request took too long. Usually a slow connection; it is retried by the next research pass.";
  if (e.status !== null && e.status !== undefined && e.status >= 500) return "The service had a problem on its side. Nothing to fix here.";
  if (/no eBay keys|no openai access|not set/.test(text)) return "No keys on this computer. That is expected when Clynx Cloud's shared service is used.";
  return null;
}

export interface ProviderSummary {
  provider: Provider;
  headline: string;
  lines: string[];
  skipped: { budget: number; unneeded: number; disabled: number };
}

export function summarizeProvider(provider: Provider, s: ProviderStats, now: number): ProviderSummary {
  const lines: string[] = [];
  if (provider === "openai") {
    lines.push(`Live requests: ${s.attempted} (${s.ok} worked, ${s.failed} failed)`);
    if (s.tokens.requestsWithTokens || s.tokens.requestsWithoutTokens) {
      lines.push(`Tokens reported: ${formatTokens(s.tokens.input)} in, ${formatTokens(s.tokens.output)} out (${formatTokens(s.tokens.total)} total) across ${s.tokens.requestsWithTokens} request${s.tokens.requestsWithTokens === 1 ? "" : "s"}`);
      if (s.tokens.requestsWithoutTokens) lines.push(`${s.tokens.requestsWithoutTokens} request${s.tokens.requestsWithoutTokens === 1 ? "" : "s"} reported no token counts (streamed answers and image requests do not)`);
      lines.push(`Estimated cost: ${formatCost(s.costUsdEst, s.costUsdEstComplete)} (an estimate from list prices)`);
    }
    const models = Object.entries(s.models).map(([m, n]) => `${m} x${n}`).join(", ");
    if (models) lines.push(`Model: ${models}`);
  } else if (provider === "ebay") {
    lines.push(`Live requests: ${s.attempted} (${s.ok} worked, ${s.failed} failed)`);
    lines.push(`Results: ${s.results.retrieved} retrieved, ${s.results.accepted} accepted as the right product, ${s.results.rejected} rejected, ${s.results.uncertain} unsure`);
    lines.push("These are what sellers ASK today, not what anything sold for.");
  } else {
    lines.push(`Sold-price lookups: ${s.attempted} (${s.ok} worked, ${s.failed} failed)`);
    lines.push(`Results: ${s.results.retrieved} retrieved, ${s.results.accepted} accepted as the right product, ${s.results.rejected} rejected, ${s.results.uncertain} unsure`);
  }
  if (s.cached || s.localDb) lines.push(`Not looked up: ${s.localDb} answered from the Database, ${s.cached} reused a recent answer`);
  lines.push(`Last success: ${ago(s.lastSuccessAt, now)}${s.lastFailureAt !== null ? ` · last failure: ${ago(s.lastFailureAt, now)}` : ""}`);
  const routes = Object.entries(s.byRoute).map(([r, n]) => `${routeLabel(r)} x${n}`).join(", ");
  if (routes) lines.push(`Went through: ${routes}`);
  const headline = s.attempted === 0 ? (s.skippedBudget + s.skippedUnneeded + s.skippedDisabled + s.localDb + s.cached > 0 ? "No live requests yet this session (decisions were made without them)" : "Nothing yet this session") : s.failed === 0 ? "Working" : s.ok === 0 ? "Every request failed" : "Some requests failed";
  return { provider, headline, lines, skipped: { budget: s.skippedBudget, unneeded: s.skippedUnneeded, disabled: s.skippedDisabled } };
}

/** A decision's verdict as a tone for its chip. */
export function verdictTone(d: Pick<AiDecision, "verdict">): "good" | "bad" | "neutral" {
  const v = d.verdict.toLowerCase();
  if (/(^|\s)(not|no|mismatch|rejected|failed|does not)/.test(v)) return "bad";
  if (/(match|identified|possible deal|looks like|kept|attach|new)/.test(v)) return "good";
  return "neutral";
}

export function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    photo_analysis: "Looked at a listing's photos",
    reference_photo_check: "Checked a reference photo",
    thumbnail_check: "Checked a thumbnail",
    reference_match: "Compared a photo with the product",
    listing_judgement: "Judged a listing from its text",
    comparable_check: "Checked comparable sales",
    product_identity: "Decided which product it is",
  };
  return map[kind] ?? kind.replace(/_/g, " ");
}
