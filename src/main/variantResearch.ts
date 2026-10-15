// What to do when someone asks Clynx to research a product that may be a more specific version of one the Database already tracks ("Xbox Series X 2TB
// Galaxy Black Special Edition" when "Xbox Series X" is on file). The old behavior folded any such request into the general entry: its profile was
// rewritten to talk about the variant, its standard-model sold prices were shown for the variant, and a name that could not be confirmed was filed anyway.
//
// Now: a product that is a variant is checked against evidence FIRST, and only then recorded, as its own entry linked to the parent. A claim that
// could not be confirmed is NOT recorded as a product (and is never called fake): the answer says what was and was not found, and the claim is kept
// on the parent so the next turn starts from it. All decisions here are pure; the search and the Database are passed in.

import { reconcileVerdict, type VariantVerdict } from "./variantEvidence.js";
import { findParentCandidate, identityTokens, isMoreSpecific } from "./variantIdentity.js";

export interface TrackedProduct {
  id: string;
  name: string;
}

export type ResearchDecision =
  /** Same product as one on file: refresh it. */
  | { kind: "refresh_existing"; existing: TrackedProduct }
  /** A confirmed variant of a tracked product: create it under the parent, with the evidence. */
  | { kind: "create_variant"; parent: TrackedProduct; verdict: VariantVerdict }
  /** Not a variant of anything tracked: an ordinary new product. */
  | { kind: "create_product" }
  /** A variant claim that could not be confirmed: record nothing as a product; tell the user exactly where it stands. */
  | { kind: "not_recorded"; parent: TrackedProduct; verdict: VariantVerdict; message: string };

export interface DecideDeps {
  /** The existing entry the name already resolves to (exact or fuzzy), if any. */
  findMatching(name: string): TrackedProduct | null;
  /** Every tracked product name (to find a parent among). */
  listTracked(): TrackedProduct[];
  /** The evidence check for a variant claim (cached/reconciled by the caller). */
  verify(name: string, parent: TrackedProduct): Promise<VariantVerdict>;
}

function sameProduct(a: string, b: string): boolean {
  const x = new Set(identityTokens(a));
  const y = new Set(identityTokens(b));
  return x.size === y.size && [...x].every((t) => y.has(t));
}

export async function decideResearchTarget(product: string, deps: DecideDeps): Promise<ResearchDecision> {
  const matched = deps.findMatching(product);
  // Asking again for the same thing, or for a plainer name than the entry's ("Xbox Series X" when the entry is "Xbox Series X Console"), is a refresh.
  if (matched && (sameProduct(product, matched.name) || !isMoreSpecific(product, matched.name))) return { kind: "refresh_existing", existing: matched };

  const parent = findParentCandidate(product, deps.listTracked());
  if (!parent || !isMoreSpecific(product, parent.name)) {
    // A fuzzy match that is a general entry of a more specific request is still a parent claim (an existing "Xbox Series X" for "Xbox Series X Galaxy").
    if (matched && isMoreSpecific(product, matched.name)) return decideForParent(product, matched, deps);
    return { kind: "create_product" };
  }
  return decideForParent(product, parent, deps);
}

async function decideForParent(product: string, parent: TrackedProduct, deps: DecideDeps): Promise<ResearchDecision> {
  const verdict = await deps.verify(product, parent);
  if (verdict.status === "verified" || verdict.status === "supported") return { kind: "create_variant", parent, verdict };
  return { kind: "not_recorded", parent, verdict, message: notRecordedMessage(product, parent, verdict) };
}

/** A short, factual account of what the evidence check actually did (not what it intended to do). */
export function traceSummary(v: VariantVerdict): string {
  const d = v.diagnostics;
  if (!d) return v.searched.length ? `${v.searched.length} searches were tried.` : "";
  const ok = d.searches.filter((x) => x.outcome === "ok").length;
  const empty = d.searches.filter((x) => x.outcome === "empty").length;
  const blocked = d.searches.filter((x) => x.outcome === "blocked").length;
  const failed = d.searches.filter((x) => x.outcome === "error").length;
  const read = d.pages.filter((p) => p.chars > 0).length;
  const pageFails = d.pages.filter((p) => p.chars === 0).length;
  const parts = [`${d.searches.length} search attempts (${ok} returned results, ${empty} returned nothing, ${blocked} were blocked, ${failed} failed)`, `${read} pages read${pageFails ? `, ${pageFails} could not be read` : ""}`];
  return `What actually happened: ${parts.join("; ")}.`;
}

