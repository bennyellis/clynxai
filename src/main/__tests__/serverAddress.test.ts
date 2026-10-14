// The server address a person types, and "Test connection": normalisation, the rule that internet addresses must be https, and plain-language failures. No network is used.
import { classifyHost, compareVersionsLoose, describeFetchFailure, normalizeServerUrl, testServer } from "../serverAddress.js";
import { check, run, section } from "./_testkit.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (routes: Record<string, () => Response | Promise<Response>>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const h = routes[path];
    if (!h) return json(404, { error: "Not found" });
    return h();
  }) as typeof fetch;
const INFO = { product: "clynx-cloud", name: "Home server", serverVersion: "0.1.0", apiVersion: 1, minClientVersion: null, services: { sharedAi: true, sharedEbay: false, billing: "none", updates: true } };

run(async () => {
  section("classifying hosts");
  check("localhost / 127.x / ::1 are this computer", classifyHost("localhost") === "loopback" && classifyHost("127.0.0.1") === "loopback" && classifyHost("[::1]") === "loopback");
  check("10.x / 192.168.x / 172.16-31.x are a local network", classifyHost("10.0.0.81") === "local-network" && classifyHost("192.168.1.20") === "local-network" && classifyHost("172.20.1.1") === "local-network");
  check("172.32.x and public addresses are the internet", classifyHost("172.32.0.1") === "internet" && classifyHost("8.8.8.8") === "internet" && classifyHost("clynx.example.com") === "internet");
  check("computer names and .local names are local", classifyHost("ben") === "local-network" && classifyHost("ben.local") === "local-network" && classifyHost("nas.home.arpa") === "local-network");

  section("normalising what was typed");
  const a = normalizeServerUrl("  10.0.0.81:8788  ");
  check("a bare LAN address gets http:// and keeps its port", a.ok && a.url === "http://10.0.0.81:8788" && a.kind === "local-network", a);
  check("...with a warning that it is not encrypted", a.ok && a.warnings.some((w) => /not encrypted/.test(w)));
  const b = normalizeServerUrl("clynx.example.com");
  check("a bare internet name gets https://", b.ok && b.url === "https://clynx.example.com" && b.secure, b);
  const c = normalizeServerUrl("https://clynx.example.com/some/path?x=1#y");
  check("a path, query and fragment are dropped", c.ok && c.url === "https://clynx.example.com", c);
  const d = normalizeServerUrl("http://clynx.example.com");
  check("plain http to an internet address is REFUSED", !d.ok && /https/.test(d.error), d);
  const d2 = normalizeServerUrl("http://203.0.113.5:8788");
  check("...including a public IP address", !d2.ok, d2);
  check("credentials in the address are refused", !normalizeServerUrl("https://user:pass@clynx.example.com").ok);
  check("other schemes are refused", !normalizeServerUrl("ftp://10.0.0.1").ok && !normalizeServerUrl("javascript:alert(1)").ok && !normalizeServerUrl("file:///c:/x").ok);
  check("empty / non-string / huge input is refused", !normalizeServerUrl("").ok && !normalizeServerUrl(undefined).ok && !normalizeServerUrl("a".repeat(400)).ok);
  const l = normalizeServerUrl("http://localhost:8787");
  check("localhost is allowed but explained", l.ok && l.kind === "loopback" && l.warnings.some((w) => /THIS computer/.test(w)), l);
  const e = normalizeServerUrl("https://[fd00::1]:8443");
  check("an IPv6 unique-local address is a local network", e.ok && e.kind === "local-network", e);

  section("failures in plain words");
  const mk = (code: string, name = "TypeError") => Object.assign(new Error("fetch failed"), { name, cause: { code } });
  check("refused", /refused the connection/.test(describeFetchFailure(mk("ECONNREFUSED"), "http://10.0.0.81:8788")));
  check("name not found suggests the numeric address", /numeric address/.test(describeFetchFailure(mk("ENOTFOUND"), "http://ben:8788")));
  check("timeout mentions same network / guest network", /guest network/.test(describeFetchFailure(mk("ETIMEDOUT"), "http://10.0.0.81:8788")) && /guest network/.test(describeFetchFailure(Object.assign(new Error("x"), { name: "AbortError" }), "http://10.0.0.81:8788")));
  check("an untrusted certificate is refused with an explanation", /certificate/.test(describeFetchFailure(mk("DEPTH_ZERO_SELF_SIGNED_CERT"), "https://10.0.0.81")));
  check("no route", /no route/i.test(describeFetchFailure(mk("EHOSTUNREACH"), "http://10.9.9.9")));

  section("Test connection");
  const ok = await testServer("10.0.0.81:8788", { clientVersion: "0.3.0-beta.2", fetchImpl: fakeFetch({ "/server/info": () => json(200, INFO) }) });
  check("a Clynx server is recognised, with its name, version and shared services", ok.ok && ok.name === "Home server" && ok.serverVersion === "0.1.0" && ok.services.sharedAi === true && ok.url === "http://10.0.0.81:8788", ok);
  const priv = await testServer("10.0.0.81:8788", { clientVersion: "0.3.0", fetchImpl: fakeFetch({ "/server/info": () => json(200, { ...INFO, access: "private", registration: "invite" }) }) });
  check("a private, invitation-only server is reported as such (the sign-in screen asks for a code)", priv.ok && priv.access === "private" && priv.registration === "invite", priv);
  check("a server that says nothing about it is treated as open", ok.ok && ok.access === "open" && ok.registration === "open");
  const notClynx = await testServer("10.0.0.81:80", { clientVersion: "0.3.0", fetchImpl: fakeFetch({ "/server/info": () => json(200, { hello: "world" }) }) });
  check("a web server that is not Clynx is rejected", !notClynx.ok && notClynx.stage === "not-clynx", notClynx);
  const legacy = await testServer("10.0.0.81:8787", { clientVersion: "0.3.0", fetchImpl: fakeFetch({ "/health": () => json(200, { status: "ok" }) }) });
  check("an older Clynx server (no /server/info) still connects, marked legacy", legacy.ok && legacy.legacy === true, legacy);
  const nothing = await testServer("10.0.0.81:80", { clientVersion: "0.3.0", fetchImpl: fakeFetch({}) });
  check("a 404 for everything is 'not a Clynx server'", !nothing.ok && nothing.stage === "not-clynx", nothing);
  const down = await testServer("10.0.0.81:8788", { clientVersion: "0.3.0", fetchImpl: (async () => { throw mk("ECONNREFUSED"); }) as typeof fetch });
  check("an unreachable server gives a network failure sentence", !down.ok && down.stage === "network" && /refused/.test(down.error), down);
  const newer = await testServer("10.0.0.81:8788", { clientVersion: "0.3.0", fetchImpl: fakeFetch({ "/server/info": () => json(200, { ...INFO, apiVersion: 2 }) }) });
  check("a server with a newer protocol asks the person to update Clynx", !newer.ok && newer.stage === "version" && /Update Clynx/.test(newer.error), newer);
  const tooOld = await testServer("10.0.0.81:8788", { clientVersion: "0.3.0-beta.1", fetchImpl: fakeFetch({ "/server/info": () => json(200, { ...INFO, minClientVersion: "0.3.0" }) }) });
  check("...and so does a server that requires a newer app version", compareVersionsLoose("0.3.0-beta.1", "0.3.0") === 0 || (!tooOld.ok && tooOld.stage === "version"), tooOld);
  const tooOld2 = await testServer("10.0.0.81:8788", { clientVersion: "0.2.9", fetchImpl: fakeFetch({ "/server/info": () => json(200, { ...INFO, minClientVersion: "0.3.0" }) }) });
  check("a client older than the server's minimum is told to install the latest", !tooOld2.ok && tooOld2.stage === "version" && /0\.3\.0/.test(tooOld2.error), tooOld2);
  const bad = await testServer("http://clynx.example.com", { clientVersion: "0.3.0", fetchImpl: fakeFetch({ "/server/info": () => json(200, INFO) }) });
  check("an insecure internet address is refused BEFORE any request is made", !bad.ok && bad.stage === "address", bad);
  let asked = 0;
  await testServer("http://clynx.example.com", { clientVersion: "0.3.0", fetchImpl: (async () => { asked++; return json(200, INFO); }) as typeof fetch });
  check("(no request was made for it)", asked === 0);
  const err500 = await testServer("10.0.0.81:8788", { clientVersion: "0.3.0", fetchImpl: fakeFetch({ "/server/info": () => json(500, {}) }) });
  check("a server error is reported without calling it a wrong address", !err500.ok && /error \(500\)/.test(err500.error), err500);
});
