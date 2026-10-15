// The screenshot, end to end: the Discovery chat (context "database", Xbox Series X open on the right, an earlier exchange of clarifying questions in the
// history, then the user types "xbox series x galaxy"). The REAL chat loop (streamChat) talks to a scripted model over a stubbed OpenAI endpoint; the
// model's tool call goes through the REAL research_product handler, REAL decision logic, REAL evidence verifier (fake web) and a REAL Database (temp file).
// Nothing in the chain is mocked except the network and the model, so what is checked is what the app does: whether the full name survives the trip,
// whether the verifier runs, whether the parent entry is left alone, what gets persisted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowedToolNames, streamChat, type ChatMessage, type ToolCall } from "../chat.js";
import { runResearchProductTool, recoverNamedProduct, type ResearchStartOptions } from "../researchTool.js";
import { Store } from "../store.js";
import { createVerdictMemory, makeClaimVerifier } from "../variantResearch.js";
import { verifyVariant, type VerifyDeps } from "../variantEvidence.js";
import { baseConfig } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

// ---------- scripted model over a stubbed OpenAI endpoint
interface ModelTurn {
  content?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}
type Script = (lastUser: string, toolResult: string | null, request: any) => ModelTurn;
const requests: any[] = [];
let script: Script = () => ({ content: "ok" });

function sse(turn: ModelTurn): string {
  const lines: string[] = [];
  if (turn.content) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.content } }] })}`);
  if (turn.toolCall) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) } }] } }] })}`);
  }
  lines.push("data: [DONE]");
  return lines.join("\n\n") + "\n\n";
}

process.env.OPENAI_API_KEY = "test-key";
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  if (!String(url).includes("api.openai.com")) return new Response("", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}"));
  requests.push(body);
  const msgs: any[] = body.messages ?? [];
  const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
  const lastUser = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
  const last = msgs[msgs.length - 1];
  const toolResult = last?.role === "tool" ? String(last.content) : null;
  return new Response(sse(script(lastUser, toolResult, body)), { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

// ---------- fake web
const XBOX_PAGE = "Xbox Series X – 1TB Carbon Black. Xbox Series X – 2TB Galaxy Black Special Edition. Xbox Series X – 2TB Digital Edition White.";
function web(pages: Array<{ url: string; title: string; text: string }>): VerifyDeps & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(q) {
      queries.push(q);
      const site = /site:(\S+)/.exec(q)?.[1];
      const words = q.replace(/site:\S+/, "").replace(/"/g, "").toLowerCase().split(/\s+/).filter(Boolean);
      return pages
        .filter((p) => !site || new URL(p.url).hostname.endsWith(site))
        .filter((p) => words.every((w) => `${p.title} ${p.text} ${new URL(p.url).hostname.replace(/\./g, " ")}`.toLowerCase().includes(w)))
        .map((p) => ({ title: p.title, url: p.url, snippet: p.text.slice(0, 120) }));
    },
    async fetchText(url) {
      return pages.find((p) => p.url === url)?.text ?? null;
    },
  };
}

interface World {
  store: Store;
  parentId: string;
  started: Array<{ id: string; name: string; opts: ResearchStartOptions }>;
  notified: string[];
  progress: string[];
  verifierWeb: ReturnType<typeof web>;
  tool(call: ToolCall, ctx: "database" | "product" | "global" | "dashboard"): Promise<string>;
}

function makeWorld(pages: Array<{ url: string; title: string; text: string }>): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-chatflow-"));
  const store = new Store(path.join(dir, "scout.db"));
  const parentId = store.addProductStub("parent", "Xbox Series X");
  store.updateProductProfile(parentId, { aiSummary: "The standard Xbox Series X console profile.", category: "Video Games & Consoles", family: "Xbox", imageUrl: null });
  store.updateProductEbayComps(parentId, { avgSoldPriceUsd: 528, avgRunTimeDays: 0.8, avgShippingUsd: 0, sampleSize: 6, activeMedianUsd: 560, activeSampleSize: 11, estimatedValueUsd: 523, estimateBasis: "blend", identity: "exact" });
  const started: World["started"] = [];
  const notified: string[] = [];
  const progress: string[] = [];
  const verifierWeb = web(pages);
  const memory = createVerdictMemory();
  const verifyClaim = makeClaimVerifier({
    memory,
    persisted: (claim, parent) => store.getProductByName(claim)?.variantEvidence ?? store.getProductById(parent.id)?.variantClaims.find((c) => c.claim.toLowerCase() === claim.toLowerCase()) ?? null,
    check: (claim, _parent, userUrls) => verifyVariant(claim, verifierWeb, { brandHints: ["Xbox"], userUrls, maxSteps: 7 }),
  });
  const world: World = {
    store,
    parentId,
    started,
    notified,
    progress,
    verifierWeb,
    tool: async (call, ctx) => {
      if (!allowedToolNames(ctx).has(call.name)) return `Failed: "${call.name}" isn't available from this chat.`;
      return runResearchProductTool(call.args, call.userMessage, {
        store,
        verifyClaim,
        startLookup: (id, name, opts) => void started.push({ id, name, opts }),
        notify: (id) => void notified.push(id),
        newId: () => `id${started.length + notified.length + 1}`,
        progress: (m) => void progress.push(m),
      });
    },
  };
  return world;
}

