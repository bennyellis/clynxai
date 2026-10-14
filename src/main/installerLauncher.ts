// Hands a downloaded, VERIFIED installer to the operating system and reopens Clynx afterwards. This is the one place that is allowed to be Windows-specific (it is the only platform with a
// silent installer today); src/main/__tests__/portability.test.ts exempts exactly this file. Pure command building, so it is unit-tested without running anything.
//
// Windows: `cmd /c "start /wait "" "<installer>" /S --updated & ping ... & start "" "<Clynx.exe>" "--user-data-dir=<data folder>""`
//   * "start /wait" is needed: cmd does not wait for a program with a window (the installer) when it is simply named, so Clynx would be started before the files were replaced.
//   * Clynx is started again whatever the installer's result: a failed install reopens the version that was there, and the next start records "the update did not finish".
//   * The data folder is passed explicitly so the reopened app uses exactly the data the closing one did.
export interface LaunchPlan {
  command: string;
  args: string[];
  options: { detached: true; stdio: "ignore"; windowsHide?: true; windowsVerbatimArguments?: true };
}

export function planInstallerLaunch(platform: string, installerPath: string, installerArgs: string[], appExecutable: string, userDataDir: string): LaunchPlan {
  if (platform === "win32") {
    const inner = `start /wait "" "${installerPath}" ${installerArgs.join(" ")} & ping -n 4 127.0.0.1 >nul & start "" "${appExecutable}" "--user-data-dir=${userDataDir}"`;
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${inner}"`], options: { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true } };
  }
  return { command: installerPath, args: installerArgs, options: { detached: true, stdio: "ignore" } };
}

/** Paths that would break the command line (a quote or a line break) are refused instead of quoted wrongly. */
export function isSafeForCommandLine(...parts: string[]): boolean {
  return parts.every((p) => typeof p === "string" && p.length > 0 && !/["\r\n\0%^&|<>]/.test(p));
}
