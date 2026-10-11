// One entry in the "Search For" list — something you specifically want
// found. Managed entirely through chat now (add_search_item/
// remove_search_item), not a Config screen. The scraper both actively
// searches for it (a dedicated keyword search at every location, every
// cycle) and matches it passively if encountered during normal browsing.
// typicalResaleUsd is the only source of pricing truth for it — the AI
// never substitutes its own guess.
// A product the user searched for before, with the price range it was searched with (Dashboard > "Recent searches").
export interface RecentSearch {
  item: string;
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
  includeBroken?: boolean;
  linkedProductId?: string | null;
  at: number;
}

export interface SearchItem {
  item: string;
  typicalResaleUsd: number;
  matchKeywords: string[];
  // Per explicit instruction — "if the ai already has prior knowledge on
  // the thing you are searching for, have it bring up an image from
  // Database... prompting the user with a popup asking if that's what
  // you're searching for": set when the user confirms that popup (see
  // Dashboard.tsx's addToSearchList and index.ts's products:findMatch),
  // pointing at the confirmed Database product's own id. When set,
  // scrapeEngine.ts prefers THIS specific product's reference photos for
  // vision comparison over the fuzzy name-based findMatchingProduct lookup
  // it would otherwise fall back to — an explicit, user-confirmed link
  // instead of a guess. Optional: an item added without a matching
  // Database entry (or where the user said "no, that's not it") has none,
  // and matching falls back to the existing fuzzy-name behavior.
  linkedProductId?: string | null;
  // Per explicit instruction — price range is PER-PRODUCT, not a single
  // global knob (Config used to have one maxPriceUsd/minPriceUsd shared by
  // everything on the Search For list — see the doc comment where that used
  // to live). Set once, at add time, via Dashboard's "Set a price range for
  // ___?" prompt (or add_search_item's own params from chat) — there's no
  // separate editing UI for it afterward; remove and re-add to change it.
  // Enforced two ways, same posture the old global fields had: as a hard
  // skip in scrapeEngine.ts's evaluateListing once this item is the one a
  // listing matched, and as the dedicated Facebook search's own minPrice/
  // maxPrice query params (scraper.ts's searchMarketplace) so the search
  // itself is scoped, not just filtered after the fact. null = no
  // floor/ceiling for this item.
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
  // INCLUDE broken / "for parts" listings (checkbox when adding it). It does not search for anything extra: the normal search
  // for this product is the only search. It means a broken listing that shows up in that search (an "Xbox Series X (Broken HDMI)"
  // under a plain "xbox" search) is taken seriously: priced against a "(For Parts / Broken)" variant of the product in the
  // Database (see brokenVariant.ts) that Clynx creates and researches, instead of being written off at a quarter of the working
  // price, and "for parts" titles are not rejected as mismatches.
  includeBroken?: boolean;
  // eBay only — set when this search target is an eBay Watch with a minimum
  // seller rating (see Watch.minSellerRatingPercent). Search For items never
  // carry one. Read by ebayEngine.ts, which drops results from sellers below
  // it before they go any further.
  minSellerRatingPercent?: number | null;
}

// Where a Watch looks. Chosen once, when the Watch is created, and not
// changeable afterward: the two platforms ask for different things (Facebook
// needs a location, eBay a seller rating), so switching would silently orphan
// half the Watch's settings.
export type WatchPlatform = "facebook" | "ebay";

// Per explicit instruction — "Watch: keep an eye out for this over time and
// alert me when it appears," persistent across app/scanner/account
// restarts, unlike SearchItem above (which is deliberately session-scoped —
// see config.ts's loadConfig, which resets searchItems on every launch).
// Stored in its own SQLite table (store.ts), not on Config, for exactly
// that reason. A Watch is evaluated by the SAME matching primitives a
// SearchItem is (matchSearchItem/findGreenFlagCandidate/
// evaluateSearchItemPricing in scorer.ts all only ever read item/
// matchKeywords/typicalResaleUsd/minPriceUsd/maxPriceUsd off a
// SearchItem-shaped object — a Watch row supplies those directly, no
// adapter type needed), but layers its own independent conditions
// (profit/discount/age/location) on top, checked against a reference price
// this domain derives itself (see watchMatching.ts) rather than the
// SearchItem-oriented scored.referencePriceUsd, which can be null whenever
// general (unverified) deal detection is off — an expected, normal
// operating state for a persistent Watch, unlike the momentary Search For
// session.
//
// Unrelated naming note: this is NOT the same concept as
// appendProductWatchNote/add_product_watch_note/ProductProfile.lookoutNotes
// elsewhere in this app — that's a pre-existing, unrelated AI-only
// per-product observation log. Pure English collision, not a code
// relationship.
// One thing a Watch looks out for. A Facebook Watch has several of these (it
// "waits" for any of them to turn up in its area); an eBay Watch has exactly one.
export interface WatchTerm {
  // What gets typed into Marketplace's search box.
  phrase: string;
  // Lowercase title keywords a listing has to contain to count as this product.
  matchKeywords: string[];
  // The Database product this term is, when it matched one (used for the
  // profit/discount conditions' reference price). Null otherwise.
  linkedProductId: string | null;
}

// The exact Facebook Marketplace search a Facebook Watch ran for one term at one
// place, kept so the user can open that very search in their browser. A state or
// whole-country Watch searches several places, so it has one per term and place.
export interface WatchSearchLink {
  term: string;
  place: string;
  url: string;
  checkedAt: number;
}

