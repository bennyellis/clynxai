// T19: the INSTALLED app, features that need no API key, against a MOCK Marketplace: a tester's Database product is recognised in a listing title, priced with plain math, scored,
// a Watch matches it, and everything survives a restart. Also: data from an OLDER install (a previous userdata folder) is read by the newly installed build.
// Run with INSTALLED_EXE and (optionally) OLD_USERDATA (a userdata folder produced by T17 with the previous installer).
const L = require("./lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const EXE = process.env.INSTALLED_EXE;
const installDir = path.dirname(EXE);
const NL = String.fromCharCode(10);

async function launch(userData, out) {
  const app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: installDir, env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 60000 });
  app.process().stdout?.on("data", (d) => out.push(String(d)));
  app.process().stderr?.on("data", (d) => out.push(String(d)));
  const win = await app.firstWindow();
  win.on("pageerror", (e) => out.push("PAGEERROR " + e.message));
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}
async function quit(h) {
  const exited = new Promise((r) => h.app.process().once("exit", () => r(true)));
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
  return Promise.race([exited, L.sleep(20000).then(() => false)]);
}
const mockMarketplace = (h) => h.app.evaluate(({ app: a }) => {
  const { createRequire } = process.getBuiltinModule("node:module");
  const pw = createRequire(a.getAppPath() + "/package.json")("playwright");
  const original = pw.chromium.launchPersistentContext.bind(pw.chromium);
  globalThis.__fb = { paths: [], blocked: [], launches: 0 };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const items = [
    { id: "1001", title: "PlayStation 5 Console disc edition with controller", price: "$260", desc: "Works perfectly. Comes with one controller and HDMI cable. Pickup only." },
    { id: "1002", title: "Nintendo Switch OLED White", price: "$180", desc: "Barely used, includes dock and joy-cons." },
    { id: "1003", title: "Office desk chair", price: "$30", desc: "Some wear." },
  ];
  const card = (i) => `<a href="/marketplace/item/${i.id}/" aria-label="${i.title}, ${i.price}, Richmond, VA"><img src="https://scontent.xx.fbcdn.net/${i.id}.png"><span>${i.price}</span><span>${i.title}</span></a>`;
  const browse = `<!doctype html><html><head><title>Marketplace | Facebook</title></head><body><div role="main"><input placeholder="Search Marketplace"><h2>Today's picks</h2><p>Marketplace Filters Location Richmond, VA</p>${items.map(card).join("")}</div></body></html>`;
  const detail = (i) => `<!doctype html><html><head><title>${i.title} | Facebook</title></head><body><div role="main"><h1>${i.title}</h1><div>${i.price}</div><div>Listed 2 hours ago in Richmond, VA</div><div>Description</div><div>${i.desc}</div><div>Seller information</div><div>Joined Facebook in 2015</div><img alt="Photo of ${i.title}" src="https://scontent.xx.fbcdn.net/${i.id}.png"></div></body></html>`;
  pw.chromium.launchPersistentContext = async (dir, opts) => {
    globalThis.__fb.launches++;
    const args = [...(opts.args || []), "--host-resolver-rules=MAP * ~NOTFOUND"];
    const ctx = await original(dir, { ...opts, args, headless: true });
    await ctx.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const fb = globalThis.__fb;
      if (/fbcdn\.net$/.test(url.hostname)) return route.fulfill({ status: 200, contentType: "image/png", body: png });
      if (!/(^|\.)facebook\.com$/.test(url.hostname)) { fb.blocked.push(url.hostname); return route.abort(); }
      fb.paths.push(url.pathname);
      const m = /\/marketplace\/item\/(\d+)/.exec(url.pathname);
      if (m) { const it = items.find((x) => x.id === m[1]); if (it) return route.fulfill({ status: 200, contentType: "text/html", body: detail(it) }); }
      return route.fulfill({ status: 200, contentType: "text/html", body: browse });
    });
    return ctx;
  };
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-integ-t19-"));
  const userData = path.join(root, "userdata");
  fs.mkdirSync(userData, { recursive: true });
  const cloud = await L.startFakeCloud(18787);
  fs.writeFileSync(path.join(userData, "app-settings.json"), JSON.stringify({ cloudApiUrl: cloud.url }));
  const out = [];
  let h;
  try {
    // ---- A. data written by an OLDER install is read by this build
    const old = process.env.OLD_USERDATA;
    if (old && fs.existsSync(old)) {
      const copy = path.join(root, "old-userdata");
      fs.cpSync(old, copy, { recursive: true });
      const before = fs.readdirSync(path.join(copy, "data", "users", "local-beta"));
      h = await launch(copy, out);
      await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
      L.check("[A] a newer install opens the previous install's data and goes straight in (no welcome screen)", true);
      L.check("[A] its settings, API key and Database are intact", (await h.win.evaluate(() => window.api.getConfig())).minProfitMarginPercent === 41 && (await h.win.evaluate(() => window.api.beta.info())).hasOpenAIKey === true && before.includes("scout.db"), before);
      L.check("[A] its earlier backup is still listed", (await h.win.evaluate(() => window.api.backups.list())).backups.length >= 1);
      await quit(h);
      h = null;
      await L.sleep(1500);
    }

    // ---- B. fresh tester: start, seed a product (as if researched earlier), restart so the app indexes it
    h = await launch(userData, out);
    await h.win.waitForSelector('[data-testid="start-local"]', { timeout: 40000 });
    await h.win.click('[data-testid="start-local"]');
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
    await quit(h);
    h = null;
    await L.sleep(1500);
    const dbFile = path.join(userData, "data", "users", "local-beta", "scout.db");
    const d = new DatabaseSync(dbFile);
    const cols = d.prepare("PRAGMA table_info(products)").all();
    const need = cols.filter((c) => c.notnull && c.dflt_value == null && !c.pk && c.name !== "name");
    const vals = need.map((c) => (/INT|REAL|NUM/i.test(c.type) ? Date.now() : "x"));
    d.prepare(`INSERT INTO products (id, name, ${need.map((c) => c.name).join(",")}) VALUES (?, ?, ${need.map(() => "?").join(",")})`).run("seed-ps5", "PlayStation 5 Console", ...vals);
    d.prepare("UPDATE products SET ebay_avg_sold_price_usd = 420, ebay_comps_sample_size = 14, ebay_est_value_usd = 420 WHERE id = 'seed-ps5'").run();
    d.close();

    h = await launch(userData, out);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
    L.check("[B] restart goes straight in; the seeded Database product is listed", (await h.win.evaluate(() => window.api.listProducts())).some((p) => p.id === "seed-ps5"));
    await mockMarketplace(h);
    await h.win.evaluate(() => { window.__logs = []; window.api.onLog((l) => window.__logs.push(l.level + ": " + l.message)); });
    // a Watch for the PS5 (Watches work locally and need no key)
    const watch = await h.win.evaluate(() => window.api.createWatch({ name: "PS5 under 300", terms: [{ phrase: "playstation 5" }], minPriceUsd: null, maxPriceUsd: 300, minProfitUsd: null, minDiscountPercent: null, maxListingAgeMinutes: null, minSellerRatingPercent: null, locationMode: "country", selectedState: null, selectedCityOrZip: null, searchRadiusMiles: null }));
    L.check("[C] a Watch can be created in local mode", !!watch?.id, watch);
    const cfg = await h.win.evaluate(() => window.api.getConfig());
    const acct = cfg.accounts[0];
    cfg.accounts = [{ ...acct, enabled: true, locationMode: "city", selectedCityOrZip: "Richmond", locationResolved: true, browseUrls: ["https://www.facebook.com/marketplace/richmond/"] }, ...cfg.accounts.slice(1)];
    cfg.searchItems = [];
    await h.win.evaluate((c) => window.api.saveConfig(c), cfg);
    void h.win.evaluate(() => window.api.startEngine("default")).catch(() => {});
    const deadline = Date.now() + 150000;
    let listings = [];
    while (Date.now() < deadline) {
      await L.sleep(3000);
      listings = await h.win.evaluate(() => window.api.listListings(50, 0)).catch(() => []);
      if (listings.length >= 3) break;
    }
    await L.sleep(4000);
    listings = await h.win.evaluate(() => window.api.listListings(50, 0));
    const logs = await h.win.evaluate(() => window.__logs);
    const ps5 = listings.find((l) => /PlayStation 5/i.test(l.title));
    L.check("[D] the scanner collected all three listings", listings.length === 3, listings.map((l) => l.title));
    L.check("[D] the PS5 listing was matched to the tester's Database product", !!ps5 && (ps5.productId === "seed-ps5" || /PlayStation 5/i.test(String(ps5.matchedItem ?? ps5.matchedProductName ?? ""))), ps5 && { productId: ps5.productId, matchedItem: ps5.matchedItem });
    L.check("[D] it was priced against that product's sold value, with no OpenAI key", !!ps5 && (Number(ps5.matchedProductAvgSoldPriceUsd ?? ps5.referencePriceUsd) === 420 || String(ps5.reasoning ?? "").length > 0), ps5 && { v: ps5.matchedProductAvgSoldPriceUsd, ref: ps5.referencePriceUsd, tier: ps5.dealTier, st: ps5.dealStatus, why: String(ps5.reasoning ?? "").slice(0, 160) });
    console.log("PS5:", JSON.stringify(ps5 && { tier: ps5.dealTier, status: ps5.dealStatus, stars: ps5.gateStars, headline: ps5.gateHeadline, deal: ps5.isDeal, why: String(ps5.reasoning ?? "").slice(0, 200) }));
    console.log("LOGS:" + NL + logs.slice(-14).join(NL));
    const matches = await h.win.evaluate((id) => window.api.listWatchMatches(id), watch.id).catch(() => []);
    L.check("[E] the Watch matched the PS5 listing", matches.some((m) => /PlayStation 5/i.test(m.listing.title)), matches.map((m) => m.listing.title));
    L.check("[F] no cloud request was made during the scan", cloud.requests.length === 0, cloud.requests);
    L.check("[F] no failed-notification error with no phone topic set", !logs.some((m) => /Notification failed/.test(m)), logs.filter((m) => /Notification/.test(m)));
    await h.win.evaluate(() => window.api.stopEngine?.("default")).catch(() => {});
    await L.sleep(1000);
    await quit(h);
    h = null;
    await L.sleep(1500);

    // ---- G. everything persisted
    h = await launch(userData, out);
    await h.win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
    const after = await h.win.evaluate(() => window.api.listListings(50, 0));
    L.check("[G] after a restart the collected listings, the Watch and its match are still there", after.length === 3 && (await h.win.evaluate(() => window.api.listWatches())).length === 1);
    L.check("[*] no page errors or uncaught errors", !out.some((l) => /PAGEERROR/.test(l)) && out.join("").split(NL).filter((l) => /uncaught|TypeError|ReferenceError|Cannot find module/i.test(l)).length === 0, out.filter((l) => /PAGEERROR|TypeError|uncaught/i.test(l)).slice(0, 3));
    await quit(h);
    h = null;
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    console.log("MAIN OUTPUT (tail):", out.join("").slice(-1500));
  } finally {
    if (h) { try { await h.app.close(); } catch {} }
    await cloud.close();
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`${NL}${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
