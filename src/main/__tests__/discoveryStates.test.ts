// Database discovery: where a listing stands is always recorded, a skipped listing says why, and a failed research job does not leave a listing
// "waiting for its photos" for ever. Uses the real evaluateListing route with the shared fakes (no browser, no network).
import { check, run, section } from "./_testkit.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, resetNetwork, searchItem, summary } from "./_fixtures.js";

async function idle(engine: any): Promise<void> {
  for (let i = 0; i < 200 && (engine.visionJobs.length > 0 || engine.visionWorkersActive > 0); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}

run(async () => {
  installFetchStub();
  resetNetwork();

  section("a price that is not a multiple of 5 no longer ends a listing that names something tracked");
  {
    const store = makeStore();
    const h = makeEngine({ store, config: baseConfig({ searchItems: [searchItem("Xbox Series S", 260)] }) });
    h.engine.detailToLoad = detail("Xbox Series S 512GB Console", 71);
    await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Xbox Series S 512GB Console", 71), h.config);
    await idle(h.engine);
    const last = store.saved[store.saved.length - 1];
    check("it was opened and judged (a search match at $71 against a $260 reference is a deal)", !!last && last.isDeal === true, last && { isDeal: last.isDeal, why: last.extraction.reasoning });
    check("and it does not claim to have been skipped for its price", last?.research?.code !== "PRICE_SHAPE", last?.research);
  }

  section("an unremarkable title at that price is opened too: the price shape is never a reason to skip");
  {
    const store = makeStore();
    const h = makeEngine({ store, config: baseConfig({ searchItems: [searchItem("Xbox Series S", 260)] }) });
    h.engine.detailToLoad = detail("Baby clothes bundle", 47);
    await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Baby clothes bundle", 47), h.config);
    await idle(h.engine);
    const last = store.saved[store.saved.length - 1];
    check("the detail page was opened", !h.logs.some((l) => /Failed to load detail/.test(l.message)));
    check("it was judged like any other listing and says where it stands", !!last?.research && last.research.code !== "PRICE_SHAPE" && last.research.code !== "SKIPPED_BEFORE_OPENING", last?.research);
  }

  section("a rule that rejects outright says rejected, not 'not researched'");
  {
    const store = makeStore();
    const h = makeEngine({ store, config: baseConfig() });
    await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Free stuff", 1), h.config);
    const last = store.saved[store.saved.length - 1];
    check("a placeholder price is rejected", last?.research?.status === "rejected" && last.research.code === "PLACEHOLDER_PRICE", last?.research);
  }

  section("a research job that fails does not leave the listing waiting for ever");
  {
    const marked: Array<{ id: string; d: { status: string; code: string; reason: string } }> = [];
    const store = makeStore({ setResearch: (id: string, d: never) => void marked.push({ id, d }), getById: (id: string) => ({ id }) });
    const h = makeEngine({ store, config: baseConfig({ photoAnalysis: { enabled: true }, searchItems: [searchItem("Xbox Series S", 260)] }) });
    (h.engine as any).runPostScoringPipeline = async () => {
      throw new Error("boom");
    };
    h.engine.detailToLoad = detail("Xbox Series S", 120, { imageUrls: ["https://img.test/1.jpg"] });
    await (h.engine as any).evaluateListing(FAKE_PAGE, summary("Xbox Series S", 120), h.config);
    check("it was saved as waiting for its photos", store.saved[0]?.research?.code === "PHOTOS_QUEUED", store.saved[0]?.research);
    await idle(h.engine);
    check("then marked as missing evidence, with the error, not a verdict", marked.length === 1 && marked[0].d.status === "insufficient_evidence" && marked[0].d.code === "RESEARCH_FAILED" && /boom/.test(marked[0].d.reason) && /not a verdict/.test(marked[0].d.reason), marked);
  }

  section("the allowances reset with each location, so one busy location cannot starve the next");
  {
    const h = makeEngine();
    const e = h.engine as any;
    e.speculativeLooksThisVisit = 3;
    e.marketLooksThisVisit = 2;
    e.speculativeLooksThisPass = 7;
    e.beginLocationVisit();
    check("per-visit counters reset, the pass total does not", e.speculativeLooksThisVisit === 0 && e.marketLooksThisVisit === 0 && e.speculativeLooksThisPass === 7);
  }
});
