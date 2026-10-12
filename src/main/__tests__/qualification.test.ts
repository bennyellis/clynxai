// Stage 4 (qualification step): decisions 3 and 7 and defects D6, D7, D8, D10, D11 on the shared final-qualification function.
import { buildQualifiedAlert, qualifyScoredListing, resolveEvidence, type MarketCheck } from "../preAlert.js";
import type { ProductSignals } from "../dealSummary.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };

function setup(initial: ProductSignals | null) {
  let signals = initial;
  const calls: Array<{ title: string; matchedItem: string | null }> = [];
  const source = { getProductSignals: () => signals, getFacebookPriceStats: () => null };
  return {
    source,
    calls,
    setSignals: (s: ProductSignals | null) => void (signals = s),
    checker: (value: number | null, after?: ProductSignals | null) => async (l: { title: string; matchedItem: string | null }): Promise<MarketCheck | null> => {
      calls.push(l);
      if (after !== undefined) signals = after;
      return { productId: "p1", productName: "Xbox Series S", valueUsd: value, refreshed: true, note: "checked" };
    },
  };
}
const sig = (value: number, sample: number, over: Partial<ProductSignals> = {}): ProductSignals => ({ id: "p1", name: "Xbox Series S", valueUsd: value, runTimeDays: 3, compSample: sample, checkedAt: Date.now() - 86_400_000, basis: "sold", ...over });
const aiOnly = (price: number, over: Record<string, unknown> = {}, listing: Record<string, unknown> = {}) =>
  scoredListing("Xbox Series S console", price, { extraction: { matchedItem: null, extractedAttributes: "game console", conditionImpact: "none", confidence: "medium", reasoning: "AI guess" }, referencePriceUsd: null, discountPercent: null, dealTier: "general", isDeal: true, ...over }, listing);

