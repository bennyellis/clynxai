// Phase 3 fixtures: Series X vs Digital, iPhone storage, MacBook Air with no specs, AirPods generation, a deal under every candidate. Fake rungs only; no photos, no network.
import { DEFAULT_BUDGET, newLadderState, resolveIdentity, vagueMarker, decisionRelevance, RETRY_WAIT_MS, type Candidate, type Identity, type Rung, type RungId } from "../identityLadder.js";
import { check, run, section } from "./_testkit.js";

// a deal when the listing is asked at 70% of the value or less
const isDeal = (ask: number, value: number) => ask <= value * 0.7;
const id = (candidates: Candidate[], confidence: Identity["confidence"] = "vague", missing: string[] = ["which model"]): Identity => ({ candidates, confidence, missing, tried: [] });
const rung = (calls: RungId[], name: RungId, result: Awaited<ReturnType<Rung>>): Rung => async () => { calls.push(name); return result; };

run(async () => {
  section("does finding out change the decision?");
  const xbox = [{ name: "Xbox Series X (Black)", valueUsd: 400 }, { name: "Xbox Series X Digital (White)", valueUsd: 300 }];
  check("asked $200: a deal under every candidate", decisionRelevance(200, xbox, isDeal) === "deal_under_every_candidate");
  check("asked $350: not a deal under any", decisionRelevance(350, xbox, isDeal) === "no_deal_under_any");
  check("asked $250: a deal for one and not the other, so it differs", decisionRelevance(250, xbox, isDeal) === "differs");
  check("a candidate with no value cannot be judged", decisionRelevance(250, [{ name: "x", valueUsd: null }], isDeal) === "unknown");

  section("a deal under every candidate is never researched");
  {
    const calls: RungId[] = [];
    const r = await resolveIdentity(newLadderState(), { listingId: "a", askingUsd: 200, start: id(xbox, "likely"), evidenceKey: "1", isDeal, rungs: { all_photos: rung(calls, "all_photos", { candidates: xbox, confidence: "vague", found: "x" }) } });
    check("no rung ran, it stopped as not relevant, and (the candidates being known) it may alert at the lowest value", calls.length === 0 && r.stop === "not_relevant" && r.mayAlert && r.valueUsd === 300, r);
    const v = await resolveIdentity(newLadderState(), { listingId: "a2", askingUsd: 200, start: id(xbox, "vague"), evidenceKey: "1", isDeal, rungs: {} });
    check("but a VAGUE identity never alerts, even when every guess would be a deal", v.stop === "not_relevant" && !v.mayAlert);
  }
  {
    const calls: RungId[] = [];
    const r = await resolveIdentity(newLadderState(), { listingId: "b", askingUsd: 350, start: id(xbox), evidenceKey: "1", isDeal, rungs: { all_photos: rung(calls, "all_photos", { candidates: xbox, confidence: "vague", found: "x" }) } });
    check("not a deal under any candidate: no research either, and no alert", calls.length === 0 && r.stop === "not_relevant" && !r.mayAlert);
  }

  section("the ladder stops at the first confident rung, cheapest first");
  {
    const calls: RungId[] = [];
    const r = await resolveIdentity(newLadderState(), {
      listingId: "c", askingUsd: 250, start: id(xbox), evidenceKey: "1", isDeal,
      rungs: {
        text_and_specifics: rung(calls, "text_and_specifics", { candidates: xbox, confidence: "vague", found: "the title does not say disc or digital" }),
        all_photos: rung(calls, "all_photos", { candidates: [xbox[0]], confidence: "settled", found: "a disc slot is visible in photo 3" }),
        labels_and_codes: rung(calls, "labels_and_codes", { candidates: [xbox[1]], confidence: "settled", found: "should not run" }),
      },
    });
    check("text first, then photos; it stopped there and the dearer rung never ran", calls.join() === "text_and_specifics,all_photos" && r.stop === "settled" && r.identity.candidates[0].name === "Xbox Series X (Black)" && r.stepsUsed === 2);
    check("settled: it may alert, at the settled model's value", r.mayAlert && r.valueUsd === 400);
    check("the marker is empty once settled", vagueMarker(r.identity) === "");
  }

  section("still vague: lowest candidate, no alert, and the marker says what is missing and what was tried");
  {
    const mac = [{ name: "MacBook Air M1", valueUsd: 500 }, { name: "MacBook Air M2", valueUsd: 800 }];
    const calls: RungId[] = [];
    const r = await resolveIdentity(newLadderState(), {
      listingId: "d", askingUsd: 450, start: id(mac, "vague", ["the A-number on the underside"]), evidenceKey: "1", isDeal,
      rungs: { text_and_specifics: rung(calls, "text_and_specifics", { candidates: mac, confidence: "vague", found: "no chip named in the title", missing: ["the A-number on the underside"] }) },
    });
    check("priced at the lowest candidate, never alerts, and ran out of rungs", r.valueUsd === 500 && !r.mayAlert && r.stop === "out_of_rungs");
    check("the marker names what is missing and what was tried", /Vague\./.test(vagueMarker(r.identity)) && /A-number/.test(vagueMarker(r.identity)) && /no chip named/.test(vagueMarker(r.identity)), vagueMarker(r.identity));
  }

  section("budgets, cache and re-check never loop");
  {
    const air = [{ name: "AirPods Pro (1st generation)", valueUsd: 120 }, { name: "AirPods Pro (2nd generation)", valueUsd: 180 }];
    const state = newLadderState();
    let n = 0;
    const slow = (name: RungId): Rung => async () => { n++; return { candidates: air, confidence: "vague", found: `${name} found nothing` }; };
    const all = { text_and_specifics: slow("text_and_specifics"), all_photos: slow("all_photos"), labels_and_codes: slow("labels_and_codes"), image_search: slow("image_search"), line_research: slow("line_research") };
    const t0 = 1_000_000;
    const base = { listingId: "e", askingUsd: 110, start: id(air), evidenceKey: "v1", isDeal, rungs: all, now: t0 };
    const first = await resolveIdentity(state, base);
    check("a listing spends at most its per-listing budget", n === DEFAULT_BUDGET.perListing && first.stop === "budget_listing", { n, stop: first.stop });
    const again = await resolveIdentity(state, { ...base, now: t0 + 60_000 });
    check("asked again with nothing new it waits and spends nothing", n === DEFAULT_BUDGET.perListing && again.stop === "waiting" && again.stepsUsed === 0);
    const later = await resolveIdentity(state, { ...base, now: t0 + RETRY_WAIT_MS + 1 });
    check("after the wait, with nothing new, the cached answer stands (still no spend)", n === DEFAULT_BUDGET.perListing && later.stop === "cached");
    const fresh = await resolveIdentity(state, { ...base, evidenceKey: "v2", now: t0 + RETRY_WAIT_MS + 2 });
    check("new evidence (a new photo) allows another look, again bounded", n > DEFAULT_BUDGET.perListing && n <= DEFAULT_BUDGET.perListing * 2 && fresh.stepsUsed > 0, { n });
    const s2 = newLadderState();
    let m = 0;
    const counting: Rung = async () => { m++; return { candidates: air, confidence: "vague", found: "x" }; };
    for (let i = 0; i < 30; i++) await resolveIdentity(s2, { listingId: `l${i}`, askingUsd: 110, start: id(air), evidenceKey: "k", isDeal, rungs: { text_and_specifics: counting }, budget: { perListing: 3, perDay: 10 }, now: t0 });
    check("the day's total is capped across listings", m === 10, m);
    await resolveIdentity(s2, { listingId: "next-day", askingUsd: 110, start: id(air), evidenceKey: "k", isDeal, rungs: { text_and_specifics: counting }, budget: { perListing: 3, perDay: 10 }, now: t0 + 86_400_000 });
    check("a new day starts the count again", m === 11, m);
  }
});
