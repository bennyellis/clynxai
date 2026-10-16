// The research reasoning: knowledge graph, evidence states, observation -> candidates -> targeted questions -> elimination -> edition discovery, and the model-name challenge.
// IMPORTANT: the "eyes" (observer) and the web here are FAKES written for these tests. They prove the reasoning and the bookkeeping, NOT that a real model recognises a real photo
// or that real pages say these things. Real-image and live-search checks are separate (scripts/visual-eval.cjs, run by the owner) and are reported as not yet verified.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeGraph } from "../knowledgeGraph.js";
import { seedNintendoHandhelds } from "../knowledgeSeeds.js";
import { canEliminate, evidenceFromSources, sourceQuality } from "../evidenceKinds.js";
import { eliminate, observationQueries, parseAnswers, parseObservation, targetedPrompt, type Observation } from "../visualProfile.js";
import { extractEditions, matchEditions } from "../editionDiscovery.js";
import { challengeModelClaim, lineupIn, parseModelClaim } from "../claimChallenge.js";
import { entityAcceptsTitle, identifyFromObservation, type Observer } from "../identityResearch.js";
import { Store } from "../store.js";
import type { VerifyDeps } from "../variantEvidence.js";
import { check, run, section } from "./_testkit.js";

const NINTENDO_URL = "https://www.nintendo.com/us/store/products/new-nintendo-3ds-xl/";
const CV_URL = "https://consolevariations.com/database/new-nintendo-3ds-xl";
const FANDOM = "https://pokemon.fandom.com/wiki/New_Nintendo_3DS_XL_Pikachu_Edition";
const GAMESPOT = "https://www.gamespot.com/articles/new-3ds-xl-special-editions/";
const PAGES: Record<string, string> = {
  [GAMESPOT]: "The New Nintendo 3DS XL Hyrule Edition is gold with a Triforce pattern on the lid. The New Nintendo 3DS XL Majora's Mask Edition is purple with a Skull Kid mask design.",
  [NINTENDO_URL]: "The New Nintendo 3DS XL Pikachu Edition is a yellow special edition handheld themed on Pokémon, with a cartoon Pikachu face on the lid, red cheek circles and black-tipped ears.",
  [CV_URL]: "New Nintendo 3DS XL Pikachu Edition: yellow shell, Pikachu face with red cheek circles and black-tipped ears, a Pokémon release. New Nintendo 3DS XL Hyrule Edition: gold shell with a Triforce pattern. New Nintendo 3DS XL Majora's Mask Edition: purple shell with a Skull Kid mask design.",
  [FANDOM]: "The New Nintendo 3DS XL Pikachu Edition was a yellow console decorated with Pikachu's face, red cheek circles and ears tipped in black.",
};

