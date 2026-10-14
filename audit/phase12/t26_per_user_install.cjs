// T26 (Beta 6): the REAL installers, per-user, with no Windows permission prompt.
//   1. Beta 5 installs (the old installer, which offered "all users"), per-user, into a throw-away folder.
//   2. Beta 6's installer is started exactly as the app's updater starts it (`/S --updated`, no /currentuser, no /D) and must upgrade that install in place, silently.
//   3. A brand-new Beta 6 install with NO switches at all (what a person gets by double-clicking and choosing nothing, simulated silently) must land in the CURRENT USER's area, not Program Files.
// Safety: refuses to run while ANY all-users ("HKLM") Clynx registration exists, because an installer would then show a Windows permission prompt on the screen (and test nothing). Everything is
// installed into %TEMP% and removed at the end; the user's data folders are never touched; an installer that has not finished in 120 s is killed (a permission prompt would show up as that).
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = "C:/Users/biggt/OneDrive/Documents/Claude/Sessions/fb-marketplace-scout";
const B5 = path.join(ROOT, "beta-release", "Clynx-Beta-Setup-0.3.0-beta.5.exe");
const B6 = path.join(ROOT, "beta-release", "Clynx-Beta-Setup-0.3.0-beta.6.exe");
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : "   " + JSON.stringify(detail)}`); };
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const entries = (hive) => ps(`Get-ChildItem '${hive}:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -like '*Clynx*') { $_.PSChildName + '|' + $p.DisplayVersion + '|' + $p.InstallLocation } }`);
function run(exe, args, ms = 120000) {
  const t0 = Date.now();
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: ms, windowsHide: true });
  return { ms: Date.now() - t0, status: r.status, timedOut: r.error?.code === "ETIMEDOUT" };
}
// only Clynx programs that THIS test installed (in its throw-away folder or the per-user Programs folder), never anything else that is running
function stopTestCopies() {
  ps(`Get-CimInstance Win32_Process -Filter "Name='Clynx.exe'" | Where-Object { $_.ExecutablePath -like '*clynx-t26*' -or $_.ExecutablePath -like '$env:LOCALAPPDATA\Programs\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}
(async () => {
  const hklm = entries("HKLM");
  if (hklm) { console.error("REFUSING TO RUN: an all-users Clynx registration exists (" + hklm + "). Uninstall it in Settings > Apps first; an installer would otherwise show a Windows permission prompt."); process.exit(3); }
  if (entries("HKCU")) { console.error("REFUSING TO RUN: a per-user Clynx install is registered (" + entries("HKCU") + "). This test uses the same registration; uninstall it first."); process.exit(3); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clynx-t26-"));
  const d1 = path.join(dir, "inst");
  try {
    // 1. Beta 5, per user, into the temp folder
    const a = run(B5, ["/S", "/currentuser", `/D=${d1}`]);
    check("[1] Beta 5 installs per-user into a throw-away folder", a.status === 0 && fs.existsSync(path.join(d1, "Clynx.exe")), a);
    const reg1 = entries("HKCU");
    check("[1] it registered itself for the current user (HKCU), version 0.3.0-beta.5, and not for all users", /0\.3\.0-beta\.5/.test(reg1) && !entries("HKLM"), { reg1, hklm: entries("HKLM") });
    // a data file next to the program stands in for the user's data (the real data lives elsewhere and is never touched by an installer)
    const marker = path.join(os.tmpdir(), `clynx-t26-userdata-${process.pid}.txt`);
    fs.writeFileSync(marker, "my data");

    // 2. the update: exactly what the app runs
    const b = run(B6, ["/S", "--updated"]);
    await new Promise((r) => setTimeout(r, 3000));
    stopTestCopies(); // (an update reopens Clynx; close the test copy)
    check("[2] Beta 6 started the way the updater starts it finishes by itself within 120 s (no permission prompt waiting)", b.status === 0 && !b.timedOut, b);
    const reg2 = entries("HKCU");
    check("[2] the same per-user install is now version 0.3.0-beta.6, still at the same place, still not all-users", /0\.3\.0-beta\.6/.test(reg2) && !/0\.3\.0-beta\.5/.test(reg2) && !entries("HKLM"), { reg2, hklm: entries("HKLM") });
    check("[2] the program files were replaced in place (the new version string is in the installed program)", fs.existsSync(path.join(d1, "resources", "app.asar")) && fs.statSync(path.join(d1, "resources", "app.asar")).mtimeMs > Date.now() - 5 * 60_000);
    check("[2] nothing of the user's data was touched", fs.readFileSync(marker, "utf8") === "my data");
    const uninst = path.join(d1, "Uninstall Clynx.exe");
    const u = run(uninst, ["/S", "/currentuser"], 90000);
    check("[2] it uninstalls silently as well", !u.timedOut, u);
    await new Promise((r) => setTimeout(r, 4000));
    check("[2] after uninstalling no Clynx registration is left", !entries("HKCU") && !entries("HKLM"), { hkcu: entries("HKCU") });

    // 3. a brand-new install with no switches at all
    const c = run(B6, ["/S"]);
    await new Promise((r) => setTimeout(r, 3000));
    stopTestCopies();
    const reg3 = entries("HKCU");
    const loc3 = (reg3.split("|")[2] || "").trim();
    const defaultDir = path.join(process.env.LOCALAPPDATA || "", "Programs");
    check("[3] a new install with NO switches finishes by itself (no all-users question, no permission prompt)", c.status === 0 && !c.timedOut, c);
    check("[3] it was installed for the current user: a per-user registration exists, and no all-users one", /0\.3\.0-beta\.6/.test(reg3) && !entries("HKLM"), { reg3, hklm: entries("HKLM") });
    check("[3] ...in the user's own area, not Program Files", !!loc3 ? loc3.toLowerCase().startsWith(defaultDir.toLowerCase()) : fs.readdirSync(defaultDir).some((n) => /clynx|marketplace/i.test(n)), { loc3, defaultDir });
    const prog = fs.existsSync(defaultDir) ? fs.readdirSync(defaultDir).filter((n) => /clynx|marketplace/i.test(n)) : [];
    for (const n of prog) {
      const un = path.join(defaultDir, n, "Uninstall Clynx.exe");
      if (fs.existsSync(un)) run(un, ["/S", "/currentuser"], 90000);
    }
    await new Promise((r) => setTimeout(r, 4000));
    check("[3] cleaned up: no Clynx registration left", !entries("HKCU") && !entries("HKLM"), { hkcu: entries("HKCU") });
    fs.rmSync(marker, { force: true });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    stopTestCopies();
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
