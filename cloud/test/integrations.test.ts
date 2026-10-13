import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { closePool, pool } from "../src/db/client.js";
import { config } from "../src/config.js";
import { redisConnection } from "../src/queue/connection.js";
import { configureVault } from "../src/integrations/vault.js";
import { setOutboundFetch } from "../src/integrations/http.js";
import { invalidateCredentialCache } from "../src/integrations/credentials.js";
import { costUsd, invalidateControls } from "../src/integrations/controls.js";
import { resetEbayTokens } from "../src/ebay/service.js";
import { beginOwnerSetup, completeOwnerSetup, revokeOwner } from "../src/owner/service.js";
import { asWeb, makeAdmin, PASSWORD, signup, uniqueEmail, webLogin, type WebUser } from "./helpers/web.js";

// The company-managed OpenAI and eBay integrations: where the secrets live, who may touch them, what a customer can and cannot do, and how spending is bounded and attributed.
// No call in this file reaches OpenAI or eBay: provider traffic goes through a stand-in (setOutboundFetch).

const KEY_A = "sk-test-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "sk-test-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const EBAY_ID = "ClynxApp-ClynxApp-PRD-abcdef123-12345678";
const EBAY_SECRET = "PRD-secretsecretsecret-9999";
const CHAT = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }], max_tokens: 100 };

// ---- the provider stand-in
interface Mock {
  openaiCalls: Array<{ auth: string }>;
  openaiMode: "ok" | "500" | "throw" | "401" | "quota";
  openaiDelayMs: number;
  inFlight: number;
  maxInFlight: number;
  stream: boolean;
  ebayTokenMints: Array<{ basic: string; grant: string }>;
  ebayCalls: Array<{ url: string; auth: string }>;
  ebayTokenMode: "ok" | "fail" | "invalid_grant";
  ebay401Once: boolean;
  ebay401Always: boolean;
  models401: boolean;
  tokenSeq: number;
}
let mock: Mock;
const fresh = (): Mock => ({ openaiCalls: [], openaiMode: "ok", openaiDelayMs: 0, inFlight: 0, maxInFlight: 0, stream: false, ebayTokenMints: [], ebayCalls: [], ebayTokenMode: "ok", ebay401Once: false, ebay401Always: false, models401: false, tokenSeq: 0 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function providerFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.Authorization ?? headers.authorization ?? "";
  if (url.endsWith("/v1/models")) return mock.models401 || !auth.includes("sk-") ? json(401, { error: { message: "Incorrect API key provided: sk-…" } }) : json(200, { data: [] });
  if (url.endsWith("/v1/chat/completions")) {
    mock.openaiCalls.push({ auth });
    mock.inFlight++;
    mock.maxInFlight = Math.max(mock.maxInFlight, mock.inFlight);
    try {
      if (mock.openaiDelayMs) await sleep(mock.openaiDelayMs);
      if (mock.openaiMode === "throw") throw new TypeError("network down");
      if (mock.openaiMode === "500") return json(500, { error: { message: "server error" } });
      if (mock.openaiMode === "401") return json(401, { error: { message: "Incorrect API key provided: sk-test-AAAA…" } });
      if (mock.openaiMode === "quota") return json(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } });
      if (mock.stream) return new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      return json(200, { choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    } finally {
      mock.inFlight--;
    }
  }
  if (url.endsWith("/identity/v1/oauth2/token")) {
    const form = new URLSearchParams(String(init?.body ?? ""));
    mock.ebayTokenMints.push({ basic: auth, grant: form.get("grant_type") ?? "" });
    if (mock.ebayTokenMode === "fail") return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "client_credentials") return json(200, { access_token: `app-token-${++mock.tokenSeq}`, expires_in: 7200, token_type: "Application Access Token" });
    if (form.get("grant_type") === "authorization_code") return json(200, { access_token: `user-access-${++mock.tokenSeq}`, expires_in: 7200, refresh_token: "user-refresh-1", refresh_token_expires_in: 47304000 });
    if (form.get("grant_type") === "refresh_token") {
      if (mock.ebayTokenMode === "invalid_grant") return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `user-access-${++mock.tokenSeq}`, expires_in: 7200 });
    }
  }
  if (url.includes("/buy/browse/v1/")) {
    mock.ebayCalls.push({ url, auth });
    if (mock.ebay401Always) return json(401, { errors: [{ message: "invalid token" }] });
    if (mock.ebay401Once) {
      mock.ebay401Once = false;
      return json(401, { errors: [{ message: "token expired" }] });
    }
    return json(200, { itemSummaries: [{ title: "PlayStation 5", price: { value: "300.00" } }], total: 1 });
  }
  if (url.includes("/sell/inventory/v1/")) {
    mock.ebayCalls.push({ url, auth });
    return json(200, { inventoryItems: [], total: 0 });
  }
  return json(404, {});
}

// ---- the app and people
let app: FastifyInstance;
let owner: WebUser;
let admin: WebUser;
const VAULT_KEY = randomBytes(32).toString("base64");

