// Does a product (usually a variant: an edition, a capacity, a color, a bundle) really exist? Decided from what sources actually say, never from
// a search coming back empty. Four outcomes, kept apart on purpose:
//   verified    the manufacturer's own page names it, or two independent non-marketplace sources do
//   supported   one retailer / reference source names it (not proof it is official, but real evidence it exists)
//   unverified  nothing found, or only seller listings, or a source with part of the name: says NOTHING about whether it exists
//   disproven   an authoritative source says this exact product is fake / unofficial / was never made
// "Unverified" is the honest answer to "the search found nothing". Only "disproven" may be called false, and it takes a source saying so.
//
// Pure apart from `verifyVariant`, whose network access (search, page fetch) is injected, so the whole thing is testable offline.

import { buildSearchPlan, identityTokens, nameTokens, normalizeName } from "./variantIdentity.js";
import { queryFromSearchUrl } from "./searchLinks.js";

export type SourceClass = "manufacturer" | "retailer" | "reference" | "marketplace" | "other";
export type VariantStatus = "verified" | "supported" | "unverified" | "disproven";

export interface EvidenceInput {
  title: string;
  url: string;
  excerpt: string;
}

export interface EvidenceSource {
  title: string;
  url: string;
  host: string;
  sourceClass: SourceClass;
  /** Every identifying word of the claimed name that this source also says. */
  matched: string[];
  missing: string[];
  fullMatch: boolean;
  /** The source says the matching product is fake / unofficial / never made. */
  negative: boolean;
  /** The words are all on the page but not near each other (a console and a game listed side by side): not a match. */
  scattered?: boolean;
  /** What the source itself calls the product, when it names it in full. */
  officialName?: string;
  /** What the source said (kept in memory for the writeup; never stored with the product). */
  excerpt?: string;
}

/** What was asked of the web and what came back: the evidence behind "unverified", so a failed look is shown as failed and not as "nothing exists". */
export interface SearchTrace {
  query: string;
  backend: string;
  outcome: "ok" | "empty" | "blocked" | "error";
  results: number;
  detail?: string;
}
export interface PageTrace {
  url: string;
  status: number | null;
  chars: number;
  via: "fetch" | "browser";
  note?: string;
}
export interface EvidenceTrace {
  searches: SearchTrace[];
  pages: PageTrace[];
}

export interface VariantVerdict {
  claim: string;
  /** The name the evidence itself uses for the product (the manufacturer's "Xbox Series X 2TB Galaxy Black Special Edition" for a claim of "Galaxy Edition"). */
  officialName?: string;
  /** Every search the web refused or failed (none returned anything): "unverified" then means "could not look", not "not found". */
  searchUnavailable?: boolean;
  /** Links the user gave that could not be read as pages (and so were not evidence). */
  unreadableUrls?: string[];
  /** Search-results links the user gave: not product pages; their query was used as a search. */
  searchLinks?: Array<{ url: string; query: string }>;
  diagnostics?: EvidenceTrace;
  status: VariantStatus;
  /** One plain sentence on why, safe to show the user. */
  basis: string;
  sources: EvidenceSource[];
  /** Words of the claim found somewhere (even in a partial match) and words never found. */
  matchedAttributes: string[];
  missingAttributes: string[];
  searched: string[];
  checkedAt: number;
}

// Company / manufacturer sites for product LINES whose own name is not the company's ("iPhone" is Apple's, "Xbox" is Microsoft's). Data, not logic: a
// line missing from here is still caught when the site's name is a word of the product's name (xbox.com for "Xbox ...").
const LINE_TO_COMPANY: Record<string, string[]> = {
  iphone: ["apple"], ipad: ["apple"], macbook: ["apple"], imac: ["apple"], airpods: ["apple"], watch: ["apple"],
  xbox: ["microsoft", "xbox"], surface: ["microsoft"], playstation: ["sony", "playstation"], ps5: ["sony", "playstation"], ps4: ["sony", "playstation"],
  switch: ["nintendo"], galaxy: ["samsung"], pixel: ["google", "store.google"], kindle: ["amazon"], echo: ["amazon"], thinkpad: ["lenovo"], rog: ["asus"],
  geforce: ["nvidia"], rtx: ["nvidia"], radeon: ["amd"], ryzen: ["amd"], quest: ["meta"], oculus: ["meta"], gopro: ["gopro"], steam: ["steampowered", "valve"],
  roomba: ["irobot"], v8: ["dyson"], airwrap: ["dyson"],
};

