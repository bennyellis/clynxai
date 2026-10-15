// The REAL retrieval pipeline end to end over real HTTP: the real search backends (request building, bot-check detection, three different result markups,
// URL decoding), the real page fetch, the real text extraction (JSON-LD, meta, image labels, scripts), the real browser render for a JavaScript-only page, the
// real source classification and matching, and the real verifier. The only fake is the network address: a router maps the public hosts (html.duckduckgo.com,
// www.xbox.com, ...) to a local server that answers the way those sites actually do (a bot check, a JavaScript shell whose product names live in structured
// data, a page that is empty until its script runs, a refusal, a page where a console and a game merely sit near each other).
import http from "node:http";
import { chromium } from "playwright";
import { createEvidenceDeps, extractEvidenceText, parseBing, parseDuckDuckGoHtml, parseDuckDuckGoLite, type EvidenceDeps } from "../webEvidence.js";
import { queryFromSearchUrl } from "../searchLinks.js";
import { verifyVariant } from "../variantEvidence.js";
import { notRecordedMessage } from "../variantResearch.js";
import { lookUpWithDeps } from "../webResearch.js";
import { check, run, section } from "./_testkit.js";

const XBOX_PRODUCT_NAME = "Xbox Series X – 2TB Galaxy Black Special Edition";
const HALO_NAME = "Xbox Series X – Halo Infinite Limited Edition";

const hostRoutes: Record<string, string> = {
  "html.duckduckgo.com": "/ddg-html",
  "lite.duckduckgo.com": "/ddg-lite",
  "www.bing.com": "/bing",
  "www.xbox.com": "/xbox",
  "www.walmart.com": "/walmart",
  "www.gamenews.example": "/news",
};

// ----- what each site answers
function ddgHtmlBotCheck(): string {
  return `<html><body><div class="anomaly-modal"><form id="challenge-form">Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.</form></div></body></html>`;
}
function liteResults(items: Array<{ url: string; title: string; snippet: string }>): string {
  return `<table>${items.map((i) => `<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(i.url)}&amp;rut=abc" class='result-link'>${i.title}</a></td></tr><tr><td class='result-snippet'>${i.snippet}</td></tr>`).join("")}</table>`;
}
function bingResults(items: Array<{ url: string; title: string; snippet: string }>): string {
  return `<ol>${items
    .map((i) => `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=zzz&u=a1${Buffer.from(i.url).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}&ntb=1">${i.title}</a></h2><div class="b_caption"><p>${i.snippet}</p></div></li>`)
    .join("")}</ol>`;
}

// A manufacturer page the way the real ones are built: nothing but a script shell in the visible text, the product names in structured data and image labels.
const XBOX_CONSOLES = `<!doctype html><html><head><title>Xbox Series X | Xbox</title>
<meta name="description" content="Meet Xbox Series X, the fastest, most powerful Xbox ever.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"Product","name":"${XBOX_PRODUCT_NAME}","description":"Limited availability console."},{"@type":"Product","name":"Xbox Series X – 1TB Carbon Black"}]}</script>
</head><body><div id="root"></div><script src="/bundle.js"></script><noscript>Enable JavaScript</noscript></body></html>`;
// Empty until its script runs: only a browser sees the name.
const XBOX_HALO_JS = `<!doctype html><html><head><title>Xbox</title></head><body><div id="root"></div><script>var parts=['Xbox Series X','Halo Infinite','Limited Edition'];setTimeout(function(){var h=document.createElement('h1');h.textContent=parts[0]+' \u2013 '+parts[1]+' '+parts[2];document.getElementById('root').appendChild(h);},300);</script></body></html>`;
// A console and a game that are on the same page but are not the same product.
const NEWS_SCATTERED = `<html><head><title>This week in gaming</title></head><body><main><p>Xbox Series X is still the fastest console. ${"Weather was mild and the market was calm. ".repeat(40)} Meanwhile Halo Infinite received a new update and a new playlist for ranked players.</p></main></body></html>`;

let requests: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  requests.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (status: number, body: string, type = "text/html; charset=utf-8") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = (url.searchParams.get("q") ?? new URLSearchParams(body).get("q") ?? "").toLowerCase();
    if (url.pathname.startsWith("/ddg-html")) return send(202, ddgHtmlBotCheck());
    if (url.pathname.startsWith("/ddg-lite")) {
      if (/site:xbox\.com/.test(q) || /(galaxy|halo)/.test(q)) {
        const target = /halo/.test(q) ? "https://www.xbox.com/en-us/consoles/halo" : "https://www.xbox.com/en-us/consoles/xbox-series-x";
        return send(200, liteResults([{ url: target, title: "Xbox Series X | Xbox", snippet: "Meet Xbox Series X" }, { url: "https://www.gamenews.example/weekly", title: "This week in gaming", snippet: "Xbox Series X and Halo Infinite" }]));
      }
      return send(200, liteResults([]));
    }
    if (url.pathname.startsWith("/bing")) return send(200, bingResults([{ url: "https://www.walmart.com/ip/xbox", title: "Xbox Series X console", snippet: "Buy Xbox Series X at Walmart" }]));
    if (url.pathname === "/xbox/en-us/consoles/xbox-series-x") return send(200, XBOX_CONSOLES);
    if (url.pathname === "/xbox/en-us/consoles/halo") return send(200, XBOX_HALO_JS);
    if (url.pathname.startsWith("/walmart/blocked")) return send(403, "Access Denied");
    if (url.pathname === "/news/weekly") return send(200, NEWS_SCATTERED);
    return send(404, "not found");
  });
});

function routedFetch(port: number): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const u = new URL(String(input));
    const route = hostRoutes[u.hostname];
    if (!route) throw new Error(`no route for ${u.hostname}`);
    const local = `http://127.0.0.1:${port}${route}${u.pathname === "/" && route.startsWith("/ddg") ? "" : u.pathname}${u.search}`;
    return fetch(local, init);
  }) as typeof fetch;
}

