// Shared by locationDiscovery.ts (resolving a state's primary city) and
// scrapeEngine.ts (filtering listings to the selected state) — kept in one
// place rather than duplicated in both. Alaska and Hawaii deliberately
// excluded, matching Config.tsx's own state picker — per explicit
// instruction, ineligible for this app's nationwide mail-order resale model.
export const US_STATE_ABBREVIATIONS: Record<string, string> = {
  Alabama: "AL",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  Florida: "FL",
  Georgia: "GA",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
};

// Per explicit instruction — "State"/"City" location modes should skip any
// listing whose OWN location clearly reads as a different state than the
// one the user is searching (a wide search radius near a state border can
// easily pull in listings from just across the line). Returns null (never
// guesses) whenever locationText doesn't contain anything confidently
// recognizable as a state — no location text at all, an unrecognized
// format, or plain listing chatter — since locationText is itself only a
// best-effort scrape of the listing card (see scraper.ts's
// parseListingCard). A bare 2-letter abbreviation is only trusted right
// after a comma (the normal "City, ST" shape Facebook's own location line
// uses) — several state abbreviations (OR, IN, OH, ME...) double as
// ordinary English words, and scanning for those as loose substrings
// anywhere in the text would risk false-flagging perfectly good listings.
// A full state name, being long and specific, is safe to match anywhere.
export function listingStateMatches(locationText: string | null, targetStateFullName: string): boolean | null {
  if (!locationText) return null;
  const targetAbbr = US_STATE_ABBREVIATIONS[targetStateFullName];
  if (!targetAbbr) return null;

  const commaAbbrMatch = locationText.match(/,\s*([A-Za-z]{2})\b/);
  if (commaAbbrMatch) {
    const abbr = commaAbbrMatch[1].toUpperCase();
    if (Object.values(US_STATE_ABBREVIATIONS).includes(abbr)) {
      return abbr === targetAbbr;
    }
  }

  for (const fullName of Object.keys(US_STATE_ABBREVIATIONS)) {
    const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(locationText)) {
      return fullName === targetStateFullName;
    }
  }

  return null;
}