const RETAILERS = new Set([
  "walmart", "bestbuy", "target", "amazon", "gamestop", "newegg", "bhphotovideo", "costco", "samsclub", "homedepot", "lowes", "adorama", "microcenter",
  "staples", "officedepot", "kohls", "macys", "dell", "hp", "lenovo", "wayfair", "ikea", "walgreens", "cvs", "att", "verizon", "tmobile", "bhphoto",
]);
const REFERENCE = new Set([
  "wikipedia", "wikidata", "gsmarena", "rtings", "theverge", "ign", "cnet", "engadget", "pcmag", "techradar", "tomsguide", "tomshardware", "polygon",
  "gamespot", "kotaku", "eurogamer", "androidcentral", "9to5mac", "9to5google", "arstechnica", "wired", "forbes", "reuters", "bloomberg", "windowscentral",
  "pushsquare", "nintendolife", "purexbox", "trueachievements", "notebookcheck", "anandtech", "pcgamer", "mashable", "zdnet", "gizmodo", "androidauthority",
]);
const MARKETPLACES = new Set([
  "ebay", "facebook", "offerup", "mercari", "craigslist", "poshmark", "etsy", "aliexpress", "alibaba", "temu", "wish", "depop", "reddit", "shopify",
  "myshopify", "kijiji", "gumtree", "letgo", "ubid", "dhgate", "vinted", "reverb",
]);

const GENERIC_WORDS = new Set(["series", "pro", "max", "plus", "black", "white", "special", "console", "edition", "bundle", "game", "games", "gaming", "digital", "disc"]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The site's own name: "xbox" for www.xbox.com, "bbc" for news.bbc.co.uk. */
function siteLabel(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 1) return host;
  const tld = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (parts.length >= 3 && tld.length === 2 && ["co", "com", "org", "net", "gov", "ac"].includes(second)) return parts[parts.length - 3];
  return second;
}

/** Who a source is, as far as its address says. `brandHints` are company or manufacturer names the caller already knows for this product. */
export function classifySource(url: string, productName: string, brandHints: string[] = []): SourceClass {
  const host = hostOf(url);
  if (!host) return "other";
  const label = siteLabel(host).replace(/-/g, "");
  if (MARKETPLACES.has(label)) return "marketplace";
  // A mobile or per-country store of a marketplace ("shop.ebay.com", "m.facebook.com") is still that marketplace.
  if (host.split(".").some((p) => MARKETPLACES.has(p))) return "marketplace";
  if (REFERENCE.has(label)) return "reference";
  if (RETAILERS.has(label)) {
    // A retailer that is also the maker (dell.com selling a Dell, amazon.com selling a Kindle) is the manufacturer for that product.
    const tokens = identityTokens(productName);
    if (tokens.includes(label)) return "manufacturer";
    return "retailer";
  }
  const tokens = identityTokens(productName).filter((t) => t.length >= 3 && !GENERIC_WORDS.has(t));
  const companies = new Set<string>(brandHints.map((b) => b.toLowerCase().replace(/[^a-z0-9.]/g, "")));
  for (const t of nameTokens(productName)) for (const c of LINE_TO_COMPANY[t] ?? []) companies.add(c);
  if (tokens.includes(label) || companies.has(label) || [...companies].some((c) => host === c || host.endsWith(`.${c}`) || host.startsWith(`${c}.`))) return "manufacturer";
  return "other";
}

