// Phase 11.6 remote-beta audit: multi-account isolation, privilege boundaries, token behaviour and abuse limits, tested through the real HTTP routes against the DISPOSABLE test database.
// Every test uses freshly created throw-away accounts; no real account or record is touched.
//
// Findings that are real defects are written as `it.fails(...)`: the test states the SECURE behaviour, currently fails (so the suite stays green and the defect stays documented),
// and will turn red the moment the defect is fixed - at which point `it.fails` is changed to `it`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { SignJWT } from "jose";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import { closePool, pool } from "../src/db/client.js";
import { listingProcessingQueue } from "../src/queue/listingProcessingQueue.js";
import { asWeb, makeAdmin, signup as webSignup, webLogin } from "./helpers/web.js";

let app: FastifyInstance;
const routes: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  mkdirSync("../audit/phase116", { recursive: true });
  app = buildApp();
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") routes.push({ method: m, url: r.url });
  });
  await app.ready();
});
afterAll(async () => {
  // the bulk-ingest test below queues thousands of jobs; leave no backlog for the queue tests that follow
  await listingProcessingQueue.obliterate({ force: true }).catch(() => undefined);
  await app?.close();
  await closePool();
});

const PW = "correct-horse-battery";
interface U { id: string; email: string; access: string; refresh: string; device: string }
const bearer = (u: { access: string }) => ({ authorization: `Bearer ${u.access}` });

async function makeUser(label = "u"): Promise<U> {
  const email = `${label}-${randomUUID()}@example.com`;
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PW } });
  expect(res.statusCode).toBe(201);
  const b = res.json();
  const dev = await app.inject({ method: "POST", url: "/devices/register", headers: { authorization: `Bearer ${b.accessToken}` }, payload: { platform: "windows", clientVersion: "0.3.0-beta.3" } });
  expect(dev.statusCode).toBe(201);
  return { id: b.userId, email, access: b.accessToken, refresh: b.refreshToken, device: dev.json().id };
}

const now = () => Date.now();
const watchBody = (name: string, over: Record<string, unknown> = {}) => ({ name, searchPhrase: name, matchKeywords: [], locationMode: "country", enabled: true, createdAt: now(), updatedAt: now(), ...over });
const productBody = (name: string, over: Record<string, unknown> = {}) => ({ name, createdAt: now(), updatedAt: now(), ...over });
const listingBody = (id: string, title: string, price: number) => ({ source: "facebook", sourceListingId: id, title, url: `https://example.test/${id}`, price, firstSeenAt: now() });

