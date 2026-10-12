// Stage 4: the Deal Quality Gate wired into the REAL routes (passive scan, active Watch check, post-scoring pipeline, eBay Watch).
// Reproduces audit defects D4 (Watch alerts unconditional / not revalidated), D6, D7 (AI-only deals), D10 (pre-push gate),
// D11 (verdict never revoked), D15 (Watch vs deal notifications), and checks decisions 1-10.
import { EbayEngine } from "../ebayEngine.js";
import { check, run, section } from "./_testkit.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, makeWatch, ntfy, resetNetwork, scoredListing, searchItem, setAiReply, summary } from "./_fixtures.js";

const TITLE = "Xbox Series S";
const strongSignals = (value: number) => ({ id: "p1", name: "Xbox Series S", valueUsd: value, runTimeDays: 3, compSample: 8, checkedAt: Date.now() - 86_400_000, basis: "sold" as const });

interface ScanOpts {
  title?: string;
  price?: number;
  age?: string | null;
  config?: Record<string, unknown>;
  watches?: any[];
  // what the market check says (value) and what the Database knows afterwards
  marketValue?: number | null;
  signalsBefore?: any;
  signalsAfter?: any;
  ai?: Record<string, unknown>;
}

async function scan(o: ScanOpts = {}) {
  resetNetwork();
  if (o.ai) setAiReply({ match: true, confidence: "high", reason: "ok", category: "console", estimatedValueRangeUsd: "250-350", conditionImpact: "none", reasoning: "looks cheap", offTopicSuggestion: null, ...o.ai });
  let signals = o.signalsBefore ?? null;
  const checks: Array<{ title: string; matchedItem: string | null }> = [];
  const store = makeStore({ listWatches: () => o.watches ?? [], getProductSignals: () => signals });
  const h = makeEngine({
    store,
    config: o.config ?? baseConfig({ searchItems: [searchItem(TITLE, 600)] }),
    checkMarket: async (l) => {
      checks.push(l);
      if (o.signalsAfter !== undefined) signals = o.signalsAfter;
      return o.marketValue === undefined ? { productId: "p1", productName: TITLE, valueUsd: 600, refreshed: true, note: "" } : o.marketValue === null ? null : { productId: "p1", productName: TITLE, valueUsd: o.marketValue, refreshed: true, note: "" };
    },
  });
  const title = o.title ?? TITLE;
  const price = o.price ?? 400;
  h.engine.detailToLoad = detail(title, price, { listingAge: o.age === undefined ? "2 hours ago" : o.age });
  await (h.engine as any).evaluateListing(FAKE_PAGE, summary(title, price), h.config);
  return { h, store, checks, last: store.saved[store.saved.length - 1] };
}

