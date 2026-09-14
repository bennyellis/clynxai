import { powerSaveBlocker } from "electron";
import type { BrowserContext, Page } from "playwright";
import { openPersistentContext, isLoggedIn, politeDelay } from "./browser.js";
import { browseListings, searchMarketplace, fetchListingDetail, diagnoseEmptyPage, verifyOrSetRadius } from "./scraper.js";
import {
  scoreListing,
  getSearchTerms,
  isRelevantToSearchItems,
  matchSearchItem,
  findGreenFlagCandidate,
  evaluateSearchItemPricing,
  detectConditionImpact,
} from "./scorer.js";
import { evaluateSellerRisk } from "./sellerRisk.js";
import { sendDealAlert } from "./notify.js";
import { analyzeListingPhotos, classifyThumbnailImage, type PhotoAnalysisResult } from "./vision.js";
import { downloadImageAsDataUri } from "./webResearch.js";
import { discoverLocations as discoverLocationsViaBrowser, type LocationDiscoveryResult } from "./locationDiscovery.js";
import { searchSoldComps, type EbayComp } from "./watchcount.js";
import { listingStateMatches } from "./usStates.js";
import { Store } from "./store.js";
import type {
  BlacklistedImage,
  BlacklistTerm,
  Config,
  DealTier,
  ExtractionResult,
  ListingDetail,
  ListingPreview,
  ListingRecord,
  ListingSummary,
  LogLine,
  ProductProfile,
  ScrapeStatus,
  SearchItem,
} from "./types.js";
import type { NarrationContext } from "./chat.js";

// $0/$1 and 4+-digit repeated-or-sequential prices ($1111, $1234, $9999)
// are a well-known Facebook Marketplace placeholder pattern — usually a
// listing with no real price set yet, or a setup for an off-platform scam
// conversation, not a genuine price. Skipped before ever visiting the
// detail page, not just scored low, since there's nothing real to
// evaluate. The 4-digit floor matters: 2-3 digit repeats ($99, $555,
// $999) are extremely common, deliberate real price points (verified via
// a quick test — $999 was a false positive before this floor was added),
// not placeholders. Ordinary round prices ($100, $250, $500) were never
// caught by this and still aren't.
export function isSuspiciousPrice(price: number): boolean {
  if (price <= 1) return true;
  const digits = String(Math.round(price));
  if (digits.length < 4) return false;
  if (/^(\d)\1+$/.test(digits)) return true; // 1111, 9999, 5555, ...
  const nums = digits.split("").map(Number);
  const ascending = nums.every((d, i) => i === 0 || d === nums[i - 1] + 1);
  const descending = nums.every((d, i) => i === 0 || d === nums[i - 1] - 1);
  return ascending || descending; // 1234, 4321, ...
}

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

