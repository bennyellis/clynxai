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