async function chat(u: WebUser, body: Record<string, unknown> = CHAT) {
  const tok = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json().accessToken as string;
  return app.inject({ method: "POST", url: "/ai/chat/completions", headers: { authorization: `Bearer ${tok}` }, payload: body });
}
const bearer = async (u: WebUser) => ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PASSWORD } })).json().accessToken}` });
const saveOpenAI = (key: string, as: WebUser = owner) => app.inject({ method: "PUT", url: "/admin/integrations/openai", headers: asWeb(as), payload: { apiKey: key } });
const saveEbay = (extra: Record<string, unknown> = {}, as: WebUser = owner) => app.inject({ method: "PUT", url: "/admin/integrations/ebay", headers: asWeb(as), payload: { clientId: EBAY_ID, clientSecret: EBAY_SECRET, environment: "PRODUCTION", ...extra } });
const setControls = async (patch: string) => {
  await pool.query(`UPDATE api_controls SET ${patch} WHERE id = 1`);
  invalidateControls();
};

beforeAll(async () => {
  configureVault(VAULT_KEY);
  setOutboundFetch(providerFetch as typeof fetch);
  process.env.AI_RETRY_BASE_MS = "1";
  app = buildApp({ billing: null });
  await app.ready();
  await pool.query("SELECT set_config('clynx.owner_change', 'on', false)");
  await pool.query("UPDATE users SET role = 'user' WHERE role = 'owner'");
  await pool.query("SELECT set_config('clynx.owner_change', 'off', false)");
  const o = await signup(app);
  const { code } = await beginOwnerSetup(o.email);
  await completeOwnerSetup(o.email, code);
  owner = await webLogin(app, o.email);
  admin = await signup(app);
  await makeAdmin(admin.id);
});
afterAll(async () => {
  await revokeOwner(owner.email).catch(() => undefined);
  setOutboundFetch(null);
  await app?.close();
  await closePool();
});

beforeEach(async () => {
  mock = fresh();
  await pool.query("DELETE FROM integration_credentials");
  await pool.query("DELETE FROM integration_events");
  await pool.query("DELETE FROM ebay_user_tokens");
  await pool.query("UPDATE api_controls SET paid_api_enabled = true, disabled_reason = NULL, global_daily_usd = 20, global_monthly_usd = 200, user_daily_usd_free = 0.25, user_daily_usd_pro = 3, owner_daily_usd = 25, max_concurrent_user = 3, max_concurrent_global = 20, ebay_daily_calls_global = 4000, ebay_daily_calls_free = 100, ebay_daily_calls_pro = 1500, ebay_daily_calls_owner = 3000, abuse_requests_per_10min = 300, abuse_refusals_per_10min = 40, abuse_block_minutes = 30 WHERE id = 1");
  await pool.query("DELETE FROM api_user_blocks");
  await pool.query("DELETE FROM ebay_usage");
  await pool.query("DELETE FROM ai_usage WHERE created_at > now() - interval '1 day'");
  for (const pattern of ["rl:abuse:*", "rl:ai:*", "rl:ebay:*", "conc:*", "resv:*", "rl:integrations-write:*"]) for (const k of await redisConnection.keys(pattern)) await redisConnection.del(k);
  configureVault(VAULT_KEY);
  invalidateCredentialCache();
  invalidateControls();
  resetEbayTokens();
  config.openaiApiKey = null;
  config.enforceEntitlements = false;
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_SECRET;
});

describe("who may touch the credentials", () => {
  const routes: Array<[string, string, unknown]> = [
    ["GET", "/admin/integrations", undefined],
    ["PUT", "/admin/integrations/openai", { apiKey: KEY_A }],
    ["PUT", "/admin/integrations/ebay", { clientId: EBAY_ID, clientSecret: EBAY_SECRET }],
    ["POST", "/admin/integrations/openai/verify", {}],
    ["DELETE", "/admin/integrations/openai", { confirm: "REVOKE" }],
    ["PUT", "/admin/controls", { globalDailyUsd: 999 }],
    ["POST", "/admin/controls/resume", {}],
  ];

  it("anonymous callers get 401, customers and administrators get 403, the desktop token gets 403 - on every route", async () => {
    const customer = await signup(app);
    const desktop = await bearer(owner);
    for (const [method, url, payload] of routes) {
      expect((await app.inject({ method: method as "GET", url, payload: payload as object })).statusCode, `anon ${url}`).toBe(401);
      expect((await app.inject({ method: method as "GET", url, headers: asWeb(customer), payload: payload as object })).statusCode, `customer ${url}`).toBe(403);
      expect((await app.inject({ method: method as "GET", url, headers: asWeb(admin), payload: payload as object })).statusCode, `admin ${url}`).toBe(403);
      expect((await app.inject({ method: method as "GET", url, headers: desktop, payload: payload as object })).statusCode, `bearer ${url}`).toBe(403);
    }
    expect((await pool.query("SELECT 1 FROM integration_credentials")).rows).toHaveLength(0); // nothing was stored by any refused attempt
  });

  it("the Owner's calls still need the CSRF token", async () => {
    const res = await app.inject({ method: "PUT", url: "/admin/integrations/openai", headers: { cookie: owner.cookie }, payload: { apiKey: KEY_A } });
    expect(res.statusCode).toBe(403);
  });

  it("an administrator may look at spending and engage the emergency stop, but only the Owner may resume or change limits", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/spending", headers: { cookie: admin.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/admin/controls/emergency-stop", headers: asWeb(admin), payload: { reason: "testing" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/admin/controls/resume", headers: asWeb(admin), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/admin/controls", headers: asWeb(admin), payload: { globalDailyUsd: 1000 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/controls/resume", headers: asWeb(owner), payload: {} })).statusCode).toBe(200);
    const customer = await signup(app);
    expect((await app.inject({ method: "GET", url: "/admin/spending", headers: { cookie: customer.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/controls/emergency-stop", headers: asWeb(customer), payload: {} })).statusCode).toBe(403);
  });
});

describe("secrets are write-only", () => {
  it("saving stores only ciphertext, and the key never appears in any response, log row or export", async () => {
    const saved = await saveOpenAI(KEY_A);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().masked.key).toMatch(/^sk-…AAAA$/);
    const row = (await pool.query("SELECT ciphertext, masked, key_id FROM integration_credentials WHERE provider = 'openai'")).rows[0];
    expect(row.ciphertext.startsWith("v1.")).toBe(true);
    expect(row.ciphertext).not.toContain("AAAAAAAA");
    expect(JSON.stringify(row.masked)).not.toContain("AAAAAAAA");
    const customer = await signup(app);
    const everywhere = [
      saved.body,
      (await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).body,
      (await app.inject({ method: "GET", url: "/admin/spending", headers: { cookie: owner.cookie } })).body,
      (await app.inject({ method: "GET", url: "/admin/audit", headers: { cookie: owner.cookie } })).body,
      (await app.inject({ method: "GET", url: "/web/export", headers: { cookie: customer.cookie } })).body,
      (await app.inject({ method: "GET", url: "/billing/status", headers: { cookie: customer.cookie } })).body,
      (await app.inject({ method: "GET", url: "/plans/public" })).body,
      JSON.stringify((await pool.query("SELECT * FROM integration_events")).rows),
      JSON.stringify((await pool.query("SELECT detail FROM admin_audit ORDER BY id DESC LIMIT 20")).rows),
    ].join("\n");
    expect(everywhere).not.toContain("AAAAAAAAAAAA");
    expect(everywhere).not.toContain(row.ciphertext);
  });

  it("the console shows status, masked identifier and last verification, never a secret", async () => {
    await saveOpenAI(KEY_A);
    await saveEbay();
    const s = (await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json();
    expect(s.vaultConfigured).toBe(true);
    const openai = s.integrations.find((i: { provider: string }) => i.provider === "openai");
    const ebay = s.integrations.find((i: { provider: string }) => i.provider === "ebay");
    expect(openai).toMatchObject({ state: "connected", source: "vault", version: 1 });
    expect(ebay.masked.clientId).toMatch(/^ClynxA….*5678$/);
    expect(ebay.masked.secret).toBe("set");
    expect(JSON.stringify(s)).not.toContain(EBAY_SECRET);
    expect(JSON.stringify(s)).not.toContain(EBAY_ID);
    expect(s.events.length).toBeGreaterThan(0);
  });

  it("without an encryption key on the server nothing is stored", async () => {
    configureVault(null);
    const res = await saveOpenAI(KEY_A);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("vault_not_configured");
    expect((await pool.query("SELECT 1 FROM integration_credentials")).rows).toHaveLength(0);
  });

  it("rejects malformed credentials", async () => {
    expect((await saveOpenAI("not-a-key")).statusCode).toBe(400);
    expect((await saveEbay({ clientId: "x" })).statusCode).toBe(400);
    expect((await saveEbay({ environment: "STAGING" })).statusCode).toBe(400);
  });

  it("a tampered or foreign ciphertext cannot be read, and the failure is contained", async () => {
    await saveOpenAI(KEY_A);
    await pool.query("UPDATE integration_credentials SET ciphertext = regexp_replace(ciphertext, '.$', 'x') WHERE provider = 'openai'");
    invalidateCredentialCache();
    const customer = await signup(app);
    const res = await chat(customer);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ai_unavailable");
    expect(mock.openaiCalls).toHaveLength(0);
    expect(res.body).not.toMatch(/decrypt|cipher|key/i);
    expect(await redisConnection.get("conc:global")).toMatch(/^0(\.0+)?$|^-?0$/); // the slot was given back
    // recovery: the Owner saves the key again
    await saveOpenAI(KEY_A);
    expect((await chat(customer)).statusCode).toBe(200);
  });
});

describe("rotation, revocation and recovery", () => {
  it("a rotated key is used from the next request and the old one never again", async () => {
    await saveOpenAI(KEY_A);
    const u = await signup(app);
    expect((await chat(u)).statusCode).toBe(200);
    expect(mock.openaiCalls[0].auth).toBe(`Bearer ${KEY_A}`);
    const r = await saveOpenAI(KEY_B);
    expect(r.json()).toMatchObject({ rotated: true, version: 2 });
    for (let i = 0; i < 3; i++) expect((await chat(u)).statusCode).toBe(200);
    expect(mock.openaiCalls.slice(1).every((c) => c.auth === `Bearer ${KEY_B}`)).toBe(true);
    expect((await pool.query("SELECT ciphertext FROM integration_credentials")).rows[0].ciphertext).not.toContain("AAAAAAAA");
    const events = (await pool.query("SELECT action FROM integration_events WHERE provider = 'openai' ORDER BY id")).rows.map((e) => e.action);
    expect(events).toEqual(["set", "rotate"]);
  });

  it("revoking stops AI at once and the server environment is NOT a way back in; saving again restores service", async () => {
    config.openaiApiKey = "sk-env-ENVENVENVENVENVENVENVENVENVENVENV";
    await saveOpenAI(KEY_A);
    const u = await signup(app);
    expect((await chat(u)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/admin/integrations/openai", headers: asWeb(owner), payload: { confirm: "REVOKE" } })).statusCode).toBe(200);
    const after = await chat(u);
    expect(after.statusCode).toBe(503);
    expect(after.json().error).toBe("ai_not_configured");
    expect(mock.openaiCalls).toHaveLength(1);
    expect((await pool.query("SELECT ciphertext FROM integration_credentials WHERE provider = 'openai'")).rows[0].ciphertext).toBe("");
    expect((await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json().integrations[0].state).toBe("revoked");
    await saveOpenAI(KEY_B);
    expect((await chat(u)).statusCode).toBe(200);
    expect(mock.openaiCalls[1].auth).toBe(`Bearer ${KEY_B}`);
  });

  it("a server that never had a key saved falls back to its environment (status says so, without the value)", async () => {
    config.openaiApiKey = "sk-env-ENVENVENVENVENVENVENVENVENVENVENV";
    const u = await signup(app);
    expect((await chat(u)).statusCode).toBe(200);
    expect(mock.openaiCalls[0].auth).toBe(`Bearer ${config.openaiApiKey}`);
    const body = (await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).body;
    expect(JSON.parse(body).integrations[0]).toMatchObject({ source: "environment", state: "connected" });
    expect(body).not.toContain("ENVENV");
  });

  it("with nothing configured customers get a clear 'not set up' answer", async () => {
    const u = await signup(app);
    const res = await chat(u);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ai_not_configured");
  });

  it("verification makes a free call, records when it worked, and shows a rejected key as an error that clears after a fix", async () => {
    await saveOpenAI(KEY_A);
    expect((await app.inject({ method: "POST", url: "/admin/integrations/openai/verify", headers: asWeb(owner), payload: {} })).json().ok).toBe(true);
    let s = (await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json().integrations[0];
    expect(s.lastVerifyOk).toBe(true);
    expect(s.lastVerifiedAt).toBeTruthy();
    mock.models401 = true;
    expect((await app.inject({ method: "POST", url: "/admin/integrations/openai/verify", headers: asWeb(owner), payload: {} })).json()).toMatchObject({ ok: false, error: "OpenAI rejected the key." });
    s = (await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json().integrations[0];
    expect(s.state).toBe("error");
    mock.models401 = false;
    await app.inject({ method: "POST", url: "/admin/integrations/openai/verify", headers: asWeb(owner), payload: {} });
    expect((await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json().integrations[0].state).toBe("connected");
  });

  it("the encryption key itself can be rotated: values sealed with the previous key still open, and are re-sealed on the next save", async () => {
    await saveOpenAI(KEY_A);
    const oldId = (await pool.query("SELECT key_id FROM integration_credentials")).rows[0].key_id;
    const next = randomBytes(32).toString("base64");
    configureVault(next, VAULT_KEY);
    invalidateCredentialCache();
    const u = await signup(app);
    expect((await chat(u)).statusCode).toBe(200); // still readable
    await saveOpenAI(KEY_A);
    const newId = (await pool.query("SELECT key_id FROM integration_credentials")).rows[0].key_id;
    expect(newId).not.toBe(oldId);
    configureVault(next, null); // the old key can now be retired
    invalidateCredentialCache();
    expect((await chat(u)).statusCode).toBe(200);
  });
});

describe("the shared AI proxy: accounting and limits", () => {
  beforeEach(async () => {
    await saveOpenAI(KEY_A);
  });

  it("attributes usage and estimated cost to the customer who made the request", async () => {
    const a = await signup(app);
    const b = await signup(app);
    for (let i = 0; i < 3; i++) await chat(a);
    await chat(b);
    const rows = (await pool.query("SELECT user_id, count(*)::int AS n, sum(cost_usd_est)::float8 AS cost, max(prompt_tokens) AS pt FROM ai_usage WHERE user_id = ANY($1) GROUP BY user_id", [[a.id, b.id]])).rows;
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
    const per = costUsd("gpt-4o-mini", 100, 50);
    expect(byUser[a.id].n).toBe(3);
    expect(byUser[a.id].cost).toBeCloseTo(per * 3, 8);
    expect(byUser[b.id].cost).toBeCloseTo(per, 8);
    const spending = (await app.inject({ method: "GET", url: "/admin/spending", headers: { cookie: admin.cookie } })).json();
    expect(spending.today.estimatedUsd).toBeGreaterThanOrEqual(per * 4 - 1e-9);
    expect(spending.topCustomersToday.find((c: { id: string }) => c.id === a.id).requests).toBe(3);
    expect(spending.byModelToday.find((m: { model: string }) => m.model === "gpt-4o-mini").requests).toBeGreaterThanOrEqual(4);
    expect(spending.note).toMatch(/estimate/i);
  });

  it("one customer cannot exhaust the shared budget: when A reaches the personal cap, B is unaffected", async () => {
    const a = await signup(app);
    const b = await signup(app);
    const per = costUsd("gpt-4o-mini", 100, 50);
    // the cap allows a couple of requests; each request's worst case is far below it, the real cost is `per`
    await setControls(`user_daily_usd_free = ${(per * 2.5).toFixed(6)}`);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await chat(a)).statusCode);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    expect(codes).toContain(429);
    const refused = await chat(a);
    expect(refused.json().error).toBe("user_budget_exhausted");
    expect((await chat(b)).statusCode).toBe(200);
    const spent = (await pool.query("SELECT coalesce(sum(cost_usd_est),0)::float8 AS s FROM ai_usage WHERE user_id = $1", [a.id])).rows[0].s;
    expect(spent).toBeLessThanOrEqual(per * 2.5 + 1e-9);
  });

  it("the global ceiling stops everyone, and service resumes when it is raised", async () => {
    const a = await signup(app);
    await setControls("global_daily_usd = 0.000001");
    const r = await chat(a);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("api_budget_exhausted");
    expect(mock.openaiCalls).toHaveLength(0);
    await setControls("global_daily_usd = 20");
    expect((await chat(a)).statusCode).toBe(200);
  });

  it("the emergency switch stops every paid operation before anything is sent to the provider", async () => {
    const a = await signup(app);
    expect((await chat(a)).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/admin/controls/emergency-stop", headers: asWeb(admin), payload: { reason: "runaway cost" } });
    const calls = mock.openaiCalls.length;
    const r = await chat(a);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("paid_api_disabled");
    expect((await chat(owner)).statusCode).toBe(503); // the Owner is stopped too
    expect(mock.openaiCalls.length).toBe(calls);
    expect((await app.inject({ method: "GET", url: "/admin/controls", headers: { cookie: admin.cookie } })).json().controls).toMatchObject({ paidApiEnabled: false, disabledReason: "runaway cost" });
    await app.inject({ method: "POST", url: "/admin/controls/resume", headers: asWeb(owner), payload: {} });
    expect((await chat(a)).statusCode).toBe(200);
  });

  it("limits concurrent requests per customer, and gives the slots back", async () => {
    const a = await signup(app);
    await setControls("max_concurrent_user = 2");
    mock.openaiDelayMs = 300;
    const tok = await bearer(a);
    const results = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "POST", url: "/ai/chat/completions", headers: tok, payload: CHAT })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 429).every((r) => r.json().error === "concurrency_limit")).toBe(true);
    expect(mock.maxInFlight).toBe(2);
    mock.openaiDelayMs = 0;
    expect((await app.inject({ method: "POST", url: "/ai/chat/completions", headers: tok, payload: CHAT })).statusCode).toBe(200);
  });

  it("many customers at once: the global concurrency limit holds, nobody's usage is mixed up, nothing is lost", async () => {
    await setControls("max_concurrent_global = 4, max_concurrent_user = 3");
    const users = await Promise.all(Array.from({ length: 5 }, () => signup(app)));
    mock.openaiDelayMs = 150;
    const toks = await Promise.all(users.map(bearer));
    const results = await Promise.all(toks.flatMap((t) => [0, 1].map(() => app.inject({ method: "POST", url: "/ai/chat/completions", headers: t, payload: CHAT }))));
    expect(mock.maxInFlight).toBeLessThanOrEqual(4);
    const ok = results.filter((r) => r.statusCode === 200).length;
    expect(ok).toBeGreaterThan(0);
    expect(results.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 503 && r.json().error === "busy")).toBe(true);
    const rows = (await pool.query("SELECT count(*)::int AS n FROM ai_usage WHERE user_id = ANY($1) AND status = 200", [users.map((u) => u.id)])).rows[0].n;
    expect(rows).toBe(ok); // every success was recorded exactly once, against someone in the group
    mock.openaiDelayMs = 0;
    expect((await chat(users[0])).statusCode).toBe(200); // all slots were released
  });

  it("reservations stop parallel requests from overshooting a personal cap together", async () => {
    const a = await signup(app);
    const per = costUsd("gpt-4o-mini", 100, 50);
    const worst = costUsd("gpt-4o-mini", 60, 100); // about what one request reserves
    await setControls(`user_daily_usd_free = ${(Math.max(per, worst) * 1.6).toFixed(6)}, max_concurrent_user = 10`);
    mock.openaiDelayMs = 200;
    const tok = await bearer(a);
    const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: "POST", url: "/ai/chat/completions", headers: tok, payload: CHAT })));
    const admitted = results.filter((r) => r.statusCode === 200).length;
    expect(admitted).toBe(1); // the second would have taken the total past the cap, so it was refused before it started
    expect(results.some((r) => r.json().error === "user_budget_exhausted")).toBe(true);
  });

  it("the Owner has no plan quota but is still held to the safety ceiling", async () => {
    config.enforceEntitlements = true;
    await pool.query("INSERT INTO ai_usage (user_id, kind, model, status, cost_usd_est) SELECT $1, 'chat', 'gpt-4o-mini', 200, 0 FROM generate_series(1, 400)", [owner.id]);
    expect((await chat(owner)).statusCode).toBe(200); // 400 requests today exceed the free plan's 150, but the Owner has no daily request quota
    const free = await signup(app);
    await pool.query("INSERT INTO ai_usage (user_id, kind, model, status, cost_usd_est) SELECT $1, 'chat', 'gpt-4o-mini', 200, 0 FROM generate_series(1, 160)", [free.id]);
    expect((await chat(free)).json().error).toBe("ai_daily_limit"); // an ordinary free customer is stopped by the plan quota
    await setControls("owner_daily_usd = 0.000001");
    const r = await chat(owner);
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe("user_budget_exhausted"); // ...and the Owner by the spending ceiling
  });

  it("flags and temporarily blocks a customer who keeps hitting the limits; others are untouched; staff can lift it", async () => {
    const a = await signup(app);
    const b = await signup(app);
    await setControls("user_daily_usd_free = 0.000001, abuse_refusals_per_10min = 3");
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) codes.push((await chat(a)).json().error);
    expect(codes).toContain("temporarily_blocked");
    expect((await pool.query("SELECT reason FROM api_abuse_flags WHERE user_id = $1 AND cleared_at IS NULL", [a.id])).rows.map((r) => r.reason)).toContain("repeated_refusals");
    const flags = (await app.inject({ method: "GET", url: "/admin/spending", headers: { cookie: admin.cookie } })).json().openAbuseFlags;
    expect(flags.some((f: { userId: string }) => f.userId === a.id)).toBe(true);
    await setControls("user_daily_usd_free = 0.25");
    expect((await chat(a)).json().error).toBe("temporarily_blocked"); // raising the cap does not lift the block
    expect((await chat(b)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/abuse/${a.id}/clear`, headers: asWeb(admin), payload: {} })).statusCode).toBe(200);
    expect((await chat(a)).statusCode).toBe(200);
  });

  it("a request burst is flagged as abuse too", async () => {
    const a = await signup(app);
    await setControls("abuse_requests_per_10min = 4");
    const errors: Array<string | undefined> = [];
    for (let i = 0; i < 7; i++) {
      const r = await chat(a);
      errors.push(r.statusCode === 200 ? undefined : r.json().error);
    }
    expect(errors.slice(0, 4).every((e) => e === undefined)).toBe(true);
    expect(errors.slice(4).every((e) => e === "temporarily_blocked")).toBe(true);
    expect((await pool.query("SELECT 1 FROM api_abuse_flags WHERE user_id = $1 AND reason = 'request_burst'", [a.id])).rows.length).toBe(1);
  });

  it("provider failures are contained: no cost is charged, slots are released, the customer sees nothing of the provider's account, and recovery is automatic", async () => {
    const a = await signup(app);
    mock.openaiMode = "500";
    const r500 = await chat(a);
    expect(r500.statusCode).toBe(500);
    expect(mock.openaiCalls.length).toBe(3); // retried with backoff
    mock.openaiMode = "throw";
    expect((await chat(a)).statusCode).toBe(504);
    mock.openaiMode = "401"; // the company's key was rejected
    const r401 = await chat(a);
    expect(r401.statusCode).toBe(503);
    expect(r401.json().error).toBe("provider_unavailable");
    expect(r401.body).not.toMatch(/sk-|Incorrect API key/);
    expect((await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json().integrations[0].state).toBe("error"); // the Owner sees it
    mock.openaiMode = "quota";
    const rq = await chat(a);
    expect(rq.statusCode).toBe(503);
    expect(rq.body).not.toMatch(/quota|billing/i);
    expect(Number((await pool.query("SELECT coalesce(sum(cost_usd_est),0)::float8 AS s FROM ai_usage WHERE user_id = $1", [a.id])).rows[0].s)).toBe(0);
    mock.openaiMode = "ok";
    await saveOpenAI(KEY_A); // the Owner fixes the key
    expect((await chat(a)).statusCode).toBe(200);
    expect(Number(await redisConnection.get("conc:global"))).toBe(0);
  });

  it("streams are passed through and the slot is released when the stream ends", async () => {
    const a = await signup(app);
    mock.stream = true;
    const res = await chat(a, { ...CHAT, stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("[DONE]");
    for (let i = 0; i < 20 && Number(await redisConnection.get(`conc:user:${a.id}`)) !== 0; i++) await sleep(25);
    expect(Number(await redisConnection.get(`conc:user:${a.id}`))).toBe(0);
  });

  it("a model that is not allowed is refused before any limit or reservation is touched", async () => {
    const a = await signup(app);
    const res = await chat(a, { ...CHAT, model: "gpt-ultra-expensive" });
    expect(res.statusCode).toBe(400);
    expect(Number((await redisConnection.get("conc:global")) ?? 0)).toBe(0);
    expect(mock.openaiCalls).toHaveLength(0);
  });
});

describe("eBay through the company's application credentials", () => {
  it("is not available until the Owner configures it", async () => {
    const u = await signup(app);
    const res = await app.inject({ method: "GET", url: "/ebay/search?q=ps5", headers: await bearer(u) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ebay_not_configured");
    expect((await app.inject({ method: "GET", url: "/ebay/status", headers: await bearer(u) })).json().available).toBe(false);
  });

  it("searches public listings with an application token the customer never sees, minted once and shared", async () => {
    await saveEbay();
    const users = await Promise.all([signup(app), signup(app), signup(app)]);
    const toks = await Promise.all(users.map(bearer));
    const results = await Promise.all(toks.flatMap((t) => [1, 2].map(() => app.inject({ method: "GET", url: "/ebay/search?q=playstation%205&limit=5", headers: t }))));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results[0].json().itemSummaries[0].title).toBe("PlayStation 5");
    expect(mock.ebayTokenMints.filter((m) => m.grant === "client_credentials")).toHaveLength(1); // one token for six concurrent searches
    expect(mock.ebayCalls.every((c) => c.auth === "Bearer app-token-1")).toBe(true);
    expect(mock.ebayCalls[0].url).toContain("api.ebay.com/buy/browse/v1/item_summary/search?q=playstation+5&limit=5");
    const all = results.map((r) => r.body).join("");
    expect(all).not.toContain("app-token");
    expect(all).not.toContain(EBAY_SECRET);
    expect(mock.ebayTokenMints[0].basic).toBe(`Basic ${Buffer.from(`${EBAY_ID}:${EBAY_SECRET}`).toString("base64")}`);
    expect((await pool.query("SELECT count(*)::int AS n FROM ebay_usage WHERE user_id = ANY($1)", [users.map((u) => u.id)])).rows[0].n).toBe(6);
  });

  it("fetches one item, and rejects malformed searches without calling eBay", async () => {
    await saveEbay();
    const u = await signup(app);
    const t = await bearer(u);
    expect((await app.inject({ method: "GET", url: "/ebay/item/v1%7C1234567890%7C0", headers: t })).statusCode).toBe(200);
    const before = mock.ebayCalls.length;
    for (const url of ["/ebay/search", "/ebay/search?q=", "/ebay/search?q=x&limit=500", "/ebay/search?q=x&filter=%3Cscript%3E", "/ebay/search?q=x&sort=evil", "/ebay/search?q=x&marketplace=EBAY_XX"]) expect((await app.inject({ method: "GET", url, headers: t })).statusCode, url).toBe(400);
    expect((await app.inject({ method: "GET", url: "/ebay/item/..%2F..%2Fsecret", headers: t })).statusCode).toBe(400);
    expect(mock.ebayCalls.length).toBe(before);
  });

  it("is metered per customer: one customer's allowance running out does not affect another, and the global allowance is a ceiling", async () => {
    await saveEbay();
    const a = await signup(app);
    const b = await signup(app);
    await setControls("ebay_daily_calls_free = 2");
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: await bearer(a) })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
    expect((await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: await bearer(b) })).statusCode).toBe(200);
    await setControls("ebay_daily_calls_free = 100, ebay_daily_calls_global = 3");
    const r = await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: await bearer(b) });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("api_budget_exhausted");
  });

  it("obeys the emergency stop", async () => {
    await saveEbay();
    const u = await signup(app);
    await app.inject({ method: "POST", url: "/admin/controls/emergency-stop", headers: asWeb(admin), payload: {} });
    const r = await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: await bearer(u) });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("paid_api_disabled");
    expect(mock.ebayCalls).toHaveLength(0);
    await app.inject({ method: "POST", url: "/admin/controls/resume", headers: asWeb(owner), payload: {} });
  });

  it("rotating the eBay credentials mints a new token with the new credentials; an early-expired token is replaced and the call retried", async () => {
    await saveEbay();
    const u = await signup(app);
    const t = await bearer(u);
    await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: t });
    await saveEbay({ clientId: "NewApp-NewApp-PRD-zzzzzz999-87654321", clientSecret: "PRD-newsecretnewsecret-1111" });
    await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: t });
    expect(mock.ebayTokenMints).toHaveLength(2);
    expect(mock.ebayTokenMints[1].basic).toBe(`Basic ${Buffer.from("NewApp-NewApp-PRD-zzzzzz999-87654321:PRD-newsecretnewsecret-1111").toString("base64")}`);
    expect(mock.ebayCalls[1].auth).toBe("Bearer app-token-2");
    mock.ebay401Once = true;
    const retried = await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: t });
    expect(retried.statusCode).toBe(200);
    expect(mock.ebayTokenMints).toHaveLength(3);
  });

  it("when eBay rejects the company's credentials customers get a plain 'temporarily unavailable', the Owner sees the error, and a fix recovers", async () => {
    await saveEbay();
    const u = await signup(app);
    mock.ebay401Always = true;
    const r = await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: await bearer(u) });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("provider_unavailable");
    expect((await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie: owner.cookie } })).json().integrations.find((i: { provider: string }) => i.provider === "ebay").state).toBe("error");
    mock.ebay401Always = false;
    mock.ebayTokenMode = "fail";
    expect((await app.inject({ method: "POST", url: "/admin/integrations/ebay/verify", headers: asWeb(owner), payload: {} })).json().ok).toBe(false);
    mock.ebayTokenMode = "ok";
    expect((await app.inject({ method: "POST", url: "/admin/integrations/ebay/verify", headers: asWeb(owner), payload: {} })).json().ok).toBe(true);
    expect((await app.inject({ method: "GET", url: "/ebay/search?q=x", headers: await bearer(u) })).statusCode).toBe(200);
  });

  describe("a customer's OWN eBay account (separate consent)", () => {
    const stateOf = (url: string) => new URL(url).searchParams.get("state") as string;

    it("the application credentials alone grant no access to anyone's account", async () => {
      await saveEbay({ ruName: "Clynx-ClynxApp-PRD-abcdef-12345" });
      const u = await signup(app);
      const r = await app.inject({ method: "GET", url: "/ebay/me/inventory", headers: await bearer(u) });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe("ebay_not_connected");
      expect(mock.ebayCalls).toHaveLength(0);
    });

    it("cannot start without a RuName configured", async () => {
      await saveEbay();
      const u = await signup(app);
      const r = await app.inject({ method: "POST", url: "/ebay/connect", headers: await bearer(u), payload: {} });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe("ebay_user_flow_not_configured");
    });

    it("sends the customer to eBay to consent, accepts only a genuine single-use state, and stores their tokens encrypted", async () => {
      await saveEbay({ ruName: "Clynx-ClynxApp-PRD-abcdef-12345" });
      const u = await signup(app);
      const other = await signup(app);
      const t = await bearer(u);
      const url = (await app.inject({ method: "POST", url: "/ebay/connect", headers: t, payload: {} })).json().url as string;
      const q = new URL(url);
      expect(q.origin).toBe("https://auth.ebay.com");
      expect(q.searchParams.get("client_id")).toBe(EBAY_ID);
      expect(q.searchParams.get("redirect_uri")).toBe("Clynx-ClynxApp-PRD-abcdef-12345");
      expect(q.searchParams.get("scope")).toContain("sell.inventory.readonly");
      const state = stateOf(url);

      const forged = await app.inject({ method: "GET", url: `/ebay/callback?code=abcdefghij&state=${encodeURIComponent(state.slice(0, -2) + "xx")}` });
      expect(forged.headers.location).toMatch(/ebay=failed/);
      expect(mock.ebayTokenMints.filter((m) => m.grant === "authorization_code")).toHaveLength(0);
      expect((await pool.query("SELECT 1 FROM ebay_user_tokens")).rows).toHaveLength(0);

      const ok = await app.inject({ method: "GET", url: `/ebay/callback?code=abcdefghij&state=${encodeURIComponent(state)}` });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toMatch(/ebay=connected/);
      const row = (await pool.query("SELECT user_id, ciphertext FROM ebay_user_tokens")).rows[0];
      expect(row.user_id).toBe(u.id); // the state bound the consent to THIS customer
      expect(row.ciphertext).not.toContain("user-access");
      expect(row.ciphertext).not.toContain("user-refresh");
      expect((await app.inject({ method: "GET", url: `/ebay/callback?code=abcdefghij&state=${encodeURIComponent(state)}` })).headers.location).toMatch(/ebay=failed/); // single use

      expect((await app.inject({ method: "GET", url: "/ebay/status", headers: t })).json()).toMatchObject({ available: true, connected: true });
      expect((await app.inject({ method: "GET", url: "/ebay/status", headers: await bearer(other) })).json().connected).toBe(false);
      const inv = await app.inject({ method: "GET", url: "/ebay/me/inventory", headers: t });
      expect(inv.statusCode).toBe(200);
      expect(mock.ebayCalls.at(-1)?.auth).toBe("Bearer user-access-1"); // the CUSTOMER's token, not the application's
      expect((await app.inject({ method: "GET", url: "/ebay/me/inventory", headers: await bearer(other) })).json().error).toBe("ebay_not_connected");
    });

    it("refreshes an expiring token, and disconnects a customer whose grant eBay no longer honours", async () => {
      await saveEbay({ ruName: "Clynx-ClynxApp-PRD-abcdef-12345" });
      const u = await signup(app);
      const t = await bearer(u);
      const state = stateOf((await app.inject({ method: "POST", url: "/ebay/connect", headers: t, payload: {} })).json().url);
      await app.inject({ method: "GET", url: `/ebay/callback?code=abcdefghij&state=${encodeURIComponent(state)}` });
      await pool.query("UPDATE ebay_user_tokens SET access_expires_at = now() + interval '10 seconds' WHERE user_id = $1", [u.id]);
      expect((await app.inject({ method: "GET", url: "/ebay/me/inventory", headers: t })).statusCode).toBe(200);
      expect(mock.ebayTokenMints.some((m) => m.grant === "refresh_token")).toBe(true);
      expect(mock.ebayCalls.at(-1)?.auth).toMatch(/^Bearer user-access-\d+$/);
      await pool.query("UPDATE ebay_user_tokens SET access_expires_at = now() + interval '10 seconds' WHERE user_id = $1", [u.id]);
      mock.ebayTokenMode = "invalid_grant";
      const gone = await app.inject({ method: "GET", url: "/ebay/me/inventory", headers: t });
      expect(gone.statusCode).toBe(409);
      expect((await pool.query("SELECT 1 FROM ebay_user_tokens WHERE user_id = $1", [u.id])).rows).toHaveLength(0);
    });

    it("lets a customer disconnect, and deletes their tokens", async () => {
      await saveEbay({ ruName: "Clynx-ClynxApp-PRD-abcdef-12345" });
      const u = await signup(app);
      const t = await bearer(u);
      const state = stateOf((await app.inject({ method: "POST", url: "/ebay/connect", headers: t, payload: {} })).json().url);
      await app.inject({ method: "GET", url: `/ebay/callback?code=abcdefghij&state=${encodeURIComponent(state)}` });
      expect((await app.inject({ method: "DELETE", url: "/ebay/connection", headers: t })).statusCode).toBe(200);
      expect((await pool.query("SELECT 1 FROM ebay_user_tokens WHERE user_id = $1", [u.id])).rows).toHaveLength(0);
    });
  });
});

