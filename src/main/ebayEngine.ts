// eBay Browse API scanning loop — same "find lowball listings" premise as
// ScrapeEngine, but modeled on watchScheduler.ts instead: a single
// lightweight poller (no Playwright, no per-account browser/login), since
// the Browse API is plain application-level REST, not a per-user Facebook
// session. evaluateListing/runPostScoringPipeline in scrapeEngine.ts are
// deliberately never called from here — this builds its own much shorter
// pipeline (search -> detail -> normalize -> score -> save -> notify)
// reusing the same scoreListing/saveScored/sendDealAlert/Watch-matching
// primitives every Facebook listing already goes through, just without any
// of scrapeEngine.ts's Facebook-only heuristics (radius/location checks,
// shipping-program detection, thumbnail classification, photo analysis —
// none of those apply to a structured API response the way they do to a
// scraped page).
import { getEbayItemDetail, hasEbayCredentials, searchEbayItems } from "./ebayClient.js";
import { normalizeEbayListing } from "./ebayNormalize.js";
import { evaluateSellerRisk } from "./sellerRisk.js";
import { matchSearchItem, scoreListing } from "./scorer.js";
import { sendDealAlert, sendWatchMatchAlert } from "./notify.js";
import { estimateListingAgeHours, isListingTooOld } from "./listingAge.js";
import { deriveWatchReferencePrice, evaluateWatchConditions, passesWatchPriceGate, watchAsSearchItem } from "./watchMatching.js";
import type { Account, Config, EngineConfig, ListingDetail, ListingPreview, ListingRecord, LogLine, ScoredListing, ScrapeStatus, SearchItem, Watch } from "./types.js";
import type { Store } from "./store.js";
import type { NarrationContext } from "./chat.js";

// eBay's own Browse API quota (5,000 calls/day) is generous relative to how
// many tracked items/watches a real install has — one target searched per
// tick, round-robin, keeps this comfortably under that regardless of list
// size (even 20 targets still only cost ~3 calls/minute at this cadence).
// Longer than watchScheduler.ts's 45s poll on purpose: eBay listings don't
// go stale nearly as fast as a live Facebook feed does, and there's no
// "Scanner off = zero coverage" urgency driving this one the way there is
// for Watch's active checks.
const SEARCH_INTERVAL_MS = 90_000;
// The timer itself ticks much faster than actual searches happen — it's
// cheap (no network until a search is actually due), and it's what lets the
// FIRST search fire within seconds of a Search For item/Watch being added
// (or eBay being toggled on) instead of leaving the user staring at an idle
// Live tile for up to a full SEARCH_INTERVAL_MS.
const POLL_INTERVAL_MS = 15_000;

// No real Facebook account backs an eBay-sourced listing — this stands in
// for one everywhere EngineConfig (Omit<Config,"accounts"> & Account)
// requires Account fields, since scoreListing/evaluateSellerRisk never
// actually read any of them (verified: scorer.ts has zero references to
// locationMode/selectedState/browseUrls/searchRadiusMiles). "country" +
// empty browseUrls keeps this inert rather than accidentally meaningful.
const EBAY_PSEUDO_ACCOUNT: Account = {
  id: "ebay",
  label: "eBay",
  enabled: true,
  browseUrls: [],
  locationMode: "country",
  selectedState: null,
  selectedCityOrZip: null,
  searchRadiusMiles: 0,
  locationResolved: true,
};

export interface EbayEngineOptions {
  store: Store;
  getConfig: () => Config;
  onLog: (line: LogLine) => void;
  onListing: (record: ListingRecord) => void;
  onNarrate: (ctx: NarrationContext) => Promise<void>;
  onWatchMatch: (watch: Watch, info: { listingId: string }) => void;
  // Per explicit instruction — "a live view of eBay searching just like the
  // Facebook live scraper": reuses the EXACT SAME ScrapeStatus shape
  // Dashboard's LiveAccountTile already renders for every Facebook account,
  // so index.ts can drop eBay straight into the same engineStatusMap/
  // engine:statusMap broadcast as one more entry (keyed "ebay") — no new
  // renderer component needed, same live "currently viewing"/"up next"
  // treatment for free. Fields this engine has no equivalent for
  // (locationIndex, analyzingPhotos, currentReaction, loggedIn) are just
  // left at inert defaults; LiveAccountTile already tolerates that.
  onStatus: (status: ScrapeStatus) => void;
}

