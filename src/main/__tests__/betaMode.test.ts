// Windows beta: build identity, the local beta mode gate, and browser discovery (an installed copy has no Chromium of its own).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBuildInfo } from "../buildInfo.js";
import { candidatePaths, checkBrowsers } from "../browserCheck.js";
import { check, run, section } from "./_testkit.js";

run(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-beta-"));
  const writeInfo = (dir: string, info: unknown) => {
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "resources", "build-info.json"), JSON.stringify(info));
  };

  section("build info and the local-mode gate");
  {
    const none = readBuildInfo(path.join(root, "nothing"), "1.2.3");
    check("no build-info file means a development run: no local mode", none.channel === "dev" && none.localModeAllowed === false && none.version === "1.2.3");
    writeInfo(path.join(root, "beta"), { version: "0.3.0-beta.1", channel: "beta", commit: "abc123def456", dirty: false, builtAt: "2026-10-14T00:00:00Z" });
    const beta = readBuildInfo(path.join(root, "beta"), "x");
    check("a beta build offers local mode and reports its version and commit", beta.localModeAllowed === true && beta.version === "0.3.0-beta.1" && beta.commit === "abc123def456");
    writeInfo(path.join(root, "prod"), { version: "1.0.0", channel: "production", commit: "z" });
    check("a production build never offers local mode", readBuildInfo(path.join(root, "prod"), "x").localModeAllowed === false);
    writeInfo(path.join(root, "odd"), { version: "1.0.0", channel: "BETA; drop table", commit: 5 });
    const odd = readBuildInfo(path.join(root, "odd"), "9.9.9");
    check("an unrecognised channel value counts as development, not beta", odd.channel === "dev" && odd.localModeAllowed === false && odd.commit === "unknown");
    fs.mkdirSync(path.join(root, "bad", "resources"), { recursive: true });
    fs.writeFileSync(path.join(root, "bad", "resources", "build-info.json"), "{ not json");
    check("a damaged file is a development run, not a crash", readBuildInfo(path.join(root, "bad"), "1.0.0").channel === "dev");
  }

  section("the source: local mode cannot be switched on by a non-beta build");
  {
    const main = fs.readFileSync(path.resolve("src/main/index.ts"), "utf-8");
    check("isLocalMode requires both the saved choice and a beta build", /isLocalMode = \(\): boolean => appSettings\.localMode === true && buildInfo\.localModeAllowed/.test(main));
    check("auth:startLocal refuses unless the build allows it", /"auth:startLocal"[\s\S]{0,200}if \(!buildInfo\.localModeAllowed\) return \{ ok: false/.test(main));
    check("local mode starts no cloud health check, heartbeat or sync", /if \(!localOnly\) \{[\s\S]{0,700}watchSyncService\.start\(\)[\s\S]{0,200}productSyncService\.start\(\)/.test(main));
    const info = fs.readFileSync(path.resolve("scripts/build-info.cjs"), "utf-8");
    check("only the beta build script writes the beta channel", /\["dev", "beta", "production"\]/.test(info));
  }

  section("finding Chrome or Edge");
  {
    const B = String.fromCharCode(92); // a backslash, so the Windows-style test paths below are unambiguous
    const w = (...parts: string[]) => parts.join(B);
    const win = { ProgramFiles: w("C:", "Program Files"), "ProgramFiles(x86)": w("C:", "Program Files (x86)"), LOCALAPPDATA: w("C:", "Users", "t", "AppData", "Local") };
    const chrome = w("C:", "Program Files", "Google", "Chrome", "Application", "chrome.exe");
    const edge = w("C:", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
    const both = checkBrowsers("win32", win, (p) => p === chrome || p === edge);
    check("Chrome is preferred when both are installed", both.preferred?.kind === "chrome" && both.preferred.channel === "chrome" && both.found.length === 2 && both.instructions === "", both);
    const onlyEdge = checkBrowsers("win32", win, (p) => p === edge);
    check("Edge (built into Windows 10/11) is used when Chrome is missing", onlyEdge.preferred?.kind === "edge" && onlyEdge.preferred.channel === "msedge", onlyEdge);
    const perUser = checkBrowsers("win32", win, (p) => p === w("C:", "Users", "t", "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"));
    check("a per-user Chrome install is found", perUser.preferred?.kind === "chrome", perUser);
    const none = checkBrowsers("win32", win, () => false);
    check("with neither installed the instructions say what to install", none.preferred === null && /Install Google Chrome/.test(none.instructions) && /Edge/.test(none.instructions), none.instructions);
    check("an empty environment does not crash", checkBrowsers("win32", {}, () => false).preferred === null);
    check("macOS and Linux paths exist too", candidatePaths("darwin", {}).length >= 2 && candidatePaths("linux", {}).length >= 2);
  }

  fs.rmSync(root, { recursive: true, force: true });
});
