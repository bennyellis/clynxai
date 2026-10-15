// Runs the REAL variant verification against the live web and prints exactly what happened: every search (backend, outcome, results), every page read (status,
// text length, plain or browser), how each source was classified, the verdict and the official name found. Nothing is saved anywhere and no AI credits are used.
//
//   node scripts/variant-live-check.cjs                      the two Xbox claims from the field report
//   node scripts/variant-live-check.cjs "Some Product Edition" [--url https://...]
const { buildSync } = require("esbuild");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clynx-live-")), "live.cjs");
const entry = path.join(os.tmpdir(), `clynx-live-entry-${process.pid}.ts`);
fs.writeFileSync(
  entry,
  `
import { chromium } from "playwright";
import { createEvidenceDeps, describeTrace, extractEvidenceText } from ${JSON.stringify(path.join(root, "src/main/webEvidence.ts"))};
import { verifyVariant } from ${JSON.stringify(path.join(root, "src/main/variantEvidence.ts"))};

async function render(url: string): Promise<string | null> {
  let browser;
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}] as any[]) {
    try { browser = await chromium.launch({ headless: true, ...opts }); break; } catch { /* try the next */ }
  }
  if (!browser) return null;
  try {
    const page = await (await browser.newContext({ locale: "en-US" })).newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
    return extractEvidenceText(await page.content()) + "\\n" + (await page.evaluate(() => document.body?.innerText ?? ""));
  } catch { return null; } finally { await browser.close().catch(() => undefined); }
}

const args = process.argv.slice(2);
const urls: string[] = [];
const claims: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i] === "--url") urls.push(args[++i]); else claims.push(args[i]); }
if (!claims.length) claims.push("Xbox Series X 2TB Galaxy Black Special Edition", "Xbox Series X Halo Infinite Edition", "Xbox Series X Galaxy");

(async () => {
  for (const claim of claims) {
    console.log("\\n==================================================================\\nCLAIM: " + claim);
    const deps = createEvidenceDeps({ render });
    const v = await verifyVariant(claim, deps, { brandHints: ["Microsoft"], userUrls: urls, maxSteps: 8 });
    console.log("\\n-- trace --\\n" + describeTrace(deps.trace()));
    console.log("\\n-- sources --");
    for (const s of v.sources) console.log("  " + s.sourceClass.padEnd(12) + " full=" + String(s.fullMatch).padEnd(5) + " scattered=" + String(!!s.scattered).padEnd(5) + " " + s.url + (s.officialName ? "  => " + s.officialName : ""));
    console.log("\\nVERDICT: " + v.status.toUpperCase() + (v.searchUnavailable ? " (search blocked/unavailable)" : "") + "\\n  " + v.basis + (v.officialName ? "\\n  official name: " + v.officialName : ""));
  }
})();
`
);
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "error",
  external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"],
});
// The bundle sits in the temp folder, so it is told where the project's own modules (playwright) are.
const modules = path.join(root, "node_modules");
require("node:child_process").spawnSync(process.execPath, [out, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
});
