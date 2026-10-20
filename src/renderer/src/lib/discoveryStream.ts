// How the Discovery tab orders what it shows. Pure (no React, no IPC) so the ordering and pairing rules can be tested.
//
// Two separate channels, never mixed into one list:
//   * "chat": the conversation with Clynx (your messages, its replies) plus research you asked for yourself.
//   * "automation": everything Clynx does on its own (scanner finds, background research, related products, re-checks).
// Both read like a conversation: oldest first, newest last, new things appended at the bottom.

export interface StreamMessage {
  id: string;
  role: "user" | "assistant";
  ts: number;
}

export interface StreamEntry {
  id: string;
  source: string;
  startedAt: number;
  status?: string;
  thoughts?: ReadonlyArray<unknown>;
}

export type Channel = "chat" | "automation";

/** Research the user asked for belongs to the conversation; everything else Clynx started itself. */
export function channelOf(entry: Pick<StreamEntry, "source">): Channel {
  return entry.source === "you" ? "chat" : "automation";
}

export interface ChatTurn<M extends StreamMessage> {
  /** The user's message (null for a reply that has no question before it). */
  user: M | null;
  /** The assistant's reply (null while unanswered). */
  reply: M | null;
}

/**
 * Pairs each user message with the assistant reply that directly follows it. An assistant message with no user message before it (or after
 * another reply) becomes its own turn, so nothing is dropped. Turns come out oldest first by the time the turn began.
 */
export function pairTurns<M extends StreamMessage>(messages: ReadonlyArray<M>): Array<ChatTurn<M>> {
  const turns: Array<ChatTurn<M>> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      const next = messages[i + 1];
      if (next && next.role === "assistant") {
        turns.push({ user: m, reply: next });
        i++;
      } else {
        turns.push({ user: m, reply: null });
      }
    } else {
      turns.push({ user: null, reply: m });
    }
  }
  // Array.prototype.sort is stable, so equal timestamps keep the order they arrived in.
  return turns.sort((a, b) => turnTs(a) - turnTs(b));
}

function turnTs<M extends StreamMessage>(t: ChatTurn<M>): number {
  return (t.user ?? t.reply!).ts;
}

export type ChatItem<M extends StreamMessage, E extends StreamEntry> =
  | { kind: "turn"; key: string; ts: number; turn: ChatTurn<M> }
  | { kind: "product"; key: string; ts: number; entry: E };

/** The conversation channel, oldest first: message turns and the research you asked for, in the order they happened. */
export function buildChatStream<M extends StreamMessage, E extends StreamEntry>(messages: ReadonlyArray<M>, entries: ReadonlyArray<E>): Array<ChatItem<M, E>> {
  const items: Array<ChatItem<M, E>> = [];
  for (const turn of pairTurns(messages)) {
    // The key follows the first message of the turn, which never changes, so a reply streaming in does not remount its row.
    const first = (turn.user ?? turn.reply)!;
    items.push({ kind: "turn", key: `turn-${first.id}`, ts: first.ts, turn });
  }
  for (const entry of entries) {
    if (channelOf(entry) === "chat") items.push({ kind: "product", key: `entry-${entry.id}`, ts: entry.startedAt, entry });
  }
  return items.sort((a, b) => a.ts - b.ts);
}

export type AutomationItem<E extends StreamEntry> = { kind: "product"; key: string; ts: number; entry: E };

/** The automation channel, oldest first. `keep` is the filter chip (all / worth flipping / not great / researching). */
export function buildAutomationStream<E extends StreamEntry>(entries: ReadonlyArray<E>, keep: (e: E) => boolean = () => true): Array<AutomationItem<E>> {
  const items: Array<AutomationItem<E>> = [];
  for (const entry of entries) {
    if (channelOf(entry) === "automation" && keep(entry)) items.push({ kind: "product", key: `entry-${entry.id}`, ts: entry.startedAt, entry });
  }
  return items.sort((a, b) => a.ts - b.ts);
}

