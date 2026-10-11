// The free checks a Facebook Watch runs on each search result BEFORE spending a page
// visit or an AI call on it, in order:
//   1. has this Watch come across the listing before?  -> skip (it is remembered the
//      first time, whatever happens next)
//   2. has the scanner already evaluated it?            -> skip (same as everywhere else)
//   3. no price, a placeholder price ($0, $1, $1234), or outside the Watch's min/max price?  -> skip
//   4. is the title clearly about one of the Watch's terms? (strict match)
//   5. is it on the blacklist?                          -> skip
//   6. is it inside the Watch's area (radius / state)?  -> skip when out of bounds
// Kept separate from the browser code so it can be tested on its own.
import type { Store } from "./store.js";
import type { ListingSummary, Watch, WatchTerm } from "./types.js";
import { checkWatchBounds, type WatchGeoDeps } from "./watchGeo.js";
import { matchWatchTerm, passesWatchPriceGate } from "./watchMatching.js";
import { isSuspiciousPrice, placeholderPriceReason } from "./placeholderPrice.js";

export type Prefilter =
  | { ok: true; term: WatchTerm; areaNote: string }
  // `quiet` skips are routine (a repeat, a result that isn't the product at all) and
  // aren't worth an Activity line; the others are.
  | { ok: false; reason: string; quiet: boolean };

export interface PrefilterDeps {
  store: Store;
  ignoreBlacklist: boolean;
  geo: WatchGeoDeps;
}

export async function prefilterWatchListing(
  watch: Watch,
  listing: Pick<ListingSummary, "id" | "title" | "price" | "locationText">,
  deps: PrefilterDeps
): Promise<Prefilter> {
  if (!deps.store.markWatchSeen(watch.id, listing.id)) return { ok: false, reason: "this Watch has already come across it", quiet: true };
  if (deps.store.hasSeenCached(listing.id)) return { ok: false, reason: "already evaluated by the scanner", quiet: true };

  if (listing.price === null) return { ok: false, reason: "no price listed", quiet: true };
  // $0, $1, $1234...: the seller wants offers, not a price a reseller can flip from (see placeholderPrice.ts).
  if (isSuspiciousPrice(listing.price)) return { ok: false, reason: placeholderPriceReason(listing.price), quiet: false };
  if (!passesWatchPriceGate(watch, listing.price)) return { ok: false, reason: `$${listing.price} is outside the price range`, quiet: true };

  const term = matchWatchTerm(watch, listing.title);
  if (!term) return { ok: false, reason: "the title isn't clearly one of the things being watched for", quiet: true };

  if (!deps.ignoreBlacklist && deps.store.isBlacklisted(listing.title)) return { ok: false, reason: "matches the blacklist", quiet: true };

  const bounds = await checkWatchBounds(watch, listing.locationText, deps.geo);
  if (!bounds.ok) return { ok: false, reason: `out of bounds: ${bounds.reason}`, quiet: false };
  return { ok: true, term, areaNote: bounds.reason };
}
