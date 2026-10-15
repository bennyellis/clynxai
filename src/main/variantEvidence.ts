// Evidence for "does this product / variant really exist?". Pure planning and judging; the network calls are injected so it can be tested alone.
//
// Three different answers, never mixed up:
//   verified   a manufacturer page (or two independent press / retailer sources) names the variant's distinguishing words
//   unverified something names it, but only sellers / marketplaces / unknown pages, or the user reported it and nothing confirms yet
//   unknown    the searches found no page naming it. This is NOT evidence that it does not exist
//   disproven  a manufacturer page about the product line explicitly says it does not exist / was never released
import { requiredVariantTokens, tokenize } from "./variants.js";

export type EvidenceStatus = "verified" | "unverified" | "unknown" | "disproven";
export type SourceKind = "manufacturer" | "retailer" | "press" | "marketplace" | "other";

export interface EvidenceSource {
  title: string;
  url: string;
  excerpt: string;
}

export interface JudgedSource extends EvidenceSource {
  kind: SourceKind;
  host: string;
  namesVariant: boolean;
}

export interface VariantEvidence {
  status: EvidenceStatus;
  /** Plain-language reasons, safe to show to the user and to hand to the chat model. */
  reasons: string[];
  required: string[];
  sources: JudgedSource[];
  queriesTried: string[];
  basis: "manufacturer" | "corroborated" | "listing-only" | "user-report" | "none" | "contradicted";
}

// ------------------------------------------------------------------------------------------------------------------ hosts
const MARKETPLACE = new Set("ebay facebook mercari offerup craigslist poshmark aliexpress temu etsy wish alibaba shopgoodwill depop vinted gumtree kijiji".split(" "));
// Large retailers: a page there is real, but on marketplaces-in-a-retailer (Walmart, Amazon) it may be a third-party seller's wording, so a retailer
// page corroborates but does not verify on its own.
const RETAILER = new Set("walmart amazon target bestbuy newegg gamestop costco bhphotovideo microcenter homedepot lowes adorama".split(" "));
const PRESS = new Set(
  (
    "wikipedia wikidata gsmarena rtings theverge ign engadget techradar pcmag cnet tomsguide windowscentral polygon gamespot kotaku " +
    "pushsquare nintendolife eurogamer arstechnica wired tomshardware notebookcheck 9to5mac 9to5google macrumors androidcentral"
  ).split(" ")
);

// Parent companies / product lines whose official site does not carry the product's own first word. A small alias table, not a catalogue:
// a name's first word is also tried as the brand, so unlisted brands still work when their domain is their name.
const BRAND_DOMAINS: Record<string, string[]> = {
  xbox: ["xbox", "microsoft"],
  surface: ["microsoft"],
  windows: ["microsoft"],
  playstation: ["playstation", "sony"],
  ps5: ["playstation"],
  ps4: ["playstation"],
  iphone: ["apple"],
  ipad: ["apple"],
  macbook: ["apple"],
  imac: ["apple"],
  airpods: ["apple"],
  galaxy: ["samsung"],
  pixel: ["google", "store"],
  switch: ["nintendo"],
  kindle: ["amazon"],
  echo: ["amazon"],
  quest: ["meta", "oculus"],
  steam: ["steampowered", "valvesoftware"],
  thinkpad: ["lenovo"],
  rog: ["asus"],
  geforce: ["nvidia"],
  rtx: ["nvidia"],
  radeon: ["amd"],
  ryzen: ["amd"],
  eos: ["canon"],
  gopro: ["gopro"],
  roomba: ["irobot"],
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The registrable label of a host: "support.xbox.com" -> "xbox", "xbox.co.uk" -> "xbox". */
function hostLabel(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return host;
  const twoLevel = new Set(["co", "com", "org", "net", "gov", "ac"]);
  return twoLevel.has(parts[parts.length - 2]) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
}

/** Candidate brand labels for a product: the aliases of any of its words, plus its first word (the brand, when its site is named after it). */
export function brandLabels(name: string, extraHints: string[] = []): string[] {
  const toks = tokenize(name);
  const labels = new Set<string>();
  if (toks[0] && toks[0].length >= 3) labels.add(toks[0]);
  for (const t of toks) for (const d of BRAND_DOMAINS[t] ?? []) labels.add(d);
  for (const h of extraHints) for (const t of tokenize(h)) if (t.length >= 3) labels.add(t);
  return [...labels];
}

export function classifySource(url: string, brands: string[]): SourceKind {
  const host = hostOf(url);
  if (!host) return "other";
  const label = hostLabel(host);
  if (MARKETPLACE.has(label)) return "marketplace";
  // the brand's own site first: Amazon is the manufacturer of a Kindle (the product's brand maps to it), a mere retailer for anything else
  if (brands.includes(label)) return "manufacturer";
  if (RETAILER.has(label)) return "retailer";
  if (PRESS.has(label)) return "press";
  return "other";
}

// ------------------------------------------------------------------------------------------------------------------ query plan
export interface QueryPlanInput {
  name: string;
  parentName?: string | null;
  brandHints?: string[];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of list.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const key = q.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(q);
    }
  }
  return out;
}