run(async () => {
  installFetchStub();

  section("decision 3 / D6: a Search For item with no reference value is an AI-only find: Feed only until validated");
  {
    const { last } = await scan({ config: baseConfig({ searchItems: [searchItem(TITLE, 0)] }), ai: { isPotentialDeal: true, confidence: "medium" }, marketValue: null, price: 300 });
    check("not a deal; Worth a Look; no push", !!last && last.isDeal === false && last.dealTier === null && last.gate?.status === "worth_a_look" && ntfy.length === 0, last && { isDeal: last.isDeal, gate: last.gate, pushes: ntfy.length });
    check("the reason says it is the AI's unconfirmed read", !!last && last.gate!.reasons.some((r) => r.code === "AI_UNVERIFIED"));
  }

  section("decision 3 / D7: a General AI find needs reliable resale evidence before it is a deal or is pushed");
  const general = baseConfig({ generalDeal: { enabled: true, minConfidence: "medium" } });
  {
    const { last, checks } = await scan({ title: "Some console", config: general, price: 300, ai: { isPotentialDeal: true, confidence: "medium" }, marketValue: null });
    check("no resale numbers: Worth a Look, no push", !!last && last.isDeal === false && last.gate?.status === "worth_a_look" && ntfy.length === 0, last && last.gate);
    check("it still went and looked for the numbers", checks.length >= 1);
  }
  {
    const { last, checks } = await scan({ title: "Some console", config: general, price: 300, ai: { isPotentialDeal: true, confidence: "medium" }, marketValue: 600, signalsBefore: null, signalsAfter: strongSignals(600) });
    check("the market check returns solid evidence: it is validated, becomes a deal, and is pushed once", !!last && last.isDeal === true && last.gate?.status === "profitable_now" && ntfy.length === 1, last && { isDeal: last.isDeal, gate: last.gate, pushes: ntfy.length });
    check("the validated value is the one saved", last?.referencePriceUsd === 600 && checks.length >= 1);
  }
  {
    const { last } = await scan({ title: "Some console", config: general, price: 400, ai: { isPotentialDeal: true, confidence: "medium" }, marketValue: 600, signalsBefore: null, signalsAfter: { ...strongSignals(600), compSample: 1 } });
    check("one sale only at an ordinary margin: Worth a Look at low confidence, no push (weak evidence lowers confidence, it does not invent a deal)", !!last && last.isDeal === false && last.gate?.status === "worth_a_look" && last.gate?.confidence !== "high" && ntfy.length === 0, last && last.gate);
  }
  {
    const { last } = await scan({ title: "Some console", config: general, price: 250, ai: { isPotentialDeal: true, confidence: "medium" }, marketValue: 600, signalsBefore: null, signalsAfter: { ...strongSignals(600), compSample: 1 } });
    check("one sale but a big gap (a rare/undervalued find): stays a deal, at low confidence, with 'limited sales data' in the alert", !!last && last.isDeal === true && last.gate?.confidence === "low" && ntfy.length === 1 && /limited sales data/.test(ntfy[0].message), last && { gate: last.gate, push: ntfy[0] });
  }

  section("decision 1: unknown age is never a verified deal, but stays visible");
  {
    const { last } = await scan({ age: null, signalsBefore: strongSignals(600) });
    check("a listing that would qualify is Worth a Look when its age could not be read", !!last && last.isDeal === false && last.gate?.status === "worth_a_look" && last.gate.reasons.some((r) => r.code === "AGE_UNKNOWN") && last.listing.listingAge === null, last && last.gate);
    check("it is not pushed", ntfy.length === 0);
  }
  {
    const { last } = await scan({ age: "whenever", signalsBefore: strongSignals(600) });
    check("the same for wording that is not understood", !!last && last.gate?.status === "worth_a_look" && last.isDeal === false && ntfy.length === 0);
  }

  section("decision 6: Worth a Look is Feed-only by default; a setting makes it a quiet push");
  {
    const { last } = await scan({ age: null, signalsBefore: strongSignals(600), config: baseConfig({ searchItems: [searchItem(TITLE, 600)], notifyWorthALook: true }) });
    check("with notifyWorthALook on it is pushed quietly and labelled", !!last && last.gate?.status === "worth_a_look" && ntfy.length === 1 && ntfy[0].priority === "low" && ntfy[0].tags === "mag" && /Worth a look/.test(ntfy[0].title), ntfy);
  }

  section("D11 / decision 9: the verdict that is saved is the final one (a withheld deal is not a deal anywhere)");
  {
    // scored as a deal against a $600 typed reference; the fresh market check says it is only worth $400
    const { last } = await scan({ marketValue: 400, signalsAfter: strongSignals(400), signalsBefore: strongSignals(600) });
    check("the saved listing is NOT a deal, says pass, and nothing is pushed", !!last && last.isDeal === false && last.gate?.status === "pass" && ntfy.length === 0, last && { isDeal: last.isDeal, gate: last.gate });
  }

  section("decision 4: Negotiation Opportunity shows the required discount");
  {
    const { last } = await scan({ price: 450, signalsBefore: strongSignals(600), config: baseConfig({ searchItems: [searchItem(TITLE, 600, { maxPriceUsd: 500 })] }) });
    check("saved as a negotiation with 11% off and an offer of $400", !!last && last.isDeal === true && last.gate?.status === "negotiation" && last.gate.requiredDiscountPercent === 11 && last.gate.targetPriceUsd === 400, last && last.gate);
    check("the alert shows the offer and the discount", ntfy.length === 1 && /\$450 \(offer ~\$400\)/.test(ntfy[0].title) && /Offer ~\$400 \(11% off\)/.test(ntfy[0].message), ntfy);
  }
  {
    const { last } = await scan({ price: 400, signalsBefore: strongSignals(600) });
    check("and a Profitable Now deal is the plain alert", !!last && last.gate?.status === "profitable_now" && ntfy.length === 1 && !/offer/.test(ntfy[0].title), ntfy);
  }

  section("decision 10: no extra lookups: listings that are not candidates cost nothing new");
  {
    const { checks, last } = await scan({ price: 700, signalsBefore: strongSignals(600) });
    check("a listing that is not a deal and matches no Watch: no market check and no verdict (unchanged behavior)", checks.length === 0 && !!last && last.isDeal === false && last.gate === undefined, { checks: checks.length });
  }
  {
    const watch = makeWatch({ minProfitUsd: 5000 });
    const { checks, store } = await scan({ price: 700, watches: [watch], signalsBefore: strongSignals(600) });
    check("a Watch candidate whose conditions fail: no market check, no push", checks.length === 0 && ntfy.length === 0 && store.watchMatches.length === 0, { checks: checks.length });
  }

  section("D4 / decision 2: a Watch match is delivered by the Watch's criteria, but labelled, and not a deal unless it passes");
  {
    const watch = makeWatch({ maxListingAgeMinutes: null });
    const { last, store } = await scan({ price: 400, config: baseConfig({ searchItems: [searchItem(TITLE, 300)] }), watches: [watch], signalsBefore: strongSignals(300), marketValue: 300, signalsAfter: strongSignals(300) });
    check("a loss-making listing still reaches the user as a Watch match (that is what the Watch asked for)", store.watchMatches.length === 1 && ntfy.length === 1, { matches: store.watchMatches.length, pushes: ntfy.length });
    check("but the alert says plainly it is NOT a qualified deal", /Watch match/.test(ntfy[0].title) && !/Watch match \+ deal/.test(ntfy[0].title) && /not a qualified deal/.test(ntfy[0].message) && ntfy[0].tags === "eye", ntfy[0]);
    check("and the saved listing is not a deal", !!last && last.isDeal === false && last.gate?.status === "pass", last && last.gate);
  }

  section("decision 8: a Watch match that is also a qualified deal is ONE notification");
  {
    const watch = makeWatch();
    const { last, store } = await scan({ price: 400, watches: [watch], signalsBefore: strongSignals(600) });
    check("exactly one push for the listing", ntfy.length === 1, ntfy);
    check("it is the combined 'Watch match + deal' alert", /Watch match \+ deal/.test(ntfy[0].title) && ntfy[0].tags === "eye,moneybag" && /Xbox watch:/.test(ntfy[0].message), ntfy[0]);
    check("the Watch match is recorded, and the listing is a qualified deal", store.watchMatches.length === 1 && !!last && last.isDeal === true && last.gate?.status === "profitable_now");
    check("the listing is marked notified (so a later deal alert cannot repeat it)", store.notifiedListings.has("l1"));
  }
  {
    const watch = makeWatch({ ntfyTopic: "friends-topic" });
    await scan({ price: 400, watches: [watch], signalsBefore: strongSignals(600) });
    const urls = ntfy.map((n) => n.url);
    check("a Watch with its OWN topic reaches someone else: both the Watch alert and your deal alert are sent", ntfy.length === 2 && urls.some((u) => u.endsWith("/friends-topic")) && urls.some((u) => u.endsWith("/t")), urls);
  }

  section("D4: a Watch match recorded early can never be retracted; a later demotion is saved, not forgotten");
  {
    resetNetwork();
    const watch = makeWatch();
    const store = makeStore({ listWatches: () => [watch] });
    const h = makeEngine({ store, config: baseConfig({ searchItems: [searchItem(TITLE, 600)] }), checkMarket: async () => ({ productId: null, productName: TITLE, valueUsd: 600, refreshed: true, note: "" }) });
    const first = scoredListing(TITLE, 400, { referencePriceUsd: 600 });
    await (h.engine as any).recordWatchMatchesIfAny([watch], first, h.config, "active", watch.terms[0]);
    check("first evaluation: the match is pushed", ntfy.length === 1);
    const demoted = { ...first, isDeal: false, extraction: { ...first.extraction, matchedItem: null } };
    await (h.engine as any).recordWatchMatchesIfAny([watch], demoted, h.config, "active", watch.terms[0]);
    check("a later evaluation of the same match sends nothing more (no duplicate)", ntfy.length === 1);
  }

  section("D1-D3 (route E) and decision 10: an active Watch check announces a qualified deal once, and only a Watch match is a Watch alert");
  {
    resetNetwork();
    const watch = makeWatch({ minProfitUsd: 5000 }); // its own criteria fail, but the listing is a qualified deal
    let signals: any = strongSignals(600);
    const store = makeStore({ listWatches: () => [watch], getProductSignals: () => signals });
    const h = makeEngine({ store, config: baseConfig({ searchItems: [searchItem(TITLE, 600)] }), checkMarket: async () => ({ productId: null, productName: TITLE, valueUsd: 600, refreshed: true, note: "" }) });
    h.engine.detailToLoad = detail(TITLE, 400, { listingAge: "3 hours ago" });
    await (h.engine as any).evaluateWatchCandidate(FAKE_PAGE, watch, watch.terms[0], summary(TITLE, 400), h.config);
    check("a qualified deal found by an active Watch check is announced as a deal (not as a Watch match)", ntfy.length === 1 && !/Watch match/.test(ntfy[0].title) && store.watchMatches.length === 0, ntfy);
    void signals;
    signals = null;
  }

  section("eBay: the same rules for an eBay Watch (canWithhold no longer means 'send as a recommendation')");
  {
    resetNetwork();
    const watch = makeWatch({ platform: "ebay" });
    const store = makeStore({ listWatches: () => [watch], getProductSignals: () => strongSignals(300) });
    const engine = new EbayEngine({
      store: store.proxy,
      getConfig: () => baseConfig(),
      onLog: () => {},
      onListing: () => {},
      onNarrate: async () => {},
      onWatchMatch: () => {},
      onStatus: () => {},
      checkMarket: async () => ({ productId: null, productName: TITLE, valueUsd: 300, refreshed: true, note: "" }),
    } as any);
    const loss = scoredListing(TITLE, 400, { referencePriceUsd: 300, isDeal: false, dealTier: null }, { source: "ebay", id: "ebay-1", listingAge: "2 hours ago" } as any);
    await (engine as any).recordWatchMatches([watch], loss, baseConfig());
    check("an eBay Watch match on a loss is still delivered, labelled, and not a qualified deal", ntfy.length === 1 && /Watch match/.test(ntfy[0].title) && /not a qualified deal/.test(ntfy[0].message), ntfy);
    resetNetwork();
    const good = scoredListing(TITLE, 200, { referencePriceUsd: 300 }, { source: "ebay", id: "ebay-2", listingAge: "2 hours ago" } as any);
    const watch2 = makeWatch({ platform: "ebay", id: "w2" });
    const store2 = makeStore({ getProductSignals: () => strongSignals(300) });
    const engine2 = new EbayEngine({ store: store2.proxy, getConfig: () => baseConfig(), onLog: () => {}, onListing: () => {}, onNarrate: async () => {}, onWatchMatch: () => {}, onStatus: () => {}, checkMarket: async () => ({ productId: null, productName: TITLE, valueUsd: 300, refreshed: true, note: "" }) } as any);
    await (engine2 as any).recordWatchMatches([watch2], good, baseConfig());
    check("an eBay Watch match that is also a qualified deal is one combined notification", ntfy.length === 1 && /Watch match \+ deal/.test(ntfy[0].title), ntfy);
  }
});
