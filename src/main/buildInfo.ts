// Which build is this? Read from resources/build-info.json (written by scripts/build-info.cjs when a build is made). A missing or unreadable file means a development run.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface BuildInfo {
  version: string;
  channel: "dev" | "beta" | "production";
  commit: string;
  dirty: boolean;
  builtAt: string | null;
  /** The "use Clynx on this computer only" mode is offered only by builds made for the beta. */
  localModeAllowed: boolean;
}

export function readBuildInfo(appPath: string, fallbackVersion: string): BuildInfo {
  const fallback: BuildInfo = { version: fallbackVersion, channel: "dev", commit: "unknown", dirty: false, builtAt: null, localModeAllowed: false };
  try {
    const file = path.join(appPath, "resources", "build-info.json");
    if (!existsSync(file)) return fallback;
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const channel = raw?.channel === "beta" || raw?.channel === "production" ? raw.channel : "dev";
    return {
      version: typeof raw?.version === "string" ? raw.version : fallbackVersion,
      channel,
      commit: typeof raw?.commit === "string" ? raw.commit : "unknown",
      dirty: raw?.dirty === true,
      builtAt: typeof raw?.builtAt === "string" ? raw.builtAt : null,
      localModeAllowed: channel === "beta",
    };
  } catch {
    return fallback;
  }
}
