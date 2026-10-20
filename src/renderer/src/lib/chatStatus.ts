import type { ChatStatusEvent } from "../../../main/chatSupport.js";
import type { ThinkingItem } from "../../../main/thinking.js";

/** The screen keeps no more than this many thinking items per turn (the main process already caps it; this is the second line of defence). */
const MAX_THINKING_ITEMS = 20;

// Beta 13: the live "what is happening" line of a chat turn, built ONLY from real events (a tool started, a tool finished, the model is waiting for its first word). It is
// ephemeral view state: never part of the conversation history and never mixed into the assistant's text. Pure, so it is tested with a fake clock.

export interface StepState {
  id: string;
  label: string;
  kind: ChatStatusEvent["kind"];
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  detail?: string;
  /** For kind "thinking": the thought line, page or photo (already sanitised and capped by the main process). */
  item?: ThinkingItem;
}
export type RequestSteps = Record<string, StepState[]>;

export function applyStatusEvent(state: RequestSteps, e: ChatStatusEvent, now: number): RequestSteps {
  const steps = [...(state[e.requestId] ?? [])];
  if (e.kind === "thinking") {
    // one item of narrated thinking: kept in order, never merged, never "running" (it is an instant fact); the screen caps what it shows as well
    if (e.item && !steps.some((s) => s.id === e.stepId) && steps.filter((s) => s.kind === "thinking").length < MAX_THINKING_ITEMS) {
      steps.push({ id: e.stepId, label: e.label, kind: "thinking", startedAt: e.startedAt, endedAt: e.startedAt, ok: true, item: e.item });
    }
    return { ...state, [e.requestId]: steps };
  }
  const i = steps.findIndex((s) => s.id === e.stepId);
  if (e.state === "start") {
    if (i < 0) steps.push({ id: e.stepId, label: e.label, kind: e.kind, startedAt: e.startedAt });
  } else if (i >= 0) {
    steps[i] = e.state === "update" ? { ...steps[i], detail: e.detail ?? steps[i].detail } : { ...steps[i], endedAt: now, ok: e.ok !== false, detail: e.detail ?? steps[i].detail };
  } else if (e.state === "end") {
    // a step that is only ever announced as finished (a notice): show it as done at once
    steps.push({ id: e.stepId, label: e.label, kind: e.kind, startedAt: e.startedAt, endedAt: now, ok: e.ok !== false, detail: e.detail });
  }
  return { ...state, [e.requestId]: steps };
}

export function runningSteps(steps: StepState[] | undefined): StepState[] {
  return (steps ?? []).filter((s) => s.endedAt === undefined && s.kind !== "notice");
}
export function problemSteps(steps: StepState[] | undefined): StepState[] {
  return (steps ?? []).filter((s) => s.kind !== "notice" && s.kind !== "thinking" && s.endedAt !== undefined && s.ok === false);
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The running steps as label + elapsed pieces, so the screen can put the typing dots right after the first word ("Thinking •••  8s") instead of before it. */
export function statusParts(steps: StepState[] | undefined, now: number): Array<{ label: string; elapsed: string }> {
  return runningSteps(steps).map((s) => ({ label: s.label, elapsed: formatElapsed(now - s.startedAt) }));
}

/** What is shown while a reply is on its way but no step has started yet: the same "Thinking" line, with no timer, so there is never an empty bubble. */
export const WAITING_LABEL = "Thinking";

/** "Researching eBay… 8s" (several at once are joined). Empty when nothing is running. */
export function statusText(steps: StepState[] | undefined, now: number): string {
  return runningSteps(steps)
    .map((s) => `${s.label}… ${formatElapsed(now - s.startedAt)}`)
    .join("  ·  ");
}

// ---- Clynx's narrated thinking (AUDITOR proposal section 3)

/** The thinking items of a turn, in the order they happened. */
export function thinkingItems(steps: StepState[] | undefined): ThinkingItem[] {
  return (steps ?? []).filter((s) => s.kind === "thinking" && s.item).map((s) => s.item as ThinkingItem);
}

export interface ThinkingSummary {
  items: ThinkingItem[];
  pages: number;
  photos: number;
  /** Whole seconds from the first step of the turn to its last (or to now while it is still working). */
  seconds: number;
  /** "Clynx is thinking…" while it works; "Thought for 12s · looked at 3 pages, 5 photos" when it is done. */
  headline: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function thinkingSummary(steps: StepState[] | undefined, now: number, working: boolean): ThinkingSummary {
  const all = steps ?? [];
  const items = thinkingItems(all);
  const pages = items.filter((i) => i.type === "page").length;
  const photos = items.filter((i) => i.type === "image").length;
  const start = all.length ? Math.min(...all.map((s) => s.startedAt)) : now;
  const end = working ? now : all.length ? Math.max(...all.map((s) => s.endedAt ?? s.startedAt)) : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const looked = [pages > 0 ? plural(pages, "page") : "", photos > 0 ? plural(photos, "photo") : ""].filter(Boolean).join(", ");
  const headline = working ? "Clynx is thinking…" : `Thought for ${formatElapsed(seconds * 1000)}${looked ? ` · looked at ${looked}` : ""}`;
  return { items, pages, photos, seconds, headline };
}
