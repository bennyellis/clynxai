// The background runner for observation-first research: rationing, shadow mode, no-op in Save-credits mode, and what lands in AI Activity. Fake eyes and web (see identityResearch.test.ts
// for what that does and does not prove).
import { DatabaseSync } from "node:sqlite";
import { KnowledgeGraph } from "../knowledgeGraph.js";
import { apiActivity } from "../apiActivity.js";
import { createVisualService, describeChallenge, describeDecision, rememberLineup } from "../visualService.js";
import { challengeModelClaim } from "../claimChallenge.js";
import type { Observer } from "../identityResearch.js";
import { beta13Flags } from "../beta13.js";
import { toolsForContext } from "../chat.js";
import { check, run, section } from "./_testkit.js";

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const obs = { objectKind: "handheld game console", brandVisible: "Nintendo", colors: ["yellow"], artwork: [], features: [], photos: 1, limits: [] };
const eyes = (calls: { n: number }): Observer => ({ observe: async () => (calls.n++, obs), answer: async (_i, qs) => Object.fromEntries(qs.map((q) => [q.aspect, { option: "not_visible", note: "" }])) });
const web = { search: async () => [], fetchText: async () => null };

run(async () => {
  const graph = new KnowledgeGraph(new DatabaseSync(":memory:"));
  const seenBefore = apiActivity.snapshot().decisions.length;
  const calls = { n: 0 };
  let mode: "off" | "shadow" = "shadow";
  let lowAi = false;
  const svc = createVisualService({ graph: () => graph, web: () => web, observer: () => eyes(calls), mode: () => mode, lowAi: () => lowAi, perHour: 2 });

  section("shadow mode researches quietly and records, nothing else");
  svc.consider({ key: "l1", title: "Yellow Nintendo DS", images: ["data:image/jpeg;base64,AAAA"] });
  await wait();
  const d = apiActivity.snapshot().decisions.filter((x) => x.kind === "visual_identity");
  check("a decision is recorded in AI Activity, labelled as shadow (nothing changed)", d.length === 1 && /would conclude/.test(d[0].verdict) && /Shadow mode: nothing was changed/.test(d[0].thought ?? ""), d);
  check("the 3DS knowledge was seeded for it, in the knowledge graph only", graph.find("Nintendo 3DS XL").length === 1);
  svc.consider({ key: "l1", title: "Yellow Nintendo DS", images: ["data:image/jpeg;base64,AAAA"] });
  await wait();
  check("the same listing is not researched twice", calls.n === 1);

  section("rationing and switches");
  svc.consider({ key: "l2", title: "another", images: ["data:image/jpeg;base64,AAAA"] });
  svc.consider({ key: "l3", title: "third", images: ["data:image/jpeg;base64,AAAA"] });
  await wait();
  check("only 2 per hour are researched", calls.n === 2);
  mode = "off";
  const lim2 = createVisualService({ graph: () => graph, web: () => web, observer: () => eyes(calls), mode: () => "off" });
  lim2.consider({ key: "x", title: "t", images: ["data:image/jpeg;base64,AAAA"] });
  lowAi = true;
  const lim3 = createVisualService({ graph: () => graph, web: () => web, observer: () => eyes(calls), mode: () => "shadow", lowAi: () => true });
  lim3.consider({ key: "y", title: "t", images: ["data:image/jpeg;base64,AAAA"] });
  lim3.consider({ key: "z", title: "t", images: [] });
  await wait();
  check("off, Save-credits mode and photo-less listings do nothing", calls.n === 2);
  check("no key means no AI call (observer unavailable)", (() => { const n = calls.n; createVisualService({ graph: () => graph, web: () => web, observer: () => null, mode: () => "shadow" }).consider({ key: "q", title: "t", images: ["data:image/jpeg;base64,AAAA"] }); return calls.n === n; })());
  check("the switch defaults to shadow and can be turned off", beta13Flags({}).visualResearch === "shadow" && beta13Flags({ beta13: { visualResearch: "off" } }).visualResearch === "off");

  section("a model name in the title is checked, and what is learned is kept as knowledge");
  const nvidia = "https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/";
  const lineup = "GeForce RTX 4090. GeForce RTX 4080 SUPER and GeForce RTX 4080. GeForce RTX 4070 Ti SUPER, GeForce RTX 4070 Ti.";
  const gpuWeb = { search: async () => [{ title: "NVIDIA 40 series", url: nvidia, snippet: lineup.slice(0, 60) }], fetchText: async () => lineup };
  const c = await challengeModelClaim("NVIDIA GeForce RTX 4080 Ti", gpuWeb);
  rememberLineup(graph, c);
  check("the maker's models are remembered with their official source", graph.find("rtx 4080 super")[0]?.status === "verified" && graph.find("rtx 4080 ti").length === 0);
  check("the one-line description says it is not in the lineup and offers real models", /NOT in the maker's lineup/.test(describeChallenge(c)) && /rtx 4080/.test(describeChallenge(c)));
  const gpuSvc = createVisualService({ graph: () => graph, web: () => gpuWeb, observer: () => eyes(calls), mode: () => "shadow" });
  gpuSvc.consider({ key: "gpu1", title: "NVIDIA GeForce RTX 4080 Ti 16GB", images: ["data:image/jpeg;base64,AAAA"] });
  await wait(600);
  const snap = apiActivity.snapshot().decisions;
  check("the claim check is its own AI Activity entry", snap.some((x) => x.kind === "model_claim_check" && /not in official lineup/.test(x.verdict)));
  check("the chat can run the same check", toolsForContext("global").some((t) => t.function.name === "check_model_name") && toolsForContext("database").some((t) => t.function.name === "check_model_name"));
  check("describing a decision never overstates (no model named when none was decided)", describeDecision({ family: null, model: null, edition: null, remainingModels: ["A", "B"], eliminated: [], editionMatches: [], uncertainty: [], authenticity: "unverified", observation: null, queries: [], sources: [], stats: { searches: 0, visionCalls: 0, cacheHits: 0, ms: 0 }, trace: [] }) === "model: undecided between A, B");
  void seenBefore;
});
