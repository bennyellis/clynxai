import type { Account, ScrapeStatus } from "../../../main/types.js";
import type { AppNotice } from "../../../main/appNotices.js";

// One plain answer to "what is the scanner doing right now?", from the engine statuses and the notices. Used by the Dashboard status line and
// the Feed's empty states, so the two never disagree. The text is deliberately STABLE (no listing titles, no countdowns): it changes only
// when the situation changes, so screens that show it do not re-render on every scan tick.
export type ScannerStateKind = "off" | "no-account" | "stopped" | "starting" | "scanning" | "waiting" | "needs-login" | "failing";

export interface ScannerState {
  kind: ScannerStateKind;
  // Short, for a status line: "Scanner stopped".
  headline: string;
  // One sentence of what it means and what to do.
  detail: string;
  tone: "ok" | "warn" | "bad" | "muted";
}

export interface ScannerStateInput {
  accounts: Account[];
  statusMap: Record<string, ScrapeStatus>;
  notices: AppNotice[];
  // Config > "Search Facebook Marketplace" master switch.
  facebookEnabled: boolean;
}

export function describeScannerState({ accounts, statusMap, notices, facebookEnabled }: ScannerStateInput): ScannerState {
  if (!facebookEnabled) {
    return { kind: "off", headline: "Facebook scanning is off", detail: "Searching Facebook Marketplace is switched off in Config. Turn it on there to scan.", tone: "muted" };
  }
  if (accounts.length === 0) {
    return { kind: "no-account", headline: "No Facebook account set up", detail: "Add a Facebook account in Config > Sources, then press Start Scanner.", tone: "warn" };
  }
  const running = accounts.filter((a) => statusMap[a.id]?.running);
  const failing = notices.some((n) => n.id.startsWith("scan-failing:"));
  if (failing) {
    return { kind: "failing", headline: "Scanning is failing", detail: "Clynx keeps hitting an error, so nothing new is arriving. The red message on the Dashboard says why and has a Try again button.", tone: "bad" };
  }
  const needsLogin = notices.some((n) => n.id.startsWith("fb-session:")) || running.some((a) => statusMap[a.id]?.loggedIn === false);
  if (needsLogin) {
    return { kind: "needs-login", headline: "Waiting for you to log in to Facebook", detail: "Facebook isn't logged in, so scanning is paused. Click Open Facebook on the Dashboard and log in; scanning resumes by itself.", tone: "bad" };
  }
  if (running.length === 0) {
    return { kind: "stopped", headline: "Scanner stopped", detail: "Nothing is being checked right now. Press Start Scanner on the Dashboard to begin.", tone: "muted" };
  }
  const now = Date.now();
  const active = running.some((a) => {
    const s = statusMap[a.id];
    return !!s && !(typeof s.sleepingUntil === "number" && s.sleepingUntil > now) && s.lastCycleStartedAt !== null;
  });
  if (active) {
    return { kind: "scanning", headline: "Scanning", detail: "Clynx is checking Facebook Marketplace. New listings appear in the Feed as soon as they've been checked.", tone: "ok" };
  }
  const sleeping = running.some((a) => typeof statusMap[a.id]?.sleepingUntil === "number" && (statusMap[a.id]!.sleepingUntil as number) > now);
  if (sleeping) {
    return { kind: "waiting", headline: "Waiting for the next pass", detail: "The last pass is done. Clynx checks again after the pause set in Config (press Skip wait on the Dashboard to go now).", tone: "ok" };
  }
  return { kind: "starting", headline: "Starting up", detail: "Opening Facebook and getting ready. The first start can take a minute while your search location is set up.", tone: "ok" };
}

/** What the Feed says when there is nothing to show, by situation. `listingCount` is how many listings exist before filters. */
export function describeEmptyFeed(args: {
  scanner: ScannerStateKind;
  listingCount: number;
  filter: "all" | "deals" | "look" | "watch";
  hasSearchItems: boolean;
}): { text: string; action: "dashboard" | null } {
  const { scanner, listingCount, filter, hasSearchItems } = args;
  if (listingCount > 0) {
    if (filter === "deals") return { text: `No deals among the ${listingCount} listings checked so far. A listing shows up here when its estimated profit clears your margin.`, action: null };
    if (filter === "look") return { text: "Nothing is marked Worth a look right now. These are listings that look interesting but can't be fully confirmed.", action: null };
    if (filter === "watch") return { text: "No Watch finds yet. Watches search on their own schedule; set one up in the Watch tab.", action: null };
    return { text: "Nothing matches.", action: null };
  }
  const tip = hasSearchItems ? "" : " Tip: add a product to Search For on the Dashboard to focus the search.";
  switch (scanner) {
    case "off":
      return { text: "Facebook scanning is switched off in Config, so no listings are arriving.", action: null };
    case "no-account":
      return { text: "No Facebook account is set up yet. Add one in Config > Sources, then start the scanner.", action: null };
    case "stopped":
      return { text: "Nothing here yet: the scanner is stopped. Press Start Scanner on the Dashboard and listings will appear here as Clynx checks them." + tip, action: "dashboard" };
    case "starting":
      return { text: "Starting up. Clynx is opening Facebook; the first listings appear here in a minute or so.", action: null };
    case "scanning":
      return { text: "Scanning now. Listings appear here as soon as Clynx has checked them." + tip, action: null };
    case "waiting":
      return { text: "Between passes. Nothing new has come in yet; Clynx will check again shortly." + tip, action: null };
    case "needs-login":
      return { text: "Scanning is paused because Facebook isn't logged in. Open the Dashboard and click Open Facebook; listings will start arriving again once you're logged in.", action: "dashboard" };
    case "failing":
      return { text: "Scanning keeps failing, so no listings are arriving. The Dashboard shows what's wrong and how to fix it.", action: "dashboard" };
  }
}
