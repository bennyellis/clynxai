// Beta 14: the service decides WHEN to research; a fake web counts the searches.
import { createKnowledgeService } from "../knowledgeService.js";
import { apiBackends, parseBraveApi, parseGoogleApi, configuredSearchApis, createDailyBudget } from "../searchApis.js";
import { createEvidenceDeps, redactSecrets } from "../webEvidence.js";
import { familyKey, type ProductKnowledge } from "../knowledgeRegistry.js";
import { beta13Flags } from "../beta13.js";
import { check, run, section } from "./_testkit.js";

const PAGE = "Meta Quest 3 comes in 128GB and 512GB. The Meta Quest 3S is a cheaper headset.";
function web() {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      async search(q: string) {
        asked.push(q);
        return [{ title: "Meta", url: "https://www.meta.com/quest/quest-3/", snippet: PAGE }, { title: "Review", url: "https://example.com/r", snippet: PAGE }];
      },
      async fetchText() {
        return PAGE;
      },
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

run(async () => {
  section("when it researches");
  const mem = new Map<string, ProductKnowledge>();
  const w = web();
  let mode: "off" | "shadow" | "enforce" = "shadow";
  const svc = createKnowledgeService({ store: { getKnowledge: (k) => mem.get(k) ?? null, saveKnowledge: (k) => void mem.set(k.key, k) }, mode: () => mode, web: () => w.deps });
  svc.consider("Xbox Series X", { identityConfidence: "high" });
  await tick();
  check("an obvious product never triggers a search", w.asked.length === 0);
  svc.consider("Meta Quest 3 128GB", { identityConfidence: "low", reasonCodes: ["CAPACITY_NOT_STATED"] });
  await tick();
  check("an unsure product is researched in the background", w.asked.length > 0 && mem.has("meta quest 3"));
  const before = w.asked.length;
  svc.consider("Meta Quest 3 512GB", { identityConfidence: "low" });
  await tick();
  check("the same line is not researched twice", w.asked.length === before);
  check("what was learned is available to the comparable check", svc.cached("Meta Quest 3 128GB")?.distinctModels.some((m) => m.name.endsWith("3s")) === true);
  mode = "off";
  svc.consider("Brand New Gadget 9", { identityConfidence: "low" });
  await tick();
  check("switched off means no research", !w.asked.some((q) => q.includes("gadget")));

  section("the switch");
  check("research defaults to shadow", beta13Flags({}).webKnowledge === "shadow");
  check("it can be switched to enforce or off", beta13Flags({ beta13: { webKnowledge: "enforce" } }).webKnowledge === "enforce" && beta13Flags({ beta13: { webKnowledge: "nonsense" as never } }).webKnowledge === "shadow");

  section("official search APIs");
  check("with no keys nothing extra is used", configuredSearchApis({}).length === 0 && apiBackends({}).length === 0);
  const both = apiBackends({ GOOGLE_CSE_API_KEY: "k", GOOGLE_CSE_ID: "cx", BRAVE_SEARCH_API_KEY: "b" });
  check("Google first, then Brave", both.map((b) => b.name).join() === "google-api,brave-api");
  check("Google needs both its key and its engine id", apiBackends({ GOOGLE_CSE_API_KEY: "k" }).length === 0);
  check("Google results parse (markup removed)", parseGoogleApi(JSON.stringify({ items: [{ title: "A <b>x</b>", link: "https://a.example", snippet: "s  t" }] }))[0].title === "A x");
  check("Brave results parse", parseBraveApi(JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example", description: "d" }] } }))[0].url === "https://b.example");
  check("garbage parses to nothing", parseGoogleApi("<html>").length === 0 && parseBraveApi("{").length === 0);
  const g = both[0];
  check("a spent quota is an error to back off from, not 'no results'", g.isBlocked!(429, "") && g.isBlocked!(403, "quota") && !g.isBlocked!(200, "{}"));
  check("the key travels but is redacted from anything shown", redactSecrets("GET https://www.googleapis.com/customsearch/v1?key=SECRET123&cx=abc&q=x failed").includes("***") && !redactSecrets("?key=SECRET123&cx=abc").includes("SECRET123"));
  const budget = createDailyBudget(2, () => Date.UTC(2026, 0, 1));
  budget.take();
  budget.take();
  check("the daily allowance stops further queries", !budget.peek() && !budget.take());
  const nextDay = createDailyBudget(1, (() => { let t = Date.UTC(2026, 0, 1); return () => (t += 20 * 3600_000); })());
  nextDay.take();
  check("the allowance renews the next day", nextDay.peek());

  section("the shared search reader uses the API first and falls back");
  const calls: string[] = [];
  const headersSeen: Array<Record<string, string>> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    headersSeen.push((init?.headers ?? {}) as Record<string, string>);
    if (String(url).includes("api.search.brave.com")) return new Response(JSON.stringify({ web: { results: [{ title: "Brave hit", url: "https://hit.example/q", description: "d" }] } }), { status: 200 });
    return new Response("<html></html>", { status: 200 });
  }) as unknown as typeof fetch;
  const deps = createEvidenceDeps({ fetchImpl: fakeFetch, backends: apiBackends({ BRAVE_SEARCH_API_KEY: "tok" }), searchGapMs: 0 });
  const hits = await deps.search("meta quest 3 storage", 5);
  check("the API answered and carried its token header", hits[0]?.title === "Brave hit" && headersSeen[0]["X-Subscription-Token"] === "tok");
  check("the trace names the backend but never the key", deps.trace().searches[0].backend === "brave-api" && !JSON.stringify(deps.trace()).includes("tok\""));
  const quotaFetch = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
  const d2 = createEvidenceDeps({ fetchImpl: quotaFetch, backends: apiBackends({ BRAVE_SEARCH_API_KEY: "tok" }), searchGapMs: 0 });
  const none = await d2.search("x", 5);
  check("a refused API is traced as blocked", none.length === 0 && d2.trace().searches[0].outcome === "blocked");
  check("family key helper is stable", familyKey("Meta Quest 3 512GB") === familyKey("Meta Quest 3 128GB"));
});