export interface Watch {
  // Send THIS Watch's notifications to a different ntfy topic than the one in Config (null: the Config topic). For a
  // Watch run for somebody else, e.g. a friend's area, so their finds go to their own phone only. Local-only (not cloud-synced).
  ntfyTopic: string | null;
  id: string;
  name: string;
  // Which marketplace this Watch looks on. Watches created before this field
  // existed were all Facebook Marketplace Watches, so the store defaults them
  // to "facebook". A "facebook" Watch is only ever checked by the Facebook
  // scanner/scheduler, an "ebay" one only by EbayEngine.
  platform: WatchPlatform;
  // The Watch's first term, kept as plain fields because the eBay engine, the
  // cloud mirror and older code all read a Watch as "one phrase". For a Facebook
  // Watch the full list is `terms` below, and that is what the Facebook side uses.
  searchPhrase: string;
  matchKeywords: string[];
  // Everything this Watch looks out for (see WatchTerm). Always at least one.
  terms: WatchTerm[];
  // Facebook Watches only: how often Clynx checks, in minutes (one of
  // watchOptions.ts's WATCH_INTERVAL_OPTIONS_MINUTES).
  checkIntervalMinutes: number;
  // Facebook Watches only: which of the user's Facebook accounts this Watch may
  // use. Empty = any account that is logged in.
  accountIds: string[];
  // Facebook Watches only: the searches it has run (see WatchSearchLink).
  searchLinks: WatchSearchLink[];
  // Optional link to a confirmed Database product — set via the same
  // "is this what you meant?" popup add_search_item's own linkedProductId
  // uses. When set, watchMatching.ts prefers this product's own
  // resalePriceUsd/ebayAvgSoldPriceUsd/live Facebook-avg pricing for
  // profit/discount conditions instead of guessing.
  linkedProductId: string | null;
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
  minProfitUsd: number | null;
  minDiscountPercent: number | null;
  // Minutes, not hours (Config.maxListingAgeHours' own unit) — deliberately
  // finer-grained since a Watch condition like "30 minutes" is a common,
  // meaningful ask that an hour-only field couldn't express.
  maxListingAgeMinutes: number | null;
  // eBay Watches only — skip listings from sellers whose positive-feedback
  // percentage (0-100) is below this. Null = no seller-rating requirement.
  // A seller eBay reports no percentage for (brand new, no feedback yet) does
  // not satisfy a set minimum.
  minSellerRatingPercent: number | null;
  // Per explicit instruction — "a Watch needs its own desired location
  // rather than blindly inheriting whatever location the Scanner currently
  // happens to be using." Mirrors Account's own location shape exactly
  // (locationMode/selectedState/selectedCityOrZip/searchRadiusMiles) so it
  // can drive the SAME locationDiscovery.ts's discoverLocation(page, city,
  // radius) resolution account onboarding already uses, with zero adapter
  // code.
  locationMode: "country" | "state" | "city";
  selectedState: string | null;
  selectedCityOrZip: string | null;
  searchRadiusMiles: number | null;
  // Resolved-location cache — populated once (see WatchScheduler), reused
  // on every scheduled active check thereafter rather than re-driving
  // Facebook's own "Change location" dialog per check. Null until the
  // active scheduler resolves it for the first time.
  resolvedLocationUrl: string | null;
  resolvedLocationLabel: string | null;
  resolvedLocationCheckedAt: number | null;
  // The same cache for a state or whole-country Watch, which search several
  // places instead of one: the Facebook Marketplace URL of each city that was
  // resolved (see ScrapeEngine.resolveWatchPlaces). Empty until resolved, and
  // cleared whenever the Watch's location is edited. A city/ZIP Watch uses
  // resolvedLocationUrl above and leaves this empty.
  resolvedLocationUrls: string[];
  // Per-watch pause, independent of the global config.watch.globallyPaused
  // "Pause All" switch — see Config's own watch field below for how the
  // two combine (effectiveEnabled = enabled && !globallyPaused).
  enabled: boolean;
  listingsSeenCount: number;
  matchCount: number;
  lastCheckedAt: number | null;
  lastActiveCheckAt: number | null;
  nextCheckAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// A confirmed Watch match — references the CANONICAL listings row rather
// than copying listing data, per explicit instruction ("reuse the
// canonical listing record"), so match history survives even after the
// real Facebook listing disappears (the local row is never deleted just
// because Facebook's own listing is gone). price/discount/profit are
// snapshotted AT MATCH TIME, separately from Watch's own live condition
// inputs above, since a listing's own scored fields can still change on a
// later re-save (vision re-pricing, bundle-value correction) — match
// history should reflect what was true when it matched, not whatever the
// live row says now.
export interface WatchMatch {
  id: string;
  watchId: string;
  listingId: string;
  matchedAt: number;
  foundByAccountId: string | null;
  foundByAccountLabel: string | null;
  discoveryMode: "passive" | "active";
  priceAtMatch: number | null;
  discountPercentAtMatch: number | null;
  profitUsdAtMatch: number | null;
  notified: boolean;
  notifiedAt: number | null;
}

// Per explicit instruction — support running MULTIPLE Facebook accounts
// concurrently, each its own persistent browser session (own login, own
// Playwright profile directory — see index.ts's PROFILES_ROOT) browsing
// its OWN location, all feeding into the one shared database/Feed/
// Database exactly like a single account already does (listing dedup
// already keys on Facebook's own item id, not anything session-local, so
// two accounts finding the same real listing was already safe before this
// existed). Confirmed with the user: accounts differ ONLY by location and
// login — every other setting (Search For list, price filters, deal
// threshold, seller-risk rules, etc.) stays a single shared Config field,
// not duplicated per account. This is exactly the location-related subset
// that used to live flat on Config itself (see the migration in
// config.ts's loadConfig, which wraps an old flat config's location
// fields into a single-item accounts array so upgrading loses nothing).
export interface Account {
  id: string;
  // User-facing name shown in Config's account roster and on Dashboard's
  // per-account Start/Stop row — purely cosmetic, no matching logic
  // depends on it.
  label: string;
  // Per explicit instruction — an account can be added without being
  // actively scanned yet (e.g. mid-setup, still needs a login). index.ts
  // still creates its ScrapeEngine either way (so "Log in" always works),
  // this only gates whether Dashboard's "Start all" includes it.
  enabled: boolean;
  // Base Marketplace URLs to rotate through — no query/search term, just
  // wherever "browse everything" lands for THIS account's location.
  // Radius is NOT set via these URLs (see the "Change location" dialog
  // flow); each URL just needs a different location center. The scraper
  // switches to the next one every listingsPerLocation evaluated
  // listings, since Facebook still seems to bias results toward whatever
  // location is current even with a large radius set.
  browseUrls: string[];
  // "country" is the original always-on behavior (browseUrls stays the
  // full nationwide spread); "state" replaces browseUrls with exactly one
  // resolved location for that state's single most populous/well-known
  // city (see locationDiscovery.ts's lookupPrimaryCityInState); "city"
  // replaces browseUrls with exactly one resolved location for a specific
  // city/ZIP the user typed in. Both go through the SAME "Change
  // location" dialog the radius check already drives. Only one of
  // selectedState/selectedCityOrZip is ever meaningful at a time, matching
  // whichever mode is active — both null in "country" mode.
  locationMode: "country" | "state" | "city";
  // Also doubles as the target for scrapeEngine.ts's listingStateMatches
  // filter in both "state" and "city" mode (in "city" mode it's the state
  // Facebook's OWN confirmation resolved the search to, not necessarily
  // anything the user typed) — this account's engine skips a listing
  // whose visible location doesn't match.
  selectedState: string | null;
  selectedCityOrZip: string | null;
  // The search radius applied to every browse location for THIS account
  // (see scrapeEngine.ts's runCycle, which re-verifies/corrects this once
  // per cycle). Defaults to 100. "state" mode overrides this to 40
  // automatically, "city" mode to 20 — both set live in the same "Change
  // location" dialog visit that resolves the location itself (see
  // index.ts's location:setMode); switching back to "country" resets it
  // to 100.
  searchRadiusMiles: number;
  // Per explicit instruction — "don't have it immediately open marketplace
  // after applying the setting, just save it until the user starts a
  // scan": changing locationMode/selectedState/selectedCityOrZip in Config
  // now only saves the CHOICE — it no longer opens a browser and drives
  // Facebook's own "Change location" dialog right away (see index.ts's
  // location:setMode, which used to do that eagerly). false here means
  // browseUrls/searchRadiusMiles may be stale for the currently-saved
  // mode/state/city; index.ts's resolveAccountLocationIfNeeded does the
  // actual resolution (opens a browser, looks up the primary city, drives
  // the dialog) the next time this account starts, and only then, setting
  // this back to true. Always true in "country" mode, which has nothing to
  // resolve (browseUrls is a static list).
  locationResolved: boolean;
  // Root-caused live: "country" mode's real resolution (see index.ts's
  // resolveAccountLocationIfNeeded and config.ts's DEFAULT_COUNTRY_CITIES)
  // drives Facebook's real "Change location" dialog for up to 48 cities,
  // paced ~15-20s apart to stay under Facebook's own anti-automation
  // throttling — a genuine 12-15 minute one-time cost. Closing the app (or
  // it crashing) partway through used to lose ALL of that work, since
  // locationResolved/browseUrls only ever got written once, after the
  // ENTIRE 48-city pass finished — reported live as "why does it need to
  // keep searching for them, it's already there," after restarting mid-run
  // repeatedly threw away real progress every time. This tracks each named
  // city's own outcome (its resolved URL, or null if that one attempt
  // failed) as it happens, persisted after EVERY city, not just at the end
  // — resolveAccountLocationIfNeeded only re-attempts cities missing here
  // or previously null, so a resumed run picks up where it left off
  // instead of starting the whole 48-city pass over. Undefined for an
  // account that's never started a country-mode resolution.
  countryCityProgress?: Record<string, string | null>;
}

export interface GeneralDealConfig {
  enabled: boolean;
  // How sure the AI has to be before flagging something outside your
  // Search For list. Defaults to "medium" (see config.ts) — per explicit
  // instruction, after a live miss where a genuinely good deal (a 3DS XL
  // bundle, reasoning fully concluding it should be flagged) got silently
  // skipped purely because its own confidence landed at "medium": most of
  // what "medium" actually represents is cosmetic missing detail (a model
  // variant, battery health, photos) a real seller just never typed, not
  // real doubt about the deal call itself — see scorer.ts's
  // extractGeneralDeal, which now also explicitly tells the AI not to
  // conflate the two. "high" is still available for a user who wants a
  // stricter bar.
  minConfidence: "medium" | "high";
}

export interface Config {
  // Per explicit instruction — multiple Facebook accounts, each its own
  // browser session/login/location, scanning CONCURRENTLY. See the
  // Account interface above for what each entry holds (this replaces the
  // old flat browseUrls/locationMode/selectedState/selectedCityOrZip/
  // searchRadiusMiles fields, which used to describe a single implicit
  // account — see config.ts's loadConfig for the migration that wraps an
  // old config's flat fields into a single-item array here). index.ts
  // keeps one ScrapeEngine per entry, each fed a synthesized Config that
  // merges this shared object with that one account's own location
  // fields — everything else on Config (below) stays a single shared
  // value read by every account's engine alike.
  accounts: Account[];
  listingsPerLocation: number;
  headless: boolean;
  pollIntervalMinutesMin: number;
  pollIntervalMinutesMax: number;
  dealThresholdPercent: number;
  // What the user keeps of an eBay sale after eBay's cut (~13.75%) and other costs, as a percent of the sold price.
  // The user's own rule of thumb is 84% (their range 80-86%). See resaleMath.ts.
  ebayNetPercent: number;
  // A purchase is a deal when (money kept - what it costs) is at least this share of the money kept.
  minProfitMarginPercent: number;
  // A deal that would need negotiating more than this many percent below the asking price to reach that margin is skipped (not
  // flagged, no notification). Default 15.
  maxNegotiationPercent: number;
  // Bookkeeping for a one-time re-resolution of state accounts' cities (see config.ts); 1 once done.
  stateCitiesVersion?: number;
  // "Save OpenAI credits" (on by default): everything that isn't a core function runs without AI or doesn't run. See aiMode.ts.
  lowAiMode: boolean;
  // The last products searched for (newest first) with their price ranges, kept across restarts so they can be added again in one
  // click (the Search For list itself resets every launch).
  recentSearches: RecentSearch[];
  // The user's own eBay seller username, once they link their store (Config > Your eBay store); empty when not linked. Their
  // own listings become a separate price reference on each product (ProductProfile.myStore).
  ebayStoreUsername: string;
  searchItems: SearchItem[];
  generalDeal: GeneralDealConfig;
  // Free-text guidance appended to every AI scoring prompt (both the
  // Search For and general-deal pathways) — deal-finding criteria only, e.g. "prefer
  // sealed/unopened items" or "ignore anything missing original box for
  // collectibles." Not a general system-prompt override; it's inserted
  // alongside the fixed task instructions, not in place of them.
  customInstructions: string;
  ntfy: {
    server: string;
    topic: string;
  };
  sellerRisk: SellerRiskConfig;
  // AI photo analysis via OpenAI's vision capability (same provider as
  // everything else — see openai.ts). Runs on confirmed deals as
  // enrichment, and also early (before giving up) on a Search For match
  // that doesn't clear the price bar on the base item alone, in case
  // photos show a valuable bundle the listing text never mentioned.
  photoAnalysis: { enabled: boolean };
  // How old a listing can be before it's skipped as stale — see
  // scrapeEngine.ts's isListingTooOld (the actual guarantee, applied after
  // any listing is opened, search or passive-browse alike) and scraper.ts's
  // applyDateListedFilter (a best-effort live click on Facebook's own
  // "Date listed" filter, search pathway only, to avoid even opening stale
  // listings in the first place). null = no cap — show listings of any age.
  // Per explicit instruction, this used to be a fixed "no more than a day
  // old" assumption; now the user's own choice.
  maxListingAgeHours: number | null;
  // Per explicit instruction — a real Config-level setting (not a
  // renderer-only preference) so it round-trips through the same
  // getConfig/saveConfig path as everything else on this screen. "dark" is
  // this app's original, only-ever-shipped appearance; "light" is the new
  // alternate palette (see global.css's [data-theme="light"] block).
  theme: "dark" | "light";
  // Per explicit instruction ("instead of choosing colors, allow the user
  // to use a color wheel to pick a primary and accent color") — replaces
  // an earlier fixed-preset scheme picker with two freely-chosen hex
  // colors. Defaults are this app's original purple/blue accents, so a
  // fresh config still looks exactly like it always has ("keep the
  // purple/blue color scheme as the default"). See the renderer's
  // lib/colorScheme.ts (applyColorScheme) for how these two colors get
  // turned into every derived CSS custom property (gradients, borders,
  // glows, and the background tint itself) — orthogonal to theme, which
  // still separately controls light vs. dark surfaces.
  primaryColor: string;
  accentColor: string;
  // Per explicit instruction — a "rainbow" color scheme: instead of the two
  // fixed colors above, the app slowly fades through the whole spectrum
  // (see the renderer's lib/colorScheme.ts startRainbow). primaryColor/
  // accentColor are kept untouched underneath, so turning this off returns
  // to exactly the colors that were picked. Defaults off.
  rainbowEnabled: boolean;
  // Per explicit instruction — "make the background on every panel slightly
  // transparent... I want the background to be visible at all times": how much
  // of the animated space background shows through the app's panels (cards,
  // the sidebar), as a percentage from 0 (solid panels) to 90 (nearly clear).
  // Applied live as the `--panel-opacity` CSS variable — see the renderer's
  // lib/colorScheme.ts applyPanelTransparency. Modals, the assistant chat and
  // small inner chips always stay solid so text over other content stays legible.
  panelTransparency: number;
  // Per explicit instruction — a single on/off switch for every app sound
  // (start/stop bloops, tab-switch tick, the deal-alert chime), not a
  // per-sound toggle. Defaults true — existing behavior unchanged until
  // someone deliberately turns it off. See lib/sound.ts's setSoundEnabled.
  soundEnabled: boolean;
  // A Windows notification when a Watch finds something (on by default). The phone
  // push (ntfy) is separate and only happens when a topic is set.
  desktopNotifications: boolean;
  // Per explicit instruction — a Config "No particles" switch that turns
  // off BOTH the cursor-reactive starfield background (see
  // StarfieldBackground.tsx) and the per-click particle bursts (see
  // ClickParticles.tsx) in one toggle, for anyone who'd rather have a
  // plain, static UI (a slower machine, a preference, whatever). Defaults
  // true (particles ON) — existing behavior unchanged until someone
  // deliberately turns it off. See the renderer's lib/particles.ts for how
  // this reaches App.tsx live, the same "preview before Save" posture as
  // theme/colorScheme/soundEnabled above.
  particlesEnabled: boolean;
  // Per explicit instruction — a master on/off for whether the scanner
  // automatically searches WatchCount.com for eBay sold comps at all,
  // separate from watchCountOncePerScan below (which only throttles HOW
  // OFTEN it happens, not whether it happens). Turning this off skips the
  // automatic lookup inside runProductLookup entirely (index.ts) — the
  // manual "refresh eBay comps" button on a product's own Database page is
  // a deliberate one-off action and stays available regardless, same
  // reasoning as why that button already ignores watchCountOncePerScan.
  // Defaults on — existing behavior unchanged until turned off in Config.
  watchCountEnabled: boolean;
  // Per explicit instruction — "if it finds an xbox series x within a
  // scan, there's no reason to search watchcount multiple times." Once a
  // given product has had an eBay comps lookup during the CURRENT scan
  // session (tracked in-memory on the engine, reset every time it starts —
  // see scrapeEngine.ts's ebayResearchedProductIds), any further research
  // pass for that same product (a re-match, a manual Refresh, "Interested"
  // reinforcement, whatever triggers index.ts's runProductLookup again)
  // skips the watchcount step entirely rather than spending another one of
  // its limited daily lookups on data that hasn't had time to change.
  // Defaults on — there's rarely a reason to want the opposite.
  watchCountOncePerScan: boolean;
  // Per explicit instruction — reversing an earlier decision to make this a
  // single GLOBAL "max I'll pay" (Config.maxPriceUsd/minPriceUsd used to
  // live here): "they may want to have multiple products with multiple
  // different min/max prices... each time they set one of those parameters
  // should only apply to the product they're trying to search." Now lives
  // on SearchItem instead — see minPriceUsd/maxPriceUsd below.
  // Per explicit instruction — bypasses the Blacklist term/image checks
  // (see store.ts's isBlacklisted and scrapeEngine.ts's blacklisted-image
  // handling) without having to clear the actual blacklist out, so a
  // temporary broadening of what the scanner will look at doesn't cost the
  // curated list built up over time. Does NOT affect the separate,
  // unconditional UNSHIPPABLE_PATTERNS category skip (vehicles, real
  // estate, furniture, ...) — that's a fixed reflection of this being a
  // mail-order-only business, not something toggled by this setting.
  ignoreBlacklist: boolean;
  // Per explicit instruction — controls whether the scanner auto-creates a
  // BRAND NEW Database entry the moment it confidently identifies something
  // it doesn't already track (see scrapeEngine.ts's researchSubjects loop /
  // onNewProductFound). Already-tracked products still get reinforced
  // (photos/observations added) either way — this only gates spawning new
  // ones automatically; turning it off means new products only ever get
  // added when the user explicitly asks (the Feed Research button, or the
  // Database chat). Defaults to true, matching the behavior this app has
  // always had.
  autoResearchListings: boolean;
  // Per explicit instruction — condition-awareness for the Database side:
  // gates BOTH (a) vision.ts detecting visible flaws in listing photos
  // (ListingCard's yellow-outline "?" badge) and (b) automatic product
  // research also searching for a poor-condition/damaged reference photo,
  // not just a clean one (see webResearch.ts's findPoorConditionProductImage).
  // One toggle for both, confirmed — "condition awareness" is one on/off
  // switch, not two. Defaults false: unlike autoResearchListings above,
  // this is new, unproven prompt surface with a real extra cost (a second
  // web-image search per product) — off until the user opts in, same
  // posture as ignoreBlacklist. Also silently does nothing for (a) unless
  // photoAnalysis.enabled above is ALSO on, since flaw detection piggybacks
  // on that same vision call rather than running independently.
  researchCondition: boolean;
  // Per explicit instruction — Facebook only lets you actively search ONE
  // thing at a time, so with more than one Search For item there's a real
  // choice in how the scanner splits its attention between them (see the
  // Dashboard Filters box's "Rotate search terms" checkbox). When true,
  // only ONE item is ever actively searched at once, switching to the
  // next after rotateSearchItemsCount listings have been evaluated for
  // it — deliberately on its OWN clock, independent of location rotation
  // (see scrapeEngine.ts's activeSearchItemIndex/
  // listingsSinceItemRotation): switching location never advances or
  // resets this, and hitting the count never forces a location switch
  // either. When false, no dedicated per-item searching happens at all —
  // the scanner just browses generally and only evaluates listings that
  // already look relevant to something on the Search For list, moving to
  // the next location as soon as nothing of interest turns up there
  // rather than grinding through a full location's worth of unrelated
  // listings (see runCycle's "general search" branch). Meaningless (and
  // ignored) with 0 or 1 Search For items — that case always just
  // searches for the one item, same as before this setting existed.
  rotateSearchItems: boolean;
  rotateSearchItemsCount: number;
  // Per explicit instruction — Watch's own global controls, deliberately
  // NOT on the watches table itself (see store.ts) since these are app-wide
  // toggles/bookkeeping, same home as photoAnalysis/ntfy above.
  // globallyPaused is the "Pause All" switch — combines with each Watch's
  // own `enabled` (effectiveEnabled = watch.enabled && !globallyPaused)
  // without destroying individual per-watch pause state on a bulk
  // pause/resume. matchesLastViewedAt drives the Sidebar's unseen-match
  // pulse indicator (a match newer than this timestamp exists) — visiting
  // the Watch screen just bumps this one value rather than an UPDATE per
  // match row.
  watch: {
    globallyPaused: boolean;
    matchesLastViewedAt: number;
  };
  // Clynx Cloud Phase 1 — a purely additive, off-by-default foundation for
  // an eventual cloud-connected mode (see cloudClient.ts). Optional so an
  // existing config.json with no idea this field exists still parses fine;
  // config.ts's DEFAULT_CONFIG supplies { enabled: false } for a fresh
  // install too. Nothing in the existing scanner/Watch/Database pathways
  // reads this — only index.ts's own small heartbeat/status wiring does.
  cloud?: {
    enabled: boolean;
    apiUrl?: string;
  };
  // A second listing source alongside the Facebook accounts above — eBay's
  // own Browse API (REST, OAuth client-credentials, no browser/login/
  // per-account model needed at all, see ebayClient.ts), searched
  // automatically for every Search For item and enabled Watch once turned
  // on. Optional/off-by-default for the same config.json-forward-compat
  // reason cloud above is. Credentials (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET)
  // live in .env, not here — same precedent OPENAI_API_KEY originally had.
  ebay?: {
    enabled: boolean;
  };
  // Per explicit instruction ("facebook or ebay or both") — Facebook has no
  // single global on/off elsewhere (only per-account enabled + manual
  // Dashboard Start/Stop); this gates the Dashboard's "Start all accounts"
  // convenience action so the toggle reads symmetrically with ebay.enabled
  // above. Optional, defaults true (config.ts's DEFAULT_CONFIG) so an
  // existing install's accounts keep starting exactly as before.
  facebookEnabled?: boolean;
}

// First UI status readout (see Config.tsx's Cloud Sync section) — the
// shape each of the 4 background sync services' own getStatus() returns
// (watchSync.ts/feedbackSync.ts/productSync.ts/listingIngestSync.ts).
// lastAt marks the end of the most recently COMPLETED sync tick (whether or
// not something inside it failed); lastError is whatever the most recent
// failure inside that tick reported, cleared the next time a tick runs
// clean. Both null before a service's first tick has ever run (e.g. cloud
// sync just got enabled, or the app just started and the 15s startup delay
// hasn't elapsed yet).
export interface SyncStatus {
  lastAt: number | null;
  lastError: string | null;
}

// Aggregates CloudClient.getStatus() plus all 4 sync services' own
// SyncStatus into the one response ipcMain.handle("cloud:getStatus")
// returns (see index.ts) — everything Config.tsx's read-only Cloud Sync
// section needs to answer "is this actually working right now" without the
// user reading terminal logs or querying Postgres directly.
export interface CloudStatus {
  enabled: boolean;
  apiUrl: string | null;
  authenticated: boolean;
  deviceId: string | null;
  heartbeat: SyncStatus;
  sync: {
    watches: SyncStatus;
    feedback: SyncStatus;
    products: SyncStatus;
    listings: SyncStatus;
  };
}

// What a single ScrapeEngine instance actually reads (scrapeEngine.ts's
// own getConfig callback returns this, not Config) — the shared Config
// object plus ONE account's own location fields flattened back onto it,
// synthesized live in index.ts per engine. This is what lets
// scrapeEngine.ts keep reading config.browseUrls/locationMode/
// selectedState/selectedCityOrZip/searchRadiusMiles exactly as it always
// has, with zero internal changes, despite those fields now living on
// Account instead of Config.
export type EngineConfig = Omit<Config, "accounts"> & Account;

export interface ListingSummary {
  id: string;
  url: string;
  title: string;
  price: number | null;
  thumbnailUrl: string | null;
  locationText: string | null;
  // Facebook shows a "Just listed" badge on a freshly posted listing's card. Captured
  // from the search results (see scraper.ts's parseListingCard) so it can be shown.
  justListed?: boolean;
  // Which marketplace this listing came from. Optional and undefined at
  // every existing Facebook Marketplace construction site (scraper.ts) —
  // undefined means "facebook" everywhere this is read, so adding eBay as a
  // second source required zero changes to any FB code path. Only ever set
  // explicitly to "ebay" by ebayNormalize.ts.
  source?: "facebook" | "ebay";
}

export interface SellerSignals {
  joinedFacebookYear: number | null;
  rating: number | null;
  ratingCount: number | null;
  hasProfilePhoto: boolean | null; // null = couldn't determine from the page
  // Best-effort, pulled from the avatar image's alt text ("<name>'s profile
  // picture") — the only place a plain-text name reliably shows up in the
  // markup this app can see. Null when that alt text isn't found/parseable.
  name: string | null;
  // eBay's own trust signals — deliberately separate fields, never aliased
  // into rating/ratingCount above. eBay's feedbackPercentage is a 0-100
  // scale; rating above is a 0-5 star scale (see Config.tsx's
  // StarRatingPicker) — blending the two would silently make every eBay
  // seller look like a ~99-star seller and defeat minRating filtering
  // entirely. sellerRisk.ts's evaluateSellerRisk never reads these two (it
  // only knows about rating/joinedFacebookYear/etc, all left undefined for
  // an eBay listing) — they exist purely for notify.ts's own eBay-
  // appropriate trust line. Optional (not `| null`), same reasoning as
  // ListingSummary.source above — undefined at every existing Facebook
  // construction site, no changes needed there.
  ebayFeedbackScore?: number;
  ebayFeedbackPercentage?: number;
}

export interface ListingDetail extends ListingSummary {
  // eBay only: the seller's shipping charge in USD (0 = free). null/undefined = not stated.
  ebayShippingUsd?: number | null;
  description: string;
  shippingMentioned: boolean;
  seller: SellerSignals;
  // Best-effort — every photo found on the listing page, not guaranteed
  // complete (see the note in scraper.ts), and with an obvious video
  // thumbnail/poster frame already filtered out (see hasVideo below). Fed
  // to vision.ts's analyzeListingPhotos for the app's real AI photo
  // analysis, and used directly as reference/thumbnail photos elsewhere.
  imageUrls: string[];
  // Per explicit instruction — "sometimes the ai will come across sellers
  // that have videos in their listings": true when scraper.ts's
  // fetchListingDetail found a <video> element on the listing page. Passed
  // through to analyzeListingPhotos so it can warn the model that one of
  // the numbered photos might actually be a frame from that video rather
  // than a genuine standalone photo (see PhotoAnalysisResult.
  // titleMatchPhoto) — the video itself is never downloaded or analyzed,
  // only its possible presence among the "photos" is accounted for.
  hasVideo: boolean;
  // Per explicit instruction — a listing already set up through Facebook's
  // own shipping program (its own "Ships for $X," "Estimated arrival,"
  // "Door dropoff" wording) isn't a hidden local deal — it's already
  // visible and buyable by every other reseller nationally through
  // Facebook's own logistics, the opposite of what this app is hunting
  // for. Checked in scrapeEngine.ts's evaluateListing as an instant skip.
  hasOfficialShipping: boolean;
  // Same idea, same instant-skip treatment — a listing that mentions eBay
  // implies it's already cross-listed/benchmarked elsewhere, not a private
  // local find.
  mentionsEbay: boolean;
  // Facebook's own relative phrasing verbatim ("Listed 3 weeks ago"), not
  // parsed into a date — its precision is already vague (weeks, not days),
  // so converting it to an absolute timestamp would just be manufacturing
  // false precision. Null when it couldn't be found on the page.
  listingAge: string | null;
}

export interface SellerRiskConfig {
  enabled: boolean;
  minAccountAgeYears: number; // e.g. 1 -> exclude accounts created within the last year
  minRating: number | null; // e.g. 3.5; null = don't check
  minRatingCount: number | null; // some sales history required; null = don't check
  maxRatingCount: number | null; // flag likely resellers with a lot of ratings; null = don't check
  requireProfilePhoto: boolean;
}

export interface SellerRiskResult {
  passed: boolean;
  reasons: string[]; // human-readable reasons it failed (empty if passed)
}

export interface ExtractionResult {
  matchedItem: string | null;
  extractedAttributes: string;
  conditionImpact: "none" | "minor" | "major" | "unknown";
  confidence: "low" | "medium" | "high";
  reasoning: string;
  // Set when this broken / for-parts listing was priced from a Database "(For Parts / Broken)" variant (its name): the alert and
  // the pre-alert market check then use that variant instead of the working product.
  brokenVariant?: string;
}

// "search" = matched one of your Search For items; the discount math is
// precise arithmetic against a price you vetted yourself.
// "general" = didn't match anything you configured, but the AI's own
// (unverified, possibly wrong) sense of typical value thinks it's a steal.
// Treat "general" with real skepticism — there's no vetted price behind it.
export type DealTier = "search" | "general" | null;

export interface ScoredListing {
  listing: ListingDetail;
  // Extras that come with the item (a bundled game, an expansion card) and what they add to its eBay value, when Clynx spotted some:
  // the whole lot is judged against the price, not just the base item (see profitGate.ts).
  bundleValueUsd?: number | null;
  bundleDescription?: string | null;
  extraction: ExtractionResult;
  referencePriceUsd: number | null;
  discountPercent: number | null;
  isDeal: boolean;
  dealTier: DealTier;
  estimatedValueRange: string | null; // only set for "general" deals
  // Only ever set on the general (unverified) pathway — the AI's own
  // suggestion for a blacklist term when a listing looks fundamentally
  // unrelated to a mail-order resale business (real estate, rentals, job
  // postings, services, event tickets...) rather than just an
  // uninteresting-but-legitimate resalable item. scrapeEngine.ts auto-adds
  // this to the blacklist (see store.ts's addBlacklistTerm) so the exact
  // same kind of listing gets skipped deterministically next time, without
  // spending another AI call on it.
  offTopicSuggestion: string | null;
}

// --- App-level records (persisted + sent to the renderer) ---------------

export type FeedbackVerdict = "good" | "bad";

// A past listing the user gave a thumbs up/down on (Feed's feedback
// buttons), used as few-shot context to steer future general-deal
// judgments — see store.ts's getFeedbackExamples and scorer.ts's
// extractGeneralDeal. "reasoning" is the AI's OWN original reasoning for
// that listing, included alongside the user's verdict/note so the model
// can see both what it concluded AND whether the user agreed.
export interface FeedbackExample {
  title: string;
  verdict: FeedbackVerdict;
  note: string | null;
  reasoning: string;
}

// A visible condition flaw (a crack, a missing part, damage) vision.ts's
// own photo analysis noticed in one specific listing photo — whether or not
// the seller's own text mentioned it. Deliberately mirrors ListingDetail's
// existing photoAttribution shape (same boundingBox convention: fractional
// 0-1, top-left origin) rather than inventing a new one, since it's the
// exact same "point at a region of a specific photo" concept, just for a
// flaw instead of a product. Gated entirely behind Config.researchCondition
// — empty array whenever that's off.
export interface PhotoFlaw {
  photoNumber: number;
  description: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence: "low" | "medium" | "high";
}

// One past flaw flag the user confirmed or denied (ListingCard's "?" badge,
// see vision.ts's buildFlawFeedbackExamplesBlock) — the exact same few-shot-
// training-example idea as FeedbackExample above, just keyed to one flagged
// photo instead of a whole listing's deal verdict. listingTitle is
// denormalized (not a join against listings) so the few-shot prompt block
// never needs one.
export interface FlawFeedbackExample {
  listingTitle: string;
  description: string;
  confidence: "low" | "medium" | "high";
  confirmed: boolean;
}

export interface ListingRecord {
  id: string;
  // Facebook's "Just listed" badge was on this listing when it was found.
  justListed: boolean;
  // The Watches that matched this listing (by name), so Feed can flag a Watch's finds.
  watchNames: string[];
  // Which marketplace this listing came from — Feed's source filter and the
  // Dashboard's Facebook/eBay badges read this. Rows saved before eBay
  // existed have no source and are all Facebook (store.ts's rowToRecord).
  source: "facebook" | "ebay";
  title: string;
  price: number | null;
  url: string;
  thumbnailUrl: string | null;
  imageUrls: string[];
  // The seller's own listing text, verbatim from the Facebook page — shown
  // in the Feed in place of the AI's reasoning, per explicit instruction,
  // since the actual description is more directly useful for judging a
  // listing than the AI's own summary of why it scored it the way it did.
  // Capped to the same 4000 chars scoring itself sees (see scraper.ts's
  // fetchListingDetail) — not the full raw page text, just whatever
  // portion the app ever looks at.
  description: string;
  locationText: string | null;
  listingAge: string | null;
  matchedItem: string | null;
  referencePriceUsd: number | null;
  discountPercent: number | null;
  conditionImpact: ExtractionResult["conditionImpact"];
  confidence: ExtractionResult["confidence"];
  reasoning: string;
  extractedAttributes: string;
  shippingMentioned: boolean;
  isDeal: boolean;
  dealTier: DealTier;
  estimatedValueRange: string | null;
  notified: boolean;
  firstSeenAt: number;
  feedback: FeedbackVerdict | null;
  feedbackNote: string | null;
  sellerName: string | null;
  sellerJoinedYear: number | null;
  sellerRating: number | null;
  sellerRatingCount: number | null;
  // eBay only: the seller's positive-feedback percentage (0-100) and the listing's shipping charge in USD (0 = free).
  // null on Facebook listings and on eBay listings saved before these were recorded.
  sellerFeedbackPercent: number | null;
  shippingCostUsd: number | null;
  sellerHasProfilePhoto: boolean | null;
  sellerRiskPassed: boolean;
  sellerRiskReasons: string[];
  // OpenAI vision photo analysis — null means "not checked yet" or
  // "checked but nothing usable came back"; photoAnalysisCheckedAt
  // disambiguates.
  photoAnalysis: string | null;
  photoAnalysisCheckedAt: number | null;
  // Structured flaws vision.ts's photo analysis noticed (see PhotoFlaw's own
  // doc comment) — always [] unless Config.researchCondition was on when
  // this listing was analyzed. ListingCard uses this to outline whichever
  // carousel photo matches the currently-displayed one in yellow.
  photoFlaws: PhotoFlaw[];
  // Per explicit instruction — Feed's "est. value" used to show the general
  // (unverified) pathway's own AI-guessed range unconditionally, which is
  // exactly a guess with no real data behind it. This is real data instead:
  // the matched product's own average watchcount/eBay sold price (see
  // store.ts's enrichWithMatchedProductPricing, looked up fresh at read
  // time via the same fuzzy findMatchingProduct used everywhere else) —
  // null whenever there's no matched item, or that product has never had a
  // watchcount comps pass run. The UI (ListingCard.tsx) only shows anything
  // here at all when this is set AND the listing's own price lands within
  // 10% of it.
  matchedProductAvgSoldPriceUsd: number | null;
  // The same matched product's average watchcount/eBay TIME TO SELL, in
  // days — the "Best Deals" panel on Dashboard shows this alongside the
  // average sold price above (see enrichWithMatchedProductPricing, same
  // lookup, same null cases).
  matchedProductAvgRunTimeDays: number | null;
  // Per explicit instruction — multi-account scanning: which account's
  // browser session actually found this listing, so the user knows which
  // Facebook login to act from (message the seller, mark interested,
  // etc.) — that session is the one with this listing actually loaded.
  // Null for anything found before multi-account existed, or if that
  // account has since been removed (see index.ts's account-removal path,
  // which deliberately leaves past listings' attribution alone rather
  // than blanking it out).
  foundByAccountId: string | null;
  foundByAccountLabel: string | null;
}

// A user-curated product "database" entry. aiSummary is built from a real,
// in-depth live web search done for this exact product (see webResearch.ts)
// — not just the model's own memorized training knowledge, and explicitly
// not a source of pricing on its own (your own numbers are still what
// counts as verified). Matched into scoring prompts by name against Search
// For items to give the AI more to work with when judging genuine-match/
// condition.
export interface MyStoreReference {
  seller: string;
  medianUsd: number;
  lowUsd: number;
  highUsd: number;
  sampleSize: number;
  items: Array<{ title: string; priceUsd: number; url: string }>;
  checkedAt: number;
}

export interface ProductProfile {
  id: string;
  name: string;
  aiSummary: string;
  aiSummaryGeneratedAt: number | null;
  // Running log of things actually observed on real Facebook listings while
  // scanning — condition notes, bundle contents, identifying details the
  // AI noticed — appended to over time (newest last), separate from
  // aiSummary above which comes from the one-time web research pass.
  // Builds up automatically as the scraper evaluates listings for this
  // product, whether or not any given listing turned out to be a deal.
  observedNotes: string;
  // One of chat.ts's fixed PRODUCT_CATEGORIES, assigned by the AI during
  // research — drives grouping in the Database UI. "Other" (not null)
  // until research actually assigns a real one, so the UI never has to
  // handle an unset case separately from the deliberate catch-all.
  category: string;
  // Per explicit instruction — a second, finer grouping tier WITHIN
  // category: the broader product line/brand this specific SKU belongs to
  // (e.g. "Xbox Series X", "Xbox Series X Controller", and "Minecraft
  // (Xbox)" all share family "Xbox"), so the Database UI can fold related
  // items under one master tile instead of listing every console,
  // controller, and bundled game as flat, unrelated entries. Assigned by
  // the AI during the same research pass as category (see chat.ts's
  // categoryAndFamilyInstructions), then normalized against whatever family
  // names already exist in the Database (see store.ts's resolveFamilyName)
  // so "Xbox" doesn't drift into "XBOX"/"Microsoft Xbox" across separate
  // research calls that never see each other's output — same drift problem
  // category's fixed enum exists to avoid, just without a fixed list since
  // there's no bounded set of possible brands/product lines. Null (not a
  // catch-all string) when nothing meaningfully groups — a one-off item
  // with no natural family shows directly in its category, ungrouped.
  //
  // Per further explicit instruction, this can be a MULTI-LEVEL path — a
  // single string with levels separated by " > ", e.g. "Xbox > Games >
  // Xbox 360" — for a sub-grouping that genuinely needs its own level
  // within a family (games look and only work with one specific console
  // generation, so they nest under "<family> > Games > <generation>"
  // rather than sitting flat alongside the consoles/controllers
  // themselves). The Database UI (see Database.tsx's buildFamilyTree)
  // parses this into a tree per category; most products still just have a
  // single-level family.
  family: string | null;
  // Per explicit instruction — when the TOP-LEVEL segment of family is
  // itself a well-known, official brand/company name (Nintendo, Nike,
  // Xbox, Apple, Dyson, ...) rather than a grouping the AI just invented
  // to organize things (see chat.ts's categoryAndFamilyInstructions —
  // isBrandFamily), this is that brand's own logo — found via web image
  // search for "<brand> logo" (see webResearch.ts's findProductImage,
  // index.ts's runProductLookup) and downloaded as a data: URI, same as
  // imageUrl. Used as the FOLDER tile's thumbnail for that top-level
  // family in the Database UI (see Database.tsx's FamilyTile) instead of
  // a member product's own photo — a folder representing a real brand
  // should look like that brand, not like whichever one of its products
  // happened to get a photo first. Stored redundantly on every product in
  // that top-level family (same denormalized pattern as category/family
  // themselves — this app has no separate "families" table), so any
  // member can supply it; store.ts's getFamilyLogoUrl is what lets a
  // second product in the same family reuse the first one's fetched logo
  // instead of searching for it again. Null when the family isn't a
  // recognized brand, or a logo search hasn't found one yet.
  familyLogoUrl: string | null;
  // A representative product photo found during web research (that page's
  // og:image, i.e. its own link-preview image) — best-effort, unverified
  // against any real listing, just a visual reference for the card. Null
  // until research finds one (or if it never does).
  imageUrl: string | null;
  // Manually entered by the user, never touched by research or scanning —
  // what THEY actually sold this exact product for on eBay before (and how
  // long it took), as opposed to aiSummary's web-sourced, unverified specs.
  // Real personal sales history a reseller has is worth more than generic
  // research, so this is surfaced back to the Database chat (see
  // buildDatabaseSystemPrompt) once it's set. Both null until the user
  // fills them in on the product's own page.
  resalePriceUsd: number | null;
  resaleTimeToSell: string | null;
  // Per explicit instruction — what the user is actually willing to pay for
  // this exact product, set right alongside the resale-history fields
  // above. Distinct from a SearchItem's own minPriceUsd/maxPriceUsd (which
  // only exist once the product is actively being searched for) — this
  // lives on the Database entry itself, so it applies to a product the user
  // is just tracking/researching too, independent of whether it's on the
  // Search For list at all.
  // Trains the AI's judgment toward what THIS user considers worth paying,
  // same spirit as store.getFeedbackExamples. Null until the user sets one.
  desiredPriceUsd: number | null;
  // When true, a listing recognized as this product (by Search For keyword
  // match OR photo/vision identification — see scrapeEngine.ts's
  // evaluateListing) priced above desiredPriceUsd is skipped outright,
  // never counted as a deal regardless of how good the discount otherwise
  // looks. Meaningless without desiredPriceUsd also set. Defaults to false
  // — the desired price alone is guidance, not an enforced ceiling, unless
  // the user explicitly turns this on.
  hardCapAtDesiredPrice: boolean;
  // Per explicit instruction — a manual "this one's noteworthy" flag the
  // user sets directly on a product's own Library tile (a star icon), NOT
  // something the AI sets itself. Per explicit instruction, this must NEVER
  // auto-add the product to the Search For list or otherwise change what
  // the user is actively searching for/filtering on — it's purely
  // informational context the AI can see and act on judgment, not a
  // mechanical trigger. See scrapeEngine.ts's runPhotoAnalysis
  // (prioritized products always join the vision "reference" set, not just
  // the 3 most recently touched) and the Database/global system prompts
  // (chat.ts), which surface which products are currently prioritized so
  // the AI treats finding more of them as worth extra attention.
  prioritized: boolean;
  // Practical things to actively check for in real listings of this
  // product — set by the user via that product's own Database chat (see
  // chat.ts's add_product_watch_note), e.g. "games are often bundled in
  // and add real resale value, check photos for game cases/discs." Read
  // fresh from the DB on every relevant listing evaluation (see
  // scrapeEngine.ts's runPhotoAnalysis), so a note added here takes effect
  // on live scanning immediately, not just on the next research pass.
  lookoutNotes: string;
  // True once the user has manually picked their own thumbnail (see
  // products:pickThumbnail in index.ts) — research/refresh then skips
  // overwriting imageUrl, so a fresh web search result can't silently
  // replace a photo the user deliberately chose.
  keepThumbnail: boolean;
  // Per explicit instruction — "look at eBay listings" for real sold-comp
  // data: watchcount.com's sold-listings search (see watchcount.ts),
  // averaged across whichever comps the AI judged as genuinely the same
  // base product (not a special/limited edition or different bundle —
  // see analyzeEbayComps). Null until a research pass has actually run
  // this; ebayCompsSampleSize of 0 (as opposed to null) means it DID run
  // but found no comps it trusted as genuine matches, worth distinguishing
  // from "never checked" in the UI.
  ebayAvgSoldPriceUsd: number | null;
  ebayAvgRunTimeDays: number | null;
  ebayAvgShippingUsd: number | null;
  ebayCompsSampleSize: number | null;
  ebayCompsCheckedAt: number | null;
  // What eBay sellers are asking right now for this product (median of the active Buy-It-Now listings that are
  // really this product), and how many listings that is. null/0 until a comps pass finds at least 3.
  ebayActiveMedianUsd: number | null;
  ebayActiveSampleSize: number | null;
  // Clynx's overall estimate of what this product sells for: the sold average, nudged toward the asking prices
  // when there are few sold comps. ebayEstimateBasis says what it rests on: "sold", "blend" (sold + asking) or
  // "active" (no sold comps, asking prices only). null until researched.
  ebayEstimatedValueUsd: number | null;
  ebayEstimateBasis: "sold" | "blend" | "active" | null;
  // What the user's own linked eBay store lists this product for (separate from the market numbers above). null when no
  // store is linked or none of its listings is this product.
  myStore: MyStoreReference | null;
  // A specific model filed under a more generic Database entry (e.g. "EVGA GeForce RTX 3060 Ti XC" under
  // "NVIDIA GeForce RTX 3060 Ti"). null for an ordinary top-level entry.
  parentProductId: string | null;
  loading: boolean;
  createdAt: number;
  // Clynx Cloud Phase 6 — bumped on every mutating product write (see
  // store.ts's addProductStub/createManualProduct/updateProductProfile/
  // updateProductEbayComps/editProductProfile/appendProductWatchNote/
  // recordProductObservation/setProductLoading), same purpose as Watch's own
  // updatedAt: the last-write-wins comparison productSync.ts's push/pull use
  // against the cloud mirror (see cloud/src/products/routes.ts).
  updatedAt: number;
}

// A confirmed-genuine reference photo for a product — auto-added whenever
// the scanner confirms a real deal tied to this product (see
// scrapeEngine.ts's evaluateListing), so the Database builds up a real
// photo library of "this is actually what a genuine listing of this looks
// like" over time. The user can add/remove from it by hand too (see
// index.ts's products:addImage/deleteImage) — this is what
// scrapeEngine.ts's general-tier vision check (see runPhotoAnalysis's
// referenceProducts option) actually compares an unmatched, possibly
// mistitled listing's photos against.
export interface ProductImage {
  id: string;
  productId: string;
  imageData: string; // a data: URI, always already downloaded — never a bare remote URL
  sourceTitle: string | null; // the listing title this came from, for context when reviewing the gallery
  createdAt: number;
  // Condition-awareness — "poor_condition" is a deliberately-researched
  // damaged/broken example (see webResearch.ts's
  // findPoorConditionProductImage), kept in its own Database gallery
  // section, never used as vision.ts's "what does this normally look like"
  // ground truth. Every existing/normal reference photo is "normal".
  kind: "normal" | "poor_condition";
}

// A term/phrase that instantly skips a listing (see store.ts's
// isBlacklisted and scrapeEngine.ts's evaluateListing) before it's ever
// opened or scored — for things categorically unrelated to a mail-order
// resale business (real estate, rentals, job postings, services...), not
// just uninteresting resalable items (that's what "Not interested" /
// category dismissal is for). "ai" source means the general-deal AI
// suggested it itself on an off-topic listing (see ScoredListing's
// offTopicSuggestion) rather than the user typing it in — surfaced
// separately in the Database UI so the user can review/remove anything the
// AI got wrong.
export interface BlacklistTerm {
  term: string;
  source: "user" | "ai";
  createdAt: number;
}

// The image counterpart to BlacklistTerm — a listing's THUMBNAIL (the cheap
// image already shown on the browse-results page, before the listing is
// ever opened) that the vision model recognized as an ineligible/
// unshippable category (a vehicle, a boat, real estate, furniture, ...) on
// sight, independent of whatever the title said. Per explicit instruction:
// a seller can easily omit any hint of this from the title itself (a boat
// titled just "must sell fast, $2200"), so title-keyword matching alone
// (see scrapeEngine.ts's UNSHIPPABLE_PATTERNS) misses it — this is what
// catches it from the photo instead. Stored images double as reference
// examples for FUTURE thumbnail checks (see scrapeEngine.ts's evaluateListing
// and vision.ts's classifyThumbnailImage) — "next time it sees something
// similar," per explicit instruction — and are shown in a Database UI
// gallery so the user can correct a wrong AI guess.
export interface BlacklistedImage {
  id: string;
  imageData: string; // a data: URI, already downloaded
  sourceTitle: string | null; // the listing title this came from, for context
  category: string | null; // the AI's own short category guess, e.g. "boat"
  reason: string | null; // the AI's own one-line explanation
  // Per explicit instruction — "when the AI blacklists listings, make sure
  // it blacklists both the title and the image(s), report both in
  // Blacklist": the normalized BlacklistTerm.term this image was added
  // alongside (see store.ts's addBlacklistTerm), so the Database Blacklist
  // section can show a term's own photo(s) right next to it instead of the
  // user having to cross-reference a separate gallery. null for an image
  // added purely from the AI's own photo classification with no companion
  // term (see evaluateListing's thumbnail pre-check).
  linkedTerm: string | null;
  // True once the user has explicitly reviewed this and agreed it's a
  // genuine mistake-to-avoid, as opposed to just sitting there unreviewed
  // since the AI added it — confirmed images are trusted more (sent first,
  // and protected from pruning) as reference examples for future checks
  // than an AI guess nobody has ever looked at.
  confirmed: boolean;
  createdAt: number;
}

// A lightweight, display-only snapshot of a listing — just enough for a
// thumbnail + title + price card, not the full ListingDetail. Shared by
// ScrapeStatus's live-preview fields and LiveActivityEvent below.
export interface ListingPreview {
  id: string;
  title: string;
  price: number | null;
  thumbnailUrl: string | null;
  url: string;
}

export interface ScrapeStatus {
  running: boolean;
  loggedIn: boolean | null;
  currentSearch: string | null; // now just "browsing" while a cycle runs
  listingsThisCycle: number;
  locationIndex: number;
  lastCycleStartedAt: number | null;
  lastCycleFinishedAt: number | null;
  lastError: string | null;
  // Per explicit instruction — Dashboard's Live panel shows "the listing
  // the AI is currently viewing" and a fading queue behind it, instead of
  // just a coarse "browsing" string. Set the instant evaluateListing
  // starts on a listing (see scrapeEngine.ts) — before it's known whether
  // that listing will turn out to be a deal, a skip, or anything else,
  // same "show it the moment it's happening" spirit as everything else on
  // this status object.
  currentListing: ListingPreview | null;
  // The next handful of listings queued up in the CURRENT batch (this
  // location's search results or browse results) — a short lookahead for
  // the fading "up next" queue, not the full remaining list.
  upcomingListings: ListingPreview[];
  // A short transient note for an in-between moment that isn't "looking at
  // a listing" at all — e.g. "Switching locations...", "Moving to next
  // product in queue..." — cleared back to null the moment a new
  // currentListing is set.
  currentActionNote: string | null;
  // Per explicit instruction — "bring the app more to life": true while
  // vision.ts's analyzeListingPhotos is actually in flight for the current
  // listing, so Dashboard's Live panel can swap its "Currently viewing"
  // label for "Researching photos..." during that window. False the rest
  // of the time, including while nothing's being viewed at all.
  analyzingPhotos: boolean;
  // The AI's own short, human, first-person reaction to the current
  // listing — see vision.ts's PhotoAnalysisResult.expertTake — shown under
  // the listing card once photo analysis resolves. Null before analysis
  // finishes (or if it's off/unavailable for this listing), cleared back
  // to null the moment a new currentListing is set, same as
  // currentActionNote.
  currentReaction: string | null;
  // While the scanner sits out its wait between passes: when that wait ends (ms since epoch). null/absent otherwise.
  sleepingUntil?: number | null;
}

// Per explicit instruction — the Database Research tab should show what
// the AI is CURRENTLY researching, and "relay its emotional feedback
// instead of its hyper-analysis" (i.e. chat.ts's ProductSummaryResult.
// reaction, not the full written-up aiSummary). A plain array (not a
// single "current" object) because research_product can genuinely be
// researching several products at once — auto-discovered siblings run
// concurrently with whatever the user just asked for by name — so the
// Research tab needs to show all of them, not just the latest.
export interface ActiveProductResearch {
  id: string;
  name: string;
  // Null while the research call is still in flight — the Research tab
  // shows a plain "Researching..." placeholder for that window, then
  // swaps in this line once index.ts's runProductLookup has it.
  reaction: string | null;
}

export interface LogLine {
  ts: number;
  // "deal" is its own level (not just "info") specifically so the
  // renderer can render a confirmed deal in green and play a sound for it
  // — a distinct visual/audio signal from routine activity, not just a
  // string it has to pattern-match for. "greenFlag" is the same idea, one
  // tier down — per explicit instruction, a listing that mentioned a
  // tracked high-value item but wasn't ultimately confirmed as a deal
  // (see scrapeEngine.ts's evaluateListing) still surfaces in Activity
  // highlighted yellow, distinct from both an ordinary skip (dim/gray) and
  // a confirmed deal (green) — worth a human glance even though the AI
  // didn't act on it.
  level: "info" | "warn" | "error" | "deal" | "greenFlag";
  message: string;
  // Per explicit instruction — "all text in the activity feed is
  // clickable... when the ai finds a marketplace listing, make the text
  // clickable to the original facebook marketplace page." Set on every
  // per-listing line in scrapeEngine.ts's evaluateListing (a deal, a green
  // flag, or any of the various skip reasons), not just confirmed deals —
  // Activity.tsx renders the WHOLE row as a link to this when present.
  listingUrl?: string;
  // Per explicit instruction — the other half of "make it so you can jump
  // to the page within the app": set on a log line about a SPECIFIC
  // product (currently just "New item of interest... adding it to the
  // Database" — see scrapeEngine.ts) so Activity.tsx can resolve this name
  // against the live products list and jump straight to that product's own
  // Database page, the same navigation Feed's Research button already
  // uses. Mutually exclusive with listingUrl in practice (a line is either
  // about a specific external listing or an in-app product), though
  // nothing enforces that beyond how the call sites are written.
  productName?: string;
  // Per explicit instruction — multi-account scanning: which account this
  // line came from, so Activity's single shared timeline can still show
  // which login is doing what (a small label chip on the row) without
  // splitting into separate per-account feeds. Optional — a line not
  // produced by any one account's engine (chat-driven actions, config
  // changes, etc.) just omits it, same as today's unlabeled behavior.
  accountId?: string;
  accountLabel?: string;
}
