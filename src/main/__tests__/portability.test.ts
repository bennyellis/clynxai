// Phase 8: guards that keep the app platform-independent (Windows today, macOS and Linux possible). It cannot prove a Mac build works - that needs a Mac - but it stops
// Windows-only habits from creeping into the source, and checks the one piece of macOS-specific behaviour the app has (the menu bar).
import fs from "node:fs";
import path from "node:path";
import { applicationMenuTemplate } from "../appMenu.js";
import { check, run, section } from "./_testkit.js";

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

const BACKSLASH = String.fromCharCode(92);
const driveLetter = new RegExp(`["'\`][A-Za-z]:${BACKSLASH}${BACKSLASH}`);
const windowsTools = /powershell|cmd\.exe|\bwmic\b|taskkill|tasklist/i;
const backslashInJoin = new RegExp(`path\\.join\\([^)]*["'\`][^"'\`]*${BACKSLASH}${BACKSLASH}[^"'\`]*["'\`]`);

run(() => {
  section("menu");
  {
    check("Windows and Linux have no menu bar", applicationMenuTemplate("win32", "Clynx") === null && applicationMenuTemplate("linux", "Clynx") === null);
    const mac = applicationMenuTemplate("darwin", "Clynx") ?? [];
    const roles = mac.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu.map((i) => (i as { role?: string }).role) : []));
    check("macOS gets an app menu with Quit and an Edit menu with the standard text shortcuts", ["quit", "undo", "redo", "cut", "copy", "paste", "selectAll"].every((r) => roles.includes(r as never)), roles);
  }

  section("source has no Windows-only habits");
  {
    const files = [...walk(path.resolve("src/main")), ...walk(path.resolve("src/preload")), ...walk(path.resolve("src/renderer/src"))];
    const offenders: string[] = [];
    for (const f of files) {
      if (path.basename(f) === "installerLauncher.ts") continue; // the one deliberate Windows-only file: the silent-installer hand-off (unit-tested in updater.test.ts)
      const lines = fs.readFileSync(f, "utf-8").split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        const where = `${path.relative(process.cwd(), f)}:${i + 1}`;
        if (driveLetter.test(code) || windowsTools.test(code)) offenders.push(where);
        if (backslashInJoin.test(code)) offenders.push(`${where} (backslash in a joined path)`);
      });
    }
    check("no drive letters, PowerShell/cmd calls or backslash path pieces in app code", offenders.length === 0, offenders.slice(0, 10));
    const main = fs.readFileSync(path.resolve("src/main/index.ts"), "utf-8");
    check("the app quits when its window closes on every platform (no half-alive macOS state)", !/process\.platform\s*!==\s*["']darwin["']\)\s*app\.quit/.test(main));
    const spawnsLiteral = (src: string) => /spawn\(\s*["'`]/.test(src);
    check("child processes are spawned from process.execPath, not a hard-coded program", !spawnsLiteral(main) && !spawnsLiteral(fs.readFileSync(path.resolve("src/main/dbIntegrity.ts"), "utf-8")));
  }

  section("packaging config");
  {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8"));
    check("the installer packs only built output, never source, cloud, data or reports", Array.isArray(pkg.build.files) && pkg.build.files.includes("out/**") && !pkg.build.files.includes("**/*") && !pkg.build.files.includes("src/**"), pkg.build.files);
    check("electron-builder can never publish by itself", pkg.build.publish === null);
    check("there is a build script per platform", !!pkg.scripts["dist:win"] && !!pkg.scripts["dist:mac"]);
    check("macOS targets are configured with hardened runtime", pkg.build.mac?.hardenedRuntime === true && Array.isArray(pkg.build.mac?.target));
  }
});
