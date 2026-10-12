// Pure listing-age math, split out of scrapeEngine.ts so it can be imported
// without pulling in that file's Playwright/Electron dependencies — needed
// by ebayEngine.ts (no browser involved at all) and already awkward enough
// for watchMatching.ts that it avoids importing this and takes a
// precomputed hours value instead (see its own doc comment).
//
// Where the age comes from: Facebook's relative "Listed X ago" text, captured verbatim at scrape time (scraper.ts's
// extractListingAge); eBay's real creation date, formatted into the same vocabulary (ebayNormalize.ts). It is NOT an
// original posting date and not a last-updated date, so it is approximate ("2 weeks" carries no more precision than that).

export type AgeState = "fresh" | "stale" | "unknown";

export interface AgeAssessment {
  // fresh: a known age under the window. stale: a known age at or past the window. unknown: the text is missing or was
  // not understood. Unknown is NOT fresh: it can never make a listing a verified deal (see dealGate.ts); the listing stays
  // visible as "Worth a look".
  state: AgeState;
  hours: number | null;
  text: string | null;
}

const HOURS_PER_UNIT: Record<string, number> = {
  second: 1 / 3600,
  sec: 1 / 3600,
  minute: 1 / 60,
  min: 1 / 60,
  hour: 1,
  hr: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
  year: 24 * 365,
};

// Facebook writes "a week ago", "an hour ago", "about an hour ago", "over a year ago", "a few hours ago" as well as "3 weeks ago".
const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  few: 3,
  several: 4,
};

const QUALIFIER = "(?:about|around|over|almost|nearly|roughly|approximately|more than|less than|under|just over|just under)";
const AGE_RE = new RegExp(
  `^(?:${QUALIFIER}\\s+)?(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\\b`
);

// Best-effort parse of a relative "Listed X ago" phrase into an approximate age in hours. Returns null for anything not
// recognized (never guesses); callers must treat null as "unknown", not as "fresh" (see assessListingAge).
export function estimateListingAgeHours(ageText: string): number | null {
  const text = ageText.trim().toLowerCase().replace(/^listed\s+/, "");
  if (!text) return null;
  if (/^(just now|moments? ago|a moment ago|a few seconds ago)$/.test(text)) return 0;
  if (/^today$/.test(text)) return 1;
  if (/^yesterday$/.test(text)) return 30; // "not today" — treated as past the 24h window

  // "a couple of / a few / several <unit>"
  const vague = text.match(new RegExp(`^(?:${QUALIFIER}\\s+)?(?:a\\s+(couple|few)(?:\\s+of)?|(several))\\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\\b`));
  if (vague) {
    const n = WORD_NUMBERS[vague[1] ?? vague[2]];
    return n * HOURS_PER_UNIT[vague[3]];
  }

  const match = text.match(AGE_RE);
  if (!match) return null;
  const raw = match[1];
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_NUMBERS[raw];
  if (n === undefined || !Number.isFinite(n)) return null;
  return n * HOURS_PER_UNIT[match[2]];
}

/**
 * The age of a listing against a freshness window. `maxHours` null means no window (every KNOWN age counts as fresh);
 * an age that is missing or not understood is always "unknown", whatever the window.
 */
export function assessListingAge(ageText: string | null | undefined, maxHours: number | null = 24): AgeAssessment {
  const text = ageText?.trim() ? ageText.trim() : null;
  const hours = text ? estimateListingAgeHours(text) : null;
  if (hours === null) return { state: "unknown", hours: null, text };
  // >= not > : Facebook's "1 day ago" phrasing covers anywhere up to ~47h (it rounds down to whole days), so treating
  // exactly-maxHours as still fresh would let some genuinely stale listings through right at the boundary.
  if (maxHours !== null && hours >= maxHours) return { state: "stale", hours, text };
  return { state: "fresh", hours, text };
}

// This is a fast-moving mail-order reselling operation by default — a listing that's been sitting for days is far less
// likely to still be available or worth the time, so anything confidently older than maxHours gets skipped before it ever
// reaches seller-risk checks or an AI call. Only a KNOWN age can be too old; an unknown age is not skipped here (that
// would silently drop listings whose wording was not recognized) but it can never become a verified deal.
export function isListingTooOld(ageText: string | null, maxHours: number | null = 24): boolean {
  return assessListingAge(ageText, maxHours).state === "stale";
}

export interface AgeGateDecision {
  assessment: AgeAssessment;
  // Past the account's general freshness window.
  stale: boolean;
  // Skip the listing outright (stale, and no Watch with its OWN looser window covers it).
  skip: boolean;
  // Stale but kept for a Watch whose own window covers it: it may be delivered as that Watch's match, but must NOT be
  // treated as an ordinary deal (nothing downstream re-checks age for the standard pathways).
  watchOnly: boolean;
}

/**
 * The listing-age gate for one listing. A Watch can only rescue a listing that is stale by the general window if the Watch
 * has an age window of its own that covers the listing's age: a Watch with no age condition uses the general window, so it
 * cannot rescue anything.
 */
export function decideAgeGate(ageText: string | null | undefined, globalMaxHours: number | null, watches: Array<{ maxListingAgeMinutes: number | null }> = []): AgeGateDecision {
  const assessment = assessListingAge(ageText, globalMaxHours);
  if (assessment.state !== "stale") return { assessment, stale: false, skip: false, watchOnly: false };
  const hours = assessment.hours as number;
  const rescued = watches.some((w) => w.maxListingAgeMinutes !== null && hours < w.maxListingAgeMinutes / 60);
  return { assessment, stale: true, skip: !rescued, watchOnly: rescued };
}

/** The freshness window that applies to a Watch: its own when it has one, else the account's general window. */
export function effectiveWatchMaxHours(watch: { maxListingAgeMinutes: number | null }, globalMaxHours: number | null): number | null {
  return watch.maxListingAgeMinutes !== null ? watch.maxListingAgeMinutes / 60 : globalMaxHours;
}