/** A short string that changes whenever the conversation gains a message or a reply finishes. Compared to decide on an unread dot. */
export function chatStamp(messages: ReadonlyArray<StreamMessage & { streaming?: boolean }>, entries: ReadonlyArray<StreamEntry>): string {
  const last = messages[messages.length - 1];
  const mine = entries.filter((e) => channelOf(e) === "chat").map((e) => `${e.id}:${e.status ?? ""}`);
  return `${messages.length}:${last ? `${last.id}:${last.streaming ? "s" : "d"}` : ""}|${mine.join(",")}`;
}

/** The same for the automation channel: a new product, a new thought, or a status change all count. */
export function automationStamp(entries: ReadonlyArray<StreamEntry>): string {
  return entries
    .filter((e) => channelOf(e) === "automation" && !e.id.startsWith("earlier-"))
    .map((e) => `${e.id}:${e.status ?? ""}:${e.thoughts?.length ?? 0}`)
    .join(",");
}

/** Whether the inactive channel has something the reader has not seen: its stamp differs from the one recorded when they last looked. */
export function hasUnread(currentStamp: string, seenStamp: string | undefined): boolean {
  return seenStamp !== undefined && currentStamp !== seenStamp;
}

// ---- one window, three views (AUDITOR proposal section 2, owner-accepted)

/** "everything" = one chronological stream (your messages, Clynx's replies and what it finds on its own, in the order it happened); "automation" = only what Clynx found on its own; "chat" = only your conversation. */
export type ViewMode = "everything" | "automation" | "chat";
export const VIEW_MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: "everything", label: "Everything" },
  { id: "automation", label: "Automation" },
  { id: "chat", label: "My chat" },
];
export const DEFAULT_VIEW: ViewMode = "everything";

export type StreamItem<M extends StreamMessage, E extends StreamEntry> = ChatItem<M, E> | AutomationItem<E>;

/**
 * What the one window shows for a view, oldest first. `keep` is the Automation filter chip; it narrows the automation entries only (in "everything" it is not applied, so nothing Clynx
 * found disappears from the full picture). Research you asked for stays with your conversation in every view that has the conversation.
 */
export function buildView<M extends StreamMessage, E extends StreamEntry>(mode: ViewMode, messages: ReadonlyArray<M>, entries: ReadonlyArray<E>, keep: (e: E) => boolean = () => true): Array<StreamItem<M, E>> {
  if (mode === "automation") return buildAutomationStream(entries, keep);
  const merged: Array<StreamItem<M, E>> = mode === "chat" ? buildChatStream(messages, entries) : [...buildChatStream(messages, entries), ...buildAutomationStream(entries)];
  // stable: equal timestamps keep the order they were added in (conversation first)
  const ordered = mode === "chat" ? merged : merged.sort((a, b) => a.ts - b.ts);
  // A reply that is still being written stays LAST: a card that arrives while Clynx is answering must not bury the answer above the viewport.
  const answering = (i: StreamItem<M, E>) => i.kind === "turn" && Boolean((i.turn.reply as { streaming?: boolean } | null)?.streaming);
  return [...ordered.filter((i) => !answering(i)), ...ordered.filter(answering)];
}

/** Whether the composer should move the person to the full picture after they send: a message sent while looking at Automation alone would otherwise be invisible. */
export function viewAfterSend(mode: ViewMode): ViewMode {
  return mode === "automation" ? "everything" : mode;
}

/** Arrow / Home / End keys over the three-way switch. Returns the new view, or null when the key does nothing. */
export function nextViewForKey(mode: ViewMode, key: string): ViewMode | null {
  const order = VIEW_MODES.map((m) => m.id);
  const at = order.indexOf(mode);
  if (key === "ArrowRight" || key === "ArrowDown") return order[(at + 1) % order.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return order[(at + order.length - 1) % order.length];
  if (key === "Home") return order[0];
  if (key === "End") return order[order.length - 1];
  return null;
}
