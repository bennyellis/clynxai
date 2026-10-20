// Runs the sold-comps command-line harness (src/main/soldComps/cli.ts) against a CSV, with no network and no real Database:
//   node scripts/sold-comps-harness.cjs --product "Xbox Series X Galaxy Black Special Edition" --csv src/main/__tests__/fixtures/soldComps/galaxy-black-synthetic.csv
const { buildSync } = require("esbuild");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-soldcomps-"));
const outfile = path.join(outDir, "cli.cjs");
buildSync({
  entryPoints: [path.join(root, "src", "main", "soldComps", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "error",
  external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"],
});
const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env: { ...process.env, NODE_PATH: path.join(root, "node_modules") } });
fs.rmSync(outDir, { recursive: true, force: true });
process.exit(run.status ?? 1);
