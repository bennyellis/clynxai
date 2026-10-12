import { powerSaveBlocker } from "electron";
import { isLowAiMode } from "./aiMode.js";
import type { BrowserContext, Page } from "playwright";
import { openPersistentContext, isLoggedIn, politeDelay } from "./browser.js";
import { explainScannerError, failureBackoffMs, FAILING_CYCLES_BEFORE_NOTICE, type ScannerErrorExplanation } from "./scannerErrors.js";
import { classifyFacebookPage, describeSessionProblem, readPageSnapshot, looksLikeHealthyFacebookPage, type SessionProblem } from "./facebookSession.js";
import { buildWatchSearchUrl, browseListings, searchMarketplace, fetchListingDetail, diagnoseEmptyPage, verifyOrSetRadius, readCurrentLocationLabel } from "./scraper.js";
import {
  scoreListing,
  getSearchTerms,
  getSearchQuery,
  isRelevantToSearchItems,
  matchSearchItem,
  findGreenFlagCandidate,
  evaluateSearchItemPricing,
  detectConditionImpact,
  CONDITION_VALUE_MULTIPLIER,
} from "./scorer.js";
import { detectScamBot, evaluateSellerRisk } from "./sellerRisk.js";
import { sendDealAlert, sendWatchMatchAlert, sendWorthALookAlert } from "./notify.js";
import { buildQualifiedAlert, qualifyScoredListing, type MarketChecker, type Qualification } from "./preAlert.js";
import type { GateExtras } from "./dealGate.js";
import { isSuspiciousPrice } from "./placeholderPrice.js";
import { looksBroken } from "./brokenVariant.js";
import { watchAsSearchItems, matchWatchTerm, passesWatchPriceGate, deriveWatchReferencePrice, evaluateWatchConditions } from "./watchMatching.js";
import { resaleSettingsFrom } from "./resaleMath.js";
import { extrasPricedSeparately, isHiddenGemCandidate, repriceWithExtras } from "./profitGate.js";
import { decideAgeGate } from "./listingAge.js";
import { gateExtrasFromLump, gateExtrasFromValuation, looksLikeBundle, type BundleValuation } from "./bundleBreakdown.js";
import { analyzeListingPhotos, classifyThumbnailImage, matchesReferenceProduct, type PhotoAnalysisResult } from "./vision.js";
import { resolveIdentityTarget } from "./productIdentity.js";
import { downloadImageAsDataUri, shrinkImageDataUri } from "./webResearch.js";
import { DEFAULT_COUNTRY_CITIES } from "./config.js";
import { prefilterWatchListing } from "./watchFacebook.js";
import { checkWatchBounds } from "./watchGeo.js";
import { isConfidentMatch, verifyWatchProduct } from "./watchVerify.js";
import { DEFAULT_WATCH_RADIUS_MILES as DEFAULT_WATCH_RADIUS_MILES_SHARED } from "./watchOptions.js";
import { discoverLocation, discoverLocations as discoverLocationsViaBrowser, lookupTopCitiesInState, type LocationDiscoveryResult } from "./locationDiscovery.js";
import { searchSoldComps, type EbayComp } from "./watchcount.js";
import { listingStateMatches } from "./usStates.js";
import { Store } from "./store.js";
import { timed, timedSync, recordEvent, recordStage, setGauge } from "./metrics.js";
import type {
  BlacklistedImage,
  BlacklistTerm,
  DealTier,
  EngineConfig,
  ExtractionResult,
  ListingDetail,
  ListingPreview,
  ListingRecord,
  ListingSummary,
  LogLine,
  ProductProfile,
  ScoredListing,
  ScrapeStatus,
  SearchItem,
  SellerRiskResult,
  Watch,
  WatchTerm,
} from "./types.js";
import type { NarrationContext } from "./chat.js";

// Placeholder prices ($0, $1, $1234...) are skipped before ever visiting the detail page: see placeholderPrice.ts, shared with
// Watches, the eBay scanner and the notification gate.
export { isSuspiciousPrice };

// Per explicit instruction, tightened after a live miss: a listing titled
// "Xbox Series X" that was actually just a controller got flagged as an
// 83%-under deal at $59 — the old version of this check exempted "$X9"
// charm pricing, so $59 sailed through untouched. The user's call: don't
// bother with a listing at all unless its price is a genuine round number
// ending in 0 or 5 — anything else (including former "charm price"
// exceptions like $49/$59/$99) reads as more likely scam bait or an
// unnoteworthy price than a real deal worth a detail-page visit and an AI
// call. Applies to every price, not just a narrow two-digit band like the
// old version did.
export function isNonRoundPrice(price: number): boolean {
  return price % 5 !== 0;
}

// Facebook Marketplace skews heavily toward big-ticket local-pickup-only
// categories (vehicles, furniture, appliances) that a mail-order reseller
// can never actually buy — fully evaluating those (a detail-page visit + an
// AI call) just wastes time on something that was never actionable. This is
// a blunt keyword heuristic, not a real category classifier — Facebook's
// own category field isn't reliably exposed in the markup this app can see
// — so it deliberately errs toward under-flagging: a missed unshippable
// listing costs one wasted evaluation, but a false positive here would
// silently hide something genuinely wanted. Checked against the title only
// (the one thing available before opening the listing), same "skip before
// the detail page" posture as isSuspiciousPrice above.
const UNSHIPPABLE_PATTERNS: RegExp[] = [
  // vehicles — generic body-style/type words alone miss most real listings,
  // since these are almost always titled by year + make + model instead
  // (e.g. "2015 Honda Civic EX"), never the word "car" itself. Caught two
  // other ways instead: a leading model year next to a recognized make, or
  // a mileage figure — both near-universal in how vehicles get listed.
  /\bcars?\b/i, /\btrucks?\b/i, /\bsuv\b/i, /\bsedan\b/i, /\bminivan\b/i, /\bvan\b/i,
  /\bmotorcycles?\b/i, /\bmoped\b/i, /\batv\b/i, /\butv\b/i, /\bgolf cart\b/i,
  /\bboats?\b/i, /\btrailers?\b/i, /\b(rv|camper)\b/i,
  /\b(19|20)\d{2}\s+(honda|toyota|ford|chevrolet|chevy|nissan|hyundai|kia|jeep|dodge|ram|gmc|bmw|mercedes(-|\s)?benz|audi|volkswagen|vw|subaru|mazda|lexus|acura|infiniti|buick|cadillac|chrysler|mitsubishi|volvo|tesla|porsche|land\s*rover|mini(?:\s*cooper)?|pontiac|saturn|scion|lincoln)\b/i,
  /\b\d{1,3},?\d{3}\s*miles\b/i,
  // bikes — per explicit instruction: boxing/shipping one is enough of a
  // hassle that it's treated the same as a vehicle here.
  /\bbikes?\b/i, /\bbicycles?\b/i,
  // furniture
  /\bsofas?\b/i, /\bcouch(es)?\b/i, /\bsectional\b/i, /\bloveseat\b/i, /\brecliner\b/i, /\bmattress(es)?\b/i,
  /\bbed\s*frame\b/i, /\bdresser\b/i, /\bwardrobe\b/i, /\barmoire\b/i, /\bdining\s*table\b/i,
  /\bbookshelf\b/i, /\bbookcase\b/i, /\bcrib\b/i, /\bsectional\s*couch\b/i,
  // appliances
  /\brefrigerators?\b/i, /\bfridge\b/i, /\bwashers?\b/i, /\bdryers?\b/i, /\bdishwashers?\b/i,
  /\bstoves?\b/i, /\bovens?\b/i, /\bfreezers?\b/i,
  // other bulky/local-only
  /\btreadmill\b/i, /\belliptical\b/i, /\bpiano\b/i, /\bhot\s*tub\b/i, /\bpool\s*table\b/i,
  /\briding\s*mower\b/i, /\blawn\s*mower\b/i, /\bshed\b/i, /\bstatue\b/i, /\bgazebo\b/i,
  /\btrampoline\b/i, /\bswing\s*set\b/i, /\bplayset\b/i, /\babove\s*ground\s*pool\b/i,
  /\bstorage\s*(container|pod)\b/i,
  // real estate / property — per explicit instruction ("houses, property for
  // rent"): a mail-order reseller can't buy or ship a property any more than
  // a car, and Facebook's Marketplace mixes these into the same feed as
  // resalable items.
  /\bhouses?\s+for\s+(sale|rent)\b/i, /\bhomes?\s+for\s+(sale|rent)\b/i, /\bcondos?\b/i,
  /\bapartments?\s+for\s+rent\b/i, /\btownhouse\b/i, /\bfor\s+rent\b/i, /\bfor\s+lease\b/i,
  /\breal\s*estate\b/i, /\b\d+\s*(bed|bd)\s*\/?\s*\d+(\.\d+)?\s*(bath|ba)\b/i, /\backreage\b/i,
  /\blot\s+for\s+sale\b/i, /\bland\s+for\s+sale\b/i,
];

// Returns the specific matched text (e.g. "sofa", "houses for rent") rather
// than just true/false, so callers can use that exact phrase as a
// blacklist term — precise enough to be reusable across listings, unlike
// blacklisting an entire (always-different) title.
export function findUnshippableMatch(title: string): string | null {
  for (const re of UNSHIPPABLE_PATTERNS) {
    const m = title.match(re);
    if (m) return m[0];
  }
  return null;
}

export function isLikelyUnshippable(title: string): boolean {
  return findUnshippableMatch(title) !== null;
}

// Moved to listingAge.ts (pure, no Playwright/Electron deps — needed by
// ebayEngine.ts too) — re-exported here so every existing import site in
// this file (and elsewhere) keeps working unchanged.
export { estimateListingAgeHours, isListingTooOld } from "./listingAge.js";
import { estimateListingAgeHours, isListingTooOld } from "./listingAge.js";

// Best-effort human-readable label for a browseUrl, so location-rotation
// messages say "Phoenix, AZ" instead of a bare index number or an opaque
// URL. Covers the nationwide state-capital list this app ships with by
// slug (see config.ts's DEFAULT_BROWSE_URLS) — there's no algorithmic way
// to turn a concatenated lowercase slug like "oklahomacity" back into
// "Oklahoma City" without a lookup table, so unrecognized slugs (a custom
// URL you captured yourself, e.g. a numeric Facebook location ID) just
// fall back to that raw slug rather than guessing at a name.
const CITY_LABELS: Record<string, string> = {
  montgomery: "Montgomery, AL",
  phoenix: "Phoenix, AZ",
  littlerock: "Little Rock, AR",
  sacramento: "Sacramento, CA",
  denver: "Denver, CO",
  hartford: "Hartford, CT",
  dover: "Dover, DE",
  tallahassee: "Tallahassee, FL",
  atlanta: "Atlanta, GA",
  boise: "Boise, ID",
  springfield: "Springfield, IL",
  indianapolis: "Indianapolis, IN",
  desmoines: "Des Moines, IA",
  topeka: "Topeka, KS",
  frankfort: "Frankfort, KY",
  batonrouge: "Baton Rouge, LA",
  augusta: "Augusta, ME",
  annapolis: "Annapolis, MD",
  boston: "Boston, MA",
  lansing: "Lansing, MI",
  saintpaul: "Saint Paul, MN",
  jackson: "Jackson, MS",
  jeffersoncity: "Jefferson City, MO",
  helena: "Helena, MT",
  lincoln: "Lincoln, NE",
  carsoncity: "Carson City, NV",
  concord: "Concord, NH",
  trenton: "Trenton, NJ",
  santafe: "Santa Fe, NM",
  albany: "Albany, NY",
  raleigh: "Raleigh, NC",
  bismarck: "Bismarck, ND",
  columbus: "Columbus, OH",
  oklahomacity: "Oklahoma City, OK",
  salem: "Salem, OR",
  harrisburg: "Harrisburg, PA",
  providence: "Providence, RI",
  columbia: "Columbia, SC",
  pierre: "Pierre, SD",
  nashville: "Nashville, TN",
  austin: "Austin, TX",
  saltlakecity: "Salt Lake City, UT",
  montpelier: "Montpelier, VT",
  richmond: "Richmond, VA",
  olympia: "Olympia, WA",
  charleston: "Charleston, WV",
  madison: "Madison, WI",
  cheyenne: "Cheyenne, WY",
};

export function describeLocationUrl(url: string): string {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean)[1];
    if (!slug) return url;
    return CITY_LABELS[slug] ?? slug;
  } catch {
    return url;
  }
}

// Fisher-Yates — a fresh random permutation of [0..n) every call. Used so
// a cycle's random-city rotation visits every location exactly once, in a
// freshly randomized order each cycle, rather than either the same fixed
// sequence every time OR independent random draws that can redraw the same
// city more than once in a row (verified live: "it kept rebounding to
// Richmond... without looking for anything" — see runCycle's own comment
// on its visitOrder).
function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// A lightweight, display-only snapshot for Dashboard's Live panel (see
// ScrapeStatus.currentListing/upcomingListings) — just enough for a
// thumbnail + title + price card.
function toPreview(listing: ListingSummary): ListingPreview {
  return { id: listing.id, title: listing.title, price: listing.price, thumbnailUrl: listing.thumbnailUrl, url: listing.url };
}

export interface ScrapeEngineOptions {
  profileDir: string;
  // Per explicit instruction — multiple Facebook accounts: this engine
  // instance belongs to exactly ONE account, so what it reads is that
  // account's own location fields merged onto the shared Config (see
  // types.ts's EngineConfig and index.ts's createEngineForAccount) —
  // everything below this line reads exactly like it always has, just
  // sourced from a synthesized object instead of the single global Config
  // a one-account setup used to have.
  getConfig: () => EngineConfig;
  store: Store;
  onLog: (line: LogLine) => void;
  onListing: (record: ListingRecord) => void;
  onStatus: (status: ScrapeStatus) => void;
  // Fired when a real listing reinforces an EXISTING Database entry (see
  // recordProductObservation in runPhotoAnalysis/evaluateListing) — same
  // live-update purpose as onListing, but for the Database tab. Scanning
  // itself never creates new products, only index.ts does that (chat's
  // research_product tool, or the Feed's Research button), so this only
  // ever fires for something the user already asked to track.
  onProductUpdated: (product: ProductProfile) => void;
  // Per explicit instruction, live: "finding these sorts of tiny little
  // differences [colors, D-pad shape across generations] can make all the
  // difference" — fired whenever a real, confirmed listing photo gets
  // added to an EXISTING product's Reference Photos gallery here (see
  // evaluateListing below), so index.ts can run a fresh cross-photo
  // comparison (vision.ts's analyzeReferencePhotoDifferences) — a newly
  // added photo could be exactly the one that reveals a difference the
  // rest of the gallery didn't show. Optional since index.ts is the only
  // caller with the store access + fire-and-forget dedup this needs;
  // scrapeEngine.ts itself doesn't hold either.
  onReferencePhotoAdded?: (productId: string) => void;
  // Fired when this account's Facebook session is found to be unusable (logged out, or stopped by a security check), and again with
  // null once it is working again. Only on a change, never repeated, so the owner can raise and clear a persistent notice.
  onSessionProblem?: (problem: SessionProblem | null) => void;
  // Fired when scan cycles keep failing (FAILING_CYCLES_BEFORE_NOTICE in a row), with a plain-words explanation, and with null once a
  // cycle works again. Only on a change, so the owner can raise and clear a persistent notice.
  onCycleFailing?: (info: (ScannerErrorExplanation & { failures: number }) | null) => void;
  // Fired for a live AI one-liner — a reaction to a deal, or a recap after
  // finishing a batch. Best-effort: narration failures are swallowed by
  // the caller so an OpenAI hiccup never breaks scraping.
  onNarrate: (ctx: NarrationContext) => Promise<void>;
  // Fired whenever the blacklist changes from WITHIN the engine itself —
  // right now, only the auto-add on an off-topic general-deal suggestion
  // (see evaluateListing) — so the Database screen's Blacklist section
  // updates live if it's open while scanning, the same live-update pattern
  // as onProductUpdated/onListing above. Manual add/remove from the
  // Database chat or its UI goes through index.ts directly instead, since
  // those already know the renderer's window.
  onBlacklistUpdated: (terms: BlacklistTerm[]) => void;
  // Same live-update purpose as onBlacklistUpdated above, for the image
  // blacklist (see evaluateListing's thumbnail pre-check) — fires whenever
  // scanning recognizes a listing's photo as an ineligible category and
  // adds it to the Database's Blacklisted Images gallery.
  onBlacklistImagesUpdated: (images: BlacklistedImage[]) => void;
  // Per explicit instruction — scanning now creates a brand-new Database
  // entry for a specific, confidently-identified product it doesn't
  // already track (see evaluateListing's researchSubjects loop), instead of
  // only ever reinforcing existing ones. Implemented in index.ts (same
  // create-stub + kick off background web research pattern as the manual
  // Research button/research_product chat tool) since that's where
  // randomUUID/runProductLookup/mainWindow already live — imageDataUri is a
  // REAL photo downloaded from the actual listing that triggered this, so
  // index.ts can set it as a trusted ("kept") thumbnail the background web
  // research is never allowed to overwrite; null means no listing photo was
  // available, so the normal generic web-image search is the only source.
  onNewProductFound: (
    name: string,
    imageDataUri: string | null,
    sourceListingTitle: string,
    // A specific model/color of an existing entry (see productIdentity.ts), as opposed to a brand-new product.
    relation?: { parentId: string | null; familyFromId: string }
  ) => void;
  // Per explicit instruction — Watch's own persistent-monitoring alert,
  // fired once store.recordWatchMatch has actually written a NEW row (its
  // own UNIQUE(watch_id, listing_id) + INSERT OR IGNORE already guarantees
  // this never double-fires for the same watch+listing pair — see
  // evaluateListing/runPostScoringPipeline below for the two points a
  // match can be recorded from). Optional for the same reason
  // onReferencePhotoAdded is — index.ts is the only caller with the
  // renderer-broadcast + ntfy access this needs.
  onWatchMatch?: (watch: Watch, match: { listingId: string }) => void;
  // Looks the product up on WatchCount and eBay (and files what it finds in the Database) before an alert goes out; see preAlert.ts.
  checkMarket?: MarketChecker;
  // For a Search For item that includes broken listings: makes sure its "(For Parts / Broken)" Database variant exists and knows what
  // broken ones sell for, before a broken listing is priced (see index.ts's ensureBrokenVariant).
  ensureBrokenVariant?: (itemName: string, listingTitle: string) => Promise<void>;
  // A listing that holds several products ("PS5 Pro with 2 controllers and a 2TB drive"): break it into items, price each one on its
  // own and value the lot with the main item as the focal point (see bundleBreakdown.ts and index.ts's valueListingBundle). Null when
  // it turns out to be one product, or the breakdown wasn't possible.
  valueBundle?: (args: { title: string; description: string; mainName: string; mainValueUsd: number }) => Promise<BundleValuation | null>;
}

// A readable name for a Marketplace place address ("…/marketplace/richmond/" ->
// "Richmond"); the fallback when the address is just an id.
function placeLabelFromUrl(url: string, fallback: string): string {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean)[1] ?? "";
    if (!/^[a-z-]+$/i.test(slug)) return fallback;
    return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return fallback;
  }
}

interface ListingEvalResult {
  counted: boolean;
  isDeal: boolean;
  title: string;
  price: number | null;
  dealTier: "search" | "general" | null;
  discountPercent: number | null;
  estimatedValueRange: string | null;
  reasoning: string;
  notable: boolean; // worth mentioning in a batch recap even though not a deal
  // Per explicit instruction — diagnosed live: "to maintain the original
  // search, it has to enter a product found under that search and then go
  // BACK to the previous page where the original searched term and filters
  // are stored." True only once evaluateListing has actually navigated the
  // shared page to the listing's own detail URL (see fetchListingDetail's
  // call site below) — every earlier instant-skip (price, blacklist,
  // shippability, ...) never touches the page at all, so going back after
  // one of those would wrongly navigate past the search-results page
  // instead of preserving it. The active-search loops in runCycle/
  // searchForItemNow use this to decide whether page.goBack() is actually
  // needed before moving to the next candidate.
  visitedDetailPage: boolean;
}

const NOT_COUNTED: ListingEvalResult = {
  counted: false,
  isDeal: false,
  title: "",
  price: null,
  dealTier: null,
  discountPercent: null,
  estimatedValueRange: null,
  reasoning: "",
  notable: false,
  visitedDetailPage: false,
};

export class ScrapeEngine {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  // Serializes every operation that touches the shared Facebook `page` —
  // the continuous scan loop (runOnce, called repeatedly from loop()) and a
  // chat-triggered "search for this right now" (searchForItemNow) both
  // drive the same single Playwright page, and two navigations at once on
  // one page would corrupt each other. Whoever calls withPage() first runs
  // first; everything else waits its turn. A chat search issued mid-cycle
  // therefore runs as soon as the current cycle finishes, not instantly —
  // there's only one tab, so it can't literally interrupt a page mid-load.
  private pageQueue: Promise<void> = Promise.resolve();
  private running = false;
  private stopRequested = false;
  // True between beginStarting() and start(): the account has been told to start but is still looking up its saved
  // location on Facebook (which can take minutes for a state). It counts as running (so the Dashboard shows "Scanning" and
  // Stop works) and stop() cancels it.
  private starting = false;
  // Set right before every deliberate context/page close this class does
  // itself (stop(), login()'s reopen-for-manual-login) so the close
  // listeners wired up below (see wireContextCloseDetection/
  // wirePageCloseDetection) can tell "we did this on purpose" apart from
  // "the user closed the actual Chrome window" —
  // only the latter should trigger the auto-stop-on-close behavior.
  private closingIntentionally = false;
  // Set the instant a chat-triggered searchForItemNow is called, cleared
  // once it actually starts running — a soft, temporary version of
  // stopRequested that only abandons the REST of whatever runCycle is
  // currently doing (checked at the same loop boundaries) rather than
  // stopping the engine. Without this, a chat request just sat in
  // withPage's FIFO queue behind however much of the current cycle was
  // left — up to every remaining location — which is exactly the "wait
  // several minutes, or worse, collide with an in-flight page.goto" issue
  // reported live. The user's own request should never have to wait behind
  // the scanner's own agenda.
  private priorityRequested = false;
  // Set when a Watch has finished with this account's browser while its scan was
  // sitting out the wait between cycles: the wait ends early so the scan resumes
  // now instead of after the rest of the interval (see runWatchCheck).
  private wakeRequested = false;
  private loopPromise: Promise<void> | null = null;
  // Per explicit instruction — a long unattended scan shouldn't get cut off
  // because Windows decided the machine was idle and suspended it (network
  // gone, Playwright's page frozen mid-navigation). 'prevent-app-suspension'
  // (not 'prevent-display-sleep') is deliberately the lighter of the two —
  // it stops the SYSTEM from sleeping but still lets the display itself
  // turn off/lock on its own schedule, which doesn't affect a Playwright
  // page's ability to keep loading/scripting in the background. Only held
  // while the scanner is actually running (see start()/stop() below), not
  // for the app's whole lifetime — no reason to block sleep just because
  // the window is open and idle.
  private powerSaveBlockerId: number | null = null;
  // Per explicit instruction — "no reason to search watchcount multiple
  // times" for the same product within one scan (see Config's
  // watchCountOncePerScan). Plain in-memory tracking, not persisted —
  // reset every time a fresh scan actually starts (see start() below), so
  // "within a scan" means exactly that: stop and start again (or an
  // automatic restartEngineIfRunning, which is itself a deliberate "start
  // clean" per earlier explicit instruction) and every product is fair
  // game again.
  private ebayResearchedProductIds = new Set<string>();
  hasResearchedEbayComps(productId: string): boolean {
    return this.ebayResearchedProductIds.has(productId);
  }
  markEbayCompsResearched(productId: string): void {
    this.ebayResearchedProductIds.add(productId);
  }
  // Per explicit instruction — decouple runPhotoAnalysis from the critical
  // scan loop: a small bounded-concurrency background queue for the
  // vision-dependent tail of evaluateListing (see runPostScoringPipeline).
  // evaluateListing enqueues a job and returns a PROVISIONAL result
  // immediately instead of awaiting the vision call inline, so runCycle's
  // loop can move on to the next listing right away; the job runs the
  // EXACT SAME decision logic that used to run synchronously here once
  // vision actually completes, re-saving the record so Feed/Activity pick
  // up the final result the moment it's ready. Concurrency defaults to 1 —
  // matching today's behavior where only one vision call was ever in
  // flight at a time (it was awaited inline) — so this changes ONLY
  // whether it blocks the scan loop, not how many OpenAI vision calls run
  // at once; bump VISION_WORKER_COUNT if you want real parallelism later.
  private visionJobs: Array<() => Promise<void>> = [];
  private visionWorkersActive = 0;
  private static readonly VISION_WORKER_COUNT = 1;

