// Bundles one of the read-only shadow tools:  node audit/phase4_shadow/build.cjs [run|doubt_rule_check|protection_check]
// then run the .cjs it writes next to itself (see each tool's header for its arguments). The generated .cjs files are not kept in git.
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const target = process.argv[2] || "run";
esbuild.buildSync({ entryPoints: [path.join(__dirname, `${target}.ts`)], bundle: true, platform: "node", format: "cjs", outfile: path.join(__dirname, `${target}.cjs`), logLevel: "error", external: ["electron", "playwright", "playwright-extra", "sharp"] });
