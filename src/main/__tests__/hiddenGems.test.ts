// Decision 5 and "do not remove the ability to find hidden gems": unusual, rare or undervalued products must stay visible (Worth a
// Look or a low-confidence deal) when comparable sales are scarce, and must only be rejected for real reasons (stale, wrong photo,
// bad price, a loss).
import { qualifyScoredListing, type MarketCheck } from "../preAlert.js";
import type { ProductSignals } from "../dealSummary.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };
const base = { settings, maxAgeHours: 48, log: (_m: string) => {} };

const sig = (value: number, sample: number, over: Partial<ProductSignals> = {}): ProductSignals => ({
  id: "p1", name: "Rare synth", valueUsd: value, runTimeDays: 9, compSample: sample, checkedAt: Date.now() - 86_400_000, basis: "sold", ...over,
});
function source(signals: ProductSignals | null) {
  return { getProductSignals: () => signals, getFacebookPriceStats: () => null };
}
const checker = (value: number | null) => async (): Promise<MarketCheck | null> => ({ productId: "p1", productName: "Rare synth", valueUsd: value, refreshed: true, note: "" });

// An item the Search For list does not know: the AI's own flag is all there is.
const gem = (price: number, listing: Record<string, unknown> = {}) =>
  scoredListing("Vintage Roland Juno-60 synthesizer", price, {
    extraction: { matchedItem: null, extractedAttributes: "synthesizer", conditionImpact: "none", confidence: "medium", reasoning: "Looks like a vintage Juno-60" },
    referencePriceUsd: null, discountPercent: null, dealTier: "general", isDeal: true,
  }, { listingAge: "2 hours ago", ...listing });

run(async () => {
  section("a rare product with almost no sales is not thrown away");
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(250), source: source(null), check: checker(null), refreshMarket: false });
    check("no sales found at all: kept as Worth a Look (visible in the Feed), not Pass", q.verdict.status === "worth_a_look", q.verdict);
    check("it is not a qualified deal, so no deal alert", !q.scored.isDeal && !q.verdict.qualified);
  }
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(250), source: source(sig(1400, 1)), check: checker(1400), refreshMarket: false });
    check("one sold comp and a huge gap: still a deal, at low confidence (not demoted for scarcity)", q.verdict.qualified && q.verdict.confidence === "low", q.verdict);
  }
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(900), source: source(sig(1400, 1)), check: checker(1400), refreshMarket: false });
    check("one sold comp and only an ordinary gap: Worth a Look, not Pass", q.verdict.status === "worth_a_look", q.verdict);
  }

  section("a great price with an unreadable age is shown, not hidden");
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(250, { listingAge: "whenever" }), source: source(sig(1400, 6)), check: checker(1400), refreshMarket: false });
    check("good numbers, unknown age: Worth a Look (never a verified deal, never discarded)", q.verdict.status === "worth_a_look" && !q.scored.isDeal, q.verdict);
  }

  section("a hidden gem that needs a lower price is a negotiation, not a pass");
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(1000), source: source(sig(1400, 6)), check: checker(1400), refreshMarket: false });
    check("fair-looking price but a real margin if the seller comes down: Negotiation Opportunity with the offer price", q.verdict.status === "negotiation" && q.scored.gate?.targetPriceUsd != null, q.verdict);
  }

  section("real reasons still reject");
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(250, { listingAge: "30 days ago" }), source: source(sig(1400, 6)), check: checker(1400), refreshMarket: false });
    check("a listing older than the freshness window is a Pass even at a great price", q.verdict.status === "pass", q.verdict);
  }
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(1500), source: source(sig(1400, 6)), check: checker(1400), refreshMarket: false });
    check("priced above its value: Pass", q.verdict.status === "pass", q.verdict);
  }
  {
    const q = await qualifyScoredListing({ ...base, scored: gem(250), source: source(sig(1400, 6)), check: checker(1400), refreshMarket: false, visionMismatch: true });
    check("the photos show something else: not a deal", !q.verdict.qualified, q.verdict);
  }
});
