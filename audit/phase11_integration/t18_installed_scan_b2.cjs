// T18: a real scan cycle in the INSTALLED app against a MOCK Marketplace (every facebook.com request is answered locally, every other host is blocked, the browser cannot resolve any name).
// Proves the packaged scanner collects listings, saves them, and behaves sensibly with NO OpenAI key (the tester's default state). Run with INSTALLED_EXE.
const L = require("./lib.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { _electron } = require(path.join(L.PROJECT, "node_modules", "playwright"));

const EXE = process.env.INSTALLED_EXE;
const installDir = path.dirname(EXE);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-integ-t18-"));
  const userData = path.join(root, "userdata");
  fs.mkdirSync(userData, { recursive: true });
  const cloud = await L.startFakeCloud(18787);
  fs.writeFileSync(path.join(userData, "app-settings.json"), JSON.stringify({ cloudApiUrl: cloud.url }));
  const out = [];
  let app;
  try {
    app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], cwd: installDir, env: { ...process.env, OPENAI_API_KEY: "" }, timeout: 60000 });
    app.process().stdout?.on("data", (d) => out.push(String(d)));
    app.process().stderr?.on("data", (d) => out.push(String(d)));
    const win = await app.firstWindow();
    const errors = [];
    win.on("pageerror", (e) => errors.push(e.message));
    await win.waitForSelector('[data-testid="start-local"]', { timeout: 40000 });
    await win.click('[data-testid="start-local"]');
    await win.waitForFunction(() => /Start Scanner/i.test(document.body.innerText), null, { timeout: 40000 });
    await win.evaluate(() => { window.__logs = []; window.api.onLog((l) => window.__logs.push(l.level + ": " + l.message)); });

    // the mock Marketplace, installed in front of the app's own browser launcher
    await app.evaluate(({ app: a }) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const req = createRequire(a.getAppPath() + "/package.json");
      const pw = req("playwright");
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

    // one browse URL, no search terms: a single quick cycle
    const cfg = await win.evaluate(() => window.api.getConfig());
    const acct = cfg.accounts[0];
    cfg.accounts = [{ ...acct, enabled: true, locationMode: "city", selectedCityOrZip: "Richmond", locationResolved: true, browseUrls: ["https://www.facebook.com/marketplace/richmond/"] }, ...cfg.accounts.slice(1)];
    cfg.searchItems = [];
    await win.evaluate((c) => window.api.saveConfig(c), cfg);
    void win.evaluate(() => window.api.startEngine("default")).catch(() => {}); // resolves only when the engine stops
    const deadline = Date.now() + 150000;
    let rows = 0;
    const dbFile = path.join(userData, "data", "users", "local-beta", "scout.db");
    while (Date.now() < deadline) {
      await L.sleep(3000);
      try { const d = new DatabaseSync(dbFile, { readOnly: true }); rows = d.prepare("select count(*) as n from listings").get().n; d.close(); } catch {}
      if (rows >= 3) break;
      const alive = await Promise.race([win.evaluate(() => window.__logs.length).catch((e) => "err:" + e.message.slice(0, 40)), L.sleep(5000).then(() => "evaluate-timeout")]);
      console.log("  ...rows=" + rows + " logs=" + alive + " t=" + Math.round((Date.now() - (deadline - 150000)) / 1000) + "s");
    }
    const logs = await win.evaluate(() => window.__logs);
    const fbState = await app.evaluate(() => globalThis.__fb);
    L.check("[1] the installed scanner opened the browser through the packaged stack", fbState.launches >= 1, fbState);
    L.check("[2] it collected the listings from the (mock) Marketplace page and saved them", rows >= 3, { rows, logs: logs.slice(-12) });
    L.check("[2] it visited each listing's page", fbState.paths.filter((p) => /\/marketplace\/item\/\d+/.test(p)).length >= 3, fbState.paths.slice(0, 12));
    L.check("[3] nothing outside facebook.com was contacted by the browser", fbState.blocked.length === 0, fbState.blocked);
    const status = await win.evaluate(() => window.api.getEngineStatusMap());
    console.log("ENGINE STATUS:", JSON.stringify(status).slice(0, 400));
    console.log("LOG TAIL:\n" + logs.slice(-25).join("\n"));
    const listings = await win.evaluate(() => window.api.listListings(50, 0));
    console.log("LISTINGS:", JSON.stringify(listings.map((l) => ({ t: l.title, p: l.price, tier: l.dealTier, st: l.dealStatus, note: String(l.dealReasoning ?? l.reasoning ?? "").slice(0, 100) }))));
    L.check("[4] no cloud request was made", cloud.requests.length === 0, cloud.requests);
    L.check("[5] no page errors / uncaught errors", errors.length === 0 && out.join("").split(String.fromCharCode(10)).filter((l) => /uncaught|TypeError|ReferenceError|Cannot find module/i.test(l)).length === 0, errors.slice(0, 3));
    await win.evaluate(() => window.api.stopEngine?.("default")).catch(() => {});
  } catch (e) {
    L.check("harness error", false, String((e && e.stack) || e));
    console.log("MAIN OUTPUT (tail):", out.join("").slice(-1500));
  } finally {
    if (app) { try { await app.close(); } catch {} }
    await cloud.close();
  }
  const failed = L.results.filter((r) => r.ok === false).length;
  console.log(`\n${L.results.filter((r) => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
