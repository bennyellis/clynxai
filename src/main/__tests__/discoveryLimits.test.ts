// Database discovery limits: the research budgets, the queue's concurrency and priority, and recovery from failures.
// Budgets and failures use the real evaluateListing route with the shared fakes; the market-lookup budget uses the benchmark corpus.
import { check, run, section } from "./_testkit.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, resetNetwork, searchItem, setAiReply, summary } from "./_fixtures.js";
import { runBench, score } from "./_discoveryBench.js";

async function idle(engine: any): Promise<void> {
  for (let i = 0; i < 300 && (engine.visionJobs.length > 0 || engine.visionWorkersActive > 0); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}
const tick = () => new Promise((r) => setImmediate(r));

const VAGUE_UNSURE = { isPotentialDeal: false, category: "", confidence: "low", conditionImpact: "none", reasoning: "can't tell", offTopicSuggestion: null, estimatedValueRangeUsd: "" };

async function scan(engineHarness: ReturnType<typeof makeEngine>, titles: string[], price = 100) {
  for (const [i, t] of titles.entries()) {
    engineHarness.engine.detailToLoad = detail(t, price, { id: `l${i}`, imageUrls: ["https://img.test/x.jpg"] } as never);
    await (engineHarness.engine as any).evaluateListing(FAKE_PAGE, summary(t, price, `l${i}`), engineHarness.config);
  }
}

run(async () => {
  installFetchStub();

  section("budget: extra photo looks per location visit");
  {
    resetNetwork();
    setAiReply(VAGUE_UNSURE);
    const store = makeStore();
    const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" } }) });
    let pipelineRuns = 0;
    (h.engine as any).runPostScoringPipeline = async () => void pipelineRuns++;
    await scan(h, ["Old stuff one", "Old stuff two", "Old stuff three", "Old stuff four", "Old stuff five"]);
    await idle(h.engine);
    const byId = (id: string) => store.saved.filter((s) => s.listing.id === id).pop()!;
    const queued = [0, 1, 2, 3, 4].filter((i) => byId(`l${i}`).research?.code === "PHOTOS_QUEUED").length;
    const capped = [0, 1, 2, 3, 4].filter((i) => byId(`l${i}`).research?.code === "LOOK_BUDGET").length;
    check("five vague listings in one visit: the first 3 are looked at, the other 2 say the allowance was used (3 per visit)", queued === 3 && capped === 2, { queued, capped });
    check("the capped ones are 'not researched', not a rejection", [3, 4].every((i) => byId(`l${i}`).research?.status === "unresearched"));
    (h.engine as any).beginLocationVisit();
    await scan(h, ["Old stuff six"]);
    check("the next location starts with a fresh allowance", byId("l0").research !== undefined && store.saved.filter((s) => s.research?.code === "PHOTOS_QUEUED").length >= 4);
  }

  section("budget: the whole pass");
  {
    resetNetwork();
    setAiReply(VAGUE_UNSURE);
    const store = makeStore();
    const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" }, discovery: { speculativeLooksPerLocation: 5, speculativeLooksPerPass: 2 } }) });
    (h.engine as any).runPostScoringPipeline = async () => {};
    await scan(h, ["Old stuff a", "Old stuff b", "Old stuff c"]);
    const codes = [0, 1, 2].map((i) => store.saved.filter((s) => s.listing.id === `l${i}`).pop()!.research?.code);
    check("a pass allowance of 2 stops the third look even though the location allowance is 5", codes.join() === "PHOTOS_QUEUED,PHOTOS_QUEUED,LOOK_BUDGET", codes);
    (h.engine as any).beginLocationVisit();
    await scan(h, ["Old stuff d"]);
    check("a new location does not reset the pass total", store.saved.filter((s) => s.listing.id === "l0").pop()!.research?.code === "LOOK_BUDGET");
  }

  section("budget: nothing is looked at when the allowance is 0, and cheap listings are never worth a look");
  {
    resetNetwork();
    setAiReply(VAGUE_UNSURE);
    const store = makeStore();
    const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" }, discovery: { speculativeLooksPerLocation: 0 } }) });
    (h.engine as any).runPostScoringPipeline = async () => {};
    await scan(h, ["Old stuff"]);
    check("allowance 0: not looked at", store.saved.pop()!.research?.code === "LOOK_BUDGET");
    const h2 = makeEngine({ store: makeStore(), config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" } }) });
    (h2.engine as any).runPostScoringPipeline = async () => {};
    await scan(h2, ["Old stuff"], 20);
    check("$20: too little for a look", (h2.store.saved.pop()!.research?.code) === "LOW_PRICE");
  }

  section("budget: fresh market lookups for a product only the photos named");
  {
    const open = await runBench({ lowAiMode: true });
    const none = await runBench({ lowAiMode: true, config: { discovery: { marketLooksPerLocation: 0 } } });
    const one = await runBench({ lowAiMode: true, config: { discovery: { marketLooksPerLocation: 5, marketLooksPerPass: 1 } } });
    const found = (r: typeof open) => ["g8", "g9"].filter((id) => r.outcomes.find((o) => o.id === id)!.surfaced).length;
    check("default allowance: both photo-named products (headphones, Steam Deck) get a market check and are found", found(open) === 2, found(open));
    check("allowance 0: neither is looked up, and each says so (not enough evidence, NO_RESALE_NUMBERS), never a rejection", found(none) === 0 && ["g8", "g9"].every((id) => none.outcomes.find((o) => o.id === id)!.researchCode === "NO_RESALE_NUMBERS"), none.outcomes.filter((o) => ["g8", "g9"].includes(o.id)).map((o) => o.researchCode));
    check("a pass allowance of 1: exactly one", found(one) === 1, found(one));
    check("fewer market checks are made with the smaller allowance", none.ai.market < one.ai.market && one.ai.market < open.ai.market, [none.ai.market, one.ai.market, open.ai.market]);
    check("the Database-known products are still found for free with no market allowance", ["g1", "g4", "g5"].every((id) => none.outcomes.find((o) => o.id === id)!.surfaced) && score(none).falseDeals === 0);
  }

  section("queue concurrency");
  {
    const h = makeEngine();
    const e = h.engine as any;
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      e.enqueueVisionJob(3, () => {
        running++;
        peak = Math.max(peak, running);
        return new Promise<void>((resolve) => gates.push(() => { running--; resolve(); }));
      });
    }
    await tick();
    check("never more than 2 research jobs run at once, however many are waiting", peak === 2 && running === 2 && e.visionJobs.length === 8, { peak, running, waiting: e.visionJobs.length });
    for (let i = 0; i < 10; i++) {
      while (gates.length === 0) await tick();
      gates.shift()!();
      await tick();
    }
    await idle(e);
    check("all ten ran and the queue emptied", running === 0 && e.visionJobs.length === 0 && e.visionWorkersActive === 0 && peak === 2, { running, peak });
  }

  section("queue: a stuck job does not stop the others");
  {
    const h = makeEngine();
    const e = h.engine as any;
    const ran: string[] = [];
    e.enqueueVisionJob(0, () => new Promise<void>(() => {})); // never finishes
    for (let i = 0; i < 5; i++) e.enqueueVisionJob(1, async () => void ran.push(`j${i}`));
    await idle(e);
    check("the second worker works through everything else", ran.length === 5, ran);
    check("the stuck job occupies one worker and nothing more", e.visionWorkersActive === 1);
  }

  section("failure recovery");
  {
    // the photo look itself fails (the photos cannot be downloaded): not enough evidence, never a rejection
    resetNetwork();
    setAiReply(VAGUE_UNSURE);
    const store = makeStore({ listProductsWithImages: () => [], listPrioritizedProductsWithImages: () => [], listProductImages: () => [] });
    const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" } }) });
    await scan(h, ["Old stuff"]);
    await idle(h.engine);
    const last = store.saved[store.saved.length - 1];
    check("a failed photo look leaves the listing 'not enough evidence (PHOTO_ANALYSIS_FAILED)'", last.research?.status === "insufficient_evidence" && last.research.code === "PHOTO_ANALYSIS_FAILED" && /not a verdict/.test(last.research.reason), last.research);
  }
  {
    // the AI service is unavailable (no key): no text read and no photo look are possible, and it is not called a rejection
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      resetNetwork();
      const store = makeStore();
      const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, generalDeal: { enabled: true, minConfidence: "medium" } }) });
      await scan(h, ["Old stuff"], 100);
      await idle(h.engine);
      const last = store.saved[store.saved.length - 1];
      check("with no AI access the listing says AI_UNAVAILABLE, 'not a rejection'", last.research?.code === "AI_UNAVAILABLE" && last.research.status === "insufficient_evidence" && /not a rejection/i.test(last.research.reason), last.research);
    } finally {
      if (key !== undefined) process.env.OPENAI_API_KEY = key;
    }
  }
  {
    // a store that cannot record the failure must not turn into an unhandled error
    const store = makeStore({
      setResearch: () => {
        throw new Error("disk full");
      },
      getById: () => ({ id: "l0" }),
    });
    const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, searchItems: [searchItem("Xbox Series S", 260)] }) });
    (h.engine as any).runPostScoringPipeline = async () => {
      throw new Error("boom");
    };
    let unhandled = false;
    const onUnhandled = () => void (unhandled = true);
    process.on("unhandledRejection", onUnhandled);
    await scan(h, ["Xbox Series S"], 100);
    await idle(h.engine);
    await new Promise((r) => setTimeout(r, 30));
    process.off("unhandledRejection", onUnhandled);
    check("even then, nothing escapes and the queue is free again", !unhandled && (h.engine as any).visionWorkersActive === 0);
  }
});
