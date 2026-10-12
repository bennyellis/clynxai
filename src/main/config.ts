import { preserveCopy, readJsonFileSafe, writeFileAtomicWithBackup } from "./safeFs.js";
import { randomUUID } from "node:crypto";
import type { Config } from "./types.js";

// LEGACY, kept only so loadConfig's migration below can recognize an
// existing account that still has these exact URLs and force it to
// re-resolve (see the migration a bit further down + index.ts's
// resolveAccountLocationIfNeeded). Root-caused live with 4 concurrent
// accounts all running "country" mode: every account's evaluated listings
// were clustering in Virginia/Maryland (near Richmond) regardless of which
// of these 48 URLs the rotation had just shuffled to, and the account's own
// Facebook sidebar kept reading "Richmond, Virginia" no matter what — these
// city-slug URLs were NEVER actually confirmed to change Facebook's served
// location (the comment that used to sit here literally admitted that: "if
// any of these turn out to be a dead/wrong slug, Facebook will just show an
// empty or default feed for it"). That's exactly what was happening for
// most of them — Facebook was silently falling back to each account's own
// default location instead of erroring, so the rotation LOOKED like it was
// working (a different URL every visit) while actually just re-rendering
// the same nearby-Richmond results 48 times per cycle. Country mode now
// resolves through the exact same dialog-driven, Facebook-CONFIRMED
// mechanism state mode already used (see DEFAULT_COUNTRY_CITIES and
// resolveAccountLocationIfNeeded) instead of trusting guessed URLs.
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

// The SAME nationwide spread as the legacy list above (one per state
// capital, minus Alaska/Hawaii — mail-only shipping doesn't cover those
// well), but as real "City, State" names for resolveAccountLocationIfNeeded
// to drive through Facebook's own "Change location" dialog (see
// locationDiscovery.ts's discoverLocation/changeLocation) — the same
// verified-not-guessed mechanism state mode's lookupTopCitiesInState +
// discoverLocations already used. Full state names, not abbreviations —
// confirmed live that's what Facebook's own Location field expects (see
// lookupTopCitiesInState's own comment on this).
export const DEFAULT_COUNTRY_CITIES = [
  "Montgomery, Alabama",
  "Phoenix, Arizona",
  "Little Rock, Arkansas",
  "Sacramento, California",
  "Denver, Colorado",
  "Hartford, Connecticut",
  "Dover, Delaware",
  "Tallahassee, Florida",
  "Atlanta, Georgia",
  "Boise, Idaho",
  "Springfield, Illinois",
  "Indianapolis, Indiana",
  "Des Moines, Iowa",
  "Topeka, Kansas",
  "Frankfort, Kentucky",
  "Baton Rouge, Louisiana",
  "Augusta, Maine",
  "Annapolis, Maryland",
  "Boston, Massachusetts",
  "Lansing, Michigan",
  "Saint Paul, Minnesota",
  "Jackson, Mississippi",
  "Jefferson City, Missouri",
  "Helena, Montana",
  "Lincoln, Nebraska",
  "Carson City, Nevada",
  "Concord, New Hampshire",
  "Trenton, New Jersey",
  "Santa Fe, New Mexico",
  "Albany, New York",
  "Raleigh, North Carolina",
  "Bismarck, North Dakota",
  "Columbus, Ohio",
  "Oklahoma City, Oklahoma",
  "Salem, Oregon",
  "Harrisburg, Pennsylvania",
  "Providence, Rhode Island",
  "Columbia, South Carolina",
  "Pierre, South Dakota",
  "Nashville, Tennessee",
  "Austin, Texas",
  "Salt Lake City, Utah",
  "Montpelier, Vermont",
  "Richmond, Virginia",
  "Olympia, Washington",
  "Charleston, West Virginia",
  "Madison, Wisconsin",
  "Cheyenne, Wyoming",
];

