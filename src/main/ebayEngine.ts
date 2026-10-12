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
import { EbayProductFilter, summarizeDropped } from "./ebayProductFilter.js";
import { sendDealAlert, sendWatchMatchAlert, sendWorthALookAlert } from "./notify.js";
import { buildQualifiedAlert, qualifyScoredListing, type MarketChecker, type Qualification } from "./preAlert.js";
import { isSuspiciousPrice, placeholderPriceReason } from "./placeholderPrice.js";
import { estimateListingAgeHours, isListingTooOld } from "./listingAge.js";
import { deriveWatchReferencePrice, evaluateWatchConditions, passesWatchPriceGate, passesWatchSellerRating, watchAsSearchItem } from "./watchMatching.js";
import { resaleSettingsFrom } from "./resaleMath.js";
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
  // Looks the product up on WatchCount and eBay (and files what it finds in the Database) before an alert goes out; see preAlert.ts.
  checkMarket?: MarketChecker;
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
  // Listings whose scoring threw (OpenAI down, a timeout...) are NOT saved —
  // so without this, the very next tick would see them as brand new and
  // spend another eBay detail call and another AI call on each one, over and
  // over for as long as the outage lasts. They're parked for a while instead.
  private scoringFailedAt = new Map<string, number>();
  private static readonly SCORING_RETRY_AFTER_MS = 20 * 60_000;
  // Per explicit instruction — a search for a product should only surface that
  // product, not every game/controller/SSD/part that mentions it. See
  // ebayProductFilter.ts. Listings it drops are never saved (so they never
  // reach the Feed); this remembers which ones were already reported in the
  // Activity log so the same lines aren't repeated every 90s search.
  private productFilter = new EbayProductFilter();
  private reportedDrops = new Set<string>();
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
  // automatically for every Search For item and enabled Watch". Only Watches
  // that were created for eBay: a Facebook Watch is the Facebook scanner's
  // job (scrapeEngine.ts / watchScheduler.ts), and an eBay Watch is only ever
  // searched here.
  private buildTargets(config: Config): SearchItem[] {
    return [...config.searchItems, ...this.activeEbayWatches(config).map(watchAsSearchItem)];
  }

  private activeEbayWatches(config: Config): Watch[] {
    if (config.watch.globallyPaused) return [];
    return this.opts.store.listWatches().filter((w) => w.enabled && w.platform === "ebay");
  }

  private async searchTarget(target: SearchItem, config: Config): Promise<void> {
    let raws;
    try {
      // 50, not 25: roughly half of a keyword search's results are typically
      // games/accessories/parts that the product filter below throws away, so
      // asking for more keeps a full set of real candidates (still one API call).
      raws = await searchEbayItems(target.item, { minPriceUsd: target.minPriceUsd, maxPriceUsd: target.maxPriceUsd, limit: 50 });
    } catch (err) {
      this.log(`eBay search failed for "${target.item}": ${(err as Error).message}`, "error");
      this.pushStatus({ lastError: (err as Error).message });
      return;
    }

    // An eBay Watch with a minimum seller rating: drop sellers below it right
    // away, before spending the product-filter's AI call on listings that
    // could never match. (A Search For item has no such requirement.)
    if (target.minSellerRatingPercent != null) {
      const min = target.minSellerRatingPercent;
      const lowRated = raws.filter((r) => !passesWatchSellerRating(min, r.sellerFeedbackPercentage));
      if (lowRated.length) {
        raws = raws.filter((r) => passesWatchSellerRating(min, r.sellerFeedbackPercentage));
        // Same once-per-listing reporting as the product filter's drops below,
        // so the same low-rated listing isn't announced on every 90s search.
        const fresh = lowRated.filter((r) => !this.reportedDrops.has(r.itemId));
        if (fresh.length) {
          for (const r of fresh) this.reportedDrops.add(r.itemId);
          this.log(`eBay "${target.item}": left out ${fresh.length} result${fresh.length === 1 ? "" : "s"} from sellers rated under ${min}%`);
        }
      }
    }

    // Only the product itself goes any further — everything else (games,
    // controllers, storage, parts, other models) is dropped here, before it
    // can show up in the live queue or be saved.
    try {
      const { kept, dropped } = await this.productFilter.filter(target, raws, (itemId) => this.opts.store.hasSeenCached(`ebay-${itemId}`));
      const fresh = dropped.filter((d) => d.reason !== "unverified" && !this.reportedDrops.has(d.raw.itemId));
      if (fresh.length) {
        for (const d of fresh) this.reportedDrops.add(d.raw.itemId);
        if (this.reportedDrops.size > 5000) this.reportedDrops.clear();
        this.log(`eBay "${target.item}": left out ${fresh.length} result${fresh.length === 1 ? "" : "s"} that aren't the product itself — ${summarizeDropped(fresh)}`);
      }
      raws = kept;
    } catch (err) {
      this.log(`eBay product filter failed for "${target.item}": ${(err as Error).message}`, "error");
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
    const activeWatches = this.activeEbayWatches(config);

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
      const failedAt = this.scoringFailedAt.get(id);
      if (failedAt !== undefined && Date.now() - failedAt < EbayEngine.SCORING_RETRY_AFTER_MS) continue;
      if (!config.ignoreBlacklist && this.opts.store.isBlacklisted(raw.title)) continue;
      // $0, $1, $1234...: not a price anyone can flip from (see placeholderPrice.ts). Skipped before the second API call, and
      // mentioned in the log once per item rather than on every pass.
      const rawPrice = Number(raw.priceValue);
      if (raw.priceValue !== null && isSuspiciousPrice(rawPrice)) {
        if (!this.reportedDrops.has(raw.itemId)) {
          this.reportedDrops.add(raw.itemId);
          this.log(`skip: "${raw.title}": ${placeholderPriceReason(rawPrice)}`, "info", raw.itemWebUrl);
        }
        continue;
      }

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
        scored = await scoreListing(listing, engineConfig, dismissedCategories, feedbackExamples, (item, title) => this.opts.store.getEbayValueForProductName(item, title), (title) => this.opts.store.getEbayValueForTitle(title));
      } catch (err) {
        this.log(`Scoring failed for "${listing.title}": ${(err as Error).message}`, "error", listing.url);
        this.scoringFailedAt.set(id, Date.now());
        continue;
      }
      this.scoringFailedAt.delete(id);

      this.opts.store.saveScored(scored, sellerRisk);
      this.opts.store.setListingFoundBy(listing.id, "ebay", "eBay");
      const record = this.opts.store.getById(listing.id);
      if (record) this.opts.onListing(record);

      const priceQualifiedWatches = activeWatches.filter(
        (w) =>
          matchSearchItem(listing.title, [watchAsSearchItem(w)]) !== null &&
          passesWatchPriceGate(w, listing.price!) &&
          passesWatchSellerRating(w.minSellerRatingPercent, listing.seller.ebayFeedbackPercentage)
      );

      // The Deal Quality Gate decides what this listing is (age, resale evidence validated against a fresh market check for anything
      // that may be pushed, margin, negotiation); isDeal means "qualified" and the verdict is saved so every screen agrees.
      let qualification: Qualification | null = null;
      if (scored.isDeal || priceQualifiedWatches.length > 0) {
        qualification = await qualifyScoredListing({
          scored,
          source: this.opts.store,
          settings: resaleSettingsFrom(engineConfig),
          maxAgeHours: config.maxListingAgeHours,
          check: this.opts.checkMarket,
          refreshMarket: scored.isDeal,
          log: (m) => this.log(m, "info", listing.url),
        });
        scored = qualification.scored;
        this.opts.store.saveScored(scored, sellerRisk);
        this.opts.store.setListingFoundBy(listing.id, "ebay", "eBay");
        const finalRecord = this.opts.store.getById(listing.id);
        if (finalRecord) this.opts.onListing(finalRecord);
      }
      const watched = await this.recordWatchMatches(priceQualifiedWatches, scored, engineConfig, qualification ?? undefined);
      if (watched) {
        qualification = watched;
        scored = watched.scored;
      }

      if (qualification?.verdict.qualified) {
        await this.pushQualifiedDeal(qualification, engineConfig, listing as ListingDetail & { price: number });
      } else if (qualification?.verdict.status === "worth_a_look") {
        await this.noteWorthALook(qualification, engineConfig, listing as ListingDetail & { price: number });
      }
    }
  }

  // A qualified deal: logged, pushed once (never again if a Watch match already told the user), and narrated.
  private async pushQualifiedDeal(q: Qualification, config: EngineConfig, listing: ListingDetail & { price: number }): Promise<void> {
    const { scored, verdict } = q;
    const tag = verdict.status === "negotiation" ? "NEGOTIATION OPPORTUNITY" : verdict.confidence === "low" ? "DEAL (limited sales data)" : "DEAL";
    this.log(
      `${tag}: ${listing.title} — $${listing.price}${verdict.status === "negotiation" && verdict.facts.requiredDiscountPercent !== null ? ` (needs ${verdict.facts.requiredDiscountPercent}% off: offer ~$${verdict.facts.targetPriceUsd})` : scored.discountPercent !== null ? ` (${scored.discountPercent.toFixed(0)}% under)` : ""}`,
      "deal",
      listing.url
    );
    try {
      if (this.opts.store.isListingNotified(listing.id)) {
        this.log(`Already notified about "${listing.title}" (as a Watch match): not sending a second alert.`, "info", listing.url);
      } else {
        const summary = buildQualifiedAlert({ q, source: this.opts.store, settings: resaleSettingsFrom(config), kind: "deal" });
        await sendDealAlert(config, scored, summary);
        this.opts.store.markNotified(listing.id);
      }
    } catch (err) {
      this.log(`Notification failed: ${(err as Error).message}`, "error", listing.url);
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
  private async noteWorthALook(q: Qualification, config: EngineConfig, listing: ListingDetail & { price: number }): Promise<void> {
    this.log(`Worth a look: ${listing.title} — ${q.verdict.headline}`, "info", listing.url);
    if (!config.notifyWorthALook || this.opts.store.isListingNotified(listing.id)) return;
    try {
      const summary = buildQualifiedAlert({ q, source: this.opts.store, settings: resaleSettingsFrom(config), kind: "look" });
      await sendWorthALookAlert(config, q.scored, { ...summary, message: q.verdict.headline });
      this.opts.store.markNotified(listing.id);
    } catch (err) {
      this.log(`Notification failed: ${(err as Error).message}`, "error", listing.url);
    }
  }

  // Mirrors scrapeEngine.ts's recordWatchMatchesIfAny exactly (same store
  // calls, same notify/markNotified pairing) — kept as its own copy rather
  // than a shared export since that one is a private ScrapeEngine method
  // tied to `this.log`'s own signature, not worth a refactor for one other
  // caller.
  private async recordWatchMatches(watches: Watch[], scored: ScoredListing, config: EngineConfig, qualification?: Qualification): Promise<Qualification | null> {
    let current: Qualification | null = qualification ?? null;
    if (watches.length === 0 || scored.listing.price === null) return current;
    const price = scored.listing.price;
    const listingAgeHours = scored.listing.listingAge ? estimateListingAgeHours(scored.listing.listingAge) : null;
    for (const watch of watches) {
      const referencePrice = deriveWatchReferencePrice(watch, this.opts.store);
      const result = evaluateWatchConditions(watch, price, referencePrice, listingAgeHours, {
        netPercent: resaleSettingsFrom(config).netPercent,
        shippingUsd: scored.listing.ebayShippingUsd ?? 0,
        defaultMaxAgeHours: config.maxListingAgeHours,
      });
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
        const settings = resaleSettingsFrom(config);
        // The verdict this alert reports: the final one when the caller has it, else worked out now with a fresh market check. A Watch
        // match is always delivered, but it says plainly whether it is also a qualified deal.
        if (!current || (!current.market && current.verdict.status !== "pass")) {
          current = await qualifyScoredListing({
            scored: current ? current.scored : scored,
            source: this.opts.store,
            settings,
            maxAgeHours: config.maxListingAgeHours,
            check: this.opts.checkMarket,
            refreshMarket: true,
            log: (m) => this.log(m, "info", scored.listing.url),
          });
          this.opts.store.saveScored(current.scored);
          this.opts.store.setListingFoundBy(scored.listing.id, "ebay", "eBay");
          const savedRecord = this.opts.store.getById(scored.listing.id);
          if (savedRecord) this.opts.onListing(savedRecord);
        }
        if (current.verdict.reasons.some((r) => r.code === "PLACEHOLDER_PRICE")) {
          this.log(`Skipped the alert for "${scored.listing.title}": $${price} looks like a placeholder price.`, "info", scored.listing.url);
        } else {
          const summary = buildQualifiedAlert({ q: current, source: this.opts.store, settings, kind: "watch", watchName: watch.name });
          // A Watch with its own ntfy topic (a friend's) reaches someone else, so the main topic's deal alert never replaces it.
          const ownTopic = !!watch.ntfyTopic?.trim() && watch.ntfyTopic.trim() !== config.ntfy.topic;
          if (!ownTopic && this.opts.store.isListingNotified(scored.listing.id)) {
            this.log(`Watch "${watch.name}": "${scored.listing.title}" was already notified as a deal: not sending a second alert.`, "info", scored.listing.url);
          } else {
            await sendWatchMatchAlert(
              config,
              watch,
              current.scored,
              { discoveryMode: "active", discountPercentAtMatch: result.discountPercent, profitUsdAtMatch: result.profitUsd },
              referencePrice,
              summary,
              current.verdict.qualified
            );
            if (!ownTopic) this.opts.store.markNotified(scored.listing.id);
          }
        }
        this.opts.store.markWatchMatchNotified(match.id);
      } catch (err) {
        this.log(`Watch notification failed: ${(err as Error).message}`, "error", scored.listing.url);
      }
      this.opts.onWatchMatch(watch, { listingId: scored.listing.id });
    }
    return current;
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
    const record = this.opts.store.getById(listing.id);
    if (record) this.opts.onListing(record);
  }
}
