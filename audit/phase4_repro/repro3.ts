// READ-ONLY audit harness #3: with a generic entry AND a specific entry both in a throw-away Database, which one do the name lookups pick?
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Store } from "../../src/main/store.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-audit4b-"));
const mk = (order: "generic-first" | "specific-first") => {
  const store = new Store(path.join(dir, order + ".db"));
  const add = (name: string, v: number) => { const id = store.addProductStub(name.replace(/\W+/g, "-"), name); store.updateProductEbayComps(id, { avgSoldPriceUsd: v, avgRunTimeDays: 5, avgShippingUsd: 0, sampleSize: 20, activeMedianUsd: v, activeSampleSize: 5, estimatedValueUsd: v, estimateBasis: "sold" }); };
  const g = () => add("Xbox Wireless Controller", 48), s = () => add("Xbox 360 Wireless Controller", 18);
  if (order === "generic-first") { g(); s(); } else { s(); g(); }
  return store;
};
for (const order of ["generic-first", "specific-first"] as const) {
  const store = mk(order);
  console.log(`\nentries created ${order}:`);
  for (const probe of ["Xbox Wireless Controller", "Xbox 360 Wireless Controller", "Microsoft Xbox 360 Wireless Controller 1403"]) {
    console.log(`  findMatchingProduct("${probe}") -> ${store.findMatchingProduct(probe)?.name}   | getEbayValueForProductName -> $${store.getEbayValueForProductName(probe)}`);
  }
  console.log(`  title-aware: getEbayValueForProductName("Xbox Wireless Controller", "Xbox 360 wireless controller 1403 black") -> $${store.getEbayValueForProductName("Xbox Wireless Controller", "Xbox 360 wireless controller 1403 black")}   (generic search item, 360 title)`);
  console.log(`  title-aware abbreviated: getEbayValueForProductName("Xbox Wireless Controller", "X360 wireless controller 1403") -> $${store.getEbayValueForProductName("Xbox Wireless Controller", "X360 wireless controller 1403")}`);
  console.log(`  a REAL Series X pad titled "Xbox Wireless Controller Carbon Black Series X|S" with the generic search item -> $${store.getEbayValueForProductName("Xbox Wireless Controller", "Xbox Wireless Controller Carbon Black Series X|S")}`);
  store.close();
}
fs.rmSync(dir, { recursive: true, force: true });