  private enqueueVisionJob(job: () => Promise<void>): void {
    this.visionJobs.push(job);
    setGauge("vision_queue_depth", this.visionJobs.length);
    this.pumpVisionQueue();
  }

  private pumpVisionQueue(): void {
    while (this.visionWorkersActive < ScrapeEngine.VISION_WORKER_COUNT && this.visionJobs.length > 0) {
      const next = this.visionJobs.shift()!;
      setGauge("vision_queue_depth", this.visionJobs.length);
      this.visionWorkersActive++;
      next().finally(() => {
        this.visionWorkersActive--;
        this.pumpVisionQueue();
      });
    }
  }
  private status: ScrapeStatus = {
    running: false,
    loggedIn: null,
    currentSearch: null,
    listingsThisCycle: 0,
    locationIndex: 0,
    lastCycleStartedAt: null,
    lastCycleFinishedAt: null,
    lastError: null,
    currentListing: null,
    upcomingListings: [],
    currentActionNote: null,
    analyzingPhotos: false,
    currentReaction: null,
  };
  // The browseUrls index currently being visited — set fresh from a
  // reshuffled random order at the start of every cycle (see runCycle's
  // visitOrder), not incremented sequentially. Persists between cycles
  // only in the sense that it's whatever location was last visited, which
  // searchForItemNow (a chat-triggered search between cycles) reuses as a
  // reasonable default.
  private locationIndex = 0;
  // Per explicit instruction, diagnosed live: the image-vs-reference-photo
  // check (see evaluateListing's greenFlagCandidate computation) was
  // reported as "not rotating locations again" — it's a REAL vision call,
  // and running it unbounded for every listing whose title didn't already
  // match reintroduced exactly the "vision blocking discovery" problem the
  // earlier queue-based decoupling of photo analysis was built to solve,
  // just in a new spot. This caps how many of those calls one location
  // visit will make; reset at the start of each per-visit block in
  // runCycle. Once exhausted, a listing whose title doesn't match just
  // falls through to the ordinary instant-skip, same as before this
  // feature existed — the cap trades "catch every possible image match" for
  // "never stall rotation," which is the right side of that tradeoff here.
  private imageMatchAttemptsThisLocation = 0;
  private static readonly MAX_IMAGE_MATCH_ATTEMPTS_PER_LOCATION = 5;
  // Found during Phase 3 review, not part of the original spec: changeLocation
  // (scraper.ts) only touches Facebook's own Radius dropdown when given an
  // EXPLICIT number — undefined leaves it at whatever this account's browser
  // session last happened to have set, from completely unrelated activity.
  // Every other caller (resolveAccountLocationIfNeeded's city/state/country
  // modes) always passes a real number for exactly this reason. A Watch's
  // own searchRadiusMiles is legitimately null when the user leaves it blank
  // (per spec, every condition but the search phrase is optional) — this is
  // what runWatchCheck falls back to in that case, matching the existing
  // city-mode account default, rather than inheriting arbitrary leftover state.
  private static readonly DEFAULT_WATCH_RADIUS_MILES = DEFAULT_WATCH_RADIUS_MILES_SHARED;
  // Per explicit redefinition of the search order — set once the scan has
  // done its one-time per-scan setup (a plain radius check, no dedicated
  // "starting city" anchor — a Richmond-specific version of this existed
  // briefly and was removed per direct feedback that it was itself a
  // source of bugs; see runCycle); reset in start()/triggerOnce() so a
  // fresh scan always redoes it, but never set again mid-scan.
  private scanSetupDone = false;
  // The Facebook session problem found on the page the scanner is looking at (see guardSession). sessionBroken ends the current
  // cycle early; reportedProblem remembers what the owner was last told, so it hears about changes only.
  private sessionBroken = false;
  // Locations a cycle tried to open, and how many of them could not be opened at all (no connection, browser gone). When every one
  // failed the cycle did nothing, which must count as a failed cycle (see the end of runCycle), not a quiet success.
  private visitsAttempted = 0;
  private visitsNotOpened = 0;
  private lastNotOpenedMessage = "";
  private consecutiveFailures = 0;
  private reportedFailureKind: string | null = null;
  private reportedProblem: SessionProblem | null = null;
  // Which Search For item currently gets the dedicated active search, and
  // how many listings have been evaluated for it since the last switch —
  // both used only when config.rotateSearchItems is on (2+ Search For
  // items). Deliberately never reset by runCycle/loop, on their own clock
  // entirely independent of locationIndex — see runCycle's active-search
  // block and the Config.rotateSearchItems doc comment in types.ts.
  private activeSearchItemIndex = 0;
  private listingsSinceItemRotation = 0;

  constructor(private opts: ScrapeEngineOptions) {}

  getStatus(): ScrapeStatus {
    return this.status;
  }

  // Whether a browser window this engine opened is still around — true not
  // just while the continuous scanner is running, but also after login()
  // (a manual-login window) or a chat-triggered searchForItemNow, neither of
  // which ever flips `running`. index.ts's stop_scanner uses this so "stop"
  // can still close a lingering window even when the scanner was never
  // formally "running" to begin with.
  hasOpenBrowser(): boolean {
    return this.context !== null;
  }

