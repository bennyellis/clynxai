// "Research all the special editions of X" / "look up the SNES one". Searches the way a person would, reads the pages that list editions (catalogues, the maker, specialist sites), and
// reports every edition the sources name, saying how well each is supported and where it was found. When it finds nothing it says WHY (the search was blocked, no page named any
// edition, the named one is not mentioned anywhere it read) from what really happened, never a vague "couldn't confirm". Network is injected.
import { discoverEditions, type EditionFinding } from "./editionDiscovery.js";
import { QUALITY_RANK, sourceQuality } from "./evidenceKinds.js";
import { searchWasUnavailable } from "./webEvidence.js";
import type { VerifyDeps } from "./variantEvidence.js";

export interface EditionResearch {
  product: string;
  findings: EditionFinding[];
  /** What the person named ("SNES"), and whether any source read mentions an edition by that name. */
  hint: { text: string; matches: EditionFinding[]; mentionedAnywhere: boolean } | null;
  searches: Array<{ query: string; backend: string; outcome: string; results: number; detail?: string }>;
  pagesRead: Array<{ url: string; chars: number; quality: string }>;
  blocked: boolean;
}

export function editionQueries(product: string, hint?: string | null): string[] {
  const p = product.replace(/\s+/g, " ").trim();
  const h = (hint ?? "").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  if (h) out.push(`${p} ${h} edition`, `${h} ${p} special edition release`);
  out.push(`${p} special editions list`, `${p} all limited edition variants and colors`, `${p} special edition database collectors`);
  return [...new Set(out)].slice(0, h ? 5 : 3);
}

export async function researchEditions(product: string, deps: VerifyDeps, opts: { hint?: string | null; maxPages?: number } = {}): Promise<EditionResearch> {
  deps.reset?.();
  const hint = (opts.hint ?? "").trim() || null;
  const pages: Array<{ url: string; title: string; text: string; quality: string }> = [];
  for (const q of editionQueries(product, hint)) {
    const hits = await deps.search(q, 8).catch(() => []);
    for (const h of hits) if (!pages.some((p) => p.url === h.url)) pages.push({ url: h.url, title: h.title, text: `${h.title}. ${h.snippet}`, quality: sourceQuality(h.url, product) });
  }
  // the pages most likely to LIST editions are read in full: the maker, specialist sites, then catalogues and references
  const rank = (q: string) => QUALITY_RANK[q as keyof typeof QUALITY_RANK] ?? 6;
  const toRead = [...pages].filter((p) => p.quality !== "marketplace").sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, opts.maxPages ?? 6);
  await Promise.all(
    toRead.map(async (p) => {
      const text = await deps.fetchText(p.url, { tokens: product.toLowerCase().split(" ") }).catch(() => null);
      if (text && text.length > p.text.length) p.text = text.slice(0, 120_000);
    })
  );
  const names = [product];
  const findings = discoverEditions(names, pages.map((p) => ({ url: p.url, title: p.title, text: p.text })));
  const trace = deps.trace?.();
  const searches = (trace?.searches ?? []).map((s) => ({ query: s.query, backend: s.backend, outcome: s.outcome, results: s.results, detail: s.detail }));
  let hintResult: EditionResearch["hint"] = null;
  if (hint) {
    const h = hint.toLowerCase();
    const matches = findings.filter((f) => f.name.toLowerCase().includes(h) || f.themeTerms.some((t) => t.toLowerCase() === h));
    hintResult = { text: hint, matches, mentionedAnywhere: pages.some((p) => p.text.toLowerCase().includes(h)) };
  }
  return { product, findings, hint: hintResult, searches, pagesRead: toRead.map((p) => ({ url: p.url, chars: p.text.length, quality: p.quality })), blocked: !!trace && searchWasUnavailable(trace) && pages.length === 0 };
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** The answer for the chat: what was found, how sure, from where, or exactly why nothing was. */
export function describeEditionResearch(r: EditionResearch): string {
  const engines = [...new Set(r.searches.filter((s) => s.outcome === "ok").map((s) => s.backend))];
  const lines: string[] = [];
  if (r.blocked) {
    const why = [...new Set(r.searches.map((s) => `${s.backend}: ${s.detail ?? s.outcome}`))].slice(0, 3).join("; ");
    return `I could not search the web for ${r.product} editions: every search engine was blocked or unreachable (${why}). Nothing was checked, so this says nothing about which editions exist. Try again in a few minutes.`;
  }
  if (r.hint) {
    if (r.hint.matches.length) {
      for (const m of r.hint.matches.slice(0, 4)) lines.push(`"${r.hint.text}": the sources name a ${m.name} (${m.support === "confirmed" ? "confirmed by more than one source" : "reported by one source"}): "${m.sources[0].quote.slice(0, 160)}" - ${host(m.sources[0].url)}.`);
    } else if (r.hint.mentionedAnywhere) {
      lines.push(`"${r.hint.text}" appears in the pages I read, but not as the name of a ${r.product} edition, so I can't call it one.`);
    } else {
      lines.push(`None of the ${r.pagesRead.length} pages I read mention "${r.hint.text}" with ${r.product}. That is not proof it doesn't exist, only that these sources don't say it does.`);
    }
  }
  if (r.findings.length) {
    const top = r.findings.slice(0, 20);
    lines.push(`Editions the sources name for ${r.product} (${r.findings.length}): ${top.map((f) => `${f.name}${f.support === "confirmed" ? "" : " (one source)"}`).join(", ")}.`);
    const confirmed = r.findings.filter((f) => f.support === "confirmed").length;
    lines.push(`${confirmed} of these are backed by an official or specialist source or by two independent sites; the rest come from a single page, so treat them as reported, not proven.`);
  } else if (!r.hint) {
    lines.push(`I read ${r.pagesRead.length} page(s) and none named a special edition of ${r.product}.`);
  }
  lines.push(`Searched ${r.searches.length} time(s) via ${engines.join(", ") || "no engine that answered"}; read: ${r.pagesRead.slice(0, 4).map((p) => host(p.url)).join(", ") || "nothing"}.`);
  return lines.join(" ");
}
