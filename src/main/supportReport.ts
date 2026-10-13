// The "support report" a user can save and send when something is wrong: versions, settings, recent diagnostics, notices and sizes - with every secret removed.
// It never contains listings, product data, photos, chat text, account passwords, API keys, tokens, or the user's email address; file paths have the user's name replaced.
export const REDACTED = "[removed]";

const SECRET_KEY = /(api[-_]?key|secret|token|passw|cookie|authorization|credential|^topic$|email|signature|refresh|private|[a-z]Key$|^key$)/;
const PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{12,}/g, "[removed-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [removed]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g, "[removed-token]"],
  [/enc:v1:[A-Za-z0-9+/=]+/g, "[removed-token]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b[0-9a-f]{40,}\b/gi, "[removed-hash]"],
];

export function scrubText(text: string, homeDir?: string): string {
  let out = text;
  if (homeDir && homeDir.length > 3) {
    const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "~");
    out = out.replace(new RegExp(escaped.replace(/\\\\/g, "/"), "gi"), "~");
  }
  // C:\Users\<name>\ and /Users/<name>/ or /home/<name>/ in any remaining path
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, "$1<user>").replace(/(\/(?:Users|home)\/)[^/\s"']+/g, "$1<user>");
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep copy with secret-looking keys blanked and secret-looking values scrubbed. */
export function redactSecrets(value: unknown, homeDir?: string, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value, homeDir);
  if (Array.isArray(value)) return depth > 6 ? "[…]" : value.slice(0, 200).map((v) => redactSecrets(v, homeDir, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 6) return "[…]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const secretLooking = SECRET_KEY.test(k) || /(Topic|Email|Secret|Token|Password)/.test(k);
      out[k] = secretLooking && v !== null && v !== undefined && v !== "" && typeof v !== "boolean" ? REDACTED : redactSecrets(v, homeDir, depth + 1);
    }
    return out;
  }
  return value;
}

export interface SupportReportInput {
  generatedAt: string;
  app: { version: string; electron: string; chrome?: string; node?: string; platform: string; arch: string; osRelease?: string; packaged: boolean };
  config: unknown;
  diagnosticsTail: string[];
  notices: Array<{ id: string; severity: string; title: string; message: string }>;
  cloud?: unknown;
  database?: { bytes: number | null; backups: number; newestBackupAt: string | null };
  build?: { version: string; channel: string; commit: string; builtAt: string | null; localMode: boolean };
  browser?: { ok: boolean; using: string | null; found: string[] };
  /** Recent scanner warnings and errors from the Activity log (no deals, no listing titles). */
  recentProblems?: string[];
  homeDir?: string;
}

export function buildSupportReport(i: SupportReportInput): string {
  const section = (title: string, body: string) => `\n=== ${title} ===\n${body}\n`;
  const json = (v: unknown) => JSON.stringify(redactSecrets(v, i.homeDir), null, 2);
  const parts = [
    "Clynx support report",
    `Created: ${i.generatedAt}`,
    "This file lists versions, settings and recent technical events. Passwords, API keys, tokens, email addresses, listings and photos are NOT included.",
    section("App", json(i.app)),
    section("Build", json(i.build ?? {})),
    section("Browser for scanning", json(i.browser ?? {})),
    section("Database", json(i.database ?? {})),
    section("Needs-attention notices", i.notices.length ? json(i.notices) : "(none)"),
    section("Cloud account", json(i.cloud ?? {})),
    section("Settings (secrets removed)", json(i.config)),
    section("Recent scanner warnings and errors (newest last)", i.recentProblems?.length ? i.recentProblems.map((l) => scrubText(l, i.homeDir)).join("\n") : "(none)"),
    section("Recent technical events (newest last)", i.diagnosticsTail.length ? i.diagnosticsTail.map((l) => scrubText(l, i.homeDir)).join("\n") : "(none)"),
  ];
  return parts.join("\n");
}
