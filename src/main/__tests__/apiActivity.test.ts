// Beta 12: AI Activity. Every request to OpenAI / eBay / WatchCount is recorded with what kind of "yes", "no" or "not made" it was; decisions are kept with a tiny picture and the AI's reasoning;
// failures are shown with their reason and never a key. NETWORK IS FAKED (fetch is stubbed): this proves the client code, the accounting and the pipeline hand-off, NOT that the live services work
// (that is scripts\api-diagnose.cjs / the Run API check button, run with real keys).
import sharp from "sharp";
import { ApiActivity, apiActivity, estimateCostUsd, purposeFromStack, scrub } from "../apiActivity.js";
import { noteDecision, makeThumb } from "../aiDecisionLog.js";
import { callOpenAI, ensureOpenAIAccess } from "../openai.js";
import { hasEbayCredentials, searchEbayItems } from "../ebayClient.js";
import { fetchActiveAsks } from "../ebayActive.js";
import { registerLowAiModeSource } from "../aiMode.js";
import { runApiSelfTest, testEbay, testOpenAI, testWatchCount, type SelfTestDeps } from "../apiSelfTest.js";
import { qualifyListing } from "../dealGate.js";
import { scoreListing } from "../scorer.js";
import { findReferencePhotos } from "../webResearch.js";
import { failureHint, formatCost, outcomeLabel, summarizeProvider, verdictTone } from "../../renderer/src/lib/aiActivityView.js";
import { baseConfig, detail } from "./_fixtures.js";
import { check, run, section } from "./_testkit.js";

const KEY = "sk-test-1234567890abcdefghij";
process.env.OPENAI_API_KEY = KEY;
process.env.EBAY_CLIENT_ID = "ebay-client-id-test";
process.env.EBAY_CLIENT_SECRET = "ebay-client-secret-test";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let handler: (url: string, init?: any) => Response | Promise<Response> = () => json({});
globalThis.fetch = (async (url: unknown, init?: any) => handler(String(url), init)) as typeof fetch;
const last = (provider: "openai" | "ebay" | "watchcount") => apiActivity.snapshot().recent.find((e) => e.provider === provider)!;
const stats = (p: "openai" | "ebay" | "watchcount") => apiActivity.snapshot().providers[p];
const chatBody = { model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 32 };
const tick = () => new Promise((r) => setTimeout(r, 20));