  private setStatus(patch: Partial<ScrapeStatus>) {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.status);
  }

  // listingUrl is passed for essentially every per-listing line now (see
  // types.ts's own doc comment) — Activity renders the whole row as a link
  // to it. productName is the in-app counterpart, for a line about a
  // specific Database product rather than an external listing.
  private log(level: LogLine["level"], message: string, listingUrl?: string, productName?: string) {
    this.opts.onLog({ ts: Date.now(), level, message, ...(listingUrl ? { listingUrl } : {}), ...(productName ? { productName } : {}) });
  }

  // Interruptible replacement for browser.ts's politeDelay, used
  // everywhere in this file instead — that helper just does a plain
  // setTimeout with zero awareness of stopRequested, which is the actual
  // "Stop just freezes" bug: the between-cycle wait (see loop()) is 4-9
  // MINUTES long, so clicking Stop during it used to do nothing until that
  // full wait elapsed naturally, since stop() awaits loopPromise which
  // can't resolve until the sleep does. This checks stopRequested every
  // ~250ms and returns early the moment it flips, so Stop now takes effect
  // in well under a second during any of these waits — the one part of
  // the pipeline that's fully within our control to interrupt. An in-flight
  // network call (an AI request, an eBay/Facebook page load) still has to
  // run out its own timeout before a cycle can finish unwinding — that's
  // bounded (tens of seconds, not minutes), not literally instant, but no
  // longer able to hang indefinitely either.
  private async sleep(minMs: number, maxMs: number, wakeable = false): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs);
    const deadline = Date.now() + ms;
    while (!this.stopRequested && !(wakeable && this.wakeRequested)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  }

  // Per explicit instruction: if the user closes the Facebook Marketplace
  // browser window/tab while the scanner is running, stop the scan instead
  // of what used to happen — ensureBrowser() saw this.page.isClosed() on
  // the next cycle and just silently launched a brand-new tab in its place,
  // so closing the window never actually stopped anything. Wired onto both
  // the page itself (the actual Marketplace tab) and the whole context
  // (covers the browser window closing outright) — registered once per
  // object, right where each gets created below, not on every
  // ensureBrowser() call, so a context/page that's still alive never picks
  // up a second redundant listener.
  // Split into two thin, concretely-typed wrappers (rather than one taking
  // BrowserContext | Page) since TS can't resolve a union type against
  // EventEmitter#once's per-type event-name overloads.
  private closeDetectionHandler(): () => void {
    return () => {
      if (this.closingIntentionally) return; // stop()/login() closing this on purpose
      if (!this.running) return; // already stopped, or never really "running" to begin with
      this.log("warn", "The Facebook Marketplace browser window was closed — stopping the scanner.");
      this.stop().catch((err) => this.log("error", `Failed to stop cleanly after the browser closed: ${(err as Error).message}`));
    };
  }
  private wireContextCloseDetection(context: BrowserContext): void {
    context.once("close", this.closeDetectionHandler());
  }
  private wirePageCloseDetection(page: Page): void {
    page.once("close", this.closeDetectionHandler());
  }

  // Single-flight guarded (browserLaunching) — runOnce() calls this at the
  // start of every cycle, and without the guard two overlapping calls
  // could each see no context yet and launch their own Chrome against the
  // same locked profile directory.
  private browserLaunching: Promise<Page> | null = null;
  // Reported live: "browserContext.newPage: Target page, context or
  // browser has been closed" — thrown well after the actual Chrome window
  // had already been closed by hand (or crashed/got killed outright).
  // wireContextCloseDetection's "close" listener is what's SUPPOSED to
  // null out this.context/this.page the moment that happens, but it's
  // fire-and-forget (async stop(), never awaited from the event handler)
  // and simply never fires at all if the browser process dies without
  // Playwright ever seeing a clean close event — leaving this.context a
  // stale-but-non-null reference that every later this.context.pages()/
  // newPage() call throws against. isClosed() on this.page alone can't
  // catch that: a page can report itself closed while this.context is
  // still the dead reference, so the `!this.context` branch below never
  // re-fires either. Retrying exactly once against a freshly-launched
  // context/page (instead of throwing this back out to whatever the user
  // just clicked — Start, a watchcount lookup, a location change) is what
  // actually makes this self-heal.
  private async ensureBrowser(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.browserLaunching) return this.browserLaunching;

    this.browserLaunching = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (!this.context) {
            const headless = this.opts.getConfig().headless;
            this.context = await openPersistentContext(this.opts.profileDir, headless);
            this.wireContextCloseDetection(this.context);
          }
          if (!this.page || this.page.isClosed()) {
            this.page = this.context.pages()[0] ?? (await this.context.newPage());
            this.wirePageCloseDetection(this.page);
          }
          return this.page;
        } catch (err) {
          if (attempt > 0 || !/closed/i.test((err as Error).message)) throw err;
          this.log("warn", `Browser window was already gone (${(err as Error).message}) — relaunching a fresh one.`);
          this.context = null;
          this.page = null;
        }
      }
    })();

    try {
      return await this.browserLaunching;
    } finally {
      this.browserLaunching = null;
    }
  }

  // Opens a brand-new tab within the shared persistent context — used by
  // anything that needs its OWN tab rather than the shared Facebook page
  // (fetchEbayComps, openWatchCountLogin below). Same self-healing posture
  // as ensureBrowser above: this.context can still be the dead reference
  // even right after ensureBrowser() itself just returned successfully
  // (e.g. the browser was closed in the brief window between that call and
  // this one), so this.context!.newPage() gets the same catch-reset-retry
  // treatment rather than being allowed to throw "...has been closed" back
  // out to the caller.
  private async openNewTab(): Promise<Page> {
    await this.ensureBrowser();
    try {
      return await this.context!.newPage();
    } catch (err) {
      if (!/closed/i.test((err as Error).message)) throw err;
      this.context = null;
      this.page = null;
      await this.ensureBrowser();
      return await this.context!.newPage();
    }
  }

  // See the pageQueue field comment — the mutual-exclusion mechanism that
  // keeps the continuous scan loop and a chat-triggered search from ever
  // driving the shared Facebook page at the same time.
  private withPage<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn();
    const result = this.pageQueue.then(run, run);
    this.pageQueue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async checkLogin(): Promise<boolean> {
    const page = await this.ensureBrowser();
    const loggedIn = await isLoggedIn(page);
    this.setStatus({ loggedIn });
    this.noteSession(loggedIn ? null : "logged-out");
    return loggedIn;
  }

  // A cycle that threw: counted, and once it has happened FAILING_CYCLES_BEFORE_NOTICE times in a row the owner is told why in plain
  // words (and again if the cause changes). A cycle that finishes without throwing resets the count and withdraws the notice.
  private noteCycleFailed(message: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILING_CYCLES_BEFORE_NOTICE) return;
    const explained = explainScannerError(message);
    if (this.reportedFailureKind === explained.kind) return;
    this.reportedFailureKind = explained.kind;
    try {
      this.opts.onCycleFailing?.({ ...explained, failures: this.consecutiveFailures });
    } catch {
      /* a notice that cannot be shown must not break scanning */
    }
  }

  private noteCycleSucceeded(): void {
    this.consecutiveFailures = 0;
    if (this.reportedFailureKind === null) return;
    this.reportedFailureKind = null;
    try {
      this.opts.onCycleFailing?.(null);
    } catch {
      /* see above */
    }
  }

  // Tells the owner (once per change) what is wrong with the Facebook session, or that it is fine again.
  private noteSession(problem: SessionProblem | null): void {
    if (problem === this.reportedProblem) return;
    this.reportedProblem = problem;
    try {
      this.opts.onSessionProblem?.(problem);
    } catch {
      /* a notice that cannot be shown must not break scanning */
    }
  }

  /**
   * Looks at the page the browser is showing right now (no navigation, milliseconds) for a login wall or a security check. Facebook
   * does not announce an expired session: the next page just is not Marketplace. On a problem the account is marked logged out, the
   * owner is told once, and the current cycle ends (`sessionBroken`); the next cycle looks again, so scanning resumes on its own
   * once the user has logged in. Returns true when there is a problem.
   */
  private async guardSession(page: Page, where: string): Promise<boolean> {
    const snapshot = await readPageSnapshot(page);
    if (!snapshot) return false; // could not tell: never stop a scan on a guess
    const problem = classifyFacebookPage(snapshot);
    if (problem) {
      this.sessionBroken = true;
      const words = describeSessionProblem(problem, "this account");
      if (this.reportedProblem !== problem) this.log("error", `${words.short} (seen ${where}; page: ${snapshot.url})`);
      this.setStatus({ loggedIn: false, lastError: words.short });
      this.noteSession(problem);
      return true;
    }
    if (looksLikeHealthyFacebookPage(snapshot) && this.reportedProblem) {
      this.log("info", "Facebook session is working again.");
      this.setStatus({ loggedIn: true, lastError: null });
      this.noteSession(null);
    }
    return false;
  }

  // Opens a headed window into the SAME browser profile the scraper reuses
  // (regardless of the headless config), so the user can log in by hand AND
  // set their Marketplace location + max distance filter — both need to
  // happen inside this exact profile, since Facebook appears to store the
  // radius preference locally per-browser rather than on the account, so it
  // won't carry over from the user's regular browser. Polls in the
  // background for login completion; the user can keep the window open as
  // long as they want to adjust filters before it's used for scraping.
  async login(): Promise<boolean> {
    // Per explicit instruction — a direct user action should bypass
    // whatever the scanner's own cycle is doing, not wait for it or (worse,
    // without this) race it. Same signal searchForItemNow uses: a cycle
    // that's still mid-flight checks this at its own checkpoints and bails
    // out of its remaining work early. This can't eliminate the case where
    // a cycle is already mid-navigation on the shared page the instant this
    // is called (there's still only one tab), but it closes the much more
    // likely window where login() would otherwise tear down and replace
    // the shared context/page out from under a cycle that's actively using
    // them, which used to be able to happen with zero coordination at all.
    this.priorityRequested = true;
    this.closingIntentionally = true;
    if (this.context) {
      // Already-closed (browser window gone, process killed, ...) throws
      // the same "...has been closed" error closing it again would be
      // pointless to propagate from — this is tearing it down on purpose
      // either way, so a context that's already dead is just as good as
      // one this successfully closed itself.
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }
    this.context = await openPersistentContext(this.opts.profileDir, false);
    this.wireContextCloseDetection(this.context);
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.wirePageCloseDetection(this.page);
    this.closingIntentionally = false;
    this.priorityRequested = false;
    await this.page.goto("https://www.facebook.com/marketplace/");
    this.log(
      "info",
      "Facebook window opened. Log in if needed, then also set your Marketplace location + max distance filter here — this exact window is what the scraper reuses."
    );

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await politeDelay(4000, 4000);
      const stillHasLoginForm = await this.page.$('input[name="pass"]');
      if (!stillHasLoginForm) {
        const confirmed = await isLoggedIn(this.page);
        if (confirmed) {
          this.setStatus({ loggedIn: true, lastError: null });
          this.noteSession(null);
          this.log("info", "Login confirmed.");
          return true;
        }
      }
    }
    this.log("warn", "Login not detected within 10 minutes.");
    return false;
  }

  // Drives Facebook's own "Change location" dialog to resolve a city name
  // (State mode's single primary city, or City/ZIP mode's exact input) into
  // a real Marketplace location URL — see locationDiscovery.ts. Uses the
  // same browser profile as everything else, so you need to be logged in
  // first.
  //
  // Per explicit instruction — Config's own "Search locations" setting can
  // trigger this from Config, a real navigation/wait sequence that's a
  // likely thing to fire WHILE a scan cycle is already running. Same
  // priorityRequested + withPage() pattern as searchForItemNow, so this
  // jumps the line instead of racing an in-progress cycle for the shared
  // page.
  // `onEachResult`, added per explicit instruction ("why does it need to
  // keep searching for [locations], it's already there") — lets a caller
  // (see index.ts's resolveAccountLocationIfNeeded) persist each city's
  // outcome to disk the MOMENT it happens, not just once this whole method
  // returns. A 48-city country-mode pass takes a genuine 12-15 minutes
  // (paced to stay under Facebook's own throttling) — closing the app
  // partway through used to lose every bit of that, since nothing was ever
  // saved until the entire batch finished.
  async discoverLocations(
    cities: string[],
    targetRadiusMiles?: number,
    onEachResult?: (result: LocationDiscoveryResult) => void
  ): Promise<LocationDiscoveryResult[]> {
    this.priorityRequested = true;
    return this.withPage(async () => {
      this.priorityRequested = false;
      const page = await this.ensureBrowser();
      const loggedIn = await isLoggedIn(page);
      this.setStatus({ loggedIn });
      if (!loggedIn) {
        this.log("error", "Not logged into Facebook. Log in from the Dashboard first.");
        const results = cities.map((city) => ({ city, url: null, resolvedState: null, resolvedLocationLabel: null, error: "Not logged in" }));
        results.forEach((r) => onEachResult?.(r));
        return results;
      }

      this.log("info", `Discovering ${cities.length} location${cities.length === 1 ? "" : "s"}...`);
      const results = await discoverLocationsViaBrowser(
        page,
        cities,
        (result) => {
          if (result.url) this.log("info", `Found location for ${result.city}: ${result.url}`);
          else this.log("warn", `Could not resolve ${result.city}: ${result.error}`);
          onEachResult?.(result);
        },
        targetRadiusMiles
      );
      const found = results.filter((r) => r.url).length;
      this.log("info", `Location discovery done — resolved ${found}/${cities.length}.`);
      return results;
    });
  }

  // Per explicit instruction — "we can look at eBay listings" for real
  // sold-comp research (see watchcount.ts). Runs on its OWN separate tab
  // within the SAME persistent browser profile/context, NOT the shared
  // Facebook page — an unrelated site has no reason to interrupt whatever
  // the scanner might currently be doing there, so unlike
  // discoverLocations/searchForItemNow, this needs no priorityRequested/
  // withPage coordination at all; it just needs the context to exist.
  async fetchEbayComps(query: string): Promise<EbayComp[]> {
    const page = await this.openNewTab();
    try {
      return await searchSoldComps(page, query);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Per explicit instruction — reported live: watchcount.com's anonymous
  // usage cap (20 lookups/day) is much lower than a logged-in account's
  // (200/day), and Google/Facebook sign-in specifically fails inside this
  // app's Playwright-controlled browser (a restriction those providers
  // apply to any automation-flagged browser — unrelated to watchcount
  // itself, and not something this app tries to work around). WatchCount's
  // own login form also takes a plain email + password, though, which
  // isn't affected by that — this opens a real, visible window on the SAME
  // persistent profile/context the automated lookups themselves use (a
  // NEW tab, not the shared Facebook page — same reasoning as
  // fetchEbayComps above) so the user can log in there by hand, the exact
  // same "this app never sees your password" posture as login() does for
  // Facebook. Left open afterward rather than auto-closed — nothing here
  // polls for "are you done," so there's no reliable moment to close it
  // automatically.
  async openWatchCountLogin(): Promise<void> {
    const page = await this.openNewTab();
    await page.goto("https://beta.watchcount.com", { waitUntil: "domcontentloaded" });
    this.log(
      "info",
      "Opened a WatchCount.com window — log in there with email + password (Google/Facebook sign-in doesn't work in this automated browser window, that's a restriction those providers apply, not this app). This app never sees your password."
    );
  }

  // Same fire-and-forget enrichment pattern used for a confirmed deal, via
  // OpenAI's vision capability (src/main/vision.ts) — entirely optional,
  // silently does nothing useful if OPENAI_API_KEY was never set. Findings
  // get folded back into that product's learned notes (see
  // recordProductObservation) ONLY if matchedItem already has a Database
  // entry the user asked for — per explicit instruction, scanning never
  // creates Database entries on its own anymore (see index.ts's
  // research_product tool and listings:research handler, the only two
  // places that do), it can only reinforce ones that already exist. A
  // brand-new, not-yet-researched product is a silent no-op here, same as
  // in the research loop below.
  private async runPhotoAnalysis(
    id: string,
    title: string,
    description: string,
    price: number | null,
    imageUrls: string[],
    matchedItem: string | null,
    // What this listing is supposed to be, for the vision model to check
    // photos against (see PhotoAnalysisResult.matchesClaim) — the matched
    // Search For item's canonical name when there is one, otherwise the
    // listing's own title, so even an unmatched listing gets a basic
    // "do the photos match its own claim" sanity check.
    claimedItem: string | null,
    // Per explicit instruction — whether scraper.ts found a <video> on this
    // listing's page, so analyzeListingPhotos can stay alert for a video
    // frame/thumbnail slipping through into imageUrls (see its own
    // hasVideo opt).
    hasVideo: boolean,
    // Per explicit instruction — the user-CONFIRMED Database product for
    // whichever Search For item this listing matched (see
    // SearchItem.linkedProductId), when there is one. Preferred over the
    // fuzzy name-based findMatchingProduct(claimedItem) lookup below, since
    // it's an explicit link the user actually confirmed via a popup rather
    // than a same-session guess at which Database entry "claimedItem"
    // probably refers to.
    linkedProductId: string | null = null,
    // Condition-awareness — gates flaw detection entirely (see
    // analyzeListingPhotos's own detectFlaws opt). Only one call site below
    // has one on hand (evaluateListing's runPostScoringPipeline, which
    // already reads config.searchItems right above it), so this is just
    // threaded straight through, not optional.
    config: EngineConfig
  ): Promise<PhotoAnalysisResult> {
    // Read fresh from the DB every time, not cached anywhere — this is what
    // makes a watch-for note added on a product's page (see chat.ts's
    // add_product_watch_note) take effect on live scanning immediately,
    // including whatever listing is being evaluated right now.
    const watchFor = matchedItem ? this.opts.store.findMatchingProduct(matchedItem)?.lookoutNotes || null : null;
    // Only for an UNMATCHED listing — per explicit instruction, a mistitled
    // listing that's genuinely one of the user's already-tracked products
    // should still be catchable, by comparing its photos against real
    // reference photos already confirmed for known products (see
    // store.listProductsWithImages) rather than relying on the title/
    // category text alone. Capped to a small handful of products, one
    // photo each, to keep the vision call's size/cost bounded.
    //
    // Per explicit instruction — the Prioritize star's actual mechanical
    // effect: a product the user has flagged as noteworthy (see
    // store.listPrioritizedProductsWithImages) is ALWAYS merged into this
    // comparison set, on top of whatever the normal "3 most recent" gives —
    // the whole point is finding as many of it as possible, which the plain
    // recency-based list would routinely fail at for something that hasn't
    // come up in a while. Deliberately does NOT touch config.searchItems or
    // any filter — this only widens what the vision model gets to compare
    // an unmatched listing's photos against, never what the scanner
    // actively searches for.
    const referenceProducts = matchedItem
      ? []
      : (() => {
          const recent = this.opts.store.listProductsWithImages(3);
          const prioritized = this.opts.store.listPrioritizedProductsWithImages();
          const seen = new Set(recent.map((r) => r.product.id));
          const merged = [...recent, ...prioritized.filter((p) => !seen.has(p.product.id))];
          return merged.flatMap(({ product, images }) => (images[0] ? [{ name: product.name, imageDataUri: images[0].imageData }] : []));
        })();
    // The OTHER direction of the same idea, for a listing that DOES have a
    // claimed item: real reference photos of that exact product (from its
    // own Database entry, if it has any) give the matchesClaim check actual
    // photographic ground truth instead of just the model's general
    // knowledge of what "claimedItem" looks like — this is what lets it
    // reliably say an Xbox Series X and a PS5 don't look alike, or that a
    // photo showing just a controller isn't a full console.
    const claimedProduct = linkedProductId
      ? this.opts.store.getProductById(linkedProductId)
      : claimedItem
        ? this.opts.store.findMatchingProduct(claimedItem)
        : null;
    // Condition-awareness — a poor-condition/damaged reference photo would
    // be misleading "ground truth" for a matchesClaim identity comparison
    // (the whole point is confirming this IS the claimed product, not
    // whether it looks equally beat-up), so only normal reference photos
    // are ever offered here.
    const claimedItemReferenceImages = claimedProduct
      ? this.opts.store
          .listProductImages(claimedProduct.id)
          .filter((img) => img.kind === "normal")
          .slice(0, 2)
          .map((img) => img.imageData)
      : [];
    this.log("info", `Analyzing ${imageUrls.length} photo(s) for "${title}"...`);
    const result = await analyzeListingPhotos(imageUrls, { title, description, price }, isLowAiMode() ? 4 : 8, {
      claimedItem,
      watchFor,
      referenceProducts,
      claimedItemReferenceImages,
      hasVideo,
      detectFlaws: config.researchCondition,
      // Read fresh per listing, same posture as watchFor above — not
      // cached, so a just-submitted confirm/deny is reflected on the very
      // next listing evaluated, not just after a restart.
      flawFeedbackExamples: config.researchCondition ? this.opts.store.getFlawFeedbackExamples() : [],
    });
    if (result.error || !result.summary) {
      this.log("warn", `Photo analysis unavailable for "${title}": ${result.error ?? "no summary returned"}`);
      return result;
    }
    this.opts.store.updatePhotoAnalysis(id, result.summary, result.flaws);
    const record = this.opts.store.getById(id);
    if (record) this.opts.onListing(record);
    this.log("info", `Photo analysis for "${title}" done.${result.hasValuableBundle ? ` Bundle spotted: ${result.bundleDescription}` : ""}`);

    if (matchedItem) {
      const updated = this.opts.store.recordProductObservation(matchedItem, `Photo analysis: ${result.summary.slice(0, 500)}`);
      if (updated) this.opts.onProductUpdated(updated);
    } else if (result.matchedKnownProduct) {
      this.log(
        "info",
        `Photo match: "${title}" wasn't matched by text, but its photos look like the tracked product "${result.matchedKnownProduct}".`
      );
      const updated = this.opts.store.recordProductObservation(
        result.matchedKnownProduct,
        `Found via photo match (title/category text didn't mention it): ${result.summary.slice(0, 500)}`
      );
      if (updated) this.opts.onProductUpdated(updated);
    }
    return result;
  }

  // Records a listing that was skipped WITHOUT ever opening its detail
  // page — a placeholder price, or an unshippable category — so it still
  // shows up in Feed with a clear reason instead of just vanishing. Not
  // counted toward the per-location rotation budget, since this was a
  // near-instant skip, not a genuine evaluation.
  // cheapFilterStartedAt, when provided, means this skip came from the
  // synchronous pre-detail-page filter chain in evaluateListing (price
  // sanity, blacklist, shippability, relevance) — the "cheap_filters" stage
  // per explicit instruction to measure it. Omitted for the ONE
  // recordInstantSkip call site that isn't part of that chain (the
  // thumbnail-classification skip, which is timed separately as its own
  // "thumbnail_classification" stage instead, since it's a real vision
  // call, not a cheap check).
  private recordInstantSkip(listing: ListingSummary, reasoning: string, cheapFilterStartedAt?: number): ListingEvalResult {
    if (cheapFilterStartedAt !== undefined) recordStage("cheap_filters", Date.now() - cheapFilterStartedAt, true);
    this.opts.store.saveScored({
      listing: {
        ...listing,
        description: "",
        shippingMentioned: false,
        imageUrls: [],
        hasVideo: false,
        hasOfficialShipping: false,
        mentionsEbay: false,
        seller: { joinedFacebookYear: null, rating: null, ratingCount: null, hasProfilePhoto: null, name: null },
        listingAge: null,
      },
      extraction: { matchedItem: null, extractedAttributes: "", conditionImpact: "unknown", confidence: "low", reasoning },
      referencePriceUsd: null,
      discountPercent: null,
      isDeal: false,
      dealTier: null,
      estimatedValueRange: null,
      offTopicSuggestion: null,
    });
    const record = this.opts.store.getLastSavedListing();
    if (record) this.opts.onListing(record);
    return NOT_COUNTED;
  }

  // Opens a listing's detail page. A method (not a bare call) so the evaluation routes can be exercised in tests without a browser.
  protected loadListingDetail(page: Page, listing: ListingSummary): Promise<ListingDetail> {
    return fetchListingDetail(page, listing);
  }

  // A listing past the general freshness window (kept only for a Watch) is never an ordinary deal: same record, deal flags cleared.
  private demoteForAge(scored: ScoredListing, ageText: string | null): ScoredListing {
    return {
      ...scored,
      isDeal: false,
      dealTier: null,
      extraction: {
        ...scored.extraction,
        reasoning: `${scored.extraction.reasoning} (Listed ${ageText ?? "a while ago"}, older than your freshness window, so it is kept only for the Watch whose own age window covers it, not as a deal.)`,
      },
    };
  }

  // Per explicit instruction — checks each already price-qualified Watch
  // candidate's FULL conditions (profit/discount/age — see
  // watchMatching.ts's evaluateWatchConditions) against the given `scored`
  // snapshot and records+alerts on any that are satisfied. Called from TWO
  // points (see evaluateListing and runPostScoringPipeline below) since a
  // listing's scored.referencePriceUsd/discountPercent can still change
  // after vision runs (bundle re-pricing, green-flag photo confirmation) —
  // store.recordWatchMatch's own UNIQUE(watch_id, listing_id) + INSERT OR
  // IGNORE is what makes calling this twice for the same watch+listing
  // safe (the second call is a silent no-op, returns null, no duplicate
  // alert). config.id/config.label are the CURRENT account's own fields —
  // EngineConfig is Config intersected with one Account, and Account is
  // where id/label come from.
  private async recordWatchMatchesIfAny(
    watches: Watch[],
    scored: ScoredListing,
    config: EngineConfig,
    discoveryMode: "passive" | "active",
    // The term already known to be what this listing is (the active check worked it out).
    knownTerm?: WatchTerm,
    // The listing's final qualification when the caller already has it; otherwise it is worked out when a match is delivered.
    qualification?: Qualification
  ): Promise<Qualification | null> {
    let current: Qualification | null = qualification ?? null;
    if (watches.length === 0 || scored.listing.price === null) return current;
    const price = scored.listing.price;
    const listingAgeHours = scored.listing.listingAge ? estimateListingAgeHours(scored.listing.listingAge) : null;
    for (const watch of watches) {
      const term = knownTerm ?? matchWatchTerm(watch, scored.listing.title);
      if (!term) continue;
      // A match the scanner happened across (passive) gets the same two checks an
      // active one already went through: inside the Watch's area, and a confident
      // yes that it really is the product.
      if (discoveryMode === "passive") {
        const bounds = await checkWatchBounds(watch, scored.listing.locationText, { store: this.opts.store });
        if (!bounds.ok) {
          this.log("info", `Watch "${watch.name}": skip — ${scored.listing.title}: out of bounds: ${bounds.reason}`, scored.listing.url);
          continue;
        }
        const verdict = await verifyWatchProduct(term.phrase, { id: scored.listing.id, title: scored.listing.title, description: scored.listing.description, price });
        if (!verdict.unavailable && !isConfidentMatch(verdict)) {
          this.log("info", `Watch "${watch.name}": skip — ${scored.listing.title}: not confident it's "${term.phrase}" (${verdict.reason})`, scored.listing.url);
          continue;
        }
      }
      const referencePrice = deriveWatchReferencePrice(watch, this.opts.store, term.linkedProductId ?? watch.linkedProductId);
      const result = evaluateWatchConditions(watch, price, referencePrice, listingAgeHours, { netPercent: resaleSettingsFrom(config).netPercent, defaultMaxAgeHours: config.maxListingAgeHours });
      if (!result.satisfied) continue;
      const match = this.opts.store.recordWatchMatch({
        watchId: watch.id,
        listingId: scored.listing.id,
        foundByAccountId: config.id,
        foundByAccountLabel: config.label,
        discoveryMode,
        priceAtMatch: price,
        discountPercentAtMatch: result.discountPercent,
        profitUsdAtMatch: result.profitUsd,
      });
      if (!match) continue; // already recorded via the other evaluation point — not a new match, no duplicate alert
      this.log("deal", `WATCH MATCH: "${watch.name}" — ${scored.listing.title} — $${price}`, scored.listing.url);
      // A failed push is logged, not thrown, and markWatchMatchNotified is skipped so it isn't silently lost — the match row itself
      // is already durable.
      try {
        const settings = resaleSettingsFrom(config);
        // The verdict this alert reports: the final one when the caller has it, else worked out now with a fresh market check. A
        // Watch match is always delivered, but it says plainly whether it is also a qualified deal.
        if (!current || (!current.market && current.verdict.status !== "pass")) {
          current = await qualifyScoredListing({
            scored: current ? current.scored : scored,
            source: this.opts.store,
            settings,
            maxAgeHours: config.maxListingAgeHours,
            check: this.opts.checkMarket,
            refreshMarket: true,
            log: (m) => this.log("info", m, scored.listing.url),
          });
          this.opts.store.saveScored(current.scored);
          const savedRecord = this.opts.store.getLastSavedListing();
          if (savedRecord) this.opts.onListing(savedRecord);
        }
        if (current.verdict.reasons.some((r) => r.code === "PLACEHOLDER_PRICE")) {
          this.log("info", `Skipped the alert for "${scored.listing.title}": $${price} looks like a placeholder price.`, scored.listing.url);
        } else {
          const summary = buildQualifiedAlert({ q: current, source: this.opts.store, settings, kind: "watch", watchName: watch.name });
          // A Watch with its own ntfy topic (a friend's) reaches someone else, so the main topic's deal alert never replaces it.
          const ownTopic = !!watch.ntfyTopic?.trim() && watch.ntfyTopic.trim() !== config.ntfy.topic;
          if (!ownTopic && this.opts.store.isListingNotified(scored.listing.id)) {
            this.log("info", `Watch "${watch.name}": "${scored.listing.title}" was already notified as a deal: not sending a second alert.`, scored.listing.url);
          } else {
            await sendWatchMatchAlert(
              config,
              watch,
              current.scored,
              { discoveryMode, discountPercentAtMatch: result.discountPercent, profitUsdAtMatch: result.profitUsd },
              referencePrice,
              summary,
              current.verdict.qualified
            );
            if (!ownTopic) this.opts.store.markNotified(scored.listing.id);
          }
        }
        this.opts.store.markWatchMatchNotified(match.id);
      } catch (err) {
        this.log("error", `Watch notification failed: ${(err as Error).message}`, scored.listing.url);
      }
      this.opts.onWatchMatch?.(watch, { listingId: scored.listing.id });
    }
    return current;
  }

  // Evaluates one listing end to end (detail fetch, seller risk, scoring,
  // persistence, notification, deal narration). The returned "counted"
  // flag is what drives the "switch location after N listings" counter;
  // the rest feeds the end-of-batch recap narration.
  // discoveryMode defaults to "passive" so every EXISTING call site (the
  // normal runCycle loops, searchForItemNow) is unaffected — only
  // runWatchCheck (the active scheduler, see watchScheduler.ts) passes
  // "active" explicitly, so a match found this way is correctly attributed
  // in watch_matches.discovery_mode instead of being misrecorded as passive.
  private async evaluateListing(
    page: Page,
    listing: ListingSummary,
    config: EngineConfig,
    discoveryMode: "passive" | "active" = "passive"
  ): Promise<ListingEvalResult> {
    recordEvent("evaluated", config.id);
    // Per explicit instruction — the in-memory-cache-first dedup check (see
    // store.ts's hasSeenCached/seenCache), benchmarked directly against the
    // plain DB lookup via the db_dedup_lookup/dedup_cache_check stages.
    if (this.opts.store.hasSeenCached(listing.id)) {
      recordEvent("duplicate", config.id);
      return NOT_COUNTED;
    }
    recordEvent("unique", config.id);
    if (listing.price === null) return NOT_COUNTED;

    // Per explicit instruction — instrumenting the pipeline to measure
    // where time actually goes: everything from here through the general-
    // deal relevance check below is the synchronous, no-network "cheap
    // filter" stage (see recordInstantSkip's cheapFilterStartedAt param and
    // metrics.ts). The one exception living in this same visual block —
    // the >$2000 unshippable branch's own downloadImageAsDataUri call — is
    // a rare path that isn't purely synchronous either, called out
    // explicitly in the benchmark report rather than pretending it's free.
    const cheapFilterStart = Date.now();

    // Per explicit instruction — "State"/"City" location modes should skip
    // anything that reads as a DIFFERENT state than the one being searched
    // (a wide-enough radius near a state line can still pull in
    // out-of-state listings — see usStates.ts's listingStateMatches, which
    // only ever returns false when it's genuinely confident, never a
    // guess). Never applies in "country" mode, where every state is fair
    // game by design.
    if (config.locationMode !== "country" && config.selectedState) {
      const stateMatch = listingStateMatches(listing.locationText, config.selectedState);
      if (stateMatch === false) {
        this.log(
          "info",
          `skip (outside ${config.selectedState}): ${listing.title} — location reads "${listing.locationText}"`,
          listing.url
        );
        return this.recordInstantSkip(
          listing,
          `Skipped without opening the listing — its location ("${listing.locationText}") looks like it's outside ${config.selectedState}, and you're only searching there.`,
          cheapFilterStart
        );
      }
    }

    if (isSuspiciousPrice(listing.price)) {
      this.log("info", `skip (placeholder-looking price): ${listing.title} — $${listing.price}`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} looks like a placeholder price, not a real one.`,
        cheapFilterStart
      );
    }

    if (isNonRoundPrice(listing.price)) {
      this.log("info", `skip (non-round price): ${listing.title} — $${listing.price}`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} doesn't end in 0 or 5, probably scam bait or unnoteworthy.`,
        cheapFilterStart
      );
    }

    const unshippableMatch = findUnshippableMatch(listing.title);
    if (unshippableMatch) {
      this.log("info", `skip (not easily shippable): ${listing.title}`, listing.url);
      // Per explicit instruction: a big-ticket ($2000+) unshippable listing
      // (a car, a house, a giant statue...) is confident enough evidence
      // that this whole category is a waste of attention that it's also
      // worth blacklisting the matched term itself — not just this one
      // listing — so future listings in the same category get skipped by
      // the even-cheaper isBlacklisted check above without needing this
      // regex scan at all. Below $2000 it still just skips (unchanged
      // behavior) without also blacklisting, since a cheap unshippable item
      // is a much weaker/more ambiguous signal to generalize from.
      if (listing.price > 2000) {
        // Per explicit instruction — "blacklist both the title and the
        // image if possible": the summary card's own thumbnail, downloaded
        // as a data: URI the same way the ineligible-thumbnail check above
        // already does, so future visually-similar listings get caught by
        // the Blacklisted Images check too, not just by title text.
        const thumbnailDataUri = listing.thumbnailUrl ? await downloadImageAsDataUri(listing.thumbnailUrl) : null;
        const added = this.opts.store.addBlacklistTerm(
          unshippableMatch,
          "ai",
          thumbnailDataUri ? { imageData: thumbnailDataUri, sourceTitle: listing.title } : null
        );
        if (added) {
          this.log("info", `Blacklisted "${added.term}" — unshippable and over $2000 ("${listing.title}").`, listing.url);
          this.opts.onBlacklistUpdated(this.opts.store.listBlacklistTerms());
          if (thumbnailDataUri) this.opts.onBlacklistImagesUpdated(this.opts.store.listBlacklistedImages());
        }
      }
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — "${listing.title}" looks like a bulky/local-pickup-only category (vehicle, furniture, appliance, real estate, etc.), not something a mail-order reseller can buy.`,
        cheapFilterStart
      );
    }

    // Per explicit instruction — a growing blacklist of terms/phrases for
    // things categorically unrelated to a mail-order resale business (real
    // estate, rentals, job postings, services...), curated by the user
    // directly (see Database's Blacklist section) and/or auto-suggested by
    // the general-deal AI itself on an off-topic listing (see the
    // offTopicSuggestion handling in the isDeal block below). Checked here,
    // before opening the listing, same posture as the price/shippability
    // filters above. config.ignoreBlacklist is a temporary, user-controlled
    // bypass for this specific check — lets the curated list stay intact
    // while broadening what the scanner will look at, rather than having to
    // clear it out to see past it.
    const blacklistMatch = config.ignoreBlacklist ? null : this.opts.store.isBlacklisted(listing.title);
    // NOTE: the renderer's red "not of interest" outline (ListingSourceMarks.tsx's
    // listingVerdict) recognizes the word "blacklisted" in the reasoning saved here.
    if (blacklistMatch) {
      this.log("info", `skip (blacklisted: "${blacklistMatch}"): ${listing.title}`, listing.url);
      return this.recordInstantSkip(listing, `Skipped without opening the listing — title matches blacklisted term "${blacklistMatch}".`, cheapFilterStart);
    }

    // Per explicit instruction — a "green flag": the title doesn't cleanly
    // match a tracked item (matchSearchItem itself finds nothing — checked
    // explicitly here so a title that DOES fully match never gets treated,
    // or logged, as merely a "green flag"), but it shares a real, specific
    // word with one, e.g. a listing titled "Xbox X" (not a real product —
    // the seller mistitled an Xbox Series S) sharing "xbox" with a tracked
    // "Xbox Series S." Computed here, before the focused-search-item skip
    // below, specifically so a mistitled high-value item doesn't get
    // silently skipped just because its title never earns a real match —
    // see the vision-confirmation block after photo analysis runs, further
    // down, for what actually happens with this.
    const strictTextMatch = matchSearchItem(listing.title, config.searchItems);
    let greenFlagCandidate: SearchItem | null = strictTextMatch ? null : findGreenFlagCandidate(listing.title, config.searchItems);
    if (greenFlagCandidate) {
      this.log(
        "info",
        `green flag: "${listing.title}" mentions "${greenFlagCandidate.item}" but doesn't fully match — opening it for a closer look.`,
        listing.url
      );
    } else if (!strictTextMatch && listing.thumbnailUrl) {
      // Per explicit instruction — "prioritize the listing's title over the
      // first image... but at the same time, someone could list a 'gaming
      // console' and the first image the AI sees is a bona fide Xbox
      // Series X, and this time it'd be the AI's image recognition ability
      // to look any further into that listing": an OR against the
      // title-based checks above, not an AND — only tried when the title
      // alone found NOTHING (a real strict match already short-circuits
      // this, and a text-based green flag already took the branch above),
      // and only for a search item the user has explicitly confirmed a
      // Database reference photo for (see SearchItem.linkedProductId — set
      // via the "is this what you're searching for?" popup). A generic
      // title with an unrelated photo still correctly finds nothing here;
      // this only ever ADDS candidates a title-only search would have
      // missed, never removes any a title match already found.
      //
      // Verified live miss: this is a REAL vision call, and running it for
      // EVERY title-less listing (every search result Facebook returns
      // that doesn't happen to say the exact tracked words) reintroduced
      // the exact "vision blocking discovery" problem the earlier
      // queue-based decoupling of full photo analysis was built to solve —
      // reported live as "not rotating locations again," since a location
      // with a lot of non-matching results could rack up dozens of these
      // sequential calls before the cycle ever got to move on. Capped per
      // location visit (reset in runCycle) — once exhausted, a title-less
      // listing just falls through to the ordinary instant-skip, same as
      // before this feature existed, rather than stalling rotation to keep
      // trying.
      if (!isLowAiMode() && this.imageMatchAttemptsThisLocation < ScrapeEngine.MAX_IMAGE_MATCH_ATTEMPTS_PER_LOCATION) {
        for (const ref of config.searchItems) {
          if (!ref.linkedProductId) continue;
          const referenceImages = this.opts.store.listProductImages(ref.linkedProductId).slice(0, 3).map((img) => img.imageData);
          if (!referenceImages.length) continue;
          const thumbnailDataUri = await downloadImageAsDataUri(listing.thumbnailUrl);
          if (!thumbnailDataUri) break; // couldn't even download the thumbnail — no point trying more reference sets against it
          this.imageMatchAttemptsThisLocation++;
          const result = await matchesReferenceProduct(thumbnailDataUri, ref.item, referenceImages);
          if (result.matches) {
            greenFlagCandidate = ref;
            this.log(
              "info",
              `image match: "${listing.title}" — thumbnail looks like "${ref.item}" (${result.reason ?? "the title didn't match, but the photo looks right"}) — opening it for a closer look.`,
              listing.url
            );
            break;
          }
          if (this.imageMatchAttemptsThisLocation >= ScrapeEngine.MAX_IMAGE_MATCH_ATTEMPTS_PER_LOCATION) break;
        }
      }
    }

    // Per explicit instruction — Watch: "keep an eye out for this over
    // time." Passive candidate matching reuses the EXACT SAME text-match
    // functions the SearchItem flow above just used (matchSearchItem/
    // findGreenFlagCandidate), just against each active Watch's own
    // synthetic SearchItem shape (see watchMatching.ts's watchAsSearchItem)
    // — checked per-watch, not as one array, since (unlike SearchItem,
    // which only ever wants the single BEST match) a listing can genuinely
    // satisfy several different Watches at once. Deliberately does NOT
    // extend the image-match vision fallback above to Watches — that's a
    // real, capped-but-shared OpenAI cost already spent on SearchItems;
    // keeping Watch's own passive candidate detection text-only is the
    // conservative "avoid unnecessary OpenAI calls" call for this phase.
    // globallyPaused/enabled are checked here (not once per cycle) so a
    // pause/resume or a per-watch pause takes effect on the very next
    // listing, same responsiveness posture as every other config read in
    // this function.
    // Facebook Watches only — an eBay Watch is EbayEngine's job and never
    // matches a Marketplace listing.
    const activeWatches: Watch[] = config.watch.globallyPaused ? [] : this.opts.store.listWatches().filter((w) => w.enabled && w.platform === "facebook");
    const matchingWatches = activeWatches.filter((w) => {
      const asItems = watchAsSearchItems(w);
      return matchSearchItem(listing.title, asItems) !== null || findGreenFlagCandidate(listing.title, asItems) !== null;
    });
    for (const w of matchingWatches) this.opts.store.recordWatchCandidateSeen(w.id);
    // Cheap price pre-check, same posture as the SearchItem price gate
    // right below — a Watch outside its own min/max range is never worth
    // carrying through the rest of this pipeline, but (unlike the
    // SearchItem gate) doesn't skip the LISTING outright on its own; see
    // priceQualifiedWatches' own use just below, which can rescue a
    // listing the SearchItem gate would otherwise have dropped. Captured
    // into a local first — listing.price is already narrowed non-null by
    // this point (the null-price bail at the very top of this function),
    // but that narrowing doesn't carry into a closure's own property
    // access, only into a plain local variable.
    const listingPrice = listing.price;
    const priceQualifiedWatches = matchingWatches.filter((w) => passesWatchPriceGate(w, listingPrice));

    // Per explicit instruction — price range is now set PER-PRODUCT (on the
    // matched SearchItem itself), not a single global ceiling/floor
    // checked against every listing regardless of what it's for — see
    // types.ts's SearchItem doc comment. Only enforceable once we know
    // which item (if any) this listing actually is: strictTextMatch/
    // greenFlagCandidate are both fully resolved by this point (including
    // the image-match sub-branch above), so this runs here instead of
    // earlier alongside the other cheap synchronous filters. A listing that
    // doesn't match any tracked item at all has no per-item range to check
    // against, so it's simply not gated on price here — general-deal
    // judgment (further down) still applies to it as normal.
    //
    // Per explicit instruction — widened for Watch: a listing outside a
    // matched SearchItem's own price range used to be skipped outright
    // here, before a completely separate Watch (its own phrase, its own
    // price range) ever got a look. `priceQualifiedWatches.length === 0`
    // is what rescues that case — the SearchItem's own price mismatch is
    // still enforced exactly as before whenever there's no price-qualified
    // Watch to save the listing.
    const priceCandidate = strictTextMatch ?? greenFlagCandidate;
    if (priceCandidate?.maxPriceUsd != null && listing.price > priceCandidate.maxPriceUsd && priceQualifiedWatches.length === 0) {
      this.log(
        "info",
        `skip (over "${priceCandidate.item}"'s max price): ${listing.title} — $${listing.price} > $${priceCandidate.maxPriceUsd} cap`,
        listing.url
      );
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} is above the $${priceCandidate.maxPriceUsd} max price you set for "${priceCandidate.item}".`,
        cheapFilterStart
      );
    }
    if (priceCandidate?.minPriceUsd != null && listing.price < priceCandidate.minPriceUsd && priceQualifiedWatches.length === 0) {
      this.log(
        "info",
        `skip (under "${priceCandidate.item}"'s min price): ${listing.title} — $${listing.price} < $${priceCandidate.minPriceUsd} floor`,
        listing.url
      );
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} is below the $${priceCandidate.minPriceUsd} min price you set for "${priceCandidate.item}".`,
        cheapFilterStart
      );
    }

    // General deal detection off means the user has told the AI (via chat,
    // see set_general_deal_detection) they want it focused ONLY on their
    // Search For list — "only look for Nintendo Switches," not "also flag
    // other stuff that looks good." Passive browsing still visits whatever
    // Facebook's general feed happens to show though (an iPhone, a pet
    // listing, anything), and without this check every single one of those
    // would still get its detail page opened and pushed into Feed as a
    // "Skip" before scoreListing ever got a chance to say "not relevant" —
    // exactly the wasted attention on unrelated listings that was reported.
    // Checked against the title only, same as the other pre-filters above
    // — a real vision pass on every browsed thumbnail before even opening
    // it would add an AI call per listing (dozens per cycle) just to
    // decide whether to look closer, which is a much bigger cost than this
    // is worth when the title alone already reliably rules out something
    // like "iPhone 13" or "free kittens" for a Nintendo Switch search. A
    // green flag is exempted — it's specifically about a tracked item, just
    // possibly mistitled, not "other stuff that looks good."
    //
    // Per explicit instruction — widened for Watch: a Watch has no
    // Search-For entry to be "relevant" to, so without the
    // priceQualifiedWatches escape hatch here, a listing matching ONLY a
    // Watch (no overlapping SearchItem) would be silently abandoned before
    // ever reaching seller-risk/scoring/Watch-condition-evaluation — even
    // though the whole point of Watch is to keep working independent of
    // whatever the Search For list or general-deal setting happen to be.
    // Deliberately priceQualifiedWatches (already past that watch's own
    // price gate), not the broader matchingWatches — a Watch that's a text
    // candidate but already outside its own price range has no reason to
    // spend a detail-page load either.
    if (
      !config.generalDeal.enabled &&
      config.searchItems.length > 0 &&
      !isRelevantToSearchItems(listing.title, config.searchItems) &&
      !greenFlagCandidate &&
      priceQualifiedWatches.length === 0
    ) {
      this.log("info", `skip (not one of your focused Search For items): ${listing.title}`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — general deal detection is off and this doesn't match anything on your Search For list.`,
        cheapFilterStart
      );
    }

    // Per explicit instruction — recognize an ineligible category (a boat,
    // a car, real estate, ...) from the listing's PHOTO alone, before the
    // listing is even opened, not just from title keywords. A seller can
    // easily leave any hint of this out of the title itself (a boat titled
    // just "must sell fast, $2200"), which the UNSHIPPABLE_PATTERNS check
    // near the top of this function has no way to catch on its own — this
    // is what catches that case. Uses only the thumbnail already shown on
    // the browse-results page (no page load needed), gated behind the same
    // photoAnalysis toggle as every other AI vision call in this app, since
    // it's a real (if small) OpenAI request per listing, unlike everything
    // else checked above this point.
    // Per explicit instruction — config.ignoreBlacklist also skips this:
    // its findings are exactly what populates Database's Blacklisted Images
    // gallery (under the same Blacklist tab as the term list above), so a
    // user asking to bypass "the Blacklist" reasonably means both halves of
    // it, not just the term-matching one.
    // Everything above this line was the synchronous cheap-filter chain and
    // it fell all the way through without an early exit — record that
    // "passed" case too, not just the skip paths above (each already timed
    // via recordInstantSkip), so the cheap_filters average reflects every
    // invocation, not just the ones that got rejected.
    recordStage("cheap_filters", Date.now() - cheapFilterStart, true);

    // Per explicit instruction — "Clynx should be prioritizing the listing
    // title, not what's in the background": a PS5 photographed on a couch was
    // skipped as "furniture". The photo check below exists to catch listings
    // whose TITLE gives nothing away (a boat titled "must sell fast"); when the
    // title already names something being tracked — a Search For item, a near
    // miss on one, or a Watch — the title has answered the question, and the
    // photo is not allowed to veto it, however cluttered or badly framed it is.
    // (This also saves the AI call.)
    const titleNamesTrackedItem = !!strictTextMatch || !!greenFlagCandidate || matchingWatches.length > 0;
    if (!isLowAiMode() && config.photoAnalysis.enabled && !config.ignoreBlacklist && listing.thumbnailUrl && !titleNamesTrackedItem) {
      const thumbnailDataUri = await downloadImageAsDataUri(listing.thumbnailUrl);
      if (thumbnailDataUri) {
        const referenceImages = this.opts.store
          .listBlacklistedImages()
          .slice(0, 6)
          .map((img) => ({ imageDataUri: img.imageData, category: img.category }));
        const imageCheck = await timed("thumbnail_classification", () => classifyThumbnailImage(thumbnailDataUri, listing.title, referenceImages));
        if (imageCheck.ineligible) {
          this.log(
            "info",
            `skip (photo shows an ineligible item — ${imageCheck.category ?? "unrecognized"}): ${listing.title}`,
            listing.url
          );
          this.opts.store.addBlacklistedImage(thumbnailDataUri, listing.title, imageCheck.category, imageCheck.reason);
          this.opts.onBlacklistImagesUpdated(this.opts.store.listBlacklistedImages());
          return this.recordInstantSkip(
            listing,
            `Skipped without opening the listing — the photo itself shows ${imageCheck.category ?? "something"} (${
              imageCheck.reason ?? "not something a mail-order reseller can ship"
            }), even though the title didn't say so.`
          );
        }
      }
    }

    // Per explicit instruction ("can it be a little faster?") — trimmed
    // from 2000-5000ms. Kept nonzero and still randomized on purpose: this
    // is what keeps listing-to-listing navigation from looking like a
    // metronome to Facebook, it's just a shorter gap now.
    await this.sleep(1200, 3000);
    let detail: ListingDetail;
    try {
      detail = await this.loadListingDetail(page, listing);
    } catch (err) {
      this.log("error", `Failed to load detail for ${listing.url}: ${(err as Error).message}`, listing.url);
      // page.goto(listing.url) is the very first line inside
      // fetchListingDetail — a failure here could mean that never even ran,
      // or that it succeeded and a later extraction step threw, so the page
      // may or may not actually be sitting on the listing's detail page.
      // Reporting visitedDetailPage true either way is the safe direction:
      // the caller's page.goBack() is wrapped in its own no-op catch, so a
      // spurious goBack when nothing needs undoing is harmless, but
      // skipping a genuinely-needed one would leave the page stranded off
      // the search results.
      return { ...NOT_COUNTED, visitedDetailPage: true };
    }

    // Fast-moving mail-order business — a listing sitting for over a day is
    // far less likely to still be available or worth chasing, so this skips
    // before spending a seller-risk check or an AI call on it. Only known
    // after opening the detail page (Facebook's "Listed X ago" text isn't on
    // the search-card summary), so unlike the price/shippability filters
    // above this still costs one page load — but it's the expensive parts
    // (AI scoring, eBay comps, seller-risk) it's actually saving. Counted
    // toward the rotation budget (same as the seller-risk-fail path below)
    // since a real page visit happened, not a near-instant title check.
    //
    // Per explicit instruction — a real fix, not just a new check: this one
    // GLOBAL ceiling used to run unconditionally, which would silently kill
    // a listing before a Watch wanting a LOOSER freshness window than the
    // global config ever got a chance to apply its own. Rescued the same
    // way as the two gates above — via a per-listing check, not a blanket
    // widening of the ceiling for every listing regardless of whether it
    // even matches that watch (which would also loosen the GLOBAL
    // freshness preference for ordinary SearchItem/general-deal scoring on
    // listings that don't match any watch at all — a real leak, not just a
    // hypothetical one, since nothing downstream of this gate re-checks
    // freshness for those pathways). Only a watch that's both
    // price-qualified AND whose own maxListingAgeMinutes genuinely covers
    // THIS listing's real age can rescue it; each watch still enforces its
    // own bound individually via evaluateWatchConditions further down
    // regardless of what rescued it here.
    // A Watch can rescue a listing past the general window only if it has an age window of its OWN that covers it (a Watch
    // with no age condition uses the general window, so it cannot). A rescued listing is kept for that Watch only: it must
    // not also become an ordinary deal, since nothing downstream of this gate re-checks age (see listingAge.ts decideAgeGate,
    // the final guard in runPostScoringPipeline, and dealGate.ts). An age that is unknown is not skipped here, but it can
    // never be a verified deal.
    const ageGate = decideAgeGate(detail.listingAge, config.maxListingAgeHours, priceQualifiedWatches);
    if (ageGate.skip) {
      this.log("info", `skip (too old — ${detail.listingAge}): ${listing.title}`, listing.url);
      this.opts.store.saveScored({
        listing: detail,
        extraction: {
          matchedItem: null,
          extractedAttributes: "",
          conditionImpact: "unknown",
          confidence: "low",
          reasoning: `Skipped — listed ${detail.listingAge}, older than your ${config.maxListingAgeHours}-hour freshness window.`,
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      });
      const staleRecord = this.opts.store.getLastSavedListing();
      if (staleRecord) this.opts.onListing(staleRecord);
      await this.sleep(600, 1500); // trimmed from 1000-2500ms, see the sleep() call above
      return { ...NOT_COUNTED, counted: true, visitedDetailPage: true, title: listing.title, price: listing.price, reasoning: `too old — ${detail.listingAge}`, notable: false };
    }

    // Per explicit instruction — reported live with a screenshot: a
    // listing already set up through Facebook's own shipping program
    // ("Ships for $13.18," "Estimated arrival ...," "Door dropoff") got
    // flagged as a deal, but it isn't a hidden local find — it's already
    // visible and buyable by every other reseller nationally through
    // Facebook's own logistics. A mention of eBay is treated the same way
    // (implies it's already cross-listed/benchmarked elsewhere). Only
    // knowable from the detail page (see scraper.ts's fetchListingDetail),
    // same posture as the freshness check just above — counted toward the
    // rotation budget since a real page visit already happened.
    if (detail.hasOfficialShipping || detail.mentionsEbay) {
      const reason =
        detail.hasOfficialShipping && detail.mentionsEbay
          ? "already set up with Facebook's own shipping program and mentions eBay"
          : detail.hasOfficialShipping
            ? "already set up with Facebook's own shipping program"
            : "mentions eBay";
      this.log("info", `skip (${reason}): ${listing.title}`, listing.url);
      this.opts.store.saveScored({
        listing: detail,
        extraction: {
          matchedItem: null,
          extractedAttributes: "",
          conditionImpact: "unknown",
          confidence: "low",
          reasoning: `Skipped — ${reason}, not a hidden local deal.`,
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      });
      const shippingRecord = this.opts.store.getLastSavedListing();
      if (shippingRecord) this.opts.onListing(shippingRecord);
      await this.sleep(600, 1500);
      return { ...NOT_COUNTED, counted: true, visitedDetailPage: true, title: listing.title, price: listing.price, reasoning: reason, notable: false };
    }

    // Scam bots (see sellerRisk.ts's detectScamBot): skipped right away, before any risk check or AI call, and
    // deliberately NOT blacklisted: only this listing is dropped, the product itself stays welcome.
    const scamReason = detectScamBot(`${detail.title} ${detail.description}`, detail.seller);
    if (scamReason) {
      this.log("info", `skip (${scamReason}): ${listing.title}`, listing.url);
      this.opts.store.saveScored({
        listing: detail,
        extraction: {
          matchedItem: null,
          extractedAttributes: "",
          conditionImpact: "unknown",
          confidence: "low",
          reasoning: `Skipped — ${scamReason}.`,
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      });
      const scamRecord = this.opts.store.getLastSavedListing();
      if (scamRecord) this.opts.onListing(scamRecord);
      await this.sleep(600, 1500);
      return { ...NOT_COUNTED, counted: true, visitedDetailPage: true, title: listing.title, price: listing.price, reasoning: scamReason, notable: false };
    }

    const sellerRisk = evaluateSellerRisk(detail.seller, config.sellerRisk);
    if (!sellerRisk.passed) {
      this.log("info", `seller risk: ${listing.title} — ${sellerRisk.reasons.join("; ")}`, listing.url);
      this.opts.store.saveScored(
        {
          listing: detail,
          extraction: {
            matchedItem: null,
            extractedAttributes: "",
            conditionImpact: "unknown",
            confidence: "low",
            reasoning: `Excluded on seller risk: ${sellerRisk.reasons.join("; ")}`,
          },
          referencePriceUsd: null,
          discountPercent: null,
          isDeal: false,
          dealTier: null,
          estimatedValueRange: null,
          offTopicSuggestion: null,
        },
        sellerRisk
      );
      const record = this.opts.store.getLastSavedListing();
      if (record) this.opts.onListing(record);
      await this.sleep(900, 2400); // trimmed from 1500-4000ms, see the sleep() call above
      return {
        ...NOT_COUNTED,
        counted: true,
        visitedDetailPage: true,
        title: listing.title,
        price: listing.price,
        reasoning: `seller risk: ${sellerRisk.reasons.join("; ")}`,
        notable: true,
      };
    }

    const dismissedCategories = this.opts.store.getDismissedCategories();
    // Per explicit instruction — the user's own Feed feedback (the "good"/
    // "bad" buttons) should actually steer future general-deal judgments,
    // not just sit recorded and unused; see scorer.ts's
    // buildFeedbackExamplesBlock. Fetched fresh per listing (cheap, a
    // handful of DB rows) so feedback given mid-scan takes effect on the
    // very next evaluation, same responsiveness posture as config filters.
    const feedbackExamples = this.opts.store.getFeedbackExamples();
    // A broken / for-parts listing of an item that includes broken ones gets its own Database variant (made and researched on first
    // sight) so it is priced as what it is, not as a working one at a quarter of the price.
    const brokenCandidate = matchSearchItem(detail.title, config.searchItems);
    if (brokenCandidate?.includeBroken && looksBroken(`${detail.title} ${detail.description}`)) {
      this.log("info", `Broken / for-parts listing of "${brokenCandidate.item}": checking what broken ones sell for...`, listing.url);
      await this.opts.ensureBrokenVariant?.(brokenCandidate.item, detail.title).catch(() => undefined);
    }
    let scored;
    try {
      scored = await timed("scoring_ai", () => scoreListing(detail, config, dismissedCategories, feedbackExamples, (item, title) => this.opts.store.getEbayValueForProductName(item, title), (title) => this.opts.store.getEbayValueForTitle(title), (item) => this.opts.store.getBrokenVariantValue(item)));
    } catch (err) {
      this.log("error", `Scoring failed for "${listing.title}": ${(err as Error).message}`, listing.url);
      return { ...NOT_COUNTED, counted: true, visitedDetailPage: true };
    }
    // Past the general freshness window and kept only for a Watch with its own covering window: never an ordinary deal.
    if (ageGate.watchOnly) scored = this.demoteForAge(scored, detail.listingAge);

    this.opts.store.saveScored(scored, sellerRisk);
    const record = this.opts.store.getLastSavedListing();
    if (record) this.opts.onListing(record);

    // Per explicit instruction — Watch condition evaluation runs
    // independently of scored.isDeal: a watch's own bar (e.g. "price ≤
    // $300") is a different, separately-configured threshold than the
    // general deal-scoring bar, and gating on isDeal would silently drop
    // matches the user explicitly asked for. This is the FIRST of two
    // evaluation points (see runPostScoringPipeline for the deferred
    // re-check after vision) — covers the common case of a match that's
    // already fully determined by text/price alone.
    await this.recordWatchMatchesIfAny(priceQualifiedWatches, scored, config, discoveryMode);

    // Per explicit instruction: when the general-deal AI itself recognizes
    // a listing as categorically unrelated to reselling (real estate, a
    // job posting, a service...) rather than just an uninteresting
    // resalable item, that suggestion grows the blacklist automatically —
    // the exact same kind of listing gets skipped deterministically next
    // time (see the isBlacklisted check above), without spending another
    // AI call on it. Source "ai" so the Database's Blacklist section can
    // show provenance and the user can remove anything it got wrong.
    if (scored.offTopicSuggestion) {
      // Per explicit instruction — "blacklist both the title and the image
      // if possible": the listing's own first real photo (falling back to
      // the summary card's thumbnail), downloaded as a data: URI the same
      // way the other photo-consuming steps in this function already do.
      const offTopicImageUrl = detail.imageUrls[0] ?? listing.thumbnailUrl ?? null;
      const offTopicImageDataUri = offTopicImageUrl ? await downloadImageAsDataUri(offTopicImageUrl) : null;
      const added = this.opts.store.addBlacklistTerm(
        scored.offTopicSuggestion,
        "ai",
        offTopicImageDataUri ? { imageData: offTopicImageDataUri, sourceTitle: listing.title } : null
      );
      if (added) {
        this.log("info", `Blacklisted "${added.term}" — "${listing.title}" looked unrelated to reselling.`, listing.url);
        this.opts.onBlacklistUpdated(this.opts.store.listBlacklistTerms());
        if (offTopicImageDataUri) this.opts.onBlacklistImagesUpdated(this.opts.store.listBlacklistedImages());
      }
    }

    // Per explicit instruction — decouple photo/vision analysis from the
    // critical scan loop so a multi-second AI call never blocks discovery
    // of the NEXT listing. Everything from photo analysis through the deal
    // notification below (previously all synchronous here) now runs as a
    // background job — see runPostScoringPipeline, an unmodified lift of
    // the exact code that used to be right here, and enqueueVisionJob's own
    // doc comment for the bounded-concurrency queue it runs on. When there
    // are no photos to analyze (or the feature is off), there's nothing to
    // defer — running the job inline is IDENTICAL to what this function
    // already did in that case, so behavior there is unchanged.
    // listing.price is already guaranteed non-null (see the early return
    // above) — the cast is only needed because TS doesn't carry that
    // narrowing through a closure captured for later/deferred invocation.
    const nonNullPricedListing = listing as ListingSummary & { price: number };
    const runPipeline = () =>
      this.runPostScoringPipeline(
        nonNullPricedListing,
        detail,
        config,
        scored,
        sellerRisk,
        greenFlagCandidate,
        dismissedCategories,
        priceQualifiedWatches,
        discoveryMode
      );
    if (config.photoAnalysis.enabled && detail.imageUrls.length > 0) {
      recordEvent("vision_enqueued");
      this.enqueueVisionJob(() =>
        runPipeline().catch((err) => this.log("error", `Background photo analysis failed for "${listing.title}": ${(err as Error).message}`, listing.url))
      );
    } else {
      await runPipeline();
    }

    // Per explicit instruction ("can it be a little faster?") — trimmed
    // from 2000-5000ms. Kept nonzero and still randomized on purpose: this
    // is what keeps listing-to-listing navigation from looking like a
    // metronome to Facebook, it's just a shorter gap now. Stays HERE
    // (synchronous, not inside the deferred pipeline) since it paces
    // Marketplace navigation itself, not vision analysis — unaffected by
    // the decoupling above.
    await politeDelay(1500, 4000);
    // The PROVISIONAL result, reflecting `scored` exactly as scoreListing
    // computed it — precisely what this function already returned in every
    // case where photo analysis was off or there were no photos. When
    // vision IS queued, this is deliberately provisional: the batch recap
    // narration and per-location rotation counting that read this result
    // use the PRE-vision numbers, and won't reflect a LATER photo-driven
    // change (a green-flag confirmation, a bundle-value bump, a mismatch
    // override) — the actual listing record in Feed/Activity still gets
    // that update the moment the background job finishes (via saveScored +
    // onListing inside runPostScoringPipeline), and a deal notification
    // still fires correctly at that point too. Only the immediate-return
    // summary and batch narration are ever "stale" by the vision queue's
    // own latency, which is exactly the tradeoff asked for.
    return {
      counted: true,
      visitedDetailPage: true,
      isDeal: scored.isDeal,
      title: listing.title,
      price: listing.price,
      dealTier: scored.dealTier,
      discountPercent: scored.discountPercent,
      estimatedValueRange: scored.estimatedValueRange,
      reasoning: scored.extraction.reasoning,
      notable: scored.extraction.matchedItem !== null,
    };
  }

  // Per explicit instruction — the vision-dependent tail of evaluateListing,
  // extracted verbatim (no logic changes) so it can run either inline
  // (today's behavior, when there's nothing to defer) or as a queued
  // background job (see enqueueVisionJob) without duplicating this
  // decision chain. Every side effect (saveScored, onListing,
  // onBlacklistUpdated, onProductUpdated, onNewProductFound, sendDealAlert,
  // onNarrate) happens internally exactly as before — this has no return
  // value because the CALLER's own immediate/provisional result no longer
  // depends on what happens in here, per explicit instruction that a
  // listing should show a provisional result while vision is pending and
  // get updated once it completes.
  private async runPostScoringPipeline(
    // Narrowed to a non-null price — evaluateListing already returned early
    // for a null price long before this is ever called, but that narrowing
    // doesn't carry across a function boundary on its own, so it's encoded
    // in the parameter type instead (this function's own contract, not a
    // runtime check) rather than re-asserting it here.
    listing: ListingSummary & { price: number },
    detail: ListingDetail,
    config: EngineConfig,
    scored: ScoredListing,
    sellerRisk: SellerRiskResult,
    greenFlagCandidate: SearchItem | null,
    dismissedCategories: string[],
    // Per explicit instruction — the SAME price-qualified watches
    // evaluateListing already computed once; passed down rather than
    // recomputed since the listing's own price never changes between the
    // two evaluation points, only scored's own pricing fields (via vision)
    // do — see this function's own deferred recordWatchMatchesIfAny call
    // below.
    priceQualifiedWatches: Watch[],
    // Threaded down from evaluateListing's own param — see its doc comment
    // for why this defaults to "passive" everywhere except runWatchCheck.
    discoveryMode: "passive" | "active"
  ): Promise<void> {
    // Photos are the real identification mechanism now, ahead of anything
    // text-based — a listing's title/category can be vague or wrong, but
    // what's actually IN the photos isn't. Runs early and for every
    // eligible listing (any tier, deal or not), not just confirmed deals,
    // so both the bundle-value check below and the research step after it
    // can use ONE real look at the photos instead of trusting the text.
    let photoResult: PhotoAnalysisResult | null = null;
    // Save-credits mode: the (expensive, multi-photo) vision look is only for listings worth it: a deal, a near-match on
    // something tracked, or a Watch candidate.
    // A hidden gem: a tracked item priced too high on its own (needing more than a 25% cut) but whose listing suggests extras come with
    // it (a console with an expansion card): worth a look at what the whole lot is worth, even in save-credits mode.
    const hiddenGem =
      !scored.isDeal &&
      !!scored.extraction.matchedItem &&
      (scored.referencePriceUsd ?? 0) > 0 &&
      isHiddenGemCandidate({
        priceUsd: listing.price,
        shippingUsd: detail.ebayShippingUsd ?? 0,
        baseValueUsd: (scored.referencePriceUsd ?? 0) * (scored.extraction.brokenVariant ? 1 : CONDITION_VALUE_MULTIPLIER[detectConditionImpact(`${listing.title} ${detail.description}`)]),
        settings: resaleSettingsFrom(config),
        text: `${listing.title} ${detail.description}`,
      });
    if (hiddenGem) this.log("info", `"${listing.title}" is pricey on its own, but may come with extras: looking at what the whole lot is worth...`, listing.url);
    if (config.photoAnalysis.enabled && detail.imageUrls.length > 0 && (!isLowAiMode() || scored.isDeal || !!greenFlagCandidate || priceQualifiedWatches.length > 0 || hiddenGem)) {
      // A green-flag candidate (see above) takes priority over the raw
      // title as the thing to check photos against — "Xbox X" itself isn't
      // a real product to compare against, but "Xbox Series S" is, and
      // this is also what makes runPhotoAnalysis pull that item's own real
      // reference photos (if the Database has any) for the comparison.
      const claimedItem = scored.extraction.matchedItem || greenFlagCandidate?.item || listing.title;
      // Per explicit instruction — prefer the user-CONFIRMED Database
      // product (see SearchItem.linkedProductId, set via the "is this what
      // you're searching for?" popup) for the claimedItem reference photos
      // below, over the fuzzy name-based findMatchingProduct lookup
      // runPhotoAnalysis would otherwise fall back to.
      const matchedSearchItem = scored.extraction.matchedItem
        ? (config.searchItems.find((s) => s.item === scored.extraction.matchedItem) ?? null)
        : greenFlagCandidate;
      // Per explicit instruction — this used to also flip Dashboard's Live
      // panel to "Researching photos..." (analyzingPhotos/currentReaction)
      // while this ran. That status is tied to whatever listing is
      // CURRENTLY being shown in Live, which by the time a QUEUED vision
      // job like this one actually runs is very likely a different,
      // unrelated listing the loop has since moved on to — showing it here
      // would attach the wrong reaction to the wrong card, so this no
      // longer touches it. vision_queue_depth/vision_jobs_sec/average
      // vision latency (see metrics.ts, surfaced in Activity) are the
      // replacement signal for "is vision busy right now."
      photoResult = await timed("vision_analysis", () =>
        this.runPhotoAnalysis(
          listing.id,
          listing.title,
          detail.description,
          listing.price,
          detail.imageUrls,
          scored.extraction.matchedItem,
          claimedItem,
          detail.hasVideo,
          matchedSearchItem?.linkedProductId ?? null,
          config
        )
      );
      recordEvent("vision_completed");
    }

    // Per explicit instruction — "if the ai comes across a listing with a
    // video as its thumbnail, find the most relevant image to the listing
    // title... use that as the thumbnail for Feed instead": the saveScored
    // call right above this (before photo analysis even ran) already
    // persisted/broadcast this listing with detail.imageUrls in its raw,
    // as-scraped order — exactly what could put a video's own poster frame
    // first, since Feed's own carousel just shows imageUrls[0] by default.
    // Vision's titleMatchPhoto (see vision.ts) is already used to pick the
    // best representative photo elsewhere (the Database's reference-photo
    // library) but was never actually promoted into what Feed shows —
    // this does that: moves it to the front of imageUrls and re-saves/
    // re-broadcasts so the corrected photo becomes the default the moment
    // it's known, without waiting on whichever of the conditional blocks
    // below happens to fire next (most listings hit none of them).
    if (detail.hasVideo && photoResult?.titleMatchPhoto && !detail.imageUrls.some((u) => u.startsWith("data:image"))) {
      const titleMatchPhoto = photoResult.titleMatchPhoto;
      // Only shown on the Feed card, so a card-sized copy is stored (see shrinkImageDataUri).
      const cardPhoto = await shrinkImageDataUri(titleMatchPhoto);
      detail = { ...detail, imageUrls: [cardPhoto, ...detail.imageUrls.filter((u) => u !== titleMatchPhoto)] };
      scored = { ...scored, listing: detail };
      this.opts.store.saveScored(scored, sellerRisk);
      const thumbFixed = this.opts.store.getLastSavedListing();
      if (thumbFixed) this.opts.onListing(thumbFixed);
    }

    // Per explicit instruction: a green-flag candidate (see above) gets
    // promoted to a real, priced search-tier match once the photos actually
    // confirm it — same reference price/budget math as a listing that
    // matched cleanly by title (see scorer.ts's evaluateSearchItemPricing).
    // A seller's bad title shouldn't cost a genuine deal just because the
    // deterministic text match never had a chance to see it. Runs before
    // the mismatch-override/bundle-value blocks below so a green-flag
    // confirmation counts as a real matchedItem for both of those too.
    if (greenFlagCandidate && !scored.extraction.matchedItem && photoResult?.matchesClaim === true) {
      const conditionImpact = detectConditionImpact(`${listing.title} ${detail.description}`);
      const pricing = evaluateSearchItemPricing(greenFlagCandidate, listing.price, conditionImpact, greenFlagCandidate.maxPriceUsd, {
        valueUsd: this.opts.store.getEbayValueForProductName(greenFlagCandidate.item),
        settings: resaleSettingsFrom(config),
      });
      this.log(
        "info",
        `Green flag confirmed: "${listing.title}" is actually a "${greenFlagCandidate.item}" — photos match, ${
          pricing.isDeal ? "and it's a real deal" : "but the price doesn't clear the bar"
        }.`
      );
      const greenFlagExtraction: ExtractionResult = {
        matchedItem: greenFlagCandidate.item,
        extractedAttributes: "",
        conditionImpact,
        confidence: "high",
        reasoning: `The listing was titled "${listing.title}", but the photos confirm this is actually a "${greenFlagCandidate.item}" — priced accordingly.`,
      };
      const greenFlagDealTier: DealTier = pricing.isDeal ? "search" : null;
      scored = {
        ...scored,
        extraction: greenFlagExtraction,
        referencePriceUsd: pricing.referencePriceUsd,
        discountPercent: pricing.discountPercent,
        isDeal: pricing.isDeal,
        dealTier: greenFlagDealTier,
      };
      this.opts.store.saveScored(scored, sellerRisk);
      const updated = this.opts.store.getLastSavedListing();
      if (updated) this.opts.onListing(updated);
    }

    // Verified live miss: a listing titled/matched as "Xbox Series X" whose
    // photos actually showed only a controller got flagged as an 83%-under
    // DEAL — the discount math was comparing the listing's price against a
    // full console's reference price for something that was never a
    // console. matchesClaim === false means the vision model looked at the
    // photos against what this listing claims to be and found something
    // meaningfully different/lesser.
    //
    // Per explicit instruction — reported live: searching "xbox series x"
    // was surfacing actual VIDEO GAMES (a game's title routinely reads
    // "Call of Duty ... Xbox Series X" — the platform name, not the
    // console, but that satisfies matchSearchItem's plain text check just
    // fine). This used to only override isDeal, leaving matchedItem/the
    // reasoning still claiming it WAS the tracked console — so a mismatched
    // game still showed up in Feed labeled and counted as an "xbox series
    // x" match, just not flagged as a deal. Broadened from "only when it
    // looked like a deal" to ANY confirmed matchedItem: a confident visual
    // mismatch means this listing isn't the tracked item at all, which
    // should be true regardless of whether the (wrong) reference price
    // happened to make it look like a deal.
    // Condition-awareness — captured BEFORE matchedItem gets nulled below,
    // so the researchSubjects loop further down can make the correction
    // explicit (product notes / log line) rather than leaving it as an
    // implicit side effect of that loop already reinforcing/creating
    // whatever vision's own identifiedProducts named. claimedAs is only
    // ever read once matchesClaim is confirmed false, so it's always the
    // real pre-mismatch value here, never the already-nulled one.
    let mismatchCorrection: { claimedAs: string; reason: string | null } | null = null;
    // NOTE: the renderer's outline colors (ListingSourceMarks.tsx's
    // listingVerdict) recognize this reasoning wording to show a yellow
    // "not sure" outline — keep the two in sync if the text below changes.
    if (scored.extraction.matchedItem && photoResult?.matchesClaim === false) {
      mismatchCorrection = { claimedAs: scored.extraction.matchedItem, reason: photoResult.mismatchReason };
      this.log(
        "warn",
        `Photo/title mismatch for "${listing.title}": claimed to be "${scored.extraction.matchedItem}" but photos show ${photoResult.mismatchReason ?? "something different"} — no longer counting this as a match.`,
        listing.url
      );
      scored = {
        ...scored,
        isDeal: false,
        dealTier: null,
        extraction: {
          ...scored.extraction,
          matchedItem: null,
          reasoning: `Looked like it might be "${scored.extraction.matchedItem}" by title alone, but the photos show ${photoResult.mismatchReason ?? "something different from what this listing claims to be"} — not counting it as a match.`,
        },
      };
      this.opts.store.saveScored(scored, sellerRisk);
      const updated = this.opts.store.getLastSavedListing();
      if (updated) this.opts.onListing(updated);
    }

    // A listing that doesn't clear the price bar on the base item alone
    // can still be a real deal once you count what's actually IN the
    // photos — a console bundled with several games, say — that the title/
    // description never mentioned. Per explicit instruction — "the switch
    // itself might only be $120, but there could be $200 worth of games" —
    // this adds the AI's own estimated bundle value to the matched item's
    // reference price and recomputes the discount for real, rather than
    // just flipping isDeal true/false with no idea how much the bundle is
    // actually worth. Runs even when scored was ALREADY a deal some other
    // way, so the displayed discount% reflects the true total value either
    // way — only needs a real matchedItem with a real reference price (so
    // there's something to add the bundle value TO) and photos that
    // actually match the claimed item to begin with (see the mismatch
    // override above).
    // The listing's own words come first: extras the seller prices separately ("Also have a 1tb storage card for 120$", a parted-out
    // list with a price per item) are NOT part of the asking price, so they add nothing to what this purchase is worth.
    const extrasSeparate = extrasPricedSeparately(`${listing.title}\n${detail.description}`);
    if (extrasSeparate && photoResult?.hasValuableBundle) {
      this.log("info", `"${listing.title}": the seller prices the extras separately, so they are not counted towards this price.`, listing.url);
    }
    // Several products in one listing: each is priced on its own first, then the lot is valued with the main item as the focal point
    // (extras add only part of what they'd fetch alone, and slow or bulky ones are left out), never as one long sum. Only for
    // listings that matter (a deal, a near-miss that might be a hidden gem, or a Watch candidate) so ordinary listings cost nothing.
    // When the breakdown is there it replaces the photo-based lump estimate below, which stays as the fallback.
    const baseValueForLot =
      scored.referencePriceUsd !== null && scored.referencePriceUsd > 0
        ? scored.referencePriceUsd * (scored.extraction.brokenVariant ? 1 : CONDITION_VALUE_MULTIPLIER[detectConditionImpact(`${listing.title} ${detail.description}`)])
        : 0;
    let bundleExtras: { valueUsd: number; phrase: string } | null = null;
    // What of the extras the Deal Quality Gate may COUNT (priced item by item, or named in the listing and capped) and what it may not.
    // Whether the extras turn a listing into a deal is decided by the gate below, once everything else has been adjusted.
    let gateExtras: GateExtras | null = null;
    if (
      !extrasSeparate &&
      this.opts.valueBundle &&
      photoResult?.matchesClaim !== false &&
      scored.extraction.matchedItem &&
      baseValueForLot > 0 &&
      listing.price !== null &&
      (hiddenGem || scored.isDeal || priceQualifiedWatches.length > 0) &&
      looksLikeBundle(`${listing.title}\n${detail.description}`)
    ) {
      try {
        const valuation = await this.opts.valueBundle({ title: listing.title, description: detail.description, mainName: scored.extraction.matchedItem, mainValueUsd: baseValueForLot });
        if (valuation) {
          this.log("info", `Bundle breakdown for "${listing.title}": ${valuation.summary}. The lot is worth about $${valuation.totalValueUsd} (simply adding everything up would say $${valuation.naiveSumUsd}).`, listing.url);
          bundleExtras = { valueUsd: valuation.addedUsd, phrase: valuation.summary };
          gateExtras = gateExtrasFromValuation(valuation);
        }
      } catch (err) {
        this.log("warn", `Couldn't break down the bundle in "${listing.title}": ${(err as Error).message}`, listing.url);
      }
    }
    if (!bundleExtras && !extrasSeparate && photoResult?.hasValuableBundle && photoResult.bundleEstimatedValueUsd) {
      bundleExtras = { valueUsd: photoResult.bundleEstimatedValueUsd, phrase: `${photoResult.bundleDescription}, worth an estimated $${photoResult.bundleEstimatedValueUsd}` };
      // One photo-based guess: counted only when the listing's own words mention extras, and only up to a share of the base item's value.
      gateExtras = gateExtrasFromLump(photoResult.bundleEstimatedValueUsd, baseValueForLot, looksLikeBundle(`${listing.title}\n${detail.description}`));
    }
    if (
      bundleExtras &&
      bundleExtras.valueUsd > 0 &&
      photoResult?.matchesClaim !== false &&
      scored.extraction.matchedItem &&
      baseValueForLot > 0 &&
      listing.price !== null
    ) {
      // Remembered either way: the alert rates the whole lot (what may be counted), not just the base item.
      scored = { ...scored, bundleValueUsd: gateExtras ? gateExtras.countedUsd : 0, bundleDescription: bundleExtras.phrase };
    } else {
      gateExtras = null;
    }

    // Per explicit instruction: every evaluated listing (not just confirmed
    // deals) now files its photos into the Database under whatever
    // product(s) it actually depicts — reinforcing an existing entry's
    // notes/gallery if one matches, or creating a brand-new entry (seeded
    // with a REAL photo from THIS listing, not a generic web search — see
    // onNewProductFound) when the AI is confident enough to have named
    // something specific that isn't tracked yet. This replaces the old
    // "reinforce, never create" restriction, which existed specifically to
    // avoid Database clutter from vague/unconfident guesses — that
    // protection is still here, just moved: researchSubjects below already
    // excludes anything the vision/text step wasn't confident enough to
    // name specifically (see analyzeListingPhotos's own prompt, which
    // returns an empty list rather than guess) and anything the user has
    // dismissed as a category they don't care about. The photos' own
    // identified products (see above) are the subjects considered whenever
    // photo analysis actually ran and found something specific — a listing
    // can name several (a console PLUS separate games) — falling back to
    // the old text-based subject (the canonical Search For name, or the
    // general-tier category guess) only when there were no photos, photo
    // analysis is off, or the model couldn't confidently identify anything.
    const visionSubjects = photoResult?.identifiedProducts ?? [];
    const fallbackSubject = scored.extraction.matchedItem || scored.extraction.extractedAttributes.trim();
    const rawSubjects = visionSubjects.length ? visionSubjects : fallbackSubject ? [fallbackSubject] : [];

    // Per explicit instruction — a product's own "hard cap at desired
    // price" (set on its Database page, alongside the resale-history
    // fields) forces a skip outright once a listing is recognized as that
    // product — by TEXT match (matchedItem) or PHOTO identification
    // (visionSubjects), either counts — and priced above what the user said
    // they're willing to pay, no matter how good the discount otherwise
    // looks. Runs after every isDeal-affecting block above so it has final
    // say regardless of which one(s) actually set isDeal true.
    let hardCapHit = false;
    if (scored.isDeal && listing.price !== null) {
      const price = listing.price;
      for (const subject of rawSubjects) {
        const capProduct = this.opts.store.findMatchingProduct(subject);
        if (capProduct?.hardCapAtDesiredPrice && capProduct.desiredPriceUsd != null && price > capProduct.desiredPriceUsd) {
          this.log(
            "info",
            `Hard price cap: "${listing.title}" recognized as "${capProduct.name}" but $${price} is over your $${capProduct.desiredPriceUsd} cap — skipping.`,
            listing.url
          );
          scored = {
            ...scored,
            isDeal: false,
            dealTier: null,
            extraction: {
              ...scored.extraction,
              reasoning: `Recognized as "${capProduct.name}", but $${price} is above the $${capProduct.desiredPriceUsd} hard price cap you set for it — skipping regardless of discount.`,
            },
          };
          this.opts.store.saveScored(scored, sellerRisk);
          const updated = this.opts.store.getLastSavedListing();
          if (updated) this.opts.onListing(updated);
          hardCapHit = true;
          break;
        }
      }
    }

    const researchSubjects = rawSubjects.filter((s) => !dismissedCategories.some((c) => c.toLowerCase() === s.toLowerCase()));
    // Only a SPECIFIC subject is trustworthy enough to found a brand-new
    // Database entry on: a real Search For item (or a green-flag item
    // vision just confirmed), or something the vision model itself
    // confidently named. scored.extraction.extractedAttributes — the
    // general-deal AI pathway's own coarse category guess, e.g. "cordless
    // power tool" — is a bucket, not a specific product, and auto-creating
    // a "product" literally named after a generic bucket is exactly the
    // clutter the old reinforce-never-create rule existed to prevent. A
    // generic guess can still REINFORCE an existing entry below if one
    // happens to already carry that name, just never spawn a new one.
    const specificSubjects = new Set(scored.extraction.matchedItem ? [scored.extraction.matchedItem, ...visionSubjects] : visionSubjects);

    // Per-subject, not one shared photo for the whole listing — verified
    // live miss: reusing the listing's first photo for EVERY subject
    // misattributed a completely wrong photo whenever a listing depicted
    // more than one distinct item (reported live: a "Nintendo 3DS" Database
    // entry showing a Call of Duty game case as its thumbnail, because the
    // CoD case happened to be the first photo in a listing that also showed
    // the 3DS itself elsewhere). vision.ts's photoAttribution now maps each
    // identified subject to the SPECIFIC photo the model actually pointed
    // to for it; only a subject with no such attribution (the text-only
    // fallback path, or a case vision didn't confidently pin to one photo)
    // falls back to this general-purpose photo.
    //
    // Per explicit instruction — "sometimes the ai will come across
    // sellers that have videos in their listings... find the most
    // relevant image to the listing title": this used to always be
    // detail.imageUrls[0], the listing's first photo in raw DOM order —
    // exactly wrong whenever that first "photo" was actually a frame from
    // a video the seller added (a bad angle, mid-motion, a paused intro
    // screen), rather than a real standalone shot. Now prefers vision's
    // own titleMatchPhoto (picked by looking across every photo for the
    // one that best represents the listing's actual title — see
    // vision.ts), falling back to the raw first image only when photo
    // analysis didn't run at all (config toggle off) or came back with no
    // usable pick. Downloaded/resolved lazily and only once either way, so
    // a listing where every subject IS specifically attributed never
    // touches this at all.
    let fallbackImageDataUri: string | null | undefined; // undefined = not attempted yet
    async function fallbackImage(): Promise<string | null> {
      if (fallbackImageDataUri === undefined) {
        if (photoResult?.titleMatchPhoto) {
          fallbackImageDataUri = photoResult.titleMatchPhoto;
        } else {
          fallbackImageDataUri = detail.imageUrls.length > 0 ? await downloadImageAsDataUri(detail.imageUrls[0]) : null;
        }
      }
      return fallbackImageDataUri;
    }

    for (const subject of researchSubjects) {
      // Save-credits mode: a listing that wasn't worth a vision look (not a deal) doesn't get filed into the Database either:
      // that would cost an identity check and possibly a whole product research for something nobody is buying.
      if (isLowAiMode() && !photoResult) continue;
      const subjectImageDataUri = photoResult?.productPhotos[subject] ?? (await fallbackImage());
      const existingProduct = this.opts.store.findMatchingProduct(subject);
      // Condition-awareness — most of this correction mechanism already
      // existed (this loop already reinforces/creates whatever vision
      // itself believes the photos show, via findMatchingProduct's fuzzy
      // matching, regardless of what the listing claimed) — this just
      // makes it EXPLICIT rather than an implicit side effect, so a
      // product's own accumulated notes reflect WHY it was corrected, not
      // just a bare reinforcement. visionSubjects[0] is vision's own
      // primary/focal identification — the one subject actually worth
      // calling "the corrected identity" when there's more than one.
      const correctionNote =
        mismatchCorrection && subject === visionSubjects[0]
          ? `Originally listed/matched as "${mismatchCorrection.claimedAs}" — photos indicate this is actually "${subject}"${mismatchCorrection.reason ? `: ${mismatchCorrection.reason}` : ""}.`
          : null;
      if (existingProduct) {
        // The name matched an existing entry, but is this listing really that exact product? A listing carrying
        // details the entry's name doesn't (a brand, a model line) gets a second look: confident matches carry on
        // as before, a different specific model gets its own entry under the generic one, and an unsure one keeps
        // its note but doesn't put its photo in an entry's gallery. See productIdentity.ts.
        const { action, verdict } = await resolveIdentityTarget(this.opts.store, existingProduct, {
          title: listing.title,
          description: detail.description,
          imageDataUri: subjectImageDataUri,
        });
        if (action.kind === "create" && config.autoResearchListings) {
          this.log(
            "info",
            `"${listing.title}" isn't the same product as "${existingProduct.name}" — it's a more specific model (${action.name}). Adding it to the Database under "${existingProduct.name}".${verdict?.reason ? ` ${verdict.reason}` : ""}`,
            undefined,
            action.name
          );
          this.opts.onNewProductFound(action.name, subjectImageDataUri, listing.title, { parentId: action.parentId, familyFromId: action.familyFromId });
          continue;
        }
        const target =
          action.kind === "attach" ? (this.opts.store.getProductById(action.productId) ?? existingProduct) : existingProduct;
        const photoAllowed = action.kind === "attach";
        if (action.kind !== "attach") {
          this.log(
            "info",
            `Not sure "${listing.title}" is exactly "${existingProduct.name}"${verdict?.reason ? ` (${verdict.reason})` : ""} — noted it, but kept its photo out of the Database.`,
            undefined,
            existingProduct.name
          );
        }
        const noteParts = [
          listing.price !== null ? `$${listing.price}` : null,
          scored.extraction.matchedItem ? scored.extraction.extractedAttributes || null : null,
          scored.extraction.conditionImpact !== "unknown" ? `condition impact: ${scored.extraction.conditionImpact}` : null,
          correctionNote,
        ].filter((p): p is string => !!p);
        if (noteParts.length) {
          const updatedProduct = this.opts.store.appendProductObservation(target, subject, noteParts.join(" — "));
          if (updatedProduct) this.opts.onProductUpdated(updatedProduct);
        }
        if (subjectImageDataUri && photoAllowed) {
          this.opts.store.addProductImage(target.id, subjectImageDataUri, listing.title);
          this.opts.onReferencePhotoAdded?.(target.id);
        }
      } else if (specificSubjects.has(subject) && config.autoResearchListings) {
        this.log(
          "info",
          `New item of interest: "${subject}" isn't tracked yet — adding it to the Database.${correctionNote ? ` ${correctionNote}` : ""}`,
          undefined,
          subject
        );
        this.opts.onNewProductFound(subject, subjectImageDataUri, listing.title);
      }
    }

    // ---- Final qualification. Everything that can change what this listing is has now happened (vision, green-flag confirmation,
    // bundle / hidden-gem extras, the hard price cap), so the Deal Quality Gate decides ONCE, on the final state: age, resale evidence
    // (validated against a fresh WatchCount / eBay check for anything that may be pushed, and always for an AI-only find), margin and
    // negotiation. isDeal now means "qualified" (Profitable Now or Negotiation Opportunity); the verdict is saved so the Feed, the
    // Dashboard and the notifications all agree.
    const rawIsDeal = scored.isDeal;
    let qualification: Qualification | null = null;
    if (scored.isDeal || gateExtras !== null || priceQualifiedWatches.length > 0) {
      qualification = await qualifyScoredListing({
        scored,
        source: this.opts.store,
        settings: resaleSettingsFrom(config),
        maxAgeHours: config.maxListingAgeHours,
        check: this.opts.checkMarket,
        refreshMarket: rawIsDeal,
        extras: gateExtras,
        visionMismatch: mismatchCorrection !== null,
        hardCapExceeded: hardCapHit,
        log: (m) => this.log("info", m, listing.url),
      });
      scored = qualification.scored;
      this.opts.store.saveScored(scored, sellerRisk);
      const finalRecord = this.opts.store.getLastSavedListing();
      if (finalRecord) this.opts.onListing(finalRecord);
    }

    // The SECOND, deferred Watch evaluation point (some listings only become deal-shaped after vision), now against the FINAL verdict.
    // A Watch match is judged by the Watch's own criteria and is always delivered, but it only counts as a deal if it passed the gate,
    // and a match that is also a qualified deal is ONE notification. store.recordWatchMatch's UNIQUE(watch_id, listing_id) + INSERT OR
    // IGNORE makes this safe when the first (pre-vision) point already recorded the same match.
    const watched = await this.recordWatchMatchesIfAny(priceQualifiedWatches, scored, config, discoveryMode, undefined, qualification ?? undefined);
    if (watched) {
      qualification = watched;
      scored = watched.scored;
    }

    if (qualification?.verdict.qualified) {
      if (!rawIsDeal && gateExtras && gateExtras.countedUsd > 0) {
        this.log("deal", `Hidden gem: "${listing.title}" comes with extras (${scored.bundleDescription ?? "extras"}) that make it worth buying at $${listing.price}.`, listing.url);
      }
      await this.pushQualifiedDeal(qualification, config, listing);
    } else if (qualification?.verdict.status === "worth_a_look") {
      await this.noteWorthALook(qualification, config, listing);
    } else if (greenFlagCandidate) {
      // Per explicit instruction: a green flag that DIDN'T pan out (photo
      // analysis was off, vision couldn't confirm it, or it was confirmed
      // but the price didn't actually clear the bar) still deserves a human
      // glance, not just a plain skip line — it mentioned a high-value
      // tracked item, that's worth being able to click through and check
      // yourself even though the AI didn't act on it. Distinct yellow tier,
      // one below a confirmed "deal" (green) — see Dashboard.tsx.
      this.log(
        "greenFlag",
        `Green flag didn't pan out: "${listing.title}" mentioned "${greenFlagCandidate.item}" but wasn't confirmed as a deal.`,
        listing.url
      );
    } else {
      this.log("info", `skip: ${listing.title} — ${scored.extraction.reasoning || "no match / not a deal"}`, listing.url);
    }
  }

  // A qualified deal (Profitable Now or Negotiation Opportunity): logged, pushed once (never again if a Watch match already told the
  // user about this listing), and narrated.
  private async pushQualifiedDeal(q: Qualification, config: EngineConfig, listing: ListingSummary & { price: number }): Promise<void> {
    const { scored, verdict } = q;
    const tag = verdict.status === "negotiation" ? "NEGOTIATION OPPORTUNITY" : verdict.confidence === "low" ? "DEAL (limited sales data)" : "DEAL";
    this.log(
      "deal",
      `${tag}: ${listing.title} — $${listing.price}${verdict.status === "negotiation" && verdict.facts.requiredDiscountPercent !== null ? ` (needs ${verdict.facts.requiredDiscountPercent}% off: offer ~$${verdict.facts.targetPriceUsd})` : scored.discountPercent !== null ? ` (${scored.discountPercent.toFixed(0)}% under)` : ""}`,
      listing.url
    );
    try {
      if (this.opts.store.isListingNotified(scored.listing.id)) {
        this.log("info", `Already notified about "${listing.title}" (as a Watch match): not sending a second alert.`, listing.url);
      } else {
        const summary = buildQualifiedAlert({ q, source: this.opts.store, settings: resaleSettingsFrom(config), kind: "deal" });
        await sendDealAlert(config, scored, summary);
        this.opts.store.markNotified(scored.listing.id);
      }
    } catch (err) {
      this.log("error", `Notification failed: ${(err as Error).message}`, listing.url);
    }
    this.opts
      .onNarrate({
        kind: "deal",
        title: listing.title,
        price: listing.price,
        dealTier: (scored.dealTier ?? "search") as "search" | "general",
        discountPercent: scored.discountPercent,
        estimatedValueRange: scored.estimatedValueRange,
        reasoning: verdict.headline,
      })
      .catch(() => {});
  }

  // Worth a look: kept in the Feed, never pushed unless the user turned that on (Config > notifyWorthALook), and then quietly.
  private async noteWorthALook(q: Qualification, config: EngineConfig, listing: ListingSummary & { price: number }): Promise<void> {
    this.log("info", `Worth a look: ${listing.title} — ${q.verdict.headline}`, listing.url);
    if (!config.notifyWorthALook || this.opts.store.isListingNotified(q.scored.listing.id)) return;
    try {
      const summary = buildQualifiedAlert({ q, source: this.opts.store, settings: resaleSettingsFrom(config), kind: "look" });
      await sendWorthALookAlert(config, q.scored, { ...summary, message: `${q.verdict.headline}` });
      this.opts.store.markNotified(q.scored.listing.id);
    } catch (err) {
      this.log("error", `Notification failed: ${(err as Error).message}`, listing.url);
    }
  }

  // Verified live miss, reported as "it keeps failing to search up that
  // item... it needs to search AFTER Facebook Marketplace is already
  // open": ensureBrowser() and the isLoggedIn() check used to run OUTSIDE
  // withPage() — only runCycle itself was queued. Starting the scanner
  // (engine.start()) and immediately firing a chat-triggered
  // searchForItemNow() (see index.ts's add_search_item — this is exactly
  // what happens when you ask the assistant to search for something while
  // the scanner isn't already running) meant BOTH this function's own
  // isLoggedIn(page) call AND searchForItemNow's own isLoggedIn(page) call
  // could fire concurrently on the SAME Playwright page — two simultaneous
  // page.goto() calls corrupting each other, so by the time the search
  // itself tried to type into the search box, the page was mid-navigation
  // from the OTHER call and nothing was there to type into. Fixed by moving
  // ensureBrowser()/isLoggedIn() inside the SAME withPage() call as
  // runCycle, with a priorityRequested check right after ensureBrowser() —
  // priorityRequested is always set synchronously before any of this can
  // actually start running (see searchForItemNow), so a cycle that starts
  // at the same moment as a requested search now reliably yields the page
  // immediately after opening the browser, before ever navigating it,
  // instead of racing to navigate it first.
  async runOnce(): Promise<void> {
    const config = this.opts.getConfig();
    if (!config.browseUrls.length) {
      this.log("error", "No browse URLs configured. Add at least one in Config.");
      return;
    }

    await this.withPage(async () => {
      const page = await this.ensureBrowser();
      if (this.priorityRequested) {
        this.log("info", "Pausing before this cycle even starts — a chat request needs the page right now.");
        return;
      }

      if (this.status.loggedIn !== true) {
        const loggedIn = await isLoggedIn(page);
        if (!loggedIn) {
          // Per explicit instruction, diagnosed live: this used to only ever
          // reach the Activity log — the Dashboard Live panel's fallback
          // text just said "Between cycles — sleeping a bit before the next
          // pass" regardless of WHY nothing happened, so a scanner silently
          // retrying this same failed login check every cycle, forever,
          // looked identical to normal idle time between passes. Setting
          // lastError surfaces this through the existing per-account error
          // banner on Dashboard (see accountsWithErrors) and the Live
          // panel's own loggedIn-aware fallback text — both already existed
          // for a thrown exception, just never wired up for this specific,
          // much more common case. Cleared automatically the moment a real
          // cycle actually starts (see runCycle's own lastError: null reset).
          const message = "Not logged into Facebook yet — a browser window should be open; log in there. This cycle will skip and retry next time.";
          this.setStatus({ loggedIn, lastError: message });
          this.log("error", message);
          const shown = await readPageSnapshot(page);
          this.noteSession((shown ? classifyFacebookPage(shown) : null) ?? "logged-out");
          return;
        }
        // Deliberately NOT clearing a reported session problem here: this check only loads Marketplace's front page, which can pass
        // while the page the cycle then opens still shows a login wall. The cycle's own check (guardSession, after each location is
        // opened) clears it when a normal page is really seen, so the notice and its phone push cannot flap on and off every cycle.
        // While a problem is reported the status stays "logged out" until the cycle's own check sees a normal page.
        this.setStatus({ loggedIn: this.reportedProblem ? false : loggedIn });
      }

      await this.runCycle(page, config);
    });
  }

  // Checked once per cycle (not inside every individual search — see
  // searchMarketplace's own comment on why it deliberately doesn't reopen
  // this mid-search), against whatever config.searchRadiusMiles currently
  // is — "state" location mode sets this to 40, everything else defaults
  // to 100 (see types.ts's Config.searchRadiusMiles).
  private async verifyRadiusOnPage(page: Page, config: EngineConfig): Promise<void> {
    try {
      await verifyOrSetRadius(page, config.searchRadiusMiles, (reason, level) => this.log(level ?? "warn", reason));
    } catch (err) {
      this.log("warn", `Start-of-cycle radius check failed: ${(err as Error).message} — continuing anyway.`);
    }
  }

  // The actual browse/search/evaluate work for one cycle — called from
  // inside runOnce's own withPage() callback (not a separate withPage()
  // call of its own), so the whole cycle, including the browser-open/login
  // steps that precede this, can never race a chat-triggered
  // searchForItemNow() for the same Facebook page.
  private async runCycle(page: Page, config: EngineConfig): Promise<void> {
    this.sessionBroken = false;
    this.visitsAttempted = 0;
    this.visitsNotOpened = 0;
    this.lastNotOpenedMessage = "";
    this.setStatus({ lastCycleStartedAt: Date.now(), lastError: null, listingsThisCycle: 0, currentSearch: "browsing" });

    const perLocation = Math.max(1, config.listingsPerLocation);
    const locationCount = config.browseUrls.length;

    // Per explicit redefinition of the search order — every fresh scan
    // does its one-time per-scan setup before ever picking a location to
    // actually search from (scanSetupDone is only ever reset in
    // start()/triggerOnce()).
    //
    // Per explicit instruction — reversing an earlier explicit instruction:
    // the Richmond-specific "starter city" anchor is REMOVED entirely, per
    // direct feedback that it was itself a source of bugs ("not rotating
    // locations at all... clearly checking to see if it's in richmond is
    // causing it to bug"). Every multi-location mode now does the exact
    // same thing here, regardless of locationMode — a plain, once-per-scan
    // radius check (Facebook stores this as a sticky per-profile
    // preference independent of which city is current, so checking it once
    // at the very start of a scan is exactly as effective as checking it at
    // a specific anchor city first) using whichever browse URL happens to
    // be first, then goes STRAIGHT into the random-city rotation below — no
    // special navigation, no dedicated "starting city" lookup. A
    // single-location account (city/ZIP mode, or a state that only
    // resolved one city) has nowhere else to set up FROM, so it skips this
    // whole block and radius-checks its own one location inside the
    // per-visit branch below instead.
    if (locationCount > 1 && !this.scanSetupDone && !this.stopRequested && !this.priorityRequested) {
      try {
        await page.goto(config.browseUrls[0], { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1200);
        await this.verifyRadiusOnPage(page, config);
      } catch (err) {
        this.log("warn", `Couldn't verify the search radius before starting: ${(err as Error).message} — continuing anyway.`);
      }
      this.scanSetupDone = true;
    }

    // Verified live miss: an earlier version of this made a cycle cover
    // exactly ONE random location, meaning "rotate to a new city after
    // hitting the per-location limit" only actually happened once every
    // multi-minute poll-interval sleep (see loop()) — the sleep was always
    // meant as the cooldown between full sweeps, not a wait between every
    // single city. Restored to visiting `locationCount` locations per
    // cycle (same visit COUNT as the original design).
    //
    // Verified live miss #2: picking each of those independently at random
    // (with replacement) could — and did — draw the same city twice in a
    // row, including immediately re-drawing the just-anchored Richmond
    // right after a completely different city, reported live as "it kept
    // rebounding to Richmond... without looking for anything." A shuffle
    // (a random PERMUTATION — every city exactly once per cycle, in random
    // order) is still "a random city" at each step, just without that
    // wasteful immediate-repeat possibility.
    const visitsThisCycle = locationCount > 1 ? locationCount : 1;
    const visitOrder = locationCount > 1 ? shuffledIndices(locationCount) : [this.locationIndex % Math.max(locationCount, 1)];

    for (let visit = 0; visit < visitsThisCycle; visit++) {
      if (this.stopRequested || this.sessionBroken) break;
      if (this.priorityRequested) {
        this.log("info", "Pausing the current cycle — a chat request needs the page right now.");
        break;
      }
      this.locationIndex = visitOrder[visit];
      const url = config.browseUrls[this.locationIndex];
      const locationLabel = describeLocationUrl(url);
      this.imageMatchAttemptsThisLocation = 0;
      // Per explicit instruction — Dashboard's Live panel shows this
      // in-between moment explicitly ("Switching locations...") instead of
      // just going blank between one listing and the next.
      this.setStatus({ locationIndex: this.locationIndex, currentListing: null, currentActionNote: locationCount > 1 ? "Switching locations..." : null });

      // The alert itself — fires the moment the scanner moves to a new
      // location, not folded into the "found N listings" line after the
      // fact, so it's clearly its own event in Activity. This navigates
      // there and confirms arrival ("log and check to see if in new
      // location") before anything searches/browses. Per explicit
      // instruction, diagnosed live from a screen recording ("right when
      // you start searching, it'll refresh the page a whole bunch of times
      // and do nothing") — the FIRST active search right after this used to
      // ALSO navigate to the same URL again itself (see searchMarketplace's
      // own alreadyOnCorrectPage param), stacking with this block's own up-
      // to-3 retries into several back-to-back reloads before anything was
      // ever typed. justConfirmedLocation below tells that first call it can
      // skip its own redundant re-navigation — every OTHER navigate-to-a-
      // URL call still does its own fresh navigate (browseListings, a
      // second/third active search item at this same location, the
      // URL-fallback path), on purpose (see scraper.ts) — verified live that
      // skipping that as a "don't refresh needlessly" optimization let a
      // stale, silently-drifted page (see
      // this account's own Facebook-side default location reasserting
      // itself client-side without changing the URL) go unnoticed all the
      // way to typing the search query, even though this check right here
      // had genuinely confirmed the correct city a moment earlier. A second
      // real navigation immediately before searching is what actually
      // closes that gap.
      // No radius re-check here — that's a sticky per-profile Facebook
      // setting verified once already this scan (see the once-per-scan
      // setup block above), not per city. A single-location account has
      // nowhere new to go, so it skips straight to its one location's own
      // radius check instead (unchanged from before this feature).
      // Per explicit instruction — set true only once the goto below
      // actually SUCCEEDS (not if the try block throws), and only consumed
      // by the FIRST searchMarketplace call at this location (see its own
      // use further down) — any second/third active-search item, or the
      // general browse pass, still needs its own real navigation, since by
      // then the page has moved on to whatever the first search left it on.
      let justConfirmedLocation = false;
      if (!this.stopRequested && !this.priorityRequested) this.visitsAttempted++;
      if (locationCount > 1) {
        this.log("info", `📍 Chose a new location to search: ${locationLabel}`);
        // Per explicit instruction — "have it switch locations, THEN enter
        // the user's search parameters": verified live that a single
        // 1000ms pause + one read wasn't always enough for Facebook's own
        // heavy client-side app to finish re-rendering the new location
        // before the active search below started typing — especially with
        // several accounts running at once competing for the same
        // machine's resources, the page could still be showing the
        // PREVIOUS location (reported live as "still defaulting to
        // Richmond") by the time the old code moved on. This now actually
        // checks the arrived label against the expected city name (not
        // just "is there a label at all") and retries the navigation a
        // couple of times if it doesn't match, instead of trusting one
        // goto + one read to have worked.
        const expectedCityName = locationLabel.split(",")[0]?.trim().toLowerCase() || null;
        let arrivedLabel: string | null = null;
        let confirmed = false;
        try {
          for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1200);
            arrivedLabel = await readCurrentLocationLabel(page);
            confirmed = !!arrivedLabel && (!expectedCityName || arrivedLabel.toLowerCase().includes(expectedCityName));
          }
          justConfirmedLocation = true;
          if (confirmed && arrivedLabel) {
            this.log("info", `Confirmed now browsing ${arrivedLabel}.`);
          } else if (arrivedLabel) {
            this.log(
              "warn",
              `Switched to ${locationLabel}, but the page still reads "${arrivedLabel}" after retrying — searching there anyway since Facebook may just be labeling it differently.`
            );
          } else {
            this.log("warn", `Switched to ${locationLabel}, but couldn't confirm the location from the page — continuing anyway.`);
          }
        } catch (err) {
          this.visitsNotOpened++;
          this.lastNotOpenedMessage = (err as Error).message;
          this.log("warn", `Failed to navigate to ${locationLabel}: ${(err as Error).message} — continuing anyway.`);
        }
      } else if (!this.stopRequested && !this.priorityRequested) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1200);
          await this.verifyRadiusOnPage(page, config);
        } catch (err) {
          // verifyRadiusOnPage handles its own failures, so what reaches here is the page itself not opening.
          this.visitsNotOpened++;
          this.lastNotOpenedMessage = (err as Error).message;
          this.log("warn", `Start-of-cycle radius check failed: ${(err as Error).message} — continuing anyway.`);
        }
      }

      // The page was just loaded: if Facebook answered with a login wall or a security check, say so and stop this cycle here
      // instead of searching a page that is not Marketplace (which looks like "0 listings found" forever).
      if (!this.stopRequested && !this.priorityRequested && (await this.guardSession(page, `after opening ${locationLabel}`))) break;

      let totalEvaluatedHere = 0;
      const batchDeals: Array<{ title: string; price: number | null }> = [];
      const batchSkips: Array<{ title: string; reason: string }> = [];

      // Per explicit instruction — reported live as "I asked it to search
      // for Nintendo Switch, it looked it up on Facebook, but then it just
      // started giving me general listings": the dedicated per-item search
      // used to run AFTER the passive general browse below, at every one of
      // however many locations are configured (49 by default). With that
      // order, the moment the continuous cycle reached its next location, it
      // would evaluate a batch of unrelated general listings BEFORE ever
      // getting back around to actively searching for whatever was just
      // added — which reads exactly like "it stopped searching for the
      // specific thing I asked for," even though nothing was actually
      // broken; the two have always run side by side, just in the wrong
      // order for this to feel right. Running the active searches FIRST at
      // each location means anything on the Search For list gets a fresh,
      // dedicated look right away every time the scanner visits somewhere
      // new, with general browsing filling in around that instead of ahead
      // of it. Falls back to the item name itself if you didn't separately
      // fill in match keywords, so an item added with just a name and price
      // still actually gets searched for.
      //
      // Capped at perLocation evaluations per item, same as passive
      // browsing below — a popular search term can return dozens of
      // results, and evaluating every single one (each a real page load +
      // an AI call, several seconds apiece) before ever moving on used to
      // mean the scanner could spend its ENTIRE cycle stuck evaluating one
      // item's search results at the very first location, never rotating
      // to the rest of the list at all. Only applies with more than one
      // location configured — with just one there's nowhere else to go,
      // so evaluating everything found still makes sense.
      // Per explicit instruction — a filter changed mid-scan (the
      // Dashboard's own Filters box, or Config) should take effect right
      // after whatever listing is currently being analyzed, not only once
      // the entire rest of this cycle (every remaining location) finishes.
      // `config` above is a single snapshot taken at the very start of the
      // whole cycle — re-fetching it fresh right before each search/listing
      // below, instead of reusing that stale copy, is what actually
      // delivers that: Facebook's own "Date listed" filter gets whatever
      // value is current the moment a NEW search is kicked off, and each
      // listing's own price-range/freshness checks (inside evaluateListing)
      // use whatever was current the moment THAT listing's analysis
      // started — already in flight when the user changes something, so it
      // finishes under the settings it started with, exactly like asked.
      const searchableItems = config.searchItems.filter((r) => getSearchTerms(r).length);

      // Facebook only lets you actively search ONE thing at a time — with
      // 0 or 1 searchable items that's never actually a conflict (the loop
      // below just runs zero or one times, same as always), but 2+ items
      // needs a real choice between two modes the user picks via the
      // Dashboard Filters box's "Rotate search terms" checkbox. See the
      // rotateSearchItems doc comment on Config in types.ts.
      const generalSearchMode = searchableItems.length > 1 && !config.rotateSearchItems;

      if (searchableItems.length > 1 && config.rotateSearchItems) {
        // Only the CURRENTLY ACTIVE item gets a dedicated search this
        // visit — activeSearchItemIndex/listingsSinceItemRotation are
        // instance fields that persist across locations AND cycles
        // (deliberately never reset here), so rotation runs on its own
        // clock, fully independent of location rotation. Per the user's
        // own example: 3 evaluated for "Xbox Series X" at one location,
        // then 2 more for the SAME item at the next location (still counts
        // toward the same running total, doesn't restart just because the
        // location changed) — only THEN, once the count actually hits the
        // configured threshold, does it rotate to "Nintendo Switch."
        const activeItem = searchableItems[this.activeSearchItemIndex % searchableItems.length];
        const query = getSearchQuery(activeItem);
        this.log("info", `Actively searching for "${activeItem.item}" (query: "${query}")...`);
        const searchConfig = this.opts.getConfig();
        let searchResults: ListingSummary[] = [];
        try {
          searchResults = await searchMarketplace(
            page,
            url,
            query,
            8,
            (reason, level) => this.log(level ?? "warn", reason),
            searchConfig.maxListingAgeHours,
            activeItem.minPriceUsd,
            activeItem.maxPriceUsd,
            justConfirmedLocation
          );
        } catch (err) {
          this.log("error", `Active search failed for "${activeItem.item}": ${(err as Error).message}`);
        } finally {
          justConfirmedLocation = false;
        }
        // Root-caused live from a real run: Facebook mixes a "Today's
        // picks"/recommendation section into the SAME results page once
        // genuine query matches run out, using the exact same
        // /marketplace/item/ link shape extractListingsFromCurrentPage
        // looks for — so a dedicated search's own results can end up with
        // totally unrelated listings tacked onto the end (an AirPort
        // Extreme, a storage container rental, art prints, showed up after
        // several minutes of correct Xbox Series X matches). Unlike the
        // general-browse path below, this loop never pre-filtered its own
        // searchResults before evaluating them — it fell to evaluateListing's
        // own per-listing relevance check to reject each one individually,
        // ONE AT A TIME, which still means setStatus shows every single one
        // as "currently viewing" before it gets skipped — reads exactly like
        // "it's not searching for what I asked" even though nothing was
        // ever wrongly counted as a match. Pre-filtering here, the same way
        // the general-browse path already does, keeps every genuinely
        // unrelated result out of view (and out of this loop) entirely.
        const candidateResults = searchResults.filter(
          (l) => isRelevantToSearchItems(l.title, config.searchItems) || findGreenFlagCandidate(l.title, config.searchItems) !== null
        );
        let evaluatedForItem = 0;
        for (const listing of candidateResults) {
          if (this.stopRequested || this.priorityRequested) break;
          if (locationCount > 1 && evaluatedForItem >= perLocation) break;
          const idx = candidateResults.indexOf(listing);
          this.setStatus({
            currentListing: toPreview(listing),
            currentActionNote: null,
            currentReaction: null,
            upcomingListings: candidateResults.slice(idx + 1, idx + 6).map(toPreview),
          });
          const result = await this.evaluateListing(page, listing, this.opts.getConfig());
          // Per explicit instruction, diagnosed live: "to maintain the
          // original search, it has to enter a product found under that
          // search and then go BACK to the previous page where the original
          // searched term and filters are stored." evaluateListing navigates
          // the shared page straight to the listing's own detail URL — this
          // returns to the search-results page (query + Date Listed/Price
          // Range filters intact) before the next candidate, instead of
          // leaving the page stranded on whatever detail page was last
          // visited. Only when a detail page was actually visited (see
          // visitedDetailPage's own doc comment) — an instant-skip never
          // touched the page, so there'd be nothing to go back FROM.
          if (result.visitedDetailPage) {
            await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          }
          if (result.counted) {
            evaluatedForItem++;
            totalEvaluatedHere++;
            this.setStatus({ listingsThisCycle: this.status.listingsThisCycle + 1 });
            if (result.isDeal) batchDeals.push({ title: result.title, price: result.price });
            else if (result.notable) batchSkips.push({ title: result.title, reason: result.reasoning });

            this.listingsSinceItemRotation++;
            const rotateThreshold = Math.max(1, this.opts.getConfig().rotateSearchItemsCount);
            if (this.listingsSinceItemRotation >= rotateThreshold) {
              this.listingsSinceItemRotation = 0;
              this.activeSearchItemIndex = (this.activeSearchItemIndex + 1) % searchableItems.length;
              const nextItem = searchableItems[this.activeSearchItemIndex];
              this.log(
                "info",
                `Rotating search focus after ${rotateThreshold} listing(s) for "${activeItem.item}" — searching for "${nextItem.item}" next.`
              );
              // Per explicit instruction — Dashboard's Live panel shows
              // this in-between moment too ("Moving to next product in
              // queue...").
              this.setStatus({ currentListing: null, currentActionNote: `Moving to "${nextItem.item}" next in queue...` });
              break;
            }
          }
        }
        this.log("info", `Active search for "${activeItem.item}" done — ${evaluatedForItem} listings evaluated.`);
      } else if (!generalSearchMode) {
        for (const item of searchableItems) {
          if (this.stopRequested || this.priorityRequested) break;
          const query = getSearchQuery(item);
          this.log("info", `Actively searching for "${item.item}" (query: "${query}")...`);
          const searchConfig = this.opts.getConfig();
          let searchResults;
          try {
            searchResults = await searchMarketplace(
              page,
              url,
              query,
              8,
              (reason, level) => this.log(level ?? "warn", reason),
              searchConfig.maxListingAgeHours,
              item.minPriceUsd,
              item.maxPriceUsd,
              justConfirmedLocation
            );
          } catch (err) {
            this.log("error", `Active search failed for "${item.item}": ${(err as Error).message}`);
            continue;
          } finally {
            // Only ever valid for the FIRST item searched at this location
            // (see justConfirmedLocation's own doc comment above) — every
            // item after it needs its own real navigation regardless of
            // whether this one succeeded or threw.
            justConfirmedLocation = false;
          }
          // See the rotate-mode branch's own candidateResults comment above
          // for why this pre-filter exists — same fix, same reason, applied
          // to this loop's own separate searchMarketplace call.
          const candidateResults = searchResults.filter(
            (l) => isRelevantToSearchItems(l.title, config.searchItems) || findGreenFlagCandidate(l.title, config.searchItems) !== null
          );
          let evaluatedForItem = 0;
          for (const listing of candidateResults) {
            if (this.stopRequested || this.priorityRequested) break;
            if (locationCount > 1 && evaluatedForItem >= perLocation) break;
            const idx = candidateResults.indexOf(listing);
            this.setStatus({
              currentListing: toPreview(listing),
              currentActionNote: null,
              currentReaction: null,
              upcomingListings: candidateResults.slice(idx + 1, idx + 6).map(toPreview),
            });
            const result = await this.evaluateListing(page, listing, this.opts.getConfig());
            // See the same goBack() in the rotate-mode loop above — returns
            // to the search-results page (query + filters intact) before the
            // next candidate, instead of leaving the shared page stranded on
            // whatever detail page was last visited.
            if (result.visitedDetailPage) {
              await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
            }
            if (result.counted) {
              evaluatedForItem++;
              totalEvaluatedHere++;
              this.setStatus({ listingsThisCycle: this.status.listingsThisCycle + 1 });
              if (result.isDeal) batchDeals.push({ title: result.title, price: result.price });
              else if (result.notable) batchSkips.push({ title: result.title, reason: result.reasoning });
            }
          }
          this.log("info", `Active search for "${item.item}" done — ${evaluatedForItem} listings evaluated.`);
        }
      }
      // generalSearchMode (2+ Search For items, "Rotate search terms"
      // unchecked): no dedicated per-item search at all — handled entirely
      // by the general browse below, which filters for relevance instead.

      if (this.stopRequested || this.priorityRequested) continue;

      // Per explicit instruction — "it is REQUIRED to follow the same
      // search path... it doesn't search for that product, it just starts
      // searching random things and backs out": when there's at least one
      // active Search For item and general (unverified) deal detection is
      // off, stay fully focused on the dedicated search — skip the
      // general-feed browse pass ENTIRELY here, not just relevance-filter
      // it (which still opened green-flag candidates' detail pages for
      // anything loosely sharing a word with a tracked item — exactly the
      // "random things" this was reported as). generalDeal.enabled is the
      // deliberate opt-in for "also flag other good deals you happen to
      // see" alongside a specific search; with it off, nothing outside the
      // active search ever gets a detail-page visit at this location.
      //
      // Bug fix — reported live: "I had three items searched in queue but
      // now the scanner isn't evaluating listings." Root cause: this
      // condition assumed "an active Search For item + general deal off"
      // always meant a DEDICATED search already ran above (the rotate or
      // sequential-per-item branch), but with 2+ items and "Rotate search
      // terms" unchecked (generalSearchMode — see above), NEITHER of those
      // branches runs at all; the general browse below is what's actually
      // SUPPOSED to do the searching for that mode (its own candidateListings
      // relevance-filter, right below, already existed for exactly this —
      // it was just unreachable). Without `|| generalSearchMode` here, that
      // combination fell straight to the "else if" skip-log branch further
      // down and evaluated zero listings, forever, at every location.
      const shouldGeneralBrowse = config.generalDeal.enabled || searchableItems.length === 0 || generalSearchMode;

      if (shouldGeneralBrowse) {
        try {
          const listings = await browseListings(page, url);
          this.log(
            "info",
            locationCount > 1 ? `${locationLabel} — found ${listings.length} listings` : `Browsed feed — found ${listings.length} listings`
          );
          if (listings.length === 0) {
            // Almost never means "genuinely nothing to find" — surface what
            // was actually on the page so this can be diagnosed from the
            // Dashboard instead of a silent, uninformative zero.
            const diagnosis = await diagnoseEmptyPage(page).catch((err) => `(diagnosis failed: ${err.message})`);
            this.log("warn", `Empty browse — page state was: ${diagnosis}`);
            await this.guardSession(page, "after an empty browse");
          }

          // Per explicit instruction — in generalSearchMode there's no
          // dedicated search to lean on (see above), so the general browse
          // itself has to do the filtering: only listings that already look
          // relevant to something on the Search For list (or loosely mention
          // one, like the green-flag check elsewhere in this file) are
          // "of interest" — everything else is skipped WITHOUT spending an
          // evaluation on it. If NONE of this location's listings qualify,
          // the location changes on the very next loop iteration instead of
          // grinding through a full perLocation's worth of unrelated
          // listings first — deliberately ignoring that cap as a floor,
          // only a ceiling.
          let candidateListings = listings;
          if (generalSearchMode) {
            candidateListings = listings.filter(
              (l) => isRelevantToSearchItems(l.title, config.searchItems) || findGreenFlagCandidate(l.title, config.searchItems) !== null
            );
            if (listings.length > 0 && candidateListings.length === 0) {
              this.log("info", `Nothing here matched your Search For list — moving to the next location.`);
            }
          }

          let generalEvaluated = 0;
          for (const listing of candidateListings) {
            if (this.stopRequested || this.priorityRequested) break;
            if (locationCount > 1 && generalEvaluated >= perLocation) break;
            const idx = candidateListings.indexOf(listing);
            this.setStatus({
              currentListing: toPreview(listing),
              currentActionNote: null,
              currentReaction: null,
              upcomingListings: candidateListings.slice(idx + 1, idx + 6).map(toPreview),
            });
            const result = await this.evaluateListing(page, listing, this.opts.getConfig());
            if (result.counted) {
              generalEvaluated++;
              totalEvaluatedHere++;
              this.setStatus({ listingsThisCycle: this.status.listingsThisCycle + 1 });
              if (result.isDeal) batchDeals.push({ title: result.title, price: result.price });
              else if (result.notable) batchSkips.push({ title: result.title, reason: result.reasoning });
            }
          }
        } catch (err) {
          this.log("error", `Browse failed for ${locationLabel}: ${(err as Error).message}`);
        }
      } else if (locationCount > 1) {
        this.log("info", `Staying focused on your Search For list — skipping the general feed here.`);
      }

      if (totalEvaluatedHere > 0) {
        this.opts
          .onNarrate({
            kind: "batch",
            locationLabel: locationCount > 1 ? locationLabel : "this pass",
            evaluatedCount: totalEvaluatedHere,
            deals: batchDeals,
            notableSkips: batchSkips.slice(0, 4),
          })
          .catch(() => {});
      }

      if (locationCount > 1) {
        this.log("info", `Done at ${locationLabel} (${totalEvaluatedHere} listings evaluated) — moving to the next.`);
      }
    }

    this.setStatus({
      currentSearch: null,
      lastCycleFinishedAt: Date.now(),
      currentListing: null,
      upcomingListings: [],
      currentActionNote: null,
    });

    // Not one location could even be opened (the connection is down, the browser is gone): that is a failed cycle, not a quiet one
    // that found nothing. The loop backs off and, after a few in a row, tells the user why (noteCycleFailed).
    if (!this.stopRequested && !this.priorityRequested && this.visitsAttempted > 0 && this.visitsNotOpened >= this.visitsAttempted) {
      throw new Error(this.lastNotOpenedMessage || "Could not open any Facebook Marketplace page");
    }
  }

  // Runs an immediate search for one item — triggered when the chat
  // assistant adds a Search For item on the user's direct request ("search
  // for X"), instead of only queuing it for whatever the next scan cycle
  // happens to reach (which could be minutes away, or never, if continuous
  // scanning isn't even running). Setting priorityRequested here, before
  // even entering the withPage queue, is what makes this actually jump the
  // line: a runCycle already in flight checks that flag at every location/
  // listing boundary and bails out of its OWN remaining work early, instead
  // of this call sitting behind however much of the cycle was left. There's
  // still only one tab, so it can't literally cut off a page.goto already
  // in flight mid-navigation — but it no longer has to wait for potentially
  // every remaining location in the cycle either, which is what actually
  // caused the reported failures (a chat search landing on a page that was
  // still mid-transition from whatever the cycle was doing when it finally
  // got its turn).
  async searchForItemNow(item: SearchItem): Promise<{ evaluated: number; error?: string }> {
    this.priorityRequested = true;
    return this.withPage(async () => {
      // Now that we actually have the page, clear it — from this point on
      // WE'RE the thing running, nothing left to interrupt in our favor,
      // and leaving it set would wrongly cut short the NEXT cycle too.
      this.priorityRequested = false;
      // Visible proof this is actually doing something: a chat-triggered
      // search kicked off while the continuous scanner is idle used to leave
      // every on-screen indicator (the Activity pill, which only ever reads
      // currentSearch — set here for the first time; previously only
      // runCycle touched it) looking exactly like nothing was happening,
      // even though the search itself was genuinely running. That's what a
      // "I asked it to look into something and it didn't even start
      // running" report actually was — cleared in the finally below no
      // matter how this exits, so it can never get stuck showing a search
      // that's long since finished (or failed before even reaching here).
      this.setStatus({ currentSearch: `chat search: "${item.item}"` });
      try {
        const config = this.opts.getConfig();
        const page = await this.ensureBrowser();

        if (this.status.loggedIn !== true) {
          const loggedIn = await isLoggedIn(page);
          this.setStatus({ loggedIn });
          if (!loggedIn) {
            this.log("error", `Chat asked to search for "${item.item}", but you're not logged into Facebook yet.`);
            return { evaluated: 0, error: "Not logged into Facebook." };
          }
        }
        if (!config.browseUrls.length) {
          this.log("error", `Chat asked to search for "${item.item}", but no browse location is configured.`);
          return { evaluated: 0, error: "No browse location configured." };
        }

        const query = getSearchQuery(item);
        // One location coming back empty doesn't mean the item isn't out
        // there — it's a nationwide search by design (see browseUrls), and a
        // request the user directly asked for shouldn't just give up after
        // checking a single city. Tries up to 5 locations, starting from
        // wherever the scanner currently is, stopping as soon as one actually
        // has results to look at (or a genuine per-location failure, which
        // still moves on to the next rather than giving up entirely).
        const locationsToTry = Math.min(config.browseUrls.length, 5);
        let evaluated = 0;
        let lastError: string | undefined;
        let locationsChecked = 0;

        for (let attempt = 0; attempt < locationsToTry; attempt++) {
          if (this.stopRequested) break;
          const locIdx = (this.locationIndex + attempt) % config.browseUrls.length;
          const url = config.browseUrls[locIdx];
          const locationLabel = describeLocationUrl(url);
          locationsChecked++;
          this.locationIndex = locIdx;
          // Per explicit instruction — "make sure Live can see everything
          // the scanner sees... even when a specific product is being
          // searched": this whole chat/Dashboard-triggered one-off search
          // (searchForItemNow) never touched currentListing/
          // upcomingListings/currentActionNote at all before, unlike
          // runCycle's own search loops — Live just sat empty the entire
          // time this ran, even though it's genuinely opening real
          // listings on Facebook the same as any other search.
          this.setStatus({ locationIndex: locIdx, currentListing: null, currentActionNote: `Searching for "${item.item}"...` });
          this.log("info", `Chat-triggered search: "${item.item}" (query: "${query}") at ${locationLabel}...`);

          let results: ListingSummary[];
          try {
            results = await searchMarketplace(
              page,
              url,
              query,
              8,
              (reason, level) => this.log(level ?? "warn", reason),
              config.maxListingAgeHours,
              item.minPriceUsd,
              item.maxPriceUsd
            );
          } catch (err) {
            lastError = (err as Error).message;
            this.log("error", `Chat-triggered search failed at ${locationLabel} for "${item.item}": ${lastError} — trying another location.`);
            continue;
          }

          if (!results.length) continue;

          for (const listing of results) {
            if (this.stopRequested) break;
            const idx = results.indexOf(listing);
            this.setStatus({
              currentListing: toPreview(listing),
              currentActionNote: null,
              currentReaction: null,
              upcomingListings: results.slice(idx + 1, idx + 6).map(toPreview),
            });
            const result = await this.evaluateListing(page, listing, config);
            // Same reasoning as runCycle's active-search loops — return to
            // the search-results page (query + filters intact) before the
            // next candidate rather than leaving the page on a detail view.
            if (result.visitedDetailPage) {
              await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
            }
            if (result.counted) {
              evaluated++;
              this.setStatus({ listingsThisCycle: this.status.listingsThisCycle + 1 });
            }
          }
          break; // found real listings here — no need to keep rotating locations
        }

        if (evaluated === 0 && lastError && locationsChecked > 0) {
          this.log("info", `Chat-triggered search for "${item.item}" done — checked ${locationsChecked} location(s), all failed. Last error: ${lastError}`);
          return { evaluated: 0, error: lastError };
        }
        if (evaluated === 0) {
          this.log(
            "info",
            `Chat-triggered search for "${item.item}" done — checked ${locationsChecked} location(s), nothing matched right now. It'll keep coming up in the regular rotation too.`
          );
        } else {
          this.log("info", `Chat-triggered search for "${item.item}" done — ${evaluated} listing(s) evaluated.`);
        }
        return { evaluated };
      } finally {
        this.setStatus({
          currentSearch: null,
          currentListing: null,
          currentActionNote: null,
          currentReaction: null,
          analyzingPhotos: false,
          upcomingListings: [],
        });
      }
    });
  }

  // The active scheduler's (watchScheduler.ts) counterpart to
  // searchForItemNow above — proactively searches for ONE watch instead of
  // waiting for it to turn up passively. Can't just reuse searchForItemNow
  // itself: that method is hardwired to rotate the ACCOUNT's own
  // config.browseUrls, which is exactly what a Watch's own independent
  // location (per explicit instruction — "a Watch needs its own desired
  // location rather than blindly inheriting whatever location the Scanner
  // currently happens to be using") must NOT do.
  //
  // Deliberately does NOT check this.stopRequested anywhere in this method,
  // unlike searchForItemNow's own loop — found and fixed during
  // implementation, not part of the original spec: stopRequested only means
  // "the CONTINUOUS scan loop should stop," but stop() sets it true
  // PERMANENTLY (only start()/triggerOnce() ever reset it back to false —
  // see stop() above). Checking it here would silently turn every active
  // Watch check into a no-op for any account whose Scanner had EVER been
  // manually stopped, directly breaking "Scanner OFF + Watch ON must work."
  // discoverLocations() above already establishes this exact precedent for
  // a one-off priority action — no stopRequested checks anywhere in it either.
  async runWatchCheck(watch: Watch): Promise<{ evaluated: number; error?: string }> {
    // All three location modes are checked actively, each against Facebook
    // places the Watch resolved for itself:
    //   * a ZIP/city Watch searches that one place (radius as the user set it);
    //   * a state Watch searches the state's biggest cities (40-mile radius, the
    //     same as an account in state mode);
    //   * a whole-country Watch searches a spread of cities across the US
    //     (500-mile radius, the same as an account in country mode).
    // The places are resolved once and cached on the Watch (see
    // resolveWatchPlaces), and a state/country Watch looks at a few of them per
    // check, rotating, so one check never spends minutes on a single Watch.
    // At each place it searches for EACH of the things the Watch is waiting for,
    // runs every result through the free checks (watchFacebook.ts: seen before,
    // price, title, area) and only then opens the few that pass.
    const cityOrZip = (watch.selectedCityOrZip ?? "").trim();
    if (watch.locationMode === "city" && !cityOrZip) return { evaluated: 0, error: "No city/ZIP set for this watch." };
    if (watch.locationMode === "state" && !watch.selectedState) return { evaluated: 0, error: "No state set for this watch." };

    // The Watch overrides the scanner. If this account is in the middle of a scan,
    // asking for priority makes the scan's cycle step aside at its next checkpoint
    // and hand over the browser; the Watch takes it for the length of the check and
    // the scan picks back up straight afterwards (see wakeRequested below).
    const scannerWasRunning = this.running && !this.stopRequested;
    this.priorityRequested = true;
    if (scannerWasRunning) {
      this.log("info", `Watch "${watch.name}" is taking over this account's browser from the scanner for a moment — the scanner resumes as soon as it's done.`);
    }
    return this.withPage(async () => {
      this.priorityRequested = false;
      this.setStatus({ currentSearch: `watch: "${watch.name}"` });
      try {
        const config = this.opts.getConfig();
        const page = await this.ensureBrowser();

        if (this.status.loggedIn !== true) {
          const loggedIn = await isLoggedIn(page);
          this.setStatus({ loggedIn });
          if (!loggedIn) {
            this.log("warn", `Watch "${watch.name}": skipped active check, not logged into Facebook yet.`);
            return { evaluated: 0, error: "Not logged into Facebook." };
          }
        }

        const resolved = await this.resolveWatchPlaces(page, watch);
        if (!resolved.places.length) return { evaluated: 0, error: resolved.error ?? "Could not resolve location." };
        const places = this.nextWatchPlaces(watch.id, resolved.places, watch.terms.length);

        // Minutes -> hours, same unit searchMarketplace's own param expects;
        // falls back to the account's general freshness setting when this
        // watch has no age condition of its own.
        const maxAgeHours = watch.maxListingAgeMinutes !== null ? watch.maxListingAgeMinutes / 60 : config.maxListingAgeHours;
        this.setStatus({ currentActionNote: `Actively checking Watch "${watch.name}"...` });

        let evaluated = 0;
        let searches = 0;
        let firstError: string | undefined;
        for (let p = 0; p < places.length; p++) {
          const place = places[p];
          for (let t = 0; t < watch.terms.length; t++) {
            const term = watch.terms[t];
            if (searches > 0) await politeDelay(2500, 5000);
            searches++;
            this.log("info", `Watch "${watch.name}": searching ${place.label} for "${term.phrase}"...`);

            let results: ListingSummary[];
            try {
              results = await searchMarketplace(page, place.url, term.phrase, 8, (reason, level) => this.log(level ?? "warn", reason), maxAgeHours, watch.minPriceUsd, watch.maxPriceUsd);
            } catch (err) {
              const message = (err as Error).message;
              this.log("error", `Watch "${watch.name}": search for "${term.phrase}" at ${place.label} failed — ${message}`);
              firstError ??= message;
              continue;
            }

            // Remember the exact search that was just run, so it can be opened later.
            // The page's own address is the truest record of it; if that can't be read
            // back as a search, the same search is rebuilt from the place and term.
            const live = page.url();
            const searchUrl = /\/marketplace\//.test(live) && /[?&]query=/.test(live) ? live : buildWatchSearchUrl(place.url, term.phrase, watch.minPriceUsd, watch.maxPriceUsd);
            this.opts.store.recordWatchSearchLink(watch.id, term.phrase, place.url, place.label, searchUrl);

            let counted = 0;
            let skipped = 0;
            for (let i = 0; i < results.length; i++) {
              const listing = results[i];
              this.setStatus({
                currentListing: toPreview(listing),
                currentActionNote: null,
                currentReaction: null,
                upcomingListings: results.slice(i + 1, i + 6).map(toPreview),
              });
              const pre = await prefilterWatchListing(watch, listing, { store: this.opts.store, ignoreBlacklist: config.ignoreBlacklist, geo: { store: this.opts.store } });
              // A listing whose title is one of the things being watched for counts as seen by the
              // Watch (the "listings seen" figure on its card), whether or not it then passes.
              if (pre.ok || !pre.quiet) this.opts.store.recordWatchCandidateSeen(watch.id);
              if (!pre.ok) {
                skipped++;
                if (!pre.quiet) this.log("info", `Watch "${watch.name}": skip — ${listing.title}: ${pre.reason}`, listing.url);
                continue;
              }
              if (await this.evaluateWatchCandidate(page, watch, pre.term, listing, config)) counted++;
            }
            evaluated += counted;
            this.log("info", `Watch "${watch.name}": "${term.phrase}" at ${place.label} — ${results.length} result(s), ${counted} looked at closely, ${skipped} passed over.`);
          }
        }

        // An error only counts when nothing at all could be searched, so one
        // flaky city in a state doesn't make the scheduler retry the whole Watch early.
        return evaluated === 0 && firstError && searches > 0 ? { evaluated, error: firstError } : { evaluated };
      } finally {
        this.setStatus({
          currentSearch: null,
          currentListing: null,
          currentActionNote: null,
          currentReaction: null,
          analyzingPhotos: false,
          upcomingListings: [],
        });
        // Hand the browser back: if a scan was running here it is sitting out the
        // rest of its between-cycle wait, so wake it to start a fresh cycle now.
        if (scannerWasRunning && this.running && !this.stopRequested) this.wakeRequested = true;
      }
    });
  }

  /**
   * A listing that passed the Watch's free checks: open it, make sure it is really the
   * product (a confident AI yes), score and save it, and record the match when the
   * Watch's conditions hold. Returns true when the listing was actually looked at.
   */
  private async evaluateWatchCandidate(page: Page, watch: Watch, term: WatchTerm, listing: ListingSummary, config: EngineConfig): Promise<boolean> {
    let detail: ListingDetail;
    try {
      detail = await this.loadListingDetail(page, listing);
    } catch (err) {
      this.log("warn", `Watch "${watch.name}": couldn't open "${listing.title}" (${(err as Error).message}) — will look again next time.`, listing.url);
      this.opts.store.unmarkWatchSeen(watch.id, listing.id);
      return false;
    }

    // Facebook's own "Date listed" filter (applied in the search) is best-effort, so the age is checked here too, once the page
    // is open: the Watch's own window, else the account's general one. Past the general window it only continues if the Watch's
    // own window covers it, and then only as this Watch's match, never as an ordinary deal.
    const ageGate = decideAgeGate(detail.listingAge, config.maxListingAgeHours, [watch]);
    if (ageGate.skip) {
      this.log("info", `Watch "${watch.name}": skip (too old — ${detail.listingAge}): ${listing.title}`, listing.url);
      this.opts.store.saveScored({
        listing: detail,
        extraction: { matchedItem: null, extractedAttributes: "", conditionImpact: "unknown", confidence: "low", reasoning: `Skipped — listed ${detail.listingAge}, older than your freshness window.` },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      });
      const staleRecord = this.opts.store.getLastSavedListing();
      if (staleRecord) this.opts.onListing(staleRecord);
      return true;
    }

    const scamReason = detectScamBot(`${detail.title} ${detail.description}`, detail.seller);
    if (scamReason) {
      this.log("info", `Watch "${watch.name}": skip — ${listing.title}: ${scamReason}`, listing.url);
      return true;
    }

    const sellerRisk = evaluateSellerRisk(detail.seller, config.sellerRisk);
    if (!sellerRisk.passed) {
      this.log("info", `Watch "${watch.name}": skip — ${listing.title}: seller risk (${sellerRisk.reasons.join("; ")})`, listing.url);
      return true;
    }

    // "High-confidence items only": a confident AI yes that it is the product itself.
    const verdict = await verifyWatchProduct(term.phrase, { id: listing.id, title: detail.title, description: detail.description, price: detail.price });
    if (verdict.unavailable) {
      // The check couldn't run (no key, timeout). The strict title match already held,
      // so it carries on rather than the Watch going silent whenever the API is down.
      this.log("warn", `Watch "${watch.name}": couldn't double-check "${listing.title}" (${verdict.reason}) — going on the title match alone.`, listing.url);
    } else if (!isConfidentMatch(verdict)) {
      this.log("info", `Watch "${watch.name}": skip — ${listing.title}: not confident it's "${term.phrase}" (${verdict.confidence}${verdict.match ? "" : ", no"}: ${verdict.reason})`, listing.url);
      return true;
    }

    let scored: ScoredListing;
    try {
      scored = await scoreListing(detail, config, this.opts.store.getDismissedCategories(), this.opts.store.getFeedbackExamples(), (item, title) => this.opts.store.getEbayValueForProductName(item, title), (title) => this.opts.store.getEbayValueForTitle(title));
    } catch (err) {
      this.log("error", `Scoring failed for "${listing.title}": ${(err as Error).message}`, listing.url);
      this.opts.store.unmarkWatchSeen(watch.id, listing.id);
      return false;
    }
    if (ageGate.watchOnly) scored = this.demoteForAge(scored, detail.listingAge);
    // The listing is judged by the Deal Quality Gate like any other (a Watch match no longer counts as a deal unless it passes).
    let qualification = await qualifyScoredListing({
      scored,
      source: this.opts.store,
      settings: resaleSettingsFrom(config),
      maxAgeHours: config.maxListingAgeHours,
      check: this.opts.checkMarket,
      refreshMarket: scored.isDeal,
      log: (m) => this.log("info", m, listing.url),
    });
    scored = qualification.scored;
    this.opts.store.saveScored(scored, sellerRisk);
    const record = this.opts.store.getLastSavedListing();
    if (record) this.opts.onListing(record);
    const watched = await this.recordWatchMatchesIfAny([watch], scored, config, "active", term, qualification);
    if (watched) qualification = watched;
    // A qualified deal found by an active Watch check is announced once (combined with the Watch match when there is one).
    if (qualification.verdict.qualified) await this.pushQualifiedDeal(qualification, config, listing as ListingSummary & { price: number });
    else if (qualification.verdict.status === "worth_a_look") await this.noteWorthALook(qualification, config, listing as ListingSummary & { price: number });
    return true;
  }

  // How many of a state/country Watch's places one check looks at.
  private static readonly WATCH_PLACES_PER_CHECK = 3;
  // A state Watch rotates through the state's 10 biggest cities (a few per check), same as a scanner account in state mode.
  private static readonly WATCH_STATE_CITY_COUNT = 10;
  private static readonly WATCH_STATE_RADIUS_MILES = 40;
  private static readonly WATCH_COUNTRY_CITY_COUNT = 8;
  private static readonly WATCH_COUNTRY_RADIUS_MILES = 500;
  // Where each state/country Watch's rotation is up to (in memory only: after
  // a restart it just starts again from the first place).
  private watchPlaceCursor = new Map<string, number>();

  // The most searches (terms x places) one check runs, so a Watch with many terms
  // looks at fewer places per check rather than keeping the browser for ages.
  private static readonly WATCH_MAX_SEARCHES_PER_CHECK = 12;

  /** The next few places in this Watch's rotation (all of them, for a single-place Watch). */
  private nextWatchPlaces(watchId: string, places: Array<{ url: string; label: string }>, termCount: number): Array<{ url: string; label: string }> {
    const affordable = Math.max(1, Math.floor(ScrapeEngine.WATCH_MAX_SEARCHES_PER_CHECK / Math.max(1, termCount)));
    const take = Math.min(places.length, ScrapeEngine.WATCH_PLACES_PER_CHECK, affordable);
    const start = (this.watchPlaceCursor.get(watchId) ?? 0) % places.length;
    this.watchPlaceCursor.set(watchId, start + take);
    return Array.from({ length: take }, (_, i) => places[(start + i) % places.length]);
  }

  /**
   * Works out which Facebook Marketplace places a Watch should search, resolving
   * them through Facebook's own location dialog the first time (the same
   * mechanism accounts use) and caching them on the Watch after that.
   */
  private async resolveWatchPlaces(page: Page, watch: Watch): Promise<{ places: Array<{ url: string; label: string }>; error?: string }> {
    if (watch.locationMode === "city") {
      const cityOrZip = (watch.selectedCityOrZip ?? "").trim();
      // Resolved once, cached — never re-driven on a routine check (see
      // types.ts's Watch.resolvedLocationUrl doc comment). store.
      // updateWatch already nulls this cache out on a genuine location
      // edit, so "not cached" here means either a brand-new watch or an
      // edit since the last successful resolution — both correctly
      // trigger exactly one fresh resolve.
      if (watch.resolvedLocationUrl) return { places: [{ url: watch.resolvedLocationUrl, label: watch.resolvedLocationLabel ?? cityOrZip }] };
      this.log("info", `Watch "${watch.name}": resolving location "${cityOrZip}"...`);
      const result = await discoverLocation(page, cityOrZip, watch.searchRadiusMiles ?? ScrapeEngine.DEFAULT_WATCH_RADIUS_MILES);
      if (!result.url) {
        this.log("warn", `Watch "${watch.name}": couldn't resolve "${cityOrZip}" (${result.error ?? "no matching suggestion"}) — will retry on the next scheduled check.`);
        return { places: [], error: result.error ?? "Could not resolve location." };
      }
      this.opts.store.setWatchResolvedLocation(watch.id, { url: result.url, label: result.resolvedLocationLabel, checkedAt: Date.now() });
      return { places: [{ url: result.url, label: result.resolvedLocationLabel ?? cityOrZip }] };
    }

    const scope = watch.locationMode === "state" ? (watch.selectedState ?? "") : "the whole country";
    if (watch.resolvedLocationUrls.length) {
      return { places: watch.resolvedLocationUrls.map((url) => ({ url, label: placeLabelFromUrl(url, scope) })) };
    }

    let cities: string[];
    let radius: number;
    if (watch.locationMode === "state") {
      try {
        cities = await lookupTopCitiesInState(watch.selectedState ?? "", ScrapeEngine.WATCH_STATE_CITY_COUNT);
      } catch (err) {
        const message = `Couldn't look up cities for ${watch.selectedState}: ${(err as Error).message}`;
        this.log("warn", `Watch "${watch.name}": ${message} — will retry on the next scheduled check.`);
        return { places: [], error: message };
      }
      radius = ScrapeEngine.WATCH_STATE_RADIUS_MILES;
    } else {
      // Evenly spaced through the nationwide list (it runs state by state, so
      // this lands on cities all across the country) rather than the first few.
      const all = DEFAULT_COUNTRY_CITIES;
      const count = Math.min(ScrapeEngine.WATCH_COUNTRY_CITY_COUNT, all.length);
      cities = Array.from({ length: count }, (_, i) => all[Math.floor((i * all.length) / count)]);
      radius = ScrapeEngine.WATCH_COUNTRY_RADIUS_MILES;
    }

    this.log("info", `Watch "${watch.name}": resolving ${cities.length} places for ${scope} (one-time)...`);
    const results = await discoverLocationsViaBrowser(
      page,
      cities,
      (r) => {
        if (!r.url) this.log("warn", `Watch "${watch.name}": couldn't resolve ${r.city}: ${r.error}`);
      },
      radius
    );
    const urls = results.flatMap((r) => (r.url ? [r.url] : []));
    if (!urls.length) {
      return { places: [], error: `Couldn't resolve any of ${cities.length} places for ${scope} on Facebook Marketplace.` };
    }
    // Only remembered when most of them resolved; a poor result is used for this
    // check but tried again properly next time, instead of being stuck with a
    // couple of places for good.
    if (urls.length * 2 >= cities.length) {
      this.opts.store.setWatchResolvedLocations(watch.id, { urls, label: scope, checkedAt: Date.now() });
    } else {
      this.log("warn", `Watch "${watch.name}": only ${urls.length}/${cities.length} places resolved — searching those now and retrying the rest on the next check.`);
    }
    this.log("info", `Watch "${watch.name}": ${urls.length}/${cities.length} places ready for ${scope}.`);
    return { places: urls.map((url) => ({ url, label: placeLabelFromUrl(url, scope) })) };
  }

  /** The account is starting but not scanning yet (it is resolving its location): show it as running, and let Stop cancel it. */
  beginStarting(note: string): void {
    if (this.running) return;
    this.starting = true;
    this.running = true;
    this.stopRequested = false;
    this.setStatus({ running: true, currentActionNote: note });
  }

  /** The location lookup failed or was cancelled: back to stopped. */
  cancelStarting(): void {
    if (!this.starting) return;
    this.starting = false;
    this.running = false;
    this.setStatus({ running: false, currentActionNote: null });
  }

  /** Stop was clicked since beginStarting() (so the caller must not go on to start scanning). */
  get stopWasRequested(): boolean {
    return this.stopRequested;
  }

  start(): void {
    if (this.running && !this.starting) return;
    this.starting = false;
    this.running = true;
    this.stopRequested = false;
    this.setStatus({ currentActionNote: null });
    this.scanSetupDone = false;
    this.setStatus({ running: true });
    // Fresh scan, fresh watchcount allowance — see watchCountOncePerScan.
    this.ebayResearchedProductIds.clear();
    if (this.powerSaveBlockerId === null || !powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
      this.powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    }
    // Launching the browser/logging in can take several seconds before the
    // first real cycle log line — without this, clicking "Start Scanner"
    // left Activity showing nothing at all for that whole stretch, reading
    // as if the button hadn't done anything even though status.running had
    // already flipped. This fires the instant Start is clicked, so the two
    // are never out of sync.
    this.log("info", "Scanner started.");
    this.loopPromise = this.loop();
  }

  // Public entry point for a single manual pass (e.g. a "Run once" button).
  // Resets any leftover stop flag from a previous stop() call, which
  // runOnce() itself doesn't do since it's also reused internally by the
  // continuous loop, where that reset would race against loop()'s own
  // stop check.
  /** Ends the wait between passes early (the Dashboard's "Skip wait"). Does nothing when the scanner isn't sleeping. */
  skipWait(): void {
    if (this.status.sleepingUntil) this.wakeRequested = true;
  }

  async triggerOnce(): Promise<void> {
    this.stopRequested = false;
    this.scanSetupDone = false;
    await this.runOnce();
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      let cycleFailed = false;
      try {
        await this.runOnce();
        this.noteCycleSucceeded();
      } catch (err) {
        cycleFailed = true;
        this.setStatus({ lastError: (err as Error).message });
        this.log("error", `Cycle failed: ${(err as Error).message}`);
        this.noteCycleFailed((err as Error).message);
      }
      if (this.stopRequested) break;
      // The wait between passes (Config > "Wait between passes"; 0 = none). While it lasts the Dashboard's Live panel says so
      // and counts down (status.sleepingUntil), and its "Skip wait" button ends it early (skipWait()).
      const config = this.opts.getConfig();
      const lowMin = Math.max(0, config.pollIntervalMinutesMin);
      const highMin = Math.max(lowMin, config.pollIntervalMinutesMax);
      let waitMin = lowMin + Math.random() * (highMin - lowMin);
      // A cycle that failed is retried after a growing pause (30 s, 1, 2, 4 ... 10 min), even when "Wait between passes" is 0:
      // retrying a broken browser or a dead connection in a tight loop helps nothing and can get an account flagged.
      if (cycleFailed) waitMin = Math.max(waitMin, failureBackoffMs(this.consecutiveFailures) / 60_000);
      if (waitMin > 0) {
        this.log("info", `${cycleFailed ? "Cycle failed" : "Cycle done"}. ${cycleFailed ? "Trying again" : "Sleeping"} in ~${waitMin.toFixed(1)} min.`);
        // A wake request from a Watch that finished DURING the cycle just ended is
        // stale (the cycle already ran after it); only one arriving mid-wait counts.
        this.wakeRequested = false;
        this.setStatus({
          sleepingUntil: Date.now() + waitMin * 60_000,
          currentListing: null,
          currentActionNote: null,
          currentReaction: null,
          analyzingPhotos: false,
          upcomingListings: [],
        });
        await this.sleep(waitMin * 60_000, waitMin * 60_000, true);
        this.setStatus({ sleepingUntil: null });
        this.wakeRequested = false;
      }
    }
    this.running = false;
    this.setStatus({ running: false, currentSearch: null, sleepingUntil: null });
  }

  // Stops the loop AND actually closes the browser window this engine
  // opened — a stopped scanner leaving Chrome sitting open and idle isn't
  // really "stopped." The persistent profile directory on disk isn't
  // touched, so your Facebook login session carries over to the next
  // window that opens when scanning starts again.
  //
  // Verified live miss: this used to await loopPromise BEFORE closing the
  // context, and loopPromise can't resolve until whatever's currently
  // queued on the shared page (withPage/pageQueue) finishes — including a
  // chat- or Database-tile-triggered searchForItemNow, where a single
  // listing evaluation involves an AI call with its own 45-90s timeout,
  // times however many listings/locations it's mid-way through. From the
  // Dashboard, that meant clicking Stop while a background search was
  // running could leave the button showing "Stopping..." (and Start
  // disabled right along with it, since both share the same busy flag) for
  // however long that unrelated search took to unwind — reported live as
  // "the start and stop buttons quit working right" right after the
  // Database search-icon feature made it easy to kick off exactly that
  // kind of background search while already scanning.
  //
  // Fixed by reordering: close the context FIRST, which makes any in-flight
  // Playwright call (page.goto, waitForSelector, ...) fail fast — the
  // loop's and searchForItemNow's own try/catch blocks already handle that
  // gracefully — instead of waiting for it to finish gracefully on its own
  // schedule. loopPromise is still awaited afterward so status/logging
  // settle properly, but capped with a timeout: an in-flight AI fetch()
  // isn't affected by the browser closing, so this guarantees Stop can
  // never hang indefinitely on one regardless of what edge case doesn't
  // unwind as expected.
  async stop(): Promise<void> {
    // Same reasoning as the log line in start() above — Activity should
    // show something the instant Stop is clicked, not only once the browser
    // has actually finished closing (up to a few seconds later).
    this.log("info", "Stopping scanner...");
    this.starting = false;
    this.stopRequested = true;
    this.closingIntentionally = true;
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }
    this.closingIntentionally = false;
    if (this.loopPromise) {
      await Promise.race([this.loopPromise, new Promise((resolve) => setTimeout(resolve, 8000))]);
    }
    this.running = false;
    this.setStatus({ running: false, loggedIn: null, currentSearch: null });
    if (this.powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      this.powerSaveBlockerId = null;
    }
    this.log("info", "Scanner stopped.");
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }
}
