// Database discovery, end to end through the real ScrapeEngine (scripted AI, virtual clock, fake Database; see _discoveryBench.ts).
// The numbers this asserts on were measured on the code before the fix with the same corpus: recall 6/16 (38%), 2 badly named products filed,
// no listing carried a reason, and (with the AI saving off) an average wait of 103 s for a listing's photo research.
import { getMetricsSnapshot, resetMetrics } from "../metrics.js";
import { CORPUS, runBench, score, type BenchResult } from "./_discoveryBench.js";
import { check, run, section } from "./_testkit.js";
import { makeEngine } from "./_fixtures.js";

const out = (r: BenchResult, id: string) => r.outcomes.find((o) => o.id === id)!;
const event = (name: string) => getMetricsSnapshot().events.find((e) => e.name === name)?.total ?? 0;

run(async () => {
  resetMetrics();
  const on = await runBench({ lowAiMode: true });
  const s = score(on);
  const speculativeLooks = event("speculative_look");

  section('default settings ("Save OpenAI credits" on): profitable listings are found');
  check(`recall of profitable listings is at least 90% (${s.surfacedProfitable}/${s.profitable})`, s.recall >= 0.9, s.recall);
  check("every one of them was opened (a price that is not a multiple of 5 no longer ends a listing that names something known)", on.outcomes.filter((o) => ["g2", "g3"].includes(o.id)).every((o) => o.opened));
  for (const id of ["g4", "g5", "g8", "g9"]) {
    const o = out(on, id);
    check(`${id} "${o.title}": a vague title, found from its photos`, o.surfaced && o.visionCalls === 1 && o.identified.length > 0, o);
  }
  check("g11: the text AI was unsure of the model, the photos settled it", out(on, "g11").surfaced);
  check("f1: an unreadable AI answer is retried once and the listing is judged normally", out(on, "f1").surfaced && out(on, "f1").visionCalls === 1);
  check("f2: an AI that never answers does not cost the listing; its photos are looked at", out(on, "f2").surfaced);

  section("nothing bad is surfaced, nothing is filed under the wrong name");
  check("no false deals", s.falseDeals === 0, s.falseDealDetail);
  check("no product filed under the wrong identity", s.wrongProductFilings === 0, s.filingDetail);
  check("no badly named product filed", s.badNameFilings === 0, s.filingDetail);
  check("a PS5 title with only a controller in the photos is rejected for what the photos show", out(on, "m1").researchCode === "PHOTOS_MISMATCH" && !out(on, "m1").surfaced);
  check("a Series X title on a Series S is rejected, and not valued as a Series X", out(on, "m2").researchCode === "PHOTOS_MISMATCH" && !out(on, "m2").surfaced && !out(on, "m2").identified.includes("Xbox Series X"));
  check("a Switch title with only a dock in the photos is rejected", out(on, "m3").researchCode === "PHOTOS_MISMATCH");
  check("the accessories the AI named are not filed (power adapter, screen protector)", !on.filings.some((f) => /adapter|protector/i.test(f.product)), on.filings);
  check('"(front view)" is not part of a filed name', !on.filings.some((f) => /view/i.test(f.product)) && on.filings.some((f) => f.product === "iPhone 13 128GB"), on.filings);
  check("the bundle sentence is not part of a filed name", !on.filings.some((f) => /bundle|includes/i.test(f.product)), on.filings);

  section("every listing that is not a deal says why, and the four ways of not being a deal are told apart");
  check("no listing is left without a reason", s.insufficientButUnlabelled === 0, on.outcomes.filter((o) => !o.surfaced && !o.researchStatus).map((o) => o.id));
  check("overpriced items the Database has numbers for: confirmed unprofitable", ["b1", "b2", "b3"].every((id) => out(on, id).researchStatus === "confirmed_unprofitable"), ["b1", "b2", "b3"].map((id) => out(on, id).researchStatus));
  check("overpriced items judged only by the AI's estimate: rejected, not 'confirmed'", ["b4", "b5"].every((id) => out(on, id).researchStatus === "rejected" && out(on, id).researchCode === "AI_ESTIMATE"));
  check("photos that show nothing nameable: not enough evidence", out(on, "u1").researchStatus === "insufficient_evidence" && out(on, "u2").researchStatus === "insufficient_evidence");
  check("a name the AI gave that cannot be filed: not enough evidence (NAME_REFUSED)", out(on, "n1").researchCode === "NAME_REFUSED");
  check("a price that is not a multiple of 5 never ends a listing: j5 ($47) was opened and judged", out(on, "j5").opened && out(on, "j5").researchCode !== "PRICE_SHAPE", out(on, "j5"));
  check("g13 (vague title AND $97) is opened, looked at and found", out(on, "g13").opened && out(on, "g13").surfaced && out(on, "g13").visionCalls === 1, out(on, "g13"));
  check("no listing in the corpus is skipped without being opened because of its price", on.outcomes.every((o) => o.opened), on.outcomes.filter((o) => !o.opened).map((o) => o.id));
  check("a deal says it was researched", out(on, "g4").researchStatus === "researched" && out(on, "g4").researchCode === "DEAL");

  section("the credit saving still holds");
  check(`extra photo looks stay inside the allowance (${speculativeLooks} of at most 3 per location x 4 locations)`, speculativeLooks <= 12 && speculativeLooks > 0, speculativeLooks);
  {
    const none = await runBench({ lowAiMode: true, config: { discovery: { speculativeLooksPerLocation: 0, marketLooksPerLocation: 0 } } });
    const sn = score(none);
    const looked = none.outcomes.filter((o) => o.visionCalls > 0);
    check("with the allowance at 0 no listing gets an extra look (only deals / near matches / Watch candidates do)", looked.every((o) => ["g1", "g2", "g3", "g6", "g7", "g10", "g12", "m1", "m2", "m3", "n2", "n3"].includes(o.id) || o.surfaced), looked.map((o) => o.id));
    check("and then a vague title is reported as not researched because of the allowance, not as a rejection", out(none, "g4").researchStatus === "unresearched" && out(none, "g4").researchCode === "LOOK_BUDGET", out(none, "g4"));
    check(`it costs less than the default (${none.spendUsd.toFixed(3)} vs ${on.spendUsd.toFixed(3)} estimated dollars)`, none.spendUsd < on.spendUsd);
    check("and still finds what the older code found", sn.surfacedProfitable >= 6, sn.surfacedProfitable);
  }

  section("AI saving off: the photo looks that were thrown away are used");
  resetMetrics();
  const off = await runBench({ lowAiMode: false });
  const so = score(off);
  check(`recall ${so.surfacedProfitable}/${so.profitable} (it was 6/16 although 14 of the 16 had been looked at)`, so.recall >= 0.9);
  check("no false deals, no wrong or badly named filings", so.falseDeals === 0 && so.wrongProductFilings === 0 && so.badNameFilings === 0, [so.falseDealDetail, so.filingDetail]);

  section("research queue: waits are short and the deals go first");
  check(`average wait for a free worker is under 40 s (it was 103 s with one worker); measured ${so.avgQueueWaitS.toFixed(0)} s`, so.avgQueueWaitS < 40, so.avgQueueWaitS);
  check(`the longest wait is under 100 s (it was 172 s); measured ${so.maxQueueWaitS.toFixed(0)} s`, so.maxQueueWaitS < 100, so.maxQueueWaitS);
  check("two photo looks run at the same time (they are network waits, not Facebook requests)", off.ai.maxInFlight >= 2, off.ai.maxInFlight);
  {
    // Both workers busy; a speculative look, a deal and a Watch candidate queue up behind them. The deal starts first, then the Watch candidate.
    const h = makeEngine();
    const engine = h.engine as any;
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const job = (name: string) => () =>
      new Promise<void>((resolve) => {
        started.push(name);
        gates.set(name, resolve);
      });
    engine.enqueueVisionJob(3, job("busy1"));
    engine.enqueueVisionJob(3, job("busy2"));
    engine.enqueueVisionJob(2, job("speculative"));
    engine.enqueueVisionJob(0, job("deal"));
    engine.enqueueVisionJob(1, job("watch"));
    check("two workers: the first two start at once and the rest wait", started.join() === "busy1,busy2", started);
    gates.get("busy1")!();
    await new Promise((r) => setImmediate(r));
    gates.get("busy2")!();
    await new Promise((r) => setImmediate(r));
    check("a deal is served before a Watch candidate, and a Watch candidate before a speculative look", started.join() === "busy1,busy2,deal,watch", started);
    gates.get("deal")!();
    await new Promise((r) => setImmediate(r));
    check("then the speculative look", started.join() === "busy1,busy2,deal,watch,speculative", started);
    gates.get("watch")!();
    gates.get("speculative")!();
    await new Promise((r) => setImmediate(r));
    check("a job that fails does not stop the queue", await (async () => {
      let ran = false;
      engine.enqueueVisionJob(0, () => Promise.reject(new Error("boom")));
      engine.enqueueVisionJob(0, async () => void (ran = true));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return ran;
    })());
  }
  check("every run drained its queue", on.drainSpanMs >= 0 && off.drainSpanMs >= 0);
  check("the corpus was complete", CORPUS.length === on.outcomes.length);
});
