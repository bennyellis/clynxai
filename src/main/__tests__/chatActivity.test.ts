// Live web activity in chat, and the photo tool's "ask, don't guess" wording. Fakes only: no network, no model.
import { apiBackends } from "../searchApis.js";
import { createEvidenceDeps, withWebActivity } from "../webEvidence.js";
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
});
