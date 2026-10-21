// The owner's imported sales, offered to the existing sold-price analysis for one search. They go through the SAME identity checks as WatchCount's results (analyzeEbayComps), so an imported
// row that is a different model or a bundle is left out like any other. Pure apart from the rows handed in.
import type { EbayComp } from "../watchcount.js";
import { ManualImportProvider } from "./manualImport.js";
import type { SoldComp } from "./types.js";

export const toEbayComp = (c: SoldComp): EbayComp => ({
  title: c.title,
  priceUsd: c.soldPrice,
  shippingUsd: c.shippingCost,
  condition: c.condition,
  listingType: c.buyingOption,
  runTimeDays: null,
  itemUrl: c.sourceListingId && /^\d{6,}$/.test(c.sourceListingId) ? `https://www.ebay.com/itm/${c.sourceListingId}` : "https://www.ebay.com",
  imageUrl: c.imageUrl,
});

/** The imported sales that share enough words with this search, as comps the analysis understands (US dollars only), without repeating a sale WatchCount already returned. */
export async function importedCompsForQuery(rows: SoldComp[], query: string, already: EbayComp[]): Promise<EbayComp[]> {
  const found = await new ManualImportProvider(() => rows).search({ title: query });
  const key = (c: { title: string; priceUsd: number }) => `${c.title.toLowerCase().replace(/\s+/g, " ").trim()}|${Math.round(c.priceUsd)}`;
  const have = new Set(already.map(key));
  return found.comps
    .filter((c) => c.currency === "USD")
    .map(toEbayComp)
    .filter((c) => !have.has(key(c)));
}
