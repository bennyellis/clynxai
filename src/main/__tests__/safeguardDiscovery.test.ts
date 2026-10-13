// Phase 4 veto-only safeguard: discovery is preserved. A vetoed match removes only the Database entry's number from the decision; the listing is still saved, still shown,
// and still goes through the Deal Quality Gate exactly like a listing of a product the Database has never seen (Worth a look at worst, a deal when the market check
// finds a real value). An unsure match changes nothing at all. Thresholds are untouched (the Gate is the real one).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { qualifyScoredListing, type MarketCheck } from "../preAlert.js";
import { Store } from "../store.js";
import { check, run, section } from "./_testkit.js";
import { scoredListing } from "./_fixtures.js";

const settings = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };
const base = { settings, maxAgeHours: 48, log: (_m: string) => {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-guard-disc-"));

const PRODUCTS: Array<[string, string, number]> = [
  ["d1", "iPhone 15", 500], ["d2", "iPhone 15 Plus", 600], ["d3", "iPhone 14", 450], ["d4", "iPhone 14 Plus", 520], ["d5", "iPhone 13", 380], ["d6", "iPhone 13 Plus", 430],
  ["d7", "iPhone 12", 280], ["d8", "iPhone 12 Plus", 330], ["d9", "Xbox Series S", 190], ["d10", "Xbox Series S 1TB", 230],
];
let n = 0;
function openStore(mode: "off" | "enforce"): Store {
  const file = path.join(dir, `db${++n}.db`);
  new Store(file).close();
  const db = new DatabaseSync(file);
  const ins = db.prepare("INSERT INTO products (id, name, category, created_at, ebay_avg_sold_price_usd, ebay_comps_sample_size, ebay_comps_checked_at) VALUES (?, ?, 'Other', ?, ?, 8, ?)");
  PRODUCTS.forEach(([id, name, v], i) => ins.run(id, name, 1_700_000_000_000 + i, v, Date.now() - 86_400_000));
  db.close();
  const s = new Store(file);
  s.setIdentitySafeguard(mode, null);
  return s;
}
const listing = (title: string, matched: string, price: number, ref: number | null) =>
  scoredListing(title, price, {
    extraction: { matchedItem: matched, extractedAttributes: "", conditionImpact: "none", confidence: "high", reasoning: "Matches." } as never,
    referencePriceUsd: ref, discountPercent: ref ? ((ref - price) / ref) * 100 : null, dealTier: "search", isDeal: true,
  }, { listingAge: "2 hours ago" });
const checker = (value: number | null) => async (): Promise<MarketCheck | null> => ({ productId: null, productName: null, valueUsd: value, refreshed: true, note: "" });
const verdictOf = async (s: Store, sc: ReturnType<typeof listing>, market: number | null, refresh = false) => {
  const q = await qualifyScoredListing({ ...base, scored: sc, source: s, check: checker(market), refreshMarket: refresh });
  return { status: q.verdict.status, qualified: q.verdict.qualified, headline: q.verdict.headline, confidence: q.verdict.confidence, isDeal: q.scored.isDeal };
};

run(async () => {
  section("an unsure match changes nothing: the verdict is identical with the safeguard off and enforcing");
  {
    const off = openStore("off");
    const on = openStore("enforce");
    const sc = (s: Store) => listing("Xbox Series S 1TB Black console", "Xbox Series S", 120, s.getEbayValueForProductName("Xbox Series S", "Xbox Series S 1TB Black console"));
    const a = await verdictOf(off, sc(off), null);
    const b = await verdictOf(on, sc(on), null);
    check("same status, headline, confidence and deal flag", JSON.stringify(a) === JSON.stringify(b), { a, b });
    check("and it is still a deal worth seeing (not suppressed)", a.status !== "pass", a);
    check("the safeguard did evaluate it and did not veto", on.safeguard.stats.evaluated > 0 && on.safeguard.stats.veto === 0, on.safeguard.stats);
    off.close();
    on.close();
  }

  section("a vetoed match: the listing is still discoverable, like any product the Database does not know");
  {
    const off = openStore("off");
    const on = openStore("enforce");
    const title = "iPhone 15+ unlocked";
    const refOff = off.getEbayValueForProductName("iPhone 15", title);
    const refOn = on.getEbayValueForProductName("iPhone 15", title);
    check("with the safeguard off the iPhone 15 value ($500) prices a Plus listing; enforcing, that wrong number is not used", refOff === 500 && refOn === null, { refOff, refOn });
    const noMarket = await verdictOf(on, listing(title, "iPhone 15", 300, refOn), null);
    check("with no other evidence it is kept as Worth a look in the Feed, never Pass", noMarket.status === "worth_a_look" && !noMarket.isDeal, noMarket);
    const unknownProduct = await verdictOf(on, listing("Rare gizmo 3000 mint", "Rare gizmo", 300, null), null);
    check("exactly what a product the Database has never heard of gets", unknownProduct.status === noMarket.status, { unknownProduct, noMarket });
    const withMarket = await verdictOf(on, listing(title, "iPhone 15", 300, refOn), 600, true);
    check("when the market check prices what the listing really is, a good price is a qualified deal: potentially profitable listings stay discoverable", withMarket.qualified && withMarket.isDeal, withMarket);
    off.close();
    on.close();
  }

  section("the Database's other numbers are untouched by a veto");
  {
    const on = openStore("enforce");
    on.getEbayValueForProductName("iPhone 15", "iPhone 15+ unlocked");
    const db = new DatabaseSync((on as never as { db: DatabaseSync }).db.prepare("PRAGMA database_list").all().map((r: any) => r.file)[0], { readOnly: true });
    const rows = db.prepare("SELECT id, ebay_avg_sold_price_usd FROM products ORDER BY id").all() as Array<{ id: string; ebay_avg_sold_price_usd: number }>;
    db.close();
    check("no stored value was changed by evaluating or vetoing", PRODUCTS.every(([id, , v]) => rows.find((r) => r.id === id)?.ebay_avg_sold_price_usd === v), rows);
    on.close();
  }
});
