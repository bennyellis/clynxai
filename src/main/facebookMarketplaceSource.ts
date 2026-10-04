// Clynx Phase 8 — Acquisition architecture evolution.
//
// FacebookMarketplaceSource is a thin ListingSource adapter around the
// EXISTING Facebook Playwright scanner (scraper.ts's searchMarketplace).
// Per explicit instruction, this adapter conforms to searchMarketplace's
// existing contract rather than the other way around — scraper.ts and
// scrapeEngine.ts are NOT modified by this phase, and this class is not
// called from anywhere in the live app yet. It exists to demonstrate that
// the ListingSource abstraction (listingSource.ts) actually fits the real
// scanner, verified via a fake/mocked search function
// (see __tests__/listingSource.test.ts), not a real browser.
import type { Page } from "playwright";
import { searchMarketplace } from "./scraper.js";
import type { ListingSource, NormalizedListing, SearchRequest } from "./listingSource.js";

// The exact shape of scraper.ts's searchMarketplace — pulled out as a named
// type so it can be swapped for a fake in tests without needing a real
// Playwright Page or a live Facebook session.
export type SearchMarketplaceFn = typeof searchMarketplace;

export interface FacebookMarketplaceSourceDeps {
  // Supplies the live, logged-in Playwright page to search on. A function
  // rather than a bare Page because a real caller (a future phase's
  // wiring) only has one shared page per account, resolved asynchronously
  // (see scrapeEngine.ts's ensureBrowser/withPage) — this defers obtaining
  // it until search() is actually called, rather than requiring one to
  // exist up front just to construct the source.
  getPage: () => Promise<Page>;
  // Forwarded verbatim to searchMarketplace's own onFallback callback (see
  // scraper.ts) — how a caller wants degraded-search/diagnostic messages
  // reported (e.g. into scrapeEngine.ts's own log) is a wiring concern for
  // whoever constructs this source, not something this adapter decides.
  onFallback?: (reason: string, level?: "info" | "warn") => void;
  // Defaults to the real scraper.ts#searchMarketplace. Overridable purely
  // for testing, so a unit test can inject a fake and assert this adapter's
  // own request-mapping/response-mapping logic without a real browser.
  searchFn?: SearchMarketplaceFn;
}

export class FacebookMarketplaceSource implements ListingSource {
  readonly name = "facebook-marketplace";

  constructor(private readonly deps: FacebookMarketplaceSourceDeps) {}

  async search(request: SearchRequest): Promise<NormalizedListing[]> {
    const search = this.deps.searchFn ?? searchMarketplace;
    const page = await this.deps.getPage();
    // A straight pass-through into searchMarketplace's existing positional
    // params — no new logic, no new Playwright calls, nothing this phase
    // invents. Every field here already has a call site in scrapeEngine.ts
    // passing the equivalent positional argument (see listingSource.ts's
    // SearchRequest doc comment for the three of them).
    const results = await search(
      page,
      request.locationUrl,
      request.query,
      request.maxScrolls ?? 8,
      this.deps.onFallback,
      request.maxAgeHours,
      request.minPriceUsd,
      request.maxPriceUsd,
      request.alreadyOnCorrectPage ?? false
    );
    // Near-identity mapping, as intended: searchMarketplace's ListingSummary
    // results carried through unchanged, plus the one additive field
    // NormalizedListing defines (see listingSource.ts).
    return results.map((listing) => ({ ...listing, sourceId: this.name }));
  }
}
