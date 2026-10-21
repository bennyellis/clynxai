// Per-entry sold statistics, the green frame on a family's price, and keeping accepted sales per entry. Fake sales only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { soldStats } from "../soldComps/stats.js";
import { hotParentIds, isHot } from "../../renderer/src/lib/hotParents.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";

const DAY = 86_400_000;
run(async () => {
  const now = 1_800_000_000_000;
  section("the numbers");
  const undated = soldStats([{ soldPrice: 100, shippingCost: 10, soldAt: null, currency: "USD" }, { soldPrice: 120, shippingCost: 10, soldAt: null, currency: "USD" }, { soldPrice: 110, shippingCost: null, soldAt: null, currency: "USD" }], 6, 3.2, now);
  check("count, middle price and the delivered middle (shipping stated on at least half)", undated.count === 3 && undated.medianUsd === 110 && undated.medianDeliveredUsd === 120, undated);
  check("without sale dates there are no 30/90-day counts and it says so", undated.count30 === null && undated.count90 === null && !undated.datesKnown && /does not give sale dates/.test(undated.note));
  check("sell-through is sold against still-for-sale, with the honest caveat", undated.sellThrough !== null && Math.abs(undated.sellThrough - 3 / 9) < 1e-9 && /rough guide/.test(undated.note));
  const dated = soldStats([{ soldPrice: 50, shippingCost: null, soldAt: now - 5 * DAY, currency: "USD" }, { soldPrice: 60, shippingCost: null, soldAt: now - 40 * DAY, currency: "USD" }, { soldPrice: 70, shippingCost: null, soldAt: now - 200 * DAY, currency: "USD" }], null, null, now);
  check("with dates: 30 and 90-day counts", dated.datesKnown && dated.count30 === 1 && dated.count90 === 2, dated);
  check("no asks looked at means no sell-through, and days-to-sell only when the source has it", dated.sellThrough === null && dated.avgDaysToSell === null);
  const none = soldStats([], 4, null, now);
  check("no sales: nothing is invented", none.count === 0 && none.medianUsd === null && none.sellThrough === null && /No accepted sales/.test(none.note));

  section("green frame on a family's price");
  const prods = [
    { id: "fam", parentProductId: null, ebayAvgSoldPriceUsd: null, ebayAvgRunTimeDays: null },
    { id: "a", parentProductId: "fam", ebayAvgSoldPriceUsd: 500, ebayAvgRunTimeDays: 3 },
    { id: "b", parentProductId: "fam", ebayAvgSoldPriceUsd: 200, ebayAvgRunTimeDays: 20 },
    { id: "fam2", parentProductId: null, ebayAvgSoldPriceUsd: null, ebayAvgRunTimeDays: null },
    { id: "c", parentProductId: "fam2", ebayAvgSoldPriceUsd: 800, ebayAvgRunTimeDays: null },
  ];
  const hot = hotParentIds(prods, 300);
  check("a family with one high-priced, fast-selling model is framed; one with slow or no-data models is not", hot.has("fam") && !hot.has("fam2") && hot.size === 1);
  check("with no library average there is nothing to compare, so nothing is framed", hotParentIds(prods, null).size === 0 && !isHot(prods[1], null));

  section("accepted sales are kept for the entry");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-soldstats-"));
  const store = new Store(path.join(dir, "scout.db"));
  const id = store.addProductStub("p", "Zorblax 3000");
  const sale = (n: number, price: number) => ({ title: `Zorblax 3000 #${n}`, priceUsd: price, shippingUsd: 8, condition: "Used", listingType: "Auction", runTimeDays: 4, itemUrl: `https://www.ebay.com/itm/${1000000 + n}`, imageUrl: null });
  store.recordAcceptedSales(id, [sale(1, 100), sale(2, 120), sale(3, 110)]);
  const st = store.soldStatsFor(id);
  check("they are counted for that entry only", st.count === 3 && st.medianUsd === 110 && store.soldStatsFor(store.addProductStub("q", "Other 5")).count === 0, st);
  store.recordAcceptedSales(id, [sale(4, 90)]);
  check("a new research replaces the old WatchCount sales instead of piling up", store.soldStatsFor(id).count === 1);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }
});
