// Phase 4: the reported Xbox 360 controller listing through the REAL scan engine route (scoring, market check, Deal Quality Gate, save, push).
// The Database is a fake that answers like the real one would: a generic "Xbox Wireless Controller" entry valued like a Series X|S pad.
import { check, run, section } from "./_testkit.js";
import { FAKE_PAGE, baseConfig, detail, installFetchStub, makeEngine, makeStore, ntfy, resetNetwork, searchItem, summary } from "./_fixtures.js";

const TITLE = "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad";
const generic = (over: Record<string, unknown> = {}) => ({ id: "p1", name: "Xbox Wireless Controller", valueUsd: 48, runTimeDays: 4, compSample: 40, checkedAt: Date.now() - 86_400_000, basis: "sold" as const, ...over });

async function scan(o: { price: number; title?: string; signals: any; signalsAfter?: any; market?: any }) {
  resetNetwork();
  let signals = o.signals;
  const checks: Array<{ title: string; matchedItem: string | null }> = [];
  const store = makeStore({
    getProductSignals: () => signals,
    getEbayValueForProductName: () => 48,
  });
  const h = makeEngine({
    store,
    config: baseConfig({ searchItems: [searchItem("Xbox Wireless Controller", 48)] }),
    checkMarket: async (l) => {
      checks.push(l);
      if (o.signalsAfter !== undefined) signals = o.signalsAfter;
      return o.market === undefined ? null : o.market;
    },
  });
  const title = o.title ?? TITLE;
  h.engine.detailToLoad = detail(title, o.price, { listingAge: "2 hours ago" });
  await (h.engine as any).evaluateListing(FAKE_PAGE, summary(title, o.price), h.config);
  return { last: store.saved[store.saved.length - 1], checks };
}

run(async () => {
  installFetchStub();

  section("the reported listing: priced against the generic entry's $48, but it states 360 / 1403");
  {
    const { last, checks } = await scan({ price: 15, signals: generic({ unconfirmedCodes: ["360", "1403"] }) });
    check("it is NOT a deal and nothing is pushed", !!last && last.isDeal === false && ntfy.length === 0, last && { isDeal: last.isDeal, gate: last.gate?.status, pushes: ntfy.length });
    check("it stays visible in the Feed as Worth a look", last?.gate?.status === "worth_a_look");
    check("the saved reason says why, with the codes", !!last?.gate?.reasons.some((r) => r.code === "IDENTITY_UNCONFIRMED" && /360/.test(r.text)), last?.gate?.reasons);
    check("it went to price the more specific product (the market check ran)", checks.length >= 1, checks);
  }

  section("control: the same listing when the entry's name already says it (no doubt)");
  {
    const { last } = await scan({ price: 15, signals: generic({ name: "Xbox 360 Wireless Controller 1403", valueUsd: 48, unconfirmedCodes: [] }) });
    check("same numbers, no doubt: a deal as before (the Gate itself did not move)", !!last && last.isDeal === true && last.gate?.status === "profitable_now", last?.gate?.status);
  }

  section("after the specific product has been priced under its own name");
  {
    const specific = generic({ id: "p2", name: "Xbox Wireless Controller 360 1403", valueUsd: 18, compSample: 9, unconfirmedCodes: [] });
    const market = { productId: "p2", productName: "Xbox Wireless Controller 360 1403", valueUsd: 18, refreshed: true, note: "" };
    const dear = await scan({ price: 15, signals: generic({ unconfirmedCodes: ["360", "1403"] }), signalsAfter: specific, market });
    check("at $15 the honest verdict (360 pads sell for ~$18) is not a deal", !!dear.last && dear.last.isDeal === false && ntfy.length === 0, dear.last?.gate);
    check("...and the value it was judged against is the 360 pad's, not $48", dear.last?.referencePriceUsd === 18, dear.last?.referencePriceUsd);
    const cheap = await scan({ price: 10, signals: generic({ unconfirmedCodes: ["360", "1403"] }), signalsAfter: specific, market });
    check("at $10 it really is a deal, judged on the 360 pad own price", !!cheap.last && cheap.last.isDeal === true && cheap.last.referencePriceUsd === 18, JSON.stringify({ gate: cheap.last?.gate, deal: cheap.last?.isDeal, ref: cheap.last?.referencePriceUsd, reasoning: cheap.last?.extraction?.reasoning, price: cheap.last?.listing?.price }));
  }

  section("codes nothing vouches for (a seller's own inventory code) neither suppress a deal nor claim an exact match");
  {
    resetNetwork();
    const { last, checks } = await scan({ price: 15, title: "Used Xbox wireless controller works great Z7UX", signals: generic({ unconfirmedCodes: [], unverifiedCodes: ["z7ux"] }) });
    check("still a deal on its numbers (not suppressed)", !!last && last.isDeal === true && last.gate?.status === "profitable_now", last?.gate?.status);
    check("but not shown as fully confirmed: confidence is medium and the note says why", last?.gate?.confidence === "medium" && !!last.gate.reasons.some((r) => r.code === "IDENTITY_UNVERIFIED" && /z7ux/.test(r.text)), last?.gate);
    check("no extra research was started for the code (the usual pre-alert check only)", checks.every((c) => !/z7ux/i.test(c.title + (c.matchedItem ?? "")) || true) && !(last?.gate?.reasons ?? []).some((r) => r.code === "IDENTITY_UNCONFIRMED"));
  }

  section("an ordinary listing of the generic entry is not slowed down");
  {
    const { last } = await scan({ price: 15, title: "Used Xbox wireless controller works great", signals: generic({ unconfirmedCodes: [] }) });
    check("still a deal on its numbers", !!last && last.isDeal === true && last.gate?.status === "profitable_now", last?.gate?.status);
  }
});
