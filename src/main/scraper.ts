import type { Page } from "playwright";
import type { ListingDetail, ListingSummary } from "./types.js";
import { timed, recordStage, recordEventBulk } from "./metrics.js";
import { US_STATE_ABBREVIATIONS } from "./usStates.js";

// Verified live: a sparse/malformed card (an ad unit, a "Today's picks"
// variant, one still mid-render) can have aria-label/innerText that's
// JUST a price and a location, with no real title text at all — e.g.
// "$80 · Richmond, VA". parseListingCard's title-picking heuristic (the
// longest non-price line) then picks the LOCATION as the "title" once
// there's only one non-price line left, since there's nothing else to
// compare it against — confirmed live via several listings that showed up
// in Feed literally titled "Richmond, VA" / "Chattanooga, TN", which then
// got evaluated as if they were real products. Checked before assuming a
// single leftover line is a genuine title.
const STATE_NAMES_LOWER = new Set(Object.keys(US_STATE_ABBREVIATIONS).map((s) => s.toLowerCase()));
const STATE_ABBRS = new Set(Object.values(US_STATE_ABBREVIATIONS));
function looksLikeBareLocation(line: string): boolean {
  const match = line.match(/^([A-Za-z .'-]+),\s*([A-Za-z .'-]+)$/);
  if (!match) return false;
  const statePart = match[2].trim();
  return STATE_ABBRS.has(statePart.toUpperCase()) || STATE_NAMES_LOWER.has(statePart.toLowerCase());
}

// --- IMPORTANT -------------------------------------------------------------
// Facebook renders Marketplace with obfuscated, frequently-changing class
// names and no stable data-testid attributes on most elements. There is no
// durable CSS selector to hang this on, so extraction here is deliberately
// heuristic (aria-label / plain text parsing) rather than tied to specific
// class names. When Facebook ships a markup change, this file — not the
// rest of the app — is what will need adjusting. To fix it: open a
// Marketplace search in a normal browser, right-click a listing card ->
// Inspect, and see what changed vs. the assumptions below.
// -----------------------------------------------------------------------

// We deliberately don't construct Marketplace URLs with location/radius
// query params — that encoding isn't documented and guessing it risks
// silently browsing the wrong area. Instead this navigates straight to your
// plain "browse everything" URL; your location + max-distance filter needs
// to be set once, live, inside this same automated browser profile (not
// your regular browser — Facebook appears to store the radius preference
// locally rather than on your account, so it doesn't carry over between
// separate browser profiles). See the "Open Facebook Marketplace" flow.
export async function browseListings(page: Page, browseUrl: string, maxScrolls = 8): Promise<ListingSummary[]> {
  // Per explicit instruction, reversing an earlier optimization: this used
  // to skip re-navigating when page.url() already equaled browseUrl (to
  // avoid a pointless extra reload right when scrapeEngine.ts's runCycle
  // had just switched locations). Diagnosed live: "it seems to always
  // eventually go back to Richmond and mess everything up... even if the
  // Activity log says differently" — the URL staying correct doesn't
  // guarantee the RENDERED content still is. Facebook's account-level
  // default location (Richmond here, confirmed unrelated to where the user
  // actually is) can apparently assert itself client-side without ever
  // changing the URL, which fools a URL-only "are we still there" check —
  // the log line confirming arrival was accurate at the moment it ran, but
  // nothing after that point re-verified it before this actually scraped
  // whatever was on screen. Always navigating fresh here is what actually
  // closes that gap — trading back a little of the "don't refresh
  // needlessly" optimization for the correctness that update was clearly
  // still missing.
  await timed("marketplace_navigation", () => page.goto(browseUrl, { waitUntil: "domcontentloaded" }));
  const results = await timed("listing_extraction", () => extractListingsFromCurrentPage(page, maxScrolls));
  // "Discovered" = every listing Marketplace's own page actually returned,
  // independent of whatever the caller later does with them (evaluates,
  // skips on a per-location cap, etc.) — see metrics.ts's own doc comment
  // on why this is deliberately a bulk increment here rather than counted
  // again downstream, so it isn't double-counted against the separate
  // "evaluated" counter recorded per-account in scrapeEngine.ts.
  recordEventBulk("discovered", results.length);
  return results;
}

