// Stage 1 route-level regression tests: the REAL evaluation routes (passive scan, active Watch check, post-scoring pipeline)
// with a fake store, fake network and no browser. Reproduces audit defects D1 and D3 at the route level, and checks the
// recall side (a fresh deal is still a deal, a genuine hidden gem is still found).
import { check, run, section } from "./_testkit.js";
import { valueBundle } from "../bundleBreakdown.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, makeWatch, ntfy, resetNetwork, scoredListing, searchItem, summary } from "./_fixtures.js";

const checkMarket600 = async () => ({ productId: null, productName: "Xbox Series S", valueUsd: 600, refreshed: true, note: "" });
const TITLE = "Xbox Series S";
const configWithItem = () => baseConfig({ searchItems: [searchItem("Xbox Series S", 600)] });

async function scan(age: string | null, opts: { watches?: any[]; price?: number } = {}) {
  resetNetwork();
  const store = makeStore({ listWatches: () => opts.watches ?? [] });
  const h = makeEngine({ store, config: configWithItem(), checkMarket: checkMarket600 });
  const price = opts.price ?? 400; // $400 against a $600 value: profit $104, margin 20.6%
  h.engine.detailToLoad = detail(TITLE, price, { listingAge: age });
  await (h.engine as any).evaluateListing(FAKE_PAGE, summary(TITLE, price), h.config);
  return { h, last: store.saved[store.saved.length - 1], store };
}

