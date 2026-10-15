// Beta 12, Change 6: the listing's own text feeds the checks, general discovery is not silenced, bounded re-evaluation, saved listings re-judged when evidence arrives,
// a dismissal validated against real numbers, honest lifecycle counts. Offline: fake store, fake network, no browser. Historical replay needs the owner's database
// (scripts/discovery-audit.cjs); nothing here is claimed as live validation.
import { feedCandidates } from "../feedCandidates.js";
import { lifecycleOf, countLifecycle } from "../listingLifecycle.js";
import { reevaluationReason, requalifyEligible, scoredFromRecord, currentAgeText, REEVAL_COOLDOWN_MS, type SavedListingState } from "../relisting.js";
import { detailTextFields } from "../listingText.js";
import { estimateListingAgeHours } from "../listingAge.js";
import { shouldValidateDismissal } from "../research.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, ntfy, resetNetwork, searchItem, setAiReply, summary } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

const REAL_XBOX_PAGE = `Xbox series X
$200
Listed about an hour ago in Bronson, MI
Message
Details
Condition
Used - like new
I bought a gaming pc awhile ago so I haven't used it, everything works I just turned it on, price is firm.
Seller information
Joined Facebook in 2025
Related searches
series s
Send seller a message
Today's picks
$300
Sony PlayStation 5 as is for parts/ 300 obo
Fredericksburg, VA
$550
PlayStation 5 with two wireless controllers and games bundle 4 new games
Richmond, VA`;

const now = Date.now();
const saved = (over: Partial<SavedListingState> = {}): SavedListingState => ({ price: 300, researchStatus: "confirmed_unprofitable", researchCode: "UNPROFITABLE_AT_PRICE", isDeal: false, notified: false, firstSeenAt: now - 2 * 3_600_000, reevalCount: 0, lastReevalAt: null, ...over });
const opts = { maxAgeHours: 24 as number | null, generalDealOn: true };