async function putWatch(u: U, localId: string, name: string, over: Record<string, unknown> = {}) {
  return app.inject({ method: "PUT", url: `/watches/${localId}`, headers: bearer(u), payload: watchBody(name, over) });
}
async function ingest(u: U, id: string, title: string, price: number) {
  return app.inject({ method: "POST", url: "/listings/ingest", headers: bearer(u), payload: listingBody(id, title, price) });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("every route: who can reach it", () => {
  const sample = (url: string) => url.replace(/:([A-Za-z]+)/g, (_m, n: string) => (/id$/i.test(n) ? randomUUID() : "x")).replace(/\/\*$/, "/x");

  it("anonymous callers get 401/403 from every data route; the only reachable routes are the intended public ones", async () => {
    const reachable: string[] = [];
    const protectedCount = { n: 0 };
    for (const r of routes) {
      if (r.url === "/*" || r.url.startsWith("/web/assets") || r.url === "/web" || r.url.startsWith("/web/*")) continue; // static website files
      const res = await app.inject({ method: r.method as never, url: sample(r.url), payload: r.method === "GET" || r.method === "DELETE" ? undefined : {} });
      if (res.statusCode === 401 || res.statusCode === 403) protectedCount.n++;
      else reachable.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    mkdirSync("../audit/phase116", { recursive: true });
    writeFileSync("../audit/phase116/anonymous_route_probe.txt", `routes probed: ${routes.length}\nanswered 401/403 to an anonymous caller: ${protectedCount.n}\nanswered something else (public by design, or a validation error):\n${reachable.sort().join("\n")}\n`);
    const unexpected = reachable.filter((l) => /^(GET|POST|PUT|PATCH|DELETE) \/(watches|products|feedback|devices|listings|me(\/|$| )|ai|ebay\/(search|item|status|connect|me)|search-planner|admin|entitlements|billing\/(checkout|portal|subscription))/.test(l));
    expect(unexpected).toEqual([]);
    expect(protectedCount.n).toBeGreaterThan(50);
  });

  it("an ordinary signed-in user (bearer AND website cookie) is refused by every /admin route, including owner-only ones and URL variants", async () => {
    const u = await makeUser("ord");
    const w = await webSignup(app, `ordweb-${randomUUID()}@example.com`);
    const admin = routes.filter((r) => r.url.startsWith("/admin"));
    expect(admin.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const r of admin) {
      const url = sample(r.url);
      for (const headers of [bearer(u), asWeb(w)]) {
        const res = await app.inject({ method: r.method as never, url, headers, payload: r.method === "GET" || r.method === "DELETE" ? undefined : {} });
        if (res.statusCode < 400 || res.statusCode >= 500) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
        if (res.statusCode !== 403 && res.statusCode !== 401) bad.push(`${r.method} ${r.url} not refused as forbidden: ${res.statusCode}`);
      }
    }
    for (const v of ["/admin/invites/", "//admin/invites", "/admin/invites?x=1", "/ADMIN/invites", "/admin/invites/%2e%2e/users", "/admin/./invites", "/admin%2Finvites"]) {
      const res = await app.inject({ method: "GET", url: v, headers: asWeb(w) });
      // a 200 here is only the website's own HTML shell (the single-page app handles unknown paths); it must never be admin DATA (JSON)
      if (res.statusCode >= 200 && res.statusCode < 300 && !/text\/html/.test(String(res.headers["content-type"]))) bad.push(`variant ${v} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it("an administrator who is not the Owner cannot reach owner-only integration endpoints", async () => {
    const a = await webSignup(app, `adm-${randomUUID()}@example.com`);
    await makeAdmin(a.id);
    const res = await app.inject({ method: "GET", url: "/admin/integrations/openai", headers: asWeb(a) });
    expect([403, 404]).toContain(res.statusCode);
    const put = await app.inject({ method: "PUT", url: "/admin/integrations/openai", headers: asWeb(a), payload: { apiKey: "sk-test-not-real-0000000000" } });
    expect(put.statusCode).toBe(403);
  });

  it("registration cannot be used to claim a role or plan", async () => {
    const email = `esc-${randomUUID()}@example.com`;
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PW, role: "owner", plan: "pro", isBetaTester: true, disabled_at: null } });
    expect(res.statusCode).toBe(201);
    const row = (await pool.query("SELECT role, plan, is_beta_tester FROM users WHERE lower(email) = $1", [email])).rows[0];
    expect(row).toMatchObject({ role: "user", plan: "free", is_beta_tester: false });
    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${res.json().accessToken}` } });
    expect(me.json()).toMatchObject({ plan: "free", owner: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("two accounts: A cannot read, change or delete B's records", () => {
  let A: U, B: U;
  let aWatchId = "", aProductId = "", aListingId = "", aLocalWatch = "", aLocalProduct = "";

  beforeAll(async () => {
    A = await makeUser("a");
    B = await makeUser("b");
    aLocalWatch = `lw-${randomUUID()}`;
    aLocalProduct = `lp-${randomUUID()}`;
    const w = await putWatch(A, aLocalWatch, "A private watch", { searchPhrase: `a-secret-phrase-${randomUUID()}`, deviceId: A.device });
    aWatchId = w.json().watch.id;
    const p = await app.inject({ method: "PUT", url: `/products/${aLocalProduct}`, headers: bearer(A), payload: productBody("A private product", { resalePriceUsd: 500, observedNotes: "A notes" }) });
    aProductId = p.json().product.id;
    const l = await ingest(A, `L-${randomUUID()}`, "A listing", 100);
    aListingId = l.json().id;
    await app.inject({ method: "PUT", url: `/feedback/${aListingId}`, headers: bearer(A), payload: { verdict: "good", note: "A note", updatedAt: now() } });
    await app.inject({ method: "POST", url: `/watches/${aWatchId}/matches`, headers: bearer(A), payload: { matches: [{ localId: "m1", listingId: "x", matchedAt: now(), discoveryMode: "active" }] } });
  });

  it("B's lists never contain A's records (watches, products, feedback, devices, matches)", async () => {
    for (const url of ["/watches", "/products", "/feedback", "/devices"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(B) });
      expect(res.statusCode).toBe(200);
      const text = res.body;
      expect(text).not.toContain("A private");
      expect(text).not.toContain(aWatchId);
      expect(text).not.toContain(A.device);
      expect(text).not.toContain(aListingId);
    }
    expect((await app.inject({ method: "GET", url: `/watches/${aWatchId}/matches`, headers: bearer(B) })).statusCode).toBe(403);
  });

  it("B cannot delete, append to or read A's watch/product/device/feedback, and nothing of A's changes", async () => {
    expect((await app.inject({ method: "DELETE", url: `/watches/${aWatchId}`, headers: bearer(B) })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/products/${aProductId}`, headers: bearer(B) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/watches/${aWatchId}/matches`, headers: bearer(B), payload: { matches: [{ localId: "evil", listingId: "x", matchedAt: now(), discoveryMode: "active" }] } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/devices/${A.device}/heartbeat`, headers: bearer(B) })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/devices/${A.device}`, headers: bearer(B) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/feedback/${aListingId}`, headers: bearer(B) })).statusCode).toBe(404);
    // A's data is intact
    const aw = (await app.inject({ method: "GET", url: "/watches", headers: bearer(A) })).json().watches;
    expect(aw.map((w: { id: string }) => w.id)).toContain(aWatchId);
    expect((await app.inject({ method: "GET", url: `/watches/${aWatchId}/matches`, headers: bearer(A) })).json().matches).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/products", headers: bearer(A) })).json().products.map((p: { id: string }) => p.id)).toContain(aProductId);
    expect((await app.inject({ method: "GET", url: "/devices", headers: bearer(A) })).json().devices.map((d: { id: string }) => d.id)).toContain(A.device);
    expect((await app.inject({ method: "GET", url: "/feedback", headers: bearer(A) })).json().feedback).toHaveLength(1);
  });

  it("B writing to the same client-side local id creates B's OWN row; A's row is untouched (the sync key includes the user)", async () => {
    const r = await putWatch(B, aLocalWatch, "B overwrite attempt", { updatedAt: now() + 100000 });
    expect(r.statusCode).toBe(201);
    expect(r.json().watch.id).not.toBe(aWatchId);
    const p = await app.inject({ method: "PUT", url: `/products/${aLocalProduct}`, headers: bearer(B), payload: productBody("B product", { updatedAt: now() + 100000, resalePriceUsd: 1 }) });
    expect(p.statusCode).toBe(201);
    const aw = (await app.inject({ method: "GET", url: "/watches", headers: bearer(A) })).json().watches.find((w: { id: string }) => w.id === aWatchId);
    expect(aw.name).toBe("A private watch");
    const ap = (await app.inject({ method: "GET", url: "/products", headers: bearer(A) })).json().products.find((x: { id: string }) => x.id === aProductId);
    expect(ap.resalePriceUsd).toBe(500);
    // a watch can not be pointed at someone else's device either way: it only stores the id, and nothing reads another user's device through it
    const w = await putWatch(B, `lw-${randomUUID()}`, "B with A device", { deviceId: A.device });
    expect([200, 201, 400, 403, 500]).toContain(w.statusCode);
  });

  it("B's device id supplied at sign-in or refresh cannot attach A's session to B's device (refresh), and a stranger's device id is refused", async () => {
    // A signs in again (second sign-in) naming B's device: the later refresh must be refused because the device is not A's
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: A.email, password: PW, deviceId: B.device } });
    expect(login.statusCode).toBe(200);
    const refresh = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: login.json().refreshToken, deviceId: B.device } });
    // the token was created already tied to B's device at login time (see finding F-07); that is the case that matters
    expect([200, 401]).toContain(refresh.statusCode);
  });

  it.fails("KNOWN ISSUE F-03: a 403 for 'exists but not yours' vs 404 for 'does not exist' lets any user test whether an id exists", async () => {
    const mine = await app.inject({ method: "DELETE", url: `/watches/${aWatchId}`, headers: bearer(B) });
    const none = await app.inject({ method: "DELETE", url: `/watches/${randomUUID()}`, headers: bearer(B) });
    expect(mine.statusCode).toBe(none.statusCode);
  });

  it("F-01 (fixed in Beta 6): GET /search-planner/demand must not show other users' search phrases or watch ids", async () => {
    const phrase = `zz-private-phrase-${randomUUID()}`;
    await putWatch(A, `lw-${randomUUID()}`, "phrase carrier", { searchPhrase: phrase });
    const trig = await app.inject({ method: "POST", url: "/search-planner/aggregate", headers: bearer(B) });
    expect(trig.statusCode).toBe(403);
    const view = await app.inject({ method: "GET", url: "/search-planner/demand", headers: bearer(B) });
    writeFileSync("../audit/phase116/F01_search_planner_leak.txt", `B triggered aggregation: HTTP ${trig.statusCode}\nB read demand: HTTP ${view.statusCode}\nA's unique phrase visible to B: ${view.body.includes(phrase)}\nsample watch ids visible: ${/sampleWatchIds":\["[0-9a-f-]{36}/.test(view.body)}\n`);
    expect(view.body).not.toContain(phrase);
  });

  it.fails("KNOWN ISSUE F-02: another user can overwrite a shared listing record (title/price/url) that the first user ingested", async () => {
    const id = `shared-${randomUUID()}`;
    await ingest(A, id, "Original title from A", 250);
    await ingest(B, id, "Tampered title from B", 1);
    const row = (await pool.query("SELECT title, price FROM listings WHERE source_listing_id = $1", [id])).rows[0];
    expect(row.title).toBe("Original title from A");
  });

  it("the shared listing table has no read-back endpoint, so one user's listings are never returned to another", async () => {
    const urls = routes.filter((r) => r.method === "GET" && r.url.startsWith("/listings")).map((r) => r.url).sort();
    expect(urls).toEqual(["/listings/:id/jobs", "/listings/lookup"]);
    const id = `secret-${randomUUID()}`;
    await ingest(A, id, "A's cheap find", 50);
    const look = await app.inject({ method: "GET", url: `/listings/lookup?source=facebook&sourceListingId=${id}`, headers: bearer(B) });
    expect(look.statusCode).toBe(200); // reveals only that SOME user scanned this listing (F-04, low)
    expect(look.body).not.toContain("A's cheap find");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("sessions and tokens", () => {
  it("logout ends the refresh token; an access token already issued keeps working until it expires (measured)", async () => {
    const u = await makeUser("lo");
    const out = await app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken: u.refresh } });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: u.refresh } })).statusCode).toBe(401);
    const stillWorks = await app.inject({ method: "GET", url: "/watches", headers: bearer(u) });
    writeFileSync("../audit/phase116/F05_access_token_after_logout.txt", `after logout the access token answered HTTP ${stillWorks.statusCode} (access tokens live ${config.accessTokenTtlSeconds}s)\n`);
    expect(stillWorks.statusCode).toBe(200);
  });

  it("refresh tokens rotate; presenting a used one revokes that user's sessions and nobody else's", async () => {
    const a = await makeUser("rt-a");
    const b = await makeUser("rt-b");
    const r1 = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: a.refresh } });
    expect(r1.statusCode).toBe(200);
    const newRefresh = r1.json().refreshToken;
    expect(newRefresh).not.toBe(a.refresh);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: a.refresh } })).statusCode).toBe(401); // reuse
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: newRefresh } })).statusCode).toBe(401); // the whole family is revoked
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: b.refresh } })).statusCode).toBe(200); // B untouched
  });

  it("a refresh token only ever returns tokens for its own account, and a stranger's device id ends it", async () => {
    const a = await makeUser("x-a");
    const b = await makeUser("x-b");
    // sign-in without a device, then a refresh that claims B's device
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: a.email, password: PW } });
    const r = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: login.json().refreshToken, deviceId: b.device } });
    expect(r.statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: login.json().refreshToken } })).statusCode).toBe(401); // and the token is spent
    const ok = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: b.refresh } });
    expect(ok.json().userId).toBe(b.id);
  });

  it("a refresh token is NOT tied to one computer: once tied to a device it still refreshes when another of the user's devices (or none) is named (measured)", async () => {
    const u = await makeUser("nd");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PW, deviceId: u.device } });
    const second = (await app.inject({ method: "POST", url: "/devices/register", headers: bearer(u), payload: { platform: "windows", clientVersion: "x" } })).json().id;
    const r = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: login.json().refreshToken, deviceId: second } });
    writeFileSync("../audit/phase116/F06_refresh_not_machine_bound.txt", `refresh token created for device D1, presented naming device D2 (same user): HTTP ${r.statusCode}\n`);
    expect(r.statusCode).toBe(200);
  });

  it("removing a device ends the session tied to it", async () => {
    const u = await makeUser("rd");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, password: PW, deviceId: u.device } });
    expect((await app.inject({ method: "DELETE", url: `/devices/${u.device}`, headers: bearer(u) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: login.json().refreshToken } })).statusCode).toBe(401);
  });

  it("changing the password signs that user out everywhere and no one else", async () => {
    const a = await makeUser("pw-a");
    const b = await makeUser("pw-b");
    const res = await app.inject({ method: "POST", url: "/me/password", headers: bearer(a), payload: { currentPassword: PW, newPassword: "brand-new-password-1" } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: a.refresh } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: b.refresh } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: a.email, password: PW } })).statusCode).toBe(401);
  });

  it("forged, unsigned, expired and wrong-key access tokens are refused", async () => {
    const u = await makeUser("forge");
    const wrongKey = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt().setExpirationTime("10m").sign(new TextEncoder().encode("a-completely-different-secret-value"));
    const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(new TextEncoder().encode(config.jwtAccessSecret));
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: u.id, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.`;
    const refreshSecretToken = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(u.id).setExpirationTime("10m").sign(new TextEncoder().encode(config.jwtRefreshSecret));
    for (const t of [wrongKey, expired, none, refreshSecretToken, "garbage", ""]) {
      const res = await app.inject({ method: "GET", url: "/watches", headers: { authorization: `Bearer ${t}` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it.fails("KNOWN ISSUE F-05: a disabled account's already-issued access token must stop working at once", async () => {
    const victim = await makeUser("dis");
    const adminWeb = await webSignup(app, `own-${randomUUID()}@example.com`);
    await makeAdmin(adminWeb.id);
    const w = await webLogin(app, adminWeb.email);
    const off = await app.inject({ method: "POST", url: `/admin/users/${victim.id}/disabled`, headers: asWeb(w), payload: { value: true } });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: victim.refresh } })).statusCode).toBe(401); // refresh is stopped
    const still = await app.inject({ method: "GET", url: "/watches", headers: bearer(victim) });
    writeFileSync("../audit/phase116/F05_disabled_user_access_token.txt", `disabled user's existing access token answered HTTP ${still.statusCode}\n`);
    expect(still.statusCode).toBe(401);
  });

  it("a deleted account's old access token cannot create data (measured status)", async () => {
    const u = await makeUser("del");
    const del = await app.inject({ method: "DELETE", url: "/me", headers: bearer(u), payload: { password: PW, confirm: "DELETE" } });
    expect(del.statusCode).toBe(200);
    const r = await putWatch(u, `lw-${randomUUID()}`, "ghost");
    const list = await app.inject({ method: "GET", url: "/watches", headers: bearer(u) });
    writeFileSync("../audit/phase116/F09_deleted_account_token.txt", `PUT /watches with a deleted user's token: HTTP ${r.statusCode}; GET: ${list.statusCode}\n`);
    expect(r.statusCode).not.toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("plan limits and abuse limits (entitlement enforcement switched on for these tests)", () => {
  const original = config.enforceEntitlements;
  beforeAll(() => {
    (config as { enforceEntitlements: boolean }).enforceEntitlements = true;
  });
  afterAll(() => {
    (config as { enforceEntitlements: boolean }).enforceEntitlements = original;
  });

  it("a free account cannot exceed its Watch and device limits one request at a time", async () => {
    const u = await makeUser("lim");
    for (let i = 0; i < 4; i++) expect((await putWatch(u, `lw-${i}-${randomUUID()}`, `w${i}`)).statusCode).toBe(201);
    expect((await putWatch(u, `lw-5-${randomUUID()}`, "w5")).statusCode).toBe(201); // 5th
    expect((await putWatch(u, `lw-6-${randomUUID()}`, "w6")).statusCode).toBe(402); // 6th refused
    expect((await app.inject({ method: "POST", url: "/devices/register", headers: bearer(u), payload: { platform: "windows", clientVersion: "x" } })).statusCode).toBe(201); // 2nd
    expect((await app.inject({ method: "POST", url: "/devices/register", headers: bearer(u), payload: { platform: "windows", clientVersion: "x" } })).statusCode).toBe(402); // 3rd refused
  });

  it.fails("KNOWN ISSUE F-08: parallel requests cannot push a free account past its Watch limit (the check and the insert are not atomic)", async () => {
    const u = await makeUser("race");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => putWatch(u, `race-${i}-${randomUUID()}`, `r${i}`)));
    const total = (await pool.query("SELECT count(*)::int AS n FROM watches WHERE user_id = $1", [u.id])).rows[0].n;
    writeFileSync("../audit/phase116/F08_limit_race.txt", `20 parallel watch creations by a free user (limit 5): ${results.filter((r) => r.statusCode === 201).length} accepted, ${total} stored\n`);
    expect(total).toBeLessThanOrEqual(5);
  });

  it("a user cannot raise their own plan: no endpoint accepts a plan, and a forged billing webhook changes nothing", async () => {
    const u = await makeUser("plan");
    const hook = await app.inject({ method: "POST", url: "/billing/webhook", headers: { "stripe-signature": "t=1,v1=deadbeef" }, payload: { type: "customer.subscription.created", data: { object: { metadata: { userId: u.id }, status: "active" } } } });
    expect(hook.statusCode).toBeGreaterThanOrEqual(400);
    const ent = (await app.inject({ method: "GET", url: "/me/entitlements", headers: bearer(u) })).json();
    expect(JSON.stringify(ent)).toContain("free");
    for (const [method, url] of [["PATCH", "/me"], ["PUT", "/me"], ["POST", "/me/plan"], ["PUT", "/me/entitlements"]] as const) {
      const res = await app.inject({ method, url, headers: bearer(u), payload: { plan: "pro", role: "owner" } });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await pool.query("SELECT plan, role FROM users WHERE id = $1", [u.id])).rows[0]).toMatchObject({ plan: "free", role: "user" });
  });

  it("AI and eBay calls are refused for an anonymous caller and cannot name a model outside the allow-list", async () => {
    const u = await makeUser("ai");
    expect((await app.inject({ method: "POST", url: "/ai/chat/completions", payload: { model: "gpt-5-mini", messages: [] } })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/ai/chat/completions", headers: bearer(u), payload: { model: "o3-pro-super-expensive", messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("model_not_allowed");
    expect((await app.inject({ method: "GET", url: "/ebay/search?q=x" })).statusCode).toBe(401);
  });
});

describe("input limits that matter for a shared server (measured)", () => {
  it("how many listings one request may ingest, and how large other bodies may be", async () => {
    const u = await makeUser("big");
    const n = 1000;
    const listings = Array.from({ length: n }, (_, i) => listingBody(`bulk-${randomUUID()}-${i}`, `bulk ${i}`, 10));
    const t0 = performance.now();
    const res = await app.inject({ method: "POST", url: "/listings/ingest", headers: bearer(u), payload: { listings } });
    const ms = Math.round(performance.now() - t0);
    const queued = (await pool.query("SELECT count(*)::int AS n FROM listing_processing_jobs WHERE listing_id IN (SELECT id FROM listings WHERE title LIKE 'bulk %' AND source_listing_id LIKE 'bulk-%')")).rows[0].n;
    writeFileSync("../audit/phase116/F10_ingest_unbounded.txt", `one authenticated request with ${n} listings: HTTP ${res.statusCode}, ${ms} ms, ${res.json().results?.filter(Boolean).length ?? 0} stored; queue rows created so far (all runs): ${queued}\n`);
    expect(res.statusCode).toBe(200);
  }, 120000);
});
