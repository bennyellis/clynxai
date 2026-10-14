// Cloud mode: where AI and eBay come from. A signed-in customer using Clynx's shared service needs no keys; keys saved on this computer are kept but not used in that mode;
// the company's refusals turn into plain messages. All simulated: a fake cloud client and a stubbed fetch, nothing leaves this process and no key is real.
import { cloudRefusal, callOpenAI, hasOpenAIAccess, initOpenAIProxy, setApiSource, ensureOpenAIAccess, openAICreditsExhausted, PLAN_LIMIT_MESSAGE } from "../openai.js";
import { hasEbayCredentials, searchEbayItems, setEbayTransport } from "../ebayClient.js";
import { friendlyEbayFailure } from "../cloudClient.js";
import { check, run, section } from "./_testkit.js";

const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => {
  fetchCalls.push(String(url));
  return new Response(JSON.stringify({ choices: [{ message: { content: "from-openai" } }] }), { status: 200 });
}) as typeof fetch;

let cloudStatus = 200;
let cloudBody = JSON.stringify({ choices: [{ message: { content: "from-clynx" } }] });
let cloudCalls = 0;
const fakeCloud = {
  isAuthenticated: () => true,
  openAIRequest: async () => {
    cloudCalls++;
    return { ok: true as const, response: new Response(cloudBody, { status: cloudStatus }) };
  },
};

run(async () => {
  initOpenAIProxy(fakeCloud as never);

  section("a saved key is used in own mode and ignored in shared mode");
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  setApiSource(() => "own");
  await callOpenAI("chat", { model: "x" });
  check("own mode: the request goes straight to OpenAI with the saved key", fetchCalls.length === 1 && fetchCalls[0].includes("api.openai.com") && cloudCalls === 0, { fetchCalls, cloudCalls });
  setApiSource(() => "shared");
  const r = await callOpenAI("chat", { model: "x" });
  check("shared mode: the request goes through Clynx Cloud, not to OpenAI", cloudCalls === 1 && fetchCalls.length === 1);
  check("shared mode: the answer is the cloud's", (await r.json()).choices[0].message.content === "from-clynx");
  check("shared mode with the key still saved: nothing was deleted", process.env.OPENAI_API_KEY === "sk-test-not-real");

  section("a customer with no key at all still has AI access in shared mode");
  delete process.env.OPENAI_API_KEY;
  check("access exists through the signed-in account", hasOpenAIAccess());
  let threw = false;
  try {
    ensureOpenAIAccess();
  } catch {
    threw = true;
  }
  check("no key is demanded", !threw);

  section("the company's refusals become plain messages");
  check("daily limit", cloudRefusal(JSON.stringify({ error: "ai_daily_limit" }))?.message === PLAN_LIMIT_MESSAGE);
  check("per-customer budget", cloudRefusal('{"error":"user_budget_exhausted"}')?.code === "user_budget_exhausted");
  check("company-wide budget is described as temporary, not the customer's fault", /temporarily unavailable/.test(cloudRefusal('{"error":"api_budget_exhausted"}')?.message ?? ""));
  check("emergency stop reads the same way", /temporarily unavailable/.test(cloudRefusal('{"error":"paid_api_disabled"}')?.message ?? ""));
  check("an abuse block says access is paused", /paused/.test(cloudRefusal('{"error":"temporarily_blocked"}')?.message ?? ""));
  check("a momentary too-many-at-once is NOT a pause", cloudRefusal('{"error":"too_many_requests"}') === null);
  check("garbage is not a refusal", cloudRefusal("<html>") === null && cloudRefusal("") === null);

  cloudStatus = 503;
  cloudBody = JSON.stringify({ error: "paid_api_disabled" });
  let msg = "";
  try {
    await callOpenAI("chat", { model: "x" });
  } catch (e) {
    msg = (e as Error).message;
  }
  check("a 503 from the emergency switch surfaces the message and pauses further calls", /temporarily unavailable/.test(msg) && openAICreditsExhausted());
  let before = cloudCalls;
  try {
    await callOpenAI("chat", { model: "x" });
  } catch {
    /* expected */
  }
  check("while paused, no more requests are sent", cloudCalls === before);

  section("eBay goes through Clynx Cloud when the shared service is on");
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_SECRET;
  check("no eBay keys and no transport: not available", !hasEbayCredentials());
  const seen: { path: string; params: Record<string, string> }[] = [];
  let enabled = true;
  setEbayTransport({
    enabled: () => enabled,
    get: async <T,>(path: string, params: Record<string, string>) => {
      seen.push({ path, params });
      return { itemSummaries: [{ itemId: "v1|1|0", title: "Test item", price: { value: "10.00", currency: "USD" } }] } as T;
    },
  });
  check("the shared service makes eBay available without keys", hasEbayCredentials());
  const items = await searchEbayItems("xbox", { limit: 5 });
  check("the search used the transport, with the query intact", seen.length === 1 && seen[0].path === "/item_summary/search" && seen[0].params.q === "xbox", seen);
  check("results are mapped as usual", items.length === 1 && items[0].title === "Test item");
  enabled = false;
  check("transport off and no keys: not available again", !hasEbayCredentials());

  section("when the company's eBay service cannot answer, the person is told the cause and who fixes it");
  check("an older server without eBay: says the server is too old, not 'Route ... not found'", /too old.*Owner/.test(friendlyEbayFailure(404, { message: "Route GET:/ebay/search not found", error: "Not Found" }, "Route GET:/ebay/search not found")));
  check("keys not saved on the server yet: says the Owner adds them once, nothing needed on this computer", /not set up.*Owner.*nothing is needed on your computer/.test(friendlyEbayFailure(503, { error: "ebay_not_configured", message: "eBay features are not set up on this server yet." }, undefined)));
  check("a daily limit keeps the server's own words", friendlyEbayFailure(429, { error: "user_budget_exhausted", message: "You have used today's allowance." }, undefined) === "You have used today's allowance.");
  check("anything else falls back to the server's message or a plain sentence", friendlyEbayFailure(500, undefined, undefined) === "eBay could not be reached through Clynx.");

  globalThis.fetch = realFetch;
});