/** One chat turn exactly as the Discovery tab sends it: context "database", the product open on the right in focus, earlier turns as history. */
async function chatTurn(world: World, message: string, history: ChatMessage[]): Promise<{ reply: string; toolResults: string[] }> {
  const toolResults: string[] = [];
  const reply = await streamChat(
    message,
    history,
    "database",
    baseConfig(),
    [],
    [],
    world.store.listProducts(),
    () => {},
    async (call) => {
      const r = await world.tool(call, "database");
      toolResults.push(r);
      return r;
    },
    world.store.getProductById(world.parentId),
    [],
    [],
    []
  );
  return { reply, toolResults };
}

// The history as in the screenshot: the model asked clarifying questions and the user answered them.
const SCREENSHOT_HISTORY: ChatMessage[] = [
  { role: "user", content: "general" },
  { role: "assistant", content: "Nice - I'm refreshing the Xbox Series X profile now. Want me to flag \"Xbox Series X Galaxy\" as a separate variant if I see official evidence, or keep it under the main Series X entry?" },
  { role: "user", content: "limited edition" },
  { role: "assistant", content: "Got it - you mean a limited-edition Xbox Series X. Do you want me to include retailer/manufacturer links you care about, or just general evidence from the web?" },
];

const relay = (toolResult: string | null): ModelTurn => ({ content: toolResult ? `Okay: ${toolResult.slice(0, 80)}` : "ok" });

