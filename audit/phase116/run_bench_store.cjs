const { buildSync } = require("esbuild");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const root = path.resolve(__dirname, "..", "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clynx-bench-b-")), "bench.cjs");
buildSync({ entryPoints: [path.join(__dirname, "bench_store.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"] });
const r = spawnSync(process.execPath, ["--no-warnings", out], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, OPENAI_API_KEY: "test-key", NODE_PATH: path.join(root, "node_modules") } });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
