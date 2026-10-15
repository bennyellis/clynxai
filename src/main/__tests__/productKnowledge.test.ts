// Beta 14: Clynx researching a product it is unsure about. A fake web stands in for the search engine and the pages.
import { acceptQueries, describeKnowledge, doubtReasons, ensureKnowledge, extractKnowledge, humanQueries, researchProductKnowledge, createResearchLimiter, keepSupported, type KnowledgePage } from "../productKnowledge.js";
import { capacitiesIn, familyKey, knowledgeFindings, setKnowledgeProvider, suffixModelsIn, type ProductKnowledge } from "../knowledgeRegistry.js";
import { classifyComparable } from "../compIdentity.js";
import type { VerifyDeps } from "../variantEvidence.js";
import { check, run, section } from "./_testkit.js";

const page = (url: string, text: string, sourceClass = "other"): KnowledgePage => ({ url, title: url, text, sourceClass });
const QUEST: KnowledgePage[] = [
  page("https://www.meta.com/quest/quest-3/", "Meta Quest 3 is available with 128GB or 512GB of storage. Meta Quest 3 has 8GB of RAM. Meta Quest 3S is a lower cost headset.", "manufacturer"),
  page("https://example.com/review", "The Quest 3 comes in 128GB and 512GB. The Quest 3S starts cheaper than the Quest 3 and also has 128GB."),
  page("https://example.org/guide", "Which Meta Quest 3 should you buy? The 512GB model costs more than the 128GB. Don't confuse it with the Meta Quest 3S."),
];

function fakeWeb(pages: KnowledgePage[], opts: { blocked?: boolean } = {}): VerifyDeps & { asked: string[] } {
  const asked: string[] = [];
  let trace = { searches: [] as any[], pages: [] as any[] };
  return {
    asked,
    async search(q) {
      asked.push(q);
      if (opts.blocked) {
        trace.searches.push({ query: q, backend: "duckduckgo-html", outcome: "blocked", results: 0 });
        return [];
      }
      trace.searches.push({ query: q, backend: "google-api", outcome: "ok", results: pages.length });
      return pages.map((p) => ({ title: p.title, url: p.url, snippet: p.text.slice(0, 120) }));
    },
    async fetchText(url) {
      return pages.find((p) => p.url === url)?.text ?? null;
    },
    trace: () => trace,
    reset: () => {
      trace = { searches: [], pages: [] };
    },
  };
}

