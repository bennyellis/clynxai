// Writes resources/build-info.json (packaged into the app) so the running app can say exactly which build it is.
//   node scripts/build-info.cjs <channel>      channel: "beta" (local beta mode offered) or "production" (default "dev")
// The channel decides whether the "use Clynx on this computer only" beta mode is offered; only beta builds contain it.
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const channel = process.argv[2] || "dev";
if (!["dev", "beta", "production"].includes(channel)) {
  console.error('channel must be "dev", "beta" or "production"');
  process.exit(2);
}
const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const info = {
  product: "clynx",
  version: pkg.version,
  channel,
  commit: git("rev-parse --short=12 HEAD") || "unknown",
  dirty: git("status --porcelain --untracked-files=no").length > 0, // untracked notes/reports never ship, so they must not mark a build "dirty"
  builtAt: new Date().toISOString(),
};
// Optional: start this build at one server (the sign-in form is still editable). Without it a distributed build has NO default server and asks for one.
if (process.env.CLYNX_DEFAULT_SERVER) info.defaultServerUrl = process.env.CLYNX_DEFAULT_SERVER;
fs.mkdirSync(path.join(root, "resources"), { recursive: true });
fs.writeFileSync(path.join(root, "resources", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
console.log("build-info:", JSON.stringify(info));