run(async () => {
  installFetchStub();
  resetNetwork();

  section("general discovery stays ON next to several Search For items (the feed is not silently narrowed)");
  {
    const feed = [{ title: "Apple iPhone 16 Pro 128 GB" }, { title: "Xbox series X 1TB" }, { title: "Lot of 9 DS Game Cartridges" }, { title: "Nintendo Switch console with dock" }];
    const items = [searchItem("Xbox Series X", 500), searchItem("Nintendo Switch", 150)];
    const on = feedCandidates(feed, items, true);
    check("general ON: every card stays a candidate", on.candidates.length === 4, on.candidates);
    check("general ON: the Search For look-alikes come first", on.candidates[0].title === "Xbox series X 1TB" && on.candidates[1].title === "Nintendo Switch console with dock" && on.focused === 2, on.candidates.map((c) => c.title));
    const off = feedCandidates(feed, items, false);
    check("general OFF: only the Search For look-alikes (exactly the old behavior)", off.candidates.length === 2 && off.candidates.every((c) => /xbox|switch/i.test(c.title)), off.candidates);
    const none = feedCandidates(feed, [], true);
    check("no Search For items: the whole feed, unchanged order", none.candidates.map((c) => c.title).join("|") === feed.map((c) => c.title).join("|"));
  }

  section("the real Xbox page: the old reading discounted it to a loss, the listing's own text lets it be the deal it is");
  {
    const config = baseConfig({ searchItems: [searchItem("Xbox Series X", 501)], generalDeal: { enabled: true, minConfidence: "medium" } });
    const run1 = async (description: string, textProvenance: any, id: string) => {
      const h = makeEngine({ config });
      h.engine.detailToLoad = detail("Xbox series X", 200, { description, listingAge: "about an hour ago", textProvenance, declaredCondition: "Used - like new" });
      const r = await (h.engine as any).evaluateListing(FAKE_PAGE, { ...summary("Xbox series X", 200, id) }, h.config);
      return { r, saved: h.store.saved };
    };
    const old = await run1(REAL_XBOX_PAGE.slice(0, 4000), undefined, "x-old"); // the whole page as the description (Beta 11 behavior)
    const oldFinal = old.saved[old.saved.length - 1];
    const f = detailTextFields(REAL_XBOX_PAGE);
    const fresh = await run1(f.description, f.textProvenance, "x-new");
    const freshFinal = fresh.saved[fresh.saved.length - 1];
    check("before: another seller's 'as is for parts' card made it 'major' damage", oldFinal.extraction.conditionImpact === "major", oldFinal.extraction);
    check("after: no damage found in the seller's own text", freshFinal.extraction.conditionImpact === "none", freshFinal.extraction);
    check("after: $200 against a $501 reference now clears the margin as a deal; before it did not", freshFinal.isDeal === true && oldFinal.isDeal === false, { fresh: freshFinal.isDeal, old: oldFinal.isDeal });
  }

  section("bounded re-evaluation of an already-seen listing");
  {
    check("same price, judged unprofitable: stays a duplicate", reevaluationReason(saved(), 300, now, opts) === null);
    check("price fell 10% ($30): looked at again", reevaluationReason(saved(), 270, now, opts) === "price_drop");
    check("a 2% change is not a drop", reevaluationReason(saved(), 295, now, opts) === null);
    check("a $3 change on a cheap item is not a drop", reevaluationReason(saved({ price: 40 }), 37, now, opts) === null);
    check("not within the 30-minute cooldown", reevaluationReason(saved({ firstSeenAt: now - 10 * 60_000 }), 200, now, opts) === null);
    check("cooldown counts from the last re-look", reevaluationReason(saved({ lastReevalAt: now - REEVAL_COOLDOWN_MS / 2 }), 200, now, opts) === null);
    check("at most twice in all", reevaluationReason(saved({ reevalCount: 2 }), 200, now, opts) === null);
    check("a listing already alerted on is never reopened", reevaluationReason(saved({ notified: true }), 200, now, opts) === null);
    check("nor one that is already a deal", reevaluationReason(saved({ isDeal: true }), 200, now, opts) === null);
    check("nor one past the freshness window", reevaluationReason(saved({ firstSeenAt: now - 30 * 3_600_000 }), 200, now, opts) === null);
    check("TOO_OLD / shipping / scam / seller-risk-type rejections are never reopened", ["TOO_OLD", "SCAM_BOT", "OFFICIAL_SHIPPING", "MENTIONS_EBAY", "UNSHIPPABLE"].every((c) => reevaluationReason(saved({ researchStatus: "rejected", researchCode: c }), 100, now, opts) === null));
    check("a saved listing with no outcome at all is looked at once", reevaluationReason(saved({ researchStatus: null, researchCode: null }), 300, now, opts) === "no_outcome");
    check("research that could not finish (interrupted) is retried", reevaluationReason(saved({ researchStatus: "insufficient_evidence", researchCode: "INTERRUPTED" }), 300, now, opts) === "evidence_missing");
    check("a photo-look allowance that ran out is retried", reevaluationReason(saved({ researchStatus: "unresearched", researchCode: "LOOK_BUDGET" }), 300, now, opts) === "evidence_missing");
    check("NOT_FOCUSED is reopened only when general detection is now on", reevaluationReason(saved({ researchStatus: "unresearched", researchCode: "NOT_FOCUSED" }), 300, now, opts) === "now_in_focus" && reevaluationReason(saved({ researchStatus: "unresearched", researchCode: "NOT_FOCUSED" }), 300, now, { ...opts, generalDealOn: false }) === null);

    // through the real engine: the dedupe still wins unless there is a reason
    const store = makeStore({ hasSeenCached: () => true, getListingState: () => saved({ price: 300 }) });
    const h = makeEngine({ store, config: baseConfig({ searchItems: [searchItem("Xbox Series S", 300)] }) });
    h.engine.detailToLoad = detail("Xbox Series S", 250, { id: "dupe", listingAge: "2 hours ago" } as any);
    const same = await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Xbox Series S", 300, "dupe"), h.config);
    check("engine: an unchanged duplicate is still a duplicate", !same.counted && same.outcome === "already_seen", same);
    const dropped = await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Xbox Series S", 250, "dupe"), h.config);
    check("engine: the same listing at a lower price is evaluated again, updating the SAME record", dropped.counted === true && store.saved.every((s) => s.listing.id === "dupe") && h.logs.some((l) => /Looking again at/.test(l.message) && /asking price came down/.test(l.message)), h.logs.map((l) => l.message));
    let noted = 0;
    const store2 = makeStore({ hasSeenCached: () => true, getListingState: () => saved({ price: 300 }), noteReevaluation: () => void noted++ });
    const h2 = makeEngine({ store: store2, config: baseConfig({ searchItems: [searchItem("Xbox Series S", 300)] }) });
    h2.engine.detailToLoad = detail("Xbox Series S", 250, { id: "dupe" } as any);
    for (let i = 0; i < 6; i++) await (h2.engine as any).evaluateListing(FAKE_PAGE, summary("Xbox Series S", 250, `d${i}`), h2.config);
    check("engine: no more than 3 re-looks per location visit", noted === 3, noted);
  }

  section("a saved 'worth a look' listing is judged again when evidence arrives (late research settlement)");
  {
    const record: any = {
      id: "L9", title: "Xbox Series X 1TB", price: 250, url: "https://example.com/L9", thumbnailUrl: null, imageUrls: [], description: "works", locationText: "Dover, DE", listingAge: "1 hour ago",
      matchedItem: "Xbox Series X", referencePriceUsd: null, discountPercent: null, conditionImpact: "none", confidence: "medium", reasoning: "AI guess", extractedAttributes: "game console", shippingMentioned: false,
      isDeal: false, dealTier: null, estimatedValueRange: null, notified: false, firstSeenAt: Date.now() - 20 * 60_000, source: "facebook", sellerName: null, sellerJoinedYear: null, sellerRating: null, sellerRatingCount: null,
      sellerHasProfilePhoto: null, shippingCostUsd: null, researchStatus: "insufficient_evidence", researchCode: "AI_UNVERIFIED",
    };
    check("eligible: insufficient evidence, matched item, price, not alerted", requalifyEligible(record));
    check("not eligible once it is a deal / alerted / has no matched item / is a real rejection", !requalifyEligible({ ...record, isDeal: true }) && !requalifyEligible({ ...record, notified: true }) && !requalifyEligible({ ...record, matchedItem: null }) && !requalifyEligible({ ...record, researchStatus: "rejected", researchCode: "TOO_OLD" }));
    const age = currentAgeText("1 hour ago", record.firstSeenAt, Date.now(), estimateListingAgeHours);
    check("the saved age moves on with the clock", age !== null && (estimateListingAgeHours(age) ?? 99) < 3, age);
    check("an age that was never understood is never re-gated", currentAgeText(null, record.firstSeenAt, Date.now(), estimateListingAgeHours) === null && currentAgeText("sometime", 0, Date.now(), estimateListingAgeHours) === null);
    check("the record becomes a scored listing the gate can judge", scoredFromRecord(record, "1 hour ago").extraction.matchedItem === "Xbox Series X" && scoredFromRecord(record, "1 hour ago").isDeal === true);

    // numbers arrive (the late check filed a Database value): the gate now sees evidence
    let current = record;
    const signals = { id: "p1", name: "Xbox Series X", valueUsd: 501, runTimeDays: 3, compSample: 9, checkedAt: Date.now() - 60_000, basis: "sold" };
    let have = false;
    const store = makeStore({
      getById: () => current,
      getProductSignals: () => (have ? signals : null),
      saveScored: (s: any) => { current = { ...current, researchStatus: s.research.status, researchCode: s.research.code, isDeal: s.isDeal }; store.saved.push(s); },
    });
    const h = makeEngine({ store, config: baseConfig({ ntfy: { server: "https://ntfy.sh", topic: "t" } }) });
    ntfy.length = 0;
    const none = await h.engine.requalifyListing("L9", "test");
    check("no numbers yet: left exactly as it was, nothing saved or sent", none === "unchanged" && store.saved.length === 0 && ntfy.length === 0, none);
    have = true;
    const got = await h.engine.requalifyListing("L9", "the late price check finished");
    check("numbers arrive: the listing that asked for them now qualifies and is saved as a deal", got === "qualified" && store.saved.length === 1 && store.saved[0].isDeal === true, { got, saved: store.saved.length });
    check("exactly one alert", ntfy.length === 1, ntfy.length);
    store.notifiedListings.add("L9");
    current = { ...current, notified: true };
    const again = await h.engine.requalifyListing("L9", "repeat callback");
    check("a repeated callback does nothing (no second alert)", again === "skipped" && ntfy.length === 1, again);

    // numbers arrive but the price is not good: settled as unprofitable on real numbers, not left 'uncertain' for ever
    current = { ...record, price: 480, isDeal: false, notified: false, researchStatus: "insufficient_evidence", researchCode: "AI_UNVERIFIED" };
    store.saved.length = 0;
    const bad = await h.engine.requalifyListing("L9", "test");
    check("numbers say it is not worth it: settled as unprofitable (verified), no alert", bad === "unprofitable" && store.saved[0]?.research?.status === "confirmed_unprofitable" && ntfy.length === 1, { bad, r: store.saved[0]?.research });
    // a stale one
    current = { ...record, firstSeenAt: Date.now() - 40 * 3_600_000, listingAge: "20 hours ago" };
    check("a listing that has since aged past the window is never re-gated", (await h.engine.requalifyListing("L9", "x")) === "skipped");
  }

  section("a 'not a deal' from the AI alone is checked against real numbers, within the market-look allowance");
  {
    const base = { price: 400, title: "Vintage Leica M6 camera body", matchedItem: null, isDeal: false, judgeUnavailable: false, offTopic: false, lookLeftVisit: 2, lookLeftPass: 12, hasChecker: true };
    check("a specific product at a worthwhile price is checked", shouldValidateDismissal(base));
    check("not when the title says nothing about the product", !shouldValidateDismissal({ ...base, title: "Gaming console works great" }));
    check("not below the price floor, not off-topic, not when the AI was unavailable", !shouldValidateDismissal({ ...base, price: 40 }) && !shouldValidateDismissal({ ...base, offTopic: true }) && !shouldValidateDismissal({ ...base, judgeUnavailable: true }));
    check("not when the allowance is spent (visit or pass) or no checker exists", !shouldValidateDismissal({ ...base, lookLeftVisit: 0 }) && !shouldValidateDismissal({ ...base, lookLeftPass: 0 }) && !shouldValidateDismissal({ ...base, hasChecker: false }));
    check("not when a product was already matched or it is already a deal", !shouldValidateDismissal({ ...base, matchedItem: "x" }) && !shouldValidateDismissal({ ...base, isDeal: true }));

    // through the engine: the AI says no; the real numbers say yes
    setAiReply({ isPotentialDeal: false, category: "film camera", estimatedValueRangeUsd: "300-400", confidence: "medium", conditionImpact: "none", reasoning: "Typical used price.", offTopicSuggestion: null });
    let checks = 0;
    const signals = { id: "p2", name: "Leica M6", valueUsd: 1200, runTimeDays: 5, compSample: 8, checkedAt: Date.now(), basis: "sold" };
    let filed = false;
    const store = makeStore({ getProductSignals: () => (filed ? signals : null) });
    const h = makeEngine({
      store,
      config: baseConfig({ generalDeal: { enabled: true, minConfidence: "medium" } }),
      checkMarket: async () => {
        checks++;
        filed = true;
        return { productId: "p2", productName: "Leica M6", valueUsd: 1200, refreshed: true, note: "checked" };
      },
    });
    h.engine.detailToLoad = detail("Vintage Leica M6 camera body", 450, { listingAge: "1 hour ago" });
    ntfy.length = 0;
    await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Vintage Leica M6 camera body", 450, "leica"), h.config);
    const final = store.saved[store.saved.length - 1];
    check("the AI's 'no' was checked once against real prices", checks === 1);
    check("real numbers ($1,200) beat the AI's guess ($300-400): it is a deal, with the numbers behind it", final.isDeal === true && final.gate?.status === "profitable_now" && final.referencePriceUsd === 1200, { isDeal: final.isDeal, gate: final.gate?.status, ref: final.referencePriceUsd });
    check("one alert", ntfy.length === 1, ntfy.length);

    // the check finds nothing: stays exactly as the AI left it
    const h2 = makeEngine({ store: makeStore(), config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" } }), checkMarket: async () => null });
    h2.engine.detailToLoad = detail("Vintage Leica M6 camera body", 450, { listingAge: "1 hour ago", imageUrls: ["https://example.com/a.jpg"] });
    await (h2.engine as any).evaluateListing(FAKE_PAGE, summary("Vintage Leica M6 camera body", 450, "leica2"), h2.config);
    const f2 = h2.store.saved[h2.store.saved.length - 1];
    check("no numbers found: not a deal, not 'confirmed' anything, labelled provisional", f2.isDeal === false && f2.research?.code === "AI_ESTIMATE" && /Provisionally/.test(f2.research?.reason ?? ""), f2.research);
    // the allowance is shared and bounded
    let n = 0;
    const h3 = makeEngine({ store: makeStore(), config: baseConfig({ generalDeal: { enabled: true, minConfidence: "medium" } }), checkMarket: async () => { n++; return null; } });
    for (let i = 0; i < 6; i++) {
      h3.engine.detailToLoad = detail(`Vintage Leica M6 camera body ${i}`, 450, { listingAge: "1 hour ago" });
      await (h3.engine as any).evaluateListing(FAKE_PAGE, summary(`Vintage Leica M6 camera body ${i}`, 450, `lb${i}`), h3.config);
    }
    check("at most the per-visit allowance (2) of extra market lookups, however many listings are dismissed", n === 2, n);
    setAiReply({});
    resetNetwork();
  }

  section("seller risk stays a rejection, and says what the numbers would have been");
  {
    const store = makeStore({ getEbayValueForTitle: () => ({ name: "Xbox Series X", value: 501 }) });
    const config = baseConfig({ sellerRisk: { enabled: true, minAccountAgeYears: 1, minRating: null, minRatingCount: null, maxRatingCount: null, requireProfilePhoto: true } });
    const h = makeEngine({ store, config });
    h.engine.detailToLoad = detail("Xbox Series X", 200, { listingAge: "1 hour ago", seller: { joinedFacebookYear: 2026, rating: null, ratingCount: null, hasProfilePhoto: false, name: "x" } });
    ntfy.length = 0;
    await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Xbox Series X", 200, "risky"), h.config);
    const s = store.saved[store.saved.length - 1];
    check("rejected for seller risk, not a deal, no alert", s.research?.code === "SELLER_RISK" && s.isDeal === false && ntfy.length === 0, s.research);
    check("the reason says it would otherwise clear the margin on the Database's numbers", /only the seller checks holding it back/.test(s.research?.reason ?? ""), s.research?.reason);
  }

  section("honest lifecycle counts: every saved listing is in exactly one stage");
  {
    check("a deal", lifecycleOf("researched", "DEAL", true, true) === "profitable");
    check("skipped from the card", lifecycleOf("unresearched", "NOT_FOCUSED", false, false) === "prefiltered" && lifecycleOf("rejected", "UNSHIPPABLE", false, false) === "prefiltered");
    check("opened, then ruled out by a rule", lifecycleOf("rejected", "TOO_OLD", false, true) === "postfiltered" && lifecycleOf("rejected", "OFFICIAL_SHIPPING", false, true) === "postfiltered");
    check("judged on numbers", lifecycleOf("confirmed_unprofitable", "UNPROFITABLE_AT_PRICE", false, true) === "unprofitable");
    check("missing evidence is uncertain, an AI estimate is uncertain", lifecycleOf("insufficient_evidence", "AI_UNVERIFIED", false, true) === "uncertain" && lifecycleOf("rejected", "AI_ESTIMATE", false, true) === "uncertain");
    check("failed and pending and deferred", lifecycleOf("insufficient_evidence", "INTERRUPTED", false, true) === "failed" && lifecycleOf("unresearched", "PHOTOS_QUEUED", false, true) === "pending" && lifecycleOf("unresearched", "LOOK_BUDGET", false, true) === "deferred");
    check("an old row with no outcome is deferred (and re-looked at once)", lifecycleOf(null, null, false, true) === "deferred");
    // the owner's real 329-listing breakdown (scripts/discovery-audit.cjs output): the stages must add up to the saved total
    const rows = [
      { status: "rejected", code: "TOO_OLD", n: 127, opened: true }, { status: "confirmed_unprofitable", code: "UNPROFITABLE_AT_PRICE", n: 55, opened: true }, { status: "unresearched", code: "NOT_FOCUSED", n: 35, opened: false },
      { status: null, code: null, n: 32, opened: true }, { status: "rejected", code: "OFFICIAL_SHIPPING", n: 26, opened: true }, { status: "rejected", code: "AI_ESTIMATE", n: 14, opened: true },
      { status: "rejected", code: "UNSHIPPABLE", n: 14, opened: false }, { status: "rejected", code: "MENTIONS_EBAY", n: 7, opened: true }, { status: "insufficient_evidence", code: "AI_UNVERIFIED", n: 6, opened: true },
      { status: "rejected", code: "SELLER_RISK", n: 5, opened: true }, { status: "rejected", code: "UNDER_MIN_PRICE", n: 4, opened: false }, { status: "insufficient_evidence", code: "INTERRUPTED", n: 1, opened: true },
      { status: "researched", code: "DEAL", n: 1, opened: true }, { status: "insufficient_evidence", code: "WEAK_EVIDENCE", n: 1, opened: true }, { status: "rejected", code: "PHOTOS_MISMATCH", n: 1, opened: true },
    ].map((r) => ({ ...r, isDeal: r.code === "DEAL" }));
    const c = countLifecycle(rows);
    const sum = Object.values(c.stages).reduce((a, b) => a + b, 0);
    check("the owner's 329 listings: stages add up to the total (no listing counted twice)", c.total === 329 && sum === 329, c);
    check("only 57 of the 329 had a real verdict; 'evaluated' no longer means 'saved'", c.fullyEvaluated === 56 + 1 + 0 && c.stages.profitable === 1 && c.stages.unprofitable === 56, c);
  }
});