async function launchRenderer(port: number): Promise<{ render: (url: string) => Promise<string | null>; close: () => Promise<void>; ok: boolean }> {
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    try {
      browser = await chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium" });
    } catch {
      return { render: async () => null, close: async () => undefined, ok: false };
    }
  }
  const b = browser;
  return {
    ok: true,
    close: () => b.close(),
    render: async (url) => {
      const u = new URL(url);
      const route = hostRoutes[u.hostname] ?? "";
      const page = await (await b.newContext()).newPage();
      await page.goto(`http://127.0.0.1:${port}${route}${u.pathname}${u.search}`, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(900);
      const html = await page.content();
      const visible = await page.evaluate(() => document.body?.innerText ?? "");
      return `${extractEvidenceText(html)}\n${visible}`;
    },
  };
}

run(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const renderer = await launchRenderer(port);
  const makeDeps = (withRender: boolean): EvidenceDeps => createEvidenceDeps({ fetchImpl: routedFetch(port), searchGapMs: 0, render: withRender && renderer.ok ? renderer.render : undefined });

  section("the parsers read the three real result markups");
  {
    check("DuckDuckGo HTML", parseDuckDuckGoHtml(`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.xbox.com/a")}&rut=1">Xbox <b>A</b></a><a class="result__snippet" href="#">A snippet</a>`)[0]?.url === "https://www.xbox.com/a");
    check("DuckDuckGo Lite", parseDuckDuckGoLite(liteResults([{ url: "https://www.xbox.com/b", title: "B", snippet: "s" }]))[0]?.url === "https://www.xbox.com/b");
    check("Bing (its redirect address is decoded to the real page)", parseBing(bingResults([{ url: "https://www.xbox.com/c", title: "C", snippet: "s" }]))[0]?.url === "https://www.xbox.com/c");
  }

  section("page text extraction keeps what the old tag-stripper threw away");
  {
    const text = extractEvidenceText(XBOX_CONSOLES);
    check("the product names in structured data are kept", text.includes(XBOX_PRODUCT_NAME) && text.includes("Xbox Series X – 1TB Carbon Black"), text.slice(0, 200));
    check("the page title and description are kept", text.includes("Xbox Series X | Xbox") && text.includes("fastest, most powerful"));
    check("an image's label is kept", extractEvidenceText('<img alt="Xbox Series X 2TB Galaxy Black Special Edition console" src="x.png">').includes("Galaxy Black Special Edition"));
  }

  section("a search engine that answers with a bot check is recorded as BLOCKED (not 'no results') and the next backend is used");
  {
    const deps = makeDeps(false);
    const hits = await deps.search("xbox series x galaxy site:xbox.com", 5);
    const t = deps.trace();
    check("the first backend's bot check was recognized", t.searches[0].backend === "duckduckgo-html" && t.searches[0].outcome === "blocked", t.searches);
    check("the next backend answered with results", t.searches[1].backend === "duckduckgo-lite" && t.searches[1].outcome === "ok" && hits.length === 2, t.searches);
    check("the result address was decoded from the redirect", hits[0].url === "https://www.xbox.com/en-us/consoles/xbox-series-x", hits[0]);
    const before = requests.filter((r) => r.includes("/ddg-html")).length;
    await deps.search("xbox series x galaxy again", 5);
    check("a backend that blocked is not asked again right away", requests.filter((r) => r.includes("/ddg-html")).length === before, requests.slice(-3));
  }

  section("'Galaxy Edition': the exact title finds nothing, the manufacturer page is found and read, the official name is discovered");
  {
    const deps = makeDeps(false);
    const v = await verifyVariant("Xbox Series X Galaxy", deps, { brandHints: ["Microsoft"], maxSteps: 8 });
    check("VERIFIED from the manufacturer", v.status === "verified" && v.sources.some((s) => s.sourceClass === "manufacturer" && s.fullMatch), { status: v.status, basis: v.basis });
    check("the evidence reached the verdict from www.xbox.com", v.sources.find((s) => s.fullMatch)?.host === "xbox.com", v.sources.map((s) => `${s.host}:${s.fullMatch}`));
    check("the official name is discovered ('Galaxy Black Special Edition')", /Galaxy Black Special Edition/.test(v.officialName ?? ""), v.officialName);
    check("the trace shows the blocked backend, the working one and the page read", !!v.diagnostics && v.diagnostics.searches.some((s) => s.outcome === "blocked") && v.diagnostics.searches.some((s) => s.outcome === "ok") && v.diagnostics.pages.some((p) => p.chars > 0), v.diagnostics);
  }

  section("'Halo Infinite Edition' -> 'Halo Infinite Limited Edition': a page that is empty until its script runs needs the browser render");
  {
    const without = await verifyVariant("Xbox Series X Halo Infinite Edition", makeDeps(false), { brandHints: ["Microsoft"] });
    check("read with a plain request only, it is NOT verified (the page shows nothing until its script runs)", without.status !== "verified", { status: without.status });
    if (renderer.ok) {
      const deps = makeDeps(true);
      const v = await verifyVariant("Xbox Series X Halo Infinite Edition", deps, { brandHints: ["Microsoft"] });
      check("with the browser fallback it is VERIFIED from the manufacturer", v.status === "verified" && /Halo Infinite Limited Edition/.test(v.officialName ?? ""), { status: v.status, official: v.officialName, basis: v.basis });
      check("the trace shows the plain read found nothing and the browser read found the page", !!v.diagnostics && v.diagnostics.pages.some((p) => p.via === "fetch" && p.chars < 400) === true && v.diagnostics.pages.some((p) => p.via === "browser" && p.chars > 0), v.diagnostics?.pages);
    } else console.log("  SKIP  browser render (no browser in this environment)");
  }

  section("a console and a game merely near each other on a page is not a product");
  {
    const deps = makeDeps(false);
    const v = await verifyVariant("Xbox Series X Halo Infinite Edition", deps, { userUrls: ["https://www.gamenews.example/weekly"], maxSteps: 0 });
    check("not verified", v.status !== "verified", v.status);
    const s = v.sources.find((x) => x.host === "gamenews.example");
    check("the page has all the words but not together, and says so", !!s && s.scattered === true && !s.fullMatch, s);
  }

  section("a link the user gives: read when it is a page, and never claimed read when it was not");
  {
    const deps = makeDeps(false);
    const good = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", deps, { userUrls: ["https://www.xbox.com/en-us/consoles/xbox-series-x"], maxSteps: 0 });
    check("a manufacturer page the user pasted is read and verifies it", good.status === "verified" && !good.unreadableUrls, { status: good.status, basis: good.basis });

    const refused = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", makeDeps(false), { userUrls: ["https://www.walmart.com/blocked/item"], maxSteps: 0 });
    check("a page that refuses the request is reported as unreadable", refused.status === "unverified" && refused.unreadableUrls?.[0] === "https://www.walmart.com/blocked/item", refused);
    check("the answer tells Clynx not to claim it read it", /Do NOT claim you opened or read it/.test(notRecordedMessage("X", { id: "1", name: "Xbox Series X" }, refused)), notRecordedMessage("X", { id: "1", name: "Xbox Series X" }, refused));

    const google = "https://www.google.com/search?gs_ssp=eJzj4tVP1zc0&q=xbox+series+x+galaxy+black&oq=xbox+series+x+g&gs_lcrp=EgZjaHJvbWU";
    check("a Google results link is recognized as a search, with its query", queryFromSearchUrl(google) === "xbox series x galaxy black");
    check("an eBay search link too", queryFromSearchUrl("https://www.ebay.com/sch/i.html?_nkw=xbox+series+x+halo") === "xbox series x halo");
    check("a product page is not mistaken for one", queryFromSearchUrl("https://www.xbox.com/en-us/consoles/xbox-series-x") === null);
    const viaGoogle = await verifyVariant("Xbox Series X Galaxy Black", makeDeps(false), { userUrls: [google], brandHints: ["Microsoft"] });
    check("the search link is NOT counted as a page that was read", viaGoogle.searchLinks?.[0].query === "xbox series x galaxy black" && !viaGoogle.unreadableUrls, viaGoogle.searchLinks);
    check("its words were used as a search and the claim verified", viaGoogle.status === "verified", { status: viaGoogle.status, basis: viaGoogle.basis });
    const msg = notRecordedMessage("X", { id: "1", name: "P" }, { ...viaGoogle, status: "unverified" });
    check("the answer says it was a search-results page, not read as a page", /search-results page/.test(msg) && /did NOT read it as a page/.test(msg), msg);
  }

  section("when every search engine is blocked, the answer says the lookup FAILED (not 'nothing found')");
  {
    const blockedAll = createEvidenceDeps({
      fetchImpl: (async () => new Response("<html>Unfortunately, bots use DuckDuckGo too. captcha</html>", { status: 429 })) as unknown as typeof fetch,
      searchGapMs: 0,
    });
    const v = await verifyVariant("Xbox Series X 2TB Galaxy Black Special Edition", blockedAll, { maxSteps: 3 });
    check("unverified, flagged as search-unavailable", v.status === "unverified" && v.searchUnavailable === true, v);
    check("the basis says the search was blocked and proves nothing", /web search itself was blocked or failed/.test(v.basis) && /says nothing about whether the product exists/.test(v.basis), v.basis);
    const m = notRecordedMessage("X", { id: "1", name: "P" }, v);
    check("Clynx is told to report a failed lookup and not to describe searches that did not happen", /failed lookup, not a finding/.test(m) && /do not describe searches that did not happen/.test(m), m);
    const chat = await lookUpWithDeps("Xbox Series X 2TB Galaxy Black Special Edition", blockedAll);
    check("the chat look-up says the search was blocked", /web search itself was blocked or failed/.test(chat) && /do NOT say the search found nothing/i.test(chat), chat);
  }

  await renderer.close();
  server.close();
});
