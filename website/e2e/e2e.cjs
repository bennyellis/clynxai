// End-to-end test of the website in a real browser against a REAL Clynx Cloud server (its own throwaway database and Redis database, a simulated payment provider, mail captured in the
// outbox). Nothing here talks to Stripe, OpenAI, eBay or any email service. Run:  node website/e2e/e2e.cjs   (needs `npm run build` in website/ first)
const { spawn, execSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const CLOUD = path.join(ROOT, "cloud");
const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const requireFrom = (dir, name) => require(require.resolve(name, { paths: [dir] }));
const { chromium } = requireFrom(ROOT, "playwright");
const pg = requireFrom(CLOUD, "pg");

const DB_URL = "postgres://clynx:clynx_dev_password@localhost:5432/clynx_web_e2e";
const releasesDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-e2e-releases-"));
const env = {
  ...process.env,
  DATABASE_URL: DB_URL, REDIS_URL: "redis://localhost:6379/6", PORT: String(PORT), PUBLIC_URL: BASE, COOKIE_SECURE: "false",
  JWT_ACCESS_SECRET: crypto.randomBytes(24).toString("hex"), JWT_REFRESH_SECRET: crypto.randomBytes(24).toString("hex"),
  CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"), BILLING_FAKE: "true", STRIPE_PRICE_PRO_MONTHLY: "price_e2e_monthly", STRIPE_PRICE_PRO_YEARLY: "price_e2e_yearly",
  WEBSITE_DIR: path.join(ROOT, "website", "dist"), RELEASES_DIR: releasesDir, RATE_LIMIT_REGISTER_PER_HOUR: "1000", NODE_ENV: "test",
};
env.OPENAI_API_KEY = ""; // the server's own .env must not leak into the test server

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? "PASS " : "FAIL ") + name + (!ok && detail !== undefined ? "   " + String(detail).slice(0, 300) : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => crypto.randomBytes(4).toString("hex");
const PW = "e2e-password-123";

async function main() {
  execSync("npx tsx src/scripts/createdb.ts clynx_web_e2e --reset", { cwd: CLOUD, stdio: "ignore", shell: true });
  execSync("npx tsx src/db/migrate.ts", { cwd: CLOUD, stdio: "ignore", shell: true, env });
  const server = spawn("npx", ["tsx", "src/index.ts"], { cwd: CLOUD, env, shell: true, stdio: "ignore" });
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  let browser;
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
      await sleep(500);
    }
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const consoleErrors = [];
    const mkPage = async (opts = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
      const page = await ctx.newPage();
      page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
      return { ctx, page };
    };
    const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, e && e.message); } };
    const token = async (email, purpose) => (await db.query("SELECT body FROM email_outbox WHERE lower(to_email) = lower($1) AND purpose = $2 ORDER BY id DESC LIMIT 1", [email, purpose])).rows[0]?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    const text = (page) => page.evaluate(() => document.body.innerText);

    // ------------------------------------------------------------ 1. navigation and responsive layouts
    const shotsDir = path.join(__dirname, "shots");
    fs.mkdirSync(shotsDir, { recursive: true });
    const pages = ["/", "/features", "/pricing", "/download", "/support", "/legal/privacy", "/legal/terms", "/legal/subscription", "/legal/refunds", "/legal/cookies", "/login", "/signup", "/no-such-page"];
    for (const [label, width, height] of [["phone", 375, 780], ["tablet", 820, 1100], ["desktop", 1440, 900]]) {
      const { ctx, page } = await mkPage({ viewport: { width, height } });
      await step(`[nav ${label}] every public page renders with a heading and no sideways scrolling`, async () => {
        const bad = [];
        for (const p of pages) {
          const r = await page.goto(BASE + p, { waitUntil: "networkidle" });
          const h1 = await page.locator("h1").count();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
          if (!r.ok() && p !== "/no-such-page") bad.push(`${p} status ${r.status()}`);
          if (h1 === 0) bad.push(`${p} no h1`);
          if (overflow) bad.push(`${p} overflows at ${width}px`);
        }
        check(`[nav ${label}] every public page renders with a heading and no sideways scrolling`, bad.length === 0, bad.join("; "));
      });
      await page.goto(BASE + "/", { waitUntil: "networkidle" });
      await page.screenshot({ path: path.join(shotsDir, `home-${label}.png`), fullPage: false });
      if (width < 600) {
        await step("[nav phone] the menu button opens the navigation", async () => {
          await page.click(".menu-btn");
          check("[nav phone] the menu button opens the navigation", await page.locator("#main-nav.open a", { hasText: "Pricing" }).isVisible());
        });
      }
      await ctx.close();
    }

    const { ctx, page } = await mkPage();
    await step("[public] pricing shows placeholder prices and says they are not final", async () => {
      await page.goto(BASE + "/pricing", { waitUntil: "networkidle" });
      const t = await text(page);
      check("[public] pricing shows placeholder prices and says they are not final", await page.locator('[data-testid="price-placeholder"]').isVisible() && /Prices are not final/.test(t) && !/\$\d+\.\d\d\s*\/?\s*mo/i.test(t));
    });
    await step("[public] the download page admits there is no public release yet", async () => {
      await page.goto(BASE + "/download", { waitUntil: "networkidle" });
      check("[public] the download page admits there is no public release yet", await page.locator('[data-testid="no-release"]').isVisible());
    });
    await step("[public] legal pages are clearly drafts", async () => {
      await page.goto(BASE + "/legal/privacy", { waitUntil: "networkidle" });
      check("[public] legal pages are clearly drafts", /DRAFT - NOT LEGAL ADVICE/.test(await text(page)));
    });
    await step("[public] the support form takes a request", async () => {
      await page.goto(BASE + "/support", { waitUntil: "networkidle" });
      await page.fill("#s-email", `visitor-${rnd()}@example.com`);
      await page.fill("#s-subject", "Installer warning question");
      await page.fill("#s-message", "Windows shows an Unknown publisher warning when I run the installer. Is that expected?");
      await page.click("text=Send to support");
      await page.waitForSelector('[data-testid="support-reference"]', { timeout: 10000 });
      check("[public] the support form takes a request", true);
    });

    // ------------------------------------------------------------ 2. account: sign up, verify, sign out/in, reset
    const email = `e2e-${rnd()}@example.com`;
    await step("[account] sign up creates the account and shows the confirm-email banner", async () => {
      await page.goto(BASE + "/signup", { waitUntil: "networkidle" });
      await page.fill("#name", "E2E Tester");
      await page.fill("#email", email);
      await page.fill("#password", PW);
      await page.click("button:has-text('Create account')");
      await page.waitForURL("**/account", { timeout: 15000 });
      check("[account] sign up creates the account and shows the confirm-email banner", /confirm your email address/i.test(await text(page)) && /Hello, E2E Tester/.test(await text(page)));
    });
    await step("[account] the emailed link confirms the address", async () => {
      const t = await token(email, "verify_email");
      await page.goto(`${BASE}/verify-email?token=${t}`, { waitUntil: "networkidle" });
      await page.waitForSelector("text=Your email address is confirmed", { timeout: 10000 });
      await page.goto(BASE + "/account", { waitUntil: "networkidle" });
      check("[account] the emailed link confirms the address", !/Please confirm your email address/.test(await text(page)));
      await page.goto(`${BASE}/verify-email?token=${t}`, { waitUntil: "networkidle" });
      check("[account] ...and the link cannot be used twice", await page.locator("text=invalid or has expired").isVisible());
    });
    await step("[account] sign out, a wrong password is refused, the right one signs in", async () => {
      await page.goto(BASE + "/account", { waitUntil: "networkidle" });
      await page.click("button.link:has-text('Sign out')");
      await page.goto(BASE + "/account", { waitUntil: "networkidle" });
      const redirected = page.url().endsWith("/login");
      await page.fill("#email", email);
      await page.fill("#password", "wrong-password");
      await page.click("button:has-text('Sign in')");
      await page.waitForSelector(".error", { timeout: 10000 });
      const refused = /do not match/.test(await text(page));
      await page.fill("#password", PW);
      await page.click("button:has-text('Sign in')");
      await page.waitForURL("**/account", { timeout: 15000 });
      check("[account] sign out, a wrong password is refused, the right one signs in", redirected && refused);
    });
    await step("[account] the session cookie is HttpOnly and not readable by page scripts", async () => {
      const cookies = await ctx.cookies();
      const sid = cookies.find((c) => /clynx_sid/.test(c.name));
      const readable = await page.evaluate(() => document.cookie);
      check("[account] the session cookie is HttpOnly and not readable by page scripts", !!sid && sid.httpOnly === true && sid.sameSite === "Lax" && !/clynx_sid/.test(readable), JSON.stringify(sid));
    });

    const resetCtx = await mkPage();
    await step("[account] forgot password: an emailed link sets a new password and ends old sessions", async () => {
      const p = resetCtx.page;
      await p.goto(BASE + "/forgot-password", { waitUntil: "networkidle" });
      await p.fill("#email", email);
      await p.click("button:has-text('Email me a reset link')");
      await p.waitForSelector("text=Check your email");
      const t = await token(email, "reset_password");
      await p.goto(`${BASE}/reset-password?token=${t}`, { waitUntil: "networkidle" });
      await p.fill("#pw", "e2e-new-password-456");
      await p.fill("#pw2", "e2e-new-password-456");
      await p.click("button:has-text('Change password')");
      await p.waitForSelector("text=Your password was changed");
      await page.goto(BASE + "/account", { waitUntil: "networkidle" });
      const oldSessionEnded = page.url().endsWith("/login");
      await page.fill("#email", email);
      await page.fill("#password", PW);
      await page.click("button:has-text('Sign in')");
      await page.waitForSelector(".error", { timeout: 10000 });
      await page.fill("#password", "e2e-new-password-456");
      await page.click("button:has-text('Sign in')");
      await page.waitForURL("**/account", { timeout: 15000 });
      check("[account] forgot password: an emailed link sets a new password and ends old sessions", oldSessionEnded);
    });
    await resetCtx.ctx.close();

    // ------------------------------------------------------------ 3. subscription through the simulated provider
    await step("[billing] a trial starts through the simulated checkout and shows on the account", async () => {
      await page.goto(BASE + "/pricing", { waitUntil: "networkidle" });
      await page.click("button:has-text('Start 7-day free trial')");
      await page.waitForURL("**/dev/billing/checkout/**", { timeout: 15000 });
      const banner = /SIMULATED PAYMENT PAGE/.test(await text(page));
      await page.click("button:has-text('Pay with test card')");
      await page.waitForURL("**/account/billing**", { timeout: 15000 });
      await page.waitForSelector('[data-testid="plan-headline"]:has-text("free trial")', { timeout: 15000 });
      check("[billing] a trial starts through the simulated checkout and shows on the account", banner);
    });
    await step("[billing] switch to annual, cancel (with confirmation), resume", async () => {
      await page.click("button:has-text('Switch to annual billing')");
      await page.waitForSelector('[data-testid="plan-headline"]:has-text("billed yearly")', { timeout: 15000 });
      await page.click("button:has-text('Cancel subscription')");
      await page.click("button:has-text('Yes, cancel at the end of the period')");
      await page.waitForSelector("text=Resume subscription", { timeout: 15000 });
      const detail = await page.locator('[data-testid="plan-detail"]').innerText();
      await page.click("button:has-text('Resume subscription')");
      await page.waitForSelector("button:has-text('Cancel subscription')", { timeout: 15000 });
      check("[billing] switch to annual, cancel (with confirmation), resume", /NOT be charged/.test(detail), detail);
    });
    await step("[billing] a failed renewal shows the payment-problem banner; recovery clears it", async () => {
      await page.click("button:has-text('Payment method and invoices')");
      await page.waitForURL("**/dev/billing/portal/**", { timeout: 15000 });
      await page.click("button:has-text('Simulate failed renewal')");
      await page.waitForURL("**/account/billing**", { timeout: 15000 });
      await page.waitForSelector("text=Your last payment did not go through", { timeout: 15000 });
      await page.click("button:has-text('Update payment method')");
      await page.waitForURL("**/dev/billing/portal/**", { timeout: 15000 });
      await page.click("button:has-text('Simulate payment recovered')");
      await page.waitForURL("**/account/billing**", { timeout: 15000 });
      await page.waitForFunction(() => !/Your last payment did not go through/.test(document.body.innerText), null, { timeout: 15000 });
      check("[billing] a failed renewal shows the payment-problem banner; recovery clears it", true);
    });

    // ------------------------------------------------------------ 4. devices, data export, deletion
    await step("[devices] a computer signed in from the app can be removed, and then cannot refresh", async () => {
      const login = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "e2e-new-password-456" }) })).json();
      const dev = await (await fetch(`${BASE}/devices/register`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ platform: "win32", clientVersion: "0.3.0-beta.1" }) })).json();
      const bound = await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "e2e-new-password-456", deviceId: dev.id }) })).json();
      await page.goto(BASE + "/account/devices", { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="device-list"] li');
      await page.click('[data-testid="device-list"] button:has-text("Remove")');
      await page.click("button:has-text('Yes, sign it out')");
      await page.waitForFunction(() => !document.querySelector('[data-testid="device-list"]'), null, { timeout: 10000 });
      const refresh = await fetch(`${BASE}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: bound.refreshToken }) });
      check("[devices] a computer signed in from the app can be removed, and then cannot refresh", refresh.status === 401);
    });
    await step("[profile] data export is JSON without secrets; the profile name saves", async () => {
      await page.goto(BASE + "/account/profile", { waitUntil: "networkidle" });
      await page.fill("#p-name", "Renamed Tester");
      await page.click("button:has-text('Save name')");
      await page.waitForSelector("text=Saved.");
      const res = await page.request.get(BASE + "/web/export");
      const body = await res.text();
      check("[profile] data export is JSON without secrets; the profile name saves", res.ok() && JSON.parse(body).account.displayName === "Renamed Tester" && !/password_hash|argon2|secret_hash|csrf/i.test(body));
    });
    await step("[profile] deleting the account needs the password and the word DELETE, then ends the session", async () => {
      await page.click("button:has-text('Delete my account...')");
      const disabled = await page.locator("button:has-text('Permanently delete')").isDisabled();
      await page.fill("#d-pw", "e2e-new-password-456");
      await page.fill("#d-confirm", "DELETE");
      await page.click("button:has-text('Permanently delete')");
      await page.waitForURL(BASE + "/", { timeout: 20000 });
      const gone = (await db.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email])).rows.length === 0;
      check("[profile] deleting the account needs the password and the word DELETE, then ends the session", disabled && gone);
    });

    // ------------------------------------------------------------ 5. administrators and releases
    const adminEmail = `admin-${rnd()}@example.com`;
    await db.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Admin', now())", [adminEmail]);
    // a real password hash for the admin, made by the server's own tool path: sign up normally then promote
    await db.query("DELETE FROM users WHERE email = $1", [adminEmail]);
    const a = await mkPage();
    await a.page.goto(BASE + "/signup", { waitUntil: "networkidle" });
    await a.page.fill("#email", adminEmail);
    await a.page.fill("#password", PW);
    await a.page.click("button:has-text('Create account')");
    await a.page.waitForURL("**/account");
    await step("[admin] an ordinary customer cannot open the console", async () => {
      await a.page.goto(BASE + "/console", { waitUntil: "networkidle" });
      const adminApi = await a.page.request.get(BASE + "/admin/overview");
      check("[admin] an ordinary customer cannot open the console", a.page.url().includes("/account") && adminApi.status() === 403);
    });
    await db.query("UPDATE users SET role = 'admin' WHERE lower(email) = lower($1)", [adminEmail]);
    await step("[admin] an administrator sees the console but not the Owner's API integrations", async () => {
      await a.page.goto(BASE + "/console", { waitUntil: "networkidle" });
      await a.page.waitForSelector('[data-testid="stat-customers"]');
      const nav = await a.page.locator('nav[aria-label="Console"]').innerText();
      await a.page.goto(BASE + "/console/integrations", { waitUntil: "networkidle" });
      const api = await a.page.request.get(BASE + "/admin/integrations");
      const billing = await a.page.request.get(BASE + "/billing/status");
      check("[admin] an administrator sees the console but not the Owner's API integrations", !/API integrations/.test(nav) && api.status() === 403 && !a.page.url().endsWith("/integrations") && (await billing.json()).plan === "free", `${a.page.url()} ${api.status()}`);
    });
    await step("[admin] customers list and support inbox work", async () => {
      await a.page.goto(BASE + "/console/users", { waitUntil: "networkidle" });
      await a.page.waitForSelector('[data-testid="users-table"] tbody tr');
      await a.page.goto(BASE + "/console/support", { waitUntil: "networkidle" });
      await a.page.waitForSelector('[data-testid="support-item"]');
      check("[admin] customers list and support inbox work", /Installer warning question/.test(await text(a.page)));
    });
    // releases are the Owner's alone (Phase 11.7): the account is the Owner for this step (the server tool is the only way to become one; the test opens the database guard for these statements)
    const asRole = async (role) => {
      await db.query("SELECT set_config('clynx.owner_change', 'on', false)");
      await db.query("UPDATE users SET role = $2 WHERE lower(email) = lower($1)", [adminEmail, role]);
      await db.query("SELECT set_config('clynx.owner_change', 'off', false)");
    };
    await step("[releases] a plain administrator sees releases but none of the buttons that change them, and the server refuses them", async () => {
      await a.page.goto(BASE + "/console/releases", { waitUntil: "networkidle" });
      const visible = await a.page.locator("button:has-text('Create draft')").count();
      const refused = await a.page.request.post(BASE + "/admin/releases", { data: { version: "9.9.9-admin.1", channel: "beta" }, headers: { "x-csrf-token": (await (await a.page.request.get(BASE + "/web/session")).json()).csrfToken } });
      check("[releases] a plain administrator sees releases but none of the buttons that change them, and the server refuses them", visible === 0 && refused.status() === 403, `${visible} ${refused.status()}`);
    });
    await asRole("owner");
    await step("[releases] nothing is public until the Owner uploads, approves and publishes; then the download matches its checksum", async () => {
      const bytes = crypto.randomBytes(200_000);
      const file = path.join(os.tmpdir(), `Clynx-Test-${rnd()}.exe`);
      fs.writeFileSync(file, bytes);
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      await a.page.goto(BASE + "/console/releases", { waitUntil: "networkidle" });
      await a.page.fill("#r-version", "9.9.9-e2e.1");
      await a.page.fill("#r-notes", "End-to-end test build.");
      await a.page.click("button:has-text('Create draft')");
      const card = a.page.locator('[data-testid="release-9.9.9-e2e.1"]');
      await card.waitFor();
      await card.locator('input[type="file"]').setInputFiles(file);
      await a.page.waitForSelector(`text=${sha}`, { timeout: 20000 });
      const publicBefore = await (await fetch(`${BASE}/releases/latest?channel=beta`)).json();
      await card.locator("button:has-text('Approve')").click();
      await a.page.waitForSelector('[data-testid="release-9.9.9-e2e.1"] .pill:has-text("approved")');
      await card.locator('input[aria-label^="Type"]').fill("9.9.9-e2e.1");
      await card.locator("button:has-text('Publish')").click();
      await a.page.waitForSelector('[data-testid="release-9.9.9-e2e.1"] .pill:has-text("published")');
      const pub = await page.goto(BASE + "/download", { waitUntil: "networkidle" });
      void pub;
      await page.waitForSelector('[data-testid="release-card"]');
      const shown = await page.locator('[data-testid="sha256"]').innerText();
      const dl = await fetch(BASE + (await page.locator('[data-testid="download-button"]').getAttribute("href")));
      const got = Buffer.from(await dl.arrayBuffer());
      check("[releases] nothing is public until the Owner uploads, approves and publishes; then the download matches its checksum", publicBefore.release === null && shown.trim() === sha && crypto.createHash("sha256").update(got).digest("hex") === sha && /End-to-end test build/.test(await text(page)));
      fs.rmSync(file, { force: true });
    });
    await asRole("admin");
    await a.ctx.close();

    // ------------------------------------------------------------ 6. the Owner
    const ownerEmail = `owner-${rnd()}@example.com`;
    const o = await mkPage();
    await o.page.goto(BASE + "/signup", { waitUntil: "networkidle" });
    await o.page.fill("#email", ownerEmail);
    await o.page.fill("#password", PW);
    await o.page.click("button:has-text('Create account')");
    await o.page.waitForURL("**/account");
    await db.query("SELECT set_config('clynx.owner_change', 'on', false)");
    await db.query("UPDATE users SET role = 'user' WHERE role = 'owner'");
    await db.query("SELECT set_config('clynx.owner_change', 'off', false)");
    const cli = (args) => execSync(`npx tsx src/scripts/owner.ts ${args}`, { cwd: CLOUD, env, shell: true, encoding: "utf8" });
    const begin = cli(`begin ${ownerEmail}`);
    const code = begin.match(/own_[A-Za-z0-9_-]+/)[0];
    cli(`complete ${ownerEmail} ${code}`);
    await step("[owner] after the one-time server setup the account shows Owner - Full Access with no payment", async () => {
      const refused = await o.page.request.get(BASE + "/web/session");
      check("[owner] granting the role ended the old browser session", refused.status() === 401);
      await o.page.goto(BASE + "/login", { waitUntil: "networkidle" });
      await o.page.fill("#email", ownerEmail);
      await o.page.fill("#password", PW);
      await o.page.click("button:has-text('Sign in')");
      await o.page.waitForURL("**/account");
      await o.page.waitForSelector('[data-testid="plan-headline"]');
      const overview = await o.page.locator('[data-testid="plan-headline"]').innerText();
      await o.page.goto(BASE + "/account/billing", { waitUntil: "networkidle" });
      await o.page.waitForSelector('[data-testid="owner-card"]');
      const t = await text(o.page);
      check("[owner] after the one-time server setup the account shows Owner - Full Access with no payment", /Owner — Full Access/.test(overview) && /Owner — Full Access/.test(t) && !/Subscribe|Start .*trial|Monthly billing/.test(t), overview);
    });
    await step("[owner] the console has API integrations; a key is write-only, masked, replaceable and revocable", async () => {
      const KEY1 = "sk-e2e-" + "Q".repeat(30);
      const KEY2 = "sk-e2e-" + "R".repeat(30);
      await o.page.goto(BASE + "/console/integrations", { waitUntil: "networkidle" });
      await o.page.waitForSelector('[data-testid="integration-openai"]');
      const card = o.page.locator('[data-testid="integration-openai"]');
      await card.locator("button:has-text('Enter credentials')").click();
      await o.page.fill("#oa-key", KEY1);
      await card.locator("button:has-text('Save')").first().click();
      await o.page.waitForFunction(() => /sk-…QQQQ/.test(document.querySelector('[data-testid="masked-openai"]')?.textContent ?? ""), null, { timeout: 15000 });
      const masked = await card.locator('[data-testid="masked-openai"]').innerText();
      const html1 = await o.page.content();
      const storedPlain = (await db.query("SELECT ciphertext FROM integration_credentials WHERE provider = 'openai'")).rows[0].ciphertext;
      check("[owner] the saved key is masked, never in the page, and stored encrypted", /sk-…QQQQ/.test(masked) && !html1.includes("QQQQQQQQ") && !storedPlain.includes("QQQQ"), masked);
      await card.locator("button:has-text('Replace (rotate)')").click();
      await o.page.fill("#oa-key", KEY2);
      await card.locator("button:has-text('Save')").first().click();
      await o.page.waitForSelector("text=Replaced.", { timeout: 15000 });
      await o.page.waitForFunction(() => /RRRR/.test(document.querySelector('[data-testid="masked-openai"]')?.textContent ?? ""), null, { timeout: 15000 });
      check("[owner] replacing a key rotates it (the old one is erased)", /RRRR/.test(await card.locator('[data-testid="masked-openai"]').innerText()) && !(await o.page.content()).includes("QQQQQQQQ"));
      await card.locator("button:has-text('Revoke')").first().click();
      await o.page.fill('input[aria-label="Type REVOKE"]', "REVOKE");
      await o.page.locator("button.danger:has-text('Revoke')").last().click();
      await o.page.waitForSelector('[data-testid="state-openai"]:has-text("Revoked")', { timeout: 15000 });
      check("[owner] revoking disconnects it", true);
    });
    await step("[owner] the emergency stop pauses paid operations and only the Owner can resume", async () => {
      await o.page.goto(BASE + "/console/spending", { waitUntil: "networkidle" });
      await o.page.click('[data-testid="emergency-stop"]');
      await o.page.waitForSelector('[data-testid="stopped"]');
      await o.page.click("button:has-text('Resume paid operations')");
      await o.page.waitForSelector('[data-testid="emergency-stop"]');
      check("[owner] the emergency stop pauses paid operations and only the Owner can resume", true);
    });
    await o.ctx.close();

    check("[*] no unexpected browser console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    await ctx.close();
  } finally {
    try { await browser?.close(); } catch { /* closed */ }
    try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch { server.kill(); }
    await db.end().catch(() => undefined);
    fs.rmSync(releasesDir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
