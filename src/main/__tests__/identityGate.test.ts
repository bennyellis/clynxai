// Phase 4 stages 1 and 4-lite: a wrongly matched listing can no longer be a confident deal, mixed comps are split, and nothing else about the Gate moved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualifyListing, evidenceLevel, type GateInput } from "../dealGate.js";
import { assessListingAge } from "../listingAge.js";
import { DEFAULT_RESALE_SETTINGS } from "../resaleMath.js";
import { Store } from "../store.js";
import { analyzeEbayComps, deriveWatchCountQuery, type EbayComp } from "../watchcount.js";
import { check, run, section } from "./_testkit.js";

const settings = DEFAULT_RESALE_SETTINGS;
const base = (over: Partial<GateInput> = {}): GateInput => ({
  pathway: "search",
  priceUsd: 15,
  conditionImpact: "none",
  evidence: { valueUsd: 48, basis: "sold", sampleSize: 40, ageDays: 1 },
  age: assessListingAge("2 hours ago", null),
  settings,
  ...over,
});
const comp = (title: string, priceUsd: number): EbayComp => ({ title, priceUsd, shippingUsd: 0, condition: "Used", listingType: "Fixed Price", runTimeDays: 4, itemUrl: "https://www.ebay.com/itm/1" });

run(async () => {
  section("the Gate: an unconfirmed identity can't be a confident deal");
  {
    const normal = qualifyListing(base());
    check("without doubt, the same numbers are Profitable Now (nothing else moved)", normal.status === "profitable_now" && normal.qualified, normal.status);
    const doubted = qualifyListing(base({ identityUnconfirmed: ["360", "1403"] }));
    check("with unconfirmed codes it is only Worth a look", doubted.status === "worth_a_look" && !doubted.qualified, doubted.status);
    check("...with a reason that names the codes", doubted.reasons.some((r) => r.code === "IDENTITY_UNCONFIRMED" && /360/.test(r.text) && /1403/.test(r.text)));
    check("...at low confidence", doubted.confidence === "low");
    check("a reference price the user typed is not affected (the caller leaves it empty)", qualifyListing(base({ evidence: { valueUsd: 48, basis: "user", sampleSize: null, ageDays: null }, identityUnconfirmed: [] })).qualified);
    check("with no value at all the old path still says so", qualifyListing(base({ evidence: null, identityUnconfirmed: ["360"] })).reasons[0].code === "NO_EVIDENCE");
    check("approximate (stand-in) comps are never better than weak evidence", evidenceLevel({ valueUsd: 48, basis: "sold", sampleSize: 40, ageDays: 1, approximate: true }) === "weak");
    check("a pass stays a pass (price too high) even when unconfirmed", qualifyListing(base({ priceUsd: 60, identityUnconfirmed: ["360"] })).status === "pass");
  }

  section("the Database: signals carry the doubt");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-idgate-"));
    const store = new Store(path.join(dir, "scout.db"));
    const id = store.addProductStub("p1", "Xbox Wireless Controller");
    store.updateProductEbayComps(id, { avgSoldPriceUsd: 48, avgRunTimeDays: 5, avgShippingUsd: 0, sampleSize: 40, estimatedValueUsd: 48, estimateBasis: "sold", identity: "approximate" });
    const s = store.getProductSignals("Xbox Wireless Controller", "Official Microsoft Xbox 360 Wireless Controller 1403 OEM");
    check("a more specific listing lists the codes the entry lacks", s?.unconfirmedCodes?.join() === "360,1403", s?.unconfirmedCodes);
    const same = store.getProductSignals("Xbox Wireless Controller", "Used xbox wireless controller works great");
    check("an ordinary listing of the entry has none", (same?.unconfirmedCodes ?? []).length === 0);
    check("the comps' identity state is stored and read back", s?.identity === "approximate" && store.getProductById(id)?.ebayCompsIdentity === "approximate");
    store.updateProductEbayComps(id, { avgSoldPriceUsd: 48, avgRunTimeDays: 5, avgShippingUsd: 0, sampleSize: 40 });
    check("an update that says nothing resets it to unknown, not stale", store.getProductById(id)?.ebayCompsIdentity === null);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section("comps: a generic name no longer averages every version");
  {
    const comps: EbayComp[] = [
      ...[44, 47, 48, 50, 52, 46, 49, 45].map((p) => comp("Microsoft Xbox Series X|S Wireless Controller Carbon Black", p)),
      ...[15, 17, 18, 19, 21, 16].map((p) => comp("Microsoft Xbox 360 Wireless Controller 1403 Black", p)),
      ...[26, 28, 29, 31, 32].map((p) => comp("Microsoft Xbox One Wireless Controller 1708", p)),
    ];
    const generic = await analyzeEbayComps("Xbox Wireless Controller", comps, "Xbox Wireless Controller");
    check("a generic name: flagged approximate, valued at the cheapest group, not the ~$32 blend", generic.identity === "approximate" && (generic.avgSoldPriceUsd ?? 99) < 22, { id: generic.identity, avg: generic.avgSoldPriceUsd, note: generic.identityNote });
    const specific = await analyzeEbayComps("Xbox 360 Wireless Controller 1403", comps, "Xbox 360 Wireless Controller 1403");
    check("a name that says 360 / 1403: only 360 comps, exact", specific.identity === "exact" && specific.sampleSize === 6 && (specific.avgSoldPriceUsd ?? 0) < 22, { id: specific.identity, n: specific.sampleSize, avg: specific.avgSoldPriceUsd });
    const single = await analyzeEbayComps("PlayStation 5 Console", [380, 395, 400, 410, 405, 390, 385].map((p) => comp("Sony PlayStation 5 Console Disc Edition", p)), "PlayStation 5 Console");
    check("a single-product comp set is unchanged and exact", single.identity === "exact" && single.sampleSize >= 6, single);
    const broken = await analyzeEbayComps("Xbox Wireless Controller", comps, "Xbox Wireless Controller", null, true);
    check("broken / for-parts research is untouched by the split", broken.identity !== "approximate");
  }

  section("the default (no-AI) search query keeps the listing's model numbers");
  {
    const q = await deriveWatchCountQuery("Xbox Wireless Controller", "Official Microsoft Xbox 360 & Windows Black Wireless Controller 1403 OEM gamepad", null);
    check("generic name + the codes the listing states", q === "Xbox Wireless Controller 360 1403", q);
    check("nothing added when the listing adds nothing", (await deriveWatchCountQuery("Xbox Wireless Controller", "xbox wireless controller works", null)) === "Xbox Wireless Controller");
    check("no source listing: the name as before", (await deriveWatchCountQuery("Xbox Wireless Controller", null, null)) === "Xbox Wireless Controller");
  }
});
