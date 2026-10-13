// Phase 7: the rules that keep the renderer window locked to the app's own pages.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { externalLinkTarget, isAppUrl, isTrustedIpcSender, REQUIRED_CSP_DIRECTIVES, ALLOWED_PERMISSIONS } from "../windowSecurity.js";
import { check, run, section } from "./_testkit.js";

const rendererDir = path.resolve("out", "renderer");
const packaged = { devUrl: null, rendererDir };
const dev = { devUrl: "http://localhost:5173", rendererDir };
const fileUrl = (...p: string[]) => pathToFileURL(path.join(rendererDir, ...p)).toString();

run(() => {
  section("which pages count as the app");
  check("the bundled index.html is the app", isAppUrl(fileUrl("index.html"), packaged));
  check("an asset inside the renderer folder is the app", isAppUrl(fileUrl("assets", "x.js"), packaged));
  check("a file outside the renderer folder is NOT the app", !isAppUrl(pathToFileURL(path.join(rendererDir, "..", "main", "index.js")).toString(), packaged));
  check("a sibling folder with the same prefix is NOT the app", !isAppUrl(pathToFileURL(rendererDir + "-evil/index.html").toString(), packaged));
  check("the renderer folder itself is not a page", !isAppUrl(pathToFileURL(rendererDir).toString(), packaged));
  check("a web page is NOT the app", !isAppUrl("https://example.com/", packaged) && !isAppUrl("https://example.com/", dev));
  check("the dev server origin is the app only in development", isAppUrl("http://localhost:5173/index.html", dev) && !isAppUrl("http://localhost:5173/index.html", packaged));
  check("another port on localhost is not the dev server", !isAppUrl("http://localhost:9999/", dev));
  check("garbage is not the app", !isAppUrl("not a url", packaged) && !isAppUrl("", packaged));

  section("links opened in the system browser");
  check("https and http links open", externalLinkTarget("https://www.facebook.com/marketplace/item/1") !== null && externalLinkTarget("http://example.com/") !== null);
  check("file:, javascript:, data: and custom protocols never open", ["file:///C:/Windows/notepad.exe", "javascript:alert(1)", "data:text/html,<script>1</script>", "ms-settings:privacy", "vscode://x"].every((u) => externalLinkTarget(u) === null));
  check("credentials in a link are refused", externalLinkTarget("https://a:b@example.com/") === null);
  check("garbage is refused", externalLinkTarget("::::") === null);

  section("IPC senders");
  check("the app's own top-level page is trusted", isTrustedIpcSender({ url: fileUrl("index.html") }, packaged));
  check("a sub-frame is not trusted, even with an app URL", !isTrustedIpcSender({ url: fileUrl("index.html"), parent: {} }, packaged));
  check("a foreign page is not trusted", !isTrustedIpcSender({ url: "https://evil.example/" }, packaged));
  check("a missing frame is not trusted", !isTrustedIpcSender(null, packaged) && !isTrustedIpcSender(undefined, packaged));

  section("static configuration");
  const html = fs.readFileSync(path.resolve("src", "renderer", "index.html"), "utf-8");
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
  check("the page carries the required CSP directives", REQUIRED_CSP_DIRECTIVES.every((d) => csp.includes(d)), csp);
  check("the CSP allows no inline or eval scripts", !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp));
  check("no browser permission is ever granted", ALLOWED_PERMISSIONS.length === 0);
  const main = fs.readFileSync(path.resolve("src", "main", "index.ts"), "utf-8");
  const prefs = /webPreferences:\s*\{([\s\S]*?)\n\s{4}\},/.exec(main)?.[1] ?? "";
  check("the window runs sandboxed with context isolation and no node integration", /contextIsolation:\s*true/.test(prefs) && /nodeIntegration:\s*false/.test(prefs) && /sandbox:\s*true/.test(prefs) && /webviewTag:\s*false/.test(prefs), prefs);
  check("every IPC handler goes through the sender check", /ipcMain\.handle = /.test(main) && /ipcMain\.on = /.test(main));
});