// Best-effort parse of Facebook's relative "Listed X ago" phrasing (see
// scraper.ts's extractListingAge) into an approximate age in hours.
// Deliberately rough — "3 weeks ago" doesn't carry more precision than
// that anyway — and returns null for anything not recognized rather than
// guessing, since isListingTooOld treats "can't tell" as "don't skip":
// silently discarding a listing just because its exact phrasing wasn't
// recognized would be worse than occasionally evaluating a stale one.
export function estimateListingAgeHours(ageText: string): number | null {
  const text = ageText.trim().toLowerCase();
  if (/^just now$/.test(text)) return 0;
  if (/^today$/.test(text)) return 1;
  if (/^yesterday$/.test(text)) return 30; // "not today" — treated as past the 24h window
  const match = text.match(/^(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\b/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const hoursPerUnit: Record<string, number> = {
    minute: 1 / 60,
    min: 1 / 60,
    hour: 1,
    hr: 1,
    day: 24,
    week: 24 * 7,
    month: 24 * 30,
    year: 24 * 365,
  };
  return n * hoursPerUnit[match[2]];
}

// This is a fast-moving mail-order reselling operation by default — a
// listing that's been sitting for days is far less likely to still be
// available or worth the time, so anything confidently older than maxHours
// gets skipped before it ever reaches seller-risk checks or an AI call.
// Only skips when the age was actually parsed; an unrecognized/missing age
// string never skips (see estimateListingAgeHours). Per explicit
// instruction, this is now the user's own Config choice (maxListingAgeHours
// — this is what actually GUARANTEES the configured window regardless of
// whether Facebook's own "Date listed" filter click succeeded, see
// scraper.ts's applyDateListedFilter) rather than a fixed 24h assumption;
// null means no cap at all — every listing counts as fresh enough.
export function isListingTooOld(ageText: string | null, maxHours: number | null = 24): boolean {
  if (!ageText || maxHours === null) return false;
  const hours = estimateListingAgeHours(ageText);
  // >= not > : Facebook's "1 day ago" phrasing covers anywhere up to ~47h
  // (it rounds down to whole days), so treating exactly-maxHours as still
  // fresh would let some genuinely stale listings through right at the
  // boundary that matters most.
  return hours !== null && hours >= maxHours;
}

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

// Fisher-Yates — a fresh random permutation of [0..n) every call. Used to
// randomize which order locations get visited in each cycle, instead of
// the same fixed 0,1,2,...,n-1 sequence every time: a long, exhaustive
// list of URLs hit in the exact same order forever is itself a
// recognizable automation pattern, and it also means an interrupted cycle
// always favors the same early locations over ones later in the list.
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
  getConfig: () => Config;
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
  onNewProductFound: (name: string, imageDataUri: string | null, sourceListingTitle: string) => void;
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
  private async sleep(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs);
    const deadline = Date.now() + ms;
    while (!this.stopRequested) {
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
    return loggedIn;
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
          this.setStatus({ loggedIn: true });
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
  async discoverLocations(cities: string[], targetRadiusMiles?: number): Promise<LocationDiscoveryResult[]> {
    this.priorityRequested = true;
    return this.withPage(async () => {
      this.priorityRequested = false;
      const page = await this.ensureBrowser();
      const loggedIn = await isLoggedIn(page);
      this.setStatus({ loggedIn });
      if (!loggedIn) {
        this.log("error", "Not logged into Facebook. Log in from the Dashboard first.");
        return cities.map((city) => ({ city, url: null, resolvedState: null, error: "Not logged in" }));
      }

      this.log("info", `Discovering ${cities.length} location${cities.length === 1 ? "" : "s"}...`);
      const results = await discoverLocationsViaBrowser(
        page,
        cities,
        (result) => {
          if (result.url) this.log("info", `Found location for ${result.city}: ${result.url}`);
          else this.log("warn", `Could not resolve ${result.city}: ${result.error}`);
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
    hasVideo: boolean
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
    const claimedProduct = claimedItem ? this.opts.store.findMatchingProduct(claimedItem) : null;
    const claimedItemReferenceImages = claimedProduct ? this.opts.store.listProductImages(claimedProduct.id).slice(0, 2).map((img) => img.imageData) : [];
    this.log("info", `Analyzing ${imageUrls.length} photo(s) for "${title}"...`);
    const result = await analyzeListingPhotos(imageUrls, { title, description, price }, 8, {
      claimedItem,
      watchFor,
      referenceProducts,
      claimedItemReferenceImages,
      hasVideo,
    });
    if (result.error || !result.summary) {
      this.log("warn", `Photo analysis unavailable for "${title}": ${result.error ?? "no summary returned"}`);
      return result;
    }
    this.opts.store.updatePhotoAnalysis(id, result.summary);
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
  private recordInstantSkip(listing: ListingSummary, reasoning: string): ListingEvalResult {
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
    const record = this.opts.store.listRecent(1, 0)[0];
    if (record) this.opts.onListing(record);
    return NOT_COUNTED;
  }

  // Evaluates one listing end to end (detail fetch, seller risk, scoring,
  // persistence, notification, deal narration). The returned "counted"
  // flag is what drives the "switch location after N listings" counter;
  // the rest feeds the end-of-batch recap narration.
  private async evaluateListing(page: Page, listing: ListingSummary, config: Config): Promise<ListingEvalResult> {
    if (this.opts.store.hasSeen(listing.id)) return NOT_COUNTED;
    if (listing.price === null) return NOT_COUNTED;

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
          `Skipped without opening the listing — its location ("${listing.locationText}") looks like it's outside ${config.selectedState}, and you're only searching there.`
        );
      }
    }

    if (isSuspiciousPrice(listing.price)) {
      this.log("info", `skip (placeholder-looking price): ${listing.title} — $${listing.price}`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} looks like a placeholder price, not a real one.`
      );
    }

    if (isNonRoundPrice(listing.price)) {
      this.log("info", `skip (non-round price): ${listing.title} — $${listing.price}`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} doesn't end in 0 or 5, probably scam bait or unnoteworthy.`
      );
    }

    // Per explicit instruction — a global ceiling the user sets directly,
    // on top of (not instead of) the checks above. The one and only "max
    // I'll pay" signal — also reused as the deal-scoring budget ceiling for
    // a matched Search For item, see evaluateSearchItemPricing's call site
    // below. null (the default) means no cap at all.
    if (config.maxPriceUsd !== null && listing.price > config.maxPriceUsd) {
      this.log("info", `skip (over max price): ${listing.title} — $${listing.price} > $${config.maxPriceUsd} cap`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} is above your $${config.maxPriceUsd} max price.`
      );
    }

    // The floor counterpart, same posture — null means no floor.
    if (config.minPriceUsd !== null && listing.price < config.minPriceUsd) {
      this.log("info", `skip (under min price): ${listing.title} — $${listing.price} < $${config.minPriceUsd} floor`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — $${listing.price} is below your $${config.minPriceUsd} min price.`
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
        `Skipped without opening the listing — "${listing.title}" looks like a bulky/local-pickup-only category (vehicle, furniture, appliance, real estate, etc.), not something a mail-order reseller can buy.`
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
    if (blacklistMatch) {
      this.log("info", `skip (blacklisted: "${blacklistMatch}"): ${listing.title}`, listing.url);
      return this.recordInstantSkip(listing, `Skipped without opening the listing — title matches blacklisted term "${blacklistMatch}".`);
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
    const greenFlagCandidate = matchSearchItem(listing.title, config.searchItems)
      ? null
      : findGreenFlagCandidate(listing.title, config.searchItems);
    if (greenFlagCandidate) {
      this.log(
        "info",
        `green flag: "${listing.title}" mentions "${greenFlagCandidate.item}" but doesn't fully match — opening it for a closer look.`,
        listing.url
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
    if (
      !config.generalDeal.enabled &&
      config.searchItems.length > 0 &&
      !isRelevantToSearchItems(listing.title, config.searchItems) &&
      !greenFlagCandidate
    ) {
      this.log("info", `skip (not one of your focused Search For items): ${listing.title}`, listing.url);
      return this.recordInstantSkip(
        listing,
        `Skipped without opening the listing — general deal detection is off and this doesn't match anything on your Search For list.`
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
    if (config.photoAnalysis.enabled && !config.ignoreBlacklist && listing.thumbnailUrl) {
      const thumbnailDataUri = await downloadImageAsDataUri(listing.thumbnailUrl);
      if (thumbnailDataUri) {
        const referenceImages = this.opts.store
          .listBlacklistedImages()
          .slice(0, 6)
          .map((img) => ({ imageDataUri: img.imageData, category: img.category }));
        const imageCheck = await classifyThumbnailImage(thumbnailDataUri, listing.title, referenceImages);
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
      detail = await fetchListingDetail(page, listing);
    } catch (err) {
      this.log("error", `Failed to load detail for ${listing.url}: ${(err as Error).message}`, listing.url);
      return NOT_COUNTED;
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
    if (isListingTooOld(detail.listingAge, config.maxListingAgeHours)) {
      this.log("info", `skip (too old — ${detail.listingAge}): ${listing.title}`, listing.url);
      this.opts.store.saveScored({
        listing: detail,
        extraction: {
          matchedItem: null,
          extractedAttributes: "",
          conditionImpact: "unknown",
          confidence: "low",
          reasoning: `Skipped — listed ${detail.listingAge}, older than the 24-hour freshness window for this fast-moving business.`,
        },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      });
      const staleRecord = this.opts.store.listRecent(1, 0)[0];
      if (staleRecord) this.opts.onListing(staleRecord);
      await this.sleep(600, 1500); // trimmed from 1000-2500ms, see the sleep() call above
      return { ...NOT_COUNTED, counted: true, title: listing.title, price: listing.price, reasoning: `too old — ${detail.listingAge}`, notable: false };
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
      const shippingRecord = this.opts.store.listRecent(1, 0)[0];
      if (shippingRecord) this.opts.onListing(shippingRecord);
      await this.sleep(600, 1500);
      return { ...NOT_COUNTED, counted: true, title: listing.title, price: listing.price, reasoning: reason, notable: false };
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
      const record = this.opts.store.listRecent(1, 0)[0];
      if (record) this.opts.onListing(record);
      await this.sleep(900, 2400); // trimmed from 1500-4000ms, see the sleep() call above
      return {
        ...NOT_COUNTED,
        counted: true,
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
    let scored;
    try {
      scored = await scoreListing(detail, config, dismissedCategories, feedbackExamples);
    } catch (err) {
      this.log("error", `Scoring failed for "${listing.title}": ${(err as Error).message}`, listing.url);
      return { ...NOT_COUNTED, counted: true };
    }

    this.opts.store.saveScored(scored, sellerRisk);
    const record = this.opts.store.listRecent(1, 0)[0];
    if (record) this.opts.onListing(record);

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

    // Photos are the real identification mechanism now, ahead of anything
    // text-based — a listing's title/category can be vague or wrong, but
    // what's actually IN the photos isn't. Runs early and for every
    // eligible listing (any tier, deal or not), not just confirmed deals,
    // so both the bundle-value check below and the research step after it
    // can use ONE real look at the photos instead of trusting the text.
    let photoResult: PhotoAnalysisResult | null = null;
    if (config.photoAnalysis.enabled && detail.imageUrls.length > 0) {
      // A green-flag candidate (see above) takes priority over the raw
      // title as the thing to check photos against — "Xbox X" itself isn't
      // a real product to compare against, but "Xbox Series S" is, and
      // this is also what makes runPhotoAnalysis pull that item's own real
      // reference photos (if the Database has any) for the comparison.
      const claimedItem = scored.extraction.matchedItem || greenFlagCandidate?.item || listing.title;
      // Per explicit instruction — "when the AI is conducting research on
      // the product's images, have it switch to 'Researching photos...'":
      // Dashboard's Live panel swaps its "Currently viewing" label for this
      // while analyzingPhotos is true (see LivePanel in Dashboard.tsx), then
      // shows the AI's own expertTake underneath once it resolves — a
      // human, first-person reaction (see vision.ts's analyzeListingPhotos)
      // instead of the raw analytical summary, per "bring the app more to
      // life."
      this.setStatus({ analyzingPhotos: true, currentReaction: null });
      photoResult = await this.runPhotoAnalysis(
        listing.id,
        listing.title,
        detail.description,
        listing.price,
        detail.imageUrls,
        scored.extraction.matchedItem,
        claimedItem,
        detail.hasVideo
      );
      this.setStatus({ analyzingPhotos: false, currentReaction: photoResult?.expertTake ?? null });
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
    if (detail.hasVideo && photoResult?.titleMatchPhoto && detail.imageUrls[0] !== photoResult.titleMatchPhoto) {
      const titleMatchPhoto = photoResult.titleMatchPhoto;
      detail = { ...detail, imageUrls: [titleMatchPhoto, ...detail.imageUrls.filter((u) => u !== titleMatchPhoto)] };
      scored = { ...scored, listing: detail };
      this.opts.store.saveScored(scored, sellerRisk);
      const thumbFixed = this.opts.store.listRecent(1, 0)[0];
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
      const pricing = evaluateSearchItemPricing(greenFlagCandidate, listing.price, conditionImpact, config.dealThresholdPercent, config.maxPriceUsd);
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
      const updated = this.opts.store.listRecent(1, 0)[0];
      if (updated) this.opts.onListing(updated);
    }

    // Verified live miss: a listing titled/matched as "Xbox Series X" whose
    // photos actually showed only a controller got flagged as an 83%-under
    // DEAL — the discount math was comparing the listing's price against a
    // full console's reference price for something that was never a
    // console. matchesClaim === false means the vision model looked at the
    // photos against what this listing claims to be and found something
    // meaningfully different/lesser — that overrides isDeal outright,
    // regardless of how good the price looked against the wrong reference.
    if (scored.isDeal && photoResult?.matchesClaim === false) {
      this.log(
        "warn",
        `Photo/title mismatch for "${listing.title}": claimed to be the matched item but photos show ${photoResult.mismatchReason ?? "something different"} — overriding to skip.`,
        listing.url
      );
      scored = {
        ...scored,
        isDeal: false,
        dealTier: null,
        extraction: {
          ...scored.extraction,
          reasoning: `Looked like a deal on price alone, but the photos show ${photoResult.mismatchReason ?? "something different from what this listing claims to be"} — skipping rather than risk a bad match.`,
        },
      };
      this.opts.store.saveScored(scored, sellerRisk);
      const updated = this.opts.store.listRecent(1, 0)[0];
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
    if (
      photoResult?.matchesClaim !== false &&
      scored.extraction.matchedItem &&
      photoResult?.hasValuableBundle &&
      photoResult.bundleEstimatedValueUsd &&
      scored.referencePriceUsd !== null &&
      scored.referencePriceUsd > 0 &&
      listing.price !== null
    ) {
      const totalValueUsd = scored.referencePriceUsd + photoResult.bundleEstimatedValueUsd;
      const bundleDiscountPercent = ((totalValueUsd - listing.price) / totalValueUsd) * 100;
      if (bundleDiscountPercent >= config.dealThresholdPercent) {
        this.log(
          "deal",
          `Bundle value spotted in photos for "${listing.title}": ${photoResult.bundleDescription} (~$${photoResult.bundleEstimatedValueUsd} extra) — total value ~$${totalValueUsd.toFixed(0)} vs $${listing.price} asking, ${bundleDiscountPercent.toFixed(0)}% under.`,
          listing.url
        );
        scored = {
          ...scored,
          isDeal: true,
          dealTier: "search" as const,
          discountPercent: bundleDiscountPercent,
          extraction: {
            ...scored.extraction,
            reasoning: `${scored.extraction.reasoning} Also, the photos show bundled extras not mentioned in the listing text (${photoResult.bundleDescription}, worth an estimated $${photoResult.bundleEstimatedValueUsd}) — total value ~$${totalValueUsd.toFixed(0)} vs $${listing.price} asking is a ${bundleDiscountPercent.toFixed(0)}% discount.`,
          },
        };
        this.opts.store.saveScored(scored, sellerRisk);
        const updated = this.opts.store.listRecent(1, 0)[0];
        if (updated) this.opts.onListing(updated);
      }
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
          const updated = this.opts.store.listRecent(1, 0)[0];
          if (updated) this.opts.onListing(updated);
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
      const subjectImageDataUri = photoResult?.productPhotos[subject] ?? (await fallbackImage());
      const existingProduct = this.opts.store.findMatchingProduct(subject);
      if (existingProduct) {
        const noteParts = [
          listing.price !== null ? `$${listing.price}` : null,
          scored.extraction.matchedItem ? scored.extraction.extractedAttributes || null : null,
          scored.extraction.conditionImpact !== "unknown" ? `condition impact: ${scored.extraction.conditionImpact}` : null,
        ].filter((p): p is string => !!p);
        if (noteParts.length) {
          const updatedProduct = this.opts.store.recordProductObservation(subject, noteParts.join(" — "));
          if (updatedProduct) this.opts.onProductUpdated(updatedProduct);
        }
        if (subjectImageDataUri) {
          this.opts.store.addProductImage(existingProduct.id, subjectImageDataUri, listing.title);
        }
      } else if (specificSubjects.has(subject) && config.autoResearchListings) {
        this.log(
          "info",
          `New item of interest: "${subject}" isn't tracked yet — adding it to the Database.`,
          undefined,
          subject
        );
        this.opts.onNewProductFound(subject, subjectImageDataUri, listing.title);
      }
    }

    if (scored.isDeal) {
      const tierLabel = scored.dealTier === "search" ? "DEAL" : "POSSIBLE DEAL (unverified pricing)";
      this.log(
        "deal",
        `${tierLabel}: ${listing.title} — $${listing.price}${
          scored.discountPercent !== null ? ` (${scored.discountPercent.toFixed(0)}% under)` : ""
        }`,
        listing.url
      );
      try {
        await sendDealAlert(config, scored);
        this.opts.store.markNotified(listing.id);
      } catch (err) {
        this.log("error", `Notification failed: ${(err as Error).message}`, listing.url);
      }
      this.opts
        .onNarrate({
          kind: "deal",
          title: listing.title,
          price: listing.price,
          dealTier: scored.dealTier as "search" | "general",
          discountPercent: scored.discountPercent,
          estimatedValueRange: scored.estimatedValueRange,
          reasoning: scored.extraction.reasoning,
        })
        .catch(() => {});
      // photoResult already ran earlier (see above) for every eligible
      // listing regardless of deal status — nothing left to do here, this
      // used to be a second, redundant photo-analysis call just for
      // confirmed deals before that became true.
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

    await politeDelay(1500, 4000);
    return {
      counted: true,
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
        this.setStatus({ loggedIn });
        if (!loggedIn) {
          this.log("error", "Not logged into Facebook yet — a browser window should be open; log in there. This cycle will skip and retry next time.");
          return;
        }
      }

      await this.runCycle(page, config);
    });
  }

  // Best-effort, not a hard gate on scanning — navigates straight to
  // Richmond, VA and looks for "Richmond" somewhere in the page's own
  // visible text as confirmation it actually landed there (not just that
  // the navigation itself succeeded, which wouldn't catch Facebook quietly
  // substituting a different account-level location). Logs either way, so
  // a silent drift is something the user can actually see in Activity
  // instead of just wondering later why results looked off. Can't verify
  // this against a live Facebook session from here (see the note at the
  // top of scraper.ts) — if Facebook's own location indicator ever renders
  // differently than assumed, this will under- or over-report, not
  // something to treat as a guarantee.
  private async verifyStartingLocation(page: Page, richmondUrl: string): Promise<void> {
    try {
      await page.goto(richmondUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      const mainText = await page.evaluate(() => {
        const main = document.querySelector('[role="main"]') as HTMLElement | null;
        return (main ?? document.body)?.innerText ?? "";
      });
      if (/richmond/i.test(mainText)) {
        this.log("info", "📍 Start-of-cycle check: confirmed on Richmond, VA.");
      } else {
        this.log(
          "warn",
          "Start-of-cycle check: navigated to Richmond, VA but couldn't confirm it on the page — Facebook may be showing a different location (possible drift from browsing Marketplace elsewhere on this account, e.g. your phone). Continuing anyway."
        );
      }
    } catch (err) {
      this.log("warn", `Start-of-cycle Richmond check failed: ${(err as Error).message} — continuing anyway.`);
    }
  }

  // Checked once per cycle (not inside every individual search — see
  // searchMarketplace's own comment on why it deliberately doesn't reopen
  // this mid-search), against whatever config.searchRadiusMiles currently
  // is — "state" location mode sets this to 40, everything else defaults
  // to 100 (see types.ts's Config.searchRadiusMiles).
  private async verifyRadiusOnPage(page: Page, config: Config): Promise<void> {
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
  private async runCycle(page: Page, config: Config): Promise<void> {
    this.setStatus({ lastCycleStartedAt: Date.now(), lastError: null, listingsThisCycle: 0, currentSearch: "browsing" });

    // Per explicit instruction — every cycle deliberately opens at
    // Richmond, VA first and confirms it actually landed there, logged to
    // Activity either way, before any real scanning happens. Reason given:
    // the user sometimes browses Facebook Marketplace from their phone on
    // this SAME account while the scanner is running, and unlike the
    // radius setting (stored per-browser-profile — see browser.ts's own
    // note on that), Facebook's "last browsed location" appears to be
    // tracked at the account level, so a phone session elsewhere could
    // silently drift what location this automated browser actually lands
    // on even when navigating straight to a specific city's URL. Skipped
    // if a stop/priority request is already pending — same "don't do extra
    // work we're about to abandon anyway" posture as every other
    // checkpoint in this cycle.
    if (!this.stopRequested && !this.priorityRequested) {
      // Per explicit instruction — the radius check needs to run every
      // cycle regardless of location mode (see Config's "Search
      // locations" setting), but Richmond specifically is only ever part
      // of the rotation in "country" mode — "state"/"city" mode replace
      // browseUrls entirely with something that may not include it at
      // all. Reuses the SAME page load for both checks when Richmond
      // applies (no reason to navigate twice); falls back to just the
      // first configured location, purely to have a Marketplace page open
      // to check radius on, when it doesn't.
      const richmondUrl = config.browseUrls.find((u) => /\/marketplace\/richmond(?:[/?]|$)/i.test(u));
      if (richmondUrl) {
        await this.verifyStartingLocation(page, richmondUrl);
        await this.verifyRadiusOnPage(page, config);
      } else if (config.browseUrls.length > 0) {
        try {
          await page.goto(config.browseUrls[0], { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1200);
          await this.verifyRadiusOnPage(page, config);
        } catch (err) {
          this.log("warn", `Start-of-cycle radius check failed: ${(err as Error).message} — continuing anyway.`);
        }
      }
    }

    const perLocation = Math.max(1, config.listingsPerLocation);
    const locationCount = config.browseUrls.length;
    // With one location there's nothing to rotate to, so visit it once and
    // evaluate everything found (matches the original single-location
    // behavior). With more than one, visit every location exactly once per
    // cycle — bounded, predictable cycle length — but in a freshly
    // shuffled random order each cycle rather than the same fixed sequence
    // every time (see shuffledIndices), so which city gets hit first/last
    // varies and a cycle that gets interrupted partway doesn't always
    // favor the same handful of locations.
    const visitsThisCycle = locationCount <= 1 ? 1 : locationCount;
    const visitOrder = locationCount > 1 ? shuffledIndices(locationCount) : [this.locationIndex % Math.max(locationCount, 1)];

    for (let visit = 0; visit < visitsThisCycle; visit++) {
      if (this.stopRequested) break;
      if (this.priorityRequested) {
        this.log("info", "Pausing the current cycle — a chat request needs the page right now.");
        break;
      }
      this.locationIndex = visitOrder[visit];
      const url = config.browseUrls[this.locationIndex];
      const locationLabel = describeLocationUrl(url);
      // Per explicit instruction — Dashboard's Live panel shows this
      // in-between moment explicitly ("Switching locations...") instead of
      // just going blank between one listing and the next.
      this.setStatus({ locationIndex: this.locationIndex, currentListing: null, currentActionNote: locationCount > 1 ? "Switching locations..." : null });

      // The alert itself — fires the moment the scanner moves to a new
      // location, not folded into the "found N listings" line after the
      // fact, so it's clearly its own event in Activity.
      if (locationCount > 1) {
        this.log("info", `📍 Switched to location ${visit + 1}/${visitsThisCycle}: ${locationLabel}`);
      }

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
        const query = getSearchTerms(activeItem)[0];
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
            searchConfig.minPriceUsd,
            searchConfig.maxPriceUsd
          );
        } catch (err) {
          this.log("error", `Active search failed for "${activeItem.item}": ${(err as Error).message}`);
        }
        let evaluatedForItem = 0;
        for (const listing of searchResults) {
          if (this.stopRequested || this.priorityRequested) break;
          if (locationCount > 1 && evaluatedForItem >= perLocation) break;
          const idx = searchResults.indexOf(listing);
          this.setStatus({
            currentListing: toPreview(listing),
            currentActionNote: null,
            currentReaction: null,
            upcomingListings: searchResults.slice(idx + 1, idx + 6).map(toPreview),
          });
          const result = await this.evaluateListing(page, listing, this.opts.getConfig());
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
          const query = getSearchTerms(item)[0];
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
              searchConfig.minPriceUsd,
              searchConfig.maxPriceUsd
            );
          } catch (err) {
            this.log("error", `Active search failed for "${item.item}": ${(err as Error).message}`);
            continue;
          }
          let evaluatedForItem = 0;
          for (const listing of searchResults) {
            if (this.stopRequested || this.priorityRequested) break;
            if (locationCount > 1 && evaluatedForItem >= perLocation) break;
            const idx = searchResults.indexOf(listing);
            this.setStatus({
              currentListing: toPreview(listing),
              currentActionNote: null,
              currentReaction: null,
              upcomingListings: searchResults.slice(idx + 1, idx + 6).map(toPreview),
            });
            const result = await this.evaluateListing(page, listing, this.opts.getConfig());
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

      let listings;
      try {
        listings = await browseListings(page, url);
      } catch (err) {
        this.log("error", `Browse failed for ${locationLabel}: ${(err as Error).message}`);
        continue;
      }
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
      }

      // Per explicit instruction — in generalSearchMode there's no
      // dedicated search to lean on (see above), so the general browse
      // itself has to do the filtering: only listings that already look
      // relevant to something on the Search For list (or loosely mention
      // one, like the green-flag check elsewhere in this file) are
      // "of interest" — everything else is skipped WITHOUT spending an
      // evaluation on it. If NONE of this location's listings qualify, the
      // location changes on the very next loop iteration instead of
      // grinding through a full perLocation's worth of unrelated listings
      // first — deliberately ignoring that cap as a floor, only a ceiling.
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

        const query = getSearchTerms(item)[0] ?? item.item;
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
              config.minPriceUsd,
              config.maxPriceUsd
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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
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
  async triggerOnce(): Promise<void> {
    this.stopRequested = false;
    await this.runOnce();
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.runOnce();
      } catch (err) {
        this.setStatus({ lastError: (err as Error).message });
        this.log("error", `Cycle failed: ${(err as Error).message}`);
      }
      if (this.stopRequested) break;
      const config = this.opts.getConfig();
      const waitMin =
        config.pollIntervalMinutesMin +
        Math.random() * (config.pollIntervalMinutesMax - config.pollIntervalMinutesMin);
      this.log("info", `Cycle done. Sleeping ~${waitMin.toFixed(1)} min.`);
      await this.sleep(waitMin * 60_000, waitMin * 60_000);
    }
    this.running = false;
    this.setStatus({ running: false, currentSearch: null });
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