run(async () => {
  const logs: string[] = [];
  const base = { settings, maxAgeHours: 24, log: (m: string) => void logs.push(m) };

  section("decision 3: an AI-only find is validated against reliable resale evidence before it can be a deal");
  {
    const h = setup(null);
    const q = await qualifyScoredListing({ ...base, scored: aiOnly(300), source: h.source, check: h.checker(600, sig(600, 8)), refreshMarket: false });
    check("the market check ran even though the caller did not ask (an AI-only deal is always validated)", h.calls.length === 1);
    check("reliable evidence arrived: it becomes a Profitable Now deal", q.verdict.status === "profitable_now" && q.scored.isDeal === true && q.scored.gate?.status === "profitable_now", q.verdict);
    check("the value the Feed shows is the validated one", q.scored.referencePriceUsd === 600);
  }
  {
    const h = setup(null);
    const q = await qualifyScoredListing({ ...base, scored: aiOnly(300), source: h.source, check: h.checker(null), refreshMarket: false });
    check("the check finds nothing: Worth a Look, not a deal, no stars", q.verdict.status === "worth_a_look" && q.scored.isDeal === false && q.scored.dealTier === null && q.scored.gate?.stars === null, q.verdict);
    check("and the reason says the AI's read is unconfirmed", q.verdict.reasons.some((r) => r.code === "AI_UNVERIFIED"));
  }
  {
    const h = setup(null);
    const q = await qualifyScoredListing({ ...base, scored: aiOnly(400), source: h.source, check: h.checker(600, sig(600, 1)), refreshMarket: false });
    check("thin evidence (one sale) at an ordinary margin: Worth a Look at low confidence, not a deal", q.verdict.status === "worth_a_look" && q.verdict.confidence === "low" && !q.scored.isDeal, q.verdict);
  }
  {
    const h = setup(null);
    const q = await qualifyScoredListing({ ...base, scored: aiOnly(250), source: h.source, check: h.checker(600, sig(600, 1)), refreshMarket: false });
    check("one sale but a big gap: a rare/undervalued find stays a deal, at low confidence", q.verdict.status === "profitable_now" && q.verdict.confidence === "low" && q.scored.isDeal, q.verdict);
  }
  {
    const h = setup(null);
    const q = await qualifyScoredListing({ ...base, scored: aiOnly(300), source: h.source, refreshMarket: false });
    check("with no way to check at all it is still only Worth a Look", q.verdict.status === "worth_a_look" && !q.scored.isDeal);
  }

  section("D11: the fresh market value can demote a deal, and the demotion is what gets saved");
  {
    // scored as a deal against a stale $600 Database value; the fresh check says it is worth $400
    const h = setup(sig(600, 8));
    const scored = scoredListing("Xbox Series S", 400, { referencePriceUsd: 600, isDeal: true });
    const q = await qualifyScoredListing({ ...base, scored, source: h.source, check: h.checker(400, sig(400, 8)), refreshMarket: true });
    check("the same listing is no longer a deal once the fresh value is known", q.verdict.status === "pass" && q.scored.isDeal === false && q.scored.dealTier === null, q.verdict);
    check("and the saved listing says so (Feed/Dashboard read this, not the old flag)", q.scored.gate?.status === "pass");
  }
  {
    const h = setup(sig(600, 8));
    const scored = scoredListing("Xbox Series S", 450, { referencePriceUsd: 600, isDeal: true });
    const q = await qualifyScoredListing({ ...base, scored, source: h.source, check: h.checker(600, sig(600, 8)), refreshMarket: true });
    check("a deal that needs 11% off is a Negotiation Opportunity with the required discount saved", q.verdict.status === "negotiation" && q.scored.isDeal && q.scored.gate?.requiredDiscountPercent === 11 && q.scored.gate?.targetPriceUsd === 400, q.scored.gate);
  }

  section("D1/D2: age: unknown is never a verified deal; stale never even triggers a market check");
  {
    const h = setup(sig(600, 8));
    const q = await qualifyScoredListing({ ...base, scored: scoredListing("Xbox Series S", 400, { referencePriceUsd: 600 }, { listingAge: null }), source: h.source, check: h.checker(600, sig(600, 8)), refreshMarket: true });
    check("unknown age: Worth a Look, not a deal, still visible", q.verdict.status === "worth_a_look" && !q.scored.isDeal && q.verdict.reasons.some((r) => r.code === "AGE_UNKNOWN"), q.verdict);
    const q2 = await qualifyScoredListing({ ...base, scored: scoredListing("Xbox Series S", 400, { referencePriceUsd: 600 }, { listingAge: "a week ago" }), source: h.source, check: h.checker(600, sig(600, 8)), refreshMarket: true });
    check("a stale listing is a pass", q2.verdict.status === "pass" && !q2.scored.isDeal);
    const before = h.calls.length;
    await qualifyScoredListing({ ...base, scored: scoredListing("Xbox Series S", 400, { referencePriceUsd: 600 }, { listingAge: "a month ago" }), source: h.source, check: h.checker(600), refreshMarket: true });
    check("and costs no market lookup (a hard stop is decided before spending one)", h.calls.length === before);
  }

  section("a failing market check does not break the listing");
  {
    const h = setup(sig(600, 8));
    const msgs: string[] = [];
    const q = await qualifyScoredListing({ ...base, log: (m) => void msgs.push(m), scored: scoredListing("Xbox Series S", 400, { referencePriceUsd: 600 }), source: h.source, check: async () => { throw new Error("boom"); }, refreshMarket: true });
    check("it uses the Database's numbers and logs the failure", q.verdict.status === "profitable_now" && msgs.some((m) => /Market check failed \(boom\)/.test(m)));
  }

  section("evidence resolution");
  {
    const h = setup(sig(600, 8));
    const fromDb = resolveEvidence(scoredListing("Xbox Series S", 400, { referencePriceUsd: 600 }), h.source);
    check("a reference price equal to the Database value uses the Database's evidence (sample size, basis)", fromDb?.basis === "sold" && fromDb.sampleSize === 8, fromDb);
    const typed = resolveEvidence(scoredListing("Xbox Series S", 400, { referencePriceUsd: 555 }), h.source);
    check("a reference that is not the Database value is the user's own typed price", typed?.basis === "user", typed);
    const noRef = resolveEvidence(aiOnly(300), h.source);
    check("an AI-only find uses what the Database knows about the product, if anything", noRef?.valueUsd === 600 && noRef.sampleSize === 8);
    check("or nothing", resolveEvidence(aiOnly(300), setup(null).source) === null);
  }

  section("notification text (decision 4: the required discount is shown)");
  {
    const h = setup(sig(600, 8));
    const neg = await qualifyScoredListing({ ...base, scored: scoredListing("Xbox Series S", 450, { referencePriceUsd: 600, isDeal: true }), source: h.source, check: h.checker(600, sig(600, 8)), refreshMarket: true });
    const a = buildQualifiedAlert({ q: neg, source: h.source, settings, kind: "deal" });
    check("a negotiation alert shows the asking price, the offer and the discount", /\$450 \(offer ~\$400\)/.test(a.title) && /Offer ~\$400 \(11% off\)/.test(a.message), a);
    const now = await qualifyScoredListing({ ...base, scored: scoredListing("Xbox Series S", 400, { referencePriceUsd: 600, isDeal: true }), source: h.source, check: h.checker(600, sig(600, 8)), refreshMarket: true });
    const b = buildQualifiedAlert({ q: now, source: h.source, settings, kind: "deal" });
    check("a Profitable Now alert is the plain deal alert with stars", /^🟦 \$400 - /.test(b.title) && /⭐/.test(b.message) && !/offer/.test(b.title), b);
    const w1 = buildQualifiedAlert({ q: now, source: h.source, settings, kind: "watch", watchName: "Xbox watch" });
    check("a Watch match that is ALSO a qualified deal: one combined notification", /^🟦 Watch match \+ deal - \$400/.test(w1.title) && /Xbox watch:/.test(w1.message) && /⭐/.test(w1.message), w1);
    const hot = setup(null);
    const weak = await qualifyScoredListing({ ...base, scored: aiOnly(300), source: hot.source, check: hot.checker(null), refreshMarket: true });
    const w2 = buildQualifiedAlert({ q: weak, source: hot.source, settings, kind: "watch", watchName: "Xbox watch" });
    check("a Watch match that is NOT a deal says so, plainly", /^🟦 Watch match - /.test(w2.title) && /not a qualified deal/.test(w2.message) && !/Watch match \+ deal/.test(w2.title), w2);
    const lowConf = await qualifyScoredListing({ ...base, scored: aiOnly(250), source: setup(null).source, check: setup(null).checker(600, sig(600, 1)), refreshMarket: true });
    const c = buildQualifiedAlert({ q: lowConf, source: h.source, settings, kind: "deal" });
    check("limited evidence is stated on a deal that stays qualified", /limited sales data/.test(c.message), c);
  }
});
