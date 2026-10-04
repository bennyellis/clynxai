// Pure listing-age math, split out of scrapeEngine.ts so it can be imported
// without pulling in that file's Playwright/Electron dependencies — needed
// by ebayEngine.ts (no browser involved at all) and already awkward enough
// for watchMatching.ts that it avoids importing this and takes a
// precomputed hours value instead (see its own doc comment).

// Best-effort parse of Facebook's relative "Listed X ago" phrasing (see
// scraper.ts's extractListingAge) into an approximate age in hours.
// Deliberately rough — "3 weeks ago" doesn't carry more precision than
// that anyway — and returns null for anything not recognized rather than
// guessing, since isListingTooOld treats "can't tell" as "don't skip":
// silently discarding a listing just because its exact phrasing wasn't
// recognized would be worse than occasionally evaluating a stale one.
export function estimateListingAgeHours(ageText: string): number | null {
  const text = ageText.trim().toLowerCase();
  if (/^just now$/.test(text)) return 0;
  if (/^today$/.test(text)) return 1;
  if (/^yesterday$/.test(text)) return 30; // "not today" — treated as past the 24h window
  const match = text.match(/^(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\b/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const hoursPerUnit: Record<string, number> = {
    minute: 1 / 60,
    min: 1 / 60,
    hour: 1,
    hr: 1,
    day: 24,
    week: 24 * 7,
    month: 24 * 30,
    year: 24 * 365,
  };
  return n * hoursPerUnit[match[2]];
}

// This is a fast-moving mail-order reselling operation by default — a
// listing that's been sitting for days is far less likely to still be
// available or worth the time, so anything confidently older than maxHours
// gets skipped before it ever reaches seller-risk checks or an AI call.
// Only skips when the age was actually parsed; an unrecognized/missing age
// string never skips (see estimateListingAgeHours). Per explicit
// instruction, this is now the user's own Config choice (maxListingAgeHours
// — this is what actually GUARANTEES the configured window regardless of
// whether Facebook's own "Date listed" filter click succeeded, see
// scraper.ts's applyDateListedFilter) rather than a fixed 24h assumption;
// null means no cap at all — every listing counts as fresh enough.
export function isListingTooOld(ageText: string | null, maxHours: number | null = 24): boolean {
  if (!ageText || maxHours === null) return false;
  const hours = estimateListingAgeHours(ageText);
  // >= not > : Facebook's "1 day ago" phrasing covers anywhere up to ~47h
  // (it rounds down to whole days), so treating exactly-maxHours as still
  // fresh would let some genuinely stale listings through right at the
  // boundary that matters most.
  return hours !== null && hours >= maxHours;
}