describe("the Owner and the rest of the platform", () => {
  it("customers never receive any credential in any account or plan answer", async () => {
    await saveOpenAI(KEY_A);
    await saveEbay();
    const u = await signup(app);
    const t = await bearer(u);
    const bodies = [
      (await app.inject({ method: "GET", url: "/me", headers: t })).body,
      (await app.inject({ method: "GET", url: "/billing/status", headers: t })).body,
      (await app.inject({ method: "GET", url: "/entitlements", headers: t })).body,
      (await app.inject({ method: "GET", url: "/ebay/status", headers: t })).body,
      (await app.inject({ method: "GET", url: "/plans/public" })).body,
      (await app.inject({ method: "GET", url: "/health/ready" })).body,
    ].join("\n");
    for (const secret of [KEY_A, "AAAAAAAAAA", EBAY_ID, EBAY_SECRET]) expect(bodies).not.toContain(secret);
  });

  it("a customer's own email never becomes a way to read credentials", async () => {
    await saveOpenAI(KEY_A);
    const imposter = await app.inject({ method: "POST", url: "/web/signup", payload: { email: uniqueEmail("owner"), password: PASSWORD } });
    expect(imposter.statusCode).toBe(201);
    const cookie = String(imposter.headers["set-cookie"]).split(";")[0];
    expect((await app.inject({ method: "GET", url: "/admin/integrations", headers: { cookie } })).statusCode).toBe(403);
  });
});
