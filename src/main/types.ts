// One entry in the "Search For" list — something you specifically want
// found. Managed entirely through chat now (add_search_item/
// remove_search_item), not a Config screen. The scraper both actively
// searches for it (a dedicated keyword search at every location, every
// cycle) and matches it passively if encountered during normal browsing.
// typicalResaleUsd is the only source of pricing truth for it — the AI
// never substitutes its own guess.
export interface SearchItem {
  item: string;
  typicalResaleUsd: number;
  matchKeywords: string[];
  // Per explicit instruction — there used to also be a per-item maxBudgetUsd
  // here, a personally-stated "I'll spend $X on this" ceiling entered right
  // alongside adding the item. Removed for being functionally the same
  // knob as config.maxPriceUsd (the Dashboard's own Max Price filter) with
  // a confusingly separate home — that single global field is now the one
  // and only "what am I willing to pay" signal, both for filtering what the
  // scanner even looks at (see scraper.ts/scrapeEngine.ts) and for deal
  // scoring (see scorer.ts's evaluateSearchItemPricing).
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
  // Base Marketplace URLs to rotate through — no query/search term, just
  // wherever "browse everything" lands for a given location on your
  // account. Radius is NOT set via these URLs (see the "Open Facebook
  // Marketplace" flow); each URL just needs a different location center.
  // The scraper switches to the next one every listingsPerLocation
  // evaluated listings, since Facebook still seems to bias results toward
  // whatever location is current even with a large radius set.
  browseUrls: string[];
  listingsPerLocation: number;
  headless: boolean;
  pollIntervalMinutesMin: number;
  pollIntervalMinutesMax: number;
  dealThresholdPercent: number;
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
  // Per explicit instruction — a single on/off switch for every app sound
  // (start/stop bloops, tab-switch tick, the deal-alert chime), not a
  // per-sound toggle. Defaults true — existing behavior unchanged until
  // someone deliberately turns it off. See lib/sound.ts's setSoundEnabled.
  soundEnabled: boolean;
  // Per explicit instruction — Config's own "Search locations" setting.
  // "country" is the original always-on behavior (browseUrls stays the
  // full nationwide spread); "state" replaces browseUrls with exactly one
  // resolved location for that state's single most populous/well-known
  // city (see locationDiscovery.ts's lookupPrimaryCityInState — resolving
  // 10 separate cities used to be the behavior here, which was slow for
  // little benefit); "city" replaces browseUrls with exactly one resolved
  // location for a specific city/ZIP the user typed in. Both go through
  // the SAME "Change location" dialog the radius check already drives.
  // Only one of selectedState/selectedCityOrZip is ever meaningful at a
  // time, matching whichever mode is active — both null in "country" mode.
  // selectedState also doubles as the target for scrapeEngine.ts's
  // listingStateMatches filter in both "state" and "city" mode (in "city"
  // mode it's the state Facebook's OWN confirmation resolved the search
  // to, not necessarily anything the user typed).
  locationMode: "country" | "state" | "city";
  selectedState: string | null;
  selectedCityOrZip: string | null;
  // Per explicit instruction — the search radius applied to every browse
  // location (see scrapeEngine.ts's runCycle, which re-verifies/corrects
  // this once per cycle). Defaults to 100, the original fixed assumption.
  // "state" mode overrides this to 40 automatically, "city" mode to 20 —
  // both set live in the same "Change location" dialog visit that resolves
  // the location itself (see index.ts's location:setMode); switching back
  // to "country" resets it to 100.
  searchRadiusMiles: number;
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
  // Per explicit instruction — a global price ceiling the user controls
  // directly, on top of (not instead of) the existing scam-bait/placeholder-
  // price checks (isSuspiciousPrice/isNonRoundPrice). The one and only "max
  // I'll pay" signal — used both to filter what the scanner ever opens (see
  // scrapeEngine.ts's evaluateListing) and, for a matched Search For item,
  // as the deal-scoring budget ceiling (see scorer.ts's
  // evaluateSearchItemPricing) — there used to also be a separate per-item
  // maxBudgetUsd doing the second job, removed for being confusingly
  // redundant with this. null = no cap.
  maxPriceUsd: number | null;
  // The floor counterpart — per explicit instruction (the Dashboard's own
  // Filters box, Min Price alongside Max Price), for filtering out listings
  // too cheap to be worth the seller-risk/scam-bait profile a suspiciously
  // low price often carries, or just not worth the time on a low-value
  // flip. null = no floor. Same enforcement point as maxPriceUsd.
  minPriceUsd: number | null;
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
}

export interface ListingSummary {
  id: string;
  url: string;
  title: string;
  price: number | null;
  thumbnailUrl: string | null;
  locationText: string | null;
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
}

export interface ListingDetail extends ListingSummary {
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
}

// "search" = matched one of your Search For items; the discount math is
// precise arithmetic against a price you vetted yourself.
// "general" = didn't match anything you configured, but the AI's own
// (unverified, possibly wrong) sense of typical value thinks it's a steal.
// Treat "general" with real skepticism — there's no vetted price behind it.
export type DealTier = "search" | "general" | null;

export interface ScoredListing {
  listing: ListingDetail;
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

export interface ListingRecord {
  id: string;
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
  sellerHasProfilePhoto: boolean | null;
  sellerRiskPassed: boolean;
  sellerRiskReasons: string[];
  // OpenAI vision photo analysis — null means "not checked yet" or
  // "checked but nothing usable came back"; photoAnalysisCheckedAt
  // disambiguates.
  photoAnalysis: string | null;
  photoAnalysisCheckedAt: number | null;
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
}

// A user-curated product "database" entry. aiSummary is built from a real,
// in-depth live web search done for this exact product (see webResearch.ts)
// — not just the model's own memorized training knowledge, and explicitly
// not a source of pricing on its own (your own numbers are still what
// counts as verified). Matched into scoring prompts by name against Search
// For items to give the AI more to work with when judging genuine-match/
// condition.
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
  // above. Distinct from config.maxPriceUsd (a global cap across every
  // listing the scanner looks at) — this lives on the Database entry
  // itself, so it applies to a product the user is just tracking/
  // researching too, independent of whatever the global filter is set to.
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
  loading: boolean;
  createdAt: number;
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
}
