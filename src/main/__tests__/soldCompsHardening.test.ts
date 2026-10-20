// TESTER's code-only findings on the sold-comps module (cbeaba5), each as a regression test: junk identifiers, the day's cache hiding new imports or expired rows, an unclear page treated as
// an answer, messy exports, cross-brand titles and misleading zero reasons. Fakes and an in-memory database only.
import { DatabaseSync } from "node:sqlite";
import { matchComp, type ProductIdentity } from "../soldComps/match.js";
import { ManualImportProvider, parseMoney, parsePrice, parseSoldImport } from "../soldComps/manualImport.js";
import { SoldCompsService, zeroReason } from "../soldComps/service.js";
import { SoldCompsStore } from "../soldComps/store.js";
import { DAY_MS, normEpid, normGtin, type ProviderResult, type SoldComp, type SoldCompsProvider } from "../soldComps/types.js";
import { WatchCountProvider } from "../soldComps/watchCountProvider.js";
import { check, run, section } from "./_testkit.js";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const XBOX: ProductIdentity = { id: "p1", name: "Xbox Series X Galaxy Black Special Edition" };
const comp = (over: Partial<SoldComp>): SoldComp => ({ id: "c", source: "manual_import", sourceListingId: null, title: "Xbox Series X Galaxy Black Special Edition Console", soldPrice: 1100, currency: "USD", soldAt: NOW - DAY_MS, condition: "Used", shippingCost: null, quantitySold: null, buyingOption: null, gtin: null, epid: null, categoryId: null, imageUrl: null, seller: null, fetchedAt: NOW, expiresAt: null, raw: null, ...over });
const fake = (id: SoldComp["source"], answer: () => ProviderResult, extra: Partial<SoldCompsProvider> = {}) => {
  let calls = 0;
  const p: SoldCompsProvider = { id, label: `fake ${id}`, thirdParty: id === "watchcount", search: async () => (calls++, answer()), ...extra };
  return { p, calls: () => calls };
};
const svc = (providers: SoldCompsProvider[], now = NOW) => new SoldCompsService({ store: new SoldCompsStore(new DatabaseSync(":memory:")), providers, now: () => now, enoughUsable: 1000 });