function fakeWeb(pages: Record<string, string>, opts: { only?: string[] } = {}): VerifyDeps & { asked: string[] } {
  const asked: string[] = [];
  let trace = { searches: [] as any[], pages: [] as any[] };
  const urls = () => Object.keys(pages).filter((u) => !opts.only || opts.only.includes(u));
  return {
    asked,
    async search(q) {
      asked.push(q);
      trace.searches.push({ query: q, backend: "fake", outcome: "ok", results: urls().length });
      return urls().map((u) => ({ title: u.replace(/^https?:\/\//, "").split("/")[0], url: u, snippet: pages[u].slice(0, 90) }));
    },
    async fetchText(u) {
      return pages[u] ?? null;
    },
    trace: () => trace,
    reset: () => void (trace = { searches: [], pages: [] }),
  };
}

const yellowObs: Observation = { objectKind: "handheld game console (clamshell)", brandVisible: "Nintendo", colors: ["yellow"], artwork: ["cartoon face with red circles and black-tipped ears"], features: [], photos: 3, limits: [] };
function fakeObserver(answers: Record<string, string>, obs: Observation | null = yellowObs): Observer & { seenImages: string[][] } {
  const seen: string[][] = [];
  return {
    seenImages: seen,
    observe: async (images) => (seen.push(images), obs),
    answer: async (_images, questions) => Object.fromEntries(questions.map((q) => [q.aspect, { option: answers[q.aspect] ?? "not_visible", note: "" }])),
  };
}

run(async () => {
  section("evidence: what a source can and cannot make true");
  check("a marketplace listing alone stays seller_reported", evidenceFromSources([{ url: "https://www.ebay.com/itm/1", quality: "marketplace" }]).kind === "seller_reported");
  check("an official source makes it verified", evidenceFromSources([{ url: "https://www.nintendo.com/x", quality: "official" }]).kind === "verified");
  check("two independent non-marketplace sources make it researched", evidenceFromSources([{ url: "https://a.example/x", quality: "collector" }, { url: "https://b.example/y", quality: "retailer" }]).kind === "researched");
  check("a single specialist source is enough, a single collector page is only 'researched' at best and never verified", evidenceFromSources([{ url: "https://www.gsmarena.com/x", quality: "specialist" }]).kind === "researched" && evidenceFromSources([{ url: "https://a.example/x", quality: "collector" }]).kind !== "verified");
  check("an official source contradicted by an official source is disputed, not decided", evidenceFromSources([{ url: "https://nintendo.com/a", quality: "official" }, { url: "https://nintendo.com/b", quality: "official", contradicts: true }]).disputed);
  check("seller and inferred facts may not rule anything out; observed and verified may", !canEliminate("seller_reported") && !canEliminate("inferred") && !canEliminate("unknown") && canEliminate("observed") && canEliminate("verified"));
  check("source quality follows the order the owner set", sourceQuality(NINTENDO_URL, "New Nintendo 3DS XL") === "official" && sourceQuality(CV_URL, "New Nintendo 3DS XL") === "collector" && sourceQuality("https://www.ebay.com/itm/1", "x") === "marketplace");

  section("the knowledge graph (separate from the Library)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-kg-"));
  const store = new Store(path.join(dir, "scout.db"));
  const kg = store.knowledgeGraph();
  check("an in-memory graph works the same (used by tools)", new KnowledgeGraph(new DatabaseSync(":memory:")).upsert({ kind: "manufacturer", name: "X" }).name === "X");
  const seeded = seedNintendoHandhelds(kg);
  check("the owner's 3DS knowledge is seeded as owner_asserted, not verified", kg.get(seeded.modelIds["New Nintendo 3DS XL"])!.status === "owner_asserted" && kg.discriminators(seeded.familyId).every((d) => d.kind === "owner_asserted"));
  check("aliases find the same entry", kg.find("New 3DS XL")[0]?.name === "New Nintendo 3DS XL" && kg.find("nintendo 3ds ll")[0]?.name === "Nintendo 3DS XL");
  const again = seedNintendoHandhelds(kg);
  check("seeding twice creates nothing twice", again.familyId === seeded.familyId && kg.counts().model === 6);
  const e = kg.upsert({ kind: "edition", name: "Pikachu Edition", parentId: seeded.modelIds["New Nintendo 3DS XL"], itemKind: "hardware" });
  const fr = kg.upsert({ kind: "franchise", name: "Pokémon", itemKind: "other" });
  const ch = kg.upsert({ kind: "character", name: "Pikachu", itemKind: "other" });
  kg.relate(fr.id, ch.id, "features");
  kg.relate(e.id, fr.id, "themed_on");
  kg.relate(e.id, ch.id, "themed_on");
  const chain = kg.describeChain(e.id);
  check("a chain runs maker > family > model > edition > franchise > character", chain.startsWith("Nintendo > Nintendo 3DS family > New Nintendo 3DS XL > Pikachu Edition") && chain.includes("Pokémon") && chain.includes("Pikachu"), chain);
  kg.addClaim(e.id, { claim: "exists", url: "https://consolevariations.com/x", quality: "collector" });
  check("one collector source alone does not verify an edition", kg.get(e.id)!.status !== "verified");
  kg.addClaim(e.id, { claim: "exists", url: NINTENDO_URL, quality: "official", quote: "Pikachu Edition" });
  check("an official source verifies it", kg.get(e.id)!.status === "verified" && !kg.get(e.id)!.disputed);
  kg.addClaim(e.id, { claim: "no such edition", url: "https://nintendo.com/other", quality: "official", contradicts: true });
  check("a conflicting official claim is kept and the entry is shown as disputed", kg.get(e.id)!.disputed && kg.conflicts(e.id).length === 1);
  kg.retract(e.id, "the person says this is wrong");
  check("a correction sends it back to unknown and due for re-checking", kg.get(e.id)!.status === "unknown" && kg.stale(e.id, 1e12));
  check("a hardware entry never takes a game, a game entry never takes hardware", entityAcceptsTitle(kg.get(e.id)!, "Pokémon Sun - Nintendo 3DS game") === false && entityAcceptsTitle(kg.get(e.id)!, "New Nintendo 3DS XL Pikachu Edition console") === true && entityAcceptsTitle({ itemKind: "game" }, "Nintendo 3DS XL console") === false);

  section("discovering 30 editions creates 0 Library products");
  const g2 = kg;
  const fam = g2.upsert({ kind: "family", name: "Test family", itemKind: "hardware" });
  for (let i = 0; i < 30; i++) g2.upsert({ kind: "edition", name: `Edition number ${i}`, parentId: fam.id, itemKind: "hardware" });
  check("thirty editions known, no product in the Library", g2.counts().edition >= 30 && store.listProductIndex().length === 0);

  section("what is SEEN becomes searches (not the seller's title)");
  const qs = observationQueries(yellowObs, { candidates: ["New Nintendo 3DS XL"] });
  check("searches use brand, colour, kind and artwork", qs.some((q) => /nintendo/i.test(q) && /yellow/.test(q) && /handheld/.test(q)) && qs.some((q) => /cartoon face/.test(q)), qs);
  check("a candidate adds a narrower search", qs.some((q) => q.startsWith("New Nintendo 3DS XL")));
  check("no Pikachu or Pokemon in the searches: the name was never supplied", !qs.some((q) => /pikachu|pok/i.test(q)));
  check("a malformed observation is rejected, a good one parsed", parseObservation({ objectKind: "" }, 1) === null && parseObservation({ objectKind: "phone", colors: ["black"], features: [{ aspect: "Camera Layout", description: "three lenses", confidence: "high" }] }, 2)?.features[0].aspect === "camera_layout");
  const questions = kg.discriminators(seeded.familyId).map((d) => ({ aspect: d.aspect, question: d.question, options: d.options }));
  check("the targeted prompt offers fixed options and 'not_visible'", /not_visible/.test(targetedPrompt(questions)) && questions.length === 2);
  check("an answer outside the options becomes not_visible", parseAnswers({ answers: [{ aspect: "c_stick", option: "maybe" }] }, questions).c_stick.option === "not_visible");

  section("ruling out: original 3DS XL vs New 3DS XL (the owner's layout facts)");
  const ds = kg.discriminators(seeded.familyId);
  const ids = Object.values(seeded.modelIds);
  const single = eliminate(ids, ds, { home_button_layout: { option: "single_home_below_screen" }, c_stick: { option: "present" } });
  check("a single HOME button and a C Stick rule out the original 3DS XL", single.eliminated.some((x) => x.candidateId === seeded.modelIds["Nintendo 3DS XL"]) && !single.remaining.includes(seeded.modelIds["Nintendo 3DS XL"]) && single.remaining.includes(seeded.modelIds["New Nintendo 3DS XL"]));
  const three = eliminate(ids, ds, { home_button_layout: { option: "three_below_screen" }, c_stick: { option: "not_visible" } });
  check("three buttons rule out the New 3DS XL, even when the C Stick is not visible", !three.remaining.includes(seeded.modelIds["New Nintendo 3DS XL"]) && three.remaining.includes(seeded.modelIds["Nintendo 3DS XL"]));
  const hiddenAll = eliminate(ids, ds, { home_button_layout: { option: "not_visible" }, c_stick: { option: "not_visible" } });
  check("hidden controls rule nothing out: uncertainty is kept", hiddenAll.remaining.length === ids.length && hiddenAll.eliminated.length === 0);
  const weak = eliminate(ids, ds.map((d) => ({ ...d, kind: "inferred" as const })), { home_button_layout: { option: "three_below_screen" }, c_stick: { option: "absent" } });
  check("an inferred discriminator cannot rule anything out", weak.eliminated.length === 0);

  section("editions: discovered from sources, matched to what is seen, never from a built-in list");
  const pages = Object.entries(PAGES).map(([url, text]) => ({ url, title: url, text }));
  const hits = extractEditions(["New Nintendo 3DS XL", "New Nintendo 3DS"], pages);
  const names = hits.map((h) => h.name);
  check("the editions are found by the pattern in the text", names.includes("Pikachu Edition") && names.includes("Hyrule Edition") && names.some((n) => /Majora/.test(n)), names);
  check("Pikachu Edition is tied to the model named with it (XL, not the smaller one)", hits.find((h) => h.name === "Pikachu Edition")!.models.join() === "New Nintendo 3DS XL", hits.find((h) => h.name === "Pikachu Edition")?.models);
  check("theme terms are collected from the sentences (Pokémon appears, no list consulted)", hits.find((h) => h.name === "Pikachu Edition")!.themeTerms.includes("Pokémon"));
  const lone = extractEditions(["New Nintendo 3DS XL"], [{ url: "https://blog.example/post", title: "x", text: "A fan called the New Nintendo 3DS XL Mystery Edition rumoured." }]);
  check("one weak source is not enough to believe an edition", lone.length === 0);
  const m = matchEditions(yellowObs, hits);
  check("yellow + cartoon face + red circles matches the Pikachu Edition, not the others", m[0].edition === "Pikachu Edition" && m[0].strength === "likely" && m.find((x) => /Hyrule/.test(x.edition))!.strength === "unsupported", m.map((x) => `${x.edition}:${x.strength}`));
  const gold: Observation = { ...yellowObs, colors: ["gold"], artwork: ["triforce pattern"] };
  const mg = matchEditions(gold, hits);
  check("gold + Triforce pattern matches Hyrule, and a Majora's Mask name does not win by sounding Zelda-like", /Hyrule/.test(mg[0].edition) && mg[0].strength === "likely" && mg.find((x) => /Majora/.test(x.edition))!.strength !== "likely", mg.map((x) => `${x.edition}:${x.strength}`));

  section("the whole pipeline on 'Yellow Nintendo DS' (fake eyes, fake web)");
  const stats: string[] = [];
  const eyes = fakeObserver({ home_button_layout: "single_home_below_screen", c_stick: "present" });
  const decision = await identifyFromObservation(
    { images: ["data:image/jpeg;base64,AAAA"], title: "Yellow Nintendo DS" },
    {
      graph: kg,
      web: fakeWeb(PAGES),
      observer: eyes,
      themes: { classify: async () => [{ term: "Pokémon", kind: "franchise" }, { term: "Pikachu", kind: "character", franchise: "Pokémon" }, { term: "Digimon", kind: "franchise" }] },
      usage: (k) => void stats.push(k),
    }
  );
  check("the original 3DS XL is ruled out from the photographed layout", decision.eliminated.some((x) => x.candidate === "Nintendo 3DS XL"), decision.trace);
  check("the Pikachu Edition is the edition candidate, from research", decision.edition?.value === "Pikachu Edition" && decision.edition.kind === "researched" && (decision.edition.sources?.length ?? 0) > 0);
  check("the model follows from the edition (documented only for the XL)", decision.model?.value === "New Nintendo 3DS XL", { model: decision.model, remaining: decision.remainingModels });
  check("authenticity is stated as unverified, aftermarket shells are mentioned", decision.authenticity === "unverified" && decision.uncertainty.some((u) => /aftermarket shell/.test(u)));
  check("the observation step takes only the photos (the seller's words have no way in)", eyes.observe.length === 1 && eyes.seenImages[0].join() === "data:image/jpeg;base64,AAAA");
  check("the seller's title did not become a verified fact", decision.family?.kind !== "verified" && decision.family?.kind !== "seller_reported");
  const e2 = kg.find("Pikachu Edition", ["edition"])[0];
  check("the edition is now knowledge, linked to the franchise and character the classifier named (the invented one is dropped)", !!e2 && kg.related(e2.id, "themed_on").some((r) => r.entity.name === "Pokémon") && kg.related(e2.id, "themed_on").some((r) => r.entity.name === "Pikachu") && kg.find("Digimon").length === 0);
  check("costs were counted: vision calls, searches, a cache hit", stats.filter((s) => s === "vision_call").length === 2 && stats.includes("web_search") && stats.includes("knowledge_cache_hit") && decision.stats.searches > 0 && decision.stats.visionCalls === 2);
  check("no Library product was created by research", store.listProductIndex().length === 0);

  const hidden = await identifyFromObservation({ images: ["x"], title: "Nintendo handheld" }, { graph: kg, web: fakeWeb({}), observer: fakeObserver({}, { ...yellowObs, artwork: [] }) });
  check("with the controls hidden several models stay possible, and it says so", hidden.model === null && hidden.remainingModels.length === 6 && hidden.uncertainty.some((u) => /Not visible/.test(u)), hidden.uncertainty);
  const unreadable = await identifyFromObservation({ images: ["x"], title: "t" }, { graph: kg, web: fakeWeb({}), observer: fakeObserver({}, null) });
  check("unreadable photos produce an honest non-answer", unreadable.family === null && /could not be read/.test(unreadable.uncertainty[0]));
  const stranger = await identifyFromObservation({ images: ["x"], title: "mystery gadget" }, { graph: kg, web: fakeWeb({}), observer: fakeObserver({}, { ...yellowObs, brandVisible: "Zorb" }) });
  check("an unknown maker is not forced into a family", stranger.family === null && /needs research/.test(stranger.uncertainty.join(" ")));

  section("a claimed model that may not exist (RTX 4080 Ti)");
  const nvidia = "https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/";
  const lineupText = "GeForce RTX 4090. GeForce RTX 4080 SUPER and GeForce RTX 4080. GeForce RTX 4070 Ti SUPER, GeForce RTX 4070 Ti, GeForce RTX 4070 SUPER and GeForce RTX 4070. GeForce RTX 4060 Ti and RTX 4060.";
  const parsed = parseModelClaim("NVIDIA GeForce RTX 4080 Ti 16GB");
  check("the claim is parsed into anchor, number and suffix", parsed?.anchor === "rtx" && parsed.number === "4080" && parsed.suffix.join() === "ti", parsed);
  check("a lineup is read from official text", lineupIn("rtx", lineupText).includes("rtx 4080 super") && lineupIn("rtx", lineupText).includes("rtx 4070 ti super"));
  const web4080 = fakeWeb({ [nvidia]: lineupText, "https://www.ebay.com/itm/123": "NVIDIA RTX 4080 Ti 16GB graphics card" });
  const c1 = await challengeModelClaim("NVIDIA GeForce RTX 4080 Ti", web4080);
  check("the RTX 4080 Ti is NOT in the official lineup, and Clynx says so from a lineup it read", c1.verdict === "not_in_official_lineup" && c1.officialLineup.length >= 6, c1);
  check("alternatives come from the official page, same number first, nothing invented", c1.alternatives[0] === "rtx 4080" || c1.alternatives[0] === "rtx 4080 super", c1.alternatives);
  check("every alternative really appears on the page", c1.alternatives.every((a) => lineupIn("rtx", lineupText).includes(a)));
  const c2 = await challengeModelClaim("RTX 4080 Super", fakeWeb({ [nvidia]: lineupText }));
  check("a real model is confirmed from the official page", c2.verdict === "exists_official");
  const c3 = await challengeModelClaim("NVIDIA GeForce RTX 4080 Ti", fakeWeb({ "https://www.ebay.com/itm/123": "NVIDIA RTX 4080 Ti graphics card, brand new" }));
  check("when only a marketplace mentions it, the answer is 'unverified', never 'fake' and never 'real'", c3.verdict === "unverified_seller_only", c3);
  const c4 = await challengeModelClaim("NVIDIA GeForce RTX 4080 Ti", fakeWeb({}));
  check("when nothing could be read, it says nothing could be checked", c4.verdict === "unverified_no_official_source");
  const apple = "https://www.apple.com/iphone/compare/";
  const c5 = await challengeModelClaim("Apple iPhone 15 Pro Plus", fakeWeb({ [apple]: "iPhone 15, iPhone 15 Plus, iPhone 15 Pro and iPhone 15 Pro Max. iPhone 14 and iPhone 14 Plus." }));
  check("the same logic works for phones, not only graphics cards", c5.verdict === "not_in_official_lineup" && c5.alternatives.includes("iphone 15 pro") , c5);
  check("a name with no model number says it cannot be checked this way", (await challengeModelClaim("Vintage Brass Lamp", fakeWeb({}))).verdict === "unverified_no_official_source");
  store.close();
});