/**
 * Searches to try, most informative first. An exact-title search that returns nothing never ends the research: the parent product, the
 * manufacturer's own site, the distinguishing words on their own and alternate wordings are all tried.
 */
export function buildQueryPlan(input: QueryPlanInput & { required?: string[] }): string[] {
  const { name, parentName = null, brandHints = [] } = input;
  const required = input.required ?? requiredVariantTokens(name, parentName);
  const brands = brandLabels(name, brandHints);
  const parent = parentName ?? "";
  const distinct = required.join(" ");
  const queries: string[] = [name];
  // manufacturer first: its own site by name (when the brand's domain is known or guessable), then "official"
  for (const b of brands.slice(0, 2)) queries.push(`site:${b}.com ${distinct || name}`);
  if (parent) {
    queries.push(`${parent} ${distinct} official`);
    queries.push(`${parent} models editions official`);
  } else {
    queries.push(`${name} official manufacturer`);
  }
  // alternate wording: capacities written both ways, marketing noise dropped
  const noNoise = name.replace(/\b(bundle|disc drive|console|brand new|sealed)\b/gi, " ");
  queries.push(noNoise.replace(/(\d)\s*(tb|gb)\b/gi, "$1 $2"));
  queries.push(noNoise.replace(/(\d)\s+(tb|gb)\b/gi, "$1$2"));
  if (distinct) queries.push(`${brands[0] ?? ""} ${distinct}`);
  return dedupe(queries).slice(0, 7);
}

// ------------------------------------------------------------------------------------------------------------------ judging
const NEGATION = /\b(no such|does not exist|doesn'?t exist|never (?:been )?(?:released|made|sold|offered|announced)|not an? official|is not available|isn'?t available|was never|fake|counterfeit)\b/i;

function namesAll(source: EvidenceSource, required: string[]): boolean {
  if (required.length === 0) return false;
  const have = new Set(tokenize(`${source.title} ${source.excerpt}`));
  return required.every((t) => have.has(t));
}

function negatesNear(source: EvidenceSource, required: string[]): string | null {
  const raw = `${source.title} ${source.excerpt}`;
  for (const m of raw.matchAll(new RegExp(NEGATION.source, "gi"))) {
    const at = m.index ?? 0;
    const window = tokenize(raw.slice(Math.max(0, at - 150), at + 150));
    if (required.length > 0 && required.every((t) => window.includes(t))) return raw.slice(Math.max(0, at - 60), at + 100).trim();
  }
  return null;
}

export interface AssessInput {
  name: string;
  parentName?: string | null;
  sources: EvidenceSource[];
  queriesTried?: string[];
  brandHints?: string[];
  /** The user supplied this product name / link themselves. It is a lead, not proof, and it is never ignored. */
  userReported?: boolean;
  /** When the caller already knows which words distinguish the variant (otherwise derived from name vs parentName). */
  required?: string[];
}

export function assessVariantEvidence(input: AssessInput): VariantEvidence {
  const required = input.required ?? requiredVariantTokens(input.name, input.parentName ?? null);
  const brands = brandLabels(input.name, input.brandHints);
  const judged: JudgedSource[] = input.sources
    .map((s) => ({ ...s, kind: classifySource(s.url, brands), host: hostOf(s.url), namesVariant: namesAll(s, required) }))
    .sort((a, b) => rank(a.kind) - rank(b.kind));
  const queriesTried = input.queriesTried ?? [];
  const base = { required, sources: judged, queriesTried };

  // disproven: only a manufacturer page about the line, explicitly negating the variant's own words
  for (const s of judged) {
    if (s.kind !== "manufacturer") continue;
    const quote = negatesNear(s, required);
    if (quote) return { ...base, status: "disproven", basis: "contradicted", reasons: [`${s.host} says: "${quote}"`] };
  }

  const naming = judged.filter((s) => s.namesVariant);
  const manufacturer = naming.find((s) => s.kind === "manufacturer");
  if (manufacturer) return { ...base, status: "verified", basis: "manufacturer", reasons: [`The manufacturer's own site (${manufacturer.host}) names it: ${manufacturer.url}`] };

  const independent = new Set(naming.filter((s) => s.kind === "retailer" || s.kind === "press").map((s) => s.host));
  if (independent.size >= 2) return { ...base, status: "verified", basis: "corroborated", reasons: [`Independent sources name it: ${[...independent].join(", ")}.`] };

  if (naming.length > 0) {
    const kinds = [...new Set(naming.map((s) => s.kind === "marketplace" ? "marketplace listings" : s.kind === "retailer" ? "a retailer page" : s.kind === "press" ? "a press page" : "pages of unknown origin"))];
    return {
      ...base,
      status: "unverified",
      basis: "listing-only",
      reasons: [`Only ${kinds.join(" and ")} name it; no manufacturer page confirms it yet. A listing's title is a seller's wording, so this is a lead, not proof.`],
    };
  }

  if (input.userReported) {
    return {
      ...base,
      status: "unverified",
      basis: "user-report",
      reasons: [`You gave me this name${required.length ? ` ("${required.join(" ")}")` : ""}, but ${judged.length ? "none of the pages I read" : "my searches"} confirmed it yet. That is not evidence against it.`],
    };
  }

  return {
    ...base,
    status: "unknown",
    basis: "none",
    reasons: [`${queriesTried.length || "My"} search${queriesTried.length === 1 ? "" : "es"} found no page naming it. That only means I have not found it, it does not show it does not exist.`],
  };
}

