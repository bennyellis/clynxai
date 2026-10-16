// Runs scripts/visual/visual-eval.ts (bundled with esbuild, like the test runner). See that file for what it does and what it needs.
const { buildSync } = require("esbuild");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
try { require("dotenv").config({ path: path.join(root, ".env") }); } catch { /* optional */ }
const out = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-visual-"));
const outfile = path.join(out, "visual-eval.cjs");
buildSync({ entryPoints: [path.join(root, "scripts", "visual", "visual-eval.ts")], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "error", external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"] });
const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env: { ...process.env, NODE_PATH: path.join(root, "node_modules") } });
fs.rmSync(out, { recursive: true, force: true });
process.exit(run.status ?? 1);