run(async () => {
  section("family and text helpers");
  check("capacity, colour and condition words are not part of the line", familyKey("Meta Quest 3 128GB (White) used") === "meta quest 3", familyKey("Meta Quest 3 128GB (White) used"));
  check("capacities are normalised", capacitiesIn("128 GB and 1TB").join() === "128gb,1tb");
  check("a model suffix is found glued to a number", suffixModelsIn("meta quest 3", "the meta quest 3s is cheaper").join() === "meta quest 3s");
  check("the line alone is not a suffix model", suffixModelsIn("meta quest 3", "the meta quest 3 is great").length === 0);
  check("a normal sentence word is not mistaken for a suffix", suffixModelsIn("meta quest 3", "meta quest 3 supports passthrough").length === 0);

  section("when it is worth looking, and what it types");
  check("an obvious product raises no doubt", doubtReasons({ identityConfidence: "high", resolver: "resolved" }).length === 0);
  check("low confidence and a missing storage size raise doubt", doubtReasons({ identityConfidence: "low", reasonCodes: ["CAPACITY_NOT_STATED"] }).length === 2);
  check("sibling entries with different sizes raise doubt", doubtReasons({ siblingCapacities: ["128gb", "512gb"] }).length === 1);
  const qs = humanQueries("Meta Quest 3 128GB", { siblingCapacities: ["512gb", "128gb"] });
  check("it types like a person, naming both sizes", qs[0] === "meta quest 3 128gb vs 512gb difference", qs);
  check("queries never use operators", qs.every((q) => !/[:"]|site|inurl/.test(q)));
  check("AI queries must be about the product and look human", acceptQueries(["meta quest 3 128gb or 512gb which is better", "site:meta.com quest", "best pizza near me", "x"], "Meta Quest 3").length === 1);

  section("extraction needs two sources or the maker");
  const ex = extractKnowledge("Meta Quest 3 128GB", QUEST);
  check("both storage sizes are found, RAM is not", ex.capacities.join() === "128gb,512gb", ex.capacities);
  check("the Quest 3S is found as a different model", ex.distinctModels.map((m) => m.name).join() === "meta quest 3s" || ex.distinctModels.map((m) => m.name).join() === "quest 3s", ex.distinctModels.map((m) => m.name));
  const one = extractKnowledge("Meta Quest 3", [page("https://blog.example/x", "The Meta Quest 3 comes in 1TB too. The Meta Quest 3 Pro rumour.")]);
  check("a single non-maker source proves nothing", one.capacities.length === 0 && one.distinctModels.length === 0);
  const two = extractKnowledge("Meta Quest 3", [page("https://a.example/x", "The Meta Quest 3 Pro is rumoured."), page("https://b.example/y", "Not the Meta Quest 3 Pro.")]);
  check("two sources agreeing is enough", two.distinctModels.length === 1);
  const skeptic = keepSupported("Meta Quest 3", { capacities: ["2TB", "512GB"], distinctModels: ["meta quest 9 ultra", "meta quest 3s"] }, QUEST, ex);
  check("an AI claim the pages do not say is dropped", !skeptic.capacities.includes("2tb") && !skeptic.distinctModels.some((m) => m.name.includes("ultra")));

  section("the whole research, with a fake web");
  const web = fakeWeb(QUEST);
  const r = await researchProductKnowledge("Meta Quest 3 128GB", web, { context: { siblingCapacities: ["128gb", "512gb"] } });
  check("it succeeds and remembers where it looked", r.ok && r.knowledge.backends.join() === "google-api" && r.knowledge.sources.length > 0);
  check("it searched with human queries", web.asked[0] === "meta quest 3 128gb vs 512gb difference", web.asked);
  const aiQueries = fakeWeb(QUEST);
  const withAi = await researchProductKnowledge("Meta Quest 3", aiQueries, { ai: { queries: async () => ["meta quest 3 vs quest 3s which should i get", "site:evil.com"], facts: async () => ({ capacities: ["512GB"], summary: "Two storage sizes." }) } });
  check("AI queries lead, bad ones are refused", aiQueries.asked[0] === "meta quest 3 vs quest 3s which should i get" && !aiQueries.asked.includes("site:evil.com"));
  check("AI summary is kept", withAi.ok && withAi.knowledge.summary === "Two storage sizes.");
  const blocked = await researchProductKnowledge("Meta Quest 3", fakeWeb([], { blocked: true }));
  check("a blocked search is reported as blocked, not as 'nothing exists'", !blocked.ok && blocked.searchUnavailable === true);

  section("remembered and rationed");
  const mem = new Map<string, ProductKnowledge>();
  const store = { getKnowledge: (k: string) => mem.get(k) ?? null, saveKnowledge: (k: ProductKnowledge) => void mem.set(k.key, k) };
  const w2 = fakeWeb(QUEST);
  const first = await ensureKnowledge("Meta Quest 3 128GB", store, w2);
  const searchesAfterFirst = w2.asked.length;
  const second = await ensureKnowledge("Meta Quest 3 512GB", store, w2);
  check("the second size of the same line is answered from memory", first.ok && second.ok && "cached" in second && w2.asked.length === searchesAfterFirst);
  const failing = new Map<string, ProductKnowledge>();
  await ensureKnowledge("Some Thing 9", { getKnowledge: (k) => failing.get(k) ?? null, saveKnowledge: (k) => void failing.set(k.key, k) }, fakeWeb([], { blocked: true }));
  check("a failed search is never remembered as knowledge", failing.size === 0);
  const lim = createResearchLimiter(1);
  const a = await ensureKnowledge("Meta Quest 3", { getKnowledge: () => null, saveKnowledge: () => undefined }, fakeWeb(QUEST), { limiter: lim });
  const b = await ensureKnowledge("Zorb 5", { getKnowledge: () => null, saveKnowledge: () => undefined }, fakeWeb(QUEST), { limiter: lim });
  check("the hourly allowance stops a second fresh research", a.ok && !b.ok);
  check("a readable one-line summary", describeKnowledge((first as any).knowledge).includes("128gb, 512gb"));

  section("what it learned changes the comparable check");
  const k = (first as any).knowledge as ProductKnowledge;
  check("the 3S title is flagged against a Quest 3 product", knowledgeFindings("Meta Quest 3 128GB", "Meta Quest 3S 128GB White", k).length === 1);
  check("a plain Quest 3 title is not flagged", knowledgeFindings("Meta Quest 3 128GB", "Meta Quest 3 128GB White", k).length === 0);
  check("a 3S product is not flagged for being a 3S", knowledgeFindings("Meta Quest 3S 128GB", "Meta Quest 3S 128GB", k).length === 0);
  const shadowSeen: string[] = [];
  let mode: "off" | "shadow" | "enforce" = "shadow";
  setKnowledgeProvider({ mode: () => mode, lookup: (n) => (familyKey(n) === k.key ? k : null), shadow: (i) => void shadowSeen.push(i.title) });
  const title = "Meta Quest 3S 128GB White";
  check("shadow mode never changes the verdict, but records it", classifyComparable({ name: "Meta Quest 3 128GB" }, title).verdict !== "rejected" && shadowSeen.length === 1);
  mode = "enforce";
  const enforced = classifyComparable({ name: "Meta Quest 3 128GB" }, title);
  check("enforce mode rejects the look-alike model", enforced.verdict === "rejected" && enforced.reasons.some((x) => x.code === "MODEL_VARIANT"));
  check("enforce mode leaves the real product alone", classifyComparable({ name: "Meta Quest 3 128GB" }, "Meta Quest 3 128GB White").verdict !== "rejected");
  mode = "off";
  check("off means off", classifyComparable({ name: "Meta Quest 3 128GB" }, title).verdict !== "rejected");
  setKnowledgeProvider(null);
});
