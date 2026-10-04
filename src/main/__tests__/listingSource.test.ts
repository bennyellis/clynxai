// Clynx Phase 8 — Acquisition architecture evolution.
//
// NOT wired into an automated test runner. The Electron app (src/main) has
// no test framework/config of its own today (only cloud/, a separate
// standalone project, has vitest) — per explicit instruction, this phase
// doesn't introduce one just to cover this single file. This is a plain
// standalone script, run manually with tsx:
//
//   npx tsx src/main/__tests__/listingSource.test.ts
//
// (tsx isn't a root devDependency either, to avoid adding one for a single
// file — cloud/ already has it installed, so from the repo root you can
// also run: ./cloud/node_modules/.bin/tsx src/main/__tests__/listingSource.test.ts)
//
// It verifies, using a FAKE searchMarketplace function (never a real
// Playwright browser or Facebook session):
//   1. FacebookMarketplaceSource structurally satisfies the ListingSource
//      interface (a compile-time check, enforced by typecheck below).
//   2. search() maps a SearchRequest onto searchMarketplace's existing
//      positional params correctly (including defaults for the two
//      optional fields).
//   3. search() maps searchMarketplace's ListingSummary[] response onto
//      NormalizedListing[] as a near-identity transform (original fields
//      preserved verbatim, plus sourceId added).
//   4. getPage() is only invoked once search() actually runs, not at
//      construction time.
//
// This file living here (src/main/__tests__/) is a deliberate, minimal
// precedent for where a future main-process test might go — not a claim
// that a real test framework is now set up.

import type { Page } from "playwright";
import type { ListingSummary } from "../types.js";
import type { ListingSource, SearchRequest } from "../listingSource.js";
import { FacebookMarketplaceSource, type SearchMarketplaceFn } from "../facebookMarketplaceSource.js";

let passed = 0;
let failed = 0;

function check(description: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${description}`);
  } else {
    failed++;
    console.log(`  FAIL  ${description}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  console.log("listingSource.test.ts — FacebookMarketplaceSource adapter verification\n");

  const FAKE_PAGE = { __fakePage: true } as unknown as Page;
  const FAKE_RESULTS: ListingSummary[] = [
    { id: "1", url: "https://facebook.com/marketplace/item/1", title: "Xbox Series X", price: 250, thumbnailUrl: "https://example.com/1.jpg", locationText: "Richmond, VA" },
    { id: "2", url: "https://facebook.com/marketplace/item/2", title: "PS5 Slim Digital", price: 300, thumbnailUrl: null, locationText: null },
  ];

  // --- Test 1: request -> positional-arg mapping, with explicit optionals ---
  {
    let capturedArgs: unknown[] | null = null;
    let getPageCalls = 0;
    const fakeSearchMarketplace: SearchMarketplaceFn = (async (...args: unknown[]) => {
      capturedArgs = args;
      return FAKE_RESULTS;
    }) as SearchMarketplaceFn;

    const source: ListingSource = new FacebookMarketplaceSource({
      getPage: async () => {
        getPageCalls++;
        return FAKE_PAGE;
      },
      onFallback: () => {},
      searchFn: fakeSearchMarketplace,
    });

    check("getPage() is not called before search() runs", getPageCalls === 0);

    const request: SearchRequest = {
      query: "xbox series x",
      locationUrl: "https://www.facebook.com/marketplace/richmond/search",
      maxAgeHours: 24,
      minPriceUsd: 50,
      maxPriceUsd: 500,
      maxScrolls: 6,
      alreadyOnCorrectPage: true,
    };
    const results = await source.search(request);

    check("getPage() is called exactly once during search()", getPageCalls === 1);
    check("searchMarketplace receives the fake page as arg[0]", capturedArgs !== null && capturedArgs![0] === FAKE_PAGE);
    check("searchMarketplace receives locationUrl as arg[1] (browseUrl)", capturedArgs![1] === request.locationUrl);
    check("searchMarketplace receives query as arg[2]", capturedArgs![2] === request.query);
    check("searchMarketplace receives maxScrolls as arg[3]", capturedArgs![3] === 6);
    check("searchMarketplace receives an onFallback function as arg[4]", typeof capturedArgs![4] === "function");
    check("searchMarketplace receives maxAgeHours as arg[5]", capturedArgs![5] === 24);
    check("searchMarketplace receives minPriceUsd as arg[6]", capturedArgs![6] === 50);
    check("searchMarketplace receives maxPriceUsd as arg[7]", capturedArgs![7] === 500);
    check("searchMarketplace receives alreadyOnCorrectPage as arg[8]", capturedArgs![8] === true);

    check(
      "search() result is a near-identity mapping: original ListingSummary fields preserved",
      results.length === FAKE_RESULTS.length &&
        results.every((r, i) => deepEqual({ id: r.id, url: r.url, title: r.title, price: r.price, thumbnailUrl: r.thumbnailUrl, locationText: r.locationText }, FAKE_RESULTS[i]))
    );
    check(
      "search() result adds sourceId === source.name to every listing",
      results.every((r) => r.sourceId === "facebook-marketplace") && source.name === "facebook-marketplace"
    );
  }

  // --- Test 2: optional SearchRequest fields default the same way searchMarketplace itself does ---
  {
    let capturedArgs: unknown[] | null = null;
    const fakeSearchMarketplace: SearchMarketplaceFn = (async (...args: unknown[]) => {
      capturedArgs = args;
      return [];
    }) as SearchMarketplaceFn;

    const source = new FacebookMarketplaceSource({
      getPage: async () => FAKE_PAGE,
      searchFn: fakeSearchMarketplace,
    });

    const minimalRequest: SearchRequest = {
      query: "nintendo switch",
      locationUrl: "https://www.facebook.com/marketplace/nationwide/search",
      maxAgeHours: null,
      minPriceUsd: null,
      maxPriceUsd: null,
      // maxScrolls and alreadyOnCorrectPage both omitted
    };
    await source.search(minimalRequest);

    check("omitted maxScrolls defaults to 8 (searchMarketplace's own default)", capturedArgs![3] === 8);
    check("omitted onFallback passes through as undefined", capturedArgs![4] === undefined);
    check("omitted alreadyOnCorrectPage defaults to false", capturedArgs![8] === false);
  }

  // --- Test 3: an empty result set maps to an empty array, not an error ---
  {
    const source = new FacebookMarketplaceSource({
      getPage: async () => FAKE_PAGE,
      searchFn: (async () => []) as SearchMarketplaceFn,
    });
    const results = await source.search({
      query: "anything",
      locationUrl: "https://www.facebook.com/marketplace/x/search",
      maxAgeHours: null,
      minPriceUsd: null,
      maxPriceUsd: null,
    });
    check("an empty searchMarketplace result maps to an empty NormalizedListing[]", Array.isArray(results) && results.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Verification script threw:", err);
  process.exit(1);
});
