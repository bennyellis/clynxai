// Live web activity in chat, and the photo tool's "ask, don't guess" wording. Fakes only: no network, no model.
import { apiBackends } from "../searchApis.js";
import { createEvidenceDeps, relevantHit, wikipediaBackend, withWebActivity } from "../webEvidence.js";
import { describeIdentification } from "../visualService.js";
import { toolStatusLabel } from "../chatSupport.js";
import { applyStatusEvent } from "../../renderer/src/lib/chatStatus.js";
import type { IdentityDecision } from "../identityResearch.js";
import { check, run, section } from "./_testkit.js";

const base = (o: Partial<IdentityDecision>): IdentityDecision => ({ family: null, model: null, edition: null, remainingModels: [], eliminated: [], editionMatches: [], uncertainty: [], authenticity: "unverified", observation: null, queries: [], sources: [], stats: { searches: 0, visionCalls: 0, cacheHits: 0, ms: 0 }, trace: [], ...o });

run(async () => {
  section("web activity reaches the chat while it happens");
  const fakeFetch = (async (url: any) => {
    if (String(url).includes("api.search.brave.com")) return new Response(JSON.stringify({ web: { results: [{ title: "A", url: "https://hit.example/q", description: "d" }] } }), { status: 200 });
    return new Response("<html><body>" + "New Nintendo 3DS XL Galaxy Style. ".repeat(40) + "</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const deps = createEvidenceDeps({ fetchImpl: fakeFetch, backends: apiBackends({ BRAVE_SEARCH_API_KEY: "tok" }), searchGapMs: 0, allowLocal: true });
  const lines: string[] = [];
  await withWebActivity((l) => lines.push(l), async () => {
    await deps.search("new 3ds xl galaxy", 5);
    await deps.fetchText("https://hit.example/q");
  });
  check("a search and a page read each announce themselves", lines.length === 2 && /Searched brave-api/.test(lines[0]) && /Read hit\.example/.test(lines[1]), lines);
  check("the key never appears", !lines.join(" ").includes("tok\""));
  const other: string[] = [];
  await Promise.all([withWebActivity((l) => other.push(l), () => deps.search("x", 5)), deps.search("y", 5)]);
  check("a search outside a chat announces nothing to it", other.length === 1);
  const quota = createEvidenceDeps({ fetchImpl: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch, backends: apiBackends({ BRAVE_SEARCH_API_KEY: "tok" }), searchGapMs: 0 });
  const bad: string[] = [];
  await withWebActivity((l) => bad.push(l), () => quota.search("x", 5));
  check("a refused search is shown as refused, not as nothing found", /refused/.test(bad[0] ?? ""), bad);

  section("status events");
  let st = applyStatusEvent({}, { requestId: "r", stepId: "t:a1", kind: "notice", label: "Searched brave-api", state: "end", startedAt: 1, ok: true }, 5);
  check("a notice is kept as a finished step", st.r.length === 1 && st.r[0].endedAt === 5 && st.r[0].kind === "notice");
  check("the photo tool has a label", /photo/i.test(toolStatusLabel("identify_from_photo", {})));

  section("asking instead of guessing");
  const unsure = describeIdentification(base({ remainingModels: ["New Nintendo 3DS", "New Nintendo 3DS XL"] }));
  check("several candidates => low confidence, ask the user, options named", /CONFIDENCE IS LOW/.test(unsure) && /ask_choice/.test(unsure) && /New Nintendo 3DS XL/.test(unsure), unsure);
  const sure = describeIdentification(base({ model: { value: "New Nintendo 3DS XL", kind: "inferred", sources: [] }, edition: { value: "Galaxy Style", kind: "inferred", sources: [] } }));
  check("a settled answer does not ask, and never claims authenticity", !/CONFIDENCE IS LOW/.test(sure) && /cannot show whether/.test(sure), sure);

  section("unrelated results are dropped and the next engine is tried");
  const q = "New Nintendo 3DS XL special editions list";
  check("news pages are not about the search", !relevantHit(q, { title: "Breaking news today", url: "https://www.foxnews.com/", snippet: "Latest headlines" }));
  check("a catalogue page is", relevantHit(q, { title: "New Nintendo 3DS XL special editions", url: "https://consolevariations.com/x", snippet: "limited editions" }));
  const junkBing = `<li class="b_algo"><h2><a href="https://www.foxnews.com/">Fox News</a></h2><p>headlines</p></li>`;
  const wiki = JSON.stringify({ query: { search: [{ title: "New Nintendo 3DS", snippet: "The <span>New Nintendo 3DS XL</span> special editions" }] } });
  const f2 = (async (url: any) => (String(url).includes("wikipedia") ? new Response(wiki, { status: 200 }) : new Response(junkBing, { status: 200 }))) as unknown as typeof fetch;
  const lines2: string[] = [];
  const d3 = createEvidenceDeps({ fetchImpl: f2, relevance: true, searchGapMs: 0, backends: [{ name: "bing", request: (x) => ({ url: `https://bing.test/?q=${x}` }), parse: (b) => (b.includes("b_algo") ? [{ title: "Fox News", url: "https://www.foxnews.com/", snippet: "headlines" }] : []), isBlocked: () => false }, wikipediaBackend()] });
  const got = await withWebActivity((l) => lines2.push(l), () => d3.search(q, 5));
  check("junk from the first engine falls through to Wikipedia", got.length === 1 && /wikipedia\.org\/wiki\/New_Nintendo_3DS/.test(got[0].url), got);
  check("the activity says the first engine's results were unrelated", lines2.some((l) => /none were about the search/.test(l)) && lines2.some((l) => /Searched wikipedia/.test(l)), lines2);
  const skipped: string[] = [];
  const d4 = createEvidenceDeps({ fetchImpl: f2, searchGapMs: 0, backends: [{ name: "off", skip: () => "switched off", run: async () => [] }, wikipediaBackend()] });
  await withWebActivity((l) => skipped.push(l), () => d4.search(q, 5));
  check("an engine that was simply skipped is not shown as a failure", skipped.length === 1 && /wikipedia/.test(skipped[0]), skipped);
});
