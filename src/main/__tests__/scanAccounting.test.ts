// Discovery investigation (Activity log): "found 18 listings" with 0-1 evaluated, general discovery switched off by adding a Search For item, research
// results arriving minutes after the location was left, and research lost when a market check timed out. Offline: fake store, fake network, no browser.
import fs from "node:fs";
import path from "node:path";
import { listingOrigin } from "../scrapeEngine.js";
import { settleLateMarketCheck } from "../marketCheckSettle.js";
import { PassAccount, type ListingOutcome } from "../passAccount.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, searchItem, summary } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

async function judge(h: ReturnType<typeof makeEngine>, title: string, price: number | null, id: string, over: { seen?: boolean } = {}) {
  h.engine.detailToLoad = detail(title, price, { listingAge: "2 hours ago" });
  return (h.engine as any).evaluateListing(FAKE_PAGE, { ...summary(title, price ?? 0, id), price }, h.config);
}

run(async () => {
  installFetchStub();

  section("every listing a pass finds is in exactly one bucket");
  {
    const a = new PassAccount("General browse at Austin, TX", 18);
    a.setCandidates(18);
    for (let i = 0; i < 8; i++) a.record("already_seen");
    for (let i = 0; i < 6; i++) a.record("skipped_before_opening");
    for (let i = 0; i < 2; i++) a.record("opened");
    a.settle(false);
    check("8 seen + 6 skipped + 2 opened + 2 left for later = 18", a.balanced && a.accounted === 18, a.describe());
    check("the line says what happened to each group", /8 already seen/.test(a.describe()) && /6 skipped before opening/.test(a.describe()) && /2 opened and judged/.test(a.describe()) && /2 left for the next pass/.test(a.describe()), a.describe());

    const f = new PassAccount("Search for xbox at Montpelier, VT", 10);
    f.setCandidates(3);
    f.record("opened");
    f.settle(true);
    check("relevance-filtered ones are counted (7 not relevant), the rest left unvisited when interrupted", f.balanced && /7 not relevant/.test(f.describe()) && /2 left unvisited/.test(f.describe()), f.describe());

    const none = new PassAccount("General browse at Augusta, ME", 18);
    none.setCandidates(18);
    none.settle(false);
    check("nothing looked at still adds up (all left for later)", none.balanced && /18 left for the next pass/.test(none.describe()), none.describe());
    const outcomes: ListingOutcome[] = ["opened", "skipped_before_opening", "already_seen", "no_price", "load_failed", "other"];
    const all = new PassAccount("x", outcomes.length);
    all.setCandidates(outcomes.length);
    outcomes.forEach((o) => all.record(o));
    all.settle(false);
    check("every outcome kind is counted once", all.balanced, all.describe());
  }

  section("the real evaluation reports WHY a listing left the pass (the silent exits are now named)");
  {
    const config = baseConfig({ searchItems: [searchItem("Xbox Series S", 300)], generalDeal: { enabled: true, minConfidence: "medium" } });
    const seen = new Set<string>(["old1"]);
    const h = makeEngine({ config, store: makeStore({ hasSeenCached: (id: string) => seen.has(id) }) });
    const duplicate = await judge(h, "Xbox Series S", 120, "old1");
    check("already seen -> already_seen (silent before)", !duplicate.counted && duplicate.outcome === "already_seen", duplicate);
    const noPrice = await judge(h, "Xbox Series S", null, "np1");
    check("no price -> no_price (silent before)", !noPrice.counted && noPrice.outcome === "no_price", noPrice);
    const placeholder = await judge(h, "Xbox Series S", 1, "ph1");
    check("a placeholder price is a skip before opening", !placeholder.counted && placeholder.outcome === "skipped_before_opening", placeholder);
    const normal = await judge(h, "Xbox Series S", 120, "ok1");
    check("a normal listing is opened and counted", normal.counted === true, normal);
  }

  section("general deal detection and a Search For item coexist");
  {
    const config = baseConfig({ searchItems: [searchItem("xbox", 300)], generalDeal: { enabled: true, minConfidence: "medium" } });
    const h = makeEngine({ config });
    const unrelated = await judge(h, "Apple iPhone 16 Pro 128 GB", 450, "ip1");
    check("with general detection on, an unrelated listing is still evaluated (not 'not one of your focused Search For items')", unrelated.counted === true && !h.logs.some((l) => /not one of your focused/.test(l.message)), h.logs.map((l) => l.message));
    const off = makeEngine({ config: baseConfig({ searchItems: [searchItem("xbox", 300)], generalDeal: { enabled: false, minConfidence: "medium" } }) });
    const skipped = await judge(off, "Apple iPhone 16 Pro 128 GB", 450, "ip2");
    check("only when the user turned it off is it skipped, and that is still accounted for", skipped.outcome === "skipped_before_opening" && off.logs.some((l) => /not one of your focused/.test(l.message)));

    const src = fs.readFileSync(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    check("adding a Search For item no longer switches general detection off anywhere", !/generalDeal:\s*\{\s*\.\.\.config\.generalDeal,\s*enabled:\s*false\s*\}/.test(src));
    check("the only code that changes it is the explicit tool, using the user's choice", /generalDeal:\s*\{\s*\.\.\.config\.generalDeal,\s*enabled\s*\}/.test(src));
    const chat = fs.readFileSync(path.join(process.cwd(), "src/main/chat.ts"), "utf8");
    check("the chat is told adding a product is not a request to turn it off", /Adding or searching for a product is NOT such a request/.test(chat) && /Never call it merely because the user added or asked to search for a product/.test(chat));
  }

  section("a result that arrives after the scanner left its location is attributed to that location, not counted into the current one");
  {
    const h = makeEngine();
    const engine = h.engine as any;
    engine.beginLocationVisit();
    engine.visitLabel = "Richmond, VA";
    const origin = { visit: engine.visitSeq, label: "Richmond, VA", title: "Xbox series S", at: Date.now() - 3 * 60_000 };
    engine.beginLocationVisit();
    engine.visitLabel = "Montpelier, VT";
    listingOrigin.run(origin, () => engine.tally({ status: "insufficient_evidence", code: "AI_UNVERIFIED" }));
    const late = h.logs.find((l) => /Late research result/.test(l.message));
    check("a late line names the listing, where it was found and how long ago", !!late && /Xbox series S/.test(late.message) && /Richmond, VA/.test(late.message) && /3 min ago/.test(late.message), late?.message);
    check("it carries the outcome", !!late && /AI_UNVERIFIED/.test(late.message));
    h.logs.length = 0;
    engine.beginLocationVisit();
    check("it is not counted into the next location's summary", !h.logs.some((l) => /Discovery summary/.test(l.message)), h.logs.map((l) => l.message));
    const same = { ...origin, visit: engine.visitSeq, label: "Salem, OR" };
    listingOrigin.run(same, () => engine.tally({ status: "researched", code: "OK" }));
    engine.beginLocationVisit();
    check("research that finishes while its own location is still current is counted normally", h.logs.some((l) => /Discovery summary.*1 researched/.test(l.message)), h.logs.map((l) => l.message));
  }

  section("a market check that timed out still files its answer (the entry it created is no longer deleted under it)");
  {
    const log: string[] = [];
    const deleted: string[] = [];
    let filled = 0;
    const settle = (research: Promise<{ estimatedValueUsd: number | null; avgSoldPriceUsd: number | null }>, created: boolean) =>
      settleLateMarketCheck({ research, created, productId: "p1", deleteProduct: (id) => void deleted.push(id), fillIn: () => void filled++, note: (m) => void log.push(m) });
    let resolveLate!: (v: { estimatedValueUsd: number | null; avgSoldPriceUsd: number | null }) => void;
    const late = new Promise<{ estimatedValueUsd: number | null; avgSoldPriceUsd: number | null }>((r) => (resolveLate = r));
    settle(late, true);
    await Promise.resolve();
    check("while the check is still running nothing is deleted", deleted.length === 0 && filled === 0);
    resolveLate({ estimatedValueUsd: 150, avgSoldPriceUsd: null });
    await new Promise((r) => setTimeout(r, 5));
    check("when the late answer has prices the entry is kept and filled in", deleted.length === 0 && filled === 1 && /prices were filed/.test(log[0] ?? ""), { deleted, filled, log });

    deleted.length = 0;
    settle(Promise.resolve({ estimatedValueUsd: null, avgSoldPriceUsd: null }), true);
    await new Promise((r) => setTimeout(r, 5));
    check("no prices: the entry created for it is removed (as if it had finished in time)", deleted.join() === "p1");

    deleted.length = 0;
    settle(Promise.reject(new Error("boom")), true);
    await new Promise((r) => setTimeout(r, 5));
    check("a failure removes the entry that was created for it", deleted.join() === "p1");

    deleted.length = 0;
    filled = 0;
    settle(Promise.resolve({ estimatedValueUsd: null, avgSoldPriceUsd: null }), false);
    settle(Promise.reject(new Error("boom")), false);
    await new Promise((r) => setTimeout(r, 5));
    check("an entry that already existed is never deleted", deleted.length === 0 && filled === 0);
  }
});
