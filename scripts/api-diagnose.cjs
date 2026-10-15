// Beta 12: a small, bounded, REAL check of OpenAI, eBay and WatchCount, made by the same code Clynx uses. It fails visibly: every dependency that cannot be reached or is not configured says so
// and the exit code is 1.
//
//   node scripts\\api-diagnose.cjs                       (reads keys from the environment and from Clynx's own .env: %APPDATA%\\Clynx\\.env)
//   node scripts\\api-diagnose.cjs --env "C:\\path\\to\\.env"
//
// Spends: one AI request of a few dozen tokens (a fraction of a cent), one eBay search of 20 results, one WatchCount page request. It prints no key, token or header. It checks THIS computer's own
// keys only: if Clynx is set to use Clynx Cloud's shared AI/eBay, the keys that matter live on the server and this command cannot test them; use the "Run API check" button in
// Activity > AI Activity instead (it uses whichever route the app uses).
const { buildSync } = require("esbuild");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-api-diagnose-"));
const out = path.join(tmp, "diagnose.cjs");
const entry = path.join(tmp, "diagnose-entry.ts");
fs.writeFileSync(
  entry,
  `
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { OPENAI_MODEL, callOpenAI, hasOpenAIAccess } from ${JSON.stringify(path.join(root, "src/main/openai.ts"))};
import { hasEbayCredentials, searchEbayItems } from ${JSON.stringify(path.join(root, "src/main/ebayClient.ts"))};
import { runApiSelfTest } from ${JSON.stringify(path.join(root, "src/main/apiSelfTest.ts"))};
import { apiActivity } from ${JSON.stringify(path.join(root, "src/main/apiActivity.ts"))};

const args = process.argv.slice(2);
const envArg = args.indexOf("--env") >= 0 ? args[args.indexOf("--env") + 1] : null;
const candidates = [envArg, process.env.APPDATA ? path.join(process.env.APPDATA, "Clynx", ".env") : null, path.join(process.cwd(), ".env")].filter(Boolean) as string[];
const loaded: string[] = [];
for (const f of candidates) if (fs.existsSync(f)) { dotenv.config({ path: f }); loaded.push(f); }

// "Protect my saved keys" stores each key as enc:v1:<ciphertext>, written with Windows' protected storage through Electron: only the running Clynx app can read it. Sending that ciphertext to
// OpenAI / eBay would only produce a misleading 401, so such a key is NOT used here and the check says so. Put a plain key in this shell to test it from the command line, or use the in-app check.
const protectedVars: string[] = [];
for (const name of ["OPENAI_API_KEY", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"]) {
  if ((process.env[name] ?? "").trim().startsWith("enc:v1:")) { protectedVars.push(name); delete process.env[name]; }
}
const have = (v: string | undefined) => (v && v.trim() ? "present" : "MISSING");
console.log("Environment files read: " + (loaded.join(", ") || "none"));
if (protectedVars.length) console.log("Stored encrypted by Clynx ('Protect my saved keys'), so this command cannot read: " + protectedVars.join(", ") + ". That is NOT a sign the keys are wrong. Use Activity > AI Activity > Run API check inside Clynx, or set plain keys in this shell for this command only (PowerShell: $env:OPENAI_API_KEY='sk-...'; $env:EBAY_CLIENT_ID='...'; $env:EBAY_CLIENT_SECRET='...').");
console.log("OPENAI_API_KEY: " + (protectedVars.includes("OPENAI_API_KEY") ? "ENCRYPTED (unreadable here)" : have(process.env.OPENAI_API_KEY)) + "   EBAY_CLIENT_ID: " + (protectedVars.includes("EBAY_CLIENT_ID") ? "ENCRYPTED (unreadable here)" : have(process.env.EBAY_CLIENT_ID)) + "   EBAY_CLIENT_SECRET: " + (protectedVars.includes("EBAY_CLIENT_SECRET") ? "ENCRYPTED (unreadable here)" : have(process.env.EBAY_CLIENT_SECRET)) + "   (values are never printed)");

(async () => {
  const r = await runApiSelfTest({ callOpenAI: callOpenAI as any, model: OPENAI_MODEL, hasOpenAIAccess, openAIRoute: () => (process.env.OPENAI_API_KEY?.trim() ? "own_key" : "none"), hasEbayCredentials, searchEbayItems, fetch });
  let bad = 0;
  const o = r.openai;
  console.log("\\nOPENAI   " + (o.ok ? "OK" : "FAILED") + "  route=" + o.route + " model=" + o.model + " http=" + (o.status ?? "-") + " " + (o.ms ?? "-") + "ms" + (o.tokens ? "  tokens in/out/total=" + o.tokens.input + "/" + o.tokens.output + "/" + o.tokens.total : "") + (o.error ? "\\n         " + o.error : "") + (o.skipped ? "\\n         not run: " + o.skipped : ""));
  if (!o.ok && !(protectedVars.includes("OPENAI_API_KEY") && o.skipped)) bad++;
  if (protectedVars.includes("OPENAI_API_KEY")) console.log("         (not run: the key is stored encrypted and this command cannot read it)");
  const e = r.ebay;
  console.log("EBAY     " + (e.ok ? "OK" : e.skipped ? "NOT CHECKED" : "FAILED") + (e.ok ? "  query='" + e.query + "' retrieved=" + e.retrieved + " accepted=" + e.accepted + " rejected=" + e.rejected + " unsure=" + e.uncertain + " median ASKING price=" + (e.medianAskUsd === null ? "n/a" : "$" + Math.round(e.medianAskUsd)) + " (asking prices, NOT sold prices) " + e.ms + "ms" : "\\n         " + (e.skipped ?? e.error)));
  if (!e.ok && !(e.skipped && (protectedVars.includes("EBAY_CLIENT_ID") || protectedVars.includes("EBAY_CLIENT_SECRET")))) bad++;
  const w = r.watchcount;
  console.log("WATCHCOUNT " + (w.ok ? "reachable" : "NOT REACHABLE") + " http=" + (w.status ?? "-") + (w.error ? "  " + w.error : "") + "\\n         " + w.note);
  if (!w.ok) bad++;
  const snap = apiActivity.snapshot();
  console.log("\\nRecorded by Clynx's own API tracker during this check: openai live=" + snap.providers.openai.attempted + " (tokens " + snap.providers.openai.tokens.total + "), ebay live=" + snap.providers.ebay.attempted + " (results " + snap.providers.ebay.results.retrieved + ")");
  if (bad) { console.log("\\n" + bad + " dependency check(s) did not pass. Nothing was hidden: see the lines above."); process.exit(1); }
  console.log("\\nAll checked dependencies passed.");
})().catch((err) => { console.error("The diagnostic itself failed: " + (err && err.message ? err.message : err)); process.exit(1); });
`
);
buildSync({ entryPoints: [entry], nodePaths: [path.join(root, "node_modules")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"] });
const modules = path.join(root, "node_modules");
const r = require("node:child_process").spawnSync(process.execPath, ["--no-warnings", out, ...process.argv.slice(2)], { stdio: "inherit", cwd: root, env: { ...process.env, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) } });
process.exit(r.status ?? 1);
