// OpenAI web search as an optional, first-choice engine for hard research only. A fake fetch and a fake cloud client stand in for the network: this proves the request, the parsing, the
// gating and the fallback, NOT that OpenAI's web search tool answers the way the request assumes (one real call on your side tells).
import { answerToHits, buildSearchRequest, openAiWebBackend, parseCloudSearch, parseResponses, type SearchAnswer } from "../openaiSearch.js";
import { createEvidenceDeps } from "../webEvidence.js";
import { callOpenAISearch, initOpenAIProxy } from "../openai.js";
import { beta13Flags } from "../beta13.js";
import { apiActivity } from "../apiActivity.js";
import { check, run, section } from "./_testkit.js";

const TEXT = "The Meta Quest 3 comes in 128GB and 512GB. The Quest 3S is a cheaper model.";
const RESPONSES = {
  output: [
    { type: "web_search_call", status: "completed" },
    { type: "message", content: [{ type: "output_text", text: TEXT, annotations: [{ type: "url_citation", url: "https://www.meta.com/quest/quest-3/", title: "Meta Quest 3", start_index: 4, end_index: 20 }, { type: "url_citation", url: "https://www.meta.com/quest/quest-3/", title: "dup", start_index: 4, end_index: 20 }, { type: "url_citation", url: "https://example.com/3s", title: "3S", start_index: 46, end_index: 60 }, { type: "url_citation", url: "javascript:alert(1)", title: "bad", start_index: 0, end_index: 3 }] }] },
  ],
  usage: { input_tokens: 400, output_tokens: 80 },
};
const answer: SearchAnswer = parseResponses(RESPONSES).answer;