run(async () => {
  section("1 a junk product code never makes every coded comp 'exact'");
  for (const junk of ["N/A", "0", "0000000000000", "-", " ", "Does not apply", "abc", "12345"]) {
    const m = matchComp({ ...XBOX, gtin: junk }, comp({ title: "Nintendo Switch OLED White Console", gtin: "0045496596439" }));
    check(`product GTIN "${junk}" is ignored: a Switch title is not 'exact'`, !(m.verdict === "exact" && m.reason === "GTIN matches") && !m.accepted, m);
  }
  check("both sides all zeros are not a match", matchComp({ ...XBOX, gtin: "0000000000000" }, comp({ title: "Whatever", gtin: "0000000000000" })).basis !== "gtin");
  check("a real code on both sides still matches, leading zeros ignored (UPC vs EAN)", normGtin("889842640816") === normGtin("0889842640816") && normGtin("889842640816") !== "");
  check("spreadsheet-mangled codes are not codes", normGtin("889842640816.0") === "" && normGtin("8.89842640816E+11") === "" && normGtin("1,234") === "");
  check("ePIDs compare without case or spaces", normEpid(" ep1 ") === normEpid("EP1") && matchComp({ ...XBOX, epid: "ep1" }, comp({ title: "whatever", epid: "EP1 " })).accepted);

  section("2 the owner's imports are never hidden by the day's cache");
  const store = new SoldCompsStore(new DatabaseSync(":memory:"));
  const importer = new ManualImportProvider(() => store.listComps("manual_import"));
  const s1 = new SoldCompsService({ store, providers: [importer], now: () => NOW, enoughUsable: 1000 });
  const before = await s1.research(XBOX);
  store.upsertComps([comp({ id: "i1", title: "Xbox Series X Galaxy Black Special Edition Console" }), comp({ id: "i2", title: "Xbox Series X 2TB Galaxy Black Special Edition", soldPrice: 1050 })]);
  const after = await s1.research(XBOX);
  check("research, then import two sales, then research again the same day: the new sales are used", before.summary === null && after.summary?.count === 2 && after.providers[0].cached === false, { before: before.zero, after: after.summary });

  section("3 expired comps are never priced from the cache, and a purged answer is asked for again");
  const exp = fake("watchcount", () => ({ comps: [comp({ id: "e1", source: "watchcount", expiresAt: NOW + DAY_MS })], outcome: { kind: "ok" } }));
  const sx = svc([exp.p]);
  await sx.research(XBOX);
  const later = new SoldCompsService({ store: sx["o"].store, providers: [exp.p], now: () => NOW + 2 * DAY_MS - 1000, enoughUsable: 1000 });
  const same = await later.research(XBOX); // still the same UTC day? 36h later is the next day anyway: use a clock inside the day instead
  check("a comp past its retention date is purged and the source is asked again", exp.calls() === 2 && same.providers[0].cached === false, exp.calls());
  const inDay = fake("watchcount", () => ({ comps: [comp({ id: "e2", source: "watchcount", expiresAt: NOW + 1000 })], outcome: { kind: "ok" } }));
  const sy = svc([inDay.p]);
  await sy.research(XBOX);
  const sy2 = new SoldCompsService({ store: sy["o"].store, providers: [inDay.p], now: () => NOW + 2000, enoughUsable: 1000 });
  const r2 = await sy2.research(XBOX);
  check("within the same day, an expired row is not served from the cache", inDay.calls() === 2 && r2.providers[0].cached === false, { calls: inDay.calls() });
  check("all-expired never reads 'No source could be asked: .'", !/asked: \./.test(zeroReason([{ provider: "watchcount", label: "WatchCount", thirdParty: true, outcome: { kind: "ok" }, retrieved: 0, usable: 0, cached: false }], []).text));

  section("4 an empty page that might be a hidden block is 'unclear', not a day-long 'no sales'");
  const wc = new WatchCountProvider(async () => ({ comps: [] }), { now: () => NOW });
  const sw = svc([wc]);
  const w1 = await sw.research(XBOX);
  const w2 = await sw.research(XBOX);
  check("unclear is not cached (asked twice) and the zero says it is not clear", w1.providers[0].outcome.kind === "unclear" && w2.providers[0].cached === false && w1.zero?.kind === "unclear" && /not clear/.test(w1.zero.text), w1.zero);

  section("5 and 6: real-world exports");
  const x1 = parseSoldImport('sep=,\nSold Price (USD),Item Title,Date Last Sold,UPC\n"$1,099.00",Xbox Series X Galaxy Black 2TB,2026-10-12,8.89842640816E+11\n', NOW);
  check("an Excel 'sep=' line, a '(USD)' header and 'Date Last Sold' are understood; a mangled UPC is dropped, not stored", x1.comps.length === 1 && x1.comps[0].soldPrice === 1099 && x1.comps[0].soldAt === Date.parse("2026-10-12") && x1.comps[0].gtin === null, x1);
  const x2 = parseSoldImport("Report generated 2026-10-20\nSome preamble\nTotal Price,Title\n950,Xbox Series X Galaxy Black\n", NOW);
  check("preamble lines before the header are skipped", x2.comps.length === 1 && x2.comps[0].soldPrice === 950, x2);
  const x3 = parseSoldImport("Item Title,Sold On,Colour\nXbox Series X,2026-10-12,Black\n", NOW);
  check("a title column with no known price column stops and says so (never guesses a price)", x3.comps.length === 0 && /no price column/.test(x3.skipped[0]?.reason ?? ""), x3);
  const x4 = parseSoldImport("Xbox Series X Galaxy Black Special Edition Console 2026\nXbox Series X Galaxy Black $1,075.00\n", NOW);
  check("a pasted line ending in a year is not a price; one ending in a $ amount is", x4.comps.length === 1 && x4.comps[0].soldPrice === 1075 && x4.skipped.length === 1, x4);
  check("comma decimals and thousands dots", parseMoney("12,50") === 12.5 && parseMoney("1.099,00") === 1099 && parseMoney("EUR 12,50") === 12.5 && parseMoney("$1,099.00") === 1099 && parseMoney("1,099") === 1099);
  check("currency is kept: € and £ and codes are not silently USD", parsePrice("€12.50")?.currency === "EUR" && parsePrice("£950")?.currency === "GBP" && parsePrice("CAD 40")?.currency === "CAD" && parsePrice("$5")?.currency === "USD");
  const eur = parseSoldImport("Title,Price\nXbox Series X Galaxy Black Special Edition Console,€950\n", NOW);
  check("an imported euro sale is stored as EUR", eur.comps[0].currency === "EUR");
  const rEur = await svc([new ManualImportProvider(() => eur.comps)]).research(XBOX);
  check("usable sales that are not in USD give a 'currency' zero, not 'all_rejected'", rEur.zero?.kind === "currency" && /not in US dollars/.test(rEur.zero.text) && rEur.usable.length === 1, rEur.zero);

  section("7 zero reasons that misled");
  const blockedP = fake("watchcount", () => ({ comps: [], outcome: { kind: "blocked", detail: "security check" } }));
  const rejectP = fake("manual_import", () => ({ comps: [comp({ id: "r1", title: "Xbox Series X Galaxy Black Special Edition Wireless Controller" })], outcome: { kind: "ok" } }));
  const mixed = await svc([rejectP.p, blockedP.p]).research(XBOX);
  check("one source blocked plus another with only rejects keeps the 'sales may be missing' caveat", mixed.zero?.kind === "all_rejected" && /could not be read properly, so sales may be missing/.test(mixed.zero.text), mixed.zero);
  check("grammar: '1 sold listing came back'", /^1 sold listing came back/.test(mixed.zero?.text ?? ""), mixed.zero);

  section("8 a title that conflicts with the code is held, never priced (sellers paste the base model's UPC on variants)");
  const withCode: ProductIdentity = { ...XBOX, gtin: "0889842640816" };
  for (const t of ["Xbox Series X 1TB Black Console", "Xbox Series S 512GB Digital Console"]) {
    const m = matchComp(withCode, comp({ title: t, gtin: "0889842640816" }));
    check(`GTIN matches but "${t}" is held as uncertain`, m.verdict === "uncertain" && !m.accepted && /title conflicts/.test(m.reason), m);
  }
  check("a code match with a matching title is still exact", matchComp(withCode, comp({ gtin: "0889842640816" })).verdict === "exact");

  section("9 cross-brand and untested titles do not price an Xbox");
  for (const t of ["PlayStation 5 Galaxy Black Special Edition Console", "Nintendo Switch Galaxy Black Special Edition Console", "Samsung Galaxy Black Special Edition phone", "Galaxy Black Special Edition console"]) {
    check(`"${t}" is not accepted`, !matchComp(XBOX, comp({ title: t })).accepted);
  }
  for (const c of ["Parts Only", "Untested", "As is", "Cracked screen"]) check(`condition "${c}" is not accepted`, !matchComp(XBOX, comp({ condition: c })).accepted);
  check("the real title is still accepted", matchComp(XBOX, comp({})).accepted);

  section("13 a provider that throws does not abort the research");
  const boom: SoldCompsProvider = { id: "marketplace_insights", label: "boom", thirdParty: false, search: async () => { throw new Error("kaboom"); } };
  const ok = fake("manual_import", () => ({ comps: [comp({ id: "k1" })], outcome: { kind: "ok" } }));
  const rb = await svc([boom, ok.p]).research(XBOX);
  check("the failure is reported as an error outcome and the next source is still asked", rb.providers[0].outcome.kind === "error" && rb.providers[1].usable === 1 && rb.summary?.count === 1, rb.providers);
});
