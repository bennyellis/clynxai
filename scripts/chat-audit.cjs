// Measures Clynx's REAL chat behavior: the app's own prompts, tools and orchestration (streamChat) talking to the real model, over 23 realistic interactions.
// For each one it records the time to the first word and to the final answer, the number of AI calls and their total inference time, which tools were called
// (tool results are canned, so nothing is saved and no real research runs), whether the reply asks the user something, whether it completed what was asked, and
// whether it re-asked something that was already answered. It writes chat-audit-results.json next to the project and prints a table.
//
//   set OPENAI_API_KEY=sk-...        (PowerShell: $env:OPENAI_API_KEY="sk-...")
//   node scripts\chat-audit.cjs [scenario-number ...]
//
// Costs a few cents (23 short conversations, a few calls each). It touches no Database or setting of yours: it uses a throw-away database.
const { buildSync } = require("esbuild");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-chat-audit-"));
const out = path.join(tmp, "audit.cjs");
const entry = path.join(tmp, "audit-entry.ts");
fs.writeFileSync(
  entry,
  `
import fs from "node:fs";
import path from "node:path";
import { streamChat, allowedToolNames, type ChatMessage, type ToolCall } from ${JSON.stringify(path.join(root, "src/main/chat.ts"))};
import { Store } from ${JSON.stringify(path.join(root, "src/main/store.ts"))};
import { DEFAULT_CONFIG } from ${JSON.stringify(path.join(root, "src/main/config.ts"))};

type Ctx = "database" | "product" | "global" | "dashboard";
interface Scenario {
  id: number; name: string; ctx: Ctx; focus?: "variant" | "parent"; history?: ChatMessage[]; user: string;
  expectTool?: string[];            // at least one of these must be called
  expectNoTool?: boolean;           // answering without a tool is the right behavior
  allowQuestion?: boolean;          // a question back is legitimate here
  expectLimitation?: RegExp;        // the reply must say it cannot do it
}
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const U = (content: string): ChatMessage => ({ role: "user", content });

const PHOTO_HISTORY: ChatMessage[] = [
  U("find more reference photos similar to the thumbnail"),
  A("Got it. Do you mean: 1) official product photos, 2) marketplace photos of real units, or 3) both?"),
  U("both"),
  A("Good. Pick one: A) a wide grab of 8-12 images, or B) a focused set of 6 official and 6 real listing photos. Which option?"),
];

const scenarios: Scenario[] = [
  { id: 1, name: "straightforward: research a named product", ctx: "database", user: "research the Steam Deck OLED", expectTool: ["research_product"] },
  { id: 2, name: "answer without tools: how to check a used PS5", ctx: "database", user: "what's the best way to check a used PS5 before I buy it?", expectNoTool: true },
  { id: 3, name: "THE FAILURE: more reference photos for the open product", ctx: "database", focus: "variant", user: "find more reference photos similar to the thumbnail", expectTool: ["research_product"], expectLimitation: /(can'?t|cannot|don'?t have|not able|no tool)/i },
  { id: 4, name: "THE FAILURE: 'both' after an A/B question", ctx: "database", focus: "variant", history: PHOTO_HISTORY.slice(0, 2), user: "both", expectTool: ["research_product"], expectLimitation: /(can'?t|cannot|don'?t have|not able|no tool)/i },
  { id: 5, name: "THE FAILURE: third answer 'both', user frustrated", ctx: "database", focus: "variant", history: [...PHOTO_HISTORY, U("i just need more reference photos, both"), A("Good. Option A or B? If you paste the thumbnail I can match it.")], user: "both", expectTool: ["research_product"], expectLimitation: /(can'?t|cannot|don'?t have|not able|no tool)/i },
  { id: 6, name: "stop asking: explicit frustration", ctx: "database", focus: "variant", history: [...PHOTO_HISTORY, U("both"), A("Which option, A or B?")], user: "i already told you both multiple times, stop asking me questions and do it", expectTool: ["research_product"], expectLimitation: /(can'?t|cannot|don'?t have|not able|no tool)/i },
  { id: 7, name: "'do it' after an offer to refresh", ctx: "database", focus: "variant", history: [U("is the profile for this up to date?"), A("It was researched a while ago. Want me to refresh it with a new web search?")], user: "do it", expectTool: ["research_product"] },
  { id: 8, name: "'yes' after an offer to blacklist", ctx: "database", history: [U("i keep seeing house rentals in my feed"), A("Want me to blacklist the phrase 'for rent' so those get skipped?")], user: "yes", expectTool: ["add_blacklist_term"] },
  { id: 9, name: "'the first one' after a numbered choice", ctx: "database", history: [U("research the xbox"), A("Which one: 1) Xbox Series X, 2) Xbox Series S, 3) Xbox One X?")], user: "the first one", expectTool: ["research_product"] },
  { id: 10, name: "selected product: refresh this", ctx: "database", focus: "variant", user: "refresh this one", expectTool: ["research_product"] },
  { id: 11, name: "selected product: is it worth flipping?", ctx: "database", focus: "variant", user: "is this worth flipping?", expectNoTool: true },
  { id: 12, name: "selected product: what do you know about it", ctx: "database", focus: "variant", user: "what do you know about this one?", expectNoTool: true },
  { id: 13, name: "named variant of the open product", ctx: "database", focus: "parent", user: "look up the galaxy black one", expectTool: ["research_product"] },
  { id: 14, name: "edition named in full", ctx: "database", user: "xbox series x halo infinite edition", expectTool: ["research_product"] },
  { id: 15, name: "blacklist request", ctx: "database", user: "blacklist anything that says 'for rent'", expectTool: ["add_blacklist_term"] },
  { id: 16, name: "tool unavailable: start the scanner (database chat)", ctx: "database", user: "start the scanner", expectLimitation: /(can'?t|cannot|don'?t have|not able|activity|dashboard|bubble)/i },
  { id: 17, name: "tool unavailable: create a watch (database chat)", ctx: "database", user: "set a watch for ps5 under $300", expectLimitation: /(can'?t|cannot|don'?t have|not able|activity|dashboard|bubble)/i },
  { id: 18, name: "question answerable from knowledge", ctx: "database", user: "what's a fair used price for an iPhone 15 Pro?", expectNoTool: true, allowQuestion: true },
  { id: 19, name: "correction", ctx: "database", history: [U("research the iphone 15"), A("Started researching iPhone 15.")], user: "no, i meant the Pro model", expectTool: ["research_product"] },
  { id: 20, name: "repeated instruction", ctx: "database", history: [U("research the ps5 slim digital"), A("Do you want the disc or digital version?"), U("digital, just do it"), A("Which storage size, 1TB or 825GB?")], user: "just research it", expectTool: ["research_product"] },
  { id: 21, name: "multi-turn memory (no tool needed)", ctx: "database", history: [U("my target price for the series x is 400 dollars"), A("Noted, \\$400 for the Series X.")], user: "what price did i just tell you for the series x?", expectNoTool: true },
  { id: 22, name: "'research it' after naming a product earlier", ctx: "database", history: [U("i saw a dyson v15 detect for 300"), A("That's a solid price if it works. The V15 usually sells for more.")], user: "research it", expectTool: ["research_product"] },
  { id: 23, name: "sold prices for the open product", ctx: "database", focus: "variant", user: "check ebay sold prices for this", expectTool: ["research_product", "web_research"] },
];

const only = process.argv.slice(2).map(Number).filter(Boolean);
const ASKING = /(\\?\\s*$|\\?\\s|pick one|which (one|option)|do you want me to|would you like|should i|want me to|tell me (which|whether))/i;
const OPTION_MENU = /(\\b[A-D]\\)|\\b[1-4]\\)|option [AB]|pick (one|A|B))/i;

(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "clynx-audit-db-"));
  const store = new Store(path.join(dir, "scout.db"));
  const mk = (id: string, name: string, summary: string, extra?: (id: string) => void) => {
    store.addProductStub(id, name);
    store.updateProductProfile(id, { aiSummary: summary, category: "Video Games & Consoles", family: "Xbox", imageUrl: null });
    extra?.(id);
  };
  mk("parent", "Xbox Series X", "Microsoft's flagship console. 1TB disc drive. Common faults: HDMI port damage, disc drive failure. Variants: 2TB Galaxy Black Special Edition, Digital.");
  mk("variant", "Xbox Series X 2TB Galaxy Black Special Edition", "Variant status: verified by microsoft.com. A 2TB Series X in Galaxy Black, a limited special edition. Value not yet known.", (id) => {
    store.setProductParent(id, "parent");
  });
  for (let i = 0; i < 40; i++) mk("x" + i, ["PlayStation 5", "Nintendo Switch OLED", "iPhone 15 Pro", "Dyson V8", "Steam Deck"][i % 5] + " " + i, "A product summary. ".repeat(30));
  const products = store.listProducts();
  const results: any[] = [];

  const realFetch = globalThis.fetch;
  let calls: Array<{ start: number; end: number; firstByte: number }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    if (!String(url).includes("api.openai.com")) return realFetch(url, init);
    const rec = { start: Date.now(), end: 0, firstByte: 0 };
    calls.push(rec);
    const res = await realFetch(url, init);
    rec.firstByte = Date.now();
    const clone = res.clone();
    clone.text().then(() => (rec.end = Date.now()));
    return res;
  }) as typeof fetch;

  for (const sc of scenarios) {
    if (only.length && !only.includes(sc.id)) continue;
    calls = [];
    const toolCalls: Array<{ name: string; args: any; ms: number }> = [];
    const focus = sc.focus ? store.getProductById(sc.focus === "variant" ? "variant" : "parent") : null;
    const allowed = allowedToolNames(sc.ctx);
    let firstChunk = 0;
    const t0 = Date.now();
    let reply = "";
    let error = "";
    try {
      reply = await streamChat(sc.user, sc.history ?? [], sc.ctx, { ...DEFAULT_CONFIG } as any, [], [], products, () => { if (!firstChunk) firstChunk = Date.now(); }, async (call: ToolCall) => {
        const s = Date.now();
        let r = "Failed: not available";
        if (!allowed.has(call.name)) r = 'Failed: "' + call.name + "\\" isn't available from this chat.";
        else if (call.name === "research_product") r = 'Started researching "' + String(call.args.product) + '". It is saved when the research finishes, so do not say it is saved yet.';
        else if (call.name === "web_research") r = "Web results for \\"" + String(call.args.query) + "\\": (canned result for the audit) general information was found. Answer in your own words.";
        else if (call.name === "add_blacklist_term") r = 'Added "' + String(call.args.term) + '" to the blacklist.';
        else if (call.name === "remove_blacklist_term") r = "Removed.";
        toolCalls.push({ name: call.name, args: call.args, ms: Date.now() - s });
        return r;
      }, focus, [], [], []);
    } catch (e: any) { error = e.message; }
    const total = Date.now() - t0;
    const names = toolCalls.map((t) => t.name);
    const inference = calls.reduce((a, c) => a + Math.max(0, (c.end || Date.now()) - c.start), 0);
    const asks = ASKING.test(reply);
    const menu = OPTION_MENU.test(reply);
    const priorAskedMenu = (sc.history ?? []).some((m) => m.role === "assistant" && OPTION_MENU.test(m.content));
    const reasked = priorAskedMenu && (asks || menu);
    const toolOk = !sc.expectTool || sc.expectTool.some((t) => names.includes(t));
    const limitOk = !sc.expectLimitation || sc.expectLimitation.test(reply);
    const noToolOk = !sc.expectNoTool || names.length === 0 || (names.length === 1 && names[0] === "web_research");
    // done: the right tool ran, or (where the task cannot be done) it said so; and it did not hand the work back as a question
    const didIt = sc.expectTool ? (toolOk || (sc.expectLimitation ? limitOk : false)) : sc.expectLimitation ? limitOk : noToolOk;
    const completed = didIt && !error && (sc.allowQuestion || !(asks && !sc.expectNoTool) || toolOk);
    results.push({ id: sc.id, name: sc.name, ms_first: firstChunk ? firstChunk - t0 : null, ms_total: total, ms_inference: inference, ai_calls: calls.length, tools: names, tool_ms: toolCalls.reduce((a, t) => a + t.ms, 0), asks_question: asks, offers_menu: menu, reasked_answered_question: reasked, completed, error, reply: reply.slice(0, 600) });
    console.log("#" + String(sc.id).padStart(2) + " " + (completed ? "OK  " : "FAIL") + " first=" + (firstChunk ? firstChunk - t0 : "-") + "ms total=" + total + "ms calls=" + calls.length + " tools=[" + names.join(",") + "] asks=" + asks + " menu=" + menu + " reasked=" + reasked + "  " + sc.name);
  }
  const done = results.filter((r) => r.completed).length;
  console.log("\\n" + done + " of " + results.length + " completed. Average total " + Math.round(results.reduce((a, r) => a + r.ms_total, 0) / Math.max(1, results.length)) + "ms; questions asked in " + results.filter((r) => r.asks_question).length + "; menus offered in " + results.filter((r) => r.offers_menu).length + ".");
  fs.writeFileSync(path.join(${JSON.stringify(root)}, "chat-audit-results.json"), JSON.stringify(results, null, 2));
  console.log("Details written to chat-audit-results.json");
  store.close();
})();
`
);
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "error",
  external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"],
});
if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY first (PowerShell: $env:OPENAI_API_KEY=\"sk-...\"). The audit talks to the real model and costs a few cents.");
  process.exit(2);
}
const modules = path.join(root, "node_modules");
const r = require("node:child_process").spawnSync(process.execPath, ["--no-warnings", out, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
});
process.exit(r.status ?? 1);
