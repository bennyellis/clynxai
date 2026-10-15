// Activity's views (feed / chat / all), its event filters, and the question "Ask Clynx about this" prefills.
import {
  buildActivityItems,
  buildAskPrompt,
  isConversation,
  isRoutineSkip,
  logMatchesLevel,
  parseActivityView,
  parseLevelFilter,
  type ChatLike,
  type LogLike,
} from "../../renderer/src/lib/activityView.js";
import { check, run, section } from "./_testkit.js";

const log = (ts: number, level: LogLike["level"], message: string, extra: Partial<LogLike> = {}): LogLike => ({ ts, level, message, ...extra });
const chat = (id: string, role: ChatLike["role"], ts: number, auto?: ChatLike["auto"]): ChatLike => ({ id, role, ts, auto });

const logs = [
  log(1, "info", "skip (too far): Couch"),
  log(3, "warn", "Facebook is slow"),
  log(5, "deal", "Deal: Steam Deck $200", { listingUrl: "https://fb.example/1", productName: "Steam Deck" }),
  log(7, "error", "Could not load listing"),
  log(9, "greenFlag", "Mentions an Xbox"),
  log(11, "info", "Scan cycle finished"),
];
const entries = [chat("u1", "user", 2), chat("a1", "assistant", 2.5), chat("n1", "assistant", 6, "deal"), chat("n2", "assistant", 8, "batch"), chat("u2", "user", 10), chat("a2", "assistant", 10.5)];
const view = (v: "all" | "feed" | "chat", showRoutine = true, level: "all" | "issues" | "deals" = "all") => buildActivityItems(logs, entries, { view: v, showRoutine, level });
const ids = (items: ReturnType<typeof view>) => items.map((i) => (i.kind === "log" ? `L${i.ts}` : i.entry.id)).join(",");

run(() => {
  section("classification");
  check("entries without auto are the conversation, with auto are events", isConversation(entries[0]) && !isConversation(entries[2]));
  check("routine skips are info lines starting with skip", isRoutineSkip(logs[0]) && !isRoutineSkip(logs[1]) && !isRoutineSkip(log(1, "warn", "skip this")));

  section("the views");
  {
    check("All is today's behaviour: everything, oldest first", ids(view("all")) === "L1,u1,a1,L3,L5,n1,L7,n2,L9,u2,a2,L11", ids(view("all")));
    check("Chat has only the conversation", ids(view("chat")) === "u1,a1,u2,a2", ids(view("chat")));
    check("Activity Feed has log lines and narration, no conversation", ids(view("feed")) === "L1,L3,L5,n1,L7,n2,L9,L11", ids(view("feed")));
    check("Chat ignores the skip toggle and the level filter", ids(view("chat", false, "issues")) === "u1,a1,u2,a2");
    check("Hide skips drops routine lines in Feed and All", !ids(view("feed", false)).split(",").includes("L1") && !ids(view("all", false)).split(",").includes("L1") && ids(view("all", false)).split(",").includes("L3"));
    check("no logs and no chat: nothing", buildActivityItems([], [], { view: "all", showRoutine: true, level: "all" }).length === 0);
  }

  section("event filters (Activity Feed)");
  {
    check("warnings and errors only", ids(view("feed", true, "issues")) === "L3,L7", ids(view("feed", true, "issues")));
    check("deals: deal and green-flag lines plus deal narration", ids(view("feed", true, "deals")) === "L5,n1,L9", ids(view("feed", true, "deals")));
    check("the level filter does not narrow All (it is the full timeline)", ids(view("all", true, "issues")) === ids(view("all")));
    check("skip toggle composes with a level filter", ids(view("feed", false, "all")) === "L3,L5,n1,L7,n2,L9,L11");
    check("logMatchesLevel", logMatchesLevel(logs[1], "issues") && !logMatchesLevel(logs[2], "issues") && logMatchesLevel(logs[2], "deals") && logMatchesLevel(logs[0], "all"));
  }

  section("identity is preserved");
  {
    const items = view("feed");
    const same = items.filter((i) => i.kind === "log").every((i, n) => i.kind === "log" && logs.includes(i.line) && i.ts === i.line.ts && n >= 0);
    check("rows are the original objects with their original timestamps (no copies)", same);
    const chatItems = view("chat");
    check("chat rows are the original entries", chatItems.every((i) => i.kind === "chat" && entries.includes(i.entry)));
  }

  section("saved choices");
  {
    check("valid views restore", parseActivityView("feed") === "feed" && parseActivityView("chat") === "chat" && parseActivityView("all") === "all");
    check("missing or unknown view defaults to All", parseActivityView(null) === "all" && parseActivityView("grid") === "all" && parseActivityView(3) === "all");
    check("level filter restores or defaults to all", parseLevelFilter("issues") === "issues" && parseLevelFilter("deals") === "deals" && parseLevelFilter("x") === "all" && parseLevelFilter(null) === "all");
  }

  section("Ask Clynx about this");
  {
    const ev = logs[2];
    const prompt = buildAskPrompt(ev, () => "10/15/2026, 2:03:22 PM");
    check("contains the timestamp, level and message", prompt.includes("Time: 10/15/2026, 2:03:22 PM") && prompt.includes("Level: deal") && prompt.includes("Event: Deal: Steam Deck $200"));
    check("lists the listing URL and product when present", prompt.includes("Listing: https://fb.example/1") && prompt.includes("Product: Steam Deck"));
    const plain = buildAskPrompt(logs[1], () => "t");
    check("omits listing and product lines when absent", !plain.includes("Listing:") && !plain.includes("Product:") && plain.includes("Level: warn"));
    check("is a complete question, not a command", /\?/.test(plain.split("\n")[0]));
    check("default timestamp is an ISO string", buildAskPrompt({ ts: 0, level: "info", message: "x" }).includes("Time: 1970-01-01T00:00:00.000Z"));
    check("includes the account when there is one", buildAskPrompt({ ts: 0, level: "info", message: "x", accountLabel: "Account 2" }).includes("Account: Account 2"));
    check("trims whitespace in the message", buildAskPrompt({ ts: 0, level: "info", message: "  hi  " }).includes("Event: hi\n") || buildAskPrompt({ ts: 0, level: "info", message: "  hi  " }).endsWith("Event: hi"));
  }
});
