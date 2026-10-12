// Runs every src/main/__tests__/*.test.ts as a standalone script: each file is bundled with esbuild (already installed as
// a dependency of vite) and executed with Node. A test file passes when its process exits with code 0.
//
//   npm test                 run everything
//   npm test -- listingAge   run only the files whose name contains "listingAge"
//
// No test framework: tests use the tiny helper in src/main/__tests__/_testkit.ts (check / finish).
const { buildSync } = require("esbuild");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "src", "main", "__tests__");
const filter = process.argv[2] ? process.argv[2].toLowerCase() : "";
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts") && f.toLowerCase().includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`No test files match "${filter}".`);
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-tests-"));
const results = [];
for (const file of files) {
  const outfile = path.join(outDir, file.replace(/\.ts$/, ".cjs"));
  console.log(`\n=== ${file} ===`);
  try {
    buildSync({
      entryPoints: [path.join(dir, file)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "error",
      external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"],
    });
  } catch {
    results.push({ file, ok: false, why: "build failed" });
    continue;
  }
  const run = spawnSync(process.execPath, [outfile], { cwd: root, stdio: "inherit", env: { ...process.env, OPENAI_API_KEY: "test-key", NODE_PATH: path.join(root, "node_modules") } });
  results.push({ file, ok: run.status === 0, why: run.status === 0 ? "" : `exit ${run.status}` });
}

console.log("\n=== summary ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.file}${r.why ? `  (${r.why})` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nAll ${results.length} test files passed.` : `\n${failed} of ${results.length} test files FAILED.`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
