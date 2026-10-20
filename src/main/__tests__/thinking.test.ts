// Discovery UI step 4 (AUDITOR proposal section 3, owner-accepted): Clynx's narrated thinking. The main process sends small, sanitised, capped items (a thought line, a page it read, a photo it looked
// at) as status events; the screen folds them into a collapsible block. Everything here is a real event the app recorded, never the model's hidden reasoning. Fakes only: a scripted model, a fake web.
import fs from "node:fs";
import path from "node:path";
import { streamChat, type ChatMessage, type ToolCall } from "../chat.js";
import type { ChatStatusEvent } from "../chatSupport.js";
import { MAX_THINKING_ITEMS, THUMB_MAX_CHARS, ThinkingBudget, hostOf, publicPageUrl, sanitizeThinkingItem, thoughtForFailure, thoughtForTool, thoughtFromWebLine } from "../thinking.js";
import { apiBackends } from "../searchApis.js";
import { createEvidenceDeps, withWebActivity } from "../webEvidence.js";
import { applyStatusEvent, thinkingItems, thinkingSummary, type RequestSteps } from "../../renderer/src/lib/chatStatus.js";
import { buildView } from "../../renderer/src/lib/discoveryStream.js";
import { baseConfig } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

const JPEG = `data:image/jpeg;base64,${Buffer.from("x".repeat(300)).toString("base64")}`;

let calls = 0;
let script: (call: number) => { content?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> } = () => ({ content: "ok" });
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

