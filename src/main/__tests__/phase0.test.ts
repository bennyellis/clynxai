// Phase 0 of the Beta 30 plan (AUDITOR_PLAN_FOR_DEVELOPER_NEXT_UPDATE_2026-10-20): the open leftovers, plus the owner's request for the eBay average price over every Library thumbnail.
// Pure functions, source shape and fakes only.
import fs from "node:fs";
import path from "node:path";
import { tilePrice } from "../../renderer/src/lib/tilePrice.js";
import { matchComp, type ProductIdentity } from "../soldComps/match.js";
import type { SoldComp } from "../soldComps/types.js";
import { check, run, section } from "./_testkit.js";

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const base = { ebayEstimatedValueUsd: null, ebayEstimateBasis: null, ebayAvgSoldPriceUsd: null, ebayAvgShippingUsd: null, ebayCompsSampleSize: null, ebayActiveSampleSize: null } as const;
const comp = (title: string, over: Partial<SoldComp> = {}): SoldComp => ({ id: "c", source: "manual_import", sourceListingId: null, title, soldPrice: 1100, currency: "USD", soldAt: 1, condition: "Used", shippingCost: null, quantitySold: null, buyingOption: null, gtin: null, epid: null, categoryId: null, imageUrl: null, seller: null, fetchedAt: 1, expiresAt: null, raw: null, ...over });
const XBOX: ProductIdentity = { id: "p", name: "Xbox Series X Galaxy Black Special Edition" };

run(async () => {
  section("the eBay average over each Library thumbnail");
  const sold = tilePrice({ ...base, ebayEstimatedValueUsd: 1087.4, ebayEstimateBasis: "sold", ebayAvgSoldPriceUsd: 1075, ebayAvgShippingUsd: 12, ebayCompsSampleSize: 14 });
  check("a product with sold sales shows the buyer's average, labelled 'avg sold'", sold.text === "$1,087" && sold.sub === "avg sold" && sold.tone === "sold", sold);
  check("the hover text says how many sales and what you'd keep after fees", /14 sold sales/.test(sold.title) && /keep about \$\d+-\$\d+/.test(sold.title), sold.title);
  const few = tilePrice({ ...base, ebayEstimatedValueUsd: 300, ebayEstimateBasis: "sold", ebayCompsSampleSize: 2 });
  check("one or two sales are a rough guess and say so", few.tone === "few" && /2 sales/.test(few.sub) && /rough guess/.test(few.title), few);
  const asking = tilePrice({ ...base, ebayEstimatedValueUsd: 900, ebayEstimateBasis: "active", ebayActiveSampleSize: 22, ebayCompsSampleSize: 0 });
  check("a price built only from asking prices is marked 'asking, not sold' (not proof)", asking.tone === "asking" && asking.sub === "asking, not sold" && /not proof/.test(asking.title) && /22 sellers/.test(asking.title), asking);
  check("a blend says so", /blended with asking/.test(tilePrice({ ...base, ebayEstimatedValueUsd: 500, ebayEstimateBasis: "blend", ebayCompsSampleSize: 6, ebayActiveSampleSize: 8 }).title));
  const none = tilePrice(base);
  check("no data at all says 'No price yet' instead of a number", none.text === "No price yet" && none.tone === "none" && none.sub === "");
  check("with no stored estimate it falls back to the average sold price plus shipping", tilePrice({ ...base, ebayAvgSoldPriceUsd: 100, ebayAvgShippingUsd: 15, ebayCompsSampleSize: 5 }).text === "$115");
  check("a zero or negative figure is no price", tilePrice({ ...base, ebayEstimatedValueUsd: 0 }).text === "No price yet" && tilePrice({ ...base, ebayEstimatedValueUsd: -5 }).text === "No price yet");
  check("thousands get a separator and amounts round to whole dollars", tilePrice({ ...base, ebayEstimatedValueUsd: 12345.6, ebayEstimateBasis: "sold", ebayCompsSampleSize: 9 }).text === "$12,346");
  const lib = read("src", "renderer", "src", "screens", "Database.tsx");
  check("every Library tile renders it over the thumbnail, bottom-left, away from the search / delete buttons", /data-testid="tile-price"/.test(lib) && /bottom: 6,\s*left: 6,\s*maxWidth: "calc\(100% - 78px\)"/.test(lib) && /const shownPrice = tilePrice\(product\)/.test(lib));
  check("an 'asking' price has a dashed amber outline so it never looks proven", /shownPrice\.tone === "asking" \? "1px dashed/.test(lib));

  section("Discovery: where you were in each view, and history that is not new");
  const disc = read("src", "renderer", "src", "screens", "DiscoveryTab.tsx");
  check("leaving a view remembers its scroll place, and coming back restores it unless you were at the latest", /ui\.places\[mode\] = stick\.getPosition\(\)/.test(disc) && /const place = ui\.places\[mode\]/.test(disc) && /if \(place && !place\.stuck\)/.test(disc) && /ui\.places = \{\}/.test(disc));
  check("products from before this session sit at the top of the stream, whatever their last-updated time", /startedAt: Math\.min\(p\.updatedAt, SESSION_STARTED_AT - 1\)/.test(disc) && /const SESSION_STARTED_AT = Date\.now\(\)/.test(disc));

  section("a research that never finishes is stopped and shown as failed");
  const idx = read("src", "main", "index.ts");
  check("a 12-minute watchdog wraps every research, marks it failed with a plain note, releases it from the live list and always lets go of the counter", /RESEARCH_WATCHDOG_MS = 12 \* 60_000/.test(idx) && /Promise\.race\(\[runProductLookupInner\(\.\.\.args\)/.test(idx) && /store\.markResearchFailed\(id, friendly\)/.test(idx) && /activeResearch\.delete\(id\)/.test(idx) && /researchActive--;/.test(idx));

  section("'not as is' is not 'as is' (sold-comps leftover)");
  check("'fully working, not as is' and 'never cracked' and 'no water damage' are accepted", ["Xbox Series X Galaxy Black Special Edition Console fully working, not as is", "Xbox Series X Galaxy Black Special Edition Console never cracked", "Xbox Series X Galaxy Black Special Edition Console no water damage"].every((t) => matchComp(XBOX, comp(t)).accepted));
  check("the words on their own still reject", ["Xbox Series X Galaxy Black Special Edition Console as is", "Xbox Series X Galaxy Black Special Edition Console cracked", "Xbox Series X Galaxy Black Special Edition Console water damaged", "Xbox Series X Galaxy Black Special Edition Console untested"].every((t) => !matchComp(XBOX, comp(t)).accepted));
  check("a sentence that negates one word and states another still rejects", !matchComp(XBOX, comp("Xbox Series X Galaxy Black Special Edition Console not cracked but red ring")).accepted);
});