/** Words of the claim that must all appear for a source to count as naming this product (marketing filler is optional). */
export function claimTokens(name: string): string[] {
  const optional = new Set(["special", "edition", "console", "bundle", "new", "official", "limited"]);
  return [...new Set(identityTokens(name).filter((t) => !optional.has(t)))];
}

function hasToken(haystackTokens: Set<string>, haystackRaw: string, token: string, previous: string | null): boolean {
  // A model letter ("x" in "Series X") says nothing on its own (a page about the Series S mentions an "X" somewhere): it counts only right after the
  // word it belongs to.
  if (token.length < 2) return previous !== null && new RegExp(`(^|[^a-z0-9])${previous}\\s+${token}([^a-z0-9]|$)`).test(haystackRaw);
  return haystackTokens.has(token);
}

const NEGATIVE = /\b(not (an? )?(official|genuine|real|authentic|licensed)|unofficial|counterfeit|knock-?off|fake|hoax|scam|does(?:n'?t| not) exist|never (?:been )?(?:released|made|existed|produced|announced)|no such (?:product|edition|model|version)|not (?:a )?(?:real|actual) (?:product|edition|model|version)|custom[- ]painted|aftermarket)\b/i;

/**
 * The smallest stretch of `stream` that holds every word in `wanted` (in any order), as a token count; null when a word is missing. Used so a page that lists
 * a console in one place and a game somewhere else does not count as naming "that console, that game edition".
 */
export function tightestSpan(stream: string[], wanted: string[]): { size: number; start: number } | null {
  const uniq = [...new Set(wanted)];
  if (uniq.length === 0) return { size: 0, start: 0 };
  const need = new Map(uniq.map((t) => [t, 0]));
  let have = 0;
  let best: { size: number; start: number } | null = null;
  let left = 0;
  for (let right = 0; right < stream.length; right++) {
    const t = stream[right];
    if (need.has(t)) {
      if (need.get(t) === 0) have++;
      need.set(t, (need.get(t) ?? 0) + 1);
    }
    while (have === uniq.length) {
      const size = right - left + 1;
      if (!best || size < best.size) best = { size, start: left };
      const lt = stream[left];
      if (need.has(lt)) {
        need.set(lt, (need.get(lt) ?? 0) - 1);
        if (need.get(lt) === 0) have--;
      }
      left++;
    }
  }
  return best;
}

const EDITION_WORDS = new Set(["special", "limited", "collector", "collectors", "anniversary", "exclusive", "deluxe", "signature", "commemorative", "founders"]);

/**
 * How much a piece of page text reads like a product's NAME rather than a caption, a button or a sentence. Real pages put the claim's words in image captions
 * ("An Xbox Series X Galaxy and an adaptive joystick controller."), calls to action ("Buy Halo Infinite Xbox Series X") and prose; a product name starts with the
 * product, may carry an edition word, and is not a sentence. A name below zero is not used.
 */
export function nameScore(name: string, claim: string): number {
  const toks = identityTokens(name);
  const claimToks = identityTokens(claim);
  let score = 0;
  if (/^(?:a|an|the|buy|shop|get|new|introducing|save|order|see|view|discover|explore|play|pre-?order|learn)\b/i.test(name)) score -= 6;
  if (/\b(?:and an?|with an?|for your|your|you|our|we|is|are)\b/i.test(name)) score -= 4;
  if (/[.!?]$/.test(name)) score -= 3;
  if (toks.some((t) => EDITION_WORDS.has(t))) score += 3;
  if (toks.length && claimToks.includes(toks[0])) score += 2;
  if (name.length <= 70) score += 2;
  else if (name.length > 100) score -= 2;
  return score;
}

/** What a source calls the product: the best-reading line / sentence / tile of its text that holds every word of the claim (null when none reads like a name). */
function officialNameIn(excerpt: string, wanted: string[], claim: string): string | undefined {
  const segments = excerpt.split(/[\n\r|•·]+|(?<=[.!?])\s+/);
  let best: { text: string; score: number } | undefined;
  for (const seg of segments) {
    const cleaned = seg.replace(/[–—]/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length < 6 || cleaned.length > 140) continue;
    const toks = new Set(normalizeName(cleaned).split(/[^a-z0-9]+/).filter(Boolean));
    if (!wanted.every((t) => t.length < 2 || toks.has(t))) continue;
    const score = nameScore(cleaned, claim);
    if (!best || score > best.score || (score === best.score && cleaned.length < best.text.length)) best = { text: cleaned, score };
  }
  return best && best.score >= 0 ? best.text : undefined;
}

/** The words of one search result / page against the claim. */
export function assessSource(claim: string, input: EvidenceInput, brandHints: string[] = []): EvidenceSource {
  const wanted = claimTokens(claim);
  const host = hostOf(input.url);
  // The site's own name counts as text: a manufacturer's page says "Galaxy S24 Ultra" and leaves "Samsung" to the address.
  const hostTokens = new Set(normalizeName(host.replace(/\./g, " ")).split(/[^a-z0-9]+/).filter(Boolean));
  const body = `${input.title}\n${safeUrlPath(input.url)}\n${input.excerpt}`;
  const normBody = normalizeName(body);
  const stream = normBody.split(/[^a-z0-9]+/).filter(Boolean);
  const norm = `${normBody} ${[...hostTokens].join(" ")}`;
  const haystackTokens = new Set([...stream, ...hostTokens]);
  const order = identityTokens(claim);
  const matched = wanted.filter((t) => {
    const at = order.indexOf(t);
    return hasToken(haystackTokens, norm, t, at > 0 ? order[at - 1] : null);
  });
  const missing = wanted.filter((t) => !matched.includes(t));
  // The words have to be NEAR each other, not just somewhere on the page (words the address supplies, like the maker's name, are not part of the stretch).
  const spanWords = matched.filter((t) => t.length > 1 && !hostTokens.has(t));
  const span = tightestSpan(stream, spanWords);
  const limit = Math.max(10, spanWords.length * 2 + 6);
  const near = spanWords.length <= 1 || (!!span && span.size <= limit);
  const allPresent = wanted.length > 0 && missing.length === 0;
  const fullMatch = allPresent && near;
  let negative = false;
  if (fullMatch) {
    // The denial has to sit next to the product's own words, not elsewhere on the page.
    const anchor = wanted.filter((t) => t.length > 2).slice(-2);
    for (const m of normBody.matchAll(new RegExp(NEGATIVE.source, "gi"))) {
      const at = m.index ?? 0;
      const around = normBody.slice(Math.max(0, at - 220), at + 220);
      if (anchor.every((t) => around.includes(t))) {
        negative = true;
        break;
      }
    }
  }
  return {
    title: input.title,
    url: input.url,
    host,
    sourceClass: classifySource(input.url, claim, brandHints),
    matched,
    missing,
    fullMatch,
    negative,
    scattered: allPresent && !near,
    officialName: fullMatch ? officialNameIn(`${input.title}\n${input.excerpt}`, wanted, claim) : undefined,
    excerpt: input.excerpt.slice(0, 2500),
  };
}

function safeUrlPath(url: string): string {
  try {
    const path = new URL(url).pathname;
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // keep the raw path
    }
    return decoded.replace(/[-_/+.]+/g, " ");
  } catch {
    return "";
  }
}

const AUTHORITATIVE: SourceClass[] = ["manufacturer", "retailer", "reference"];

/** The verdict a set of sources supports. Never "disproven" for an absence of sources. */
export function assessEvidence(
  claim: string,
  inputs: EvidenceInput[],
  opts: { brandHints?: string[]; searched?: string[]; now?: number } = {}
): VariantVerdict {
  const sources = inputs.map((i) => assessSource(claim, i, opts.brandHints));
  const full = sources.filter((s) => s.fullMatch);
  const wanted = claimTokens(claim);
  const matchedAttributes = wanted.filter((t) => sources.some((s) => s.matched.includes(t)));
  const missingAttributes = wanted.filter((t) => !matchedAttributes.includes(t));
  const rank = { manufacturer: 0, retailer: 1, reference: 2, other: 3, marketplace: 4 } as const;
  const officialName = [...full]
    .filter((s) => !s.negative && s.officialName)
    .sort((a, b) => nameScore(b.officialName!, claim) + (b.sourceClass === "manufacturer" ? 1 : 0) - (nameScore(a.officialName!, claim) + (a.sourceClass === "manufacturer" ? 1 : 0)) || rank[a.sourceClass] - rank[b.sourceClass])[0]?.officialName;
  const base = { claim, officialName, sources: sources.slice(0, 12), matchedAttributes, missingAttributes, searched: opts.searched ?? [], checkedAt: opts.now ?? Date.now() };

  const positive = full.filter((s) => !s.negative);
  const authoritativePositive = positive.filter((s) => AUTHORITATIVE.includes(s.sourceClass));
  const authoritativeNegative = full.filter((s) => s.negative && AUTHORITATIVE.includes(s.sourceClass));

  if (authoritativeNegative.length > 0 && authoritativePositive.length === 0) {
    const s = authoritativeNegative[0];
    return { ...base, status: "disproven", basis: `${s.host} says this exact product is not official or does not exist.` };
  }
  const manufacturer = positive.find((s) => s.sourceClass === "manufacturer");
  if (manufacturer) return { ...base, status: "verified", basis: `The manufacturer's own site (${manufacturer.host}) lists it.` };
  const independent = new Set(authoritativePositive.map((s) => s.host));
  if (independent.size >= 2) return { ...base, status: "verified", basis: `${[...independent].slice(0, 3).join(", ")} all list it.` };
  if (authoritativePositive.length > 0) {
    const s = authoritativePositive[0];
    return { ...base, status: "supported", basis: `${s.host} lists it (${s.sourceClass === "retailer" ? "a retailer page, which may be a third-party seller" : "a reference source"}); no manufacturer page found yet.` };
  }
  if (positive.length > 0) {
    const hosts = [...new Set(positive.map((s) => s.host))].slice(0, 3).join(", ");
    return { ...base, status: "unverified", basis: `Only seller listings or unclassified pages (${hosts}) use this name. That shows sellers use the name, not that it is an official product.` };
  }
  const scattered = sources.find((s) => s.scattered && AUTHORITATIVE.includes(s.sourceClass));
  if (scattered) {
    return { ...base, status: "unverified", basis: `${scattered.host} has all the words of the name, but not together (they are in different places on the page), so it does not show this product exists.` };
  }
  const partial = sources.filter((s) => AUTHORITATIVE.includes(s.sourceClass) && s.matched.length > 0 && s.matched.length >= Math.ceil(wanted.length * 0.6));
  if (partial.length > 0) {
    const s = partial[0];
    return {
      ...base,
      status: "unverified",
      basis: `${s.host} covers part of it (${s.matched.join(", ")}) but not ${s.missing.join(", ")}. The exact configuration is unconfirmed, not ruled out.`,
    };
  }
  return { ...base, status: "unverified", basis: "Nothing found that names it. A search turning up nothing does not mean it does not exist." };
}

export interface VerifyDeps {
  /** A web search: titles, addresses and snippets. */
  search(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>>;
  /** The readable text of a page (a generous amount: product pages bury the name below the navigation), or null when it can't be read. */
  fetchText(url: string, hint?: { tokens: string[] }): Promise<string | null>;
  /** What was asked and what came back since the last reset (optional: a fake web has none). */
  trace?(): EvidenceTrace;
  reset?(): void;
}

export interface VerifyOptions {
  brandHints?: string[];
  /** Addresses the user gave for this product: read first, and only count for what the page itself says. */
  userUrls?: string[];
  maxSteps?: number;
  /** How many top results per search to open and read. */
  readPerSearch?: number;
  now?: number;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/[#?].*$/, "").replace(/\/$/, "") === b.replace(/[#?].*$/, "").replace(/\/$/, "");
}

/**
 * Looks for evidence the way a person would: the exact title first, then (when that proves nothing) the product line plus its distinctive words,
 * the manufacturer's own site, the line's list of editions, alternate spellings. Stops as soon as the manufacturer confirms it. Pages of
 * manufacturers and retailers are read in full; everything else is judged by its search snippet.
 */
export async function verifyVariant(claim: string, deps: VerifyDeps, opts: VerifyOptions = {}): Promise<VariantVerdict> {
  const seen: EvidenceInput[] = [];
  const searched: string[] = [];
  const unreadableUrls: string[] = [];
  const searchLinks: Array<{ url: string; query: string }> = [];
  const hint = { tokens: claimTokens(claim) };
  deps.reset?.();
  const add = (input: EvidenceInput) => {
    const existing = seen.find((s) => sameUrl(s.url, input.url));
    if (!existing) seen.push(input);
    else if (input.excerpt.length > existing.excerpt.length) existing.excerpt = input.excerpt;
  };
  const finish = (v: VariantVerdict): VariantVerdict => {
    const trace = deps.trace?.();
    const unavailable = !!trace && trace.searches.length > 0 && trace.searches.every((x) => x.outcome === "blocked" || x.outcome === "error");
    const out: VariantVerdict = {
      ...v,
      unreadableUrls: unreadableUrls.length ? unreadableUrls : undefined,
      searchLinks: searchLinks.length ? searchLinks : undefined,
      diagnostics: trace ? { searches: trace.searches.slice(0, 30), pages: trace.pages.slice(0, 30) } : undefined,
      searchUnavailable: unavailable || undefined,
    };
    if (unavailable && out.status === "unverified" && seen.every((x) => !assessSource(claim, x, opts.brandHints).fullMatch)) {
      out.basis = `The web search itself was blocked or failed (${trace!.searches.filter((x) => x.outcome !== "ok").slice(0, 3).map((x) => `${x.backend}: ${x.detail ?? x.outcome}`).join("; ")}), so nothing could be checked. That says nothing about whether the product exists.`;
    }
    return out;
  };

  // Links the user gave: a product page is read first (and only counts for what it says); a search-results page is not a page that can be read, but the
  // words it searched for are used as a search.
  const extraQueries: string[] = [];
  for (const url of opts.userUrls ?? []) {
    const q = queryFromSearchUrl(url);
    if (q) {
      searchLinks.push({ url, query: q });
      extraQueries.push(q);
      continue;
    }
    const text = await deps.fetchText(url, hint).catch(() => null);
    if (text) add({ title: url, url, excerpt: text });
    else {
      unreadableUrls.push(url);
      searched.push(`(could not read ${url})`);
    }
  }
  let verdict = assessEvidence(claim, seen, { brandHints: opts.brandHints, searched, now: opts.now });
  if (verdict.status === "verified" || verdict.status === "disproven") return finish(verdict);

  const plan = [
    ...extraQueries.map((query) => ({ query, purpose: "exact" as const })),
    ...buildSearchPlan(claim, { brandHints: opts.brandHints, maxSteps: opts.maxSteps ?? 8 }),
  ];
  const readLimit = opts.readPerSearch ?? 3;
  for (const step of plan) {
    searched.push(`${step.query}`);
    let results: Array<{ title: string; url: string; snippet: string }> = [];
    try {
      results = await deps.search(step.query, 6);
    } catch {
      continue;
    }
    for (const r of results) add({ title: r.title, url: r.url, excerpt: r.snippet });
    // Read the pages that could settle it: the maker's and the retailers', plus the top result of any search.
    const toRead = results.filter((r, i) => i < readLimit || ["manufacturer", "retailer"].includes(classifySource(r.url, claim, opts.brandHints ?? []))).slice(0, readLimit + 2);
    await Promise.all(
      toRead.map(async (r) => {
        const text = await deps.fetchText(r.url, hint).catch(() => null);
        if (text) add({ title: r.title, url: r.url, excerpt: text });
      })
    );
    verdict = assessEvidence(claim, seen, { brandHints: opts.brandHints, searched, now: opts.now });
    if (verdict.status === "verified" || verdict.status === "disproven") break;
  }
  return finish(verdict);
}

const RANK: Record<VariantStatus, number> = { disproven: 0, unverified: 1, supported: 2, verified: 3 };

/**
 * A new look at a claim never silently overturns an earlier one: a later search that finds less than before does not downgrade a verified or
 * supported product to "unverified" (the earlier sources are still true). Moving UP is always allowed; "disproven" only replaces an earlier verdict
 * when it came from a source that says so (assessEvidence only ever returns it then) and nothing authoritative earlier said otherwise.
 */
export function reconcileVerdict(previous: VariantVerdict | null, next: VariantVerdict): VariantVerdict {
  if (!previous || previous.claim.toLowerCase() !== next.claim.toLowerCase()) return next;
  if (RANK[next.status] >= RANK[previous.status] && next.status !== "disproven") return next;
  if (next.status === "disproven" && previous.status !== "verified" && previous.status !== "supported") return next;
  if (next.status === "disproven") {
    return { ...previous, basis: `${previous.basis} (A later source disagrees: ${next.basis} Not changed without more evidence.)` };
  }
  // The new look found less: keep what was found before, and keep the sources.
  const merged = [...previous.sources];
  for (const s of next.sources) if (!merged.some((m) => sameUrl(m.url, s.url))) merged.push(s);
  return { ...previous, sources: merged.slice(0, 12), searched: [...new Set([...previous.searched, ...next.searched])] };
}

/** A short block for the AI: what is known about the claim, what that does and does not mean, how to word it. */
export function describeVerdictForAi(v: VariantVerdict): string {
  const lines: string[] = [`Evidence check for "${v.claim}": ${v.status.toUpperCase()}. ${v.basis}`];
  if (v.officialName && v.officialName.toLowerCase() !== v.claim.toLowerCase()) lines.push(`The source calls it "${v.officialName}".`);
  if (v.searchUnavailable) lines.push("The web search was blocked or unreachable: say the lookup itself failed and offer to retry; do NOT describe what was searched as if it returned nothing.");
  if (v.searchLinks?.length) lines.push(`The link the user gave is a search-results page (query "${v.searchLinks[0].query}"), not a product page: you did NOT read it as a page; its query was used as a search.`);
  if (v.unreadableUrls?.length) lines.push(`Could not read: ${v.unreadableUrls.join(", ")}. Do NOT claim you opened or read ${v.unreadableUrls.length === 1 ? "it" : "them"}.`);
  if (v.sources.length) lines.push(`Sources: ${v.sources.filter((s) => s.fullMatch).slice(0, 4).map((s) => `${s.host} (${s.sourceClass})`).join(", ") || "none that name it in full"}.`);
  if (v.status === "verified" || v.status === "supported") lines.push("Treat it as a real product. Say where the evidence came from. Do not call it fake, custom or seller-invented.");
  else if (v.status === "unverified") lines.push("Say you could not confirm it yet. Do NOT say it is fake, seller-invented or non-existent: nothing here shows that. Ask for a link or a photo of the box/label, or offer to look again.");
  else lines.push("A source says it is not an official product. Say that and cite the source; still invite proof to the contrary.");
  lines.push("No sold comps for the exact product means value is UNKNOWN: never borrow the standard model's price for it.");
  return lines.join("\n");
}
