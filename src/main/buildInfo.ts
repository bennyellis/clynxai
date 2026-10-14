// Which build is this? Read from resources/build-info.json (written by scripts/build-info.cjs when a build is made). A missing or unreadable file means a development run.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeServerUrl } from "./serverAddress.js";

export interface BuildInfo {
  version: string;
  channel: "dev" | "beta" | "production";
  commit: string;
  dirty: boolean;
  builtAt: string | null;
  /** The "use Clynx on this computer only" mode is offered only by builds made for the beta. */
  localModeAllowed: boolean;
  /** The server address this build starts from (set when the build is made for one server). Null: the person enters it. */
  defaultServerUrl: string | null;
}

export function readBuildInfo(appPath: string, fallbackVersion: string): BuildInfo {
  const fallback: BuildInfo = { version: fallbackVersion, channel: "dev", commit: "unknown", dirty: false, builtAt: null, localModeAllowed: false, defaultServerUrl: null };
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
      defaultServerUrl: (() => {
        const a = normalizeServerUrl(raw?.defaultServerUrl);
        return a.ok ? a.url : null;
      })(),
    };
  } catch {
    return fallback;
  }
}