export function notRecordedMessage(product: string, parent: TrackedProduct, v: VariantVerdict): string {
  const facts: string[] = [traceSummary(v)];
  if (v.searchUnavailable) facts.push("The web search itself was blocked or failed, so this is a failed lookup, not a finding: tell the user the lookup failed and offer to retry (do not say you searched and found nothing).");
  if (v.searchLinks?.length) facts.push(`The link the user gave is a search-results page (query "${v.searchLinks[0].query}"), not a product page. You did NOT read it as a page; say that, and that its query was used as a search.`);
  if (v.unreadableUrls?.length) facts.push(`Could not read: ${v.unreadableUrls.join(", ")}. Do NOT claim you opened or read ${v.unreadableUrls.length === 1 ? "it" : "them"}; ask for the product page's exact title or a screenshot.`);
  const detail = facts.filter(Boolean).join(" ");
  if (v.status === "disproven") {
    return `NOT SAVED. "${product}" was not added to the Database. ${v.basis} Tell the user that source says it is not an official product, name the source, and invite proof to the contrary (a product link, a photo of the box label). "${parent.name}" is unchanged. ${detail}`.trim();
  }
  return `NOT SAVED. I could not confirm "${product}" yet, so I did NOT add it to the Database and "${parent.name}" is unchanged. ${v.basis} ${detail} This is "unverified", NOT "fake": do not tell the user it is fake, seller-invented or non-existent, and do not describe searches that did not happen. Ask for a link to the product page (a link is read as soon as it is given) or a photo of the box/label, and offer to look again.`.replace(/\s+/g, " ").trim();
}

export function createdVariantMessage(product: string, parent: TrackedProduct, v: VariantVerdict): string {
  const named = v.officialName && v.officialName.toLowerCase() !== product.toLowerCase() ? ` The source calls it "${v.officialName}".` : "";
  return `VERIFIED: ${v.status} (${v.basis})${named} Added "${product}" to the Database as its own entry under "${parent.name}" and started researching it. It is not saved until that research finishes: say it is being researched, not that it is saved. Its value comes only from sales of this exact version; if there are none yet it will show as not enough evidence, never the standard model's price.`;
}

/** Addresses in the user's message that Clynx may read: http(s) only, and nothing that points back at this computer or a private network. */
export function publicHttpUrls(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    if (isPublicHttpUrl(raw) && !out.includes(raw)) out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:") || host === "::") return false;
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  } else if (!host.includes(".")) return false;
  return true;
}

export interface VerdictMemory {
  get(claim: string): VariantVerdict | null;
  set(claim: string, verdict: VariantVerdict): void;
}

/** A plain in-memory map, keyed by the claim's words (case, spacing and punctuation do not matter). */
export function createVerdictMemory(): VerdictMemory {
  const map = new Map<string, VariantVerdict>();
  const key = (claim: string) => identityTokens(claim).join(" ");
  return { get: (c) => map.get(key(c)) ?? null, set: (c, v) => void map.set(key(c), v) };
}

/** An unchanged "unverified" answer is not looked up again for this long unless the user brings something new (a link). */
const RECHECK_UNVERIFIED_AFTER_MS = 10 * 60_000;

/**
 * The evidence check as the research flow uses it: what was found earlier in this conversation (memory) or saved with the Database
 * (`persisted`) is reused instead of contradicted or repeated, a new look only ever adds to it (reconcileVerdict), and a link from the user
 * always triggers a new look because it is new evidence.
 */
export function makeClaimVerifier(opts: {
  memory: VerdictMemory;
  persisted(claim: string, parent: TrackedProduct): VariantVerdict | null;
  check(claim: string, parent: TrackedProduct, userUrls: string[]): Promise<VariantVerdict>;
  now?: () => number;
}): (claim: string, parent: TrackedProduct, userUrls?: string[]) => Promise<VariantVerdict> {
  const now = opts.now ?? (() => Date.now());
  return async (claim, parent, userUrls = []) => {
    const earlier = opts.memory.get(claim) ?? opts.persisted(claim, parent);
    if (earlier && userUrls.length === 0) {
      if (earlier.status === "verified" || earlier.status === "supported" || earlier.status === "disproven") return earlier;
      if (now() - earlier.checkedAt < RECHECK_UNVERIFIED_AFTER_MS) return earlier;
    }
    const fresh = await opts.check(claim, parent, userUrls);
    const merged = reconcileVerdict(earlier, fresh);
    opts.memory.set(claim, merged);
    return merged;
  };
}
