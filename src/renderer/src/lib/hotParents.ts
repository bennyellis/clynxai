// Green frame on a family's price: a family entry (a parent with models below it, not priced itself) is framed green when any model below it is a high-demand flip. "High demand" is the same test the
// fire badge uses (sells above the library's average price AND in under a week, from real sold data); a model with no sold data never counts, so "no data" stays "no data". Pure.
export interface HotInput {
  id: string;
  parentProductId: string | null;
  ebayAvgSoldPriceUsd: number | null;
  ebayAvgRunTimeDays: number | null;
}

export function isHot(p: Pick<HotInput, "ebayAvgSoldPriceUsd" | "ebayAvgRunTimeDays">, libraryAvgSoldUsd: number | null): boolean {
  if (p.ebayAvgSoldPriceUsd === null || p.ebayAvgRunTimeDays === null || libraryAvgSoldUsd === null) return false;
  return p.ebayAvgSoldPriceUsd >= libraryAvgSoldUsd && p.ebayAvgRunTimeDays < 7;
}

/** The ids of entries that have at least one hot model directly below them. */
export function hotParentIds(products: ReadonlyArray<HotInput>, libraryAvgSoldUsd: number | null): Set<string> {
  const out = new Set<string>();
  for (const p of products) if (p.parentProductId && isHot(p, libraryAvgSoldUsd)) out.add(p.parentProductId);
  return out;
}
