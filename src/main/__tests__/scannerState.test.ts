// Phase 2, item 4: the scanner's situation (stopped, starting, scanning, waiting, needs login, failing, off) is named in plain words, with
// the right next step, and the Feed's empty states say why they are empty.
import { describeEmptyFeed, describeScannerState, type ScannerStateKind } from "../../renderer/src/lib/scannerState.js";
import type { AppNotice } from "../appNotices.js";
import type { Account, ScrapeStatus } from "../types.js";
import { check, run, section } from "./_testkit.js";

const acct = (id = "a1"): Account => ({ id, label: "Account 1", enabled: true } as Account);
const st = (over: Partial<ScrapeStatus> = {}): ScrapeStatus => ({ running: true, loggedIn: true, currentSearch: null, listingsThisCycle: 0, locationIndex: 0, lastCycleStartedAt: Date.now() - 5000, lastCycleFinishedAt: null, lastError: null, currentListing: null, upcomingListings: [], currentActionNote: null, analyzingPhotos: false, currentReaction: null, ...over } as ScrapeStatus);
const notice = (id: string): AppNotice => ({ id, severity: "error", title: "t", message: "m", action: "dismiss", actionLabel: "x", createdAt: 1 });
const kind = (over: { accounts?: Account[]; statusMap?: Record<string, ScrapeStatus>; notices?: AppNotice[]; facebookEnabled?: boolean }) =>
  describeScannerState({ accounts: [acct()], statusMap: {}, notices: [], facebookEnabled: true, ...over });

run(() => {
  section("each situation gets its own name");
  {
    check("Facebook switched off in Config", kind({ facebookEnabled: false }).kind === "off");
    check("no account at all", kind({ accounts: [] }).kind === "no-account");
    check("an account that is not running: stopped", kind({ statusMap: { a1: st({ running: false }) } }).kind === "stopped" && kind({}).kind === "stopped");
    check("running but not yet through its first cycle: starting up", kind({ statusMap: { a1: st({ lastCycleStartedAt: null }) } }).kind === "starting");
    check("running and mid-pass: scanning", kind({ statusMap: { a1: st() } }).kind === "scanning");
    check("running and between passes: waiting", kind({ statusMap: { a1: st({ sleepingUntil: Date.now() + 120_000 }) } }).kind === "waiting");
    check("a pause that has already ended counts as scanning again", kind({ statusMap: { a1: st({ sleepingUntil: Date.now() - 1000 }) } }).kind === "scanning");
    check("logged out while running: needs login", kind({ statusMap: { a1: st({ loggedIn: false }) } }).kind === "needs-login");
    check("a Facebook-session notice also means needs login (even if the status has not caught up)", kind({ statusMap: { a1: st() }, notices: [notice("fb-session:a1")] }).kind === "needs-login");
    check("a scan-failing notice means failing", kind({ statusMap: { a1: st() }, notices: [notice("scan-failing:a1")] }).kind === "failing");
  }

  section("priority: the most useful thing to tell the user wins");
  {
    const both = kind({ statusMap: { a1: st({ loggedIn: false }) }, notices: [notice("scan-failing:a1"), notice("fb-session:a1")] });
    check("failing beats needs-login", both.kind === "failing");
    check("off beats everything", kind({ facebookEnabled: false, statusMap: { a1: st() }, notices: [notice("scan-failing:a1")] }).kind === "off");
    check("a logged-out account that is NOT running is just stopped (nothing is being attempted)", kind({ statusMap: { a1: st({ running: false, loggedIn: false }) } }).kind === "stopped");
    check("one of two accounts running is enough to be 'scanning'", describeScannerState({ accounts: [acct("a1"), acct("a2")], statusMap: { a1: st({ running: false }), a2: st() }, notices: [], facebookEnabled: true }).kind === "scanning");
  }

  section("the words");
  {
    const states: ScannerStateKind[] = ["off", "no-account", "stopped", "starting", "scanning", "waiting", "needs-login", "failing"];
    const samples = [
      kind({ facebookEnabled: false }), kind({ accounts: [] }), kind({}), kind({ statusMap: { a1: st({ lastCycleStartedAt: null }) } }), kind({ statusMap: { a1: st() } }),
      kind({ statusMap: { a1: st({ sleepingUntil: Date.now() + 120_000 }) } }), kind({ statusMap: { a1: st({ loggedIn: false }) } }), kind({ notices: [notice("scan-failing:a1")], statusMap: { a1: st() } }),
    ];
    check("all eight situations are produced", samples.map((s) => s.kind).join() === states.join(), samples.map((s) => s.kind));
    check("every one has a short headline and a sentence saying what it means", samples.every((s) => s.headline.length > 3 && s.headline.length < 50 && s.detail.length > 30));
    check("the ones that need the user tell them what to click", /Start Scanner/.test(samples[2].detail) && /Open Facebook/.test(samples[6].detail) && /Try again/.test(samples[7].detail) && /Config/.test(samples[0].detail));
    check("tones: stopped is neutral, needs-login and failing are red, scanning is green", samples[2].tone === "muted" && samples[6].tone === "bad" && samples[7].tone === "bad" && samples[4].tone === "ok");
    check("no jargon in any of them", !samples.some((s) => /exception|playwright|ipc|engine|undefined|null/i.test(s.headline + s.detail)));
    check("text is stable: it contains no countdown or listing title (so screens showing it do not re-render each tick)", samples.every((s) => !/\d/.test(s.headline + s.detail)));
  }

  section("the Feed's empty states");
  {
    const e = (scanner: ScannerStateKind, over: Partial<Parameters<typeof describeEmptyFeed>[0]> = {}) => describeEmptyFeed({ scanner, listingCount: 0, filter: "all", hasSearchItems: true, ...over });
    check("stopped: says it is stopped and offers the Dashboard", /stopped/.test(e("stopped").text) && e("stopped").action === "dashboard");
    check("needs login: says Facebook isn't logged in and offers the Dashboard", /isn't logged in/.test(e("needs-login").text) && e("needs-login").action === "dashboard");
    check("failing: says scanning keeps failing and offers the Dashboard", /keeps failing/.test(e("failing").text) && e("failing").action === "dashboard");
    check("scanning: reassures that listings will appear, no button", /Scanning now/.test(e("scanning").text) && e("scanning").action === null);
    check("starting and waiting have their own wording", /Starting up/.test(e("starting").text) && /Between passes/.test(e("waiting").text));
    check("off and no-account point at Config", /Config/.test(e("off").text) && /Config > Sources/.test(e("no-account").text));
    check("with nothing to search for, a tip suggests adding a product", /add a product to Search For/.test(e("scanning", { hasSearchItems: false }).text) && !/Tip/.test(e("scanning").text));
    check("deals filter with listings present: explains the margin rule, not 'scanner stopped'", /No deals among the 12 listings/.test(e("stopped", { listingCount: 12, filter: "deals" }).text) && !/stopped/.test(e("stopped", { listingCount: 12, filter: "deals" }).text));
    check("worth-a-look and watch filters have their own wording", /Worth a look/.test(e("scanning", { listingCount: 3, filter: "look" }).text) && /Watch tab/.test(e("scanning", { listingCount: 3, filter: "watch" }).text));
  }
});
