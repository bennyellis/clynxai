// Beta 13 audit — runs the diagnostic probes in scripts/beta13-audit/ against this checkout (read-only; prints observations, changes nothing).
//   node scripts/beta13-audit.cjs [probe-name] [probe arguments]      e.g.  identity-probe  |  library-db-audit "C:\path\scout.db"  |  library-db-audit --selftest
const { buildSync } = require("esbuild");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const dir = path.join(root, "scripts", "beta13-audit");
const want = process.argv[2];
const passThrough = process.argv.slice(3);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && (!want || f.includes(want))).sort();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-b13-"));
for (const f of files) {
  console.log(`\n##### ${f}`);
  const outfile = path.join(out, f.replace(/\.ts$/, ".cjs"));
  buildSync({ entryPoints: [path.join(dir, f)], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "error", external: ["node:sqlite", "sharp", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "electron"] });
  spawnSync(process.execPath, [outfile, ...passThrough], { cwd: root, stdio: "inherit", env: { ...process.env, OPENAI_API_KEY: "audit-no-network", NODE_PATH: path.join(root, "node_modules") } });
}
fs.rmSync(out, { recursive: true, force: true });
