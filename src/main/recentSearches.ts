// "Recent searches" under Dashboard > Add product: the products the user has searched for before, each with the price range
// it was searched with, so one click puts it back on the Search For list. The Search For list itself resets every launch;
// this list lives in config.json and survives restarts.
import type { RecentSearch } from "./types.js";

export const MAX_RECENT_SEARCHES = 12;

type SearchKey = { item: string; minPriceUsd: number | null; maxPriceUsd: number | null; includeBroken?: boolean };

function sameSearch(a: SearchKey, b: SearchKey): boolean {
  return (
    a.item.trim().toLowerCase() === b.item.trim().toLowerCase() &&
    (a.minPriceUsd ?? null) === (b.minPriceUsd ?? null) &&
    (a.maxPriceUsd ?? null) === (b.maxPriceUsd ?? null) &&
    !!a.includeBroken === !!b.includeBroken
  );
}

/** The list with this search put first (newest first). The same product with the same price range is only kept once. */
export function pushRecentSearch(list: RecentSearch[] | undefined, entry: Omit<RecentSearch, "at">, now: number = Date.now()): RecentSearch[] {
  const item = entry.item.trim();
  if (!item) return list ?? [];
  const next: RecentSearch = { item, minPriceUsd: entry.minPriceUsd ?? null, maxPriceUsd: entry.maxPriceUsd ?? null, linkedProductId: entry.linkedProductId ?? null, includeBroken: !!entry.includeBroken, at: now };
  return [next, ...(list ?? []).filter((r) => !sameSearch(r, next))].slice(0, MAX_RECENT_SEARCHES);
}

export function removeRecentSearch(list: RecentSearch[] | undefined, target: SearchKey): RecentSearch[] {
  return (list ?? []).filter((r) => !sameSearch(r, target));
}
