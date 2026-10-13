// Turns what a failed scan cycle throws into words a customer can act on. The raw text of an exception (a Playwright call log, a
// network error code) means nothing to them and leads straight to a support ticket; the technical detail stays in the Activity log.
export type ScannerErrorKind = "chrome-missing" | "browser-closed" | "network" | "timeout" | "profile-locked" | "unknown";

export interface ScannerErrorExplanation {
  kind: ScannerErrorKind;
  title: string;
  // What to do about it, in plain words.
  message: string;
}

/** Cycle failures in a row before the user is told (one failed cycle is often a blip that the next one fixes). */
export const FAILING_CYCLES_BEFORE_NOTICE = 3;

export function explainScannerError(raw: string): ScannerErrorExplanation {
  const text = raw || "";
  if (/executable doesn'?t exist|playwright install|chrome.*(?:not found|is not installed)|failed to launch.*chrome|ENOENT.*chrome/i.test(text)) {
    return {
      kind: "chrome-missing",
      title: "Clynx can't start Google Chrome or Microsoft Edge",
      message: "Clynx scans through Google Chrome (or Microsoft Edge) and couldn't open either. Install or repair Google Chrome (google.com/chrome), then restart Clynx and click Try again.",
    };
  }
  if (/profile.*(?:in use|locked)|singleton.*lock|user data directory is already in use|processsingleton/i.test(text)) {
    return {
      kind: "profile-locked",
      title: "The Facebook browser window is stuck",
      message: "Another Chrome window is still using this account's Facebook profile. Close any leftover Clynx/Facebook Chrome windows, then click Try again.",
    };
  }
  if (/target (?:page, context or browser has been )?closed|browser has been closed|browser.*(?:disconnected|crashed)|context.*closed/i.test(text)) {
    return {
      kind: "browser-closed",
      title: "The Facebook browser window was closed",
      message: "The Chrome window Clynx scans with closed or crashed. Click Try again and Clynx will open it again; your Facebook login is kept.",
    };
  }
  if (/net::err_|err_internet|err_name_not_resolved|err_connection|enotfound|econnreset|econnrefused|fetch failed|network.*(?:error|unreachable)|getaddrinfo|offline/i.test(text)) {
    return {
      kind: "network",
      title: "Clynx can't reach Facebook",
      message: "The internet connection looks down, or Facebook isn't answering. Check your connection; Clynx keeps retrying and will carry on by itself, or click Try again once you're back online.",
    };
  }
  if (/timeout|timed out|exceeded/i.test(text)) {
    return {
      kind: "timeout",
      title: "Facebook is responding very slowly",
      message: "Pages are taking too long to load, so scans keep timing out. Clynx keeps retrying with longer pauses. If it continues, check your connection and click Try again.",
    };
  }
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return {
    kind: "unknown",
    title: "Scanning keeps failing",
    message: `Several scans in a row failed${firstLine ? ` (${firstLine.slice(0, 140)})` : ""}. Click Try again; if it keeps happening, open Activity and send the last red lines to support.`,
  };
}

/** How long to wait before the next try after `failures` failed cycles in a row: 30 s, 1 min, 2 min, 4 min ... capped at 10 min. */
export function failureBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(10 * 60_000, 30_000 * 2 ** (Math.min(failures, 10) - 1));
}