function rank(k: SourceKind): number {
  return k === "manufacturer" ? 0 : k === "press" ? 1 : k === "retailer" ? 2 : k === "other" ? 3 : 4;
}

// ------------------------------------------------------------------------------------------------------------------ the search loop
export interface SearchDeps {
  search(query: string, max: number): Promise<Array<{ title: string; url: string; snippet: string }>>;
  /** Page text, or null when it could not be read. */
  fetchPage(url: string): Promise<string | null>;
}

export interface GatherResult {
  sources: EvidenceSource[];
  evidence: VariantEvidence;
  queriesTried: string[];
}

/** Runs the query plan until the question is settled (verified / disproven) or the budget is spent, merging every source found. */
export async function gatherEvidence(input: QueryPlanInput & { userReported?: boolean; extraSources?: EvidenceSource[]; maxQueries?: number; pagesPerQuery?: number; required?: string[] }, deps: SearchDeps): Promise<GatherResult> {
  const plan = buildQueryPlan(input);
  const maxQueries = input.maxQueries ?? 4;
  const pagesPerQuery = input.pagesPerQuery ?? 4;
  const sources: EvidenceSource[] = [...(input.extraSources ?? [])];
  const seen = new Set(sources.map((s) => s.url));
  const tried: string[] = [];
  const assess = () => assessVariantEvidence({ name: input.name, parentName: input.parentName, sources, queriesTried: tried, brandHints: input.brandHints, userReported: input.userReported, required: input.required });
  let evidence = assess();
  for (const q of plan) {
    if (tried.length >= maxQueries) break;
    if ((evidence.status === "verified" || evidence.status === "disproven") && tried.length > 0) break;
    tried.push(q);
    let results: Array<{ title: string; url: string; snippet: string }> = [];
    try {
      results = await deps.search(q, 6);
    } catch {
      continue; // one failed search does not end the research
    }
    const fresh = results.filter((r) => r.url && !seen.has(r.url)).slice(0, pagesPerQuery);
    const pages = await Promise.all(
      fresh.map(async (r) => {
        const text = await deps.fetchPage(r.url).catch(() => null);
        return { title: r.title, url: r.url, excerpt: text && text.length > r.snippet.length ? text : r.snippet };
      })
    );
    for (const p of pages) {
      seen.add(p.url);
      if (p.excerpt.trim()) sources.push(p);
    }
    evidence = assess();
  }
  return { sources, evidence, queriesTried: tried };
}

// ------------------------------------------------------------------------------------------------------------------ wording
const STATUS_LABEL: Record<EvidenceStatus, string> = {
  verified: "VERIFIED",
  unverified: "UNVERIFIED",
  unknown: "UNKNOWN (not found)",
  disproven: "DISPROVEN",
};

const STATUS_RULE: Record<EvidenceStatus, string> = {
  verified: "Treat it as a real product and say where the evidence came from.",
  unverified: "Say it is unconfirmed and why. Do not call it fake and do not call it official. Say what proof would settle it.",
  unknown: "Say you could not find it yet. Never say it does not exist, is fake, or is made up because a search came back empty.",
  disproven: "Say the manufacturer's own page contradicts it, quoting the evidence.",
};

