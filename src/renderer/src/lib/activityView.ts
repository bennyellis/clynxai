// What the Activity screen shows in each of its views, and the question "Ask Clynx about this" builds from an event. Pure (no React, no IPC).
//
//   feed: the operational events (scan log lines plus the AI's own narration)
//   chat: only the conversation with Clynx
//   all : both interleaved by time (how Activity always worked)
// Nothing here touches log storage: it only chooses which of the lines App.tsx already keeps are drawn.

export type ActivityView = "all" | "feed" | "chat";
export type LevelFilter = "all" | "issues" | "deals";

export const ACTIVITY_VIEW_KEY = "clynx.activity.view";
export const ACTIVITY_LEVEL_KEY = "clynx.activity.levelFilter";

export interface LogLike {
  ts: number;
  level: "info" | "warn" | "error" | "deal" | "greenFlag";
  message: string;
  listingUrl?: string;
  productName?: string;
  accountLabel?: string;
}

export interface ChatLike {
  id: string;
  role: "user" | "assistant";
  ts: number;
  // Set when the AI said it on its own (narration), not in reply to the user.
  auto?: "deal" | "batch";
}

export type ActivityItem<L extends LogLike, C extends ChatLike> = { kind: "log"; ts: number; line: L } | { kind: "chat"; ts: number; entry: C };

export function parseActivityView(raw: unknown): ActivityView {
  return raw === "feed" || raw === "chat" || raw === "all" ? raw : "all";
}

export function parseLevelFilter(raw: unknown): LevelFilter {
  return raw === "issues" || raw === "deals" || raw === "all" ? raw : "all";
}

/** The routine, per-listing "skip (reason): title" chatter. */
export function isRoutineSkip(line: Pick<LogLike, "level" | "message">): boolean {
  return line.level === "info" && /^skip\b/i.test(line.message);
}

/** Entries without `auto` are the conversation; entries with it are Clynx's own narration, which is an event. */
export function isConversation(entry: ChatLike): boolean {
  return entry.auto === undefined;
}

/** Whether a log line passes the level filter: "issues" = warnings and errors, "deals" = deals and green flags. */
export function logMatchesLevel(line: Pick<LogLike, "level">, level: LevelFilter): boolean {
  if (level === "all") return true;
  if (level === "issues") return line.level === "warn" || line.level === "error";
  return line.level === "deal" || line.level === "greenFlag";
}

function narrationMatchesLevel(entry: ChatLike, level: LevelFilter): boolean {
  if (level === "all") return true;
  if (level === "deals") return entry.auto === "deal";
  return false; // narration is never a warning or an error
}

/**
 * The rows to draw, oldest first. `level` only narrows the Activity Feed view: in "all" the view is the unfiltered timeline, as before, and
 * in "chat" there are no events to filter.
 */
export function buildActivityItems<L extends LogLike, C extends ChatLike>(
  logs: ReadonlyArray<L>,
  chat: ReadonlyArray<C>,
  opts: { view: ActivityView; showRoutine: boolean; level: LevelFilter }
): Array<ActivityItem<L, C>> {
  const { view, showRoutine, level } = opts;
  const items: Array<ActivityItem<L, C>> = [];
  if (view !== "chat") {
    for (const line of logs) {
      if (!showRoutine && isRoutineSkip(line)) continue;
      if (view === "feed" && !logMatchesLevel(line, level)) continue;
      items.push({ kind: "log", ts: line.ts, line });
    }
  }
  for (const entry of chat) {
    if (view === "chat") {
      if (!isConversation(entry)) continue;
    } else if (view === "feed") {
      if (isConversation(entry) || !narrationMatchesLevel(entry, level)) continue;
    }
    items.push({ kind: "chat", ts: entry.ts, entry });
  }
  // Stable sort: equal timestamps keep log-then-chat order, matching the previous merged feed.
  return items.sort((a, b) => a.ts - b.ts);
}

export interface AskableEvent {
  ts: number;
  level: string;
  message: string;
  listingUrl?: string;
  productName?: string;
  accountLabel?: string;
}

/**
 * The draft that "Ask Clynx about this" puts in the composer. It is a complete question on its own (so Clynx has the event without having
 * seen the log), and it is only a draft: the user reads it and presses Send.
 */
export function buildAskPrompt(event: AskableEvent, formatTs: (ts: number) => string = (ts) => new Date(ts).toISOString()): string {
  const lines = [
    "Can you explain this event from my Activity feed, and tell me if I should do anything about it?",
    "",
    `Time: ${formatTs(event.ts)}`,
    `Level: ${event.level}`,
    `Event: ${event.message.trim()}`,
  ];
  if (event.accountLabel) lines.push(`Account: ${event.accountLabel}`);
  if (event.productName) lines.push(`Product: ${event.productName}`);
  if (event.listingUrl) lines.push(`Listing: ${event.listingUrl}`);
  return lines.join("\n");
}