function idleEbayStatus(): ScrapeStatus {
  return {
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
}

function toPreview(id: string, title: string, price: number | null, thumbnailUrl: string | null, url: string): ListingPreview {
  return { id, title, price, thumbnailUrl, url };
}

export class EbayEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Same overlap guard as WatchScheduler — a slow eBay round-trip (search +
  // one detail call per new item) should never let a second tick start
  // concurrently and double up on the same quota.
  private busy = false;
  private cursor = 0;
  // Live bug found: a user turning eBay on with an empty Search For list and
  // no enabled Watches saw literally nothing happen — no error, no log line,
  // nothing in Activity — since buildTargets() legitimately has nothing to
  // search eBay with yet (unlike Facebook's own "browse everything" mode,
  // eBay's Browse API is pure keyword search; there's no generic-browse
  // equivalent to fall back to). Logged once per transition into that empty
  // state (not every 90s tick) so it's visible without spamming Activity —
  // reset back to false the moment there's something to search again.
  private loggedIdleState = false;
  private lastSearchAt = 0;
  private status: ScrapeStatus = idleEbayStatus();

  constructor(private opts: EbayEngineOptions) {}

  private pushStatus(patch: Partial<ScrapeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.status);
  }

  start(): void {
    if (this.timer) return;
    // Pushed immediately (not left to wait for the first 90s tick) so
    // Dashboard's Live panel shows an eBay tile right away on login instead
    // of a blank gap until the first real search happens.
    this.pushStatus(idleEbayStatus());
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`eBay scan error: ${(err as Error).message}`, "error"));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private log(message: string, level: LogLine["level"] = "info", listingUrl?: string): void {
    this.opts.onLog({ ts: Date.now(), level, message, listingUrl, accountId: "ebay", accountLabel: "eBay" });
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const config = this.opts.getConfig();
    if (!config.ebay?.enabled) {
      if (this.status.running) this.pushStatus({ running: false, currentActionNote: null });
      return;
    }
    // Credentials can be absent/invalid (not yet set up, or revoked) —
    // checked every tick rather than cached, so adding them to .env takes
    // effect on the very next tick without a restart, same responsiveness
    // posture as every other config read in this app.
    if (!hasEbayCredentials()) {
      if (!this.loggedIdleState) {
        this.log('eBay search is on, but EBAY_CLIENT_ID/EBAY_CLIENT_SECRET aren\'t set in .env yet — nothing will happen until they are (see .env.example).', "warn");
        this.loggedIdleState = true;
      }
      if (this.status.running) this.pushStatus({ running: false, currentActionNote: null });
      return;
    }

    const targets = this.buildTargets(config);
    if (!targets.length) {
      if (!this.loggedIdleState) {
        this.log('eBay search is on, but there\'s nothing to search for yet — add at least one Search For item or enabled Watch (eBay searches by keyword, it has no "browse everything" mode the way Facebook does).', "warn");
        this.loggedIdleState = true;
      }
      if (this.status.running) this.pushStatus({ running: false, currentActionNote: null });
      return;
    }
    this.loggedIdleState = false;

    if (Date.now() - this.lastSearchAt < SEARCH_INTERVAL_MS) return;
    this.lastSearchAt = Date.now();

    this.cursor = this.cursor % targets.length;
    const target = targets[this.cursor];
    this.cursor++;

    this.busy = true;
    this.pushStatus({
      running: true,
      lastCycleStartedAt: Date.now(),
      currentSearch: target.item,
      currentActionNote: `Searching eBay for "${target.item}"...`,
      currentListing: null,
    });
    try {
      await this.searchTarget(target, config);
    } finally {
      this.busy = false;
      this.pushStatus({ lastCycleFinishedAt: Date.now(), currentActionNote: null });
    }
  }

  // Per explicit instruction (Config.ebay's own doc comment) — "searched
  // automatically for every Search For item and enabled Watch," mirroring
  // exactly what already drives Facebook's own passive matching (see
  // scrapeEngine.ts's evaluateListing, which checks both the same way).
  private buildTargets(config: Config): SearchItem[] {
    const watches = config.watch.globallyPaused ? [] : this.opts.store.listWatches().filter((w) => w.enabled);
    return [...config.searchItems, ...watches.map(watchAsSearchItem)];
  }

  private async searchTarget(target: SearchItem, config: Config): Promise<void> {
    let raws;
    try {
      raws = await searchEbayItems(target.item, { minPriceUsd: target.minPriceUsd, maxPriceUsd: target.maxPriceUsd, limit: 25 });
    } catch (err) {
      this.log(`eBay search failed for "${target.item}": ${(err as Error).message}`, "error");
      this.pushStatus({ lastError: (err as Error).message });
      return;
    }

    // Per explicit instruction — a live view of eBay searching, same as
    // Facebook's: the whole batch of raw search results becomes the "up
    // next" queue immediately (before any dedup/detail/scoring work has
    // touched a single one of them), and the loop below pulls one off the
    // front into currentListing at a time as it actually gets looked at —
    // same two-stage feel LiveAccountTile already gives Facebook listings.
    this.pushStatus({
      currentActionNote: null,
      upcomingListings: raws.map((r) => toPreview(`ebay-${r.itemId}`, r.title, r.priceValue ? Math.round(Number(r.priceValue)) : null, r.imageUrl, r.itemWebUrl)),
    });

    const engineConfig: EngineConfig = { ...config, ...EBAY_PSEUDO_ACCOUNT };
    const activeWatches = config.watch.globallyPaused ? [] : this.opts.store.listWatches().filter((w) => w.enabled);

    for (const raw of raws) {
      const id = `ebay-${raw.itemId}`;
      this.pushStatus({
        currentListing: toPreview(id, raw.title, raw.priceValue ? Math.round(Number(raw.priceValue)) : null, raw.imageUrl, raw.itemWebUrl),
        upcomingListings: this.status.upcomingListings.filter((l) => l.id !== id),
      });
      // Cheapest possible check first — skip the detail call entirely (a
      // second real API request) for anything already in the DB, same
      // dedup-before-cost ordering evaluateListing already uses.
      if (this.opts.store.hasSeenCached(id)) continue;
      if (!config.ignoreBlacklist && this.opts.store.isBlacklisted(raw.title)) continue;

      const detail = await getEbayItemDetail(raw.itemId);
      if (!detail) continue; // ended/deleted between search and detail fetch, or a transient error — getEbayItemDetail already swallows it

      const listing = normalizeEbayListing(detail);
      if (listing.price === null) continue;

      if (isListingTooOld(listing.listingAge, config.maxListingAgeHours)) {
        this.saveSkipped(listing, `Skipped — listed ${listing.listingAge}, older than your freshness window.`);
        continue;
      }

      const sellerRisk = evaluateSellerRisk(listing.seller, config.sellerRisk);
      if (!sellerRisk.passed) {
        this.saveSkipped(listing, `Excluded on seller risk: ${sellerRisk.reasons.join("; ")}`, sellerRisk.reasons);
        continue;
      }

      const dismissedCategories = this.opts.store.getDismissedCategories();
      const feedbackExamples = this.opts.store.getFeedbackExamples();
      let scored: ScoredListing;
      try {
        scored = await scoreListing(listing, engineConfig, dismissedCategories, feedbackExamples);
      } catch (err) {
        this.log(`Scoring failed for "${listing.title}": ${(err as Error).message}`, "error", listing.url);
        continue;
      }

      this.opts.store.saveScored(scored, sellerRisk);
      this.opts.store.setListingFoundBy(listing.id, "ebay", "eBay");
      const record = this.opts.store.listRecent(1, 0)[0];
      if (record) this.opts.onListing(record);

      const priceQualifiedWatches = activeWatches.filter(
        (w) => matchSearchItem(listing.title, [watchAsSearchItem(w)]) !== null && passesWatchPriceGate(w, listing.price!)
      );
      await this.recordWatchMatches(priceQualifiedWatches, scored, engineConfig);

      if (scored.isDeal) {
        const tierLabel = scored.dealTier === "search" ? "DEAL" : "POSSIBLE DEAL (unverified pricing)";
        this.log(
          `${tierLabel}: ${listing.title} — $${listing.price}${scored.discountPercent !== null ? ` (${scored.discountPercent.toFixed(0)}% under)` : ""}`,
          "deal",
          listing.url
        );
        try {
          await sendDealAlert(engineConfig, scored);
          this.opts.store.markNotified(listing.id);
        } catch (err) {
          this.log(`Notification failed: ${(err as Error).message}`, "error", listing.url);
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
      }
    }
  }

  // Mirrors scrapeEngine.ts's recordWatchMatchesIfAny exactly (same store
  // calls, same notify/markNotified pairing) — kept as its own copy rather
  // than a shared export since that one is a private ScrapeEngine method
  // tied to `this.log`'s own signature, not worth a refactor for one other
  // caller.
  private async recordWatchMatches(watches: Watch[], scored: ScoredListing, config: EngineConfig): Promise<void> {
    if (watches.length === 0 || scored.listing.price === null) return;
    const price = scored.listing.price;
    const listingAgeHours = scored.listing.listingAge ? estimateListingAgeHours(scored.listing.listingAge) : null;
    for (const watch of watches) {
      const referencePrice = deriveWatchReferencePrice(watch, this.opts.store);
      const result = evaluateWatchConditions(watch, price, referencePrice, listingAgeHours);
      if (!result.satisfied) continue;
      const match = this.opts.store.recordWatchMatch({
        watchId: watch.id,
        listingId: scored.listing.id,
        foundByAccountId: "ebay",
        foundByAccountLabel: "eBay",
        discoveryMode: "active",
        priceAtMatch: price,
        discountPercentAtMatch: result.discountPercent,
        profitUsdAtMatch: result.profitUsd,
      });
      if (!match) continue;
      this.log(`WATCH MATCH: "${watch.name}" — ${scored.listing.title} — $${price}`, "deal", scored.listing.url);
      try {
        await sendWatchMatchAlert(config, watch, scored, { discoveryMode: "active", discountPercentAtMatch: result.discountPercent, profitUsdAtMatch: result.profitUsd }, referencePrice);
        this.opts.store.markWatchMatchNotified(match.id);
      } catch (err) {
        this.log(`Watch notification failed: ${(err as Error).message}`, "error", scored.listing.url);
      }
      this.opts.onWatchMatch(watch, { listingId: scored.listing.id });
    }
  }

  // Persists a listing that's being skipped (too old / seller risk) with no
  // AI call spent — same posture as scrapeEngine.ts's own stale/seller-risk
  // save paths: still needs to land in saveScored so hasSeenCached marks it
  // seen (otherwise every future tick would re-spend a detail call on the
  // exact same listing forever) and still shows up in Feed as a skipped
  // entry rather than silently vanishing.
  private saveSkipped(listing: ListingDetail, reasoning: string, sellerRiskReasons?: string[]): void {
    this.opts.store.saveScored(
      {
        listing,
        extraction: { matchedItem: null, extractedAttributes: "", conditionImpact: "unknown", confidence: "low", reasoning },
        referencePriceUsd: null,
        discountPercent: null,
        isDeal: false,
        dealTier: null,
        estimatedValueRange: null,
        offTopicSuggestion: null,
      },
      sellerRiskReasons ? { passed: false, reasons: sellerRiskReasons } : undefined
    );
    this.opts.store.setListingFoundBy(listing.id, "ebay", "eBay");
    const record = this.opts.store.listRecent(1, 0)[0];
    if (record) this.opts.onListing(record);
  }
}