run(async () => {
  section("the registry: counters, bounds and scrubbing");
  {
    const a = new ApiActivity();
    for (let i = 0; i < 150; i++) a.record({ provider: "openai", kind: "chat", outcome: i % 2 ? "live_ok" : "live_failed", route: "own_key", model: "gpt-5-mini", tokens: i % 2 ? { input: 10, output: 5, total: 15 } : null, error: i % 2 ? null : "boom" });
    const s = a.snapshot();
    check("only the last 100 events and 30 failures are kept (bounded)", s.recent.length === 100 && s.recentFailures.length === 30, [s.recent.length, s.recentFailures.length]);
    check("counters keep counting past the bounds", s.providers.openai.attempted === 150 && s.providers.openai.ok === 75 && s.providers.openai.failed === 75);
    check("tokens and estimated cost add up (75 x 15 tokens; $0.25/M in, $2/M out)", s.providers.openai.tokens.total === 1125 && Math.abs(s.providers.openai.costUsdEst - (75 * 10 * 0.25 + 75 * 5 * 2) / 1e6) < 1e-9, s.providers.openai);
    check("newest first", s.recent[0].ts >= s.recent[99].ts);
    for (let i = 0; i < 60; i++) a.decision({ kind: "photo_analysis", subject: `s${i}`, verdict: "identified", thought: "x" });
    check("only the last 40 decisions are kept", a.snapshot().decisions.length === 40 && a.snapshot().decisions[0].subject === "s59");
    a.decision({ kind: "k", subject: "big", verdict: "v", thought: "t", image: "data:image/jpeg;base64," + "A".repeat(30_000) });
    check("an oversized picture is dropped, not stored", a.snapshot().decisions[0].image === null);
    a.decision({ kind: "k", subject: "ok", verdict: "v", thought: "t".repeat(900), image: "data:image/jpeg;base64,AAAA" });
    check("a small picture is kept; long thoughts are cut to 400 characters", !!a.snapshot().decisions[0].image && a.snapshot().decisions[0].thought.length <= 401);
    a.record({ provider: "ebay", kind: "oauth_token", outcome: "cached", route: "ebay_direct" }, { quiet: true });
    check("a quiet record counts but adds no event", a.snapshot().providers.ebay.cached === 1 && a.snapshot().recent.every((e) => e.provider !== "ebay"));
    check("the cost estimate is unknown for an unknown model", estimateCostUsd("some-new-model", { input: 1, output: 1, total: 2 }) === null);
    const scrubbed = scrub(`HTTP 401: Incorrect API key provided: ${KEY}. Authorization: Bearer abcdef1234567890 {"access_token":"v^1.1#i^1#r^0#abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}`);
    check("keys, bearer tokens and access tokens never survive scrubbing", !scrubbed.includes(KEY) && !/abcdef1234567890/.test(scrubbed) && !/v\^1\.1/.test(scrubbed) && /\[key\]|\[redacted\]/.test(scrubbed), scrubbed);
    check("the caller's file names the purpose", purposeFromStack("Error\n    at callOpenAI (C:\\app\\src\\main\\openai.ts:1:1)\n    at judge (C:\\app\\src\\main\\scorer.ts:9:9)") === "listing judgement (text)");
  }

  section("OpenAI: a successful request records model, status, latency and the tokens the answer reported");
  {
    apiActivity.reset();
    handler = (url, init) => {
      check("the request goes to OpenAI with the key in the Authorization header (and only there)", url.startsWith("https://api.openai.com/") && init.headers.Authorization === `Bearer ${KEY}` && !String(init.body).includes(KEY));
      return json({ model: "gpt-5-mini-2025", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
    };
    const res = await callOpenAI("chat", chatBody);
    check("the caller still gets a normal, unread Response", res.ok && (await res.json()).choices[0].message.content === "ok");
    await tick();
    const e = last("openai");
    check("recorded as a live success through the user's own key with the model and status", e.outcome === "live_ok" && e.route === "own_key" && e.model === "gpt-5-mini" && e.status === 200 && typeof e.ms === "number", e);
    check("token counts come from the answer's own usage block", e.tokens?.input === 12 && e.tokens?.output === 3 && e.tokens?.total === 15 && !e.tokensNotReported, e.tokens);
    check("the session totals and the cost estimate are updated", stats("openai").tokens.total === 15 && stats("openai").costUsdEst > 0 && stats("openai").lastSuccessAt !== null);
  }

  section("OpenAI: answers that cannot be counted are said so, not invented");
  {
    handler = () => json({ choices: [{ message: { content: "ok" } }] }); // no usage block
    await (await callOpenAI("chat", chatBody)).text();
    await tick();
    check("no usage block: success recorded, tokens flagged 'not reported' (never a made-up number)", last("openai").outcome === "live_ok" && last("openai").tokens === null && last("openai").tokensNotReported === true);
    handler = () => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"o\"}}]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    await callOpenAI("chat", { ...chatBody, stream: true });
    check("a streamed answer is recorded as a live success with tokens 'not reported'", last("openai").outcome === "live_ok" && last("openai").tokensNotReported === true);
    handler = () => new Response("<html>not json</html>", { status: 200 });
    await callOpenAI("chat", chatBody);
    await tick();
    check("a malformed answer body is still recorded (live ok, no tokens) and does not throw", last("openai").outcome === "live_ok" && last("openai").tokensNotReported === true);
    check("the session says how many requests reported no tokens", stats("openai").tokens.requestsWithoutTokens === 3 && stats("openai").costUsdEstComplete === false);
  }

  section("OpenAI: failures are surfaced with their reason (and never the key)");
  {
    handler = () => json({ error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` } }, 401);
    const r401 = await callOpenAI("chat", chatBody);
    const f = last("openai");
    check("a rejected key is a live failure with status 401 and the provider's reason", r401.status === 401 && f.outcome === "live_failed" && f.status === 401 && /invalid_api_key/.test(f.error ?? ""), f);
    check("the key itself is not in the recorded error", !(f.error ?? "").includes(KEY) && !JSON.stringify(apiActivity.snapshot()).includes(KEY));
    check("it appears in recent failures with a plain-English hint", apiActivity.snapshot().recentFailures[0].status === 401 && /rejected the key/i.test(failureHint({ provider: "openai", status: 401, error: f.error }) ?? ""));
    handler = () => json({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }, 429);
    const r429 = await callOpenAI("chat", chatBody);
    check("a rate limit is recorded as a failure with status 429 (not swallowed)", r429.status === 429 && last("openai").status === 429 && /rate limit/i.test(failureHint({ provider: "openai", status: 429, error: "x" }) ?? ""));
    handler = () => json({ error: { message: "server error" } }, 503);
    await callOpenAI("chat", chatBody);
    check("a 5xx is a failure with an 'on their side' hint", last("openai").status === 503 && /their side|problem on its side/i.test(failureHint({ provider: "openai", status: 503, error: "x" }) ?? ""));
    handler = () => new Promise((_res, rej) => { const e: any = new Error("aborted"); e.name = "AbortError"; rej(e); });
    let thrown = false;
    try { await callOpenAI("chat", chatBody); } catch { thrown = true; }
    check("a timeout is thrown to the caller (unchanged) and recorded as a failed request with a timeout reason", thrown && last("openai").outcome === "live_failed" && /timed out/.test(last("openai").error ?? ""));
    handler = () => { throw new Error("getaddrinfo ENOTFOUND api.openai.com"); };
    try { await callOpenAI("chat", chatBody); } catch { /* expected */ }
    check("a network failure is recorded as a failed request with its reason", last("openai").outcome === "live_failed" && /ENOTFOUND/.test(last("openai").error ?? ""));
  }

  section("eBay: token, search, results, failures, caching (real client code, faked network)");
  {
    apiActivity.reset();
    check("credentials are detected without exposing them", hasEbayCredentials() === true);
    let tokenCalls = 0, searchCalls = 0;
    const item = (id: string, title: string, price: string, cat = "Video Game Consoles") => ({ itemId: id, title, price: { value: price, currency: "USD" }, itemWebUrl: `https://ebay.test/${id}`, condition: "Used", categories: [{ categoryId: "1", categoryName: cat }], shippingOptions: [{ shippingCost: { value: "0", currency: "USD" } }] });
    handler = (url, init) => {
      if (url.includes("/identity/v1/oauth2/token")) {
        tokenCalls++;
        check("the token request uses Basic auth with the keys and the plain public scope", /^Basic /.test(init.headers.Authorization) && String(init.body).includes("grant_type=client_credentials"));
        return json({ access_token: "tok-" + "x".repeat(40), expires_in: 7200 });
      }
      searchCalls++;
      check("the search is a Browse item_summary request for the US marketplace with a bearer token", url.includes("/buy/browse/v1/item_summary/search") && url.includes("q=Xbox+Series+X") && init.headers["X-EBAY-C-MARKETPLACE-ID"] === "EBAY_US" && /^Bearer tok-/.test(init.headers.Authorization));
      return json({ itemSummaries: [item("1", "Microsoft Xbox Series X 1TB Console Black", "450"), item("2", "Xbox Series X 2TB Galaxy Black Special Edition Console", "700"), item("3", "Call of Duty Black Ops 6 Xbox Series X", "40", "Video Games"), item("4", "Xbox Series X Wireless Controller Carbon", "45", "Controllers"), item("5", "Xbox Series S 512GB Console White", "250"), item("6", "Xbox Series X for parts not working", "120")] });
    };
    const items = await searchEbayItems("Xbox Series X", { limit: 20 });
    check("the response was parsed into items", items.length === 6 && items[0].priceValue === "450");
    await searchEbayItems("Xbox Series X", { limit: 20 });
    check("one token was minted and reused (cached), two searches made", tokenCalls === 1 && searchCalls === 2);
    const sEbay = stats("ebay");
    check("recorded: 1 token + 2 searches live, with results counted and the token reuse as 'cached'", sEbay.byKind.oauth_token.ok === 1 && sEbay.byKind.browse_search.ok === 2 && sEbay.cached === 1 && last("ebay").results === 6, sEbay.byKind);
    check("the route is eBay directly with this computer's keys", last("ebay").route === "ebay_direct");
    handler = (url) => (url.includes("oauth2/token") ? json({ access_token: "tok2-" + "y".repeat(40), expires_in: 7200 }) : json({}, 200));
    const empty = await searchEbayItems("nothing like this", { limit: 5 });
    check("an empty result is a success with 0 results (shown as such)", empty.length === 0 && last("ebay").outcome === "live_ok" && last("ebay").results === 0);
    handler = (url) => (url.includes("oauth2/token") ? json({ access_token: "tok3-" + "z".repeat(40), expires_in: 7200 }) : json({ errors: [{ message: "Invalid access token" }] }, 401));
    let err401 = "";
    try { await searchEbayItems("Xbox Series X"); } catch (e) { err401 = (e as Error).message; }
    check("a 401 is thrown to the caller and recorded with its status and an eBay-keys hint", /401/.test(err401) && last("ebay").status === 401 && /rejected the keys/i.test(failureHint({ provider: "ebay", status: 401, error: last("ebay").error }) ?? ""));
    let mints = 0;
    handler = (url) => { if (url.includes("oauth2/token")) { mints++; return json({ access_token: "tok4-" + "w".repeat(40), expires_in: 7200 }); } return json({ itemSummaries: [] }); };
    await searchEbayItems("Xbox Series X");
    check("after a 401 the cached token is dropped, so the next call mints a fresh one", mints === 1);
    handler = (url) => (url.includes("oauth2/token") ? json({ access_token: "tok5-" + "v".repeat(40), expires_in: 7200 }) : json({ errors: [{ message: "Too many requests" }] }, 429));
    try { await searchEbayItems("Xbox Series X"); } catch { /* expected */ }
    check("a 429 rate limit is recorded as a failure with its status", last("ebay").status === 429 && last("ebay").outcome === "live_failed");
    // a 401 on a search drops the cached token; the NEXT call must mint one, and here the token endpoint refuses
    handler = (url) => (url.includes("oauth2/token") ? json({ error: "invalid_client" }, 401) : json({ errors: [] }, 401));
    try { await searchEbayItems("Xbox Series X"); } catch { /* expected: search 401 */ }
    try { await searchEbayItems("Xbox Series X"); } catch { /* expected: token refused */ }
    check("a failing token request is recorded as an authentication failure", stats("ebay").byKind.oauth_token.failed >= 1 && apiActivity.snapshot().recentFailures.some((f) => f.kind === "oauth_token" && f.status === 401));
    check("no eBay token or secret appears anywhere in the snapshot", !JSON.stringify(apiActivity.snapshot()).match(/tok\d?-[xyzwv]{40}|ebay-client-secret-test/));
  }

  section("the pipeline hand-off: eBay results -> identity -> asking-price value -> profit -> classification (asking prices are NOT sold prices)");
  {
    apiActivity.reset();
    registerLowAiModeSource(() => true); // plain-text comparable checks: no AI in this chain
    const item = (id: string, title: string, price: string, cat = "Video Game Consoles", cond = "Used") => ({ itemId: id, title, price: { value: price, currency: "USD" }, itemWebUrl: `https://ebay.test/${id}`, condition: cond, categories: [{ categoryId: "1", categoryName: cat }], shippingOptions: [{ shippingCost: { value: "0", currency: "USD" } }] });
    handler = (url) => (url.includes("oauth2/token") ? json({ access_token: "tok6-" + "u".repeat(40), expires_in: 7200 }) : json({ itemSummaries: [
      item("1", "Microsoft Xbox Series X 1TB Console Black", "440"), item("2", "Xbox Series X 1TB Console", "460"), item("3", "Xbox Series X Console 1TB Disc Drive", "450"), item("4", "Xbox Series X 1TB Black Console Used", "470"),
      item("5", "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)", "40", "Video Games"), item("6", "Xbox Series X Wireless Controller Carbon Black", "45", "Controllers"),
      item("7", "Xbox Series S 512GB Console White", "250"), item("8", "Xbox Series X for parts not working", "120", "Video Game Consoles", "For parts or not working"), item("9", "Xbox Series X 2TB Galaxy Black Special Edition", "700"),
    ] }));
    const asks = await fetchActiveAsks("Xbox Series X", "Xbox Series X", null, null, false, "Xbox > Consoles", [], null);
    const v = asks.validation!;
    check("for a console product, listings filed under Games / Controllers are dropped by category first; of the 7 left, Series S, the parts one and the 2TB Galaxy edition are rejected by identity", v.retrieved === 7 && v.rejected === 3 && v.compatible + v.exact === 4, v);
    const wide = await fetchActiveAsks("Xbox Series X", "Xbox Series X", null, null, false, null, [], null);
    check("with no category hint the identity check itself rejects the game (MEDIA) and the controller (ACCESSORY): 9 retrieved, 5 rejected", wide.validation!.retrieved === 9 && wide.validation!.rejected === 5 && (wide.validation!.reasons.MEDIA ?? 0) + (wide.validation!.reasons.ACCESSORY ?? 0) >= 2, wide.validation);
    check("the value comes only from listings verified as the product: median of the console asks (~$455)", asks.medianUsd !== null && asks.medianUsd >= 440 && asks.medianUsd <= 470 && asks.sampleSize >= 4, { med: asks.medianUsd, n: asks.sampleSize });
    check("none of the rejected listings' prices leaked in (a $40 game would drag the median to ~$250)", asks.medianUsd! > 400);
    const thresholds = { netPercent: 84, minMarginPercent: 20, maxCutPercent: 15 };
    const ev = { valueUsd: asks.medianUsd, basis: "active" as const, sampleSize: asks.sampleSize, ageDays: 0 };
    const base = { pathway: "general" as const, conditionImpact: "none" as const, evidence: ev, age: { state: "fresh" as const, hours: 2, text: "2 hours ago" }, settings: thresholds };
    const modest = qualifyListing({ ...base, priceUsd: 300 });
    check("$300 against ~$455 of ASKING prices: good margin but asking-only evidence is weak, so it is Worth a look, not a verified deal", modest.status === "worth_a_look" && modest.reasons.some((r) => r.code === "WEAK_EVIDENCE"), modest.status);
    const big = qualifyListing({ ...base, priceUsd: 200 });
    check("$200 (a big gap) still qualifies, at low confidence, exactly as the existing thresholds say", big.qualified && big.confidence === "low", big);
    const none = qualifyListing({ ...base, priceUsd: 400 });
    check("$400 is not a deal (thresholds unchanged: it would need a bigger cut than allowed)", !none.qualified, none.status);
    check("no OpenAI request was needed or made in this chain", stats("openai").attempted === 0);
    handler = (url) => (url.includes("oauth2/token") ? json({ access_token: "tok7-" + "t".repeat(40), expires_in: 7200 }) : json({ errors: [] }, 500));
    const failedAsks = await fetchActiveAsks("Xbox Series X", "Xbox Series X", null, null, false, null, [], null);
    check("failed research: an eBay error gives no asking data (never a made-up value) and the failure is on record with its status", failedAsks.medianUsd === null && failedAsks.sampleSize === 0 && last("ebay").status === 500 && last("ebay").outcome === "live_failed");
    registerLowAiModeSource(() => true);
  }

  section("a listing judged by the AI: the request, its tokens and the decision with its reasoning are all recorded");
  {
    apiActivity.reset();
    handler = (url) => json({ choices: [{ message: { content: JSON.stringify({ isPotentialDeal: true, category: "game console", estimatedValueRangeUsd: "400-500", confidence: "high", conditionImpact: "none", reasoning: "A used Series X at $250 is far under the usual $400-500.", offTopicSuggestion: null }) } }], usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } });
    const config = baseConfig({ generalDeal: { enabled: true, minConfidence: "medium" } });
    const scored = await scoreListing(detail("Xbox Series X console", 250, { description: "works" }), config, [], [], () => null, () => null);
    await tick();
    check("the text judgement reached the listing (it is flagged as a deal)", scored.isDeal === true && scored.dealTier === "general");
    const d = apiActivity.snapshot().decisions[0];
    check("the decision is recorded with what it judged, its verdict and its own reasoning", d.kind === "listing_judgement" && /Xbox Series X console/.test(d.subject) && /possible deal/.test(d.verdict) && /usual \$400-500/.test(d.thought), d);
    check("the request is recorded for 'listing judgement (text)' with 960 tokens", last("openai").kind === "listing judgement (text)" && last("openai").tokens?.total === 960);
  }

  section("decisions with images");
  {
    apiActivity.reset();
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
    const big = `data:image/jpeg;base64,${png.toString("base64")}`;
    const thumb = await makeThumb(big);
    check("an 800x600 photo becomes a small thumbnail (<= 120 px, a few KB)", !!thumb && thumb.length < 8000 && thumb.startsWith("data:image/jpeg"), thumb?.length);
    noteDecision({ kind: "photo_analysis", subject: "Xbox on a table", verdict: "identified", thought: "A black console with a controller.", imageDataUri: big });
    await tick(); await tick();
    const d = apiActivity.snapshot().decisions[0];
    check("the decision carries the thumbnail, not the original", !!d.image && d.image.length < 8000 && d.thought.includes("black console"));
    check("a non-image gives a decision with no picture, and never throws", await (async () => { noteDecision({ kind: "k", subject: "s", verdict: "v", thought: "t", imageDataUri: "not an image" }); await tick(); return apiActivity.snapshot().decisions[0].image === null; })());
    // the identity gate's deterministic rejection is visible too
    const imgs: Record<string, Buffer> = { "https://img.test/9.jpg": png };
    handler = (url) => (imgs[url] ? new Response(new Uint8Array(imgs[url]), { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response("", { status: 404 }));
    registerLowAiModeSource(() => false);
    const r = await findReferencePhotos("Xbox Series X Galaxy Black Edition", { want: 2, candidates: [{ url: "https://img.test/9.jpg", label: "eBay listing photo — Guardians", text: "Marvel's Guardians of the Galaxy Cosmic Deluxe Edition (Xbox Series X)" }] });
    const rej = apiActivity.snapshot().decisions.find((x) => x.kind === "reference_photo_check");
    check("the Guardians of the Galaxy rejection shows in AI Activity as 'rejected from its title (no AI used)' with the reason", r.photos.length === 0 && !!rej && /no AI used/.test(rej.verdict) && /game|software/i.test(rej.thought), rej);
    registerLowAiModeSource(() => true);
  }

  section("the API check (button and command): bounded, real code paths, visible failures");
  {
    const ok: SelfTestDeps = {
      callOpenAI: async () => json({ model: "gpt-5-mini", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 14, completion_tokens: 2, total_tokens: 16 } }),
      model: "gpt-5-mini", hasOpenAIAccess: () => true, openAIRoute: () => "own_key", hasEbayCredentials: () => true,
      searchEbayItems: async () => [
        { title: "Xbox Series X 1TB Console", priceValue: "450", priceCurrency: "USD", shippingCostUsd: 0 }, { title: "Xbox Series X 1TB Black", priceValue: "470", priceCurrency: "USD", shippingCostUsd: 10 },
        { title: "Halo Infinite (Xbox Series X)", priceValue: "20", priceCurrency: "USD", shippingCostUsd: 0 }, { title: "Xbox Series S 512GB", priceValue: "250", priceCurrency: "USD", shippingCostUsd: 0 },
      ],
      fetch: (async () => new Response("<html></html>", { status: 200 })) as typeof fetch,
    };
    const r = await runApiSelfTest(ok);
    check("all three pass when the services answer", r.openai.ok && r.ebay.ok && r.watchcount.ok);
    check("the OpenAI part reports the model, route and token counts it was given", r.openai.tokens?.total === 16 && r.openai.route === "own_key" && r.openai.reply === "ok");
    check("the eBay part counts 4 retrieved, 2 accepted, 2 rejected and labels the median as ASKING", r.ebay.retrieved === 4 && r.ebay.accepted === 2 && r.ebay.rejected === 2 && r.ebay.medianAskUsd === 465, r.ebay);
    const bad = await runApiSelfTest({ ...ok, callOpenAI: async () => json({ error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` } }, 401), searchEbayItems: async () => { throw new Error("eBay API error 429: rate limited"); }, fetch: (async () => { throw new Error("fetch failed"); }) as typeof fetch });
    check("every failure is returned with its reason, not turned into a pass", !bad.openai.ok && bad.openai.status === 401 && /invalid_api_key/.test(bad.openai.error ?? "") && !bad.ebay.ok && /429/.test(bad.ebay.error ?? "") && !bad.watchcount.ok && /fetch failed/.test(bad.watchcount.error ?? ""), bad);
    check("the key is scrubbed from the check's own error text", !JSON.stringify(bad).includes(KEY));
    const none = await runApiSelfTest({ ...ok, hasOpenAIAccess: () => false, hasEbayCredentials: () => false });
    check("no keys: OpenAI fails with 'not run', eBay is NOT CHECKED (skipped with a reason), neither passes", !none.openai.ok && !!none.openai.skipped && !none.ebay.ok && !!none.ebay.skipped);
    const timeout = await testOpenAI({ ...ok, callOpenAI: async () => { const e: any = new Error("aborted"); e.name = "AbortError"; throw e; } });
    check("a timeout is reported as a timeout", !timeout.ok && /timed out/.test(timeout.error ?? ""));
    const empty = await testOpenAI({ ...ok, callOpenAI: async () => json({ choices: [] }) });
    check("an answer with no message fails", !empty.ok);
    const garbage = await testOpenAI({ ...ok, callOpenAI: async () => new Response("<html>", { status: 200 }) });
    check("a malformed answer fails with a reason", !garbage.ok && /not valid JSON/.test(garbage.error ?? ""));
    const emptyEbay = await testEbay({ ...ok, searchEbayItems: async () => [] });
    check("an empty eBay result is a pass with 0 results, visibly", emptyEbay.ok && emptyEbay.retrieved === 0 && emptyEbay.medianAskUsd === null);
    const wc503 = await testWatchCount({ ...ok, fetch: (async () => new Response("", { status: 503 })) as typeof fetch });
    check("a WatchCount 503 is a failure", !wc503.ok && wc503.status === 503);
  }

  section("what the screen says (pure helpers)");
  {
    const a = new ApiActivity();
    check("nothing recorded: 'Nothing yet this session'", summarizeProvider("openai", a.snapshot().providers.openai, Date.now()).headline === "Nothing yet this session");
    a.record({ provider: "openai", kind: "photo analysis (listing)", outcome: "skipped_unneeded", route: "none" }, { quiet: true });
    a.record({ provider: "openai", kind: "x", outcome: "skipped_budget", route: "none" });
    const s = summarizeProvider("openai", a.snapshot().providers.openai, Date.now());
    check("only skips: it says decisions were made WITHOUT live requests (the 'no token use' explanation)", /No live requests yet/.test(s.headline) && s.skipped.unneeded === 1 && s.skipped.budget === 1, s);
    a.record({ provider: "openai", kind: "chat", outcome: "live_failed", route: "clynx_cloud", status: 503, error: "x" });
    check("every request failed is stated plainly", summarizeProvider("openai", a.snapshot().providers.openai, Date.now()).headline === "Every request failed");
    check("labels for every outcome kind", ["live_ok", "live_failed", "cached", "local_db", "skipped_budget", "skipped_unneeded", "skipped_disabled"].every((o) => outcomeLabel(o as any).length > 0));
    check("cost wording says when it is incomplete", /^at least/.test(formatCost(0.004, false)) && /^~/.test(formatCost(1.234, true)));
    check("verdict tones", verdictTone({ verdict: "match" }) === "good" && verdictTone({ verdict: "not a match" }) === "bad" && verdictTone({ verdict: "rejected from its title (no AI used)" }) === "bad" && verdictTone({ verdict: "unsure" }) === "neutral");
  }

  // (last: it leaves the module in its "credits used up" state, which would refuse every later AI call)
  section("OpenAI: requests that never left, and why");
  {
    handler = () => json({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, 429);
    await callOpenAI("chat", chatBody);
    check("an exhausted account is recorded as a failure with the quota reason and a hint", /insufficient_quota/.test(last("openai").error ?? "") && /no credit/i.test(failureHint({ provider: "openai", status: 429, error: last("openai").error }) ?? ""));
    let skipped = "";
    try { await callOpenAI("chat", chatBody); } catch (e) { skipped = (e as Error).message; }
    check("afterwards calls are refused without a request and recorded as 'skipped: allowance or limit'", /credits are used up/.test(skipped) && last("openai").outcome === "skipped_budget" && last("openai").route !== undefined);
    let ensured = "";
    try { ensureOpenAIAccess(); } catch (e) { ensured = (e as Error).message; }
    check("ensureOpenAIAccess refusals are recorded too (they used to leave no trace)", /credits are used up/.test(ensured) && stats("openai").skippedBudget >= 2);
    check("budget refusals are not counted as live requests", stats("openai").attempted === stats("openai").ok + stats("openai").failed);
  }

});
