// D1.6 (owner request): what the user types is the query of record. A typed phrase is never silently swapped for a loosely matched old entry ("xbox series x galaxy edition" refreshing an
// invented "Xbox Series X Galaxy/White"), only a spelling slip or a real product title's word order is repaired (and said), a phrase that is a game AND a console is put to the user, a phrase
// that is not a product name is not filed, and the research reply never stalls with "what should I focus on". Fakes stand in for the Database and the web.
import { decideResearchTarget, entryAddsWords, notRecordedMessage, type DecideDeps, type TrackedProduct } from "../variantResearch.js";
import { buildVocabulary, describeCorrections, looksLikeQuestion, normalizeTypedProduct, placePhrase, splitProductRequest, stripCommand } from "../typedInput.js";
import { runResearchProductTool, type ResearchToolDeps } from "../researchTool.js";
import type { VariantVerdict } from "../variantEvidence.js";
import { check, run, section } from "./_testkit.js";

const NOW = 1_700_000_000_000;
const verdict = (claim: string, status: VariantVerdict["status"], extra: Partial<VariantVerdict> = {}): VariantVerdict => ({ claim, status, basis: "test", sources: [], matchedAttributes: [], missingAttributes: [], searched: ["q"], checkedAt: NOW, ...extra });

const XBOX: TrackedProduct = { id: "xbox", name: "Xbox Series X" };
const OLD: TrackedProduct = { id: "old", name: "Xbox Series X Galaxy/White" };
const CONSOLE_NAMED: TrackedProduct = { id: "xc", name: "Xbox Series X Console" };
const GAME: TrackedProduct = { id: "g", name: "Halo Infinite (Xbox Series X|S)" };
const HALO_CONSOLE: TrackedProduct = { id: "hc", name: "Xbox Series X Halo Infinite Limited Edition" };

function fakeDeps(tracked: TrackedProduct[], matching: TrackedProduct | null, verdicts: Record<string, VariantVerdict> = {}) {
  const log = { created: [] as string[], lookups: [] as Array<{ id: string; name: string }>, parents: [] as string[], claims: [] as string[], loading: [] as string[] };
  const deps: ResearchToolDeps = {
    store: {
      findMatchingProduct: () => matching as never,
      listProductIndex: () => tracked as never,
      getProductById: (id: string) => ({ id, name: tracked.find((t) => t.id === id)?.name ?? id, family: null, variantEvidence: null }) as never,
      addProductStub: (id: string, name: string) => (log.created.push(name), id),
      setProductLoading: (id: string) => void log.loading.push(id),
      setProductParent: (id: string, parent: string) => void log.parents.push(`${id}<-${parent}`),
      setProductVariantEvidence: () => undefined,
      recordVariantClaim: (id: string) => void log.claims.push(id),
    } as never,
    verifyClaim: async (name) => verdicts[name.toLowerCase()] ?? verdict(name, "unverified"),
    startLookup: (id, name) => void log.lookups.push({ id, name }),
    notify: () => undefined,
    newId: () => "new-id",
  };
  return { deps, log };
}

const typedPhrase = (): string => "xbox series x galaxy edition";