run(async () => {
  installFetchStub();

  section("D1 (route): a stale listing is skipped even when Facebook words its age as 'a week ago'");
  for (const age of ["a week ago", "a month ago", "a day ago", "4 days ago", "over a year ago"]) {
    const { last } = await scan(age);
    check(`"${age}": saved as a skip, not a deal, no alert`, !!last && last.isDeal === false && /older than your/.test(last.extraction.reasoning) && ntfy.length === 0, last && { isDeal: last.isDeal, why: last.extraction.reasoning, pushes: ntfy.length });
  }

  section("Recall: a fresh profitable listing is still a deal and is still pushed");
  {
    const { last } = await scan("2 hours ago");
    check("fresh + profitable -> isDeal true", !!last && last.isDeal === true, last && { isDeal: last.isDeal, why: last.extraction.reasoning });
    check("and one deal alert goes out", ntfy.length === 1 && /\$400/.test(ntfy[0].title), ntfy);
  }
  {
    const { last } = await scan("about an hour ago");
    check(`"about an hour ago" (unparsed before) is fresh and still a deal`, !!last && last.isDeal === true);
  }

  section("D3 (route D, passive scan): a Watch with no age window can no longer rescue an old listing into a deal");
  {
    const watch = makeWatch({ maxListingAgeMinutes: null });
    const { last, store } = await scan("3 weeks ago", { watches: [watch] });
    check("skipped as too old; no deal alert and no Watch alert", !!last && last.isDeal === false && ntfy.length === 0 && store.watchMatches.length === 0, { pushes: ntfy.length, matches: store.watchMatches.length, isDeal: last && last.isDeal });
  }

  section("D3 (route D): a Watch with its OWN covering window still gets its match, but the listing is not an ordinary deal");
  {
    const watch = makeWatch({ maxListingAgeMinutes: 30 * 24 * 60 });
    const { last, store, h } = await scan("4 days ago", { watches: [watch] });
    check("the Watch match is recorded and pushed (once)", store.watchMatches.length === 1 && ntfy.length === 1 && ntfy[0].tags === "eye", { matches: store.watchMatches.length, pushes: ntfy });
    check("the saved listing is NOT a deal (it is only here for the Watch)", !!last && last.isDeal === false && last.dealTier === null && /kept only for the Watch/.test(last.extraction.reasoning), last && { isDeal: last.isDeal, tier: last.dealTier, why: last.extraction.reasoning });
    check("no ordinary deal alert was sent for it", !ntfy.some((n) => n.tags === "moneybag"));
    void h;
  }

  section("D3 (route E, active Watch check): previously had no age check at all");
  async function activeCheck(age: string | null, windowMinutes: number | null) {
    resetNetwork();
    const watch = makeWatch({ maxListingAgeMinutes: windowMinutes });
    const store = makeStore({ listWatches: () => [watch] });
    const h = makeEngine({ store, config: configWithItem(), checkMarket: checkMarket600 });
    h.engine.detailToLoad = detail(TITLE, 400, { listingAge: age });
    await (h.engine as any).evaluateWatchCandidate(FAKE_PAGE, watch, watch.terms[0], summary(TITLE, 400), h.config);
    return { last: store.saved[store.saved.length - 1], store, h };
  }
  {
    const { last, store, h } = await activeCheck("3 months ago", null);
    check("a Watch with no window: a 3-month-old listing is skipped (saved as a skip), no Watch alert", !!last && last.isDeal === false && /older than your/.test(last.extraction.reasoning) && ntfy.length === 0 && store.watchMatches.length === 0, { pushes: ntfy.length });
    check("and the skip is logged", h.logs.some((l) => /too old/.test(l.message)));
  }
  {
    const { last } = await activeCheck("a week ago", null);
    check(`"a week ago" is skipped too (the unparsed phrase)`, !!last && last.isDeal === false && ntfy.length === 0);
  }
  {
    const { last, store } = await activeCheck("4 days ago", 30 * 24 * 60);
    check("a Watch whose own window covers it: Watch alert yes, ordinary deal no", store.watchMatches.length === 1 && ntfy.length === 1 && ntfy[0].tags === "eye" && !!last && last.isDeal === false, { pushes: ntfy.length, isDeal: last && last.isDeal });
  }
  {
    const { last, store } = await activeCheck("3 hours ago", null);
    check("a fresh listing is evaluated and matched as before", store.watchMatches.length === 1 && ntfy.length >= 1 && !!last);
  }

  section("D3 (pipeline guard): nothing after scoring may turn a stale (Watch-only) listing into a deal");
  // A real hidden gem: a $700 Steam Deck asked at $590 (not a deal alone) that comes with a dock, a 1TB card and a big game lot,
  // each priced item by item (what the bundle breakdown does), so the extras are corroborated and may be counted.
  async function hiddenGem(age: string) {
    resetNetwork();
    const store = makeStore();
    const deckBundle = async (args: { mainName: string; mainValueUsd: number }) =>
      valueBundle({
        main: { name: args.mainName, quantity: 1, role: "main", sellability: "easy", guessUsd: null },
        mainValueUsd: args.mainValueUsd,
        extras: [
          { item: { name: "Steam Deck dock", quantity: 1, role: "accessory", sellability: "easy", guessUsd: 150 }, unitValueUsd: 150, runTimeDays: 4 },
          { item: { name: "Steam Deck game lot", quantity: 1, role: "extra", sellability: "easy", guessUsd: 700 }, unitValueUsd: 700, runTimeDays: 6 },
          { item: { name: "1TB microSD card", quantity: 1, role: "extra", sellability: "easy", guessUsd: 120 }, unitValueUsd: 120, runTimeDays: 5 },
        ],
      });
    const h = makeEngine({ store, config: baseConfig(), checkMarket: async () => ({ productId: null, productName: "Steam Deck OLED", valueUsd: 700, refreshed: true, note: "" }), extra: { valueBundle: deckBundle } });
    const title = "Steam Deck OLED with dock, 1TB card and 20 games";
    const listing = detail(title, 590, { listingAge: age });
    const scored = scoredListing(title, 590, { extraction: { matchedItem: "Steam Deck OLED", extractedAttributes: "", conditionImpact: "none", confidence: "high", reasoning: "Matches." }, referencePriceUsd: 700, discountPercent: 15, isDeal: false, dealTier: null }, { listingAge: age });
    await (h.engine as any).runPostScoringPipeline(listing, listing, h.config, scored, { passed: true, reasons: [] }, null, [], [], "passive");
    return { last: store.saved[store.saved.length - 1] };
  }
  {
    const { last } = await hiddenGem("2 hours ago");
    check("a genuine, item-by-item priced hidden gem on a fresh listing is still found (recall preserved)", !!last && last.isDeal === true && last.gate?.status === "profitable_now", last && { isDeal: last.isDeal, gate: last.gate });
    check("and its deal alert goes out", ntfy.length === 1 && /\$590/.test(ntfy[0].title), ntfy);
  }
  {
    const { last } = await hiddenGem("4 days ago");
    check("the same lot on a stale listing is NOT a deal", !!last && last.isDeal === false && last.gate?.status === "pass" && last.gate.reasons.some((r) => r.code === "AGE_STALE"), last && last.gate);
    check("and no deal alert is sent", ntfy.length === 0, ntfy);
  }
});
