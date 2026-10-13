// Which browser can Clynx drive on this computer? Scanning needs a real Chromium-based browser. Google Chrome is preferred; Microsoft Edge (installed with Windows 10/11)
// works the same way and is the fallback. Playwright's own downloaded Chromium exists only on developer machines and is never relied on by an installed app.
import { existsSync } from "node:fs";
import path from "node:path";

export type BrowserKind = "chrome" | "edge";
export interface FoundBrowser {
  kind: BrowserKind;
  /** The name Playwright's `channel` option uses. */
  channel: "chrome" | "msedge";
  label: string;
  path: string;
}
export interface BrowserCheck {
  found: FoundBrowser[];
  /** What the scanner will use (Chrome if present, else Edge); null when neither is installed. */
  preferred: FoundBrowser | null;
  /** Plain-words next step; empty when a browser was found. */
  instructions: string;
}

export const CHROME_DOWNLOAD_URL = "https://www.google.com/chrome/";

export function candidatePaths(platform: string, env: Record<string, string | undefined>): Array<{ kind: BrowserKind; path: string }> {
  const out: Array<{ kind: BrowserKind; path: string }> = [];
  if (platform === "win32") {
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["ProgramW6432"], env["LOCALAPPDATA"]].filter((r): r is string => !!r);
    for (const r of roots) out.push({ kind: "chrome", path: path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe") });
    for (const r of roots) out.push({ kind: "edge", path: path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe") });
  } else if (platform === "darwin") {
    out.push({ kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    out.push({ kind: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" });
  } else {
    for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]) out.push({ kind: "chrome", path: p });
    for (const p of ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"]) out.push({ kind: "edge", path: p });
  }
  return out;
}

export function checkBrowsers(platform: string = process.platform, env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): BrowserCheck {
  const found: FoundBrowser[] = [];
  for (const c of candidatePaths(platform, env)) {
    if (found.some((f) => f.kind === c.kind)) continue;
    if (exists(c.path)) found.push(c.kind === "chrome" ? { kind: "chrome", channel: "chrome", label: "Google Chrome", path: c.path } : { kind: "edge", channel: "msedge", label: "Microsoft Edge", path: c.path });
  }
  found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "chrome" ? -1 : 1));
  const preferred = found[0] ?? null;
  return {
    found,
    preferred,
    instructions: preferred
      ? ""
      : platform === "win32"
        ? "Clynx scans Facebook Marketplace through Google Chrome or Microsoft Edge, and neither was found. Install Google Chrome (google.com/chrome), then restart Clynx. Microsoft Edge comes with Windows 10 and 11: if it was removed, reinstall it from microsoft.com/edge."
        : "Clynx scans Facebook Marketplace through Google Chrome or Microsoft Edge, and neither was found. Install Google Chrome (google.com/chrome), then restart Clynx.",
  };
}