run(async () => {
  section("P26 the refresh rule: the same product refreshes; an entry that says MORE does not");
  const decide = (typed: string, matched: TrackedProduct | null, tracked: TrackedProduct[], verdicts: Record<string, VariantVerdict> = {}, withEvidence: string[] = []) => {
    const d: DecideDeps = { findMatching: () => matched, listTracked: () => tracked, entryHasEvidence: (e) => withEvidence.includes(e.id), verify: async (n) => verdicts[n.toLowerCase()] ?? verdict(n, "unverified") };
    return decideResearchTarget(typed, d);
  };
  check("'Xbox Series X' against 'Xbox Series X Console' still refreshes (console is filler)", (await decide("Xbox Series X", CONSOLE_NAMED, [CONSOLE_NAMED])).kind === "refresh_existing");
  check("the same words again refresh", (await decide("xbox series x galaxy/white", OLD, [OLD])).kind === "refresh_existing");
  check("entryAddsWords: the old entry says more than the typed phrase", entryAddsWords("xbox series x galaxy edition", OLD.name) === true && entryAddsWords("Xbox Series X", CONSOLE_NAMED.name) === false);

  section("P26b a plainer typed name for a PROPER entry is that entry, not a duplicate (AUDITOR's rows)");
  const proper = (id: string, name: string): TrackedProduct => ({ id, name });
  const IPH = proper("iph", "Apple iPhone 15 128GB");
  const PS5P = proper("ps5p", "Sony PlayStation 5 Pro Console");
  const GBSE = proper("gbse", "Xbox Series X Galaxy Black Special Edition");
  const GB2 = proper("gb2", "Xbox Series X 2TB Galaxy Black Special Edition");
  check("'iphone 15' vs 'Apple iPhone 15 128GB' refreshes (brand and capacity are not different words)", (await decide("iphone 15", IPH, [IPH])).kind === "refresh_existing");
  check("'ps5 pro' style: 'PlayStation 5 Pro' vs 'Sony PlayStation 5 Pro Console' refreshes", (await decide("PlayStation 5 Pro", PS5P, [PS5P])).kind === "refresh_existing");
  check("'xbox series x galaxy' vs a verified 'Galaxy Black Special Edition' refreshes it", (await decide("xbox series x galaxy", GBSE, [XBOX, GBSE], {}, ["gbse"])).kind === "refresh_existing");
  check("'xbox series x galaxy black' vs a verified '2TB Galaxy Black Special Edition' refreshes it", (await decide("xbox series x galaxy black", GB2, [XBOX, GB2], {}, ["gb2"])).kind === "refresh_existing");
  check("the same words against an entry with NO evidence are not trusted to be that entry", (await decide("xbox series x galaxy", GBSE, [XBOX, GBSE])).kind !== "refresh_existing");
  check("an invented separator is never trusted even with evidence on file", (await decide(typedPhrase(), OLD, [XBOX, OLD], {}, ["old"])).kind !== "refresh_existing");

  section("P20 the typed phrase is the query of record, never swapped for the old 'Galaxy/White' entry");
  const typed = "xbox series x galaxy edition";
  const verified = { [typed]: verdict(typed, "verified", { officialName: "Xbox Series X 2TB Galaxy Black Special Edition" }) };
  const d1 = await decide(typed, OLD, [XBOX, OLD], verified);
  check("not a refresh of Galaxy/White", d1.kind !== "refresh_existing");
  check("a verified edition becomes its own entry under the plain console", d1.kind === "create_variant" && d1.parent.id === "xbox");
  const d2 = await decide(typed, OLD, [XBOX, OLD]);
  check("an unconfirmed one records nothing and is still not a refresh", d2.kind === "not_recorded");
  const t1 = fakeDeps([XBOX, OLD], OLD, verified);
  const out1 = await runResearchProductTool({ product: typed }, `research ${typed}`, t1.deps);
  check("the tool never refreshes the old entry", !t1.log.lookups.some((l) => l.id === "old") && !t1.log.loading.includes("old"), t1.log);
  check("the new entry is researched under the typed words or the source's official name, not Galaxy/White", t1.log.lookups.length === 1 && /galaxy/i.test(t1.log.lookups[0].name) && !/galaxy\/white/i.test(t1.log.lookups[0].name), t1.log.lookups);
  check("it is filed as a child of the plain console", t1.log.parents.includes("new-id<-xbox"), t1.log.parents);
  check("the reply never says it refreshed Galaxy/White", !/Galaxy\/White/.test(out1), out1);

  section("P27 the reply never stalls with 'what should I focus on'");
  check("a new entry's reply tells the model not to ask", /Do NOT ask the user what to focus on/.test(out1), out1);
  const t2 = fakeDeps([], null);
  const out2 = await runResearchProductTool({ product: "Dyson V8 Absolute" }, "research dyson v8 absolute", t2.deps);
  check("a plain new product too", /^Started researching/.test(out2) && /Do NOT ask the user what to focus on/.test(out2), out2);
  const t3 = fakeDeps([CONSOLE_NAMED], CONSOLE_NAMED);
  const out3 = await runResearchProductTool({ product: "Xbox Series X" }, "research xbox series x", t3.deps);
  check("and a refresh", /Already have a Database profile/.test(out3) && /Do NOT ask the user what to focus on/.test(out3), out3);
  check("no reply asks the question itself", ![out1, out2, out3].some((o) => /what should i focus on\?/i.test(o)));

  section("P21/P22 only spelling and the word order of a real title are repaired, and it is said");
  const vocab = buildVocabulary(["Xbox Series X Galaxy/White", "Nintendo Switch OLED"]);
  const order = normalizeTypedProduct("Xbox X series galaxy edition", vocab);
  check("'Xbox X series' is read as 'Xbox Series X'", /^Xbox Series X galaxy edition$/i.test(order.text) && order.corrections.some((c) => c.kind === "word-order"), order);
  check("the correction is stated in the answer, with what was typed", /I read "Xbox X series galaxy edition" as/.test(describeCorrections(order)), describeCorrections(order));
  const typo = normalizeTypedProduct("xbox seris x galxy edition", vocab);
  check("misspellings are repaired", /series/i.test(typo.text) && /galaxy/i.test(typo.text) && typo.corrections.length === 2, typo);
  check("a switch typo", /switch/i.test(normalizeTypedProduct("nintendo swtich oled", vocab).text));
  const clean = normalizeTypedProduct("xbox series x galaxy edition", vocab);
  check("a phrase that is right is returned exactly as typed, with no correction", clean.text === "xbox series x galaxy edition" && clean.corrections.length === 0, clean);
  check("a known word is never changed (series, galaxy, oled, lite, pro)", normalizeTypedProduct("series galaxy oled lite pro", vocab).corrections.length === 0);
  check("words with numbers and unknown names are left alone", normalizeTypedProduct("Zorblax 3000 Deluxe", vocab).text === "Zorblax 3000 Deluxe");
  const t4 = fakeDeps([XBOX], null);
  const out4 = await runResearchProductTool({ product: "xbox seris x galxy edition" }, "xbox seris x galxy edition", t4.deps);
  check("the tool reports the correction and checks the repaired words", /I read "xbox seris x galxy edition" as/.test(out4) && /Series/.test(out4.split("(")[0]) && /Galaxy/.test(out4.split("(")[0]), { out4 });

  section("P23 a phrase that is both a game and a console is put to the user");
  const p23 = placePhrase("halo infinite", buildVocabulary([GAME.name, HALO_CONSOLE.name]), [GAME, HALO_CONSOLE]);
  check("two kinds -> choose", p23.kind === "choose" && p23.options.length === 2, p23);
  const t5 = fakeDeps([GAME, HALO_CONSOLE], null);
  const out5 = await runResearchProductTool({ product: "halo infinite" }, "halo infinite", t5.deps);
  check("the tool asks and creates or refreshes nothing", /NEEDS THE USER'S CHOICE/.test(out5) && /ask_choice/.test(out5) && t5.log.created.length === 0 && t5.log.lookups.length === 0, { out5, log: t5.log });
  check("one kind only is not ambiguous", placePhrase("halo infinite", buildVocabulary([GAME.name]), [GAME]).kind === "ok");

  section("P24 a phrase that is not a product name is not placed");
  const t6 = fakeDeps([XBOX], null);
  const out6 = await runResearchProductTool({ product: "asdfghjk qwrtpsdf" }, "asdfghjk qwrtpsdf", t6.deps);
  check("says it cannot place it, asks, creates nothing", /^NOT PLACED/.test(out6) && /Ask the user/.test(out6) && t6.log.created.length === 0 && t6.log.lookups.length === 0, { out6, log: t6.log });
  check("real words and unknown product names are placed", placePhrase("Zorblax Deluxe", buildVocabulary([]), []).kind === "ok" && placePhrase("band poster 1997 tour", buildVocabulary([]), []).kind === "ok");

  section("P25 a blocked search says so and nothing is recorded as fact");
  const blocked = verdict(typed, "unverified", { searchUnavailable: true });
  const msg = notRecordedMessage(typed, XBOX, blocked);
  check("the answer says it is a failed lookup, not a finding", /failed lookup, not a finding/.test(msg) && /NOT SAVED/.test(msg), msg);
  const t7 = fakeDeps([XBOX, OLD], OLD, { [typed]: blocked });
  const out7 = await runResearchProductTool({ product: typed }, typed, t7.deps);
  check("nothing is created and the old entry is untouched", /NOT SAVED/.test(out7) && t7.log.created.length === 0 && t7.log.lookups.length === 0 && !t7.log.loading.includes("old"), { out7, log: t7.log });

  section("P20b a phrase with its own words never refreshes the old invented 'Galaxy/White' (TESTER's rows)");
  for (const phrase of ["Xbox Series X Galaxy Edition 2TB", "Xbox Series X Galaxy Edition 1TB", "xbox series x galaxy black", "Xbox Series X Galaxy Black Edition", "Xbox Series X Galaxy Edition Guardians", "xbox series x galaxy edition price?"]) {
    check(`"${phrase}" is not a refresh of Galaxy/White`, (await decide(phrase, OLD, [XBOX, OLD])).kind !== "refresh_existing");
  }
  check("the very same words as the entry are still a refresh", (await decide("Xbox Series X Galaxy Edition White", OLD, [XBOX, OLD])).kind === "refresh_existing");
  // TESTER's niche run: a real word is never turned into another real word (a substitution), only a missing / extra / swapped letter is repaired
  const niche = buildVocabulary(["Xbox Series X Halo Infinite", "Yeti Rambler 20oz", "Bose QuietComfort 45", "Samsung Galaxy S24 Ultra 256GB", "Apple MacBook Air M2"]);
  check("holo is not Halo, base is not Bose", normalizeTypedProduct("Pokemon Charizard holo 1999 base set", niche).corrections.length === 0, normalizeTypedProduct("Pokemon Charizard holo 1999 base set", niche));
  check("tumbler is not Rambler", normalizeTypedProduct("yeti tumbler 30oz", niche).corrections.length === 0);
  check("a missing letter is still repaired (samsng, macbok)", /Samsung/.test(normalizeTypedProduct("samsng galaxy s24 ultra", niche).text) && /MacBook/.test(normalizeTypedProduct("macbok air m2", niche).text));

  section("L4 a request is never the product's name");
  check("'xbox series x. find all variants and add-ons' -> product + request", JSON.stringify(splitProductRequest("xbox series x. find all variants and add-ons")) === JSON.stringify({ product: "xbox series x", request: "find all variants and add-ons" }), splitProductRequest("xbox series x. find all variants and add-ons"));
  check("'xbox series x and look up variants' splits", splitProductRequest("xbox series x and look up variants").product === "xbox series x" && /^look up variants/.test(splitProductRequest("xbox series x and look up variants").request ?? ""), splitProductRequest("xbox series x and look up variants"));
  check("'xbox series x, then find add-ons' splits", splitProductRequest("xbox series x, then find add-ons").product === "xbox series x", splitProductRequest("xbox series x, then find add-ons"));
  check("a plain product name is untouched", splitProductRequest("Sony WH-1000XM4").request === null && splitProductRequest("Sony WH-1000XM4").product === "Sony WH-1000XM4");
  check("a name with a period inside a model is untouched", splitProductRequest("Nikon Z6 II 24.5MP body").request === null);
  const tSplit = fakeDeps([XBOX], null);
  const outSplit = await runResearchProductTool({ product: "xbox series x. find all variants and add-ons" }, "xbox series x. find all variants and add-ons", tSplit.deps);
  check("the tool never creates an entry named with the whole sentence", !tSplit.log.created.some((n) => /find all variants/i.test(n)) && !tSplit.log.lookups.some((l) => /find all variants/i.test(l.name)), tSplit.log);
  check("and it hands the request back to the model", /Their message also asked: "find all variants and add-ons"/.test(outSplit), outSplit);

  section("junk is not filed (TESTER's niche run)");
  check("a question is a question", looksLikeQuestion("is a used series s worth flipping?") && !looksLikeQuestion("Sony WH-1000XM4"));
  const tQ = fakeDeps([XBOX], null);
  const outQ = await runResearchProductTool({ product: "is a used series s worth flipping?" }, "is a used series s worth flipping?", tQ.deps);
  check("a question creates nothing", /^NOT PLACED/.test(outQ) && tQ.log.created.length === 0 && tQ.log.lookups.length === 0, { outQ, log: tQ.log });
  const tK = fakeDeps([XBOX], null);
  const outK = await runResearchProductTool({ product: "asdf qwer zxcv" }, "asdf qwer zxcv", tK.deps);
  check("keyboard mashing creates nothing", /^NOT PLACED/.test(outK) && tK.log.created.length === 0, { outK, log: tK.log });
  check("'research the steam deck oled' loses the command and the article", stripCommand("research the steam deck oled") === "steam deck oled", stripCommand("research the steam deck oled"));

  section("a plainer name for an entry that just has a fuller name is that entry (no duplicate)");
  const FULL = (id: string, name: string): TrackedProduct => ({ id, name });
  for (const [typedName, entry] of [["kitchenaid artisan mixer", "KitchenAid Artisan Stand Mixer"], ["dewalt dcd771", "DeWalt DCD771C2 20V Drill"], ["lego millennium falcon", "LEGO Millennium Falcon 75192"], ["halo infinite", "Halo Infinite (Xbox Series X|S)"], ["samsung galaxy s24 ultra", "Samsung Galaxy S24 Ultra 256GB"]] as const) {
    const e = FULL("e", entry);
    check(`"${typedName}" refreshes "${entry}"`, (await decide(typedName, e, [e])).kind === "refresh_existing");
  }
  check("but a plain entry still never takes a typed edition with its own color", (await decide("xbox series x galaxy black", OLD, [XBOX, OLD])).kind !== "refresh_existing");

  section("TESTER's findings on 12545dd: real titles are not questions, an exact name wins, 'find me' is a command");
  for (const title of ["Can Am Maverick X3", "Will Smith Oscars poster", "How to Train Your Dragon DVD", "When Harry Met Sally DVD", "Is This It vinyl", "Which Wich shirt", "Do Not Disturb Sign", "Dyson V8 Absolute"]) {
    check(`"${title}" is a product name, not a question`, !looksLikeQuestion(title));
  }
  check("real questions still are", ["is a used series s worth flipping", "should I buy a steam deck", "how much is a ps5 worth", "can you find me a switch", "Xbox Series X?"].every(looksLikeQuestion));
  const tTitle = fakeDeps([XBOX], null);
  const outTitle = await runResearchProductTool({ product: "Can Am Maverick X3" }, "Can Am Maverick X3", tTitle.deps);
  check("a title that starts with a question word is researched", !/^NOT PLACED/.test(outTitle), outTitle);
  const GAME_X = { id: "gx", name: "Halo Infinite (Xbox Series X|S)" };
  check("an entry named exactly 'Xbox Series X' wins over a game whose title contains it", placePhrase("xbox series x", buildVocabulary([XBOX.name, GAME_X.name]), [XBOX, GAME_X]).kind === "ok");
  const tExact = fakeDeps([XBOX, GAME_X], XBOX);
  const outExact = await runResearchProductTool({ product: "xbox series x. find all variants and add-ons" }, "xbox series x. find all variants and add-ons", tExact.deps);
  check("the exact name with a request does not ask game-or-console", !/NEEDS THE USER'S CHOICE/.test(outExact) && /Their message also asked/.test(outExact), outExact);
  check("'find me a steam deck oled' researches 'steam deck oled'", stripCommand("find me a steam deck oled") === "steam deck oled" && stripCommand("look up for me a dyson v8") === "dyson v8", stripCommand("find me a steam deck oled"));
});