/** The block handed to the chat model so its answer follows the evidence instead of an exact-search miss. */
export function describeEvidence(ev: VariantEvidence): string {
  const lines = [`Variant evidence: ${STATUS_LABEL[ev.status]}.`, ...ev.reasons, `How to answer: ${STATUS_RULE[ev.status]}`];
  if (ev.queriesTried.length) lines.push(`Searches tried (${ev.queriesTried.length}): ${ev.queriesTried.map((q) => `"${q}"`).join("; ")}`);
  const named = ev.sources.filter((s) => s.namesVariant).slice(0, 4);
  if (named.length) lines.push(`Pages naming it: ${named.map((s) => `${s.host} (${s.kind})`).join(", ")}`);
  return lines.join("\n");
}

/** One-line status stored at the top of a product's write-up. */
export function evidenceHeadline(ev: VariantEvidence): string {
  return `Variant status: ${STATUS_LABEL[ev.status]}. ${ev.reasons[0] ?? ""}`.trim();
}

/** Whether a researched variant may be kept in the Database. Unknown and disproven ones are not filed. */
export function mayFileVariant(ev: VariantEvidence): boolean {
  return ev.status === "verified" || ev.status === "unverified";
}

// ------------------------------------------------------------------------------------------------------------------ session ledger
// Findings from earlier turns, so a later turn does not contradict them without new evidence. Kept in memory only: the Database holds the
// research itself, this only carries "what did the evidence say" across chat turns.
export interface LedgerEntry {
  name: string;
  status: EvidenceStatus;
  headline: string;
  at: number;
}

const LEDGER_TTL_MS = 3 * 60 * 60 * 1000;
const LEDGER_MAX = 12;

export class EvidenceLedger {
  private entries = new Map<string, LedgerEntry>();

  private key(name: string): string {
    return tokenize(name).sort().join(" ");
  }

  record(name: string, ev: VariantEvidence, now = Date.now()): void {
    const k = this.key(name);
    const prev = this.entries.get(k);
    // new evidence may upgrade a status; an empty search never downgrades a verified one
    if (prev && prev.status === "verified" && ev.status !== "verified" && ev.status !== "disproven") return;
    this.entries.set(k, { name, status: ev.status, headline: evidenceHeadline(ev), at: now });
    if (this.entries.size > LEDGER_MAX) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
  }

  list(now = Date.now()): LedgerEntry[] {
    return [...this.entries.values()].filter((e) => now - e.at < LEDGER_TTL_MS).sort((a, b) => b.at - a.at);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Text for the system prompt; empty when there is nothing to carry over. */
  render(now = Date.now()): string {
    const items = this.list(now);
    if (items.length === 0) return "";
    return (
      "\n\nFINDINGS FROM EARLIER IN THIS CONVERSATION (established by real searches; do not contradict them without new evidence, and if new evidence changes one, say what changed):\n" +
      items.map((e) => `- ${e.name}: ${e.headline}`).join("\n")
    );
  }
}

export const evidenceLedger = new EvidenceLedger();

// ------------------------------------------------------------------------------------------------------------------ tool results
export interface ResearchOutcomeInput {
  requested: string;
  /** The Database entry the research was filed under, as it is now. */
  saved: { name: string; aiSummary: string; loading: boolean } | null;
  state: "finished" | "still-running" | "discarded";
  evidence?: VariantEvidence | null;
  parentName?: string | null;
}

/**
 * What the chat is told after research_product. "Saved" is only said when the entry exists, is finished loading and holds a real write-up;
 * a failed or unfinished lookup comes back as a failure or a "not saved yet", so the chat cannot claim data that is not in the Database.
 * (A result starting "Failed:" is also how the chat knows not to ask about resale history.)
 */
export function describeResearchOutcome(o: ResearchOutcomeInput): string {
  const ev = o.evidence ? `\n${describeEvidence(o.evidence)}` : "";
  if (o.state === "discarded") {
    return `Not saved: I did not file "${o.requested}" in the Database because the evidence does not support it as a product.${ev}\nTell the user exactly that, and what would help (the manufacturer's page, a box photo, a SKU).`;
  }
  if (!o.saved) return `Failed: "${o.requested}" is not in the Database (nothing was saved).${ev}`;
  const failed = /^\(Research failed/i.test(o.saved.aiSummary.trim());
  if (failed) return `Failed: research on "${o.requested}" did not complete (${o.saved.aiSummary.trim().slice(0, 160)}). Nothing useful was saved.${ev}`;
  if (o.state === "still-running" || o.saved.loading || !o.saved.aiSummary.trim()) {
    return `Research on "${o.requested}" is still running and is NOT saved yet. Do not tell the user it is saved; say it is still being looked into and will show on the Database tab when it finishes.${ev}`;
  }
  const where = o.parentName ? ` as a variant of "${o.parentName}" (kept separate from it: its own write-up and its own price comps)` : "";
  return `Saved "${o.saved.name}" to the Database${where}.${ev}`;
}
