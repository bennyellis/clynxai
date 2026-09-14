import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Config } from "./types.js";

// A nationwide spread (one per state capital, minus a couple with
// unresolved slugs) so the scraper rotates across the whole country
// looking for deals instead of staying local — the whole point of buying
// exclusively by mail rather than local pickup. Not independently verified
// live (no way to browse Facebook from here) — if any of these turn out to
// be a dead/wrong slug, Facebook will just show an empty or default feed
// for it and the "Empty browse" diagnostic in Activity will say so.
export const DEFAULT_BROWSE_URLS = [
  "https://www.facebook.com/marketplace/montgomery",
  "https://www.facebook.com/marketplace/phoenix",
  "https://www.facebook.com/marketplace/littlerock",
  "https://www.facebook.com/marketplace/sacramento",
  "https://www.facebook.com/marketplace/denver",
  "https://www.facebook.com/marketplace/hartford",
  "https://www.facebook.com/marketplace/dover",
  "https://www.facebook.com/marketplace/tallahassee",
  "https://www.facebook.com/marketplace/atlanta",
  "https://www.facebook.com/marketplace/boise",
  "https://www.facebook.com/marketplace/springfield",
  "https://www.facebook.com/marketplace/indianapolis",
  "https://www.facebook.com/marketplace/desmoines",
  "https://www.facebook.com/marketplace/topeka",
  "https://www.facebook.com/marketplace/frankfort",
  "https://www.facebook.com/marketplace/batonrouge",
  "https://www.facebook.com/marketplace/augusta",
  "https://www.facebook.com/marketplace/annapolis",
  "https://www.facebook.com/marketplace/boston",
  "https://www.facebook.com/marketplace/lansing",
  "https://www.facebook.com/marketplace/saintpaul",
  "https://www.facebook.com/marketplace/jackson",
  "https://www.facebook.com/marketplace/jeffersoncity",
  "https://www.facebook.com/marketplace/helena",
  "https://www.facebook.com/marketplace/lincoln",
  "https://www.facebook.com/marketplace/carsoncity",
  "https://www.facebook.com/marketplace/concord",
  "https://www.facebook.com/marketplace/trenton",
  "https://www.facebook.com/marketplace/santafe",
  "https://www.facebook.com/marketplace/albany",
  "https://www.facebook.com/marketplace/raleigh",
  "https://www.facebook.com/marketplace/bismarck",
  "https://www.facebook.com/marketplace/columbus",
  "https://www.facebook.com/marketplace/oklahomacity",
  "https://www.facebook.com/marketplace/salem",
  "https://www.facebook.com/marketplace/harrisburg",
  "https://www.facebook.com/marketplace/providence",
  "https://www.facebook.com/marketplace/columbia",
  "https://www.facebook.com/marketplace/pierre",
  "https://www.facebook.com/marketplace/nashville",
  "https://www.facebook.com/marketplace/austin",
  "https://www.facebook.com/marketplace/saltlakecity",
  "https://www.facebook.com/marketplace/montpelier",
  "https://www.facebook.com/marketplace/richmond",
  "https://www.facebook.com/marketplace/olympia",
  "https://www.facebook.com/marketplace/charleston",
  "https://www.facebook.com/marketplace/madison",
  "https://www.facebook.com/marketplace/cheyenne",
];