// "0 listings found" almost never means Facebook genuinely has nothing —
// it means the page didn't show a normal Marketplace grid at all (a
// checkpoint, a temporary block, a logged-out state, a slow load). This
// grabs a quick snapshot of what's actually on the page so that can be
// logged and diagnosed, instead of a silent, uninformative zero.
//
// Verified live miss: a body-wide snippet is USELESS for this — Marketplace's
// left-hand location/category sidebar ("Location ... Categories Vehicles
// Property Rentals Apparel Classifieds Electronics Entertainment...") alone
// fills the first 300 characters of document.body.innerText, so this
// produced the exact same-looking snippet whether the page genuinely had
// zero listings or was showing a full grid of them — confirmed by comparing
// document.body.innerText against a real, fully-loaded page with 7+ visible
// listings and getting sidebar-only text either way. Scoped to [role="main"]
// instead (same scoping fetchListingDetail already uses), which actually
// contains the listing grid and excludes the sidebar entirely.
// Verified live miss #2: reported as "Empty browse" on a page whose own
// [role="main"] text snippet clearly showed real listings ("Today's picks
// ... $260 3ds xl blue 64gb and games ... $40 SONY HEADPHONES 1000XM5
// ..."). That rules out the SPA-hydration-timing explanation the earlier
// fix above was for — the content had genuinely finished rendering — which
// means extractListingsFromCurrentPage's `a[href*="/marketplace/item/"]`
// selector itself isn't matching something that visibly exists on THIS
// account/session, even though it was verified live (a logged-out session,
// different from what actually failed) to match real "Today's picks" item
// links just like these. Rather than guess at a replacement selector with
// no evidence of what's actually different, this now also samples the
// real anchor/href structure so the NEXT occurrence's log line shows
// exactly what markup is actually there to fix against.
export async function diagnoseEmptyPage(page: Page): Promise<string> {
  try {
    const title = await page.title().catch(() => "(couldn't read title)");
    const url = page.url();
    const details = await page
      .evaluate(() => {
        const main = document.querySelector('[role="main"]') as HTMLElement | null;
        const scope: Element = main ?? document.body;
        const text = ((main ?? document.body)?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        const anchors = Array.from(scope.querySelectorAll("a"));
        const marketplaceHrefs = [...new Set(anchors.map((a) => a.getAttribute("href") || "").filter((h) => h.includes("marketplace")))];
        return {
          text,
          anchorCount: anchors.length,
          marketplaceHrefCount: marketplaceHrefs.length,
          sampleHrefs: marketplaceHrefs.slice(0, 6),
        };
      })
      .catch(() => null);
    if (!details) return `title="${title}" url=${url} text="(couldn't read page text)"`;
    return `title="${title}" url=${url} text="${details.text}" anchorsInMain=${details.anchorCount} marketplaceHrefs=${
      details.marketplaceHrefCount
    } sampleHrefs=${JSON.stringify(details.sampleHrefs)}`;
  } catch (err) {
    return `(diagnosis itself failed: ${(err as Error).message})`;
  }
}

// Drives Facebook's actual "Search Marketplace" input for a specific query,
// instead of constructing a search URL — typing into the real search box
// and letting Facebook's own client-side search handle it should give
// results genuinely scoped to that query, the same way a person searching
// by hand would get, rather than however a bare URL with a query param
// gets treated server-side (which testing suggests may be broader/less
// targeted). Falls back to the URL-based approach if the search box can't
// be found, so a markup change degrades gracefully instead of breaking
// active search entirely — but that fallback is reported via onFallback
// (not just a console.warn) specifically so it shows up in the app's own
// Activity log instead of silently degrading somewhere only visible in a
// terminal the user may not be watching. Includes a page snapshot (see
// diagnoseEmptyPage) so a markup change can actually be diagnosed instead
// of just noticing results look off.
export async function searchMarketplace(
  page: Page,
  browseUrl: string,
  query: string,
  maxScrolls = 8,
  // Per explicit instruction — the same callback also reports a GOOD
  // outcome now (confirming the search radius, see below), not just
  // problems, so the level is explicit rather than always implying
  // something went wrong. Existing callers that don't pass a level keep
  // logging as "warn" (see the default at each call site in
  // scrapeEngine.ts), so nothing about the pre-existing Date
  // Listed/Price Range fallback messages changes.
  onFallback?: (reason: string, level?: "info" | "warn") => void,
  // Per explicit instruction — the "no more than a day old" freshness
  // window is now a user-configurable Config setting (config.
  // maxListingAgeHours), not a hardcoded assumption. null means "any age,"
  // in which case Facebook's own filter is left untouched entirely.
  maxAgeHours: number | null = 24,
  // Per explicit instruction — the Dashboard Filters box's Min/Max Price
  // now ALSO drives Facebook's own "Price Range" filter on the search
  // results page (the same area as "Availability"/"Date listed"), not just
  // scrapeEngine.ts's own post-fetch price checks. Both null (the default)
  // leaves Facebook's own filter untouched, same posture as maxAgeHours.
  minPriceUsd: number | null = null,
  maxPriceUsd: number | null = null,
  // Per explicit instruction, diagnosed live from a screen recording:
  // "right when you start searching, it'll refresh the page a whole bunch
  // of times and do nothing." Root cause — this function's OWN mandatory
  // fresh navigation just below (added for a real, different reason: see
  // this param's sibling explanation right under it) was stacking with
  // scrapeEngine.ts's runCycle, which ALREADY does its own real,
  // arrival-confirmed navigation (up to 3 retries) to this exact URL right
  // before calling this function — meaning a multi-location cycle
  // routinely reloaded the same page 2-4 times in a row before ever typing
  // anything. Set to true ONLY by a caller that just did that same
  // confirmed navigation itself, moments ago, with nothing else touching
  // the page in between — never by a caller (like the URL-fallback path
  // below, or browseListings' own callers) with no such guarantee, which
  // still need the fresh-navigate safety net this used to always run.
  alreadyOnCorrectPage = false
): Promise<ListingSummary[]> {
  // Per explicit instruction, reversing an earlier optimization (see
  // browseListings' own doc comment above for the full diagnosis): this
  // used to skip re-navigating when page.url() already equaled browseUrl,
  // to avoid a pointless reload right after runCycle had just switched
  // locations. Diagnosed live: "it seems to always eventually go back to
  // Richmond and mess everything up... even if the Activity log says
  // differently" — the URL matching doesn't guarantee the rendered content
  // still does, if Facebook's account-level default location (confirmed
  // unrelated to where the user actually is) asserts itself client-side
  // without changing the URL. Always navigating fresh right before typing
  // the search query is what actually closes that gap — UNLESS the caller
  // just did an equivalent real, verified navigation to this exact URL
  // itself (alreadyOnCorrectPage), in which case doing it again a moment
  // later is pure redundant reloading, not extra safety.
  if (!alreadyOnCorrectPage) {
    await timed("marketplace_navigation", () => page.goto(browseUrl, { waitUntil: "domcontentloaded" }));
  }

  const box = await findSearchMarketplaceBox(page);
  if (!box) {
    const diagnosis = await diagnoseEmptyPage(page).catch((err) => `(diagnosis failed: ${err.message})`);
    onFallback?.(`Couldn't find the "Search Marketplace" box — falling back to a URL-based search for "${query}". Page state: ${diagnosis}`);
    return browseListings(page, buildSearchUrl(browseUrl, query), maxScrolls);
  }

  try {
    await box.click({ timeout: 5000 });
    await box.fill("");
    await box.type(query, { delay: 30 });
    // Per explicit redefinition of the search order — "log and check to
    // see if [the search terms/filters] are filled in correctly
    // constantly": read back what the box actually holds right after
    // typing (before Enter submits/reloads it) instead of just assuming
    // the type() above landed — this is what actually catches a
    // long-running session silently drifting off the requested query
    // (autocomplete overwriting it, a stray keystroke, a race with page
    // content still loading), rather than trusting intent alone.
    const typedValue = await box.inputValue().catch(() => null);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    // Per explicit instruction — "every time the product is typed into
    // marketplace's search bar it is logged in Activity... it keeps
    // losing track completely in the long run." The caller already logs
    // "Actively searching for X" right before this runs, but that's
    // announcing INTENT, not confirming the actual DOM interaction above
    // succeeded — this is the real trace of what the browser actually did,
    // useful for spotting exactly where a long-running session drifted.
    if (typedValue !== null && typedValue.trim() !== query.trim()) {
      onFallback?.(`Typed "${query}" into the Search Marketplace box, but it read back as "${typedValue}" — the search may not be accurate.`, "warn");
    } else {
      onFallback?.(`Typed "${query}" into the Search Marketplace box.`, "info");
    }
  } catch (err) {
    onFallback?.(`Search box interaction failed (${(err as Error).message}) — falling back to URL-based search for "${query}".`);
    return browseListings(page, buildSearchUrl(browseUrl, query), maxScrolls);
  }

  // Per explicit instruction, diagnosed live: "it's searching for min/max
  // price but not date listed." Price Range (see applyPriceRangeFilter) has
  // to reload the page to a freshly-built URL to guarantee the correct
  // city/query survive it (see that function's own doc comment on the
  // Richmond bug this fixed) — but Date Listed is applied by CLICKING a
  // Facebook UI control with no URL representation at all, so running Price
  // Range AFTER it (the original order) silently discarded Date Listed's
  // effect on every reload, every time a price filter was also set. Price
  // Range now runs FIRST, so its one guaranteed reload happens before
  // anything else touches the page; Date Listed's click-based interaction
  // runs LAST, on that already-settled page, with nothing left afterward
  // that could wipe it out again.
  //
  // Reported live as "the price range feature doesn't work" earlier this
  // session: Min/Max Price was only ever enforced after the fact
  // (scrapeEngine.ts's own per-SearchItem minPriceUsd/maxPriceUsd checks in
  // evaluateListing), never told to Facebook's own search filter — this
  // closes that gap by talking to Facebook's own URL-based filter directly,
  // evaluateListing's own checks staying in place as the backstop guarantee
  // regardless of whether this live interaction lands.
  await applyPriceRangeFilter(page, minPriceUsd, maxPriceUsd, browseUrl, query, onFallback);

  // Narrows results to the configured freshness window using Facebook's
  // OWN "Date listed" filter, right on the search results page — this is
  // what actually saves time: results that are already excluded here never
  // get a detail-page visit or an AI call at all, versus scrapeEngine.ts's
  // isListingTooOld, which can only catch stale listings AFTER opening
  // them (it stays in place as a backstop for whatever slips past this,
  // including the URL-fallback search path above, which doesn't go
  // through this filter, AND as the guarantee that the configured window is
  // actually enforced even if this live click below doesn't land — this
  // control's exact live behavior wasn't fully re-verifiable this session,
  // see applyDateListedFilter). Best-effort and silent-degrading on
  // purpose, same posture as the search box above: if the control isn't
  // where expected, log why via onFallback and keep going unfiltered
  // rather than breaking the search outright.
  await applyDateListedFilter(page, maxAgeHours, onFallback);

  // Radius is deliberately NOT re-checked here on every single search —
  // see verifyOrSetRadius's own doc comment and scrapeEngine.ts's runCycle,
  // which checks/corrects it exactly once per cycle instead, right after
  // confirming the starting location. The "Change location" dialog this
  // needs to open ALSO contains a location text field, and reopening it
  // mid-search (on top of whatever city/query state Date Listed and Price
  // Range just established) risked disturbing that instead of just fixing
  // the radius — a once-per-cycle check on a clean page avoids that.

  const results = await timed("listing_extraction", () => extractListingsFromCurrentPage(page, maxScrolls));
  recordEventBulk("discovered", results.length);
  return results;
}

// Maps the configured freshness window to Facebook's own "Date listed"
// filter option label. null (no cap) deliberately skips touching the
// control at all rather than hunting for an "All listings"/equivalent
// option — leaving Facebook's own default in place is already "no age
// restriction." Facebook doesn't offer anything coarser than 30 days on
// this filter, so a longer configured window still maps to that.
function dateListedLabelFor(maxAgeHours: number | null): string | null {
  if (maxAgeHours === null) return null;
  if (maxAgeHours <= 24) return "Last 24 hours";
  if (maxAgeHours <= 24 * 7) return "Last 7 days";
  return "Last 30 days";
}

async function applyDateListedFilter(page: Page, maxAgeHours: number | null, onFallback?: (reason: string) => void): Promise<void> {
  const label = dateListedLabelFor(maxAgeHours);
  if (!label) return;

  const trigger = await findDateListedTrigger(page);
  if (!trigger) {
    const diagnosis = await diagnoseEmptyPage(page).catch((err) => `(diagnosis failed: ${err.message})`);
    onFallback?.(`Couldn't find the "Date listed" filter — searching without the ${label.toLowerCase()} freshness filter. Page state: ${diagnosis}`);
    return;
  }

  try {
    await trigger.click({ timeout: 5000 });
  } catch (err) {
    onFallback?.(`Couldn't open the "Date listed" filter (${(err as Error).message}) — searching without the ${label.toLowerCase()} freshness filter.`);
    return;
  }

  const option = await findDateListedOption(page, label);
  if (!option) {
    const diagnosis = await diagnoseEmptyPage(page).catch((err) => `(diagnosis failed: ${err.message})`);
    onFallback?.(`Opened "Date listed" but couldn't find a "${label}" option — searching without the ${label.toLowerCase()} freshness filter. Page state: ${diagnosis}`);
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  try {
    await option.click({ timeout: 5000 });
    // Facebook re-fetches results client-side after picking a filter
    // option — give that a moment before scrolling/extracting, same
    // reasoning as the 1500ms wait after submitting a search query above.
    await page.waitForTimeout(1500);
  } catch (err) {
    onFallback?.(`Couldn't select "${label}" (${(err as Error).message}) — searching without the ${label.toLowerCase()} freshness filter.`);
  }
}

// Verified live miss: the previous version of this function tried to
// click a "Price Range" control and type into Min/Max fields, guessed
// entirely from the Date Listed filter's own shape — reported live as
// "doesn't type anything," meaning either the trigger or the input fields
// never actually matched Facebook's real markup. Rather than keep
// guessing ARIA roles/labels for a panel this app has never actually seen
// rendered (this environment can't log into Facebook to inspect it),
// this switches to the SAME mechanism the URL-based fallback search
// already relies on (see buildSearchUrl below): Facebook Marketplace's
// search results page reads minPrice/maxPrice straight from its own URL
// query string, so re-navigating to a URL with those params added applies
// the filter without depending on finding or interacting with any specific
// UI element at all — far fewer ways for this to silently fail than a
// multi-step click-and-type sequence. Builds that URL from browseUrl/query
// (see this function's own param comments below for why), not from
// whatever applyDateListedFilter's click-based interaction may or may not
// have left in the URL bar — so Date Listed's own effect,
// if Facebook happens to encode it in the URL at all, doesn't survive this
// reload. Same backstop posture as before either way: scrapeEngine.ts's own
// per-SearchItem minPriceUsd/maxPriceUsd AND maxListingAgeHours checks in
// evaluateListing still enforce both ranges regardless of whether
// Facebook's own filters took.
async function applyPriceRangeFilter(
  page: Page,
  minPriceUsd: number | null,
  maxPriceUsd: number | null,
  // Per explicit instruction, diagnosed live: "only when i put in a min/max
  // price, it'll still just stay locked in richmond... when just searching
  // with no min/max, it's working." This used to build its target URL from
  // page.url() alone, trusting that typing the query (and applying Date
  // Listed) had already encoded the correct city + query into the URL bar.
  // They may not have — Facebook's search-box interaction and the Date
  // Listed filter both read as CLIENT-SIDE-only updates (no confirmed URL
  // change), so page.url() at this point could still be whatever bare city
  // URL was last actually navigated to. Reloading THAT with just
  // minPrice/maxPrice appended reapplies no query at all, and a bare
  // reload of a generic Marketplace URL is exactly the shape of request
  // that fell back to Facebook's own default location in an earlier bug
  // this session. browseUrl + query are the two things this function can
  // ALWAYS trust are correct (they're what the caller explicitly asked
  // for), so the target URL is built from those via the same buildSearchUrl
  // mechanism the "search box not found" fallback already relies on,
  // instead of trusting whatever page.url() happens to currently read.
  browseUrl: string,
  query: string,
  onFallback?: (reason: string, level?: "info" | "warn") => void
): Promise<void> {
  if (minPriceUsd === null && maxPriceUsd === null) return;

  try {
    const current = new URL(buildSearchUrl(browseUrl, query));
    if (minPriceUsd !== null) current.searchParams.set("minPrice", String(Math.max(0, Math.round(minPriceUsd))));
    if (maxPriceUsd !== null) current.searchParams.set("maxPrice", String(Math.max(0, Math.round(maxPriceUsd))));
    await page.goto(current.toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    // Per explicit instruction — "log searching for min/max prices too,"
    // same "leave a real trace in Activity" reasoning as the search-box
    // typing confirmation above — this used to only ever log on FAILURE,
    // so a successful price filter left no trace at all.
    const rangeLabel =
      minPriceUsd !== null && maxPriceUsd !== null
        ? `$${Math.round(minPriceUsd)}-$${Math.round(maxPriceUsd)}`
        : minPriceUsd !== null
          ? `$${Math.round(minPriceUsd)}+`
          : `up to $${Math.round(maxPriceUsd!)}`;
    // Per explicit redefinition of the search order — "log and check to
    // see if [filters] are filled in correctly constantly": re-read the
    // actual resulting URL rather than assuming the goto above applied the
    // params as intended — Facebook redirecting/stripping a query param
    // would otherwise silently look like a successful filter.
    const resultUrl = new URL(page.url());
    const minMatches = minPriceUsd === null || resultUrl.searchParams.get("minPrice") === String(Math.max(0, Math.round(minPriceUsd)));
    const maxMatches = maxPriceUsd === null || resultUrl.searchParams.get("maxPrice") === String(Math.max(0, Math.round(maxPriceUsd)));
    if (minMatches && maxMatches) {
      onFallback?.(`Applied price filter: ${rangeLabel}.`, "info");
    } else {
      onFallback?.(`Tried to apply price filter ${rangeLabel}, but the page doesn't reflect it (now "${resultUrl.search || "no filters"}") — it may not have taken.`, "warn");
    }
  } catch (err) {
    onFallback?.(`Couldn't apply your min/max price to the search (${(err as Error).message}) — searching without it.`);
  }
}

// Verified live via a screenshot the user shared (an earlier version of
// this guessed a filter-chip-style control on the results toolbar, like
// Date Listed, and that guess was wrong): Facebook's radius setting
// actually lives in a "Change location" dialog, opened from a SIDEBAR link
// reading "<City>, <State> · Within <N> mi" — present on any Marketplace
// page, not just search results. That dialog has its own "Location" text
// input plus a "Radius" dropdown showing the current value (e.g. "40
// miles"), and an "Apply" button. The exact ARIA roles/markup inside that
// dialog are still inferred from what the screenshot showed, not something
// actually inspected live — if any selector below is still wrong, that's
// the part to fix next.

// Scoped to the whole page rather than [role="main"] since this sidebar
// link sits outside it; matches on the stable "Within ... mi" wording
// rather than any specific city name, since the city half of that text
// changes with wherever the scanner currently is.
async function readCurrentRadiusMiles(page: Page): Promise<number | null> {
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const match = text.match(/within\s+(\d{1,4})\s*mi(?:les)?\b/i);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

// Same sidebar text as readCurrentRadiusMiles just above, just capturing
// the "City, State" half instead of the radius half — e.g. "Richmond,
// Virginia" out of "Richmond, Virginia · Within 100 mi". Used after
// changeLocation applies a new location so callers (see
// locationDiscovery.ts's discoverLocation) can find out which STATE a
// city/ZIP search actually resolved to, without needing to already know it
// going in — a ZIP code alone doesn't say what state it's in.
export async function readCurrentLocationLabel(page: Page): Promise<string | null> {
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const match = text.match(/([A-Za-z][A-Za-z .'-]*,\s*[A-Za-z][A-Za-z .'-]*?)\s*·\s*Within\s+\d{1,4}\s*mi/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function findChangeLocationTrigger(page: Page) {
  const strategies = [
    () => page.getByRole("button", { name: /within\s+\d+\s*mi/i }),
    () => page.getByRole("link", { name: /within\s+\d+\s*mi/i }),
    () => page.getByText(/within\s+\d+\s*mi/i),
  ];
  return waitForFirstVisible(
    strategies.map((s) => s().first()),
    5000
  );
}

async function findChangeLocationDialog(page: Page) {
  const strategies = [
    () => page.getByRole("dialog", { name: /change location/i }),
    () => page.getByRole("dialog"),
  ];
  return waitForFirstVisible(
    strategies.map((s) => s().first()),
    5000
  );
}

// The dialog's own "Radius" control — a dropdown-styled box reading the
// current value (e.g. "40 miles") right under a "Radius" label, per the
// screenshot. Tries it as a native <select> first (Playwright's
// selectOption is far more reliable than click-then-find-option when it
// genuinely is one), then falls back to a click-open-then-pick-option
// sequence — same pattern as findDateListedTrigger/findDateListedOption —
// in case it's actually a custom-styled listbox instead. The opened
// option list is searched at the PAGE level, not scoped to the dialog,
// since a dropdown's options commonly render in a portal outside the
// dialog's own DOM subtree.
async function setRadiusInDialog(page: Page, dialog: Awaited<ReturnType<typeof findChangeLocationDialog>>, targetMiles: number): Promise<boolean> {
  if (!dialog) return false;

  const select = dialog.locator("select").first();
  if (await select.count().catch(() => 0)) {
    try {
      await select.selectOption({ label: `${targetMiles} miles` });
      return true;
    } catch {
      // Not actually a native <select>, or that exact label didn't match — fall through.
    }
  }

  const trigger = await waitForFirstVisible(
    [
      dialog.getByRole("combobox", { name: /radius/i }).first(),
      dialog.locator('[aria-label*="radius" i]').first(),
      dialog.getByText(/^\d+\s*miles?$/i).first(),
    ],
    3000
  );
  if (!trigger) return false;
  try {
    await trigger.click({ timeout: 5000 });
  } catch {
    return false;
  }

  const pattern = new RegExp(`^${targetMiles}\\s*mi(?:les)?\\b`, "i");
  const option = await waitForFirstVisible(
    [
      page.getByRole("option", { name: pattern }).first(),
      page.getByRole("menuitem", { name: pattern }).first(),
      page.getByRole("radio", { name: pattern }).first(),
      page.getByText(pattern).first(),
    ],
    3000
  );
  if (!option) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  try {
    await option.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Per explicit instruction — "make sure the search radius is set to 100
// miles before starting a search" and "make sure the 100 mile radius stays
// the same throughout a search." Unlike Price Range, there's no known
// URL-query-string equivalent for this to switch to (that fix only worked
// because Facebook Marketplace's search URL was already confirmed to read
// minPrice/maxPrice from its own querystring — no equivalent has been
// found/verified for radius), so this stays a click-based best-effort:
// if Facebook's markup doesn't match these guesses, this reports that via
// onFallback and moves on rather than blocking the search. Read-then-
// click-only-if-needed (not a blind click every time) so a correctly-set
// radius doesn't get needlessly reopened on every check.
export async function verifyOrSetRadius(
  page: Page,
  targetMiles: number,
  onFallback?: (reason: string, level?: "info" | "warn") => void
): Promise<void> {
  const before = await readCurrentRadiusMiles(page);
  if (before === targetMiles) {
    onFallback?.(`Confirmed search radius is set to ${targetMiles} miles.`, "info");
    return;
  }

  const locationTrigger = await findChangeLocationTrigger(page);
  if (!locationTrigger) {
    const diagnosis = await diagnoseEmptyPage(page).catch((err) => `(diagnosis failed: ${err.message})`);
    onFallback?.(
      `Couldn't find the "Change location" sidebar link to confirm the ${targetMiles}-mile search radius${
        before !== null ? ` (currently reads ${before} miles)` : ""
      } — searching without confirming it. Page state: ${diagnosis}`
    );
    return;
  }

  try {
    await locationTrigger.click({ timeout: 5000 });
  } catch (err) {
    onFallback?.(`Couldn't open "Change location" (${(err as Error).message}) — searching without confirming the ${targetMiles}-mile radius.`);
    return;
  }

  const dialog = await findChangeLocationDialog(page);
  if (!dialog) {
    onFallback?.(`Clicked the location link but the "Change location" dialog never appeared — searching without confirming the radius.`);
    return;
  }

  const set = await setRadiusInDialog(page, dialog, targetMiles);
  if (!set) {
    onFallback?.(`Opened "Change location" but couldn't find/select a "${targetMiles} miles" radius option — searching without confirming it.`);
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  try {
    const applyButton = await waitForFirstVisible([dialog.getByRole("button", { name: /^apply$/i }).first()], 3000);
    if (applyButton) await applyButton.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
  } catch (err) {
    onFallback?.(`Selected ${targetMiles} miles but couldn't click Apply (${(err as Error).message}) — the change may not have taken.`);
    return;
  }

  const after = await readCurrentRadiusMiles(page);
  if (after === targetMiles) {
    onFallback?.(`Search radius had drifted to ${before ?? "an unreadable value"} — changed it back to ${targetMiles} miles.`, "info");
  } else {
    onFallback?.(
      `Tried to set the search radius to ${targetMiles} miles but couldn't confirm it took (now reads ${after ?? "unreadable"}) — continuing anyway.`
    );
  }
}

// The SAME "Change location" dialog verifyOrSetRadius drives above —
// confirmed live via a screenshot showing its own "Location" field holding
// a full "City, State" value (e.g. "Richmond, Virginia" — the full state
// name, never a 2-letter abbreviation, confirmed directly against that
// screenshot) right under a "Search by city, neighborhood or ZIP code."
// instruction line, alongside the same Radius control and Apply button.
// Scoped to the dialog and matched on "location" specifically so it's
// never confused with the dialog's own "Change location" title or the
// neighboring Radius field.
async function findLocationFieldInDialog(dialog: NonNullable<Awaited<ReturnType<typeof findChangeLocationDialog>>>) {
  const strategies = [
    () => dialog.getByRole("combobox", { name: /location/i }),
    () => dialog.getByRole("textbox", { name: /location/i }),
    () => dialog.getByRole("searchbox", { name: /location/i }),
    () => dialog.locator('[aria-label*="location" i]'),
    () => dialog.getByRole("button", { name: /location/i }),
  ];
  return waitForFirstVisible(
    strategies.map((s) => s().first()),
    3000
  );
}

// Reported live (screenshot: typing ZIP "10282" correctly surfaced a real
// suggestion card reading "New York, NY" / "8 people checked in here"
// right under the field) — but the OLD version below never actually
// clicked it, and the flow stalled before Apply was ever attempted. Root
// cause: that version built its match pattern from the RAW text typed
// (e.g. the digits "10282") and required the suggestion to literally
// contain it — which works for a real "City, State" query (the suggestion
// contains the city name) but can NEVER work for a ZIP code, since
// Facebook resolves it to a real place name with no textual relationship
// to the digits typed. A role="option" suggestion is tried first (doesn't
// need any text match at all, and can't be confused with the dialog's own
// map — the map's plain city labels, e.g. "Charleston"/"Columbus" visible
// in that same screenshot, carry no such role); a dialog-scoped text match
// against the CITY half of "City, State" is tried next for a named-city
// query; failing both, arrowing down to the top suggestion and pressing
// Enter (exactly how a person selects it with a keyboard, needing no
// knowledge of the suggestion's markup at all) is what actually handles
// the ZIP case. Every text-based attempt is scoped to the DIALOG, never
// the whole page, so it can't grab the map's labels or anything in the
// marketplace feed behind the dialog overlay.
async function setLocationInDialog(page: Page, dialog: Awaited<ReturnType<typeof findChangeLocationDialog>>, targetCityState: string): Promise<boolean> {
  if (!dialog) return false;
  const field = await findLocationFieldInDialog(dialog);
  if (!field) return false;

  try {
    await field.click({ clickCount: 3, timeout: 5000 });
    await field.fill("").catch(() => {});
    await field.type(targetCityState, { delay: 40 });
  } catch {
    return false;
  }
  await page.waitForTimeout(1200);

  const properOption = await waitForFirstVisible([dialog.getByRole("option").first()], 2500);
  if (properOption) {
    try {
      await properOption.click({ timeout: 3000 });
      return true;
    } catch {
      // fall through
    }
  }

  const cityShort = targetCityState.split(",")[0].trim();
  if (!/^\d+$/.test(cityShort)) {
    const escaped = cityShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");
    const textMatch = await waitForFirstVisible(
      [dialog.getByRole("button", { name: pattern }).first(), dialog.getByText(pattern).first()],
      2000
    );
    if (textMatch) {
      try {
        await textMatch.click({ timeout: 3000 });
        return true;
      } catch {
        // fall through to the keyboard approach below
      }
    }
  }

  try {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    return true;
  } catch {
    return false;
  }
}

// Per explicit instruction — the "State"/"City" location modes (see
// locationDiscovery.ts's discoverLocation, the only caller) need to resolve
// a REAL Marketplace URL for a chosen city, driving this same "Change
// location" dialog rather than guessing/fabricating a location ID. An
// earlier version of that lookup guessed its own separate, never-verified
// trigger/dialog logic before this dialog had actually been seen live —
// this reuses the SAME proven find-trigger/find-dialog/click-Apply
// sequence verifyOrSetRadius above already uses for the exact same dialog,
// just driving the Location field instead of (or alongside) the Radius one.
// targetRadiusMiles, when given, sets the Radius dropdown in this SAME
// dialog visit — per explicit instruction, a City/ZIP search should only
// ever cover 20 miles around that exact spot (not whatever radius happened
// to be set before), and that has to go through the same single Apply
// click as the location change itself, not a separate one. A failure to
// set the radius is treated as non-fatal — the location change is still
// worth applying, and the per-cycle verifyOrSetRadius check (above) is a
// standing safety net that'll correct the radius on its own regardless.
export async function changeLocation(
  page: Page,
  targetCityState: string,
  targetRadiusMiles?: number
): Promise<{ ok: boolean; error: string | null; resolvedLocationLabel: string | null }> {
  const trigger = await findChangeLocationTrigger(page);
  if (!trigger) return { ok: false, error: 'Could not find/open the "Change location" sidebar link', resolvedLocationLabel: null };

  try {
    await trigger.click({ timeout: 5000 });
  } catch (err) {
    return { ok: false, error: `Could not open "Change location" (${(err as Error).message})`, resolvedLocationLabel: null };
  }

  const dialog = await findChangeLocationDialog(page);
  if (!dialog) return { ok: false, error: 'Clicked the location link but the "Change location" dialog never appeared', resolvedLocationLabel: null };

  const set = await setLocationInDialog(page, dialog, targetCityState);
  if (!set) {
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: false, error: "No matching suggestion appeared for this city in the Location field", resolvedLocationLabel: null };
  }

  if (targetRadiusMiles !== undefined) {
    await setRadiusInDialog(page, dialog, targetRadiusMiles).catch(() => false);
  }

  try {
    const applyButton = await waitForFirstVisible([dialog.getByRole("button", { name: /^apply$/i }).first()], 3000);
    if (!applyButton) return { ok: false, error: 'Selected a suggestion but could not find the "Apply" button', resolvedLocationLabel: null };
    await applyButton.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
  } catch (err) {
    return { ok: false, error: `Could not click Apply (${(err as Error).message})`, resolvedLocationLabel: null };
  }

  const resolvedLocationLabel = await readCurrentLocationLabel(page);
  return { ok: true, error: null, resolvedLocationLabel };
}

// By this point the page has already been sitting around at least as long
// as the search-box interaction above took, so it's had more time to settle
// — a shorter wait than the search box's 5000ms is enough, same
// wait-instead-of-instant-check reasoning as findSearchMarketplaceBox.
async function findDateListedTrigger(page: Page) {
  const strategies = [
    () => page.getByRole("button", { name: /date listed/i }),
    () => page.getByRole("combobox", { name: /date listed/i }),
    () => page.locator('[aria-label*="date listed" i]'),
    () => page.getByText(/^date listed$/i),
  ];
  return waitForFirstVisible(
    strategies.map((s) => s().first()),
    3000
  );
}

// Generalized from a "Last 24 hours"-only version — per explicit
// instruction, the freshness window is now configurable (see
// dateListedLabelFor), so this needs to find whichever option label that
// resolved to. The bare "24 hours" (no "Last") alternate phrasing is kept
// only for that one specific option, since that was verified live as a
// real alternate rendering Facebook has used for it; no equivalent
// short-form is assumed for the 7/30-day options without the same live
// verification.
async function findDateListedOption(page: Page, label: string) {
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const strategies = [
    () => page.getByRole("radio", { name: pattern }),
    () => page.getByRole("menuitem", { name: pattern }),
    () => page.getByRole("option", { name: pattern }),
    () => page.getByText(pattern),
    ...(label === "Last 24 hours"
      ? [() => page.getByRole("radio", { name: /^24 hours$/i }), () => page.getByText(/^24 hours$/i)]
      : []),
  ];
  return waitForFirstVisible(
    strategies.map((s) => s().first()),
    3000
  );
}

// Races every strategy's locator against each other, waiting (not just
// instantly checking) for one to actually become visible — see the big
// comment on findSearchMarketplaceBox below for why this specifically
// fixes a real, reported bug. Bounded to `timeoutMs` total (not stacked
// per-strategy), since they're all racing the same clock.
async function waitForFirstVisible(candidates: ReturnType<Page["locator"]>[], timeoutMs: number): Promise<ReturnType<Page["locator"]> | null> {
  try {
    return await Promise.any(
      candidates.map(async (loc) => {
        await loc.waitFor({ state: "visible", timeout: timeoutMs });
        return loc;
      })
    );
  } catch {
    return null;
  }
}

async function findSearchMarketplaceBox(page: Page) {
  const strategies = [
    () => page.getByPlaceholder(/search marketplace/i),
    () => page.getByRole("combobox", { name: /search marketplace/i }),
    () => page.getByRole("searchbox", { name: /search marketplace/i }),
    () => page.getByRole("textbox", { name: /search marketplace/i }),
    () => page.locator('input[aria-label*="search marketplace" i]'),
    () => page.locator('[contenteditable="true"][aria-label*="search marketplace" i]'),
  ];
  // Verified live against Facebook's own logged-out Marketplace preview:
  // the search box genuinely does carry role="combobox" with an accessible
  // name of "Search Marketplace" — these strategies are correct. The actual
  // bug (reported live: "it doesn't actually search in the search bar") was
  // that this used to check with an INSTANT locator.count(), which reads
  // the DOM at that exact instant — but Facebook is a heavy client-rendered
  // SPA, and page.goto only waits for domcontentloaded, well before React
  // has necessarily mounted the Marketplace UI. Checking immediately after
  // navigation could see nothing for every strategy and silently fall
  // through to the URL-based fallback below, even though the real search
  // box would have appeared moments later. Waiting (with a real timeout)
  // for one to become visible, instead of an instant snapshot check, closes
  // that race.
  const found = await waitForFirstVisible(
    strategies.map((s) => s().first()),
    5000
  );
  if (found) return found;

  // Last resort: the visible "Search Marketplace" text confirmed in a live
  // screenshot doesn't seem to correspond to an actual `placeholder`/
  // `aria-label` attribute the strategies above depend on — Facebook likely
  // renders it as a separate overlay element instead, real on custom-styled
  // inputs. This works around that by finding the literal on-page text
  // "Search Marketplace" directly, then walking up a few ancestor levels
  // looking for a real input/contenteditable/textbox living nearby — the
  // same "walk up from a known anchor" approach already used for Facebook's
  // seller-signal parsing, since exact class names here aren't something I
  // can verify live. Tags the match with a temporary attribute so it can be
  // handed back as a normal Playwright locator.
  const marker = "data-mscout-searchbox";
  const domWalkFound = await page
    .evaluate((markerAttr) => {
      const all = Array.from(document.querySelectorAll("*"));
      const label = all.find((el) => {
        const text = (el.textContent || "").trim();
        return /^search marketplace$/i.test(text) && el.children.length === 0;
      });
      if (!label) return false;
      let node: Element | null = label;
      for (let i = 0; i < 6 && node; i++) {
        const input = node.querySelector('input, [contenteditable="true"], [role="combobox"], [role="searchbox"], [role="textbox"]');
        if (input) {
          input.setAttribute(markerAttr, "1");
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }, marker)
    .catch(() => false);

  if (!domWalkFound) return null;
  const locator = page.locator(`[${marker}]`);
  return (await locator.count()) > 0 ? locator.first() : null;
}

// Fallback only (see searchMarketplace above) — swaps the `query` param
// onto your own captured browseUrl rather than inventing search path/params
// from scratch, same reasoning as the location/radius URL.
function buildSearchUrl(browseUrl: string, query: string): string {
  const url = new URL(browseUrl);
  if (!url.pathname.replace(/\/$/, "").endsWith("/search")) {
    url.pathname = url.pathname.replace(/\/$/, "") + "/search";
  }
  url.searchParams.set("query", query);
  if (!url.searchParams.has("exact")) {
    url.searchParams.set("exact", "false");
  }
  return url.toString();
}

// Verified live miss #3, the actual root cause: page.waitForSelector's
// DEFAULT `state` is "visible" (attached to the DOM AND actually painted —
// non-zero size, not display:none/visibility:hidden/opacity:0), not just
// "exists." Reported live as "Empty browse" repeatedly, on pages whose OWN
// diagnostic snapshot (see diagnoseEmptyPage, taken moments after this gave
// up) reliably found the exact same `/marketplace/item/` links via a plain
// document.querySelectorAll — which doesn't check visibility at all. That
// gap is the signature of "visible": a heavy SPA like Marketplace commonly
// renders cards into the DOM inside a skeleton/fade-in wrapper before they
// finish becoming visible, and evidently that transition here reliably
// takes longer than this used to wait. We don't actually need these
// anchors to be visible for anything we do with them — extraction reads
// href/innerText attributes directly via page.evaluate() regardless of
// visibility, and the scroll loop right after this doesn't depend on it
// either — so "attached" (exists in the DOM at all) is the correct, and
// evidently much faster to satisfy, condition to actually wait for here.
async function waitForListingLinks(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector('a[href*="/marketplace/item/"]', { state: "attached", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function readListingAnchors(page: Page): Promise<
  Array<{
    id: string;
    url: string;
    ariaLabel: string | null;
    innerText: string;
    thumbnailUrl: string | null;
  }>
> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
    const seen = new Set<string>();
    const results: Array<{
      id: string;
      url: string;
      ariaLabel: string | null;
      innerText: string;
      thumbnailUrl: string | null;
    }> = [];

    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      const match = href.match(/\/marketplace\/item\/(\d+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const img = a.querySelector("img") as HTMLImageElement | null;
      results.push({
        id,
        url: `https://www.facebook.com/marketplace/item/${id}/`,
        ariaLabel: a.getAttribute("aria-label"),
        innerText: (a as HTMLElement).innerText ?? "",
        thumbnailUrl: img?.src ?? null,
      });
    }
    return results;
  });
}

// Per explicit instruction — "most relevant results exist at the top of
// the page, not the bottom... prioritize looking at the first few results,
// only scroll if there are no good matches": this used to ALWAYS scroll
// the full maxScrolls (8 — several full screens) BEFORE ever reading the
// page at all, on every single call, whether the top of the page already
// had plenty to look at or not. Facebook's own results are relevance-
// sorted, but that sort only covers actual matches for the query — once
// those run out, scrolling further pulls in whatever "you might also
// like"-style backfill Facebook renders next, which is exactly the
// "most unrelated" stuff described live as showing up. Every listing (top
// AND bottom) then got evaluated identically, with nothing keeping the
// genuinely relevant top-of-page results the priority.
//
// Now reads the page FIRST with no scrolling, and only scrolls (one step
// at a time, re-checking after each) when there genuinely aren't enough
// candidates on screen yet — the common case for an actual product search
// (a search term like "ps5" alone easily clears this without scrolling at
// all) never touches the deeper backfill zone in the first place; scrolling
// toward maxScrolls only still happens for a thin/slow-loading page, same
// worst case as before this change, not a regression for that case.
const EARLY_STOP_CANDIDATE_COUNT = 12;

async function extractListingsFromCurrentPage(page: Page, maxScrolls: number): Promise<ListingSummary[]> {
  // Verified live: the item-link pattern this waits for is still exactly
  // right, and a real Marketplace page (once it actually finishes
  // rendering) has plenty of these — a "0 listings" result is far more
  // likely a slow/heavy initial render than a genuinely empty page, so one
  // retry after a short pause is worth it before writing off the whole
  // location. Reported live as "Empty browse" on a page that, per
  // diagnoseEmptyPage's OLD body-wide snippet, looked indistinguishable
  // from a real empty page even when it wasn't (see that function's own
  // comment) — this retry plus that fix together should both reduce false
  // empties and make any real ones actually diagnosable going forward.
  let found = await waitForListingLinks(page, 15000);
  if (!found) {
    await page.waitForTimeout(3000);
    found = await waitForListingLinks(page, 8000);
  }
  if (!found) return [];

  let raw = await readListingAnchors(page);
  let scrollsUsed = 0;
  while (raw.length < EARLY_STOP_CANDIDATE_COUNT && scrollsUsed < maxScrolls) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(700);
    scrollsUsed++;
    raw = await readListingAnchors(page);
  }

  return raw.map((r) => parseListingCard(r));
}

function parseListingCard(r: {
  id: string;
  url: string;
  ariaLabel: string | null;
  innerText: string;
  thumbnailUrl: string | null;
}): ListingSummary {
  const source = r.ariaLabel && r.ariaLabel.length > 5 ? r.ariaLabel : r.innerText;
  const lines = source
    .split(/\n|,\s*(?=\$)/)
    .map((l) => l.trim())
    .filter(Boolean);

  const priceLine = lines.find((l) => /\$\s?[\d,]+/.test(l));
  const price = priceLine ? parsePrice(priceLine) : null;

  const nonPriceLines = lines.filter((l) => l !== priceLine);
  // A single leftover line that's shaped exactly like "City, State"/"City,
  // ST" is almost certainly the card's location with no real title text
  // available at all (see looksLikeBareLocation's own doc comment) — that
  // case falls back to "(untitled listing)" rather than silently wearing
  // the location as its title, and keeps the location text itself instead
  // of discarding it.
  const soleLine = nonPriceLines.length === 1 ? nonPriceLines[0] : null;
  const soleLineIsLocation = soleLine !== null && looksLikeBareLocation(soleLine);
  const title = soleLineIsLocation ? "(untitled listing)" : nonPriceLines.sort((a, b) => b.length - a.length)[0] ?? "(untitled listing)";
  const locationText = soleLineIsLocation ? soleLine : nonPriceLines.length > 1 ? nonPriceLines[nonPriceLines.length - 1] : null;

  return {
    id: r.id,
    url: r.url,
    title,
    price,
    thumbnailUrl: r.thumbnailUrl,
    locationText,
  };
}

function parsePrice(text: string): number | null {
  const match = text.match(/\$\s?([\d,]+)/);
  if (!match) return null;
  const n = parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export async function fetchListingDetail(page: Page, listing: ListingSummary): Promise<ListingDetail> {
  await timed("detail_page_load", () => page.goto(listing.url, { waitUntil: "domcontentloaded" }));
  // Everything from here to the return below is parsing/extraction against
  // the now-loaded page (no further navigation) — timed as one "detail
  // extraction" stage, separate from the page load above, since those are
  // the two genuinely distinct steps that already exist here (unlike
  // "extraction" vs "normalization," which this codebase doesn't actually
  // separate — DOM parsing produces already-normalized fields directly).
  // Recorded manually rather than via timed()'s callback wrapper since this
  // function has a single exit point already, several lines below.
  const detailExtractionStart = Date.now();
  await page.waitForTimeout(1200);

  const bodyText: string = await page.evaluate(() => {
    const main = document.querySelector('[role="main"]') as HTMLElement | null;
    return (main ?? document.body).innerText ?? "";
  });

  // Best-effort: FB usually renders alt text like "<name>'s profile picture"
  // on the seller avatar. If we can't find any such image, we don't know
  // whether a photo exists or Facebook just labeled it differently —
  // hasProfilePhoto stays null (unknown) rather than a false "no photo".
  // That same alt text is also the one reliably-parseable place a plain
  // seller name shows up in the markup, so it's extracted here too rather
  // than adding a second DOM query for it.
  const { hasProfilePhoto: hasProfilePhotoRaw, sellerName } = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll("img[alt]"));
    const avatar = imgs.find((img) => /profile (picture|photo)/i.test(img.getAttribute("alt") ?? ""));
    if (!avatar) return { hasProfilePhoto: null as boolean | null, sellerName: null as string | null };
    const alt = avatar.getAttribute("alt") ?? "";
    const nameMatch = alt.match(/^(.+?)'s profile (picture|photo)$/i);
    // A default/placeholder silhouette avatar is still an <img>, but its alt
    // text or nearby text sometimes says so explicitly; otherwise we can't
    // distinguish a real photo from a placeholder purely from markup, so a
    // found avatar element counts as "has a photo" — this may occasionally
    // be wrong for placeholder avatars but errs toward not falsely
    // excluding real sellers.
    return { hasProfilePhoto: true, sellerName: nameMatch ? nameMatch[1] : null };
  });

  const description = bodyText.slice(0, 4000);
  const shippingMentioned = /\bship(ping|s)?\b|\bdelivery\b|\bmail(ed)?\b/i.test(description);

  // Verified live via a screenshot the user shared: a listing that's opted
  // into Facebook's own shipping program shows its own distinct wording
  // ("Ships for $13.18," "No returns for this item," "Estimated arrival
  // Sep 21 - Sep 24," "Door dropoff") — not a hidden local deal, since it's
  // already visible and buyable by every other reseller nationally through
  // Facebook's own logistics. A mention of eBay is treated the same way
  // (implies it's already cross-listed/benchmarked elsewhere). Checked
  // against the full bodyText (not just the 4000-char description slice
  // above), since this wording can sit further down the page than that
  // slice covers.
  const hasOfficialShipping = /\bships for \$|\bestimated arrival\b|\bdoor drop[- ]?off\b/i.test(bodyText);
  const mentionsEbay = /\bebay\b/i.test(bodyText);

  const seller = await extractSellerSignals(page, bodyText, hasProfilePhotoRaw, sellerName);
  const listingAge = extractListingAge(bodyText);

  // Best-effort: grab every photo on the listing page, not just the one
  // search-card thumbnail. Facebook's photo galleries often render a full
  // thumbnail strip in the DOM even when only one large image is "active",
  // so this can usually pick up the full set without needing to click
  // through the carousel — but that's an assumption about markup I
  // couldn't verify live (see the note at the top of this file), so
  // treat this as "probably most of the photos," not guaranteed all of
  // them.
  //
  // Scoped to [role="main"] (same region already used for bodyText above)
  // and excludes anything carrying the "<name>'s profile picture" alt-text
  // pattern (see the seller-avatar extraction above) — verified live this
  // was otherwise picking up "People You May Know"/friend-suggestion
  // avatars from elsewhere on the page (they're also served from
  // fbcdn.net, so the CDN filter alone didn't exclude them), which then
  // showed up as if they were photos of the actual listing.
  //
  // Verified live miss, reported as the Feed's photo carousel showing an
  // unrelated product entirely: a real listing detail page's [role="main"]
  // also contains a "related listings"/"more like this" section further
  // down the SAME page, and on the one item checked live, 20 of 21
  // fbcdn-hosted images in that region belonged to THAT section, not the
  // actual listing (an unrelated AirPods Max, a Mercedes, a zero-turn
  // mower, etc.) — each one wrapped in its own link to a DIFFERENT
  // marketplace listing. The real listing's own gallery photos are NOT
  // wrapped in a link to another item, which also explains the exact
  // symptom reported ("the first image and maybe the second and third...
  // display correctly" then unrelated ones "quickly come up" — the real
  // gallery comes first in DOM order, the unrelated section right after
  // it, both swept up together by the old unscoped query). Excluding
  // anything inside such a link removes the unrelated section entirely
  // while keeping the listing's own photos.
  // Per explicit instruction — "sometimes the ai will come across sellers
  // that have videos in their listings": a video's own poster/thumbnail
  // frame commonly renders as just another <img> in the same gallery,
  // indistinguishable from a real photo to the plain querySelectorAll
  // below — left in, it could end up used as the fallback/representative
  // photo (see scrapeEngine.ts) even though it's often a bad angle,
  // mid-motion, or a paused intro screen rather than a real product shot.
  // Best-effort, same posture as the alt-text/related-listings filters
  // already here: excludes any image whose OWN alt/aria-label explicitly
  // says "video" (a real <video> element's poster image is commonly
  // labeled this way) — this can't catch every possible rendering of a
  // video thumbnail Facebook might use, which is exactly why hasVideo is
  // ALSO surfaced separately, so analyzeListingPhotos can stay alert for
  // one that slips through this filter and still ends up in imageUrls.
  // Reported live via a screenshot: a listing detail page can also render a
  // sponsored "Ad" unit right inline in this same [role="main"] region,
  // below Seller information — a small bold "Ad" label with its own "..."
  // menu, structurally the same idea as the related-listings section
  // already excluded below, just a different (unrelated) product's photo
  // riding along uninvited. Same "walk up a few ancestors from a text
  // landmark" approach as the related-listings exclusion: finds every leaf
  // element whose OWN trimmed text is exactly "Ad" and treats a handful of
  // ancestor levels around it as off-limits for photo extraction. Haven't
  // been able to verify this against a live Facebook session myself (see
  // the note at the top of this file) — this is built directly off what was
  // visible in that screenshot, not independently confirmed.
  const { urls: imageUrls, hasVideo } = await page.evaluate(() => {
    const main = document.querySelector('[role="main"]') as HTMLElement | null;
    const scope: ParentNode = main ?? document.body;
    const hasVideo = !!scope.querySelector("video");

    const adContainers: Element[] = [];
    const walker = document.createTreeWalker(scope as Node, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
      if (node.children.length === 0 && node.textContent?.trim() === "Ad") {
        let container: Element = node;
        for (let i = 0; i < 5 && container.parentElement; i++) container = container.parentElement;
        adContainers.push(container);
      }
    }

    const urls = Array.from(scope.querySelectorAll("img"))
      .filter((img) => !/profile (picture|photo)/i.test(img.getAttribute("alt") ?? ""))
      .filter((img) => !img.closest('a[href*="/marketplace/item/"]'))
      .filter((img) => !/\bvideo\b/i.test(`${img.getAttribute("alt") ?? ""} ${img.getAttribute("aria-label") ?? ""}`))
      .filter((img) => !adContainers.some((c) => c.contains(img)))
      .map((img) => (img as HTMLImageElement).src)
      .filter((src) => src && /\bfbcdn\.net\b/i.test(src));
    return { urls: Array.from(new Set(urls)).slice(0, 12), hasVideo };
  });

  recordStage("detail_extraction", Date.now() - detailExtractionStart, true);
  return {
    ...listing,
    description,
    shippingMentioned,
    seller,
    imageUrls,
    hasVideo,
    hasOfficialShipping,
    mentionsEbay,
    listingAge,
  };
}

// Facebook renders this as e.g. "Listed 3 weeks ago in Crimora, VA" —
// captured verbatim (not parsed into a date) rather than converted to a
// timestamp, since its own precision is already vague (weeks, not days);
// computing a fake-precise date from it would just be manufacturing
// precision that isn't really there.
function extractListingAge(pageText: string): string | null {
  const match = pageText.match(/\bListed\s+([^\n]*?\bago\b|yesterday|today|just now)/i);
  return match ? match[1].trim() : null;
}

async function extractSellerSignals(
  page: Page,
  pageText: string,
  hasProfilePhoto: boolean | null,
  name: string | null
): Promise<ListingDetail["seller"]> {
  const joinMatch = pageText.match(/Joined Facebook in (\d{4})/i);
  const joinedFacebookYear = joinMatch ? parseInt(joinMatch[1], 10) : null;

  // Rating patterns vary ("4.8", "4.8 out of 5", "4.8 · 12 ratings"); take
  // the first plausible decimal-or-int rating near the word "rating(s)".
  const ratingMatch = pageText.match(/(\d(?:\.\d)?)\s*(?:out of 5|\/\s*5|stars?)?\s*(?:·|\()?\s*(\d+)\s*ratings?/i);
  let rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
  let ratingCount = ratingMatch ? parseInt(ratingMatch[2], 10) : null;

  // Verified live miss, reported as Feed showing "no seller rating
  // available" for a listing whose page clearly showed 5 filled stars and
  // a "(5)" count: Facebook can render the rating as star ICONS with no
  // visible numeric text at all — nothing for the plain-text regex above
  // to match against. Falls back to reading an accessible label (Facebook
  // is generally accessibility-conscious, so a star-rating graphic without
  // any visible number very likely still carries one for screen readers)
  // and, separately, a bare "(N)" count sitting near that same element
  // even without the word "rating(s)" next to it, which is what the
  // screenshot showed. Genuinely unverified beyond that one screenshot —
  // if Facebook's actual aria-label wording differs from what's guessed
  // here, this will keep coming up empty the same way the old regex did.
  if (rating === null || ratingCount === null) {
    const ariaResult = await page
      .evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("[aria-label]"));
        const ratingEl = candidates.find((el) => {
          const label = el.getAttribute("aria-label") ?? "";
          return /\d(?:\.\d)?\s*(?:out of|\/)\s*5\b/i.test(label) || /^rated\s+\d/i.test(label);
        });
        if (!ratingEl) return { rating: null as number | null, ratingCount: null as number | null };
        const label = ratingEl.getAttribute("aria-label") ?? "";
        const ratingNumMatch = label.match(/(\d(?:\.\d)?)/);
        const ariaRating = ratingNumMatch ? parseFloat(ratingNumMatch[1]) : null;

        // The visible "(N)" count commonly sits as a sibling/nearby text
        // node right after the star icons — walk a couple of ancestor
        // levels looking for it rather than assuming an exact structure.
        let scope: Element | null = ratingEl.parentElement;
        let ariaRatingCount: number | null = null;
        for (let i = 0; i < 3 && scope && ariaRatingCount === null; i++) {
          const countMatch = (scope.textContent ?? "").match(/\((\d+)\)/);
          if (countMatch) ariaRatingCount = parseInt(countMatch[1], 10);
          scope = scope.parentElement;
        }
        return { rating: ariaRating, ratingCount: ariaRatingCount };
      })
      .catch(() => ({ rating: null as number | null, ratingCount: null as number | null }));
    rating = rating ?? ariaResult.rating;
    ratingCount = ratingCount ?? ariaResult.ratingCount;
  }

  return { joinedFacebookYear, rating, ratingCount, hasProfilePhoto, name };
}
