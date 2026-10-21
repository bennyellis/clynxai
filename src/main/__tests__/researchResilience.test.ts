// Beta 28 live-test findings (TESTER) that were left: "I read X as Y" never reached the chat, and a failing or hanging sold-price lookup took the whole price research (and the asking-price
// estimate) down with it. Scripted model, fakes, no network.
import { streamChat, type ChatMessage, type ToolCall } from "../chat.js";
import { extractCorrectionSentence, markCorrectionShown } from "../chatIntent.js";
import { friendlySoldFailure, softSoldLookup } from "../researchFailure.js";
import { buildVocabulary, describeCorrections, normalizeTypedProduct } from "../typedInput.js";
import { estimateMarketValue } from "../marketValue.js";
import { baseConfig } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

let calls = 0;
let script: (call: number, body: any) => { content?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> } = () => ({ content: "ok" });
const bodies: any[] = [];
process.env.OPENAI_API_KEY = "k";
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  if (!String(url).includes("api.openai.com")) return new Response("", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}"));
  bodies.push(body);
  const t = script(++calls, body);
  const lines: string[] = [];
  if (t.content) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: t.content } }] })}`);
  (t.tools ?? []).forEach((tool, i) => lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${calls}_${i}`, function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } }] })}`));
  lines.push("data: [DONE]");
  return new Response(lines.join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

run(async () => {
  section("the correction sentence is shown by the app, not left to the model");
  const vocab = buildVocabulary(["Xbox Series X Galaxy Edition"]);
  const n = normalizeTypedProduct("xbox seris x galxy edition", vocab);
  const toolText = `${describeCorrections(n)} Started researching "Xbox Series X Galaxy Edition".`;
  const sentence = extractCorrectionSentence(toolText);
  check("the sentence is lifted out of the tool answer exactly", !!sentence && sentence.startsWith('I read "xbox seris x galxy edition" as "') && sentence.endsWith(").") && !/BEGIN/.test(sentence), sentence);
  check("a tool answer with no correction has none", extractCorrectionSentence('Started researching "Xbox Series X".') === null);
  check("the instruction to begin with it is replaced by 'already shown'", /ALREADY been shown/.test(markCorrectionShown(toolText)) && !/BEGIN your reply/.test(markCorrectionShown(toolText)) && /Started researching/.test(markCorrectionShown(toolText)));

  const streamed: string[] = [];
  calls = 0;
  bodies.length = 0;
  script = (call) => (call === 1 ? { tools: [{ name: "research_product", args: { product: "xbox seris x galxy edition" } }] } : { content: "On it: the Galaxy edition is being researched." });
  const reply = await streamChat("xbox seris x galxy edition", [] as ChatMessage[], "global", baseConfig(), [], [], [], (d) => streamed.push(d), async (_call: ToolCall) => toolText, null, [], [], []);
  check("the 'I read' sentence is in the streamed text and the final reply even though the model never wrote it", streamed.join("").includes('I read "xbox seris x galxy edition" as') && reply.includes('I read "xbox seris x galxy edition" as'), { reply, streamed: streamed.join("") });
  check("it comes first, then the model's own words", reply.indexOf("I read") < reply.indexOf("On it"), reply);
  check("the model was told it was already shown (so it does not say it twice)", JSON.stringify(bodies[1].messages).includes("ALREADY been shown") && !JSON.stringify(bodies[1].messages).includes("BEGIN your reply"));
  const twice = await (async () => {
    calls = 0;
    script = (call) => (call === 1 ? { tools: [{ name: "research_product", args: { product: "x" } }] } : { content: `${sentence} Researching now.` });
    return streamChat("x", [] as ChatMessage[], "global", baseConfig(), [], [], [], () => {}, async () => toolText, null, [], [], []);
  })();
  check("a model that writes the sentence anyway does not make it appear twice", (twice.match(/I read "xbox seris x galxy edition" as/g) ?? []).length <= 2 && twice.includes("Researching now"), twice);

  section("a failing or hanging sold-price lookup no longer takes the research down");
  const ok = await softSoldLookup(async () => [1, 2, 3], 1000);
  check("a lookup that works returns its comps", ok.comps.length === 3 && ok.failure === null);
  const bad = await softSoldLookup(async () => { throw new Error("browserType.launchPersistentContext: Timeout 180000ms exceeded. Call log: <launching> chrome.exe --flag"); }, 1000);
  check("a lookup that throws gives no comps and the reason, never an exception", bad.comps.length === 0 && /launchPersistentContext/.test(bad.failure ?? ""), bad);
  const t0 = Date.now();
  const hang = await softSoldLookup(() => new Promise<number[]>(() => {}), 40);
  check("a lookup that hangs is cut at the deadline (the research goes on)", hang.comps.length === 0 && /deadline/.test(hang.failure ?? "") && Date.now() - t0 < 1500, hang);
  check("the notes are plain and say what the research uses instead", [friendlySoldFailure(bad.failure!), friendlySoldFailure(hang.failure!), friendlySoldFailure("weird")].every((m) => /asking on eBay/.test(m) && m.length < 160 && !/chrome|--flag|Call log/.test(m)));
  const asksOnly = estimateMarketValue({ mean: null, n: 0 }, { median: 1000, n: 22 });
  check("with no sold prices, 22 accepted asking prices still give an estimate (from the asking side)", asksOnly.valueUsd !== null && asksOnly.basis === "active" && Math.abs((asksOnly.valueUsd ?? 0) - 920) < 1, asksOnly);
  const oneSaleManyAsks = estimateMarketValue({ mean: 200, n: 1 }, { median: 1000, n: 22 });
  check("ONE sale that wildly disagrees with 22 accepted asking prices no longer leaves 'no price yet': the estimate comes from the asking side", oneSaleManyAsks.valueUsd !== null && oneSaleManyAsks.basis === "active" && Math.abs((oneSaleManyAsks.valueUsd ?? 0) - 920) < 1, oneSaleManyAsks);
  check("but one disagreeing sale with only a few asks still gives no number (not enough to tell which is right)", estimateMarketValue({ mean: 200, n: 1 }, { median: 1000, n: 4 }).valueUsd === null);
  check("two sales that disagree still stand over the asks", estimateMarketValue({ mean: 200, n: 2 }, { median: 1000, n: 22 }).basis === "sold");
});
