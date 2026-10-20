// Beta 28 live-test findings (TESTER): a hello started the scanner, a question wrote a watch note, internal tool names appeared in replies, a text fragment was filed as a product, and the
// floating chat sat on top of the screens' own chat boxes. The model is scripted (no model access here): what is proven is the app's behaviour around it.
import fs from "node:fs";
import path from "node:path";
import { streamChat, type ChatMessage, type ChatTrace, type ToolCall } from "../chat.js";
import { isInformationalOnly, plainToolNames, SIDE_EFFECT_TOOLS } from "../chatIntent.js";
import { CLYNX_PERSONA } from "../clynxPersona.js";
import { runVariantFanout, isPlausibleProductName } from "../variantFanout.js";
import { cleanOfficialName } from "../variantLinking.js";
import { baseConfig } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

let script: (call: number) => { content?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> } = () => ({ content: "ok" });
let calls = 0;
process.env.OPENAI_API_KEY = "k";
globalThis.fetch = (async (url: unknown) => {
  if (!String(url).includes("api.openai.com")) return new Response("", { status: 404 });
  const t = script(++calls);
  const lines: string[] = [];
  if (t.content) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: t.content } }] })}`);
  (t.tools ?? []).forEach((tool, i) => lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${calls}_${i}`, function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } }] })}`));
  lines.push("data: [DONE]");
  return new Response(lines.join("\n\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

async function chatTurn(message: string, context: "dashboard" | "global" | "product", model: typeof script) {
  calls = 0;
  script = model;
  const ran: string[] = [];
  const trace: ChatTrace = { rounds: [], tools: [], totalMs: 0, aiCalls: 0, guards: [] };
  const reply = await streamChat(message, [] as ChatMessage[], context, baseConfig(), [], [], [], () => {}, async (call: ToolCall) => (ran.push(call.name), `Done: ${call.name}`), null, [], [], [], trace);
  return { reply, ran, trace };
}

run(async () => {
  section("a greeting or a question is not a request to change anything");
  const informational = ["hi! what can you do for me?", "hi", "Hello", "thanks!", "what should I check before buying one?", "is it worth flipping?", "how does the scanner work?", "which edition is the rare one?"];
  for (const m of informational) check(`"${m}" is informational`, isInformationalOnly(m));
  const requests = ["start the scanner", "can you start the scanner?", "add a Series S under $250 to my search", "stop showing me rentals", "pause the Galaxy watch", "remind me to check the fan noise", "turn on include broken", "clear the feed", "yes", "do it", "go ahead"];
  for (const m of requests) check(`"${m}" is a request (or an answer to one), not informational`, !isInformationalOnly(m));

  const hello = await chatTurn("hi! what can you do for me?", "global", (n) => (n === 1 ? { tools: [{ name: "start_scanner", args: {} }] } : { content: "Hey! I can scan Marketplace, research products and more. Want me to start scanning?" }));
  check("a hello that makes the model call start_scanner does NOT run it", hello.ran.length === 0 && hello.trace.guards.includes("question-not-action"), { ran: hello.ran, guards: hello.trace.guards });
  check("the model gets 'Not run' and answers in words", !/Done/.test(hello.reply) && /scan/i.test(hello.reply), hello.reply);
  const note = await chatTurn("what should I check before buying one?", "product", (n) => (n === 1 ? { tools: [{ name: "add_product_watch_note", args: { note: "check the fan" } }] } : { content: "Test video out, the disc drive and fan noise." }));
  check("a question that makes the model write a watch note does NOT write it", note.ran.length === 0, note.ran);
  const real = await chatTurn("start the scanner", "global", (n) => (n === 1 ? { tools: [{ name: "start_scanner", args: {} }] } : { content: "Started." }));
  check("a real request still runs the tool", real.ran.join() === "start_scanner" && !real.trace.guards.includes("question-not-action"), real);
  const research = await chatTurn("is the dyson v8 worth it?", "global", (n) => (n === 1 ? { tools: [{ name: "web_research", args: { query: "dyson v8 worth" } }] } : { content: "Rough answer." }));
  check("read-only tools (a web search) still run on a question", research.ran.join() === "web_research", research.ran);
  check("the list of guarded tools covers the scanner, settings, lists, watches and notes, and not the read-only ones", ["start_scanner", "stop_scanner", "update_config", "clear_feed", "add_search_item", "create_watch", "delete_watch", "add_product_watch_note"].every((t) => SIDE_EFFECT_TOOLS.has(t)) && !SIDE_EFFECT_TOOLS.has("web_research") && !SIDE_EFFECT_TOOLS.has("research_product") && !SIDE_EFFECT_TOOLS.has("list_watch_matches"));
  check("the persona says a question is not a request, and 'Done' needs a tool result", /not a request to change anything/.test(CLYNX_PERSONA) && /Never open a reply with "Done"/.test(CLYNX_PERSONA));

  section("internal tool names never reach the person");
  check("research_variants says -> plain words", plainToolNames("Research_variants says the Galaxy edition is official.") === "The variants check says the Galaxy edition is official.", plainToolNames("Research_variants says the Galaxy edition is official."));
  check('"I ran research_product on X" -> plain words', plainToolNames('I ran research_product on "Dyson V8 Absolute" and saved the profile.') === 'I ran the product research on "Dyson V8 Absolute" and saved the profile.');
  check("backticked names and several names in one reply", plainToolNames("I used `web_research` then library_op and add_product_watch_note.") === "I used a web search then the Library and a watch note.");
  check("ordinary text with underscores or the word 'research' is untouched", plainToolNames("Dyson research and a file_name.txt") === "Dyson research and a file_name.txt");
  const leak = await chatTurn("tell me about the dyson v8", "global", () => ({ content: "I ran research_product on the Dyson V8 and research_variants says there are two." }));
  check("a reply that names tools is cleaned before it is returned", !/research_product|research_variants/.test(leak.reply) && /product research/.test(leak.reply), leak.reply);

  section("a text fragment is not a product name");
  for (const bad of ["Xbox (modern Console & common Bundle", "Xbox Series X Bundle (", "Xbox Series X &", "Xbox Series X with", "[Xbox Series X", "<b>Xbox</b>", "ab", "https://x.com/y xbox"]) check(`"${bad}" is not plausible`, !isPlausibleProductName(bad));
  for (const good of ["Xbox Series X", "Xbox Series X 2TB Galaxy Black Special Edition", "Canon EOS R6 Mark II (Body Only)", "Sony WH-1000XM4", "Nikon Z6 II 24.5MP body", "PlayStation 5 Slim [Digital Edition]"]) check(`"${good}" is plausible`, isPlausibleProductName(good));
  const filed: string[] = [];
  const noted: string[] = [];
  const out = await runVariantFanout(["Xbox (modern Console & common Bundle", "Xbox Series S"], {
    alreadyTracked: () => false,
    verify: async (name) => ({ claim: name, status: "verified", basis: "t", sources: [], matchedAttributes: [], missingAttributes: [], searched: [], checkedAt: 1 } as never),
    create: async (name) => void filed.push(name),
    rememberClaim: () => {},
    paused: () => false,
    sleep: async () => {},
    note: (m) => void noted.push(m),
  });
  check("the fan-out never verifies or files the fragment, and says why", filed.join() === "Xbox Series S" && out.skipped.includes("Xbox (modern Console & common Bundle") && noted.some((n) => /text fragment/.test(n)), { filed, out, noted });
  check("an official name with unbalanced brackets is never adopted", cleanOfficialName("Xbox Series X Galaxy Edition (modern Console & common Bundle", "Xbox Series X Galaxy Edition") === null && cleanOfficialName("Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Galaxy Edition") !== null);

  section("the floating chat leaves room instead of covering the screen's own chat box");
  const root = process.cwd();
  const css = fs.readFileSync(path.join(root, "src", "renderer", "src", "styles", "global.css"), "utf8");
  const bar = fs.readFileSync(path.join(root, "src", "renderer", "src", "components", "GlobalAssistantBar.tsx"), "utf8");
  check("the bar publishes whether it is open", /dataset\.floatingChat = minimized \? "closed" : "open"/.test(bar) && /delete document\.documentElement\.dataset\.floatingChat/.test(bar));
  check("while it is open every screen except Activity gets 392px of right padding, on wide windows only", /@media \(min-width: 1000px\)[\s\S]*html\[data-floating-chat="open"\] \[data-screen\]:not\(\[data-screen="activity"\]\)[\s\S]*padding-right: 392px/.test(css));
});