export const DEFAULT_CONFIG: Config = {
  browseUrls: DEFAULT_BROWSE_URLS,
  listingsPerLocation: 20,
  headless: false,
  // Per explicit instruction ("can it be a little faster?") — trimmed down
  // from the original 4-9 min. Still random-ranged and still a real gap
  // between cycles (not zero), just a shorter one, so this doesn't touch
  // the actual anti-bot-detection posture, only how often a finished cycle
  // starts the next one.
  pollIntervalMinutesMin: 2,
  pollIntervalMinutesMax: 5,
  dealThresholdPercent: 35,
  searchItems: [],
  customInstructions: "",
  generalDeal: {
    enabled: true,
    minConfidence: "medium",
  },
  ntfy: { server: "https://ntfy.sh", topic: "" },
  photoAnalysis: { enabled: true },
  sellerRisk: {
    enabled: true,
    minAccountAgeYears: 1,
    // Per explicit instruction — optional, off by default. A seller with no
    // rating yet (a newer or low-volume account) still passes regardless
    // of this setting either way (see sellerRisk.ts — only checked when
    // seller.rating is actually present), but a hard 3.5 floor here was
    // filtering out genuinely GOOD deals from newer sellers who happen to
    // have a real but lower rating, which is the opposite of what a
    // reseller wants. Set a real minimum yourself in Config if you want one.
    minRating: null,
    minRatingCount: null,
    maxRatingCount: null,
    requireProfilePhoto: true,
  },
  maxListingAgeHours: 24,
  theme: "dark",
  soundEnabled: true,
  locationMode: "country",
  selectedState: null,
  selectedCityOrZip: null,
  searchRadiusMiles: 100,
  watchCountOncePerScan: true,
  // Per explicit instruction — user-controlled filtering parameters, all
  // off/unset by default so nothing about existing behavior changes until
  // the user deliberately turns one on.
  maxPriceUsd: null,
  minPriceUsd: null,
  ignoreBlacklist: false,
  autoResearchListings: true,
  rotateSearchItems: false,
  rotateSearchItemsCount: 5,
};

// Derives a plain "browse everything" URL (no /search, no query) from an
// old-format search URL, for configs saved before browse mode existed.
function deriveBrowseUrlFromLegacySearchUrl(searchUrl: string): string | null {
  try {
    const url = new URL(searchUrl);
    url.pathname = url.pathname.replace(/\/search\/?$/, "");
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const merged: Config = { ...DEFAULT_CONFIG, ...raw };

    // Migrate configs saved before multi-location rotation existed
    // (single browseUrl string) into the new browseUrls array.
    if ((!merged.browseUrls || !merged.browseUrls.length) && typeof raw.browseUrl === "string" && raw.browseUrl) {
      merged.browseUrls = [raw.browseUrl];
    }
    // Migrate even older pre-browse-mode configs (searchUrlTemplate + searches[]).
    if ((!merged.browseUrls || !merged.browseUrls.length) && raw.searchUrlTemplate) {
      const derived = deriveBrowseUrlFromLegacySearchUrl(raw.searchUrlTemplate);
      if (derived) merged.browseUrls = [derived];
    }

    // Migrate configs saved before the "Search For" rename/simplification
    // — old referencePrices entries (which had a since-removed activeSearch
    // toggle) become searchItems, everything now unconditionally searched.
    if ((!merged.searchItems || !merged.searchItems.length) && Array.isArray(raw.referencePrices)) {
      merged.searchItems = raw.referencePrices.map((r: any) => ({
        item: r.item,
        typicalResaleUsd: r.typicalResaleUsd,
        matchKeywords: r.matchKeywords ?? [],
      }));
    }
    merged.searchItems = merged.searchItems ?? [];
    // Configs saved before the per-item maxBudgetUsd field was removed may
    // still have it sitting in the JSON on disk — harmless (SearchItem no
    // longer declares it, and nothing reads it), left as-is rather than
    // scrubbed out.

    // Per explicit instruction — the Dashboard resets to a clean slate on
    // every launch: the Search For list, custom instructions, and the
    // general-deal toggle are session-scoped asks ("find me a PS5 today"),
    // not standing configuration, so they start fresh here rather than
    // silently carrying forward whatever the AI was focused on last time.
    // (This was briefly changed the other way — persisting them like every
    // other setting — after a report that a tracked item "only ever
    // searched once": that turned out to be a real, separate bug
    // [scorer.ts's matchSearchItem was silently skipping any item with no
    // price set, so it could never be RECOGNIZED as a match again after the
    // first lucky flag, regardless of whether it stayed in this list] which
    // is fixed independently of this reset — restoring the reset here is
    // exactly what the user asked for once that confusion was cleared up.)
    // Everything else below this point (API-key-adjacent toggles, the
    // location list, items per location, poll interval, notification
    // settings, seller-risk filters, Min/Max Price, Date Listed, etc.)
    // persists exactly as saved until changed — those live on (or are
    // reachable from) Config/the Dashboard Filters area, not chat-only.
    merged.searchItems = [];
    merged.customInstructions = "";
    merged.generalDeal = { ...merged.generalDeal, enabled: DEFAULT_CONFIG.generalDeal.enabled };

    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(configPath: string, config: Config): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
