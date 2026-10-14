// Runs the Database discovery benchmark (src/main/__tests__/_discoveryBench.ts) against a checkout and prints the numbers.
//
//   node scripts/discovery-bench.cjs                      this checkout
//   node scripts/discovery-bench.cjs --root <dir>         another checkout (e.g. a git worktree of an older commit that has
//                                                         src/main/__tests__/_discoveryBench.ts copied into it)
//   node scripts/discovery-bench.cjs --out result.json    also write the raw result
//   node scripts/discovery-bench.cjs --lowai off          run with "Save OpenAI credits" off (default: on, like a fresh install)
//   node scripts/discovery-bench.cjs --cases              print every listing's outcome
//
// Everything is simulated (scripted AI, virtual clock, fake Database): no network, no browser, no user data.
const { buildSync } = require("esbuild");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const here = path.resolve(__dirname, "..");
const root = path.resolve(opt("root", here));
const out = opt("out", "");
const lowAi = opt("lowai", "on") !== "off";
const benchDir = path.join(root, "src", "main", "__tests__");

const entry = `
import { runBench, score } from "./_discoveryBench.js";
const lowAiMode = ${lowAi ? "true" : "false"};
const showCases = ${flag("cases") ? "true" : "false"};
(async () => {
  const r = await runBench({ lowAiMode });
  const s = score(r);
  const f1 = (n: number) => n.toFixed(1);
  console.log("lowAiMode:", lowAiMode);
  console.log("recall of profitable listings: " + s.surfacedProfitable + "/" + s.profitable + " = " + (s.recall * 100).toFixed(0) + "%  (opened " + s.openedProfitable + ", photo-researched or surfaced " + s.researchedProfitable + ")");
  console.log("identified correctly (Database filing / match): " + s.identifiedCorrectly + "/" + s.identifiable);
  console.log("false deals (bad / mislabelled listing surfaced): " + s.falseDeals + (s.falseDealDetail.length ? "  -> " + s.falseDealDetail.join(" | ") : ""));
  console.log("wrong-product filings: " + s.wrongProductFilings + ", badly named filings: " + s.badNameFilings + (s.filingDetail.length ? "\\n    " + s.filingDetail.join("\\n    ") : ""));
  console.log("listings with no verdict about why (not surfaced, not junk): " + s.insufficientButUnlabelled);
  console.log("research jobs: " + r.jobs.length + "  (" + f1(s.jobsPerHour) + "/hour)  seen->researched avg " + f1(s.avgListingToResearchedS) + "s  p95 " + f1(s.p95ListingToResearchedS) + "s  queue wait avg " + f1(s.avgQueueWaitS) + "s max " + f1(s.maxQueueWaitS) + "s");
  console.log("time between finished research jobs: avg " + f1(s.avgGapBetweenJobsS) + "s  max " + f1(s.maxGapBetweenJobsS) + "s");
  console.log("run: scan " + f1(s.scanMin) + " min, queue drain +" + f1(s.drainMin) + " min = " + f1(s.totalMin) + " min (virtual)");
  console.log("AI calls: judge " + r.ai.judge + ", vision " + r.ai.vision + ", identity " + r.ai.identity + ", market checks " + r.ai.market + "  est. $" + s.spendUsd.toFixed(3) + "  max in flight " + r.ai.maxInFlight);
  if (showCases) {
    for (const o of r.outcomes) console.log("  " + o.id.padEnd(4) + o.role.padEnd(10) + (o.opened ? "opened " : "skipped") + " vision×" + o.visionCalls + " " + (o.surfaced ? "SURFACED " : "         ") + String(o.status ?? "-").padEnd(14) + String(o.researchStatus ?? "").padEnd(24) + String(o.researchCode ?? "").padEnd(26) + o.title.slice(0, 40) + " $" + o.price + " -> [" + o.identified.join("; ") + "]");
  }
  const outFile = ${JSON.stringify(out)};
  if (outFile) require("node:fs").writeFileSync(outFile, JSON.stringify({ result: r, score: s }, null, 1));
})().catch((e) => { console.error("BENCH FAILED", e && e.stack || e); process.exit(1); });
`;

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-bench-"));
const outfile = path.join(outDir, "bench.cjs");
buildSync({
  stdin: { contents: entry, resolveDir: benchDir, sourcefile: "bench-entry.ts", loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "error",
  external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"],
});
const run = spawnSync(process.execPath, [outfile], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, OPENAI_API_KEY: "test-key", NODE_PATH: [path.join(root, "node_modules"), path.join(here, "node_modules")].join(path.delimiter) },
});
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(run.status ?? 1);