run(async () => {
  section("the request and the answer");
  const req = buildSearchRequest("meta quest 3 versions", "gpt-4.1-mini");
  check("one web_search tool, a required search, a capped answer, nothing stored", JSON.stringify(req.tools) === '[{"type":"web_search"}]' && req.tool_choice === "required" && req.max_output_tokens === 600 && req.store === false);
  check("citations are the pages, duplicates and unsafe addresses are dropped", answer.citations.length === 2 && answer.citations.every((c) => /^https:/.test(c.url)));
  check("each page carries the sentence it was cited for", /128GB and 512GB/.test(answer.citations[0].snippet) && /3S is a cheaper/.test(answer.citations[1].snippet), answer.citations);
  check("a cloud answer is validated the same way", parseCloudSearch({ answer: "x", citations: [{ url: "https://a.example", title: "A", snippet: "s" }, { url: "ftp://bad" }] })?.citations.length === 1 && parseCloudSearch({ nope: 1 }) === null);
  const hits = answerToHits(answer, 5);
  check("results look like any engine's: title, address, snippet", hits.length === 2 && hits[0].title === "Meta Quest 3" && hits[0].snippet.length > 10);
  check("it is OFF by default", beta13Flags({}).openaiSearch === false && beta13Flags({ beta13: { openaiSearch: true } }).openaiSearch === true);

  section("it declines itself, so the next engine answers");
  let enabled = true, low = false, calls = 0, fail = false;
  let t = 1_000_000;
  const backend = openAiWebBackend({ enabled: () => enabled, lowAi: () => low, perHour: 2, now: () => t, search: async () => { calls++; if (fail) throw new Error("boom"); return answer; } });
  check("available when on, not in Save-credits mode, under the hourly limit", backend.skip!() === null);
  enabled = false;
  check("switched off", /switched off/.test(backend.skip!() ?? ""));
  enabled = true; low = true;
  check("Save-credits mode", /Save OpenAI credits/.test(backend.skip!() ?? ""));
  low = false;
  await backend.run!("q1", 5);
  await backend.run!("q2", 5);
  check("the hourly limit stops a third search", /hourly limit/.test(backend.skip!() ?? "") && calls === 2);
  t += 3601_000;
  check("and it renews after an hour", backend.skip!() === null);

  section("in the shared reader: first for hard research, with fallback and no repeated failures");
  const seenByFallback: string[] = [];
  const fallback = { name: "fallback", request: (q: string) => ({ url: `https://fb.example/?q=${encodeURIComponent(q)}` }), parse: () => [{ title: "fb", url: "https://fb.example/r", snippet: "fb" }], isBlocked: () => false };
  const fakeFetch = (async (u: string) => (seenByFallback.push(String(u)), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  enabled = true; fail = false; calls = 0;
  const b2 = openAiWebBackend({ enabled: () => enabled, lowAi: () => false, perHour: 50, search: async () => { calls++; if (fail) throw new Error("model not supported"); return answer; } });
  const deps = createEvidenceDeps({ fetchImpl: fakeFetch, backends: [b2, fallback], searchGapMs: 0 });
  const r1 = await deps.search("meta quest 3 versions", 5);
  check("OpenAI's cited pages answer first and the fallback is not touched", r1[0].url === "https://www.meta.com/quest/quest-3/" && seenByFallback.length === 0 && deps.trace().searches[0].backend === "openai-web");
  fail = true;
  const r2 = await deps.search("another phrase here", 5);
  check("when it fails, the next engine answers and the failure is traced", r2[0].url === "https://fb.example/r" && deps.trace().searches.some((s) => s.backend === "openai-web" && s.outcome === "error"));
  const before = calls;
  await deps.search("a third phrase here", 5);
  check("a failing OpenAI search is left alone for a while, not asked for every query", calls === before);
  enabled = false;
  const deps2 = createEvidenceDeps({ fetchImpl: fakeFetch, backends: [openAiWebBackend({ enabled: () => false, lowAi: () => false, perHour: 5, search: async () => answer }), fallback], searchGapMs: 0 });
  const r3 = await deps2.search("meta quest 3 versions", 5);
  check("switched off, only the usual engines are used", r3[0].url === "https://fb.example/r" && deps2.trace().searches[0].detail?.includes("switched off") === true);

  section("the call itself: your own key, or Clynx Cloud");
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; auth: string; body: any }> = [];
  let status = 200;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    sent.push({ url: String(u), auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(status === 200 ? RESPONSES : { error: { message: "tool not supported" } }), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-own";
  const before1 = apiActivity.snapshot().providers.openai.attempted;
  const a = await callOpenAISearch("meta quest 3 versions");
  check("with your own key it goes straight to OpenAI's Responses endpoint with the built request", sent[0].url === "https://api.openai.com/v1/responses" && sent[0].auth === "Bearer sk-test-own" && sent[0].body.tools[0].type === "web_search" && a?.citations.length === 2);
  check("it is recorded in AI Activity as a web search with its tokens", apiActivity.snapshot().recent.some((e) => e.kind === "web search" && e.outcome === "live_ok" && e.route === "own_key" && e.tokens?.total === 480) && apiActivity.snapshot().providers.openai.attempted === before1 + 1);
  delete process.env.OPENAI_API_KEY;
  const cloudCalls: unknown[] = [];
  let cloudMode: "ok" | "off" = "ok";
  initOpenAIProxy({
    isAuthenticated: () => true,
    openAIRequest: async (kind: string, body: unknown) => (cloudCalls.push({ kind, body }), { ok: true as const, response: cloudMode === "ok" ? new Response(JSON.stringify({ answer: "x", citations: [{ url: "https://a.example/p", title: "A", snippet: "s" }] }), { status: 200 }) : new Response(JSON.stringify({ error: "search_not_enabled" }), { status: 503 }) }),
  } as never);
  const c1 = await callOpenAISearch("meta quest 3 versions");
  check("without a key it uses Clynx Cloud's search route and sends only the phrase", c1?.citations[0].url === "https://a.example/p" && JSON.stringify(cloudCalls[0]) === '{"kind":"search","body":{"query":"meta quest 3 versions"}}');
  cloudMode = "off";
  let msg = "";
  try { await callOpenAISearch("another phrase"); } catch (e) { msg = (e as Error).message; }
  check("a server with search switched off is reported, and not asked again for 30 minutes", /503/.test(msg));
  let again = "";
  const n = cloudCalls.length;
  try { await callOpenAISearch("yet another"); } catch (e) { again = (e as Error).message; }
  check("no further requests are made while it is known to be unavailable", /not available/.test(again) && cloudCalls.length === n);
  if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  globalThis.fetch = realFetch;
  void status;
});
