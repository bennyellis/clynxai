// Clynx Phase 8 — Acquisition architecture evolution.
//
// Per the project's own long-term architecture notes: "The existing
// Facebook implementation should eventually become one ListingSource
// implementation... DO NOT rebuild the current scanner... first create
// architectural boundaries that allow this migration later." This file is
// exactly that boundary — a TYPES-ONLY abstraction over "acquire candidate
// listings for a search," so a future phase can add a second
// implementation (a licensed marketplace API, say) without scrapeEngine.ts
// or anything downstream needing to know or care which one actually ran.
//
// Deliberately narrow, per explicit instruction: this is a pure wrapper
// around the EXISTING scanner (see facebookMarketplaceSource.ts). Nothing
// here changes scraper.ts's or scrapeEngine.ts's behavior, and nothing here
// is wired into the live scan loop yet — that wiring, and any refactor of
// evaluateListing to consume a ListingSource instead of calling
// scraper.ts directly, is future-phase work.
//
// --- Where this boundary sits in the existing pipeline ---------------------
// The real scanner has two clearly separate stages already, and this
// abstraction only covers the FIRST one:
//   1. SEARCH/ACQUIRE — scraper.ts's searchMarketplace (or its
//      browseListings fallback) turns a query + location into a batch of
//      lightweight ListingSummary cards (id/url/title/price/thumbnail/
//      location). This is the "go find candidates" step, and it's the one
//      a licensed API would naturally replace — an API integration would
//      hand back its own batch of listing records instead of a scraped
//      HTML page's cards, but the SHAPE of "here are some candidate
//      listings for this search" is the same either way.
//   2. EVALUATE/SCORE — scrapeEngine.ts's evaluateListing takes ONE
//      candidate at a time and does everything else: blacklist/shippability
//      checks, fetchListingDetail, AI scoring (scorer.ts), vision analysis,
//      seller-risk checks, DB writes, notifications. This stage is
//      intelligence the app applies to ANY listing regardless of where it
//      came from — it has nothing to do with acquisition, so it deliberately
//      stays OUTSIDE ListingSource. A future API-backed source still needs
//      every one of evaluateListing's checks run on what it returns.
// Modeling ListingSource on stage 1 only (not a wholesale
// "search-and-score" abstraction) is what keeps this phase a thin wrapper:
// it lets FacebookMarketplaceSource.search() below be a near-identity
// mapping over searchMarketplace's own existing return value, with no new
// Playwright calls, no new scoring logic, and no behavior this phase would
// need to invent or guess at.

import type { ListingSummary } from "./types.js";

// A listing as acquired from SOME source, before any scoring/evaluation.
//
// This is ListingSummary (the exact shape scraper.ts's searchMarketplace/
// browseListings already return today) plus one additive field. Per
// explicit instruction, NormalizedListing normalizes toward the shape the
// rest of the app already consumes rather than inventing a new one — and
// ListingSummary, not ScoredListing/ListingRecord, is the shape the actual
// SEARCH step already produces (see the stage breakdown above). ScoredListing
// and ListingRecord layer on AI scoring output (extraction, isDeal,
// dealTier, referencePriceUsd...) that only exists after evaluateListing
// runs — an acquisition-layer type claiming to already have that would be
// lying about what a "search" call actually knows, and would force every
// future ListingSource implementation to somehow produce AI scoring output
// of its own, which is exactly the kind of invented, out-of-scope shape this
// narrow phase is supposed to avoid.
export interface NormalizedListing extends ListingSummary {
  // Which ListingSource produced this listing (see
  // FacebookMarketplaceSource.name). Not present on a bare ListingSummary —
  // the one genuinely new piece of information this layer adds — so that
  // once a second implementation exists, code fanning results in from
  // multiple sources can still tell them apart without re-deriving it.
  // Every existing consumer of ListingSummary-shaped data (evaluateListing,
  // toPreview, ListingCard.tsx, ...) can keep ignoring this field entirely.
  sourceId: string;
}

// The parameters needed to search for listings at one location, mirrored
// directly from what the existing code already passes around — NOT an
// invented shape. See:
//   - scraper.ts's searchMarketplace(page, browseUrl, query, maxScrolls,
//     onFallback, maxAgeHours, minPriceUsd, maxPriceUsd, alreadyOnCorrectPage)
//   - scrapeEngine.ts's three call sites (runCycle's active-search loops,
//     searchForItemNow, runWatchCheck), which all resolve a query string via
//     scorer.ts's getSearchQuery(item) and a location URL via an Account's
//     browseUrls entry or a Watch's resolvedLocationUrl BEFORE calling
//     searchMarketplace — this layer picks up right where that resolution
//     already leaves off, same as searchMarketplace itself does.
//
// `page` (the live, logged-in Playwright session) is deliberately NOT a
// field here — it's Facebook/Playwright-specific plumbing, not a search
// parameter a future non-Facebook source would have any use for.
// FacebookMarketplaceSource takes it as constructor/dependency injection
// instead (see facebookMarketplaceSource.ts), keeping this request type
// genuinely source-agnostic.
export interface SearchRequest {
  // The literal phrase to search for — already resolved from a SearchItem
  // or Watch via scorer.ts's getSearchQuery elsewhere. This layer only ever
  // sees the resulting string, exactly like searchMarketplace's own `query`
  // parameter does; it has no notion of SearchItem/Watch itself.
  query: string;
  // An already-resolved Facebook Marketplace browse URL for one specific
  // location + radius (an Account.browseUrls entry, or a Watch's
  // resolvedLocationUrl). Location RESOLUTION (turning a city/ZIP into this
  // URL) is a separate, pre-existing concern (locationDiscovery.ts) that
  // stays outside this abstraction, same as it already stays outside
  // searchMarketplace itself.
  locationUrl: string;
  // Mirrors searchMarketplace's own maxAgeHours — null means no freshness
  // cap (Facebook's own "Date listed" filter is left untouched).
  maxAgeHours: number | null;
  // Mirrors searchMarketplace's own minPriceUsd/maxPriceUsd — both drive
  // Facebook's own "Price Range" filter, not just a post-fetch check.
  minPriceUsd: number | null;
  maxPriceUsd: number | null;
  // Mirrors searchMarketplace's own optional maxScrolls param. Omit to use
  // that function's existing default (8).
  maxScrolls?: number;
  // Mirrors searchMarketplace's own alreadyOnCorrectPage perf optimization
  // (skip a redundant navigation when the caller already just confirmed
  // arrival at locationUrl moments ago). Optional; omitting it is always
  // safe (searchMarketplace defaults it to false itself).
  alreadyOnCorrectPage?: boolean;
}

// A source of candidate listings for a search. Exactly one implementation
// exists today (FacebookMarketplaceSource, wrapping the existing Playwright
// scanner) — the interface itself is what lets a future phase add a second
// (e.g. a licensed API) that the rest of the app can consume identically.
//
// Shape note: search() returns a plain Promise<NormalizedListing[]>, not a
// stream/async-iterator/paginated response. That matches the existing
// scanner exactly as-is — searchMarketplace already returns one bounded,
// scroll-limited batch array per call (maxScrolls caps how much of
// Facebook's own infinite-scroll result list it collects before returning),
// so there's no existing streamed/paginated behavior to preserve here. A
// future source with real pagination could still satisfy this by collecting
// its own pages internally before resolving.
export interface ListingSource {
  // A short, stable identifier for this source (e.g. "facebook-marketplace")
  // — used to stamp NormalizedListing.sourceId and for logging, not for any
  // branching logic in this phase.
  readonly name: string;
  search(request: SearchRequest): Promise<NormalizedListing[]>;
}
