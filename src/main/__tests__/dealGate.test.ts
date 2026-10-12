// Stage 2: the pure Deal Quality Gate. Each test names the audit defect or decision it protects.
import { assessListingAge } from "../listingAge.js";
import { CONDITION_VALUE_MULTIPLIER } from "../scorer.js";
import { CONDITION_VALUE_FACTOR } from "../resaleMath.js";
import { EVIDENCE_RULES, evidenceFromSignals, evidenceLevel, isQualifiedStatus, qualifyListing, userEvidence, type GateInput, type ValueEvidence } from "../dealGate.js";
import { check, run, section } from "./_testkit.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };
const fresh = assessListingAge("2 hours ago", 24);
const unknownAge = assessListingAge(null, 24);
const staleAge = assessListingAge("a week ago", 24);
const strong: ValueEvidence = { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 2 };
const gate = (over: Partial<GateInput> & { priceUsd: number }) =>
  qualifyListing({ pathway: "search", conditionImpact: "none", evidence: strong, age: fresh, settings, ...over });
const codes = (v: ReturnType<typeof gate>) => v.reasons.map((r) => r.code);

run(() => {
  section("the four statuses (decision 4)");
  let v = gate({ priceUsd: 400 });
  check("Profitable Now: margin at asking >= the minimum, strong evidence, fresh", v.status === "profitable_now" && v.qualified && v.confidence === "high" && (v.facts.marginAtAskPercent ?? 0) >= 20, v);
  check("it carries profit and stars", (v.facts.profitAtAskUsd ?? 0) > 100 && (v.stars ?? 0) >= 3, v);

  v = gate({ priceUsd: 450 });
  check("Negotiation Opportunity: margin below the minimum at asking but reachable within the limit", v.status === "negotiation" && v.qualified, v);
  check("it shows the REQUIRED DISCOUNT and the price to offer", v.facts.requiredDiscountPercent === 11 && v.facts.targetPriceUsd === 400 && /Offer ~\$400 \(11% off\)/.test(v.headline), { f: v.facts, h: v.headline });
  check("it explains what is needed", v.reasons.some((r) => r.code === "NEEDS_DISCOUNT" && /Needs 11% off/.test(r.text) && /offer about \$400/.test(r.text)), v.reasons);
  check("a contingent deal never rates above 3 stars", (v.stars ?? 9) <= 3, v.stars);
  check("the profit at the target price is shown", (v.facts.profitAtTargetUsd ?? 0) >= 100, v.facts);

  v = gate({ priceUsd: 480 });
  check("Pass: it would need more off than the user's limit (about 16%, limit 15%)", v.status === "pass" && !v.qualified && codes(v).includes("UNREACHABLE") && /off the asking price/.test(v.headline), v);
  v = gate({ priceUsd: 700 });
  check("Pass: a loss says so", v.status === "pass" && /loses about \$/.test(v.headline), v.headline);

  check("only Profitable Now and Negotiation are 'qualified'", isQualifiedStatus("profitable_now") && isQualifiedStatus("negotiation") && !isQualifiedStatus("worth_a_look") && !isQualifiedStatus("pass") && !isQualifiedStatus(null));

  section("decision 1 / D1-D2: unknown age can never be a verified deal, but stays visible");
  v = gate({ priceUsd: 400, age: unknownAge });
  check("a listing that would qualify becomes Worth a Look when its age is unknown", v.status === "worth_a_look" && !v.qualified && codes(v).includes("AGE_UNKNOWN"), v);
  v = gate({ priceUsd: 450, age: unknownAge });
  check("the same for a negotiation opportunity", v.status === "worth_a_look" && codes(v).includes("AGE_UNKNOWN"));
  v = gate({ priceUsd: 700, age: unknownAge });
  check("but an unknown age does not rescue a listing that loses money (still a pass)", v.status === "pass");
  v = gate({ priceUsd: 400, age: staleAge });
  check("a known-stale age is a pass", v.status === "pass" && codes(v).includes("AGE_STALE"));

  section("decision 3 / D6-D7: AI-only finds need reliable resale evidence");
  v = gate({ priceUsd: 300, evidence: null, aiFlagged: true, pathway: "general" });
  check("an AI-only find with no resale numbers is Worth a Look, never a deal", v.status === "worth_a_look" && !v.qualified && codes(v).includes("AI_UNVERIFIED") && v.confidence === "low" && v.stars === null, v);
  v = gate({ priceUsd: 300, evidence: null });
  check("no numbers and no AI claim: still just worth a look, with the plain reason", v.status === "worth_a_look" && codes(v).includes("NO_EVIDENCE"));
  v = gate({ priceUsd: 300, evidence: { valueUsd: null, basis: null, sampleSize: null, ageDays: null }, aiFlagged: true });
  check("a null value counts as no evidence", v.status === "worth_a_look");

  section("decision 5 / D8: weak evidence lowers confidence, it does not discard rare products");
  v = gate({ priceUsd: 400, evidence: { valueUsd: 600, basis: "sold", sampleSize: 1, ageDays: 2 } });
  check("one sale and an ordinary margin: Worth a Look (weak evidence)", v.status === "worth_a_look" && codes(v).includes("WEAK_EVIDENCE") && /Only 1 sale/.test(v.headline), v);
  v = gate({ priceUsd: 250, evidence: { valueUsd: 600, basis: "sold", sampleSize: 1, ageDays: 2 } });
  check("one sale but a BIG gap (rare/undervalued): stays a deal at LOW confidence", v.status === "profitable_now" && v.confidence === "low" && codes(v).includes("RARE_FIND") && (v.stars ?? 9) <= 3, v);
  v = gate({ priceUsd: 400, evidence: { valueUsd: 600, basis: "active", sampleSize: 0, ageDays: 1 } });
  check("asking-prices-only value is weak: worth a look, and says why", v.status === "worth_a_look" && /asking prices only/.test(v.headline), v);
  v = gate({ priceUsd: 250, evidence: { valueUsd: 600, basis: "active", sampleSize: 0, ageDays: 1 } });
  check("asking-prices-only with a big gap is still found (low confidence)", v.status === "profitable_now" && v.confidence === "low");
  v = gate({ priceUsd: 450, evidence: { valueUsd: 600, basis: "sold", sampleSize: 1, ageDays: 2 } });
  check("a negotiation on weak evidence is only worth a look", v.status === "worth_a_look");
  v = gate({ priceUsd: 700, evidence: { valueUsd: 600, basis: "sold", sampleSize: 1, ageDays: 2 } });
  check("weak evidence that says it loses money is a pass (scarcity does not invent value)", v.status === "pass");

  section("evidence levels");
  const lvl = (e: Partial<ValueEvidence>) => evidenceLevel({ valueUsd: 100, basis: "sold", sampleSize: 8, ageDays: 1, ...e });
  check("5+ fresh sales: strong; 3-4: moderate; 1-2: weak; none: none", lvl({}) === "strong" && lvl({ sampleSize: 3 }) === "moderate" && lvl({ sampleSize: 2 }) === "weak" && lvl({ valueUsd: null }) === "none" && evidenceLevel(null) === "none");
  check("comps older than 30 days cannot be strong; older than 90 lose a level", lvl({ ageDays: 45 }) === "moderate" && lvl({ ageDays: 120 }) === "moderate" && lvl({ ageDays: 120, sampleSize: 4 }) === "weak");
  check("active-only is weak, a user-typed reference is moderate", lvl({ basis: "active" }) === "weak" && lvl({ basis: "user", sampleSize: null }) === "moderate");
  v = gate({ priceUsd: 400, evidence: { valueUsd: 600, basis: "sold", sampleSize: 8, ageDays: 120 } });
  check("old but plentiful comps still qualify (at medium confidence)", v.status === "profitable_now" && v.confidence === "medium", v);
  check("the thresholds are the documented ones", EVIDENCE_RULES.strongSamples === 5 && EVIDENCE_RULES.moderateSamples === 3);
  const sig = evidenceFromSignals({ id: "p", name: "X", valueUsd: 500, runTimeDays: 3, compSample: 6, checkedAt: Date.now() - 10 * 86_400_000, basis: "blend" });
  check("evidence is built from the Database's product signals", sig !== null && sig.valueUsd === 500 && sig.basis === "blend" && sig.sampleSize === 6 && Math.round(sig.ageDays ?? 0) === 10, sig);
  check("no value, no evidence", evidenceFromSignals({ id: "p", name: "X", valueUsd: null, runTimeDays: null, compSample: null }) === null && userEvidence(0) === null && userEvidence(300)?.basis === "user");
  v = gate({ priceUsd: 400, evidence: userEvidence(600) });
  check("a Search For item with the user's own reference price still qualifies (existing behavior preserved)", v.status === "profitable_now" && v.confidence === "medium", v);

  section("D9 / decision 7: hidden gems: counted extras qualify, unverified extras do not (and are not lost)");
  const switchEvidence: ValueEvidence = { valueUsd: 200, basis: "sold", sampleSize: 8, ageDays: 2 };
  v = gate({ priceUsd: 300, evidence: switchEvidence });
  check("without extras a $200 item at $300 is a pass", v.status === "pass");
  v = gate({ priceUsd: 300, evidence: switchEvidence, extras: { countedUsd: 400, uncountedUsd: 0 } });
  check("with corroborated, counted extras it is found: a real hidden gem qualifies", v.status === "profitable_now" && codes(v).includes("HIDDEN_GEM") && v.facts.extrasCountedUsd === 400, v);
  v = gate({ priceUsd: 300, evidence: switchEvidence, extras: { countedUsd: 0, uncountedUsd: 400 } });
  check("with the SAME extras but unverified (a photo-only guess) it is Worth a Look, not a deal (the audit's R5 case)", v.status === "worth_a_look" && !v.qualified && codes(v).includes("HIDDEN_GEM_UNVERIFIED") && v.stars === null, v);
  v = gate({ priceUsd: 300, evidence: switchEvidence, extras: { countedUsd: 0, uncountedUsd: 20 } });
  check("unverified extras too small to matter leave it a pass", v.status === "pass");
  v = gate({ priceUsd: 400, extras: { countedUsd: 0, uncountedUsd: 300 } });
  check("unverified extras are ignored when the listing already qualifies on its own", v.status === "profitable_now" && v.facts.extrasCountedUsd === 0);

  section("hard stops decided elsewhere");
  check("a confirmed photo mismatch is a pass", gate({ priceUsd: 400, visionMismatch: true }).status === "pass");
  check("a hard price cap is a pass", gate({ priceUsd: 400, hardCapExceeded: true }).status === "pass");
  check("a placeholder price is a pass", gate({ priceUsd: 1, placeholderPrice: true }).status === "pass" && gate({ priceUsd: 0 }).status === "pass");

  section("the user's own settings and the condition rules drive the arithmetic");
  check("condition: a minor flaw values it at 60%, so $400 on a $600 item now loses", gate({ priceUsd: 400, conditionImpact: "minor" }).status === "pass");
  check("a broken copy priced from its own variant gets no further discount", gate({ priceUsd: 400, conditionImpact: "major", broken: true }).status === "profitable_now");
  check("the condition factors match scorer.ts (they must never drift)", CONDITION_VALUE_FACTOR.minor === CONDITION_VALUE_MULTIPLIER.minor && CONDITION_VALUE_FACTOR.major === CONDITION_VALUE_MULTIPLIER.major && CONDITION_VALUE_FACTOR.none === CONDITION_VALUE_MULTIPLIER.none);
  v = gate({ priceUsd: 400, settings: { ...settings, minMarginPercent: 40, maxCutPercent: 30 } });
  check("a stricter minimum margin turns it into a negotiation, with a bigger required discount", v.status === "negotiation" && (v.facts.requiredDiscountPercent ?? 0) > 20, v.facts);
  v = gate({ priceUsd: 400, shippingUsd: 40 });
  check("shipping counts toward the cost", v.status === "negotiation", v);
  v = gate({ priceUsd: 450, settings: { ...settings, maxCutPercent: 5 } });
  check("the negotiation limit is the user's (5% limit makes an 11%-off need a pass)", v.status === "pass");
});
