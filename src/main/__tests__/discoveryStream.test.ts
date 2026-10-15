// The Discovery tab's two channels: the conversation (and research you asked for) and Clynx's own automation, each oldest first, plus the
// near-bottom rule the chat uses to decide whether to follow new content.
import { automationStamp, buildAutomationStream, buildChatStream, channelOf, chatStamp, hasUnread, pairTurns } from "../../renderer/src/lib/discoveryStream.js";
import { STICK_THRESHOLD_PX, isNearBottom } from "../../renderer/src/lib/stickToBottom.js";
import { check, run, section } from "./_testkit.js";

type Msg = { id: string; role: "user" | "assistant"; ts: number; content?: string; streaming?: boolean; error?: boolean };
const u = (id: string, ts: number): Msg => ({ id, role: "user", ts });
const a = (id: string, ts: number, extra: Partial<Msg> = {}): Msg => ({ id, role: "assistant", ts, ...extra });
const e = (id: string, source: string, startedAt: number, extra: { status?: string; thoughts?: unknown[] } = {}) => ({ id, source, startedAt, ...extra });

run(() => {
  section("channels");
  check("research you asked for is conversation", channelOf({ source: "you" }) === "chat");
  check("every automatic source is automation", ["scanner", "refresh", "related", "alert", "bundle", "variant"].every((s) => channelOf({ source: s }) === "automation"));

  section("pairing messages into turns");
  {
    const turns = pairTurns([u("u1", 1), a("a1", 2), u("u2", 3), a("a2", 4)]);
    check("two question/answer turns, in order", turns.length === 2 && turns[0].user?.id === "u1" && turns[0].reply?.id === "a1" && turns[1].reply?.id === "a2");
    const unanswered = pairTurns([u("u1", 1), a("a1", 2), u("u2", 3)]);
    check("a question with no reply yet is a turn with reply null", unanswered.length === 2 && unanswered[1].user?.id === "u2" && unanswered[1].reply === null);
    const orphan = pairTurns([a("a0", 1), u("u1", 2), a("a1", 3)]);
    check("a reply with no question before it is kept as its own turn", orphan.length === 2 && orphan[0].user === null && orphan[0].reply?.id === "a0");
    const twoReplies = pairTurns([u("u1", 1), a("a1", 2), a("a2", 3)]);
    check("a second consecutive reply is not swallowed", twoReplies.length === 2 && twoReplies[1].user === null && twoReplies[1].reply?.id === "a2");
    check("an empty thread has no turns", pairTurns([]).length === 0);
    const streaming = pairTurns([u("u1", 1), a("a1", 2, { streaming: true, content: "Hel" })]);
    check("a streaming reply stays paired with its question", streaming.length === 1 && streaming[0].reply?.streaming === true);
    const err = pairTurns([u("u1", 1), a("a1", 2, { error: true, content: "Error: x" })]);
    check("an error reply stays paired", err.length === 1 && err[0].reply?.error === true);
    const shuffled = pairTurns([u("u2", 30), a("a2", 31), u("u1", 10), a("a1", 11)]);
    check("turns are sorted oldest first by when they began", shuffled[0].user?.id === "u1" && shuffled[1].user?.id === "u2");
  }

  section("the chat channel: oldest first, newest last");
  {
    const entries = [e("r1", "you", 25), e("s1", "scanner", 15), e("r0", "you", 5)];
    const items = buildChatStream([u("u1", 10), a("a1", 11), u("u2", 30), a("a2", 31)], entries);
    check("messages and your own research interleave by time", items.map((i) => i.key).join(",") === "entry-r0,turn-u1,entry-r1,turn-u2", items.map((i) => i.key));
    check("scanner research is NOT in the chat", !items.some((i) => i.key === "entry-s1"));
    check("a streaming reply's row key does not change as it grows", buildChatStream([u("u1", 1), a("a1", 2, { content: "" })], [])[0].key === buildChatStream([u("u1", 1), a("a1", 2, { content: "long text" })], [])[0].key);
    check("empty state: nothing at all", buildChatStream([], []).length === 0 && buildChatStream([], [e("s1", "scanner", 1)]).length === 0);
    const last = items[items.length - 1];
    check("the newest item is last", last.kind === "turn" && last.ts === 30);
  }

  section("the automation channel");
  {
    const entries = [e("s2", "scanner", 40), e("y", "you", 35), e("earlier-p", "scanner", 2), e("s1", "refresh", 20)];
    const items = buildAutomationStream(entries);
    check("oldest first, your research excluded", items.map((i) => i.entry.id).join(",") === "earlier-p,s1,s2");
    const filtered = buildAutomationStream(entries, (x) => x.id === "s2");
    check("the filter chip narrows it", filtered.length === 1 && filtered[0].entry.id === "s2");
    check("empty state", buildAutomationStream([]).length === 0);
    check("an entry keeps its place when its status changes (key and ts are stable)", buildAutomationStream([e("s1", "scanner", 5, { status: "researching" })])[0].key === buildAutomationStream([e("s1", "scanner", 5, { status: "done" })])[0].key);
  }

  section("unread markers");
  {
    const m1 = [u("u1", 1), a("a1", 2, { streaming: true })];
    const m2 = [u("u1", 1), a("a1", 2)];
    check("chat stamp changes when a reply finishes", chatStamp(m1, []) !== chatStamp(m2, []));
    check("chat stamp changes with a new message", chatStamp(m2, []) !== chatStamp([...m2, u("u2", 3)], []));
    check("chat stamp is stable otherwise", chatStamp(m2, []) === chatStamp([...m2], []));
    check("your own research counts for chat, scanner research does not", chatStamp([], [e("y", "you", 1)]) !== chatStamp([], []) && chatStamp([], [e("s", "scanner", 1)]) === chatStamp([], []));
    const s1 = [e("s1", "scanner", 1, { status: "researching", thoughts: [] })];
    const s2 = [e("s1", "scanner", 1, { status: "researching", thoughts: [1] })];
    check("automation stamp changes with a new thought", automationStamp(s1) !== automationStamp(s2));
    check("automation stamp changes with a new product", automationStamp(s1) !== automationStamp([...s1, e("s2", "scanner", 2)]));
    check("saved-notes history (earlier-*) never lights the dot", automationStamp([]) === automationStamp([e("earlier-x", "scanner", 1)]));
    check("nothing recorded yet means nothing unread", !hasUnread("x", undefined));
    check("a changed stamp is unread, the same is not", hasUnread("b", "a") && !hasUnread("a", "a"));
  }

  section("near-bottom rule (80px)");
  {
    const at = (gap: number) => ({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - gap });
    check("threshold is 80px", STICK_THRESHOLD_PX === 80);
    check("exactly at the bottom: follow", isNearBottom(at(0)));
    check("79px up: still follow", isNearBottom(at(79)));
    check("80px up: stop following", !isNearBottom(at(80)));
    check("far up reading history: stop following", !isNearBottom(at(500)));
    check("content shorter than the box: follow", isNearBottom({ scrollHeight: 100, clientHeight: 400, scrollTop: 0 }));
    check("a custom threshold is honoured", isNearBottom(at(150), 200) && !isNearBottom(at(150), 100));
  }
});
