// Which cards of Facebook's general feed are worth opening, and in what order (pure).
//
// With two or more Search For items and "Rotate search terms" off there is no dedicated search: the general feed itself is where the Search For items are found. It used to be
// filtered down to titles that looked like a Search For item EVEN WHEN general deal detection was on, so unrelated bargains were silently never opened. Now:
//   - general detection ON : every card is a candidate; the ones that look like a Search For item go first, so they still get the per-location opens before the cap is spent.
//   - general detection OFF: only cards that look like a Search For item (or are one word short of it) are candidates, exactly as before.
import { findGreenFlagCandidate, isRelevantToSearchItems } from "./scorer.js";
import type { SearchItem } from "./types.js";

export function feedCandidates<T extends { title: string }>(listings: T[], searchItems: SearchItem[], generalDealEnabled: boolean): { candidates: T[]; focused: number } {
  const focused: T[] = [];
  const others: T[] = [];
  for (const l of listings) {
    if (isRelevantToSearchItems(l.title, searchItems) || findGreenFlagCandidate(l.title, searchItems) !== null) focused.push(l);
    else others.push(l);
  }
  return { candidates: generalDealEnabled ? [...focused, ...others] : focused, focused: focused.length };
}