export const DEFAULT_CONFIG: Config = {
  // Per explicit instruction — multiple Facebook accounts scanning
  // concurrently, each its own location (see types.ts's Account). A fresh
  // install still gets exactly one account with the app's original
  // always-on nationwide "country" mode, so a new user's first-run
  // experience is unchanged. "default" (not a random id) since this is a
  // fixed constant, not something generated per-launch.
  accounts: [
    {
      id: "default",
      label: "Account 1",
      enabled: true,
      // Interim-only — overwritten the moment this account first resolves
      // (see resolveAccountLocationIfNeeded's "country" branch), just like
      // state/city mode leave browseUrls empty until their own first
      // resolution. Kept as the legacy guessed list rather than empty so a
      // Start that somehow races ahead of resolution still has SOMETHING to
      // browse instead of erroring on "No browse URLs configured."
      browseUrls: DEFAULT_BROWSE_URLS,
      locationMode: "country",
      selectedState: null,
      selectedCityOrZip: null,
      // Per explicit instruction — "for whole country, change the search
      // radius from 100 miles to 500 miles" (see index.ts's
      // COUNTRY_MODE_RADIUS_MILES, which is what actually gets applied —
      // this default only matters for the brief window before a fresh
      // account's first real resolution overwrites it).
      searchRadiusMiles: 500,
      // Per explicit instruction — changing location mode in Config should
      // just save the choice, not immediately open a browser to resolve it;
      // resolution now happens lazily the next time this account starts
      // (see index.ts's resolveAccountLocationIfNeeded). Root-caused live
      // (see DEFAULT_BROWSE_URLS's own comment above): country mode's
      // browseUrls are NOT actually reliable without being driven through
      // Facebook's own "Change location" dialog first, exactly like state
      // and city mode already require — so this can no longer default to
      // true the way it used to.
      locationResolved: false,
    },
  ],
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
  ebayNetPercent: 84,
  minProfitMarginPercent: 20,
  maxNegotiationPercent: 15,
  lowAiMode: true,
  // "Worth a look" finds stay in the Feed only unless this is turned on (then they are pushed quietly).
  notifyWorthALook: false,
  // A brand-new install sees the checklist; loadConfig marks it already dismissed for a config file that predates it.
  onboarding: { dismissed: false, facebookConnected: false, locationChosen: false, phoneSkipped: false },
  recentSearches: [],
  ebayStoreUsername: "",
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
  primaryColor: "#7c6cf6",
  accentColor: "#a855f7",
  rainbowEnabled: false,
  panelTransparency: 20,
  soundEnabled: true,
  desktopNotifications: true,
  particlesEnabled: true,
  // Per explicit instruction — a master on/off for the automatic WatchCount
  // comps lookup, separate from watchCountOncePerScan below (which only
  // throttles frequency, not whether it happens at all). Defaults to true
  // so nothing changes for existing users until they deliberately turn it
  // off in Config.
  watchCountEnabled: true,
  watchCountOncePerScan: true,
  // Per explicit instruction — user-controlled filtering parameter, off/
  // unset by default so nothing about existing behavior changes until the
  // user deliberately turns it on. (Min/Max Price used to live here too, as
  // a single global cap — now per-item on SearchItem itself, see types.ts.)
  ignoreBlacklist: false,
  autoResearchListings: true,
  // Condition-awareness — off by default, see types.ts's Config.researchCondition.
  researchCondition: false,
  rotateSearchItems: false,
  rotateSearchItemsCount: 5,
  watch: {
    globallyPaused: false,
    matchesLastViewedAt: 0,
  },
  // Clynx Cloud Phase 1 foundation — off by default, see types.ts's Config.cloud.
  cloud: {
    enabled: false,
  },
  // eBay Browse API integration — off by default until credentials are
  // configured, see types.ts's Config.ebay.
  ebay: {
    enabled: false,
  },
  facebookEnabled: true,
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

// What happened the last time loadConfig met a config.json it could not use as it was. A damaged file is never lost and never
// silently replaced: it is kept aside (savedCopy) and the app tells the user (index.ts shows a persistent notice).
export interface ConfigLoadNotice {
  // restored: the file was damaged, the last known-good copy was put back
  // reset: the file was damaged and there was no good copy, so settings start from the defaults
  kind: "restored" | "reset";
  savedCopy: string | null;
}
let lastConfigLoadNotice: ConfigLoadNotice | null = null;
/** The notice from the most recent loadConfig, once (null when the file loaded normally). */
export function takeConfigLoadNotice(): ConfigLoadNotice | null {
  const n = lastConfigLoadNotice;
  lastConfigLoadNotice = null;
  return n;
}

export function loadConfig(configPath: string): Config {
  lastConfigLoadNotice = null;
  const read = readJsonFileSafe<any>(configPath);
  if (read.status === "missing") {
    return { ...DEFAULT_CONFIG };
  }
  if (read.status === "damaged") {
    lastConfigLoadNotice = { kind: "reset", savedCopy: read.quarantinedTo };
    return { ...DEFAULT_CONFIG };
  }
  if (read.status === "restored") lastConfigLoadNotice = { kind: "restored", savedCopy: read.quarantinedTo };
  try {
    const raw = read.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json is not a settings object");
    const merged: Config = { ...DEFAULT_CONFIG, ...raw };
    // An existing customer upgrading must not suddenly be nagged with a first-run checklist: it starts dismissed (still in Config).
    // Missing fields of a partly saved checklist fall back to "not done".
    merged.onboarding = raw.onboarding && typeof raw.onboarding === "object"
      ? { ...DEFAULT_CONFIG.onboarding!, ...raw.onboarding }
      : { ...DEFAULT_CONFIG.onboarding!, dismissed: true };

    // Per explicit instruction — multiple Facebook accounts. A config
    // saved before this existed described its ONE location flatly
    // (browseUrls/locationMode/selectedState/selectedCityOrZip/
    // searchRadiusMiles right on Config) rather than in an accounts
    // array; wrap those fields into a single-item array here so upgrading
    // loses no location setup. Resolves the FULL historical chain first
    // (an even older single browseUrl string, or older still,
    // searchUrlTemplate) rather than assuming raw.browseUrls is already
    // the array form — those two migrations used to write straight to
    // merged.browseUrls, which no longer exists as a top-level Config
    // field now that it lives on Account instead.
    if (!Array.isArray(raw.accounts) || !raw.accounts.length) {
      let legacyBrowseUrls: string[] = Array.isArray(raw.browseUrls) ? raw.browseUrls : [];
      if (!legacyBrowseUrls.length && typeof raw.browseUrl === "string" && raw.browseUrl) {
        legacyBrowseUrls = [raw.browseUrl];
      }
      if (!legacyBrowseUrls.length && raw.searchUrlTemplate) {
        const derived = deriveBrowseUrlFromLegacySearchUrl(raw.searchUrlTemplate);
        if (derived) legacyBrowseUrls = [derived];
      }
      if (!legacyBrowseUrls.length) legacyBrowseUrls = DEFAULT_BROWSE_URLS;

      merged.accounts = [
        {
          id: randomUUID(),
          label: "Account 1",
          enabled: true,
          browseUrls: legacyBrowseUrls,
          locationMode: raw.locationMode === "state" || raw.locationMode === "city" ? raw.locationMode : "country",
          selectedState: typeof raw.selectedState === "string" ? raw.selectedState : null,
          selectedCityOrZip: typeof raw.selectedCityOrZip === "string" ? raw.selectedCityOrZip : null,
          searchRadiusMiles: typeof raw.searchRadiusMiles === "number" ? raw.searchRadiusMiles : 100,
          // Already resolved — these browseUrls came from a working config.
          locationResolved: true,
        },
      ];
    }

    // Per explicit instruction — a config saved before locationResolved
    // existed (including one already migrated into the accounts array by
    // an older version of this app) has no way to know whether its saved
    // browseUrls are still valid for its saved locationMode/selectedState.
    // Defaulting missing values to true (not false) is the safe direction:
    // it assumes an existing account's already-working browseUrls are
    // still good, rather than forcing every upgrading user's next Start to
    // pay an unexpected resolution delay for a location that hasn't
    // actually changed.
    merged.accounts = merged.accounts.map((a) => ({ ...a, locationResolved: a.locationResolved ?? true }));

    // Root-caused live with 4 concurrent accounts (see DEFAULT_BROWSE_URLS's
    // own comment) — every "country" mode account saved before this fix
    // carries the OLD guessed city-slug URLs and locationResolved: true
    // (country mode used to skip resolution entirely), so the safe-default
    // pass just above would leave them exactly as broken as they already
    // were. Detecting that exact legacy shape (same length, same first URL)
    // and forcing ONE more resolution pass — through the now-real
    // dialog-driven "country" branch in resolveAccountLocationIfNeeded — is
    // what actually fixes an existing install instead of just new ones. A
    // country-mode account that's already been re-resolved since this fix
    // shipped has real, Facebook-confirmed URLs here instead (a different
    // length/shape almost certainly, since discoverLocations only keeps the
    // cities that actually resolved), so it's correctly left alone.
    const looksLikeLegacyGuessedCountryUrls = (browseUrls: string[]): boolean =>
      browseUrls.length === DEFAULT_BROWSE_URLS.length && browseUrls[0] === DEFAULT_BROWSE_URLS[0];
    merged.accounts = merged.accounts.map((a) =>
      a.locationMode === "country" && looksLikeLegacyGuessedCountryUrls(a.browseUrls) ? { ...a, locationResolved: false } : a
    );

    // One-time: a state account looks in the state's 10 biggest cities (see stateCities.ts). Ones that resolved their cities before that
    // was a fixed list got whatever the AI happened to name, so they resolve again the next time they start.
    if ((merged.stateCitiesVersion ?? 0) < 1) {
      merged.accounts = merged.accounts.map((a) => (a.locationMode === "state" ? { ...a, locationResolved: false } : a));
      merged.stateCitiesVersion = 1;
    }

    // Migrate configs saved before the "Search For" rename/simplification
    // — old referencePrices entries (which had a since-removed activeSearch
    // toggle) become searchItems, everything now unconditionally searched.
    if ((!merged.searchItems || !merged.searchItems.length) && Array.isArray(raw.referencePrices)) {
      merged.searchItems = raw.referencePrices.map((r: any) => ({
        item: r.item,
        typicalResaleUsd: r.typicalResaleUsd,
        matchKeywords: r.matchKeywords ?? [],
        minPriceUsd: null,
        maxPriceUsd: null,
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
    // settings, seller-risk filters, Date Listed, etc.) persists exactly as
    // saved until changed — those live on (or are reachable from) Config/
    // the Dashboard Filters area, not chat-only. Min/Max Price is the one
    // exception among "things you set per search item" that's still
    // session-scoped: it lives ON each (now-reset) searchItems entry rather
    // than as its own standing Config field.
    merged.searchItems = [];
    merged.customInstructions = "";
    merged.generalDeal = { ...merged.generalDeal, enabled: DEFAULT_CONFIG.generalDeal.enabled };

    return merged;
  } catch {
    // The file parsed but could not be used: keep a copy of it before anything can overwrite it with defaults.
    lastConfigLoadNotice = { kind: "reset", savedCopy: preserveCopy(configPath, "unreadable") };
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(configPath: string, config: Config): void {
  // Atomic (temp file, then replace) and the previous good file is kept as config.json.bak.
  writeFileAtomicWithBackup(configPath, JSON.stringify(config, null, 2));
}
