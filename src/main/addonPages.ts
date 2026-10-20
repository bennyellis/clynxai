// The pages that name a product's accessories, the way editionResearch.ts finds the pages that name its editions: search like a person ("<product> accessories", "<product> compatible
// accessories"), read the maker / specialist / catalogue pages in full, and hand the text to variantDiscovery.addonCandidatesFromPages. Marketplace listings are not used. Network injected.
import { QUALITY_RANK, sourceQuality } from "./evidenceKinds.js";
import type { VerifyDeps } from "./variantEvidence.js";
import type { PageText } from "./variantDiscovery.js";

export function addonQueries(product: string): string[] {
  const p = product.replace(/\s+/g, " ").trim();
  return [`${p} accessories`, `${p} official accessories`, `${p} compatible accessories`];
}

const CLASS_OF: Record<string, string> = { official: "manufacturer", specialist: "reference", retailer: "retailer", collector: "reference", marketplace: "marketplace", other: "other" };

/** Pages likely to list accessories, with their text. Returns null when every search was unavailable (so "no add-ons found" is never confused with "could not look"). */
export async function fetchAddonPages(product: string, deps: VerifyDeps, opts: { maxPages?: number } = {}): Promise<PageText[] | null> {
  deps.reset?.();
  const pages: Array<{ url: string; title: string; text: string; quality: string }> = [];
  let anySearch = false;
  for (const q of addonQueries(product)) {
    const hits = await deps.search(q, 8).catch(() => null);
    if (hits === null) continue;
    anySearch = true;
    for (const h of hits) if (!pages.some((p) => p.url === h.url)) pages.push({ url: h.url, title: h.title, text: `${h.title}. ${h.snippet}`, quality: sourceQuality(h.url, product) });
  }
  if (!anySearch) return null;
  const rank = (q: string) => QUALITY_RANK[q as keyof typeof QUALITY_RANK] ?? 6;
  const toRead = pages.filter((p) => p.quality !== "marketplace").sort((a, b) => rank(a.quality) - rank(b.quality)).slice(0, opts.maxPages ?? 5);
  await Promise.all(
    toRead.map(async (p) => {
      const text = await deps.fetchText(p.url, { tokens: product.toLowerCase().split(" ") }).catch(() => null);
      if (text && text.length > p.text.length) p.text = text.slice(0, 120_000);
    })
  );
  return pages.map((p) => ({ url: p.url, title: p.title, text: p.text, sourceClass: CLASS_OF[p.quality] ?? "other" }));
}
