// Bundles one of the read-only audit scripts so it can be run with node (it imports the app's real matching code, and changes nothing).
//   node audit/phase4_repro/build.cjs repro1   then   node audit/phase4_repro/repro1.cjs
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const f = path.join(__dirname, process.argv[2]);
esbuild.buildSync({ entryPoints: [f + ".ts"], bundle: true, platform: "node", format: "cjs", outfile: f + ".cjs", logLevel: "error", external: ["playwright", "playwright-extra", "sharp", "electron"] });