run(async () => {
  section("the chat's own instructions no longer tell the model to strip a variant back to its parent (the cause of the screenshot)");
  {
    const w = makeWorld([]);
    script = () => ({ content: "hi" });
    requests.length = 0;
    await chatTurn(w, "hello", []);
    const system: string = requests[0].messages[0].content;
    check("the old rule is gone: 'Pass ONLY the general, canonical product name'", !/Pass ONLY the general, canonical product name/.test(system));
    check("it says to pass a named version's FULL name", /FULL name exactly as they said it/.test(system), system.slice(system.indexOf("research_product"), system.indexOf("research_product") + 300));
    check("it forbids shortening to the parent", /NEVER shorten a named version to its parent/.test(system));
    check("it forbids asking whether to keep it under the main entry", /NEVER ask whether to "keep it under the main entry"/.test(system));
    check("it forbids asking official-vs-custom before researching", /NEVER ask whether it is "official"/.test(system));
    check("the focus section tells it a named version is a separate product", /they mean that version, which is a separate product/.test(system));
    const tool = requests[0].tools.find((t: any) => t.function.name === "research_product");
    check("the tool definition agrees (full name for one specific version)", /FULL name|full name/.test(tool.function.parameters.properties.product.description));
    check("the tool accepts a link", !!tool.function.parameters.properties.url);
    const web = requests[0].tools.find((t: any) => t.function.name === "web_research");
    check("web_research accepts a link", !!web.function.parameters.properties.url);
  }

  section("the screenshot, exactly: a model that shortens to the parent ('Xbox Series X'), after the clarifying-question history");
  {
    const w = makeWorld([{ url: "https://www.xbox.com/en-us/consoles/xbox-series-x", title: "Xbox Series X | Xbox", text: XBOX_PAGE }]);
    script = (lastUser, toolResult) => (toolResult ? relay(toolResult) : { toolCall: { name: "research_product", args: { product: "Xbox Series X" } } });
    const before = w.store.getProductById(w.parentId)!;
    const { reply, toolResults } = await chatTurn(w, "xbox series x galaxy", SCREENSHOT_HISTORY);
    check("the user's full wording reached the tool (the shortened argument was corrected)", w.started.length === 1 && w.started[0].name === "xbox series x galaxy", w.started);
    check("the evidence verifier ran (it searched, beyond the exact title)", w.verifierWeb.queries.length >= 1, w.verifierWeb.queries);
    check("the tool result says VERIFIED, not 'refreshing the parent'", /^VERIFIED/.test(toolResults[0]) && !/Already have a Database profile/.test(toolResults[0]), toolResults[0]);
    const index = w.store.listProductIndex();
    check("a new, separate entry exists", index.length === 2, index);
    const variant = w.store.getProductById(w.started[0].id)!;
    check("it is the full name the user typed, not 'Xbox Series X'", variant.name === "xbox series x galaxy", variant.name);
    check("it is linked to the parent, not merged into it", variant.parentProductId === w.parentId);
    check("its evidence was saved with it", variant.variantEvidence?.status === "verified" || variant.variantEvidence?.status === "supported", variant.variantEvidence);
    check("research started for the VARIANT, not the parent", w.started[0].id !== w.parentId && w.started[0].opts.verdict?.status !== undefined);
    check("it was filed in the parent's family", w.started[0].opts.forcedFamily === "Xbox", w.started[0].opts);
    check("the parent was not put into 'researching' state", w.store.getProductById(w.parentId)?.loading === false);
    const after = w.store.getProductById(w.parentId)!;
    check("the parent's profile is untouched", after.aiSummary === before.aiSummary);
    check("the parent keeps its own $523 value (that is the standard model's, not the variant's)", after.ebayEstimatedValueUsd === 523 && after.ebayCompsSampleSize === 6);
    check("the variant starts with NO value (not the parent's $523)", variant.ebayEstimatedValueUsd === null && variant.ebayAvgSoldPriceUsd === null && variant.ebayCompsSampleSize === null);
    check("the tool result tells the model not to say it is saved yet", /not saved until that research finishes/i.test(toolResults[0]), toolResults[0]);
    check("the user sees a progress line while it verifies", w.progress.some((m) => /Checking manufacturer and retailer sources/.test(m)), w.progress);
    check("the reply the user gets is built from that result", /VERIFIED/.test(reply), reply);
  }

  section("the same turn with a model that passes the full name itself");
  {
    const w = makeWorld([{ url: "https://www.xbox.com/en-us/consoles/xbox-series-x", title: "Xbox Series X | Xbox", text: XBOX_PAGE }]);
    script = (_u, toolResult) => (toolResult ? relay(toolResult) : { toolCall: { name: "research_product", args: { product: "Xbox Series X 2TB Galaxy Black Special Edition" } } });
    const { toolResults } = await chatTurn(w, "research Xbox Series X 2TB Galaxy Black Special Edition", SCREENSHOT_HISTORY);
    check("verified and filed as its own entry", /^VERIFIED/.test(toolResults[0]) && w.store.listProductIndex().length === 2, toolResults[0]);
    check("under the parent", w.store.getProductById(w.started[0].id)?.parentProductId === w.parentId);
  }

  section("a variant nothing confirms: nothing is saved as a product, it is not called fake, and the next turn reuses the finding");
  {
    const w = makeWorld([]);
    script = (_u, toolResult) => (toolResult ? relay(toolResult) : { toolCall: { name: "research_product", args: { product: "Xbox Series X" } } });
    const { toolResults } = await chatTurn(w, "xbox series x galaxy", SCREENSHOT_HISTORY);
    check("NOT SAVED", /^NOT SAVED/.test(toolResults[0]), toolResults[0]);
    check("unverified, and the model is told it is not fake", /unverified/i.test(toolResults[0]) && /NOT "fake"/.test(toolResults[0]), toolResults[0]);
    check("no product was created", w.store.listProductIndex().length === 1 && w.started.length === 0, w.store.listProductIndex());
    const parent = w.store.getProductById(w.parentId)!;
    check("the claim is kept on the parent", parent.variantClaims.length === 1 && parent.variantClaims[0].claim === "xbox series x galaxy" && parent.variantClaims[0].status === "unverified", parent.variantClaims);
    check("the parent's profile and value are untouched", parent.aiSummary === "The standard Xbox Series X console profile." && parent.ebayEstimatedValueUsd === 523);
    const searches = w.verifierWeb.queries.length;
    check("it really searched beyond the exact title", searches > 1, w.verifierWeb.queries);
    const second = await chatTurn(w, "xbox series x galaxy", [...SCREENSHOT_HISTORY, { role: "user", content: "xbox series x galaxy" }, { role: "assistant", content: "NOT SAVED..." }]);
    check("asked again: the earlier finding is reused, no repeat search", w.verifierWeb.queries.length === searches && /^NOT SAVED/.test(second.toolResults[0]), w.verifierWeb.queries.length);
    check("still nothing created", w.store.listProductIndex().length === 1);
    // The user then gives the manufacturer's link: that is new evidence and is read.
    w.verifierWeb.queries.length = 0;
    script = (_u, toolResult) => (toolResult ? relay(toolResult) : { toolCall: { name: "research_product", args: { product: "Xbox Series X Galaxy", url: "https://www.xbox.com/en-us/consoles/xbox-series-x" } } });
    const withLink = await chatTurn(w, "here is the page https://www.xbox.com/en-us/consoles/xbox-series-x", SCREENSHOT_HISTORY);
    check("with no readable page the claim stays unverified (never invented)", /^NOT SAVED/.test(withLink.toolResults[0]));
  }

  section("a question about the open product is still a refresh of that product, never a variant");
  {
    const w = makeWorld([]);
    script = (_u, toolResult) => (toolResult ? relay(toolResult) : { toolCall: { name: "research_product", args: { product: "Xbox Series X" } } });
    const { toolResults } = await chatTurn(w, "is the xbox series x worth flipping?", []);
    check("refresh, no evidence check, no new entry", /Already have a Database profile for "Xbox Series X"/.test(toolResults[0]) && w.store.listProductIndex().length === 1 && w.verifierWeb.queries.length === 0, toolResults[0]);
    check("the refresh is of the parent", w.started.length === 1 && w.started[0].id === w.parentId);
  }

  section("what the user typed is only used when it is a bare product name that says more than the model passed");
  {
    check("a bare name", recoverNamedProduct("Xbox Series X", "xbox series x galaxy") === "xbox series x galaxy");
    check("after 'research'", recoverNamedProduct("Xbox Series X", "research Xbox Series X 2TB Galaxy Black Special Edition") === "Xbox Series X 2TB Galaxy Black Special Edition");
    check("after 'look into', with please", recoverNamedProduct("Xbox Series X", "look into xbox series x galaxy please") === "xbox series x galaxy");
    check("a question is not a name", recoverNamedProduct("Xbox Series X", "is the xbox series x galaxy real?") === null);
    check("a sentence is not a name", recoverNamedProduct("Xbox Series X", "what do you think about xbox series x galaxy") === null);
    check("a message saying the same thing as the model passed changes nothing", recoverNamedProduct("Xbox Series X", "xbox series x") === null);
    check("an unrelated message changes nothing", recoverNamedProduct("Xbox Series X", "limited edition") === null);
    check("an attachment's text does not leak into the name", recoverNamedProduct("Xbox Series X", "xbox series x galaxy\nAttached file \"notes.txt\":\nbuy low sell high") === "xbox series x galaxy");
    check("nothing typed, nothing recovered", recoverNamedProduct("Xbox Series X", undefined) === null);
  }

  section("the tool is only reachable from the chats that have it");
  {
    const w = makeWorld([]);
    check("not from a chat without it", /isn't available/.test(await w.tool({ name: "research_product", args: { product: "X" } }, "dashboard")));
  }
});
