// Discovery UI step 3 (AUDITOR proposal section 2, owner-accepted): ONE window with an Everything / Automation / My chat switch, the box pinned at the bottom in every view, Claude-style messages,
// and no narrow-window tabs or unread dots. The view logic is pure (lib/discoveryStream.ts) and tested here; the screen is checked as the shape of its source. Entries, research, verdicts and
// how things are stored are untouched.
import fs from "node:fs";
import path from "node:path";
import { buildView, DEFAULT_VIEW, nextViewForKey, VIEW_MODES, viewAfterSend, type StreamEntry, type StreamMessage } from "../../renderer/src/lib/discoveryStream.js";
import { check, run, section } from "./_testkit.js";

interface Msg extends StreamMessage {
  text: string;
}
const msg = (id: string, role: "user" | "assistant", ts: number): Msg => ({ id, role, ts, text: id });
const entry = (id: string, source: string, startedAt: number, status = "done"): StreamEntry & { id: string } => ({ id, source, startedAt, status, thoughts: [] });

run(async () => {
  const messages = [msg("u1", "user", 100), msg("a1", "assistant", 110), msg("u2", "user", 400), msg("a2", "assistant", 410)];
  const entries = [entry("scan1", "scanner", 50), entry("asked1", "you", 120), entry("scan2", "scanner", 300), entry("rel1", "related", 500), entry("alert1", "alert", 600, "researching")];
  const keys = (items: Array<{ key: string }>) => items.map((i) => i.key).join();

  section("the three views");
  check("the default is Everything, and the switch lists the three in order", DEFAULT_VIEW === "everything" && VIEW_MODES.map((v) => v.label).join() === "Everything,Automation,My chat");
  const everything = buildView("everything", messages, entries);
  check("Everything is ONE chronological stream: your turns, research you asked for and what Clynx found on its own, in the order they happened", keys(everything) === "entry-scan1,turn-u1,entry-asked1,entry-scan2,turn-u2,entry-rel1,entry-alert1", keys(everything));
  const automation = buildView("automation", messages, entries);
  check("Automation is only what Clynx found on its own (the research you asked for stays with your conversation)", keys(automation) === "entry-scan1,entry-scan2,entry-rel1,entry-alert1", keys(automation));
  const chat = buildView("chat", messages, entries);
  check("My chat is your conversation plus the research you asked for", keys(chat) === "turn-u1,entry-asked1,turn-u2", keys(chat));
  check("every entry and message is in Everything exactly once", everything.length === messages.length / 2 + entries.length && new Set(keys(everything).split(",")).size === everything.length);

  section("the filter chips narrow Automation only");
  const onlyResearching = buildView("automation", messages, entries, (e) => e.status === "researching");
  check("with a chip on, Automation shows just those", keys(onlyResearching) === "entry-alert1", keys(onlyResearching));
  check("in Everything the chip is not applied: nothing Clynx found disappears from the full picture", keys(buildView("everything", messages, entries, () => false)) === keys(everything));
  check("My chat ignores the chip too", keys(buildView("chat", messages, entries, () => false)) === keys(chat));

  section("order is stable and nothing is lost");
  const ties = buildView("everything", [msg("u", "user", 10)], [entry("e", "scanner", 10)]);
  check("equal times keep the conversation first, then the finding", keys(ties) === "turn-u,entry-e", keys(ties));
  check("an empty window is an empty list", buildView("everything", [], []).length === 0 && buildView("automation", [], []).length === 0 && buildView("chat", [], []).length === 0);
  check("a reply streaming in keeps its row (the key follows the first message of the turn)", keys(buildView("chat", [msg("u9", "user", 5), msg("a9", "assistant", 6)], [])) === "turn-u9" && keys(buildView("chat", [msg("u9", "user", 5)], [])) === "turn-u9");

  section("after you send, and the keyboard");
  check("a message sent while looking at Automation moves you to the full picture; the other views stay", viewAfterSend("automation") === "everything" && viewAfterSend("chat") === "chat" && viewAfterSend("everything") === "everything");
  check("arrows move through the switch and wrap, Home / End jump, other keys do nothing", nextViewForKey("everything", "ArrowRight") === "automation" && nextViewForKey("chat", "ArrowRight") === "everything" && nextViewForKey("everything", "ArrowLeft") === "chat" && nextViewForKey("automation", "Home") === "everything" && nextViewForKey("automation", "End") === "chat" && nextViewForKey("chat", "a") === null);

  section("the screen: one window, the box pinned, no tabs or dots");
  const disc = fs.readFileSync(path.join(process.cwd(), "src", "renderer", "src", "screens", "DiscoveryTab.tsx"), "utf8");
  const count = (re: RegExp) => (disc.match(re) ?? []).length;
  check("one stream, one scroller, one box: the Composer is rendered exactly once, in the same window as the stream", count(/<Composer\b/g) === 1 && count(/ref=\{stick\.scrollRef\}/g) === 1 && !/autoStick|chatStick/.test(disc));
  check("the three-way switch is a tablist over the one stream, with the keyboard handler", /role="tablist" aria-label="What to show" onKeyDown=\{switchKeys\}/.test(disc) && /VIEW_MODES\.map/.test(disc) && /aria-controls="discovery-stream"/.test(disc) && /id="discovery-stream"/.test(disc));
  check("the narrow-window tab code and the unread dots are gone", !/SIDE_BY_SIDE|ResizeObserver|hasUnread|chatStamp|automationStamp|new activity|\bwide\b/.test(disc));
  check("the filter chips show only in the Automation view", /mode === "automation" && \(\s*<>[\s\S]*?Worth flipping/.test(disc));
  check("after sending, the view is chosen by viewAfterSend and the stream goes to the latest", /setMode\(viewAfterSend\(mode\)\);\s*stick\.scrollToBottom\(\);/.test(disc));
  check("Claude-style messages: you are a rounded bubble on the right under 'You'; Clynx is plain text beside its logo, with no card", /isUser \? <YouLabel align="right" \/> : <ClynxAvatar \/>/.test(disc) && /background: "transparent", border: "none"/.test(disc) && /borderRadius: 18/.test(disc));
  check("product cards (verdicts, Ask about this, Open in Library) stay inside the stream", /renderCard\(item\.entry\)/.test(disc) && /onAsk=\{\(\) => askAbout\(entry\)\}/.test(disc) && /onOpenProduct=\{onOpenProduct\}/.test(disc));
  check("'Jump to latest' stays", /<JumpToLatest label="Jump to latest"/.test(disc));
  check("the live feed column is untouched by this step", /orderTiles\(entries\)\.map/.test(disc) && /<strong>Live feed<\/strong>/.test(disc));
  check("the stream sits in a centred column so lines stay readable on a wide window", /maxWidth: 860, margin: "0 auto"/.test(disc));
});
