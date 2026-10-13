// Bundles the shadow runner (node audit/phase4_shadow/build.cjs), then run: node audit/phase4_shadow/run.cjs <copy-of-scout.db> <output-folder>
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
esbuild.buildSync({ entryPoints: [path.join(__dirname, "run.ts")], bundle: true, platform: "node", format: "cjs", outfile: path.join(__dirname, "run.cjs"), logLevel: "error", external: ["playwright", "playwright-extra", "sharp", "electron"] });
