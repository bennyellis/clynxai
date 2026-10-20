// Phase 1 of the Beta 30 plan: model facts and the naming engine. The plan's acceptance fixtures: the owner's Xbox lines, the Switch family, iPhone 15 Pro lock states and carriers, Sony WH-1000XM5
// (colours folded), KitchenAid Artisan (colours folded, bowl-lift Professional separate), DeWalt DCD771 vs DCD771C2 (the kit differs), AirPods Pro (generations). Names match the format, aliases
// resolve old names, notices appear. Pure functions and a throwaway Database: no network, nothing of the owner's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";
import { foldedNotice, judgeAttribute, namingFacts, neverAlerts, normalizeGeneration, parsePhone, phoneEntry, resolveName } from "../namingEngine.js";
import { buildAliasIndex, nameKey, SEED_LINES } from "../modelFacts.js";
import { check, run, section } from "./_testkit.js";

const canon = (name: string) => resolveName(name).canonical;

run(async () => {
  section("the owner's Xbox lines: one simple name per model, old and official names resolve to it");
  check("Series X black (disc), Digital white, and Galaxy are three different models with the owner's names", canon("Xbox Series X") === "Xbox Series X (Black)" && canon("Xbox Series X Digital") === "Xbox Series X Digital (White)" && canon("Xbox Series X Galaxy Edition") === "Xbox Series X Galaxy Edition");
  check("'Xbox Series X' and 'Xbox Series X (1TB)' and '... 1TB Carbon Black' are ONE entry", new Set(["Xbox Series X", "Xbox Series X (1TB)", "xbox series x 1tb", "Xbox Series X 1TB Carbon Black", "Microsoft Xbox Series X Console", "Brand New Xbox Series X Sealed"].map(canon)).size === 1);
  check("the white Digital model under all its names", new Set(["Xbox Series X Digital Edition", "Xbox Series X Robot White", "Xbox Series X All-Digital", "Xbox Series X 1TB Digital Edition"].map(canon)).size === 1 && canon("Xbox Series X Robot White") === "Xbox Series X Digital (White)");
  check("the Galaxy edition under its official name: 2TB, no size in the canonical name", canon("XBOX Series X 2TB Galaxy Black Special Edition") === "Xbox Series X Galaxy Edition" && !/2TB/.test(canon("Xbox Series X Galaxy Black Special Edition")));
  check("Series S: 512GB, 1TB white and 1TB black stay THREE entries", new Set(["Xbox Series S", "Xbox Series S 1TB", "Xbox Series S 1TB Carbon Black"].map(canon)).size === 3 && canon("Xbox Series S 512GB") === "Xbox Series S (White, 512GB)" && canon("Xbox Series S 1TB Black") === "Xbox Series S (Black, 1TB)");
  check("Series X and Series S are different products", canon("Xbox Series X") !== canon("Xbox Series S"));
  const x = resolveName("Xbox Series X Robot White");
  check("a resolved model says its family (not priced itself), keeps the typed name as an alias, and is not 'generic'", x.parent === "Xbox Series X" && x.alias === "Xbox Series X Robot White" && x.how === "model" && x.line === "Xbox Series X" && x.generic === false, x);
  check("the bare line name is flagged 'generic' (a later step may have to ask which model)", resolveName("Xbox Series X").generic === true && resolveName("Xbox Series S").generic === true && resolveName("Xbox Series X Digital").generic === false);
  check("the canonical name resolves to itself with no alias", resolveName("Xbox Series X Digital (White)").alias === null && resolveName("Xbox Series X Digital (White)").canonical === "Xbox Series X Digital (White)");

  section("Switch and 3DS families");
  check("the OLED sits under the parent 'Nintendo Switch'", resolveName("Nintendo Switch OLED Model White").canonical === "Nintendo Switch OLED" && resolveName("Switch OLED").parent === "Nintendo Switch");
  check("Switch 2 is its own product with no parent; Lite is its own too", resolveName("Nintendo Switch 2").parent === null && canon("Switch 2") === "Nintendo Switch 2" && canon("Nintendo Switch 2") !== canon("Nintendo Switch OLED") && canon("Switch Lite") === "Nintendo Switch Lite" && resolveName("Nintendo Switch Lite").parent === null);
  check("the 3DS family: every model's parent is 'Nintendo 3DS' and the models stay distinct", resolveName("New 3DS XL").parent === "Nintendo 3DS" && canon("New 3DS XL") === "New Nintendo 3DS XL" && new Set(["3DS XL", "New 3DS", "New 3DS XL", "2DS XL"].map(canon)).size === 4 && resolveName("Nintendo 3DS").parent === null);

  section("colours that do not move the price are folded, and the note says so");
  const xm5 = ["Sony WH-1000XM5 Black", "Sony WH-1000XM5 Silver", "sony wh-1000xm5 midnight blue"].map((n) => resolveName(n));
  check("WH-1000XM5 in every colour is ONE entry named 'Sony WH-1000XM5'", xm5.every((r) => r.canonical === "Sony WH-1000XM5") && xm5.every((r) => r.how === "folded"), xm5.map((r) => r.canonical));
  check("the visible notice names the colour that was left out", /colour \(black\)/i.test(foldedNotice(xm5[0])) && /share one entry/.test(foldedNotice(xm5[0])) && foldedNotice({ folded: [] }) === "");
  const ka = ["KitchenAid Artisan Empire Red", "kitchenaid artisan onyx black", "KitchenAid Artisan Contour Silver"].map(canon);
  check("KitchenAid Artisan in three colours is one entry; the bowl-lift Professional stays separate", new Set(ka).size === 1 && ka[0] === "KitchenAid Artisan" && canon("KitchenAid Artisan Professional 600 Empire Red") !== "KitchenAid Artisan" && /Professional/.test(canon("KitchenAid Artisan Professional 600 Empire Red")));
  check("DeWalt DCD771 (drill alone) and DCD771C2 (kit) are two entries", canon("DeWalt DCD771") !== canon("DeWalt DCD771C2 20V Drill") && canon("DeWalt DCD771") === "DeWalt DCD771");
  check("a model generation is part of the name, never folded: AirPods Pro vs 2nd generation", canon("AirPods Pro") !== canon("AirPods Pro 2nd Gen") && canon("AirPods Pro 2nd Gen") === "AirPods Pro (2nd generation)" && canon("Apple AirPods Pro (2nd generation)") === "AirPods Pro (2nd generation)" && canon("AirPods Pro Gen 2") === "AirPods Pro (2nd generation)");
  check("generations normalise whichever way they are written", normalizeGeneration("AirPods Pro 2nd gen") === "AirPods Pro (2nd generation)" && normalizeGeneration("iPad gen 9") === "iPad (9th generation)" && normalizeGeneration("Echo Dot 3rd generation") === "Echo Dot (3rd generation)" && normalizeGeneration("Kindle 11th gen") === "Kindle (11th generation)");
  check("condition filler is not part of a name", canon("Brand New Sony WH-1000XM5 Black Sealed") === "Sony WH-1000XM5");
  check("a name that would be stripped to nothing keeps its words", canon("Black Friday") === "Black Friday" && canon("Silver") === "Silver");
  check("a name nothing is known about is left alone", resolveName("Zorblax Deluxe 3000").how === "unchanged" && canon("Zorblax Deluxe 3000") === "Zorblax Deluxe 3000");

  section("is a detail worth a separate entry? judged from sold medians, never guessed");
  const same = judgeAttribute("Colour", [{ value: "Black", medianUsd: 300, n: 14 }, { value: "Silver", medianUsd: 305, n: 9 }, { value: "Midnight Blue", medianUsd: 298, n: 6 }]);
  check("colours within a few percent fold, with the evidence in the notice", same.distinguishing === false && /Colours of this model sell for about the same/.test(same.notice ?? "") && /Black \$300 \(14 sales\)/.test(same.notice ?? "") && /Silver \$305 \(9 sales\)/.test(same.notice ?? ""), same);
  const apart = judgeAttribute("Carrier", [{ value: "Unlocked", medianUsd: 700, n: 12 }, { value: "T-Mobile", medianUsd: 600, n: 8 }]);
  check("a real gap keeps the attribute in the name and gives no 'folded' note", apart.distinguishing === true && apart.notice === null && apart.gapPercent === 17, apart);
  const thin = judgeAttribute("Colour", [{ value: "Black", medianUsd: 300, n: 2 }, { value: "White", medianUsd: 100, n: 1 }]);
  check("with too few sales per value it says so instead of deciding", thin.distinguishing === null && /not enough/.test(thin.reason) && judgeAttribute("Colour", [{ value: "Black", medianUsd: 300, n: 20 }]).distinguishing === null);

  section("phones: lock state and carrier entries, created on demand");
  const unlocked = phoneEntry(parsePhone("Apple iPhone 15 Pro 256GB Factory Unlocked, mint"))!;
  check("unlocked -> 'iPhone 15 Pro Unlocked (256GB)' under 'iPhone 15 Pro'", unlocked.name === "iPhone 15 Pro Unlocked (256GB)" && unlocked.parent === "iPhone 15 Pro" && unlocked.kind === "normal" && unlocked.certainty === "settled", unlocked);
  const locked = phoneEntry(parsePhone("iPhone 15 Pro 256GB carrier locked"))!;
  check("locked with no carrier -> 'iPhone 15 Pro Locked (256GB)'", locked.name === "iPhone 15 Pro Locked (256GB)" && locked.parent === "iPhone 15 Pro", locked);
  const tmo = phoneEntry(parsePhone("iPhone 15 Pro 256GB T-Mobile locked"))!;
  check("a carrier is a child of Locked: 'iPhone 15 Pro Locked T-Mobile (256GB)'", tmo.name === "iPhone 15 Pro Locked T-Mobile (256GB)" && tmo.parent === "iPhone 15 Pro Locked (256GB)", tmo);
  check("the other carriers", ["Verizon", "AT&T", "Xfinity", "Cricket"].every((c) => phoneEntry(parsePhone(`iPhone 15 Pro 256GB ${c} locked`))?.name === `iPhone 15 Pro Locked ${c} (256GB)`));
  check("a carrier word alone means locked to it", phoneEntry(parsePhone("T-Mobile iPhone 15 Pro 128GB"))?.name === "iPhone 15 Pro Locked T-Mobile (128GB)");
  check("a phone that WAS locked and is now unlocked is Unlocked", phoneEntry(parsePhone("iPhone 15 Pro 256GB was Verizon locked, now unlocked"))?.name === "iPhone 15 Pro Unlocked (256GB)" && phoneEntry(parsePhone("iPhone 15 Pro 256GB, Settings shows no SIM restrictions"))?.name === "iPhone 15 Pro Unlocked (256GB)");
  check("other makers: Samsung and Pixel", phoneEntry(parsePhone("Samsung Galaxy S24 Ultra 512GB unlocked"))?.name === "Samsung Galaxy S24 Ultra Unlocked (512GB)" && phoneEntry(parsePhone("Google Pixel 8 Pro 128GB unlocked"))?.name === "Google Pixel 8 Pro Unlocked (128GB)" && phoneEntry(parsePhone("iPhone 15 Pro Max 1TB unlocked"))?.name === "iPhone 15 Pro Max Unlocked (1TB)");
  for (const [text, reason] of [["iPhone 15 Pro 256GB iCloud locked, selling for parts", "iCloud"], ["iPhone 14 128GB activation lock on", "iCloud"], ["iPhone 13 256GB MDM remote management", "MDM"], ["iPhone 13 blacklisted IMEI", "blacklisted"], ["iPhone 12 financed, still owes a balance", "financed"]] as const) {
    const e = phoneEntry(parsePhone(text))!;
    check(`"${text}" -> For Parts, never alerts`, e.kind === "for_parts" && /For Parts/i.test(e.name) && neverAlerts(e) && new RegExp(reason, "i").test(parsePhone(text).forParts ?? ""), e);
  }
  check("'no iCloud lock', 'iCloud removed', 'not blacklisted', 'paid off' are NOT for parts", ["iPhone 15 Pro 256GB unlocked, no iCloud lock", "iPhone 15 Pro 256GB iCloud removed unlocked", "iPhone 14 128GB unlocked, not blacklisted, clean IMEI", "iPhone 14 128GB unlocked, fully paid off"].every((t) => parsePhone(t).forParts === null));
  const vague = phoneEntry(parsePhone("iPhone 15 Pro 256GB great shape"))!;
  check("no lock information: named by model and size only, marked vague, never alerts", vague.name === "iPhone 15 Pro (256GB)" && vague.certainty === "vague" && neverAlerts(vague) && !neverAlerts(unlocked) && !neverAlerts(tmo), vague);
  check("not a phone model -> no phone entry", phoneEntry(parsePhone("Dyson V8 Absolute")) === null);

  section("aliases and the owner's edits live in the Database (not yet wired to any insert path)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-naming-"));
  const store = new Store(path.join(dir, "scout.db"));
  const id = store.addProductStub("p1", "Xbox Series X (Black)");
  const other = store.addProductStub("p2", "Xbox Series S (White, 512GB)");
  check("an alias is kept once, never the product's own name, never empty", store.addProductAlias(id, "Xbox Series X 1TB") === true && store.addProductAlias(id, "xbox  series x 1tb") === false && store.addProductAlias(id, "Xbox Series X (Black)") === false && store.addProductAlias(id, "  ") === false && store.addProductAlias("nope", "x y z") === false);
  check("it is listed and found by name, whatever the case or spacing", store.listProductAliases(id).length === 1 && store.findProductIdByAlias("XBOX series x 1TB") === id && store.findProductIdByAlias("nothing") === null);
  store.addProductAlias(other, "Series thing");
  store.addProductAlias(id, "Series thing");
  check("a name two products claim decides nothing", store.findProductIdByAlias("series thing") === null);
  store.setModelFactOverride("Xbox Series X Galaxy Edition", { addAliases: ["Xbox Series X Starfield 2TB"], attrs: { note: "owner" } }, 1);
  store.setModelFactOverride("Xbox Series X Galaxy Edition", { addAliases: ["Xbox Series X Galaxy 2TB Edition"] }, 2);
  const edits = store.listModelFactOverrides();
  check("the owner's edits add up and survive", edits.length === 1 && edits[0].addAliases.length === 2 && edits[0].attrs.note === "owner");
  const edited = namingFacts(edits);
  check("with the edits in force their names resolve; without them they do not", resolveName("Xbox Series X Starfield 2TB", edited).canonical === "Xbox Series X Galaxy Edition" && resolveName("Xbox Series X Starfield 2TB").canonical !== "Xbox Series X Galaxy Edition");
  store.deleteProduct(id);
  check("deleting a product deletes its aliases", store.listProductAliases(id).length === 0 && store.listProductAliases(other).length === 1);
  store.clearAllProducts();
  check("clearing the Database clears aliases too", store.listProductAliases(other).length === 0);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup can fail on Windows */
  }

  section("the facts themselves are consistent");
  const index = buildAliasIndex(SEED_LINES);
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const line of SEED_LINES) for (const m of line.models) for (const n of [m.canonical, ...m.aliases]) {
    const k = nameKey(n);
    const prev = seen.get(k);
    if (prev && prev !== m.canonical) clashes.push(`${n} -> ${prev} / ${m.canonical}`);
    seen.set(k, m.canonical);
  }
  check("no name belongs to two models in the built-in facts", clashes.length === 0, clashes);
  check("every alias resolves to the model that lists it, and every parent is a real name", SEED_LINES.every((l) => l.models.every((m) => m.aliases.every((a) => index.get(nameKey(a))?.model.canonical === m.canonical) && (!m.parent || nameKey(m.parent).length > 0))));
  check("every fact says where it came from", SEED_LINES.every((l) => l.source && l.models.every((m) => !!m.source)));
});
