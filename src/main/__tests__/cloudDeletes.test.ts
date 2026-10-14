// Phase 12: deleting a Watch, Product or Feedback in the app must actually reach the server. Beta 2 to 5 sent every DELETE with "Content-Type: application/json" and no body; the server
// answered 400 each time, forever. The request must not claim a JSON body it does not have. (The server now also accepts such requests, for the computers still on an older version.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudClient, withoutEmptyContentType, writeSession } from "../cloudClient.js";
import type { Config } from "../types.js";
import { check, run, section } from "./_testkit.js";

const USER = "11111111-2222-4333-8444-555555555555";

run(async () => {
  section("the helper");
  {
    const h = (i?: RequestInit) => Object.keys((withoutEmptyContentType(i)?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
    check("no body: the JSON content type is dropped, the sign-in header stays", h({ method: "DELETE", headers: { "Content-Type": "application/json", Authorization: "Bearer x" } }).join() === "authorization");
    check("any spelling of the header is dropped", h({ method: "DELETE", headers: { "content-type": "application/json", Authorization: "Bearer x" } }).join() === "authorization");
    check("with a body nothing changes", h({ method: "PUT", body: "{}", headers: { "Content-Type": "application/json", Authorization: "Bearer x" } }).includes("content-type"));
    check("no headers, no init: unchanged", withoutEmptyContentType(undefined) === undefined && h({ method: "GET" }).length === 0);
  }

  section("what the client really sends");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-del-"));
  const sessionPath = path.join(root, "cloud-session.json");
  const config = { cloud: { enabled: true, apiUrl: "http://127.0.0.1:1" } } as unknown as Config;
  writeSession(sessionPath, { deviceId: "d1", refreshToken: "rt", userId: USER, email: "me@example.test", apiUrl: "http://127.0.0.1:18999" });
  const realFetch = globalThis.fetch;
  const seen: Array<{ method: string; path: string; contentType: string | null; hasBody: boolean }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    if (url.pathname === "/auth/refresh") return new Response(JSON.stringify({ accessToken: "at", refreshToken: "rt2", userId: USER }), { status: 200 });
    seen.push({ method: init?.method ?? "GET", path: url.pathname, contentType: headers.get("content-type"), hasBody: init?.body !== undefined });
    // a server that behaves like Fastify's default: a JSON content type with an empty body is refused
    if (headers.get("content-type")?.includes("json") && init?.body === undefined) return new Response(JSON.stringify({ error: "Body cannot be empty when content-type is set to 'application/json'" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, id: "dev-1" }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new CloudClient(() => config, sessionPath);
    await client.restoreSession();
    check("signed in for the test", client.isAuthenticated());
    const w = await client.deleteWatch("33333333-3333-4333-8333-333333333333");
    const p = await client.deleteProduct("44444444-4444-4444-8444-444444444444");
    const f = await client.deleteFeedback("55555555-5555-4555-8555-555555555555");
    check("deleting a Watch is accepted", w.ok === true, w);
    check("deleting a Product is accepted", p.ok === true, p);
    check("deleting Feedback is accepted", f.ok === true, f);
    const dels = seen.filter((s) => s.method === "DELETE");
    check("all three DELETE requests were sent, with no content type and no body", dels.length === 3 && dels.every((d) => d.contentType === null && !d.hasBody), dels);
    const reg = await client.registerDevice();
    check("a request that does carry a body still says it is JSON", reg.ok === true && seen.some((s) => s.path === "/devices/register" && s.contentType === "application/json" && s.hasBody), seen.map((s) => s.path));
    client.stopAuthRefresh();
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