run(async () => {
  section("addresses are public and carry nothing personal");
  check("a public page keeps its path but loses credentials, query string and fragment", publicPageUrl("https://user:pw@www.example.com/p/xbox?session=abc&email=a@b.c#top") === "https://www.example.com/p/xbox");
  check("non-web, local and private addresses are refused", ["file:///C:/x", "javascript:alert(1)", "ftp://x.com/a", "http://localhost:3000/x", "http://127.0.0.1/x", "http://192.168.1.5/x", "http://10.0.0.2/x", "http://172.20.1.1/x", "not a url", ""].every((u) => publicPageUrl(u) === null));
  check("host names read well", hostOf("https://www.xbox.com/en-US/x") === "xbox.com");

  section("an item is cleaned, or it is dropped");
  check("a thought is one trimmed line, capped", sanitizeThinkingItem({ type: "thought", text: "  hello \n  there  " })?.text === "hello there" && (sanitizeThinkingItem({ type: "thought", text: "x".repeat(900) })?.text?.length ?? 0) <= 200 && sanitizeThinkingItem({ type: "thought", text: "   " }) === null);
  check("a page needs a public address and gets its domain as the title when it has none", sanitizeThinkingItem({ type: "page", url: "https://www.xbox.com/a?x=1" })?.title === "xbox.com" && sanitizeThinkingItem({ type: "page", url: "http://localhost/a" }) === null);
  check("a photo needs a small image data URI; anything else is dropped", sanitizeThinkingItem({ type: "image", thumbnail: JPEG })?.thumbnail === JPEG && sanitizeThinkingItem({ type: "image", thumbnail: "https://x.com/a.jpg" }) === null && sanitizeThinkingItem({ type: "image", thumbnail: "data:text/html;base64,AAAA" }) === null && sanitizeThinkingItem({ type: "image", thumbnail: `data:image/jpeg;base64,${"A".repeat(THUMB_MAX_CHARS)}` }) === null && sanitizeThinkingItem({ type: "image" }) === null);
  check("a photo's note is kept short", (sanitizeThinkingItem({ type: "image", thumbnail: JPEG, text: "y".repeat(500) })?.text?.length ?? 0) <= 200);
  check("nothing else gets through", sanitizeThinkingItem(null) === null && sanitizeThinkingItem({ type: "video" as never }) === null);

  section("a turn shows at most 20 items, no repeats");
  const b = new ThinkingBudget();
  check("the same thought twice in a row, and the same page twice, are shown once", b.admit({ type: "thought", text: "Checking." }) !== null && b.admit({ type: "thought", text: "Checking." }) === null && b.admit({ type: "page", url: "https://a.com/x?1" }) !== null && b.admit({ type: "page", url: "https://a.com/x?2" }) === null && b.count === 2);
  const many = new ThinkingBudget();
  let shown = 0;
  for (let i = 0; i < 60; i++) if (many.admit({ type: "thought", text: `line ${i}` })) shown++;
  check(`however many are offered, ${MAX_THINKING_ITEMS} are shown`, shown === MAX_THINKING_ITEMS && many.count === MAX_THINKING_ITEMS);

  section("thought lines are written by the app, from what really happened");
  check("tools get a first-person line; a tool without one gets none", thoughtForTool("web_research", { query: "xbox series x galaxy" }) === 'I\'m searching the web for "xbox series x galaxy".' && /looking into Dyson V8/.test(thoughtForTool("research_product", { product: "Dyson V8" })!) && /close look at your photo/.test(thoughtForTool("identify_from_photo", {})!) && thoughtForTool("start_scanner", {}) === null);
  check("a long argument is cut, not dumped", (thoughtForTool("web_research", { query: "q".repeat(500) }) ?? "").length < 120);
  check("a failure line is plain and keeps the raw error out", !/Error|ECONN|stack/.test(thoughtForFailure("web_research")) && thoughtForFailure("web_research").length < 120);
  check("a web line becomes a thought", thoughtFromWebLine('Searched brave-api for "x": 5 results', true)?.text === 'Searched brave-api for "x": 5 results' && thoughtFromWebLine("  ", true) === null);

  section("the web reader announces the PAGE it read, with no query string");
  const fakeFetch = (async (url: any) => {
    if (String(url).includes("api.search.brave.com")) return new Response(JSON.stringify({ web: { results: [{ title: "A", url: "https://hit.example/q?utm=1", description: "d" }] } }), { status: 200 });
    return new Response("<html><body>" + "Xbox Series X Galaxy Black Special Edition. ".repeat(40) + "</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const deps = createEvidenceDeps({ fetchImpl: fakeFetch, backends: apiBackends({ BRAVE_SEARCH_API_KEY: "tok" }), searchGapMs: 0, allowLocal: true });
  const seen: Array<{ line: string; item?: unknown }> = [];
  await withWebActivity((line, _ok, item) => seen.push({ line, item }), async () => {
    await deps.search("xbox galaxy", 5);
    await deps.fetchText("https://hit.example/q?utm=1");
  });
  const pageEvt = seen.find((s) => /^Read hit\.example/.test(s.line));
  check("a page that was read carries a page item; a search line carries none", !!pageEvt && (pageEvt.item as { type?: string })?.type === "page" && (seen.find((s) => /^Searched/.test(s.line))?.item ?? null) === null, seen);
  const unreadable = createEvidenceDeps({ fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch, backends: apiBackends({ BRAVE_SEARCH_API_KEY: "tok" }), searchGapMs: 0, allowLocal: true });
  const bad: Array<{ item?: unknown }> = [];
  await withWebActivity((_l, _o, item) => bad.push({ item }), async () => {
    await unreadable.fetchText("https://nope.example/a");
  });
  check("a page that could not be read carries no item (it is not something Clynx looked at)", bad.every((x) => !x.item), bad);

  section("through a real chat turn: thoughts, pages and photos arrive as capped status events");
  const events: ChatStatusEvent[] = [];
  const hooks = {
    onStatus: (e: Omit<ChatStatusEvent, "requestId">) => events.push({ requestId: "r", ...e }),
    thumbnail: async (uri: string) => (uri.length < 100 ? null : JPEG),
  };
  calls = 0;
  script = (call) => (call === 1 ? { tools: [{ name: "web_research", args: { query: "xbox series x galaxy edition" } }] } : { content: "Here is what I found." });
  const attach = [{ name: "front.jpg", dataUri: `data:image/jpeg;base64,${"A".repeat(400)}` }, { name: "tiny.jpg", dataUri: "data:image/jpeg;base64,AA" }];
  const executor = async (_call: ToolCall) => {
    await deps.search("xbox galaxy", 5);
    await deps.fetchText("https://hit.example/q?utm=1");
    return "Found two pages.";
  };
  const reply = await streamChat("what is the xbox series x galaxy edition", [] as ChatMessage[], "global", baseConfig(), [], [], [], () => {}, executor, null, [], attach as never, [], undefined, hooks);
  const items = events.filter((e) => e.kind === "thinking");
  check("the turn still answers normally", /found/i.test(reply), reply);
  check("a line about the photos, the usable photo's thumbnail (a photo without one is skipped), the tool's line, the search, and the page", items.some((e) => /close|looking at the \d+ photos|photo you sent|2 photos/i.test(e.item?.text ?? "")) && items.filter((e) => e.item?.type === "image").length === 1 && items.some((e) => /searching the web for "xbox series x galaxy edition"/.test(e.item?.text ?? "")) && items.some((e) => e.item?.type === "page" && e.item.url === "https://hit.example/q"), items.map((e) => e.item));
  check("every thinking event is an instant, finished, sanitised item", items.length > 0 && items.every((e) => e.state === "end" && e.ok === true && !!e.item && !/\?|#/.test(e.item.url ?? "")));
  check("the thumbnails are what the injected shrinker returned, nothing larger", items.filter((e) => e.item?.type === "image").every((e) => e.item?.thumbnail === JPEG));
  const noHook = await (async () => {
    const ev: ChatStatusEvent[] = [];
    calls = 0;
    script = () => ({ content: "ok" });
    await streamChat("hi", [] as ChatMessage[], "global", baseConfig(), [], [], [], () => {}, async () => "", null, [], attach as never, [], undefined, { onStatus: (e) => ev.push({ requestId: "r", ...e }) });
    return ev.filter((e) => e.kind === "thinking" && e.item?.type === "image");
  })();
  check("without a thumbnail maker no photo is shown (never the full picture)", noHook.length === 0);
  const flood = await (async () => {
    const ev: ChatStatusEvent[] = [];
    calls = 0;
    script = (call) => (call === 1 ? { tools: [{ name: "web_research", args: { query: "q" } }] } : { content: "done" });
    const manyPages = async () => {
      for (let i = 0; i < 40; i++) await deps.fetchText(`https://site${i}.example/p`);
      return "read many";
    };
    await streamChat("tell me about it", [] as ChatMessage[], "global", baseConfig(), [], [], [], () => {}, manyPages, null, [], [], [], undefined, { onStatus: (e) => ev.push({ requestId: "r", ...e }) });
    return ev.filter((e) => e.kind === "thinking");
  })();
  check("forty pages read in one turn show at most twenty items", flood.length === MAX_THINKING_ITEMS, flood.length);

  section("the screen's model: ordered items, a headline, the same cap");
  let steps: RequestSteps = {};
  const feed = (e: Partial<ChatStatusEvent> & { stepId: string; kind: ChatStatusEvent["kind"]; label: string; state: ChatStatusEvent["state"]; startedAt: number }) => (steps = applyStatusEvent(steps, { requestId: "r", ...e } as ChatStatusEvent, e.startedAt));
  feed({ stepId: "think-1", kind: "model", label: "Thinking", state: "start", startedAt: 1_000 });
  feed({ stepId: "think-1", kind: "model", label: "Thinking", state: "end", startedAt: 1_000, ok: true });
  feed({ stepId: "i1", kind: "thinking", label: "x", state: "end", startedAt: 2_000, ok: true, item: { type: "thought", text: "I'm searching the web." } });
  feed({ stepId: "i2", kind: "thinking", label: "x", state: "end", startedAt: 3_000, ok: true, item: { type: "page", url: "https://a.com/p", title: "a.com" } });
  feed({ stepId: "i3", kind: "thinking", label: "x", state: "end", startedAt: 4_000, ok: true, item: { type: "page", url: "https://b.com/p", title: "b.com" } });
  feed({ stepId: "i4", kind: "thinking", label: "x", state: "end", startedAt: 5_000, ok: true, item: { type: "image", thumbnail: JPEG } });
  feed({ stepId: "i1", kind: "thinking", label: "x", state: "end", startedAt: 2_000, ok: true, item: { type: "thought", text: "repeat of the same step id" } });
  check("items keep their order and a repeated step id is not added twice", thinkingItems(steps.r).map((i) => i.type).join() === "thought,page,page,image", thinkingItems(steps.r));
  check("a thinking item is never 'running' and never a problem", steps.r.filter((s) => s.kind === "thinking").every((s) => s.endedAt !== undefined && s.ok === true));
  const working = thinkingSummary(steps.r, 9_000, true);
  check("while Clynx works the block says so", working.headline === "Clynx is thinking…" && working.items.length === 4);
  const done = thinkingSummary(steps.r, 99_000, false);
  check("when done it folds to one line: how long, how many pages and photos", done.headline === "Thought for 4s · looked at 2 pages, 1 photo" && done.pages === 2 && done.photos === 1, done.headline);
  check("singular and zero parts read naturally", thinkingSummary([{ id: "a", label: "", kind: "thinking", startedAt: 0, endedAt: 12_000, ok: true, item: { type: "page", url: "https://a.com", title: "a" } }], 0, false).headline === "Thought for 12s · looked at 1 page" && thinkingSummary([{ id: "a", label: "", kind: "thinking", startedAt: 0, endedAt: 3_000, ok: true, item: { type: "thought", text: "hm" } }], 0, false).headline === "Thought for 3s");
  let capped: RequestSteps = {};
  for (let i = 0; i < 50; i++) capped = applyStatusEvent(capped, { requestId: "r", stepId: `c${i}`, kind: "thinking", label: "", state: "end", startedAt: i, ok: true, item: { type: "thought", text: `t${i}` } }, i);
  check("the screen keeps at most 20 as well", thinkingItems(capped.r).length === MAX_THINKING_ITEMS);
  check("an event with no item adds nothing", Object.keys(applyStatusEvent({}, { requestId: "r", stepId: "z", kind: "thinking", label: "", state: "end", startedAt: 1 } as ChatStatusEvent, 1)).length === 1 && (applyStatusEvent({}, { requestId: "r", stepId: "z", kind: "thinking", label: "", state: "end", startedAt: 1 } as ChatStatusEvent, 1).r ?? []).length === 0);

  section("the block on the screen");
  const block = fs.readFileSync(path.join(process.cwd(), "src", "renderer", "src", "components", "ThinkingBlock.tsx"), "utf8");
  const disc = fs.readFileSync(path.join(process.cwd(), "src", "renderer", "src", "screens", "DiscoveryTab.tsx"), "utf8");
  check("it is a collapsible block: open while Clynx works, folded when done, and you can open it again", /<details[\s\S]*open=\{open\}/.test(block) && /const open = override \?\? working/.test(block) && /<summary[^>]*>\{summary\.headline\}<\/summary>/.test(block));
  check("a page opens in your browser (noreferrer), a photo enlarges on click and is capped at 160 px", /href=\{item\.url\}[\s\S]*?target="_blank"[\s\S]*?rel="noreferrer noopener"/.test(block) && /lightbox\.open\(item\.thumbnail/.test(block) && /maxWidth: 160, maxHeight: 160/.test(block));
  check("no third-party favicon is fetched (a letter stands in), and nothing animates", !/favicon|google\.com\/s2|animation|transition/.test(block.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")));
  check("Discovery shows it above each Clynx reply and leaves out the plain 'Web activity' list", /\{!isUser && <ThinkingBlock requestId=\{msg\.id\}/.test(disc) && /<ChatStatusLine requestId=\{msg\.id\} hideNotices/.test(disc) && disc.indexOf("<ThinkingBlock requestId") < disc.indexOf("{msg.content}"));

  section("TESTER's step 3 review: an answer is not buried, a jump does not re-stick, and the Stop is reachable from every view");
  const msgs = [{ id: "u1", role: "user" as const, ts: 1000, streaming: false }, { id: "a1", role: "assistant" as const, ts: 1001, streaming: true }];
  const ents = [{ id: "scan", source: "scanner", startedAt: 1500, status: "done", thoughts: [] }];
  check("a card that arrives while Clynx is answering lands ABOVE the answer, which stays last", buildView("everything", msgs, ents).map((i) => i.key).join() === "entry-scan,turn-u1", buildView("everything", msgs, ents).map((i) => i.key));
  check("once the reply is finished it takes its place in time", buildView("everything", [{ ...msgs[0] }, { ...msgs[1], streaming: false }], ents).map((i) => i.key).join() === "turn-u1,entry-scan");
  check("My chat is unchanged by this rule's presence", buildView("chat", msgs, ents).map((i) => i.key).join() === "turn-u1");
  check("the stop strip is shown in every view and the panel is a proper tabpanel", /Clynx is answering…/.test(disc) && /api\.cancelChat\(answering\.id\)/.test(disc) && /role="tabpanel"[\s\S]{0,80}aria-labelledby=\{`discovery-view-\$\{mode\}`\}/.test(disc) && !/role="log"/.test(disc));
  check("a jump lets go of 'stick to the latest' AFTER the view changed, and skips the view-change scroll", /skipModeScroll\.current = true/.test(disc) && /skipModeScroll\.current = false;/.test(disc) && disc.indexOf("setTimeout(() => {\n      stick.release();") > 0 || /setTimeout\(\(\) => \{\r?\n\s+stick\.release\(\);/.test(disc));
});
